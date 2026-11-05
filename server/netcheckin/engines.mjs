/**
 * 各平台的签到执行引擎。
 *
 * 返回值统一为 { status, detail, url?, meta? }，status 取值：
 *   success     本次签到成功
 *   already     今天已经领过（幂等，等于成功）
 *   needs_login 登录态失效 → 点「登录」重新授权
 *   not_installed 桌面版平台没装客户端
 *   needs_manual  客户端开着但没开调试端口（不强杀用户正在用的窗口）
 *   offline / timeout / not_found / uncertain / failed / error
 *
 * 每种引擎都是被真实平台逼出来的形态，注释里写了各自的坑。
 */

import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadPlaywright } from './browser.mjs';
import {
  pageVisibleText,
  detectLoginWall,
  findCandidateButtons,
  clickFirstCandidate,
  readOutcome,
  openAndWait,
  closeOverlays,
  snapshot,
  dumpHtml,
  listVisibleButtons,
} from './dom.mjs';
import { resolveClientExe, isClientRunning, quitClientGracefully } from './registry.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (s) => String(s ?? '').split('\n')[0];

/**
 * 声明式完成判定 doneRule: { present: [...], absent: [...] }。
 * 有些平台领完之后入口按钮直接消失（豆包的「立即签到」就没有变灰文案），
 * doneKeywords 永远等不到。规则语义：present 全部出现 且 absent 全部不出现
 * → 视为今日已完成。页面没加载出来时 present 不满足，不会误判。
 */
export function doneRuleHit(text, rule) {
  if (!rule) return false;
  const present = Array.isArray(rule.present) ? rule.present : [];
  const absent = Array.isArray(rule.absent) ? rule.absent : [];
  if (!present.length && !absent.length) return false;
  return present.every((k) => text.includes(k)) && absent.every((k) => !text.includes(k));
}

/* ======================================================================
 * 智谱清言：纯接口代领
 * ======================================================================
 * 签到不是按钮，而是页面加载时前端自动调用的接口，所以不需要找 DOM：
 *   POST /chatglm/member-api/member/daily_login_score  body {}
 *   - status=10001 → 今天已经领过；接口幂等，重复调用无副作用
 *   - 签名 X-Sign = md5(ts-nonce-secret)，appSecret 是前端 bundle
 *     里的公开常量（社区多个开源项目共同确认），不需要抓包
 *   - 本机设备标识放在 localStorage['chatglm-deid']，要跟 token 内嵌的 device_id 对得上
 *   - member-api 的鉴权接口必须带 Authorization: Bearer <chatglm_token>，
 *     只带 cookie 会一律 40003（bad request），与登录是否有效无关
 * 登录态是 cookie chatglm_token（约 24h）+ refresh_token（约 50 天）；
 * 页面加载时前端会自动调刷新接口续期，所以每次先打开一次首页即可。
 */

const ZHIPU_APP_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';

