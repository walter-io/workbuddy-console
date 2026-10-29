/**
 * OpenAI Responses API ↔ OpenAI Chat Completions 转换层。
 *
 * 为什么需要这层：Codex CLI（实测 0.139.0）说的是 Responses API，
 * 请求落在 `POST /v1/responses`，body 与 chat/completions 不同：
 *   - 系统提示叫 `instructions`（顶层），history 叫 `input`
 *   - input 是**条目数组**：message / function_call / function_call_output / reasoning
 *   - tools 是扁平结构（`{type:"function", name, parameters}`），不是 `{function:{...}}`
 *   - 流式事件是 response.created / output_item.added / output_text.delta / response.completed 一族
 *
 * 实测（codex 0.139.0）确认的入站特征：
 *   POST /v1/responses
 *   Authorization: Bearer <key>
 *   body: model, instructions, input, tools, tool_choice, parallel_tool_calls,
 *         reasoning, store, stream, include, prompt_cache_key, client_metadata
 * 而且：**没有 response.completed 事件时 Codex 会报
 *   "stream disconnected before completion: stream closed before response.completed"**
 * 所以序列末尾那一条是硬性要求，不是可选装饰。
 */
import crypto from 'node:crypto';
import { UpstreamError } from './wb.mjs';
import { sanitizeMessages } from './sanitize.mjs';

const newRespId = () => `resp_${crypto.randomBytes(16).toString('hex')}`;
const newItemId = (p) => `${p}_${crypto.randomBytes(16).toString('hex')}`;

/* ---------------- 入站：Responses 请求 → OpenAI 请求 ---------------- */

/** input 里一条 message 的 content（字符串或块数组）压成 OpenAI content */
function inputContentToOpenAi(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') {
      parts.push({ type: 'text', text: b.text || '' });
    } else if (b.type === 'input_image' || b.type === 'image_url') {
      const url = b.image_url || b.url || '';
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (!parts.length) return '';
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('');
  return parts;
}

/**
 * 把 Responses 的 input 条目数组翻译成 OpenAI messages。
 * function_call / function_call_output 要还原成 OpenAI 的 tool_calls / role:"tool" 形态，
 * 否则多轮工具调用会丢上下文。
 */
function inputToMessages(input, messages) {
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return;
  }
  for (const item of Array.isArray(input) ? input : []) {
    if (!item) continue;
    const type = item.type;
    if (type === 'message' || (!type && item.role)) {
      const role = item.role === 'developer' ? 'system' : item.role || 'user';
      messages.push({ role, content: inputContentToOpenAi(item.content) });
      continue;
    }
    if (type === 'function_call') {
      const call = {
        id: item.call_id || item.id || newItemId('call'),
        type: 'function',
        function: { name: item.name || '', arguments: item.arguments || '{}' },
      };
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: '', tool_calls: [call] });
      continue;
    }
    if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
      continue;
    }
    // reasoning / item_reference 等：上游不认，丢弃
  }
}

/** Responses tool_choice → OpenAI tool_choice */
function toolChoiceToOpenAi(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  if (tc.type === 'function') return { type: 'function', function: { name: tc.name } };
  return undefined;
}

/** Responses 请求体 → 上游能吃的 OpenAI 请求体 */
export function responsesToOpenAi(body = {}) {
  const out = {};
  if (body.model) out.model = body.model;

  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  inputToMessages(body.input, messages);
  // Codex 的 instructions 是它自己的系统提示词，逐字命中上游竞品指纹库会被 11128 拦截，
  // 出口统一净化（仅 system 级文本，用户消息不动）——理由与实证见 sanitize.mjs。
  out.messages = sanitizeMessages(messages);

  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = body.tools
      .filter((t) => t?.type === 'function' && t.name)
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
      }));
    if (tools.length) {
      out.tools = tools;
      const tc = toolChoiceToOpenAi(body.tool_choice);
      if (tc !== undefined) out.tool_choice = tc;
    }
  }

  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
  return out;
}

