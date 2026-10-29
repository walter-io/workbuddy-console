/**
 * Google Gemini 原生协议 ↔ OpenAI Chat Completions 转换层。
 *
 * 为什么需要这层：Gemini CLI（@google/gemini-cli）与 Gemini 原生 SDK 说的是 Google 的
 * generateContent 协议，请求落在
 *   POST /v1beta/models/{model}:generateContent
 *   POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 * 与 OpenAI / Anthropic 两套都不同：
 *   - 入站没有 model 字段，**模型在 URL 路径里**；message 叫 contents
 *   - content 由 parts 组成（text / inlineData / functionCall / functionResponse），
 *     role 用 `user` / `model`（不是 assistant）
 *   - 系统提示是顶层 `systemInstruction`；采样参数收在 `generationConfig` 里
 *   - 工具是 `tools[].functionDeclarations[]`，且**没有 tool_call_id**，
 *     functionResponse 只靠 name 关联，需要在本层合成 id 才能喂给 OpenAI 上游
 *   - 出站是 `{candidates:[{content:{parts},finishReason}]}`；流式是裸 `data: {chunk}`，
 *     **没有 event 名**（与 Anthropic 的具名事件流不同）
 *
 * 客户端接入（官方 Gemini CLI，实测文档口径）：
 *   GOOGLE_GEMINI_BASE_URL = http://127.0.0.1:<port>   # 只填域名，不要带 /v1beta
 *   GEMINI_API_KEY         = <控制台生成的 Key>
 *   鉴权头默认走 x-goog-api-key；CLI 会自动拼 /v1beta/models/{model}:...
 *   注：CLI 要求 HTTPS，但 localhost / 127.0.0.1 例外，因此本机回环可直接用 http。
 */
import crypto from 'node:crypto';
import { UpstreamError } from './wb.mjs';
import { sanitizeMessages } from './sanitize.mjs';

const newResponseId = () => crypto.randomBytes(12).toString('hex');

/* ---------------- 入站：Gemini 请求 → OpenAI 请求 ---------------- */

/** systemInstruction：string 或 { parts:[{text}] } → 纯文本 */
function systemInstructionToText(si) {
  if (!si) return '';
  if (typeof si === 'string') return si;
  return (Array.isArray(si.parts) ? si.parts : [])
    .map((p) => p?.text || '')
    .join('\n');
}

/** part.inlineData / part.fileData → OpenAI image_url 块 */
function partToImage(part) {
  const inline = part?.inlineData;
  if (inline?.data) {
    return { type: 'image_url', image_url: { url: `data:${inline.mimeType || 'image/png'};base64,${inline.data}` } };
  }
  const file = part?.fileData;
  if (file?.fileUri) {
    return { type: 'image_url', image_url: { url: file.fileUri } };
  }
  return null;
}

