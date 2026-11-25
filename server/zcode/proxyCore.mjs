/**
 * ZCode 反向代理核心（架构对齐 server/proxy/index.mjs 的 WorkBuddy 实现）：
 * - 不另起端口：挂在本控制台 Express 上（/v1z/* 路径），默认关闭
 * - OpenAI 兼容入站（/v1z/chat/completions、/v1z/models），上游转 Anthropic /v1/messages
 * - apiKey 鉴权、请求日志、限额冷却、风控节流：语义与 WorkBuddy 反代一致
 *
 * 与 WorkBuddy 反代的差异只在「上游客户端」：wb.mjs → zcode/upstream.mjs，
 * 配置不共用 cfg.proxy（互不干扰），单独放 cfg.zcodeProxy。
 */
import crypto from 'node:crypto';
import { loadConfig, saveConfigAsync } from '../store/config.mjs';
import { anthropicMessages, anthropicMessagesStream, listUpstreamModels, zcodeClientVersion, giftStreamRelease } from './upstream.mjs';

/** 允许透传给上游的字段（OpenAI → Anthropic 转换层之外的原样字段丢弃） */
const LOG_LIMIT = 200;
const COOLDOWN_MS = 10 * 60 * 1000;

const state = {
  logs: [],
  stats: { total: 0, ok: 0, failed: 0, lastAt: null },
  cooldown: new Map(), // key: model → 冷却截止时间戳
  lastRequestAt: 0,
};

function newProxyKey() {
  return 'sk-zcode-' + crypto.randomBytes(16).toString('hex');
}

function cfg() {
  const c = loadConfig();
  if (!c.zcodeProxy) c.zcodeProxy = { enabled: false, apiKey: '', timeoutMs: 120_000, minIntervalMs: 3_000 };
  return c.zcodeProxy;
}

function pushLog(entry) {
  state.logs.unshift(entry);
  if (state.logs.length > LOG_LIMIT) state.logs.length = LOG_LIMIT;
}

/** OpenAI chat body → Anthropic /v1/messages body（最小映射，未知字段丢弃） */
function openAiToAnthropic(body) {
  const systemParts = [];
  const messages = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object' || !m.role) continue;
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      else if (Array.isArray(m.content)) for (const p of m.content) if (p && typeof p.text === 'string') systemParts.push(p.text);
      continue;
    }
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
    });
  }
  const out = { model: String(body.model || ''), messages, stream: !!body.stream };
  if (systemParts.length) out.system = systemParts.join('\n');
  if (Number.isFinite(body.max_tokens) && body.max_tokens > 0) out.max_tokens = body.max_tokens;
  else out.max_tokens = 4096; // R012-4/R013-1：流式与非流式都兜底，兼容严格上游
  if (Number.isFinite(body.temperature)) out.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) out.top_p = body.top_p;
  if (body.thinking && typeof body.thinking === 'object') out.thinking = body.thinking;
  return out;
}

/** Anthropic 响应 → OpenAI chat completion（非流式） */
function anthropicToOpenAi(resp, model) {
  const blocks = Array.isArray(resp.content) ? resp.content : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const u = resp.usage || {};
  return {
    id: resp.id || 'chatcmpl-zcode',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: resp.stop_reason === 'max_tokens' ? 'length' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: Number(u.input_tokens || 0),
      completion_tokens: Number(u.output_tokens || 0),
      total_tokens: Number(u.input_tokens || 0) + Number(u.output_tokens || 0),
    },
  };
}

/** Anthropic SSE → OpenAI SSE（chunk 级转换） */
function anthropicChunkToOpenAi(ev, model) {
  if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
    return {
      id: 'chatcmpl-zcode',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: ev.delta.text }, finish_reason: null }],
    };
  }
  if (ev.type === 'message_delta' && ev.delta) {
    return {
      id: 'chatcmpl-zcode',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: ev.delta.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
    };
  }
  return null;
}

