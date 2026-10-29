/**
 * 对话任务补全：自动领取（签到 + 成长中心）里「必须真实发起模型对话」的那类任务。
 *
 * 背景：成长任务里有一类按进度计数的对话任务（如 chat_5「和 AI 聊天 5 次」），
 * 只接单/领奖永远凑不满进度——官方靠**对话请求里附带的上报字段**计进度。
 * 该通道逆向自官方桌面端 5.x（`resources/app.asar.unpacked/cli/dist/codebuddy.js`，
 * 2026-10-22 实测有效）：
 *
 *   POST {chatBase}/v2/chat/completions   （必须 stream:true，非流式一律 400 code 11101）
 *   body: { model, messages, max_tokens, stream: true,
 *           extra_vars: { growthEvent: JSON.stringify([{
 *             eventCode: 'chat_request_send',   // Events.ChatRequestSend
 *             id: '<每次对话唯一>',             // 客户端用会话 id；实测任意唯一串都计进度
 *             extra: { inputLength, requestModelId, requestModelName, mode, command, expertId },
 *           }]) } }
 *
 *   实测：不带 extra_vars.growthEvent 的对话**不计**任务进度（请求本身照常计费进用量流水）；
 *   带上后任务进度即时 +1。inputTrunc 会进官方用量明细（内容可见），所以 prompt 只放固定寒暄语。
 *
 * 模型选择（本需求的重点）：
 *   1. 免费模型优先 —— 实测每次请求 0 积分的模型（2026-10-22 官方逐请求计费流水核对）；
 *   2. 免费模型全部不可用（429/下线/网关错误）才退到**低倍率**付费模型，按实测
 *      每次请求积分升序排列（deepseek-v4.1-flash ≈5.6 < glm-5.3-flash ≈10.9 < hy4-preview ≈41.8）；
 *   3. 用到付费模型必须在报告里点名，让用户知道这轮花了积分。
 *
 * 安全阀：单任务最多补 MAX_CHATS_PER_TASK 次对话；4xx 不算硬失败（换模型重试），
 * 5xx/网络不可达计硬失败并换下一个模型。
 */
import crypto from 'node:crypto';
import { proxyFetch } from '../proxy.mjs';
import { variantOf, officialNetHint } from './variant.mjs';
import { authHeaders } from './credits.mjs';

/** 官方对话端点（与 modelLimits.mjs 的 CHAT_BASE 一致） */
const CHAT_BASE = {
  cn: 'https://copilot.tencent.com',
  ai: 'https://www.workbuddy.ai',
};

/**
 * 免费模型清单（实测 0 积分/次，2026-10-22 计费流水：hy3 12 次、step-5-preview 12 次、
 * wb-lite 11 次全部 credit=0）。按日常稳定性排序，hy3 是用户点名的首选。
 * 官方下线/改名免费模型时需要手工同步这份清单。
 */
export const FREE_MODELS = ['hy3', 'step-5-preview', 'wb-lite'];

/**
 * 低倍率付费模型兜底（实测每次请求积分升序，2026-10-22 计费流水：
 * deepseek-v4.1-flash ≈5.6、glm-5.3-flash ≈10.9、hy4-preview ≈41.8；
 * 其余按会话记录中的常见度补位，真实倍率以官方计费为准——兜底场景本来就该少用）。
 */
export const LOW_RATE_MODELS = [
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'glm-5.2',
  'kimi-k2.7',
  'minimax-m3',
  'deepseek-v4-pro',
  'hy4-preview',
];

/** 候选顺序 = 免费 → 低倍率（completeChatTasks 依此逐个尝试） */
export const MODEL_CANDIDATES = [...FREE_MODELS, ...LOW_RATE_MODELS];

/** 任务进度上报的事件码（官方桌面端 Events.ChatRequestSend） */
export const GROWTH_EVENT_CODE = 'chat_request_send';

/** 只补「和 AI 聊天」类任务：画布/专家/技能/主题等需要客户端专属动作，硬补只会白花钱 */
const CHAT_TASK_RE = /^chat_/;