/** functionResponse.response 是对象，转成字符串喂给 OpenAI 的 role:"tool" */
function functionResponseToString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** tools[].functionDeclarations[] → OpenAI 的 tools[] */
function toolDeclarationsToOpenAi(tools) {
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    for (const fd of Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : []) {
      if (!fd?.name) continue;
      out.push({
        type: 'function',
        function: {
          name: fd.name,
          description: fd.description || '',
          parameters: fd.parameters || { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

const TOOL_MODE = { AUTO: 'auto', ANY: 'required', NONE: 'none' };

/**
 * Gemini 请求体 → 上游吃得下的 OpenAI 请求体。
 *
 * 工具 id 合成规则：Gemini 的 functionCall / functionResponse 一般不带 id，
 * 这里按调用顺序给 functionCall 生成 `call_{name}_{seq}`，并在遇到同名
 * functionResponse 时 FIFO 取回，保证多轮工具调用里 tool_call_id 能对上。
 * （若上游/客户端显式带了 id 字段则优先沿用。）
 */
export function geminiToOpenAi(body = {}, model) {
  const out = {};
  const messages = [];

  const sys = systemInstructionToText(body.systemInstruction);
  if (sys) messages.push({ role: 'system', content: sys });

  const idQueue = new Map(); // functionName -> [合成 id, ...]
  let seq = 0;

  for (const c of Array.isArray(body.contents) ? body.contents : []) {
    const isModel = c?.role === 'model';
    const parts = Array.isArray(c?.parts) ? c.parts : [];
    const texts = [];
    const visual = [];
    const toolCalls = [];
    const toolResults = [];

    for (const p of parts) {
      if (!p) continue;
      if (typeof p.text === 'string') {
        texts.push(p.text);
        continue;
      }
      const img = partToImage(p);
      if (img) {
        visual.push(img);
        continue;
      }
      if (p.functionCall) {
        const name = p.functionCall.name || '';
        const id = p.functionCall.id || `call_${name}_${++seq}`;
        if (!idQueue.has(name)) idQueue.set(name, []);
        idQueue.get(name).push(id);
        toolCalls.push({
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
        });
        continue;
      }
      if (p.functionResponse) {
        const name = p.functionResponse.name || '';
        const queue = idQueue.get(name);
        const id = p.functionResponse.id || (queue && queue.length ? queue.shift() : `call_${name}`);
        toolResults.push({ id, content: functionResponseToString(p.functionResponse.response) });
      }
    }

    if (isModel) {
      const text = texts.join('');
      if (text || toolCalls.length) {
        const m = { role: 'assistant', content: text };
        if (toolCalls.length) m.tool_calls = toolCalls;
        messages.push(m);
      }
    } else {
      if (texts.length || visual.length) {
        const content = visual.length
          ? [...(texts.length ? [{ type: 'text', text: texts.join('') }] : []), ...visual]
          : texts.join('');
        messages.push({ role: 'user', content });
      }
      // tool_result 必须单独成条，且排在 user 消息之后（OpenAI 的硬性要求）
      for (const tr of toolResults) messages.push({ role: 'tool', tool_call_id: tr.id, content: tr.content });
    }
  }

  out.model = model || body.model || '';
  out.messages = sanitizeMessages(messages);

  const tools = toolDeclarationsToOpenAi(body.tools);
  if (tools.length) {
    out.tools = tools;
    const mode = TOOL_MODE[String(body.toolConfig?.functionCallingConfig?.mode || '').toUpperCase()];
    if (mode) out.tool_choice = mode;
  }

  const gc = body.generationConfig || {};
  if (Number.isFinite(Number(gc.temperature))) out.temperature = Number(gc.temperature);
  if (Number.isFinite(Number(gc.topP))) out.top_p = Number(gc.topP);
  const maxOut = Number(gc.maxOutputTokens);
  if (Number.isFinite(maxOut) && maxOut > 0) out.max_tokens = maxOut;
  if (Array.isArray(gc.stopSequences) && gc.stopSequences.length) out.stop = gc.stopSequences;
  // 结构化输出：Gemini 用 responseMimeType，OpenAI 用 response_format
  if (gc.responseMimeType === 'application/json') out.response_format = { type: 'json_object' };

  return out;
}

/* ---------------- 出站：OpenAI → Gemini ---------------- */

const FINISH_TO_GEMINI = {
  stop: 'STOP',
  end_turn: 'STOP',
  tool_calls: 'STOP',
  function_call: 'STOP',
  length: 'MAX_TOKENS',
  content_filter: 'SAFETY',
  content_filtered: 'SAFETY',
};

const geminiFinish = (finishReason) => FINISH_TO_GEMINI[finishReason] || 'STOP';

function usageToGemini(usage) {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const candidates = Number(usage?.completion_tokens) || 0;
  return { promptTokenCount: prompt, candidatesTokenCount: candidates, totalTokenCount: prompt + candidates };
}

/** OpenAI assistant 消息 → Gemini parts（text + functionCall） */
function partsFromOpenAiMessage(msg) {
  const parts = [];
  if (typeof msg?.content === 'string' && msg.content) parts.push({ text: msg.content });
  for (const tc of msg?.tool_calls || []) {
    let args = {};
    try {
      args = JSON.parse(tc?.function?.arguments || '{}');
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: tc?.function?.name || '', args } });
  }
  return parts;
}

/** 聚合后的 OpenAI 响应 → Gemini GenerateContentResponse（非流式） */
export function buildGeminiResponse(openai = {}, model) {
  const choice = openai?.choices?.[0] || {};
  let parts = partsFromOpenAiMessage(choice.message || {});
  if (!parts.length) parts = [{ text: '' }];

  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: geminiFinish(choice.finish_reason),
        index: 0,
        safetyRatings: [],
      },
    ],
    usageMetadata: usageToGemini(openai?.usage),
    modelVersion: openai?.model || model || '',
    responseId: newResponseId(),
  };
}

/** Gemini 模型清单（GET /v1beta/models） */
export function geminiModelsPayload(ids) {
  return {
    models: (Array.isArray(ids) ? ids : []).map((id) => ({
      name: `models/${id}`,
      displayName: id,
      description: '',
      version: '',
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
      inputTokenLimit: 128000,
      outputTokenLimit: 8192,
    })),
  };
}

/* ---------------- 出站：流式 chunk 序列 ---------------- */

/** Gemini 流式是裸 `data: {chunk}`，**没有 event 名** */
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

/**
 * 把上游 OpenAI delta 流转成 Gemini 的 streamGenerateContent chunk 序列。
 *
 * 文本按 delta 逐块下发（客户端按 parts 合并）；工具调用的参数是分片到达的，
 * 这里累积到流末尾再一次性发出完整 functionCall；最后补一个只带
 * finishReason + usageMetadata 的收尾 chunk（Gemini 原生也是这个形状）。
 */
// stats：出参对象，adapter 把上游 usage 写进 stats.usage 供记账
export async function pipeGeminiStream(frames, res, { model, signal, stats } = {}) {
  let modelVersion = model || '';
  let finishReason = null;
  let usage = null;
  let upstreamError = null;
  let emitted = false;
  const calls = new Map(); // 上游 tool index -> { name, args }

  const textChunk = (text) => ({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
    modelVersion,
  });

  for await (const ev of frames) {
    if (signal?.aborted) break;
    if (ev.type === 'error') {
      upstreamError = ev.message;
      break;
    }
    if (ev.type === 'done') break;
    if (ev.type !== 'delta') continue;

    if (ev.model) modelVersion = modelVersion || ev.model;
    if (ev.usage) usage = ev.usage;
    if (ev.usage && stats) stats.usage = { prompt_tokens: Number(ev.usage.prompt_tokens) || 0, completion_tokens: Number(ev.usage.completion_tokens) || 0 };

    if (ev.content) {
      emitted = true;
      sse(res, textChunk(ev.content));
    }

    for (const tc of ev.toolCalls) {
      const key = tc?.index ?? 0;
      const st = calls.get(key) || { name: '', args: '' };
      if (tc?.function?.name) st.name += tc.function.name;
      if (typeof tc?.function?.arguments === 'string') st.args += tc.function.arguments;
      calls.set(key, st);
    }

    if (ev.finishReason) finishReason = ev.finishReason;
  }

  if (signal?.aborted) return; // 客户端已走，不必再写

  const callParts = [];
  for (const st of calls.values()) {
    let args = {};
    try {
      args = JSON.parse(st.args || '{}');
    } catch {
      args = {};
    }
    callParts.push({ functionCall: { name: st.name || '', args } });
  }
  if (callParts.length) {
    emitted = true;
    sse(res, { candidates: [{ content: { role: 'model', parts: callParts }, index: 0 }], modelVersion });
  }

  // 空回复也要给一个 chunk，否则部分客户端认为流非法
  if (!emitted) sse(res, textChunk(''));

  if (upstreamError) {
    sse(res, { error: { code: 502, message: upstreamError, status: 'INTERNAL' } });
    res.end();
    return upstreamError; // 调用方按失败记账/冷却/采样
  }

  sse(res, {
    candidates: [{ finishReason: geminiFinish(finishReason), index: 0, safetyRatings: [] }],
    usageMetadata: usageToGemini(usage),
    modelVersion,
  });
  res.end();
  return null;
}

export { UpstreamError };