/* ---------------- 出站：OpenAI → Responses ---------------- */

function usageToResponses(usage) {
  const inputTokens = Number(usage?.prompt_tokens) || 0;
  const outputTokens = Number(usage?.completion_tokens) || 0;
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

function stopReason(finishReason) {
  return finishReason === 'length' ? 'incomplete' : 'completed';
}

/** 聚合后的 OpenAI 响应 → Responses 对象（非流式） */
export function buildResponsesReply(openai = {}, model) {
  const choice = openai?.choices?.[0] || {};
  const msg = choice.message || {};
  const output = [];

  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text) {
    output.push({
      id: newItemId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const tc of msg.tool_calls || []) {
    output.push({
      id: newItemId('fc'),
      type: 'function_call',
      status: 'completed',
      name: tc?.function?.name || '',
      arguments: tc?.function?.arguments || '{}',
      call_id: tc?.id || newItemId('call'),
    });
  }
  if (!output.length) {
    output.push({
      id: newItemId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  const id = String(openai?.id || '').replace(/^chatcmpl-/, '');
  const resp = {
    id: id ? `resp_${id}` : newRespId(),
    object: 'response',
    created_at: openai?.created || Math.floor(Date.now() / 1000),
    status: stopReason(choice.finish_reason),
    model: openai?.model || model || '',
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: usageToResponses(openai?.usage),
  };
  if (resp.status === 'incomplete') {
    resp.incomplete_details = { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' };
  }
  return resp;
}

/* ---------------- 出站：流式事件序列 ---------------- */

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * 把上游 OpenAI delta 流转成 Responses SSE 事件序列。
 *
 * 关键点：最后必须发 `response.completed`，否则 Codex 判流未完整结束并重连。
 * 文本走 message item + output_text.delta；工具调用走 function_call item +
 * function_call_arguments.delta，两种 item 各自占用递增的 output_index。
 */
// stats：出参对象，adapter 把上游 usage 写进 stats.usage 供记账
export async function pipeResponsesStream(frames, res, { model, signal, stats } = {}) {
  const responseId = newRespId();
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  let nextOutputIndex = 0;
  let finishReason = null;
  let usage = null;
  let upstreamError = null;

  let textItem = null; // { id, index, text }
  const callItems = new Map(); // 上游 tool index → { id, index, name, args, callId }

  const envelope = (status, output, s) => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model: model || '',
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: s || null,
  });

  // 先发 created + in_progress，Codex 依赖这两个事件建立响应上下文
  sse(res, 'response.created', { type: 'response.created', sequence_number: seq++, response: envelope('in_progress', [], null) });
  sse(res, 'response.in_progress', {
    type: 'response.in_progress',
    sequence_number: seq++,
    response: envelope('in_progress', [], null),
  });

  const openTextItem = () => {
    if (textItem) return;
    textItem = { id: newItemId('msg'), index: nextOutputIndex++, text: '' };
    sse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: seq++,
      output_index: textItem.index,
      item: { id: textItem.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    sse(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      sequence_number: seq++,
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const openCallItem = (key, tc) => {
    let st = callItems.get(key);
    if (st) return st;
    st = { id: newItemId('fc'), index: nextOutputIndex++, name: '', args: '', callId: tc?.id || newItemId('call') };
    callItems.set(key, st);
    if (tc?.id) st.callId = tc.id;
    return st;
  };

  for await (const ev of frames) {
    if (signal?.aborted) break;
    if (ev.type === 'error') {
      upstreamError = ev.message;
      break;
    }
    if (ev.type === 'done') break;
    if (ev.type !== 'delta') continue;

    if (ev.model) model = model || ev.model;
    if (ev.usage) usage = ev.usage;
    if (ev.usage && stats) stats.usage = { prompt_tokens: Number(ev.usage.prompt_tokens) || 0, completion_tokens: Number(ev.usage.completion_tokens) || 0 };

    if (ev.content) {
      openTextItem();
      textItem.text += ev.content;
      sse(res, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        sequence_number: seq++,
        item_id: textItem.id,
        output_index: textItem.index,
        content_index: 0,
        delta: ev.content,
      });
    }

    for (const tc of ev.toolCalls) {
      const key = tc?.index ?? 0;
      const st = openCallItem(key, tc);
      if (tc?.id) st.callId = tc.id;
      const name = tc?.function?.name;
      if (name && !st.name) {
        st.name = name;
        sse(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          sequence_number: seq++,
          output_index: st.index,
          item: { id: st.id, type: 'function_call', status: 'in_progress', name: st.name, arguments: '', call_id: st.callId },
        });
      }
      const args = tc?.function?.arguments;
      if (typeof args === 'string' && args) {
        if (!st.name) {
          // 极端情况：arguments 先于 name 到达，先补一个 added 事件占位
          sse(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            sequence_number: seq++,
            output_index: st.index,
            item: { id: st.id, type: 'function_call', status: 'in_progress', name: '', arguments: '', call_id: st.callId },
          });
        }
        st.args += args;
        sse(res, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          sequence_number: seq++,
          item_id: st.id,
          output_index: st.index,
          delta: args,
        });
      }
    }

    if (ev.finishReason) finishReason = ev.finishReason;
  }

  if (signal?.aborted) return;

  // 收尾：把打开的 item 逐个补齐 done 事件
  const output = [];
  if (textItem) {
    sse(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      sequence_number: seq++,
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      text: textItem.text,
    });
    const part = { type: 'output_text', text: textItem.text, annotations: [] };
    sse(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      sequence_number: seq++,
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      part,
    });
    const item = { id: textItem.id, type: 'message', status: 'completed', role: 'assistant', content: [part] };
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', sequence_number: seq++, output_index: textItem.index, item });
    output.push({ ...item, index: textItem.index });
  }
  for (const st of [...callItems.values()]) {
    sse(res, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      sequence_number: seq++,
      item_id: st.id,
      output_index: st.index,
      arguments: st.args,
    });
    const item = {
      id: st.id,
      type: 'function_call',
      status: 'completed',
      name: st.name || '',
      arguments: st.args || '{}',
      call_id: st.callId,
    };
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', sequence_number: seq++, output_index: st.index, item });
    output.push({ ...item, index: st.index });
  }
  // 空回复也要有 content 骨架，Codex 才能判定"回复为空"而不是"格式非法"
  if (!output.length) {
    const id = newItemId('msg');
    const part = { type: 'output_text', text: '', annotations: [] };
    const item = { id, type: 'message', status: 'completed', role: 'assistant', content: [part] };
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    sse(res, 'response.content_part.added', { type: 'response.content_part.added', sequence_number: seq++, item_id: id, output_index: 0, content_index: 0, part: { ...part, text: '' } });
    sse(res, 'response.content_part.done', { type: 'response.content_part.done', sequence_number: seq++, item_id: id, output_index: 0, content_index: 0, part });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item });
    output.push({ ...item, index: 0 });
  }

  if (upstreamError) {
    sse(res, 'response.failed', {
      type: 'response.failed',
      sequence_number: seq++,
      response: { ...envelope('failed', [], usageToResponses(usage)), error: { code: 'upstream_error', message: upstreamError } },
    });
    res.end();
    return upstreamError; // 调用方按失败记账/冷却/采样
  }

  // 按 output_index 排序，保证 output 数组顺序与事件一致
  output.sort((a, b) => a.index - b.index);
  const finalOutput = output.map(({ index, ...rest }) => rest);
  sse(res, 'response.completed', {
    type: 'response.completed',
    sequence_number: seq++,
    response: envelope(stopReason(finishReason), finalOutput, usageToResponses(usage)),
  });
  res.end();
  return null;
}

export { UpstreamError };
