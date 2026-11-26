/**
 * Loomy 反向代理（讯飞 Loomy 桌面客户端，本机实测 0.9.39）：
 *
 * 上游是 OpenAI 兼容端点 https://loomyad.xunfei.cn/api/v1（Loomy 客户端内置 opencode 内核，
 * provider 走 @ai-sdk/openai-compatible），登录凭据是明文 session：
 *   C:/Users/Public/Loomy/<profile>/userData/auth-session.json → { session, userid, phone, updatedAt }
 *
 * 本模块做的事（架构对齐 server/zcode/proxyCore.mjs）：
 * - 挂在本控制台 Express 上（/v1L/*），不另起端口；配置独立 cfg.loomyProxy
 * - 入站 OpenAI 兼容（/v1L/chat/completions、/v1L/models），出站**纯透传**（协议同构，无需转换）
 * - 鉴权 Bearer sk-loomy-*；请求日志、最小间隔节流，语义与 ZCode 反代一致
 * - 凭据 watcher：auth-session.json 变化（换号/重登）自动跟随新 session
 *
 * 实测要点（2026-11-26）：
 * - 上游只认 `Authorization: Bearer <session>`；归因头（TurnId/ChatId 等）不强制
 * - 上游 stream:false 会长时间挂起（实测 40s 0 字节）→ 无论客户端请求流式与否，
 *   出站统一 stream:true；客户端要非流式时在本地聚合 SSE 成完整 OpenAI 响应
 * - /api/v1/models 用 session 鉴权报「缺少 token」→ 模型清单改读本机 opencode.json
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfigAsync } from '../store/config.mjs';

const UPSTREAM_BASE = 'https://loomyad.xunfei.cn/api/v1';
const LOG_LIMIT = 200;

/** opencode.json 读不到时的兜底模型清单（2026-11-26 实测本机配置） */
const FALLBACK_MODELS = [
  { id: 'spark-x2.6', name: 'Spark-X2.6 正式版(x2.5)' },
  { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash(x2.0)' },
  { id: 'deepseek-v4-flash-1017', name: 'DeepSeek V4.1 Flash 1017(x2.0)' },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash(x0.8)' },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' },
];

const state = {
  logs: [],
  stats: { total: 0, ok: 0, failed: 0, lastAt: null },
  lastRequestAt: 0,
  sessionCache: null, // { session, userid, phone, file, mtime, updatedAt }
  sessionError: null,
  lastSessionChangeAt: null,
};

function newProxyKey() {
  return 'sk-loomy-' + crypto.randomBytes(16).toString('hex');
}

function cfg() {
  const c = loadConfig();
  if (!c.loomyProxy) c.loomyProxy = { enabled: false, apiKey: '', timeoutMs: 600_000, minIntervalMs: 3_000 };
  return c.loomyProxy;
}

function pushLog(entry) {
  state.logs.unshift(entry);
  if (state.logs.length > LOG_LIMIT) state.logs.length = LOG_LIMIT;
}

/* ---------------- 凭据发现与读取 ---------------- */

/** 扫描本机 Loomy 数据根，返回 auth-session.json 候选列表（按 mtime 新→旧） */
function findSessionFiles() {
  const out = [];
  if (process.env.LOOMY_SESSION_FILE && fs.existsSync(process.env.LOOMY_SESSION_FILE)) {
    out.push(process.env.LOOMY_SESSION_FILE);
  }
  const roots = [path.join('C:', 'Users', 'Public', 'Loomy')];
  for (const root of roots) {
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const p = path.join(root, ent.name, 'userData', 'auth-session.json');
        if (fs.existsSync(p)) out.push(p);
      }
    } catch { /* 根目录不存在 */ }
  }
  return out
    .map((p) => ({ p, st: fs.statSync(p) }))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .map((x) => ({ p: x.p, mtimeMs: x.st.mtimeMs, size: x.st.size }));
}

/** 读当前登录态（带缓存；force 跳过缓存）。失败返回 null 并记录原因。 */
export function readLoomySession(force = false) {
  if (!force && state.sessionCache) return state.sessionCache;
  state.sessionCache = null;
  state.sessionError = null;
  const candidates = findSessionFiles();
  if (!candidates.length) {
    state.sessionError = '未找到 Loomy 登录凭据（auth-session.json）。请确认 Loomy 已安装并登录过；也可用环境变量 LOOMY_SESSION_FILE 指定凭据文件路径。';
    return null;
  }
  const top = candidates[0];
  try {
    const j = JSON.parse(fs.readFileSync(top.p, 'utf8'));
    if (!j.session) {
      state.sessionError = '凭据文件里没有 session 字段（可能未登录）：' + top.p;
      return null;
    }
    state.sessionCache = {
      session: String(j.session),
      userid: String(j.userid || ''),
      phone: String(j.phone || ''),
      file: top.p,
      mtimeMs: top.mtimeMs,
      updatedAt: Number(j.updatedAt) || top.mtimeMs,
    };
  } catch (e) {
    state.sessionError = '读取凭据失败：' + String((e && e.message) || e);
  }
  return state.sessionCache;
}

