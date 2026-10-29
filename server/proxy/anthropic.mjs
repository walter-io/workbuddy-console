/**
 * Anthropic Messages API ↔ OpenAI Chat Completions 转换层。
 *
 * 为什么需要这层：Claude Code 与 ZCode（Anthropic 模式）说的是 Anthropic 协议，
 * 请求落在 `POST /v1/messages`（带 anthropic-version 头），body 形状与 OpenAI 完全不同：
 *   - system 是**顶层字段**，不在 messages 数组里
 *   - content 是**块数组**（text / tool_use / tool_result / image），不是纯字符串
 *   - max_tokens 必填，tools 用 `input_schema`（OpenAI 是 `function.parameters`）
 *   - 流式事件是 message_start / content_block_delta / message_delta / message_stop 一族，
 *     **不是** OpenAI 的 `data: {"choices":[{"delta":...}]}`
 * 上游只认 OpenAI 协议，所以这里做双向翻译。
 *
 * 实测（claude 2.1.205）确认的入站特征：
 *   POST /v1/messages?beta=true
 *   anthropic-version: 2023-06-01
 *   Authorization: Bearer <token>
 *   body: model, messages, system, tools, metadata, max_tokens, thinking,
 *         context_management, output_config, stream
 */
import crypto from 'node:crypto';
import { openUpstreamStream, UpstreamError } from './wb.mjs';
import { sanitizeMessages } from './sanitize.mjs';

const newMsgId = () => `msg_${crypto.randomBytes(16).toString('hex')}`;
const newToolId = () => `toolu_${crypto.randomBytes(16).toString('hex')}`;

/* ---------------- 入站：Anthropic 请求 → OpenAI 请求 ---------------- */

/**
 * system 顶层字段（string 或 text 块数组）压成一段纯文本。
 * 风控净化统一在本文件出口的 sanitizeMessages() 里做（见 sanitize.mjs）。
 */
function systemToText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .filter((b) => b?.type === 'text')
    .map((b) => b.text || '')
    .join('\n');
}

/** tool_result 的 content 可以是字符串，也可以是块数组 */
function toolResultToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' ? b.text || '' : b?.type === 'image' ? '[image]' : ''))
      .join('');
  }
  if (content == null) return '';
  return String(content);
}

/** Anthropic image 块 → OpenAI image_url 块 */
function imageToOpenAi(block) {
  const src = block?.source || {};
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

/**
 * 一条 Anthropic 消息可能展开成多条 OpenAI 消息：
 * 含 tool_result 的 user 消息要拆成 `role:"tool"` 条目（OpenAI 的硬性要求）。
 */
function convertMessage(msg, out) {
  const role = msg?.role;
  const content = msg?.content;

  if (role === 'assistant') {
    if (typeof content === 'string') {
      out.push({ role: 'assistant', content });
      return;
    }
    const parts = Array.isArray(content) ? content : [];
    const text = parts.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
    const calls = parts
      .filter((b) => b?.type === 'tool_use')
      .map((b) => ({
        id: b.id || newToolId(),
        type: 'function',
        function: { name: b.name || '', arguments: JSON.stringify(b.input ?? {}) },
      }));
    const m = { role: 'assistant', content: text };
    if (calls.length) m.tool_calls = calls;
    out.push(m);
    return;
  }

  // user（及罕见的其它 role）：拆文本/图片与 tool_result
  if (typeof content === 'string') {
    out.push({ role: 'user', content });
    return;
  }
  const parts = Array.isArray(content) ? content : [];
  const visual = [];
  const toolResults = [];
  for (const b of parts) {
    if (b?.type === 'text') visual.push({ type: 'text', text: b.text || '' });
    else if (b?.type === 'image') {
      const img = imageToOpenAi(b);
      if (img) visual.push(img);
    } else if (b?.type === 'tool_result') toolResults.push(b);
  }
  if (visual.length) {
    const onlyText = visual.every((v) => v.type === 'text');
    out.push({
      role: 'user',
      content: onlyText ? visual.map((v) => v.text).join('') : visual,
    });
  }
  for (const tr of toolResults) {
    out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: toolResultToText(tr.content) });
  }
}

/** Anthropic tool_choice → OpenAI tool_choice */
function toolChoiceToOpenAi(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  switch (tc.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return tc.name ? { type: 'function', function: { name: tc.name } } : 'auto';
    default:
      return undefined;
  }
}

/**
 * 把 Anthropic 请求体翻译成上游吃得下的 OpenAI 请求体。
 * 丢弃 Claude Code 的私货字段（thinking / context_management / output_config / metadata）：
 * 上游不认，且伪造 thinking 块会触发签名校验失败。
 */
export function anthropicToOpenAi(body = {}) {
  const out = {};
  if (body.model) out.model = body.model;

  const messages = [];
  const sys = systemToText(body.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of Array.isArray(body.messages) ? body.messages : []) convertMessage(m, messages);
  out.messages = sanitizeMessages(messages);

  // max_tokens 在 Anthropic 侧必填；OpenAI 兼容字段两边都认
  const maxTokens = Number(body.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = maxTokens;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }));
    const tc = toolChoiceToOpenAi(body.tool_choice);
    if (tc !== undefined) out.tool_choice = tc;
  }

  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  // Anthropic 用 stop_sequences，OpenAI 用 stop（两边都是 string | string[]）
  if (body.stop_sequences !== undefined) out.stop = body.stop_sequences;

  return out;
}