/** 单任务单轮最多补的对话次数（进度到 target 就停，这里只是失控保险） */
export const MAX_CHATS_PER_TASK = 10;

/** 两次对话之间的间隔：太快像刷量，没必要 */
/** 补对话的节奏：官方语义是"用户聊天 N 次"，人类两次对话之间隔着几十秒到几分钟。
 * 此前固定 1.2s 连发（同内容、同节奏）是教科书级机器特征（2026-10 封号反馈后改）。
 * 取 20~45s 随机：一次任务的几次补聊总共几分钟，巡检本身每小时才有一次，可接受。 */
const CHAT_INTERVAL_MS = () => 20_000 + Math.floor(Math.random() * 25_000);

/** 每账号每日合成聊天总量上限：同一段固定文本的机器对话是 ML 侧最容易聚类的
 * 自动化特征，量越大越危险。单任务上限 10 次之外，这里再加「当日总量 ≤20 次」
 * 的硬闸——多任务叠加时优先保账号安全（内存态，重启清零可接受） */
const DAILY_CHAT_CAP = 20;
const dailyChatCount = new Map(); // `day|accountId` -> number

function bumpDailyChats(accountId) {
  const key = `${new Date().toISOString().slice(0, 10)}|${accountId}`;
  const n = (dailyChatCount.get(key) || 0) + 1;
  dailyChatCount.set(key, n);
  if (dailyChatCount.size > 64) for (const k of dailyChatCount.keys()) if (!k.startsWith(new Date().toISOString().slice(0, 10))) dailyChatCount.delete(k);
  return n;
}

/** 测试钩子：清空每日合成聊天计数（test-growth 的桩场景彼此独立，需要复用配额） */
export function __resetDailyChatCount() {
  dailyChatCount.clear();
}

/** 对话内容固定寒暄——inputTrunc 会进官方用量明细，不放任何隐私 */
const CHAT_PROMPT = '你好，请用一句话打个招呼。';
const CHAT_MAX_TOKENS = 256;

function asInt(v, defaultValue = 0) {
  const n = Number.parseInt(String(v), 10);
  if (Number.isFinite(n)) return n;
  const f = Number.parseFloat(String(v));
  return Number.isFinite(f) ? Math.trunc(f) : defaultValue;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isFreeModel(model) {
  return FREE_MODELS.includes(String(model));
}

/**
 * 从任务列表里挑出「需要补对话」的任务（纯函数，供测试）。
 * 口径：chat_* 前缀、未锁定、已接单（in_progress/accepted）、进度未满。
 * 返回 [{ code, title, need }]，need 已按 MAX_CHATS_PER_TASK 封顶。
 */
export function chatTaskBacklog(tasks) {
  if (!Array.isArray(tasks)) return [];
  const out = [];
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    const code = String(t.task_code || '');
    if (!CHAT_TASK_RE.test(code) || t.locked) continue;
    const status = String(t.accept_status || '');
    if (status !== 'in_progress' && status !== 'accepted') continue;
    const progress = t.progress && typeof t.progress === 'object' ? t.progress : {};
    const current = asInt(progress.current);
    const target = asInt(progress.target);
    if (target <= 0 || current >= target) continue;
    out.push({
      code,
      title: String(t.title || code),
      need: Math.min(target - current, MAX_CHATS_PER_TASK),
    });
  }
  return out;
}

/**
 * 发一次带任务进度上报的对话。成功（HTTP 2xx）即认为进度会 +1。
 * 返回 { ok, hardFailure, message }。
 */