function maskPhone(phone) {
  const p = String(phone || '');
  return p.length >= 7 ? p.slice(0, 3) + '****' + p.slice(-4) : p || '';
}

/** 登录态 watcher：每 15s 重扫 + 比对指纹，变化即失效缓存并回调 */
let watcherStarted = false;
export function startLoomySessionWatcher(onChange) {
  if (watcherStarted) return;
  watcherStarted = true;
  let lastFingerprint = '';
  const tick = () => {
    const candidates = findSessionFiles();
    const fp = candidates.map((c) => `${c.p}:${c.mtimeMs}:${c.size}`).join('|');
    const prev = readLoomySession();
    const prevFp = prev ? `${prev.file}:${prev.mtimeMs}` : state.sessionError || '';
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      const before = state.sessionCache ? `${state.sessionCache.file}:${state.sessionCache.mtimeMs}` : null;
      readLoomySession(true);
      const after = state.sessionCache ? `${state.sessionCache.file}:${state.sessionCache.mtimeMs}` : null;
      // 只有「有 → 有且不同」或「无 → 有」才算有效变化（首次启动不算）
      if (before && after && before !== after) {
        state.lastSessionChangeAt = Date.now();
        try { onChange && onChange({ ok: !!state.sessionCache, error: state.sessionError }); } catch { /* 回调异常不影响轮询 */ }
      } else if (!before && after && prevFp !== lastFingerprint.split('|')[0]) {
        // 首次拿到凭据，不触发横幅
      }
    }
  };
  tick();
  setInterval(tick, 15_000).unref();
}

/* ---------------- 模型清单 ---------------- */

/** 从本机 Loomy 的 opencode.json 读模型清单（跟随客户端更新），读不到用兜底 */
export function listUpstreamModels() {
  try {
    const candidates = findSessionFiles();
    if (candidates.length) {
      const cfgPath = path.join(path.dirname(path.dirname(candidates[0].p)), 'opencode', 'opencode.json');
      if (fs.existsSync(cfgPath)) {
        const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const models = j?.provider?.imodel?.models || {};
        const list = Object.entries(models).map(([id, m]) => ({ id, name: String(m?.name || id) }));
        if (list.length) return list;
      }
    }
  } catch { /* 落兜底 */ }
  return FALLBACK_MODELS;
}

/* ---------------- 上游调用 ---------------- */

function upstreamHeaders(sess) {
  const h = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + sess.session,
  };
  if (sess.userid) h['x-user-id'] = sess.userid;
  return h;
}

/**
 * 上游对话（统一 stream:true 出站）。
 * 返回 { ok, status, reader|data, error }：
 * - wantStream=true：返回上游 ReadableStream（OpenAI SSE 原样）
 * - wantStream=false：在本地聚合为完整 OpenAI chat.completion 对象
 */
export async function loomyChat({ body, wantStream, timeoutMs, signal }) {
  const sess = readLoomySession();
  if (!sess) return { ok: false, status: 0, error: state.sessionError || 'Loomy 登录态不可用' };
  const upstreamBody = JSON.stringify({ ...body, stream: true });
  let res;
  try {
    res = await fetch(UPSTREAM_BASE + '/chat/completions', {
      method: 'POST',
      headers: upstreamHeaders(sess),
      body: upstreamBody,
      signal,
    });
  } catch (e) {
    return { ok: false, status: 0, error: '上游连接失败：' + String((e && e.message) || e) };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let hint = '';
    if (res.status === 401) hint = '（Loomy 登录态可能已过期，请打开 Loomy 重新登录后重试）';
    return { ok: false, status: res.status, error: (text.slice(0, 400) || '上游 HTTP ' + res.status) + hint };
  }
  if (!res.body) return { ok: false, status: res.status, error: '上游无响应体' };

  if (wantStream) return { ok: true, status: res.status, reader: res.body.getReader(), release: () => { try { const p = res.body.cancel(); if (p && typeof p.catch === 'function') p.catch(() => { /* 已结束 */ }); } catch { /* 已结束 */ } } };

  // 非流式：聚合 SSE → 完整 OpenAI completion
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  let id = 'chatcmpl-loomy';
  const deadline = Date.now() + Math.max(10_000, Number(timeoutMs) || 600_000);
  try {
    for (;;) {
      if (Date.now() > deadline) return { ok: false, status: 504, error: '上游响应超时' };
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
        if (ev.id) id = ev.id;
        if (ev.usage && typeof ev.usage === 'object') usage = ev.usage;
        const d = ev.choices?.[0]?.delta;
        if (d?.content) content += d.content;
        if (d?.reasoning_content) reasoning += d.reasoning_content;
        if (ev.choices?.[0]?.finish_reason) finish = ev.choices[0].finish_reason;
      }
    }
  } catch (e) {
    return { ok: false, status: 502, error: '读取上游流失败：' + String((e && e.message) || e) };
  }
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    ok: true,
    status: 200,
    data: {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: String(body?.model || ''),
      choices: [{ index: 0, message, finish_reason: finish || 'stop' }],
      usage: usage
        ? {
            prompt_tokens: Number(usage.prompt_tokens || 0),
            completion_tokens: Number(usage.completion_tokens || 0),
            total_tokens: Number(usage.total_tokens ?? (Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0))),
          }
        : undefined,
    },
  };
}