/* ---------------- 出站：OpenAI → Anthropic ---------------- */

/** OpenAI finish_reason → Anthropic stop_reason */
export function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
    case 'end_turn':
      return 'end_turn';
    default:
      return finishReason ? 'end_turn' : 'end_turn';
  }
}

function usageToAnthropic(usage) {
  return {
    input_tokens: Number(usage?.prompt_tokens) || 0,
    output_tokens: Number(usage?.completion_tokens) || 0,
  };
}

/** 聚合后的 OpenAI 响应 → Anthropic message（非流式） */
export function buildAnthropicMessage(openai = {}, model) {
  const choice = openai?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc?.function?.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: tc?.id || newToolId(), name: tc?.function?.name || '', input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const id = String(openai?.id || '').replace(/^chatcmpl-/, '');
  return {
    id: id ? `msg_${id}` : newMsgId(),
    type: 'message',
    role: 'assistant',
    model: openai?.model || model || '',
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: usageToAnthropic(openai?.usage),
  };
}

/* ---------------- 出站：流式事件序列 ---------------- */

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * 把上游 OpenAI delta 流转成 Anthropic SSE 事件序列。
 *
 * 事件顺序严格按 Anthropic 规范（Claude Code 的 SDK 解析器对顺序敏感）：
 *   message_start → (content_block_start → content_block_delta* → content_block_stop)*
 *   → message_delta → message_stop
 *
 * 块模型差异：OpenAI 是"一个 delta 里混着文本和工具分片"，Anthropic 是"编号 content block"。
 * 这里维护单调递增的块索引；文本块与每个工具调用各占一个块，切换前先关掉上一个。
 */
// stats：出参对象，adapter 把上游 usage 写进 stats.usage 供记账
export async function pipeAnthropicStream(frames, res, { model, signal, stats } = {}) {
  const messageId = newMsgId();
  let started = false;
  let nextIndex = 0;
  let textIndex = -1;
  let openIndex = -1; // 当前打开的块（-1 表示无）
  let textAccum = '';
  let finishReason = null;
  let usage = null;
  let upstreamError = null;
  /** 上游 tool_call 分片索引 → { blockIndex, id, name, args } */
  const tools = new Map();

  const startMessage = () => {
    if (started) return;
    started = true;
    sse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: model || '',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const closeOpen = () => {
    if (openIndex >= 0) {
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: openIndex });
      openIndex = -1;
    }
  };

  const openBlock = (index, contentBlock) => {
    closeOpen();
    openIndex = index;
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: contentBlock });
  };

  for await (const ev of frames) {
    if (signal?.aborted) break;
    if (ev.type === 'error') {
      upstreamError = ev.message;
      break;
    }
    if (ev.type === 'done') break;
    if (ev.type !== 'delta') continue;

    startMessage();
    if (ev.model) model = model || ev.model;
    if (ev.usage) usage = ev.usage;
    if (ev.usage && stats) stats.usage = { prompt_tokens: Number(ev.usage.prompt_tokens) || 0, completion_tokens: Number(ev.usage.completion_tokens) || 0 };

    // 文本
    if (ev.content) {
      if (textIndex < 0) {
        textIndex = nextIndex++;
        openBlock(textIndex, { type: 'text', text: '' });
      } else if (openIndex !== textIndex) {
        openBlock(textIndex, { type: 'text', text: '' });
      }
      textAccum += ev.content;
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: ev.content },
      });
    }

    // 工具调用分片
    for (const tc of ev.toolCalls) {
      const key = tc?.index ?? 0;
      let st = tools.get(key);
      if (!st) {
        st = { blockIndex: nextIndex++, id: tc?.id || newToolId(), name: '', args: '' };
        tools.set(key, st);
      }
      if (tc?.id) st.id = tc.id;
      const fnName = tc?.function?.name;
      const fnArgs = tc?.function?.arguments;
      if (fnName) {
        st.name += fnName;
        if (openIndex !== st.blockIndex) {
          openBlock(st.blockIndex, { type: 'tool_use', id: st.id, name: st.name, input: {} });
        }
      }
      if (typeof fnArgs === 'string' && fnArgs) {
        if (openIndex !== st.blockIndex) {
          openBlock(st.blockIndex, { type: 'tool_use', id: st.id, name: st.name || '', input: {} });
        }
        st.args += fnArgs;
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: st.blockIndex,
          delta: { type: 'input_json_delta', partial_json: fnArgs },
        });
      }
    }

    if (ev.finishReason) finishReason = ev.finishReason;
  }

  if (signal?.aborted) return; // 客户端已走，不必再写

  // 空回复也要给一个（空）文本块，否则部分客户端认为响应非法
  closeOpen();
  if (!started) {
    startMessage();
    textIndex = nextIndex++;
    openBlock(textIndex, { type: 'text', text: '' });
    closeOpen();
  } else if (textIndex < 0 && !tools.size) {
    textIndex = nextIndex++;
    openBlock(textIndex, { type: 'text', text: '' });
    closeOpen();
  }

  if (upstreamError) {
    // 已经写出部分内容：用 error 事件收尾更符合 Anthropic 习惯。
    // 返回错误文本：调用方据此按失败记账/冷却/采样（此前返回 undefined 被记成成功）
    sse(res, 'error', { type: 'error', error: { type: 'api_error', message: upstreamError } });
    res.end();
    return upstreamError;
  }

  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
    usage: { output_tokens: Number(usage?.completion_tokens) || 0 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
  return null;
}

export { UpstreamError };