/** 风控节流（审查 Z-5）：并发同读 lastRequestAt 会全部同时放行 → 用 promise 链把节流段串行化 */
let throttleChain = Promise.resolve();
async function throttle() {
  const run = throttleChain.catch(() => {}).then(async () => {
    const zc = cfg();
    const min = Math.max(0, Number(zc.minIntervalMs) || 0);
    if (min > 0) {
      const wait = state.lastRequestAt + min - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    state.lastRequestAt = Date.now();
  });
  throttleChain = run;
  await run;
}

/** 路由注册（app = 主 Express；挂在静态资源之前，同 WorkBuddy 反代） */
/** ZCode 登录态变化通知（upstream watcher → proxyCore 状态横幅） */
let lastCredentialChange = null;
export function notifyZcodeCredentialChange(state) { lastCredentialChange = state; }

export function registerZcodeProxyRoutes(app, { port }) {
  // 状态（页面拉取）
  // R016-1：cfgdbg 调试端点已删除（曾全量回显 key，违反 Z-4）
  app.get('/api/zcode/proxy/status', (req, res) => {
    const zc = cfg();
    res.json({
      enabled: !!zc.enabled,
      apiKeySet: !!zc.apiKey,
      endpoint: 'http://127.0.0.1:' + port + '/v1z',
      clientVersion: zcodeClientVersion(),
      upstream: 'zcode.z.ai/api/v1/zcode-plan/anthropic（免 key · 读本机 ZCode 登录态 · 消耗该账号免费套餐额度）',
      credentialChanged: !!lastCredentialChange && (!lastCredentialChange.lastJwtChangeAt || Date.now() - lastCredentialChange.lastJwtChangeAt < 300_000),
      timeoutMs: zc.timeoutMs,
      minIntervalMs: zc.minIntervalMs,
      stats: state.stats,
      logs: state.logs,
      models: listUpstreamModels(),
    });
  });

  // 开关 + Key 配置
  app.put('/api/zcode/proxy/config', async (req, res) => {
    try {
      const c = loadConfig();
      if (!c.zcodeProxy) c.zcodeProxy = { enabled: false, apiKey: '', timeoutMs: 120_000, minIntervalMs: 3_000 };
      if (typeof req.body?.enabled === 'boolean') {
        c.zcodeProxy.enabled = req.body.enabled;
        if (req.body.enabled && !c.zcodeProxy.apiKey) c.zcodeProxy.apiKey = newProxyKey();
      }
      if (req.body?.regenerateKey === true) c.zcodeProxy.apiKey = newProxyKey();
      if (Number.isFinite(req.body?.timeoutMs) && req.body.timeoutMs >= 10_000) c.zcodeProxy.timeoutMs = req.body.timeoutMs;
      if (Number.isFinite(req.body?.minIntervalMs) && req.body.minIntervalMs >= 0) c.zcodeProxy.minIntervalMs = req.body.minIntervalMs;
      await saveConfigAsync(c);
      // 完整 key 不默认回显（审查 Z-4）：前端只需要「是否已配置」；要看 key 走显式 reveal=1
      const reveal = req.query.reveal === '1';
      res.json({
        ok: true,
        enabled: c.zcodeProxy.enabled,
        apiKeySet: !!c.zcodeProxy.apiKey,
        ...(reveal ? { apiKey: c.zcodeProxy.apiKey } : {}),
        timeoutMs: c.zcodeProxy.timeoutMs,
        minIntervalMs: c.zcodeProxy.minIntervalMs,
      });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // 反代鉴权中间件（/v1z/*）
  app.use('/v1z', (req, res, next) => {
    const zc = cfg();
    if (!zc.enabled) return res.status(404).json({ error: { message: 'ZCode 反向代理未开启' } });
    const auth = String(req.headers['authorization'] || '');
    const key = auth.replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
    if (!zc.apiKey || key !== zc.apiKey) return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
    next();
  });

  // OpenAI 兼容：模型列表
  app.get('/v1z/models', (req, res) => {
    const { models } = listUpstreamModels();
    res.json({
      object: 'list',
      data: models.map((m) => ({ id: m, object: 'model', created: 0, owned_by: 'zcode' })),
    });
  });

  // OpenAI 兼容：chat completions
  app.post('/v1z/chat/completions', async (req, res) => {
    const startedAt = Date.now();
    const body = req.body || {};
    const model = String(body.model || '');
    state.stats.total++;
    try {
      await throttle();
      const upstreamBody = openAiToAnthropic(body);
      // 会话 id：客户端可显式传 x-session-id；不传则由 upstream 从首条 user 消息派生
      const sessionId = String(req.headers['x-session-id'] || '').trim();
      if (body.stream) {
        // 客户端断连 → abort 上游（WB 反代基线：close→destroy，避免客户端断开后白烧上游 token）
        const abort = new AbortController();
        // R024：断连时必须**真正取消上游 reader**。
        //   仅 abort() 信号不足以让上游连接结束——上游 body 已被 getReader() 锁定，
        //   cancel() 会抛 ERR_INVALID_STATE；连接不断 → ZCode 服务端仍认为这次请求占着
        //   账号级并发槽位 → 下一个请求直接吃 3008。
        let readerRef = null;
        res.on('close', () => {
          abort.abort();
          if (readerRef) {
            try {
              const p = readerRef.cancel();
              if (p && typeof p.catch === 'function') p.catch(() => { /* 已结束 */ });
            } catch { /* 已结束 */ }
            readerRef = null;
          }
        });
        let upstream = null;
        let ok = false;
        let lastErr = null;
        try {
          upstream = await anthropicMessagesStream(upstreamBody, { signal: abort.signal, sessionId });
          if (!upstream.ok) {
            const errText = await upstream.text().catch(() => '');
            return res.status(upstream.status || 502).json({ error: { message: errText.slice(0, 400) || ('上游 HTTP ' + upstream.status), type: 'upstream_error' } });
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const reader = upstream.body.getReader();
          readerRef = reader;
          const decoder = new TextDecoder();
          let buf = '';
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop() || '';
              for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                let ev;
                try { ev = JSON.parse(payload); } catch { continue; }
                const chunk = anthropicChunkToOpenAi(ev, model);
                if (chunk) res.write('data: ' + JSON.stringify(chunk) + '\n\n');
              }
            }
            res.write('data: [DONE]\n\n');
            res.end();
            readerRef = null;   // R024：流已正常结束，close 事件不必再 cancel
            ok = true;
          } catch (e) {
            ok = false;
            // 审查 R004-6：中断时给客户端一个可解析的 error 事件再结束（不是无声掐断）
            try {
              res.write('data: ' + JSON.stringify({ error: { message: String((e && e.message) || e).slice(0, 300), type: 'upstream_interrupted' } }) + '\n\n');
              res.end();
            } catch { /* 已断开 */ }
          }
        } catch (e) {
          ok = false;
          lastErr = String((e && e.message) || e);
          if (!res.headersSent) {
            res.status(502).json({ error: { message: String((e && e.message) || e), type: 'upstream_error' } });
          }
        } finally {
          // 槽位必须在所有出口释放（正常结束 / 中断 / 上游非 2xx / 抛错），
          // 否则并发槽位会越占越少，最后所有请求都卡在等待上。
          if (upstream) giftStreamRelease(upstream);
          state.stats.ok += ok ? 1 : 0;
          state.stats.failed += ok ? 0 : 1;
          pushLog({ at: startedAt, model, ok, ms: Date.now() - startedAt, status: ok ? 200 : (res.headersSent ? 200 : 502), stream: true, note: lastErr ? lastErr.slice(0, 200) : undefined });
        }
        return;
      }
      // 非流式
      const out = await anthropicMessages(upstreamBody, { timeoutMs: cfg().timeoutMs, sessionId });
      if (!out.ok) {
        state.stats.failed++;
        pushLog({ at: startedAt, model, ok: false, ms: Date.now() - startedAt, status: out.status, error: String(out.error || '').slice(0, 200) });
        // 401 通常是 token 过期：上游 401 时给可操作提示
        const hint = out.status === 401 ? '（ZCode 登录态可能已过期，请到 ZCode 里重新登录后重试）' : '';
        return res.status(out.status || 502).json({ error: { message: String(out.error || '上游请求失败') + hint, type: 'upstream_error' } });
      }
      state.stats.ok++;
      pushLog({ at: startedAt, model, ok: true, ms: Date.now() - startedAt, status: 200, tokens: out.data?.usage || null });
      res.json(anthropicToOpenAi(out.data, model));
    } catch (e) {
      state.stats.failed++;
      pushLog({ at: startedAt, model, ok: false, ms: Date.now() - startedAt, status: 0, error: String((e && e.message) || e).slice(0, 200) });
      res.status(500).json({ error: { message: String((e && e.message) || e), type: 'internal_error' } });
    }
  });
}