async function sendGrowthChat(account, model, netOpts = {}) {
  const variant = variantOf(account);
  const base = CHAT_BASE[variant.id] || CHAT_BASE.cn;
  const url = `${base}/v2/chat/completions`;
  const growthEvent = JSON.stringify([
    {
      eventCode: GROWTH_EVENT_CODE,
      id: `wb-console-${crypto.randomUUID()}`,
      extra: {
        inputLength: CHAT_PROMPT.length,
        requestModelId: model,
        requestModelName: model,
        mode: 'craft',
        command: '',
        expertId: '',
      },
    },
  ]);
  try {
    const res = await proxyFetch(url, {
      method: 'POST',
      headers: { ...authHeaders(account, url), Accept: 'text/event-stream' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: CHAT_PROMPT }],
        max_tokens: CHAT_MAX_TOKENS,
        stream: true,
        extra_vars: { growthEvent },
      }),
      netHint: officialNetHint(variant.id),
      ...netOpts,
    });
    // 流式响应整体读完（max_tokens 有上限，体量很小），连接正常关闭即可
    await res.text();
    if (res.status >= 200 && res.status < 300) return { ok: true, hardFailure: false, message: '' };
    return { ok: false, hardFailure: res.status >= 500, message: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, hardFailure: true, message: e?.message || '网络不可达' };
  }
}

/**
 * 按候选顺序补足 backlog 里的对话任务。
 * - 每个任务从免费模型开始发；当前模型请求失败就换下一个候选，免费全灭才碰付费；
 * - 用到付费模型时在报告里点名提醒（低倍率也是真金白银的积分）；
 * - 失败绝不抛出：对话补全是附加收益，不能污染签到/成长主流程的结果。
 * 返回 { parts, successes, failures, hardFailures, changed }
 * changed=true 表示有对话发出、任务进度可能变化（调用方应复查并补领奖）。
 */
export async function completeChatTasks(account, backlog, { systemProxy } = {}) {
  const parts = [];
  let successes = 0;
  let failures = 0;
  let hardFailures = 0;
  let changed = false;
  const netOpts = systemProxy === undefined ? {} : { systemProxy };

  for (const item of Array.isArray(backlog) ? backlog : []) {
    if (!item?.code || item.need <= 0) continue;
    let remaining = item.need;
    const modelsUsed = [];

    for (const model of MODEL_CANDIDATES) {
      if (remaining <= 0) break;
      let usedThis = 0;
      while (remaining > 0) {
        // 每日总量硬闸：到顶就收手，任务留到明天（账号安全优先于奖励）
        if (bumpDailyChats(account.id) > DAILY_CHAT_CAP) {
          parts.push(`今日补对话已达保护上限（${DAILY_CHAT_CAP} 次/账号），剩余留到明天`);
          remaining = 0;
          break;
        }
        const r = await sendGrowthChat(account, model, netOpts);
        if (!r.ok) {
          // 当前模型不可用：换下一个候选。首个请求就失败说明模型本身不可用，
          // 已经发过几次才失败则说明是中途断供，两种都要如实记录。
          parts.push(
            usedThis === 0
              ? `模型 ${model} 不可用（${r.message}）`
              : `模型 ${model} 发送 ${usedThis} 次后不可用（${r.message}）`
          );
          if (r.hardFailure) hardFailures += 1;
          break;
        }
        remaining -= 1;
        usedThis += 1;
        changed = true;
        if (!modelsUsed.includes(model)) modelsUsed.push(model);
        if (remaining > 0) await sleep(CHAT_INTERVAL_MS());
      }
    }

    const paidUsed = modelsUsed.filter((m) => !isFreeModel(m));
    if (remaining <= 0) {
      const paidNote = paidUsed.length
        ? `（付费模型 ${paidUsed.join('、')}，已消耗积分）`
        : `（免费模型 ${modelsUsed.join('、')}）`;
      parts.push(`对话任务「${item.title}」已补 ${item.need} 次对话${paidNote}`);
      successes += 1;
    } else {
      const tried = modelsUsed.length ? `，${modelsUsed.join('、')} 共发出 ${item.need - remaining} 次` : '';
      parts.push(`对话任务「${item.title}」还差 ${remaining} 次：所有候选模型均不可用${tried}`);
      failures += 1;
    }
  }

  return { parts, successes, failures, hardFailures, changed };
}