export function zhipuHeaders(deviceId, { appVersion = '2.0.7', token = '' } = {}) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString('hex');
  const sign = createHash('md5').update(`${ts}-${nonce}-${ZHIPU_APP_SECRET}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'App-Name': 'chatglm',
    'X-App-Platform': 'pc',
    'X-App-Version': appVersion,
    'X-Device-Id': deviceId,
    'X-Timestamp': ts,
    'X-Nonce': nonce,
    'X-Sign': sign,
    // member-api 的鉴权接口（member_info / daily_login_score）认 Bearer 头，
    // 只靠 cookie 会一律 40003「bad request」——登录有效也会被当成失效
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** 从页面上下文取签名要用的两样东西：设备 ID + chatglm_token（可能是 HttpOnly，必须走 CDP 读） */
export async function zhipuAuthMaterial(page) {
  const ctx = page.context();
  const [deid, token] = await Promise.all([
    page.evaluate(() => localStorage.getItem('chatglm-deid') || '').catch(() => ''),
    ctx
      .cookies('https://chatglm.cn')
      .then((cs) => cs.find((c) => c.name === 'chatglm_token' && c.value)?.value || '')
      .catch(() => ''),
  ]);
  return { deid, token };
}

/**
 * 智谱登录态体检（登录检测与检测共用）：
 * 登录成功后 SPA 会跳进 /main/ 路由——这是站点自己的行为，最可靠；
 * 次选：cookie 存在时用带签名的 member_info 验证（裸调恒 40003，必须带 Bearer）。
 */
export async function zhipuProbe(page) {
  if (/chatglm\.cn\/main\//.test(page.url())) return { ok: true, why: '已进入登录后的界面' };
  const cookies = await page.context().cookies('https://chatglm.cn').catch(() => []);
  if (!cookies.some((c) => c.name === 'chatglm_token' && c.value)) return { ok: false, why: 'no-cookie' };
  const { deid, token } = await zhipuAuthMaterial(page).catch(() => ({ deid: '', token: '' }));
  if (!token) return { ok: false, why: 'no-cookie' };
  const headers = zhipuHeaders(deid, { token });
  const res = await page
    .evaluate(async (headers) => {
      try {
        const r = await fetch('/chatglm/member-api/member/member_info', { headers, credentials: 'include' });
        let code = '';
        let message = '';
        try {
          const j = await r.json();
          code = String(j?.status ?? j?.code ?? '');
          message = String(j?.message || '');
        } catch {
          /* 非 JSON 响应 */
        }
        return { http: r.status, code, message };
      } catch (e) {
        return { http: 0, code: '', message: String(e).split('\n')[0] };
      }
    })
    .catch(() => ({ http: -1, code: '', message: 'evaluate 失败' }));
  const ok = res.http === 200 && (res.code === '' || res.code === '10000' || res.code === '0');
  const pageUrl = page.url().replace(/^https?:\/\//, '').slice(0, 40);
  const why = ok
    ? 'cookie+接口有效'
    : `接口 HTTP ${res.http}${res.code ? ` / ${res.code}` : ''}${res.message ? ` ${res.message}` : ''}（页面=${pageUrl}）`;
  return { ok, why };
}

/** 智谱检测：领取走签名接口而非页面按钮，页面体检对它没有意义——直接验证登录态 */
export async function zhipuProbeRun(page, logger) {
  await openAndWait(page, 'https://chatglm.cn/', logger, { settle: 1200 });
  const r = await zhipuProbe(page);
  return r.ok
    ? { status: 'dry_run', detail: `检测通过：登录态有效（${r.why}）` }
    : { status: 'needs_login', detail: `登录态无效（${r.why}），点「登录」重新授权一次即可` };
}

/** 百度 Comate 检测：领取入口可能在 IDE 插件里，网页试运行只验证百度登录态 */
export async function comateProbeRun(page, ctx, logger) {
  await openAndWait(page, 'https://comate.baidu.com/', logger, { settle: 1500 });
  const cookies = await ctx.cookies('https://comate.baidu.com').catch(() => []);
  const ok = cookies.some((c) => (c.name === 'BDUSS' || c.name === 'BDUSS_BFESS') && c.value);
  return ok
    ? { status: 'dry_run', detail: '检测通过：百度登录态有效（领取入口可能在 IDE 插件里）' }
    : { status: 'needs_login', detail: '未检测到百度登录态，点「登录」重新授权一次' };
}

/** member_info 的 left_score 是 1/100 精度，转成日常数值 */
function zhipuPoints(member) {
  try {
    const v = member?.json?.result?.left_score ?? member?.json?.result?.data?.left_score;
    if (v === undefined || v === null) return null;
    const n = Number(v) / 100;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function runZhipu(page, logger) {
  // 1) 打开首页：让前端自己完成 token 续期，同时确保同源（cookie 才会带上）
  await openAndWait(page, 'https://chatglm.cn/', logger, { settle: 1500 });
  await pageVisibleText(page, 2000);

  // 2) 设备 ID 必须与 token 内 device_id 一致，否则接口返回 40003
  const { deid, token } = await zhipuAuthMaterial(page);
  if (!deid) logger?.warn?.('chatglm-deid 没取到，先用随机值顶替（有被当成陌生设备的风险）');
  if (!token) logger?.warn?.('没拿到 chatglm_token（接口会报 40003，得重新登录）');
  const headers = zhipuHeaders(deid || crypto.randomUUID(), { token });

  // 3) 借页面自己的环境发请求：cookie、origin、UA 都是现成的
  const res = await page.evaluate(
    async ({ headers }) => {
      const call = async (url, method = 'POST') => {
        try {
          const r = await fetch(url, {
            method,
            headers,
            body: method === 'POST' ? '{}' : undefined,
            credentials: 'include',
          });
          const text = await r.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON 响应 */
          }
          return { http: r.status, json, text: text.slice(0, 300) };
        } catch (e) {
          return { http: 0, error: firstLine(e?.message || e) };
        }
      };
      return {
        checkin: await call('/chatglm/member-api/member/daily_login_score', 'POST'),
        member: await call('/chatglm/member-api/member/member_info', 'GET'),
      };
    },
    { headers },
  );

  const ck = res.checkin || {};
  const body = ck.json || {};
  const code = String(body.status ?? body.code ?? '');
  logger?.step?.(`官方接口返回 HTTP ${ck.http}${ck.http >= 400 ? '（未放行，通常是登录态问题）' : ''}`);

  if (ck.http === 401 || code === '40003' || code === '40102' || code === '401') {
    return { status: 'needs_login', detail: '登录已失效，点「登录」重新授权一次即可' };
  }
  if (code === '10001') {
    const pts = zhipuPoints(res.member);
    return { status: 'already', detail: `今日已领取过${pts !== null ? `，当前积分 ${pts}` : ''}`, meta: { credits: pts } };
  }
  if (ck.http === 200 && (code === '10000' || code === '0' || code === '')) {
    const pts = zhipuPoints(res.member);
    const gained = body.result?.score ?? body.result?.left_score ?? null;
    const gainTxt = gained !== null && gained !== undefined ? ` +${Number(gained) / (Number(gained) > 1000 ? 100 : 1)} 积分` : '';
    return {
      status: 'success',
      detail: `领取成功${gainTxt}${pts !== null ? `，当前积分 ${pts}` : ''}`,
      meta: { credits: pts, todayCredit: gained !== null ? Number(gained) : undefined },
    };
  }
  return { status: 'failed', detail: `官方接口返回异常（HTTP ${ck.http}${body.message || body.msg ? `：${body.message || body.msg}` : ''}）` };
}

/* ======================================================================
 * 通用网页流程：打开入口 → 识别登录墙 → 找按钮 → 真实点击
 * ======================================================================
 * 大多数平台的签到就是一个带文案的按钮，这套通用流程 + 可配置关键词就能覆盖；
 * 平台改版后把新文案补进 config 的 keywords 即可，不用改代码。
 */

export async function runGenericWeb(platform, page, logger) {
  const urls = platform.entryUrls.length ? platform.entryUrls : [platform.homepage];
  const lastReason = [];

  for (const url of urls) {
    let text = '';
    try {
      await openAndWait(page, url, logger);
      await closeOverlays(page, logger);
      text = await pageVisibleText(page);
    } catch (e) {
      lastReason.push(`${url} 打开失败: ${firstLine(e?.message || e)}`);
      logger?.warn?.(lastReason[lastReason.length - 1]);
      continue;
    }

    const login = await detectLoginWall(page, text);
    if (login.needLogin) {
      logger?.warn?.(`${login.reason} → 需要重新登录`);
      return { status: 'needs_login', detail: login.reason, url: page.url() };
    }

    // 登录即到账的平台（Vidu 等）：积分随访问自动发放，没有「签到按钮」可点——
    // 确认页面已进入登录后的状态就算领取完成；被人机验证拦住则如实报告
    if (platform.visitClaim) {
      if (/验证您是真人|请按住滑块|拖动到最右|人机验证|安全验证/.test(text)) {
        return { status: 'uncertain', detail: '被人机验证拦截，稍后自动重试', url: page.url() };
      }
      if (/(^|\n)\s*(登录 \/ 注册|登录\/注册|登录|注册)\s*(\n|$)/.test(text)) {
        return { status: 'needs_login', detail: '登录入口仍在，点「重新登录」授权一次', url: page.url() };
      }
      if (platform.loginProbePath && page.url().includes(platform.loginProbePath)) {
        return { status: 'success', detail: '已到账（登录即送，打开页面即发放）', url: page.url() };
      }
      // 页面出现平台专属的登录后字样（如吐司页头的「算力」余额）= 已登录且已到账
      const okHit = (platform.loginOkTexts || []).find((k) => k && text.includes(k));
      if (okHit) {
        return { status: 'success', detail: `已到账（页面出现「${okHit}」，登录即送，无独立签到按钮）`, url: page.url() };
      }
      return { status: 'needs_login', detail: '未检测到登录态——点「重新登录」授权一次', url: page.url() };
    }

    // 幂等保护：页面已显示完成就不再点
    const doneHit = platform.doneKeywords.find((k) => text.includes(k));
    const cls = readOutcome(text);
    if (doneHit || cls.already || doneRuleHit(text, platform.doneRule)) {
      const why = doneHit || (cls.already ? '已签到/已领取' : '领取入口已消失（doneRule 命中）');
      logger?.ok?.(`今天已完成（${why}）`);
      return { status: 'already', detail: why, url: page.url() };
    }

    const res = await clickFirstCandidate(page, platform.keywords, logger, { label: platform.name });
    const out = res.outcome || {};
    await sleep(600);

    if (out.already) return { status: 'already', detail: `点击后提示已完成（${res.text}）`, url: page.url() };
    if (out.success) return { status: 'success', detail: `点击「${res.text}」后提示成功`, url: page.url() };
    if (out.fail) return { status: 'failed', detail: `点击「${res.text}」后提示失败`, url: page.url() };
    if (res.clicked) return { status: 'uncertain', detail: `已点击「${res.text}」，未能确认结果`, url: page.url() };

    lastReason.push(`${url} 页面上没有领取入口`);
    logger?.warn?.(lastReason[lastReason.length - 1]);
  }

  // 兜底：只有「登录」字样、没有已登录标志、也没有领取按钮 → 基本是登录态过期
  try {
    const tail = await pageVisibleText(page, 4000);
    const weakLogin = /登录/.test(tail) && !/(退出登录|切换账号|个人中心|我的主页|账户设置)/.test(tail);
    if (weakLogin) {
      return { status: 'needs_login', detail: '未找到领取入口，且登录态已失效', url: page.url() };
    }
  } catch {
    /* ignore */
  }

  return { status: 'not_found', detail: lastReason.join('；') || '没有找到领取入口', url: page.url() };
}

/** 通用流程的检测模式：只查登录态 + 列出能看到哪些候选按钮，不点击 */
export async function dryRunWeb(platform, page, logger) {
  const url = platform.entryUrls[0] || platform.homepage;
  await openAndWait(page, url, logger);
  await closeOverlays(page, logger);
  const text = await pageVisibleText(page);
  const login = await detectLoginWall(page, text);
  const cands = await findCandidateButtons(page, platform.keywords);
  const allButtons = await listVisibleButtons(page);

  if (login.needLogin) return { status: 'needs_login', detail: login.reason, url: page.url(), candidates: [] };
  // 登录即到账的平台：检测语义与正式运行一致（被人机验证拦截/登录入口仍在/已登录）
  if (platform.visitClaim) {
    if (/验证您是真人|请按住滑块|拖动到最右|人机验证|安全验证/.test(text)) {
      return { status: 'uncertain', detail: '被人机验证拦截，稍后自动重试', url: page.url(), candidates: [], buttons: allButtons };
    }
    if (/(^|\n)\s*(登录 \/ 注册|登录\/注册|登录|注册)\s*(\n|$)/.test(text)) {
      return { status: 'needs_login', detail: '登录入口仍在（点「登录」授权一次）', url: page.url(), candidates: [], buttons: allButtons };
    }
    // 探测路径命中（登录后仍停留的页面地址）= 已登录的正证
    if (platform.loginProbePath && page.url().includes(platform.loginProbePath)) {
      return { status: 'dry_run', detail: '检测通过：已登录（登录即送平台，访问即到账）', url: page.url(), candidates: [], buttons: allButtons };
    }
    // 页面出现平台专属的登录后字样（如吐司页头的「算力」余额）= 已登录
    const okHit = (platform.loginOkTexts || []).find((k) => k && text.includes(k));
    if (okHit) {
      return { status: 'dry_run', detail: `检测通过：页面出现「${okHit}」，已登录且已到账`, url: page.url(), candidates: [], buttons: allButtons };
    }
    return { status: 'needs_login', detail: '未检测到登录态——点「登录」在工具里登录一次后再检测', url: page.url(), candidates: [], buttons: allButtons };
  }
  if (doneRuleHit(text, platform.doneRule)) {
    return { status: 'dry_run', detail: '检测通过：页面处于今日已完成状态（领取入口已消失）', url: page.url(), candidates: [], buttons: allButtons };
  }
  if (cands.length) {
    return {
      status: 'dry_run',
      detail: `检测通过：命中入口 ${cands.length} 个「${cands.map((c) => c.text).slice(0, 5).join(' / ')}」（未点击）`,
      url: page.url(),
      candidates: cands,
      buttons: allButtons,
    };
  }
  return {
    status: 'not_found',
    detail: `没发现关键词命中按钮；页面按钮：${allButtons.slice(0, 12).join(' / ') || '（无）'}`,
    url: page.url(),
    candidates: [],
    buttons: allButtons,
  };
}

/* ======================================================================
 * MiniMax Code：签到入口藏在账户菜单里，需要多步导航
 * ======================================================================
 * 首页的签到面板只在「今天还没签」时出现，签过就没了。所以三步走：
 * ① 先等首页的面板；② 不出现就从账户菜单进「每日签到」看弹窗；③ 两处都落空才算没找到。
 */

const MINIMAX_HOME = 'https://agent.minimax.cn/';
const MINIMAX_DONE_TEXTS = ['今日已签到', '已签到', '明天再来'];

async function clickVisibleText(page, texts, logger) {
  for (const t of texts) {
    try {
      const el = page.locator(`text=${t}`).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click({ timeout: 4000 });
        logger?.step?.(`点击「${t}」`);
        return true;
      }
    } catch {
      /* 换下一个 */
    }
  }
  return false;
}

async function openMinimaxAccountMenu(page, logger) {
  try {
    // 账户入口是左下角一个「MiniMax + 用户名」的元素，按位置找比按 class 稳
    const pos = await page.evaluate(() => {
      const h = window.innerHeight;
      for (const el of document.querySelectorAll('div,button,[role="button"]')) {
        const t = (el.textContent || '').trim();
        if (!/^(MiniMax|用户)\S{0,16}$/.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 18) continue;
        if (r.y < h * 0.8) continue; // 只认左下角
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t };
      }
      return null;
    });
    if (!pos) return false;
    await page.mouse.click(pos.x, pos.y);
    logger?.step?.(`展开账户菜单（${pos.text}）`);
    await sleep(1500);
    return true;
  } catch {
    return false;
  }
}

export async function runMinimax(page, logger, { dryRun = false } = {}) {
  logger?.step?.(`打开 ${MINIMAX_HOME}`);
  await page.goto(MINIMAX_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => null);
  await sleep(3000);

  // 登录判断只看登录弹窗特征（页面其它地方可能本来就有「登录」字样）
  let text = await pageVisibleText(page);
  if (/获取验证码|微信扫码登录|请输入您的手机号/.test(text)) {
    return { status: 'needs_login', detail: '登录已失效，点「登录」扫码重新进入一次' };
  }

  let hasPanel = false;
  for (let i = 0; i < 8; i++) {
    text = await pageVisibleText(page);
    if (text.includes('签到得')) {
      hasPanel = true;
      break;
    }
    if (MINIMAX_DONE_TEXTS.some((k) => text.includes(k))) break;
    await sleep(1500);
  }

  if (!hasPanel) {
    logger?.step?.('首页没出签到面板，转从账户菜单进');
    if (await openMinimaxAccountMenu(page, logger)) {
      await clickVisibleText(page, ['每日签到'], logger);
      await sleep(2500);
    }
    text = await pageVisibleText(page);

    const doneInDialog = MINIMAX_DONE_TEXTS.find((k) => text.includes(k));
    if (doneInDialog) return { status: 'already', detail: `面板显示「${doneInDialog}」，今天已完成` };
    if (!text.includes('签到得')) {
      return { status: 'not_found', detail: '没找到「每日签到」入口（界面可能改版了）' };
    }
  }

  if (dryRun) return { status: 'dry_run', detail: '已找到「每日签到」入口（未点击）' };

  // 签到按钮文案形如「签到得 400」
  let claimed = false;
  try {
    const btn = page.getByRole('button', { name: /^(签到|立即签到|签到得)/ }).first();
    if (await btn.isVisible({ timeout: 2000 })) {
      await btn.click({ timeout: 6000 });
      claimed = true;
      logger?.step?.('已按下「签到得 N」');
    }
  } catch {
    /* 退回文本匹配 */
  }
  if (!claimed) claimed = await clickVisibleText(page, ['签到得'], logger);

  await sleep(2500);
  text = await pageVisibleText(page);

  const success = ['签到成功', '领取成功'].find((k) => text.includes(k));
  const doneAfter = MINIMAX_DONE_TEXTS.find((k) => text.includes(k));
  const m = text.match(/\+(\d{2,5})\s*积分/);
  const points = m ? Number(m[1]) : null;

  if (success || doneAfter) {
    const ok = Boolean(success) || claimed;
    return {
      status: ok ? 'success' : 'already',
      detail: points ? `领取成功，+${points} 积分` : ok ? '领取成功（页面已显示今日已完成）' : `页面显示「${doneAfter}」`,
      meta: points ? { todayPoints: points } : undefined,
    };
  }
  if (!claimed) return { status: 'not_found', detail: '找到了入口但没找到可点击的领取按钮' };
  return { status: 'uncertain', detail: '已点击领取，但页面上没有出现明确的成功提示' };
}

/* ======================================================================
 * 桌面版平台：CDP 临时接管桌面客户端
 * ======================================================================
 * 适用对象：Electron / Chromium 壳客户端。界面本质是网页，开了调试端口就能：
 *   1. 在它的页面里执行 JS（直接调它自己的前端接口，带登录态）
 *   2. 或像普通网页一样找按钮点
 * 不适用：原生客户端、手机 App（没有进程可接）。
 *
 * 两个铁律：
 * - 启动客户端只能用环境变量或它认可的参数开调试端口，且必须剥掉
 *   ELECTRON_RUN_AS_NODE（否则 Electron 以纯 Node 模式启动、1 秒静默退出）；
 * - 客户端「正在运行但没开调试端口」时绝不强杀用户的窗口，返回 needs_manual。
 */

async function cdpVersion(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** 客户端是否存在：配置的显式路径和候选目录里找一个真实文件；都没有 → 未安装 */
export function clientInstalled(platform) {
  const exe = resolveClientExe(platform);
  return exe && fs.existsSync(exe) ? exe : '';
}

export async function runClientCheckin(platform, { logger, shotDir, dryRun = false } = {}) {
  const exe = clientInstalled(platform);
  if (!exe) {
    return {
      status: 'not_installed',
      detail: `本机没有找到 ${platform.name} 客户端，安装并登录后再启用这个平台。`,
    };
  }

  const port = platform.port;
  let launched = false;

  // 1) 端口已在监听 → 直接接管；否则按需拉起
  let version = await cdpVersion(port);
  if (!version) {
    const running = await isClientRunning(exe);
    if (running) {
      if (!platform.autoRestart) {
        return {
          status: 'needs_manual',
          detail: `${platform.name} 正在运行，但没有开启调试通道。请完全退出客户端（包括托盘图标）后再点一次「领取」`,
        };
      }
      logger?.info?.(`${platform.name} 正在运行但没开调试端口，重启一次把接管通道打开`);
      await quitClientGracefully(exe);
      await sleep(2000);
    }

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // 不删这个，客户端会以纯 Node 模式启动并秒退
    delete env.NODE_OPTIONS;
    const args = [];
    if (platform.cdpMode === 'env') {
      env[platform.cdpEnv || 'REMOTE_DEBUGGING_PORT'] = String(port);
    } else {
      args.push(`--remote-debugging-port=${port}`);
    }

    logger?.info?.(`启动 ${platform.name}（调试端口 ${port}）`);
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', env });
    // spawn 异步失败（权限/路径）只走下面的端口超时兜底，不能让整个服务崩掉
    child.on('error', () => {});
    child.unref();
    launched = true;

    const t0 = Date.now();
    while (Date.now() - t0 < platform.launchTimeoutMs) {
      version = await cdpVersion(port);
      if (version) break;
      await sleep(1200);
    }
    if (!version) {
      if (launched) await quitClientGracefully(exe);
      return { status: 'error', detail: `客户端已拉起，调试端口 ${port} 却没有响应（等了 ${Math.round(platform.launchTimeoutMs / 1000)}s）` };
    }
    logger?.info?.(`CDP 就绪: ${version.Browser}`);
  } else {
    logger?.step?.(`检测到调试端口 ${port} 已就绪，直接接管`);
  }

  // 2) 连进去（playwright 惰性加载：桌面版平台不依赖浏览器 profile，但依赖 CDP 客户端）
  const { chromium } = await loadPlaywright();
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20_000 });
  } catch (e) {
    if (launched) await quitClientGracefully(exe);
    return { status: 'error', detail: `连接客户端失败: ${firstLine(e?.message || e)}` };
  }

  let page;
  try {
    // 3) 选页面（必要时用客户端的登录态新开一个任务页）
    const pages = browser.contexts().flatMap((c) => c.pages());
    logger?.step?.(`发现 ${pages.length} 个页面`);

    if (platform.openUrl) {
      page = await browser.contexts()[0].newPage();
      await page.goto(platform.openUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // 任务/活动面板走异步渲染，多留点时间让它画完
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null);
      await sleep(2500);
    } else {
      page =
        (platform.pageUrlMatch && pages.find((p) => p.url().includes(platform.pageUrlMatch))) || pages[0];
      if (!page) return { status: 'error', detail: '没找到可操作的页面' };
    }

    // 3.5) 签到入口藏在账户菜单里的客户端：先点开菜单
    let menuAlreadyOpen = false;
    if (platform.menuOpenTexts.length) {
      const cur = await pageVisibleText(page);
      menuAlreadyOpen = platform.menuOpenTexts.some((t) => cur.includes(t));
      if (menuAlreadyOpen) logger?.step?.('前置菜单已打开，跳过点击');
    }
    if (platform.beforeClickSelectors.length && !menuAlreadyOpen) {
      for (const sel of platform.beforeClickSelectors) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 1500 })) {
            logger?.step?.(`打开前置菜单: ${sel}`);
            await loc.click({ timeout: 4000 });
            await sleep(1500);
            break;
          }
        } catch {
          /* 换下一个 */
        }
      }
    }

    // 4) 先确认今天没签过，能不点就不点
    let text = await pageVisibleText(page);
    const doneHit = platform.doneKeywords.find((k) => text.includes(k));
    if (doneHit) return { status: 'already', detail: `页面显示「${doneHit}」，今天已完成` };
    if (doneRuleHit(text, platform.doneRule)) {
      return { status: 'already', detail: '领取入口已消失，页面处于今日已完成状态' };
    }

    if (dryRun) {
      const cands = await findCandidateButtons(page, platform.keywords);
      let selHit = null;
      for (const sel of platform.clickSelectors) {
        try {
          if (await page.locator(sel).first().isVisible({ timeout: 800 })) {
            selHit = sel;
            break;
          }
        } catch {
          /* next */
        }
      }
      const hit = cands.length ? cands.map((c) => c.text).slice(0, 4).join(' / ') : selHit;
      return hit
        ? { status: 'dry_run', detail: `检测通过：登录有效，命中入口「${hit}」（未点击）` }
        : { status: 'not_found', detail: '检测：登录有效，但页面里没找到签到入口' };
    }

    // 5) 按选择器点击（入口是纯图标没有文字的客户端用这个）
    if (platform.clickSelectors.length) {
      for (const sel of platform.clickSelectors) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 1200 })) {
            logger?.step?.(`命中选择器 ${sel}，点击`);
            await loc.click({ timeout: 5000 });
            await sleep(1500);
            const t3 = await pageVisibleText(page, 4000);
            const o3 = readOutcome(t3);
            if (o3.already) return { status: 'already', detail: '点击后提示已完成' };
            if (o3.success) return { status: 'success', detail: '点击后出现成功提示' };
            if (o3.fail) return { status: 'failed', detail: '点击后出现失败提示' };
            return { status: 'uncertain', detail: `已点击入口按钮，未能确认结果` };
          }
        } catch {
          /* 换下一个 */
        }
      }
      logger?.step?.('选择器全部落空，退回按文案找');
    }

    // 6) 文案匹配点击（与网页端同一套逻辑）
    const login = await detectLoginWall(page, text);
    if (login.needLogin) return { status: 'needs_login', detail: login.reason };

    let res = await clickFirstCandidate(page, platform.keywords, logger, { label: platform.name });
    if (!res.clicked) {
      logger?.step?.('首次未找到入口，等 3 秒重试（异步内容可能晚到）');
      await sleep(3000);
      res = await clickFirstCandidate(page, platform.keywords, logger, { label: platform.name });
    }
    const out = res.outcome || {};
    if (out.already) return { status: 'already', detail: `点击后提示已完成（${res.text}）` };
    if (out.success) return { status: 'success', detail: `点击「${res.text}」后出现成功提示` };
    if (out.fail) return { status: 'failed', detail: `点击「${res.text}」后出现失败提示` };
    if (res.clicked) {
      await sleep(1800);
      const t2 = await pageVisibleText(page, 5000);
      const o2 = readOutcome(t2);
      const doneHit2 = platform.doneKeywords.find((k) => t2.includes(k));
      const stillThere = (await findCandidateButtons(page, platform.keywords)).length > 0;
      const ruleDone = doneRuleHit(t2, platform.doneRule);

      // 最可信的判定：点完之后入口消失，且页面出现「已领取/已签到」类文案
      if (!stillThere && (doneHit2 || ruleDone)) {
        return { status: 'success', detail: `点击「${res.text}」后入口消失，页面${doneHit2 ? `显示「${doneHit2}」` : '已是完成状态'}` };
      }
      if (o2.success || o2.already) return { status: 'success', detail: `点击后页面提示${o2.success ? '成功' : '已完成'}` };
      if (stillThere) return { status: 'uncertain', detail: `已点击「${res.text}」但入口仍在，可能点到了遮挡层` };
      return { status: 'uncertain', detail: `已点击「${res.text}」，入口已消失但未能确认结果` };
    }
    return { status: 'not_found', detail: `页面上没有命中关键词的按钮：${platform.keywords.join('/')}` };
  } catch (e) {
    return { status: 'error', detail: firstLine(e?.message || e) };
  } finally {
    if (page && shotDir) await snapshot(page, shotDir, platform.id).catch(() => null);
    try {
      browser.close?.();
    } catch {
      /* ignore */
    }
    // 只断开 CDP；客户端是我们拉起来的才收尾，用户自己开着的绝不动
    if (launched && !platform.keepRunning) await quitClientGracefully(exe);
  }
}