/* ---------------- 节流 ---------------- */

let throttleChain = Promise.resolve();
async function throttle() {
  const run = throttleChain.catch(() => {}).then(async () => {
    const lc = cfg();
    const min = Math.max(0, Number(lc.minIntervalMs) || 0);
    if (min > 0) {
      const wait = state.lastRequestAt + min - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    state.lastRequestAt = Date.now();
  });
  throttleChain = run;
  await run;
}

/* ---------------- 登录态变化通知（watcher → 状态横幅） ---------------- */

export function loomyCredentialSnapshot() {
  return {
    ok: !!state.sessionCache,
    error: state.sessionError,
    phoneMasked: maskPhone(state.sessionCache?.phone),
    userid: state.sessionCache?.userid || '',
    updatedAt: state.sessionCache?.updatedAt || null,
    file: state.sessionCache?.file || null,
    changedRecently: !!state.lastSessionChangeAt && Date.now() - state.lastSessionChangeAt < 300_000,
  };
}

/* ---------------- 路由注册 ---------------- */

export function registerLoomyRoutes(app, { port }) {
  // 状态
  app.get('/api/loomy/proxy/status', (req, res) => {
    const lc = cfg();
    const models = listUpstreamModels();
    res.json({
      enabled: !!lc.enabled,
      apiKeySet: !!lc.apiKey,
      endpoint: 'http://127.0.0.1:' + port + '/v1L',
      upstream: UPSTREAM_BASE.replace('https://', '') + '（OpenAI 兼容 · 读本机 Loomy 登录态 · 消耗该账号每日赠送积分）',
      credential: loomyCredentialSnapshot(),
      timeoutMs: lc.timeoutMs,
      minIntervalMs: lc.minIntervalMs,
      stats: state.stats,
      logs: state.logs,
      models,
    });
  });

  // 开关 + Key 配置（响应必须回显 enabled：前端开关靠响应值回填状态）
  app.put('/api/loomy/proxy/config', async (req, res) => {
    try {
      const c = loadConfig();
      if (!c.loomyProxy) c.loomyProxy = { enabled: false, apiKey: '', timeoutMs: 600_000, minIntervalMs: 3_000 };
      if (typeof req.body?.enabled === 'boolean') {
        c.loomyProxy.enabled = req.body.enabled;
        if (req.body.enabled && !c.loomyProxy.apiKey) c.loomyProxy.apiKey = newProxyKey();
      }
      if (req.body?.regenerateKey === true) c.loomyProxy.apiKey = newProxyKey();
      if (Number.isFinite(req.body?.timeoutMs) && req.body.timeoutMs >= 10_000) c.loomyProxy.timeoutMs = req.body.timeoutMs;
      if (Number.isFinite(req.body?.minIntervalMs) && req.body.minIntervalMs >= 0) c.loomyProxy.minIntervalMs = req.body.minIntervalMs;
      await saveConfigAsync(c);
      const reveal = req.query.reveal === '1';
      res.json({
        ok: true,
        enabled: c.loomyProxy.enabled,
        apiKeySet: !!c.loomyProxy.apiKey,
        ...(reveal ? { apiKey: c.loomyProxy.apiKey } : {}),
        timeoutMs: c.loomyProxy.timeoutMs,
        minIntervalMs: c.loomyProxy.minIntervalMs,
      });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // 明文 Key（点「显示 / 复制」时才取一次）
  app.get('/api/loomy/proxy/reveal-key', (req, res) => {
    const lc = cfg();
    if (!lc.apiKey) return res.status(404).json({ error: '还没有调用 Key：请先开启反向代理' });
    res.json({ apiKey: lc.apiKey });
  });

  // 上游连通测试：拿当前 session 发一条最小请求（聚合非流式）
  app.post('/api/loomy/proxy/test', async (req, res) => {
    const startedAt = Date.now();
    const model = String(req.body?.model || 'GLM-5.3-Flash');
    try {
      const out = await loomyChat({
        body: { model, messages: [{ role: 'user', content: '回复"ok"两个字，不要其他内容' }] },
        wantStream: false,
        timeoutMs: 90_000,
      });
      if (!out.ok) {
        return res.json({ ok: false, status: out.status || 0, error: String(out.error || '未知错误'), ms: Date.now() - startedAt });
      }
      const text = out.data?.choices?.[0]?.message?.content || '';
      res.json({ ok: true, reply: text.slice(0, 200), usage: out.data?.usage || null, model, ms: Date.now() - startedAt });
    } catch (e) {
      res.json({ ok: false, status: 0, error: String((e && e.message) || e), ms: Date.now() - startedAt });
    }
  });

  // 数据面：/v1L/*
  app.use('/v1L', (req, res, next) => {
    const lc = cfg();
    if (!lc.enabled) return res.status(404).json({ error: { message: 'Loomy 反向代理未开启' } });
    const auth = String(req.headers['authorization'] || '');
    const key = auth.replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
    if (!lc.apiKey || key !== lc.apiKey) return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
    next();
  });

  app.get('/v1L/models', (req, res) => {
    res.json({
      object: 'list',
      data: listUpstreamModels().map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'loomy' })),
    });
  });

  app.post('/v1L/chat/completions', async (req, res) => {
    const startedAt = Date.now();
    const body = req.body || {};
    const model = String(body.model || '');
    state.stats.total++;
    try {
      await throttle();
      const wantStream = !!body.stream;
      // 客户端断连 → abort 上游（对齐 ZCode 反代：close → destroy，避免白烧积分）
      const abort = new AbortController();
      let readerRef = null;
      let releaseRef = null;
      res.on('close', () => {
        abort.abort();
        if (readerRef) {
          try {
            const p = readerRef.cancel();
            if (p && typeof p.catch === 'function') p.catch(() => { /* 已结束 */ });
          } catch { /* 已结束 */ }
          readerRef = null;
        }
        if (releaseRef) { try { releaseRef(); } catch { /* 已结束 */ } releaseRef = null; }
      });

      const out = await loomyChat({ body, wantStream, timeoutMs: cfg().timeoutMs, signal: abort.signal });
      if (!out.ok) {
        state.stats.failed++;
        pushLog({ at: startedAt, model, ok: false, ms: Date.now() - startedAt, status: out.status || 0, error: String(out.error || '').slice(0, 200), stream: wantStream });
        return res.status(out.status && out.status >= 400 ? out.status : 502).json({ error: { message: String(out.error || '上游请求失败'), type: 'upstream_error' } });
      }

      if (wantStream) {
        // 纯透传：上游本来就是 OpenAI SSE
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        readerRef = out.reader;
        releaseRef = out.release;
        let tokens = null;
        try {
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await readerRef.read();
            if (done) break;
            res.write(value);
            // 只解析计数，不改动透传内容
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const ev = JSON.parse(payload);
                if (ev.usage && typeof ev.usage === 'object') tokens = ev.usage;
              } catch { /* 非 JSON 行忽略 */ }
            }
          }
          res.end();
          readerRef = null;
          state.stats.ok++;
          pushLog({ at: startedAt, model, ok: true, ms: Date.now() - startedAt, status: 200, stream: true, tokens });
        } catch (e) {
          state.stats.failed++;
          try {
            res.write('data: ' + JSON.stringify({ error: { message: String((e && e.message) || e).slice(0, 300), type: 'upstream_interrupted' } }) + '\n\n');
            res.end();
          } catch { /* 已断开 */ }
          pushLog({ at: startedAt, model, ok: false, ms: Date.now() - startedAt, status: res.headersSent ? 200 : 502, stream: true, error: String((e && e.message) || e).slice(0, 200) });
        } finally {
          if (releaseRef) { try { releaseRef(); } catch { /* 已结束 */ } releaseRef = null; }
        }
        return;
      }

      // 非流式：聚合结果直接回
      state.stats.ok++;
      pushLog({ at: startedAt, model, ok: true, ms: Date.now() - startedAt, status: 200, stream: false, tokens: out.data?.usage || null });
      res.json(out.data);
    } catch (e) {
      state.stats.failed++;
      pushLog({ at: startedAt, model, ok: false, ms: Date.now() - startedAt, status: 0, error: String((e && e.message) || e).slice(0, 200) });
      if (!res.headersSent) res.status(500).json({ error: { message: String((e && e.message) || e), type: 'internal_error' } });
    }
  });
}
