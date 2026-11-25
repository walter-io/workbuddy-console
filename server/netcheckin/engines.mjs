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
import { spawn } from 'node:child_process';
import { loadPlaywright } from './browser.mjs';
import { sigCheck } from './loginsig.mjs';
import {
  pageVisibleText,
  pageVisibleTextDeep,
  elementCoverage,
  unblockElement,
  detectLoginWall,
  findCandidateButtons,
  findCandidateButtonsDeep,
  clickFirstCandidate,
  readOutcome,
  openAndWait,
  closeOverlays,
  snapshot,
  dumpHtml,
  listVisibleButtons,
} from './dom.mjs';
import { clientProbe, isClientRunning, quitClientGracefully } from './registry.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (s) => String(s ?? '').split('\n')[0];

/**
 * 客户端可能自己关掉/替换签到页（豆包实测：openUrl 新页后主框架连跳 3 次，
 * 活动页也常被用户或客户端自己关掉）。这里始终拿一个还活着的页面：
 * 原页没关就原样用；关了就先找同地址的同伴页，找不到再用 openUrl 新开一次。
 */
async function livePage(browser, page, platform) {
  if (page && !page.isClosed()) return page;
  const allPages = () => browser.contexts().flatMap((c) => c.pages());
  const key = platform.openUrl ? String(platform.openUrl).split('?')[0] : '';
  const isOurs = (p) => {
    try {
      const u = p.url();
      return Boolean((key && u.includes(key)) || (platform.pageUrlMatch && u.includes(platform.pageUrlMatch)));
    } catch {
      return false;
    }
  };
  const found = allPages().find((p) => !p.isClosed() && isOurs(p));
  if (found) return found;
  if (platform.openUrl) {
    try {
      const np = await browser.contexts()[0].newPage();
      await np.goto(platform.openUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      np.__checkinOpenedByUs = true; // 我们开的标签页，收尾时必须关掉
      return np;
    } catch {
      return null;
    }
  }
  return null;
}

/** 页面被客户端关掉/替换时，换一个活页面再试一次（最多 2 次重试，仍失败抛原错） */
const CLIENT_PAGE_DEAD = /Target page, context or browser has been closed|Execution context was destroyed|Target closed|frame was detached/i;
async function safeRead(fn, getPage) {
  let lastErr;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await fn(await getPage());
    } catch (e) {
      if (!CLIENT_PAGE_DEAD.test(String(e?.message || e))) throw e;
      lastErr = e;
      if (attempt === 2) break;
      await sleep(1500);
    }
  }
  throw lastErr;
}

/** 把 Chromium 的网络错误码翻译成人话（原始报错附在后面备查）：
 *  实测最常撞上的是 ERR_TIMED_OUT——Cloudflare 站点偶发慢，重试通常就能过 */
const NET_ERROR_HINTS = [
  ['ERR_TIMED_OUT', '网络超时（站点响应慢或连接被拦，稍后重试通常能好）'],
  ['ERR_CONNECTION_RESET', '连接被重置（站点可能被墙或风控掐断）'],
  ['ERR_CONNECTION_CLOSED', '连接被关闭（代理节点不通或被墙；可试强制直连/稍后重试）'],
  ['ERR_CONNECTION_REFUSED', '连接被拒绝（站点可能下线）'],
  ['ERR_NAME_NOT_RESOLVED', '域名解析失败（网络不通或站点下线）'],
  ['ERR_PROXY_CONNECTION_FAILED', '代理连不上'],
  ['ERR_HTTP2_PROTOCOL_ERROR', 'HTTP/2 协议错误（站点或中间链路异常）'],
  ['ERR_ABORTED', '加载被中断'],
];
const humanizeNetError = (e) => {
  const raw = firstLine(e?.message || e);
  const hit = NET_ERROR_HINTS.find(([code]) => raw.includes(code));
  return hit ? `${hit[1]}（${raw.slice(0, 80)}）` : raw;
};

/** 按平台配置的余额正则从页面文本里抓积分余额（抓不到返回 null，绝不误报） */
const captureCredits = (platform, text) => {
  const pat = platform.creditsPattern;
  if (!pat) return null;
  try {
    const m = new RegExp(pat).exec(text || '');
    if (!m || !m[1]) return null;
    const n = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

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

/** 百度 Comate 检测：领取入口可能在 IDE 插件里，网页试运行只验证百度登录态 */
export async function comateProbeRun(page, ctx, logger) {
  await openAndWait(page, 'https://comate.baidu.com/', logger, { settle: 1500 });
  const cookies = await ctx.cookies('https://comate.baidu.com').catch(() => []);
  const ok = cookies.some((c) => (c.name === 'BDUSS' || c.name === 'BDUSS_BFESS') && c.value);
  return ok
    ? { status: 'dry_run', detail: '检测通过：百度登录态有效（领取入口可能在 IDE 插件里）' }
    : { status: 'needs_login', detail: '未检测到百度登录态，点「登录」重新授权一次' };
}

/* ======================================================================
 * 通用网页流程：打开入口 → 识别登录墙 → 找按钮 → 真实点击
 * ======================================================================
 * 大多数平台的签到就是一个带文案的按钮，这套通用流程 + 可配置关键词就能覆盖；
 * 平台改版后把新文案补进 config 的 keywords 即可，不用改代码。
 */

export async function runGenericWeb(platform, page, logger, ctx) {
  const urls = platform.entryUrls.length ? platform.entryUrls : [platform.homepage];
  const lastReason = [];
  // 登录凭据签名优先（登录窗口自动学的会话 cookie 名单）：全在=已登录，页面文案
  // 判定整个跳过（SPA 慢渲染/悬停菜单/图标按钮都骗不了它）；全缺=失效直接报重登；
  // 部分缺失或没有签名 → 走旧的文案逻辑（不武断，零行为回归）
  const sig = ctx ? await sigCheck(platform, ctx).catch(() => 'none') : 'none';
  if (sig === 'invalid') {
    logger?.warn?.('登录凭据签名已全部消失 → 需要重新登录');
    return { status: 'needs_login', detail: '登录凭据已失效（登录 cookie 不在了），点「重新登录」授权一次', url: platform.loginUrl || platform.homepage };
  }
  for (const url of urls) {
    let text = '';
    try {
      await openAndWait(page, url, logger);
    } catch (e) {
      // 站点偶发超时很常见（Cloudflare 慢、风控抖动），先原地对同一入口重试一次再换下一个
      const why = humanizeNetError(e);
      logger?.warn?.(`${url} 打开失败: ${why}，重试一次…`);
      await sleep(3000);
      try {
        await openAndWait(page, url, logger);
      } catch (e2) {
        lastReason.push(`${url} 打开失败: ${humanizeNetError(e2)}`);
        logger?.warn?.(lastReason[lastReason.length - 1]);
        continue;
      }
    }
    try {
      await closeOverlays(page, logger);
      text = await pageVisibleText(page);
    } catch (e) {
      lastReason.push(`${url} 打开失败: ${firstLine(e?.message || e)}`);
      logger?.warn?.(lastReason[lastReason.length - 1]);
      continue;
    }

    // 登录墙检查：签名有效时跳过（站点登录后仍可能带着「登录」字样的活动位，别误报）
    if (sig !== 'valid') {
      const login = await detectLoginWall(page, text);
      if (login.needLogin) {
        logger?.warn?.(`${login.reason} → 需要重新登录`);
        return { status: 'needs_login', detail: login.reason, url: page.url() };
      }
    }

    // 签到入口藏在顶栏按钮/菜单里的平台（哩布哩布的算力面板等）：
    // 先点开前置入口，再在展开的面板里找领取按钮
    if (platform.beforeClickSelectors?.length) {
      for (const sel of platform.beforeClickSelectors) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 1500 })) {
            logger?.step?.(`打开前置入口: ${sel}`);
            await loc.click({ timeout: 4000 });
            await sleep(1500 + Math.random() * 800);
            break;
          }
        } catch {
          /* 换下一个选择器 */
        }
      }
      text = await pageVisibleText(page);
    }

    // 登录即到账的平台（Vidu 等）：积分随访问自动发放，没有「签到按钮」可点——
    // 确认页面已进入登录后的状态就算领取完成；被人机验证拦住则如实报告
    if (platform.visitClaim) {
      if (/验证您是真人|请按住滑块|拖动到最右|人机验证|安全验证/.test(text)) {
        return { status: 'uncertain', detail: '被人机验证拦截，稍后自动重试', url: page.url() };
      }
      // 签名有效 = 已登录：登录即送平台到此就算到账（每日积分随登录自动发放）
      if (sig === 'valid') {
        return { status: 'success', detail: '已到账（登录凭据有效，登录即送）', url: page.url(), meta: { credits: captureCredits(platform, text) } };
      }
      if (!platform.requireLoginSig && /(^|\n)\s*(登录 \/ 注册|登录\/注册|登录|注册)\s*(\n|$)/.test(text)) {
        return { status: 'needs_login', detail: '登录入口仍在，点「重新登录」授权一次', url: page.url() };
      }
      if (!platform.requireLoginSig && platform.loginProbePath && page.url().includes(platform.loginProbePath)) {
        return { status: 'success', detail: '已到账（登录即送，打开页面即发放）', url: page.url() };
      }
      // 页面出现平台专属的登录后字样（如吐司页头的「算力」余额）= 已登录且已到账
      const okHit = (platform.loginOkTexts || []).find((k) => k && text.includes(k));
      if (okHit) {
        return { status: 'success', detail: `已到账（页面出现「${okHit}」，登录即送，无独立签到按钮）`, url: page.url(), meta: { credits: captureCredits(platform, text) } };
      }
      // 兜底正证：登录后的页面不会再有任何「登录/注册」入口文字（吐司实测——
      // 登录态在 localStorage，cookie 判定不适用；已登录页全文找不到「登录」二字，
      // 未登录的页面必然挂着登录入口）。走到这里说明登录墙检测已经通过。
      if (!platform.requireLoginSig && !/(登录|注册)/.test(text)) {
        return { status: 'success', detail: '已到账（页面上没有「登录/注册」入口，视为已登录；登录即送到账）', url: page.url(), meta: { credits: captureCredits(platform, text) } };
      }
      if (platform.requireLoginSig) {
        return { status: 'needs_login', detail: '还没在工具里登录过（或登录已失效）——点「登录」授权一次', url: page.url() };
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

/** 通用流程的检测模式：只查登录态 + 列出能看到哪些候选按钮，不点击（前置入口会点开，但不点领取） */
export async function dryRunWeb(platform, page, logger, ctx) {
  const url = platform.entryUrls[0] || platform.homepage;
  await openAndWait(page, url, logger);
  await closeOverlays(page, logger);
  // 签名优先：全在=已登录（跳过文案判定），全缺=失效直接报重登；部分缺失/无签名走旧逻辑
  const sig = ctx ? await sigCheck(platform, ctx).catch(() => 'none') : 'none';
  if (sig === 'invalid') {
    return { status: 'needs_login', detail: '检测：登录凭据已失效（登录 cookie 不在了），点「重新登录」授权一次', url: page.url(), candidates: [] };
  }
  let text = await pageVisibleText(page);
  if (sig !== 'valid') {
    const login = await detectLoginWall(page, text);
    if (login.needLogin) return { status: 'needs_login', detail: login.reason, url: page.url(), candidates: [] };
  }

  // 检测也要先点开前置入口（哩布哩布的算力面板等），否则永远看不到里面的领取按钮
  if (platform.beforeClickSelectors?.length) {
    for (const sel of platform.beforeClickSelectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 1500 })) {
          logger?.step?.(`打开前置入口: ${sel}`);
          await loc.click({ timeout: 4000 });
          await sleep(1500 + Math.random() * 800);
          break;
        }
      } catch {
        /* 换下一个选择器 */
      }
    }
    text = await pageVisibleText(page);
  }

  const cands = await findCandidateButtons(page, platform.keywords);
  const allButtons = await listVisibleButtons(page);
  // 登录即到账的平台：检测语义与正式运行一致（被人机验证拦截/登录入口仍在/已登录）
  if (platform.visitClaim) {
    if (/验证您是真人|请按住滑块|拖动到最右|人机验证|安全验证/.test(text)) {
      return { status: 'uncertain', detail: '被人机验证拦截，稍后自动重试', url: page.url(), candidates: [], buttons: allButtons };
    }
    // 签名有效 = 已登录：登录即送平台到此即算到账
    if (sig === 'valid') {
      return { status: 'dry_run', detail: '检测通过：登录凭据有效（登录即送平台，访问即到账）', url: page.url(), candidates: [], buttons: allButtons, meta: { credits: captureCredits(platform, text) } };
    }
    if (!platform.requireLoginSig && /(^|\n)\s*(登录 \/ 注册|登录\/注册|登录|注册)\s*(\n|$)/.test(text)) {
      return { status: 'needs_login', detail: '登录入口仍在（点「登录」授权一次）', url: page.url(), candidates: [], buttons: allButtons };
    }
    // 探测路径命中（登录后仍停留的页面地址）= 已登录的正证
    if (!platform.requireLoginSig && platform.loginProbePath && page.url().includes(platform.loginProbePath)) {
      return { status: 'dry_run', detail: '检测通过：已登录（登录即送平台，访问即到账）', url: page.url(), candidates: [], buttons: allButtons, meta: { credits: captureCredits(platform, text) } };
    }
    // 页面出现平台专属的登录后字样（如吐司页头的「算力」余额）= 已登录
    const okHit = (platform.loginOkTexts || []).find((k) => k && text.includes(k));
    if (okHit) {
      return { status: 'dry_run', detail: `检测通过：页面出现「${okHit}」，已登录且已到账`, url: page.url(), candidates: [], buttons: allButtons, meta: { credits: captureCredits(platform, text) } };
    }
    // 兜底正证：全文没有「登录/注册」字样 = 登录入口已消失 = 已登录（同正式运行的判定）
    if (!platform.requireLoginSig && !/(登录|注册)/.test(text)) {
      return { status: 'dry_run', detail: '检测通过：页面上没有「登录/注册」入口，视为已登录', url: page.url(), candidates: [], buttons: allButtons, meta: { credits: captureCredits(platform, text) } };
    }
    if (platform.requireLoginSig) {
      return { status: 'needs_login', detail: '还没在工具里登录过（或登录已失效）——点「登录」授权一次', url: page.url(), candidates: [], buttons: allButtons };
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

/** 按钮有稳定的 class 与 aria-label，别再靠 getByRole 的模糊正则去猜 */
const MINIMAX_CLAIM_SELECTOR = 'button.signin-claim-button, button[aria-label^="签到得"]';

export async function runMinimax(page, logger, { dryRun = false } = {}) {
  logger?.step?.(`打开 ${MINIMAX_HOME}`);
  await page.goto(MINIMAX_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => null);
  await sleep(3000);

  // 登录判断只看登录弹窗特征（页面其它地方可能本来就有「登录」字样）
  let text = await pageVisibleTextDeep(page);
  if (/获取验证码|微信扫码登录|请输入您的手机号/.test(text)) {
    return { status: 'needs_login', detail: '登录已失效，点「登录」扫码重新进入一次' };
  }

  let hasPanel = false;
  for (let i = 0; i < 8; i++) {
    text = await pageVisibleTextDeep(page);
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
    } else {
      const loginBtn = await page.locator('button:has-text("登录")').first().isVisible({ timeout: 1500 }).catch(() => false);
      if (loginBtn) return { status: 'needs_login', detail: '还没在工具里登录过 MiniMax（或登录已失效）——点「登录」扫码登录一次' };
    }
    text = await pageVisibleTextDeep(page);

    const doneInDialog = MINIMAX_DONE_TEXTS.find((k) => text.includes(k));
    if (doneInDialog) return { status: 'already', detail: `面板显示「${doneInDialog}」，今天已完成` };
    if (!text.includes('签到得')) {
      return { status: 'not_found', detail: '没找到「每日签到」入口（界面可能改版了）' };
    }
  }

  // 文案先出现、按钮晚挂载是常态；按真实元素等，而不是靠固定 sleep
  let cov = await elementCoverage(page, MINIMAX_CLAIM_SELECTOR);
  for (let i = 0; i < 8 && !cov.exists; i++) {
    await sleep(1000);
    cov = await elementCoverage(page, MINIMAX_CLAIM_SELECTOR);
  }
  if (!cov.exists) {
    text = await pageVisibleTextDeep(page);
    const done = MINIMAX_DONE_TEXTS.find((k) => text.includes(k));
    if (done) return { status: 'already', detail: `面板显示「${done}」，今天已完成` };
    return {
      status: 'not_found',
      detail: '签到面板在，但页面没有「签到得 N」按钮（可能今天已领或界面改版）',
      meta: { pageText: text.slice(-180) },
    };
  }

  if (dryRun) {
    return { status: 'dry_run', detail: `已找到「每日签到」入口（按钮「${cov.label || '签到得'}」，未点击）` };
  }

  // 2026-11-12 实测：MiniMax 会弹「H3 Image 首发上线」全屏引导层（z-index 9999），
  // 签到按钮看得到、isVisible() 也为真，但 elementFromPoint 落在弹层上，
  // locator.click() 一直等到超时 → 旧版报「找到了入口但没找到可点击的领取按钮」。
  let unblock = null;
  if (cov.covered) {
    const hint = cov.hit?.aria || cov.hit?.text?.slice(0, 30) || cov.hit?.cls?.slice(0, 30) || '未知弹层';
    logger?.step?.(`签到按钮被「${hint}」遮挡，先清弹层`);
    unblock = await unblockElement(page, MINIMAX_CLAIM_SELECTOR, logger);
    cov = unblock.coverage;
  }

  let claimed = false;
  let clickErr = '';
  try {
    const btn = page.locator(MINIMAX_CLAIM_SELECTOR).first();
    await btn.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => null);
    await btn.click({ trial: true, timeout: 3500 }); // 先确认真的点得到
    await btn.click({ timeout: 6000 });
    claimed = true;
  } catch (e) {
    clickErr = firstLine(e?.message || e).slice(0, 150);
  }
  if (!claimed) claimed = await clickVisibleText(page, ['签到得'], logger);
  if (!claimed && cov.rect && !cov.covered) {
    try {
      await page.mouse.click(cov.rect.cx, cov.rect.cy);
      claimed = true;
      logger?.step?.('按坐标点击「签到得」');
    } catch (e) {
      clickErr += `；坐标点击也失败：${firstLine(e?.message || e).slice(0, 90)}`;
    }
  }
  if (claimed) logger?.step?.('已按下「签到得 N」');

  // 结果判定：toast 会消失，按钮变「今日已签到」才是持久证据。
  // 两条线一起看，避免弹窗/iframe 里的提示读不到就误判成失败。
  let success = '';
  let doneAfter = '';
  let points = null;
  let post = { exists: false, label: '' };
  let buttonChanged = false;
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    text = await pageVisibleTextDeep(page);
    success = ['签到成功', '领取成功', '已到账', '签到完成'].find((k) => text.includes(k)) || '';
    doneAfter = MINIMAX_DONE_TEXTS.find((k) => text.includes(k)) || '';
    const m = text.match(/[+＋]\s*(\d{2,5})\s*积分/) || text.match(/(?:获得|到账)\s*(\d{2,5})\s*积分/);
    points = m ? Number(m[1]) : points;
    post = await elementCoverage(page, MINIMAX_CLAIM_SELECTOR);
    buttonChanged = !post.exists || !/签到得|立即签到/.test(post.label || '');
    if (success || doneAfter || (claimed && buttonChanged)) break;
  }
  const outcome = readOutcome(text);
  const confirmed = Boolean(success || doneAfter || (claimed && buttonChanged) || outcome.already);

  if (confirmed) {
    const status = claimed ? 'success' : 'already';
    const detail = points
      ? `领取成功，+${points} 积分`
      : success
        ? success
        : doneAfter
          ? `页面显示「${doneAfter}」，今天已完成`
          : claimed
            ? '领取成功（签到按钮已变为完成态）'
            : '页面显示今日已完成';
    return { status, detail, meta: points ? { todayPoints: points } : undefined };
  }

  if (!claimed) {
    const reason = unblock?.covered
      ? `「签到得」按钮被${unblock.blocker ? `「${unblock.blocker}」` : '运营弹窗'}挡住，尝试${unblock.attempts.join('、') || '关闭'}后仍点不到（可手动打开一次网页关掉公告再重试）`
      : `按钮「${cov.label || '签到得'}」就在页面上，但点击失败${clickErr ? `（${clickErr}）` : ''}`;
    logger?.warn?.(reason);
    return { status: 'not_found', detail: reason, meta: { blocked: !!unblock?.covered } };
  }

  return {
    status: 'uncertain',
    detail: `已点击「签到得」，但没看到明确成功提示；页面片段：${text.slice(-120)}`,
  };
}

/* ======================================================================
 * 魔搭社区 / 百度搭子：登录态在页面里直接调官方接口，不靠按钮文案
 * ======================================================================
 * 魔搭的每日登录魔粒是「打开网站自动发放」，没有领取按钮；百度搭子的登录
 * 奖励是纯接口（查状态 → POST 领取 → 复查）。两者都在页面内 fetch，带
 * credentials:'include'，用已登录的内置浏览器会话；Cookie/token 只留在浏览器里，
 * 日志最多写「读到余额 X」。
 */

const MS_HOME = 'https://www.modelscope.cn/';
const MS_EARN_PAGE = 'https://www.modelscope.cn/magicube/usage?tab=earn';

/** 在页面里读魔搭的魔粒任务表与余额（只回传状态码和 JSON，Cookie 不出浏览器） */
async function readModelscopeSnapshot(page) {
  return page.evaluate(async () => {
    const get = async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
        let json = null;
        try { json = await r.json(); } catch { /* 非 JSON 当成读不懂 */ }
        return { status: r.status, json };
      } catch {
        return { status: -1, json: null };
      }
    };
    const [rules, balance] = await Promise.all([
      get('/openapi/v1/magicubes/earn/rules'),
      get('/openapi/v1/magicubes/balance'),
    ]);
    return { rules, balance };
  });
}

function msNotLoggedIn(resp) {
  if (!resp) return false;
  if (resp.status === 401 || resp.status === 403) return true;
  const j = resp.json;
  if (!j || typeof j !== 'object') return false;
  const code = String(j.code ?? j.Code ?? '');
  const msg = String(j.message ?? j.Message ?? '');
  return /InvalidAuthentication|not.?logged|未登录|10010101003/i.test(code + ' ' + msg);
}

function msBalanceOf(json) {
  const d = json && (json.data !== undefined ? json.data : json.Data);
  if (!d || typeof d !== 'object') return null;
  const a = d.available_balance !== undefined ? d.available_balance : d.total_balance;
  if (a === undefined || a === null || a === '') return null;
  const n = Number(a);
  return Number.isFinite(n) ? n : null;
}

function msRuleListOf(json) {
  if (!json || typeof json !== 'object') return null;
  let d = json.data !== undefined ? json.data : (json.Data !== undefined ? json.Data : json);
  if (d && !Array.isArray(d) && typeof d === 'object') d = d.rules || d.list || d.items || null;
  if (!Array.isArray(d)) return null;
  return d.filter((x) => x && typeof x === 'object');
}

/** 从任务表算今日登录奖励：received=是否已到账，total=含绑阿里云的总数，extra=绑阿里云附加 */
function msRewardOf(list) {
  const da = list.find((x) => x.rule_key === 'daily_active');
  const bind = list.find((x) => x.rule_key === 'aliyun_bindlogin');
  const received = Boolean(da && (Number(da.today_used) >= 1 || Number(da.today_earned_amount) > 0));
  const extra = bind && Number(bind.today_earned_amount) > 0 ? Number(bind.today_earned_amount) : 0;
  const raw = da ? Number(da.today_earned_amount || da.amount || 200) : 200;
  const base = Number.isFinite(raw) && raw > 0 ? raw : 200;
  return { received, total: base + extra, extra };
}

export async function runModelscope(page, logger, { dryRun = false } = {}) {
  logger?.step?.(`打开 ${MS_HOME}`);
  await page.goto(MS_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => null);
  await sleep(3000);

  const first = await readModelscopeSnapshot(page).catch(() => null);
  if (msNotLoggedIn(first?.rules) || msNotLoggedIn(first?.balance)) {
    return { status: 'needs_login', detail: '魔搭登录已失效，点「登录」重新登录一次' };
  }
  const firstList = msRuleListOf(first?.rules?.json);
  if (!firstList) {
    return { status: 'not_found', detail: '读不懂魔搭魔粒接口返回（格式可能改了）' };
  }
  const credits = msBalanceOf(first?.balance?.json);
  const firstReward = msRewardOf(firstList);
  logger?.info?.(`魔搭读到余额 ${credits ?? '未知'}，今日${firstReward.received ? '已' : '未'}到账`);

  if (firstReward.received) {
    return { status: 'already', detail: `今日登录魔粒已到账 ${firstReward.total}`, meta: { credits } };
  }
  if (dryRun) {
    return { status: 'dry_run', detail: '已登录，今日魔粒尚未到账', meta: { credits } };
  }

  // 魔搭没有领取按钮：带登录态打开「赚魔粒」页让站点自动发放，等 5 秒再复查
  logger?.step?.(`打开 ${MS_EARN_PAGE}`);
  await page.goto(MS_EARN_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => null);
  await sleep(5000);

  const second = await readModelscopeSnapshot(page).catch(() => null);
  if (msNotLoggedIn(second?.rules) || msNotLoggedIn(second?.balance)) {
    return { status: 'needs_login', detail: '魔搭登录已失效，点「登录」重新登录一次' };
  }
  const secondList = msRuleListOf(second?.rules?.json);
  if (!secondList) {
    return { status: 'not_found', detail: '读不懂魔搭魔粒接口返回（格式可能改了）' };
  }
  const credits2 = msBalanceOf(second?.balance?.json);
  const reward2 = msRewardOf(secondList);
  logger?.info?.(`魔搭复查余额 ${credits2 ?? '未知'}，今日${reward2.received ? '已' : '未'}到账`);
  if (reward2.received) {
    const extra = reward2.extra > 0 ? `（含绑阿里云 +${reward2.extra}）` : '';
    return { status: 'success', detail: `今日登录魔粒已到账 ${reward2.total}${extra}`, meta: { credits: credits2 } };
  }
  return { status: 'uncertain', detail: '已打开魔搭，魔粒暂未显示到账（官方发放可能有延迟），稍后点「检测」再看', meta: { credits: credits2 } };
}

const DU_HOME = 'https://console.bce.baidu.com/';
const DU_INFO = '/api/dumate/points/loginBonusInfo';
const DU_BONUS = '/api/dumate/points/loginBonus';

/** 页面内调百度搭子接口；csrftoken 从 bce-user-info Cookie 取值（Node 侧读好传进来） */
async function dumateCall(page, path, method, csrf) {
  return page.evaluate(async ({ path, method, csrf }) => {
    const headers = { Accept: 'application/json' };
    if (csrf) headers.csrftoken = csrf;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    try {
      const r = await fetch(path, { method, credentials: 'include', headers, body: method === 'POST' ? '' : undefined });
      let json = null;
      try { json = await r.json(); } catch { /* 非 JSON 忽略 */ }
      return { status: r.status, json, url: r.url || location.href };
    } catch {
      return { status: -1, json: null, url: '' };
    }
  }, { path, method, csrf });
}

function duNotLoggedIn(resp) {
  if (!resp) return false;
  if (resp.status === 401 || resp.status === 403) return true;
  if (resp.url && /passport\.baidu\.com|[?&/=]login(?:[?&#/]|$)/i.test(resp.url)) return true;
  const j = resp.json;
  if (!j || typeof j !== 'object') return false;
  const code = String(j.code ?? j.errorCode ?? j.errno ?? '');
  const msg = String(j.message ?? j.msg ?? '');
  return /not.?login|not.?logged|未登录|登录已失效|session.?expired/i.test(code + ' ' + msg);
}

/** result/data/根三层都看一遍，兼容字段位置变动 */
function duPayload(json) {
  const j = json && typeof json === 'object' ? json : {};
  if (j.result && typeof j.result === 'object') return j.result;
  if (j.data && typeof j.data === 'object') return j.data;
  return j;
}

function duPoints(json) {
  const v = duPayload(json).totalPoints;
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function duHasIssued(json) {
  return duPayload(json).hasIssued === true;
}

function duMessage(json) {
  const j = json && typeof json === 'object' ? json : {};
  return String(j.message ?? j.msg ?? duPayload(j).message ?? duPayload(j).msg ?? '');
}

export async function runDumate(page, logger, { dryRun = false } = {}) {
  logger?.step?.(`打开 ${DU_HOME}`);
  await page.goto(DU_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => null);
  await sleep(1500);

  const cookies = await page.context().cookies(DU_HOME).catch(() => []);
  const info0 = cookies.find((c) => c && c.name === 'bce-user-info');
  const csrf = info0 ? String(info0.value || '').replace(/^['"]|['"]$/g, '') : '';
  if (!csrf || new URL(page.url()).hostname !== 'console.bce.baidu.com') {
    return { status: 'needs_login', detail: '百度搭子还没登录（或登录已失效），点「登录」用百度账号登录一次' };
  }

  const info = await dumateCall(page, DU_INFO, 'GET', csrf).catch(() => null);
  if (duNotLoggedIn(info)) {
    return { status: 'needs_login', detail: '百度搭子登录已失效，点「登录」重新登录一次' };
  }
  if (!info || info.status !== 200 || !info.json || info.json.success !== true) {
    return { status: 'uncertain', detail: `百度搭子状态接口异常${info?.status ? `（HTTP ${info.status}）` : ''}${duMessage(info?.json) ? `：${duMessage(info?.json)}` : ''}` };
  }
  const credits = duPoints(info.json);
  logger?.info?.(`百度搭子读到积分 ${credits ?? '未知'}`);
  if (duHasIssued(info.json)) {
    return { status: 'already', detail: '今日奖励已领取', meta: { credits } };
  }
  if (dryRun) {
    return { status: 'dry_run', detail: '已登录，今日奖励尚未领取', meta: { credits } };
  }

  const claim = await dumateCall(page, DU_BONUS, 'POST', csrf).catch(() => null);
  if (duNotLoggedIn(claim)) {
    return { status: 'needs_login', detail: '百度搭子登录已失效，点「登录」重新登录一次' };
  }
  const recheck = await dumateCall(page, DU_INFO, 'GET', csrf).catch(() => null);
  if (duNotLoggedIn(recheck)) {
    return { status: 'needs_login', detail: '百度搭子登录已失效，点「登录」重新登录一次' };
  }
  const afterCredits = recheck?.json?.success === true ? duPoints(recheck.json) : null;
  if (recheck?.json?.success === true && duHasIssued(recheck.json)) {
    const got = claim?.json?.result;
    const gotText = typeof got === 'number' ? `+${got} 积分，` : '';
    return { status: 'success', detail: `领取成功，${gotText}当前积分 ${afterCredits ?? credits ?? 0}`, meta: { credits: afterCredits ?? credits } };
  }
  const msg = duMessage(claim?.json) || duMessage(recheck?.json);
  return { status: 'uncertain', detail: `已请求领取，但未能确认到账${msg ? `（接口提示：${msg}）` : ''}`, meta: { credits: afterCredits ?? credits } };
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
 * - 客户端「正在运行但没开调试端口」时绝不强杀用户正在用的窗口：
 *   autoRestart 的平台先温和退出再带端口重启，否则返回 needs_manual。
 *
 * 收尾规则（2026-11-18 定版）：签到结束后按「谁开的谁关」——
 * - 因签到拉起的客户端要关掉（是我们开的，不关就一直挂在后台）；
 * - 用户本来就开着的绝不动（哪怕为了开调试端口重启过一次，签完也让它开着）。
 */

async function cdpVersion(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** 客户端是否存在：走统一的多策略探测；只有引导壳不算（CDP 接管不了） */
export function clientInstalled(platform) {
  const probe = clientProbe(platform);
  return probe.exe && !probe.launcherOnly ? probe.exe : '';
}

export async function runClientCheckin(platform, { logger, shotDir, dryRun = false } = {}) {
  const probe = clientProbe(platform);
  const exe = probe.exe && !probe.launcherOnly ? probe.exe : '';
  if (!exe) {
    const places = [...new Set(probe.tried.map((t) => t.path).filter(Boolean))].slice(0, 3).join('、');
    return {
      status: 'not_installed',
      detail: `没有找到 ${platform.name} 的主程序${probe.launcherOnly ? '（只发现启动器/引导壳，不能用于接管）' : ''}${places ? `；已排查 ${places} 等 ${probe.tried.length} 个位置` : ''}。若装在非默认目录，请在 ~/.free-token/checkin/config.json 的 platforms.${platform.id}.app 填入 exe 完整路径。`,
    };
  }
  logger?.info?.(`${platform.name} 客户端：${exe}（来源 ${probe.source}）`);

  const port = platform.port;
  let launched = false;
  /** 客户端在我们动手之前是否已经在运行（用户自己开着的）：决定签到结束后要不要关 */
  let wasRunningOriginally = false;

  // 1) 端口已在监听 → 直接接管；否则按需拉起
  let version = await cdpVersion(port);
  if (!version) {
    const running = await isClientRunning(exe);
    if (running) {
      wasRunningOriginally = true;
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
    // 冷启动竞态（豆包 2026-11-21 实测必现）：温和退出后旧进程树收尾要几秒，
    // 新进程被单实例锁转发给正在退出的旧实例后秒退，端口永远等不到。
    // 首轮超时且进程已不在时补拉一次；进程还在（端口真没开）就不白等第二轮。
    for (let attempt = 1; attempt <= 2 && !version; attempt++) {
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
      if (version) break;
      if (await isClientRunning(exe)) break;
      logger?.warn?.(`第 ${attempt} 次拉起后调试端口未就绪且进程已退出，补拉一次`);
    }
    if (!version) {
      // 原本就在运行的客户端拉起失败也不关：签完保持「开着」的状态，交给用户自己处理
      if (launched && !wasRunningOriginally) await quitClientGracefully(exe);
      return { status: 'error', detail: `客户端已拉起，调试端口 ${port} 却没有响应（等了 ${Math.round(platform.launchTimeoutMs / 1000)}s）` };
    }
    logger?.info?.(`CDP 就绪: ${version.Browser}`);
  } else {
    wasRunningOriginally = true; // 端口已在监听 = 客户端本来就在跑
    logger?.step?.(`检测到调试端口 ${port} 已就绪，直接接管`);
  }

  // 2) 连进去（playwright 惰性加载：桌面版平台不依赖浏览器 profile，但依赖 CDP 客户端）
  const { chromium } = await loadPlaywright();
  let browser;
  // Playwright 自带的 HTTP 栈会认 HTTP_PROXY/HTTPS_PROXY 环境变量，把发往本机 127.0.0.1 的
  // CDP 请求也塞进系统代理（实测 sing-box 2080：Host 与代理 authority 不一致直接拒连；Node
  // 原生 fetch 不认这些变量，所以上面的 cdpVersion 照常通）。连接窗口内临时剥掉代理变量。
  const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
  const savedProxyEnv = {};
  for (const k of PROXY_ENV_KEYS) {
    savedProxyEnv[k] = process.env[k];
    delete process.env[k];
  }
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20_000 });
  } catch (e) {
    if (launched && !wasRunningOriginally) await quitClientGracefully(exe);
    return { status: 'error', detail: `连接客户端失败: ${firstLine(e?.message || e)}` };
  } finally {
    for (const k of PROXY_ENV_KEYS) {
      if (savedProxyEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedProxyEnv[k];
    }
  }

  let page;
  let openedByUs = false;
  // 签到过程中页面随时可能被客户端关掉/替换：所有读页面、找按钮、点按钮都从这里
  // 拿一个活页再执行；livePage 连新页都开不出来时抛标记错误，由下面的 catch 收口。
  let clickedOnce = false;
  const getLivePage = () => {
    // 点过领取之后页面没了：绝不重开/换页再读——重开的新页还在加载，会把「按钮还没画出来」
    // 误判成「入口已消失=已领取」（离线模拟实测）。直接交给 catch 报「结果待确认」。
    if (clickedOnce && (!page || page.isClosed())) {
      const err = new Error('客户端把签到页关掉了');
      err.code = 'CHECKIN_PAGE_GONE';
      return Promise.reject(err);
    }
    return livePage(browser, page, platform).then((p) => {
    if (!p) {
      const err = new Error('客户端把签到页关掉了，下次再试');
      err.code = 'CHECKIN_PAGE_GONE';
      throw err;
    }
    if (p.__checkinOpenedByUs) openedByUs = true;
    page = p;
    return p;
    });
  };
  const read = (fn) => safeRead(fn, getLivePage);
  // 会点击的操作绝不重试：点完页面才被关掉时重试会再点一次（重复领取）。
  // 只取一次活页执行；点击之后页面没了，交给 catch 报「结果待确认」。
  const act = async (fn) => fn(await getLivePage());

  try {
    // 3) 选页面（必要时用客户端的登录态新开一个任务页）
    const pages = browser.contexts().flatMap((c) => c.pages());
    logger?.step?.(`发现 ${pages.length} 个页面`);

    if (platform.openUrl) {
      page = await browser.contexts()[0].newPage();
      openedByUs = true;
      await page.goto(platform.openUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // 任务/活动面板走异步渲染，多留点时间让它画完
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null);
      // 豆包实测主框架会连续跳 3 次：等 url 稳定 2 秒再读，否则读的是半途的中间页
      let lastNavAt = Date.now();
      const onNav = (frame) => {
        if (frame === page.mainFrame()) lastNavAt = Date.now();
      };
      page.on('framenavigated', onNav);
      const navDeadline = Date.now() + 10_000;
      while (Date.now() < navDeadline) {
        await sleep(500);
        if (Date.now() - lastNavAt >= 2000) break;
      }
      page.off('framenavigated', onNav);
      await sleep(2500);
    } else {
      // 客户端的窗口目标不是跟调试端口一起出现的：主窗口（如 Trae 的 workbench）要再画几秒
      // 才注册进 CDP，之前连上就连着取页面列表，拿到 0 个就直接报「没找到可操作的页面」
      // （Trae 实测必现）。这里轮询等目标出现：优先匹配 pageUrlMatch，等不到再退回第一个页面。
      const pageDeadline = Date.now() + 30_000;
      while (true) {
        const ps = browser.contexts().flatMap((c) => c.pages());
        page = (platform.pageUrlMatch && ps.find((p) => p.url().includes(platform.pageUrlMatch))) || ps[0] || null;
        if (page || Date.now() >= pageDeadline) break;
        await sleep(800);
      }
      logger?.step?.(`选定页面: ${page ? page.url().slice(0, 80) : '无'}（等待期间发现 ${pages.length} 个）`);
      if (!page) return { status: 'error', detail: '没找到可操作的页面（等了 30s 客户端里始终没有窗口目标）' };
      // 刚出现就接管的话界面可能还在加载：留一拍再找菜单/按钮
      await sleep(2500);
    }

    // 3.5) 签到入口藏在账户菜单里的客户端：先点开菜单
    let menuAlreadyOpen = false;
    if (platform.menuOpenTexts.length) {
      const cur = await read((p) => pageVisibleText(p));
      menuAlreadyOpen = platform.menuOpenTexts.some((t) => cur.includes(t));
      if (menuAlreadyOpen) logger?.step?.('前置菜单已打开，跳过点击');
    }
    if (platform.beforeClickSelectors.length && !menuAlreadyOpen) {
      for (const sel of platform.beforeClickSelectors) {
        try {
          const opened = await act(async (p) => {
            const loc = p.locator(sel).first();
            if (await loc.isVisible({ timeout: 1500 })) {
              logger?.step?.(`打开前置菜单: ${sel}`);
              await loc.click({ timeout: 4000 });
              await sleep(1500);
              return true;
            }
            return false;
          });
          if (opened) break;
        } catch (e) {
          if (e?.code === 'CHECKIN_PAGE_GONE') throw e;
          /* 换下一个 */
        }
      }
    }

    // 3.8) 客户端里的活动面板常挂在跨域 iframe，窗口注册进 CDP 后还要 6~10 秒才挂载
    // （Qoder 实测：2.5s 时 frames=1、0 个候选；6s 时 gateway.qoder.com.cn 的
    //  activity-iframe 才带着「领取」按钮出现）。固定 sleep 会漏掉入口，
    // 这里轮询等「完成态文案 / 候选按钮」出现，最多 18 秒。
    const settleUntil = Date.now() + 18_000;
    while (Date.now() < settleUntil) {
      const t = await read((p) => pageVisibleTextDeep(p, 8000));
      if (platform.doneKeywords.some((k) => t.includes(k))) break;
      if ((await read((p) => findCandidateButtonsDeep(p, platform.keywords))).length) break;
      await sleep(1000);
    }

    // 4) 先确认今天没签过，能不点就不点（必须连 iframe 一起读，Qoder 的活动面板在 iframe 里）
    let text = await read((p) => pageVisibleTextDeep(p));
    const doneHit = platform.doneKeywords.find((k) => text.includes(k));
    if (doneHit) return { status: 'already', detail: `页面显示「${doneHit}」，今天已完成` };
    if (doneRuleHit(text, platform.doneRule)) {
      return { status: 'already', detail: '领取入口已消失，页面处于今日已完成状态' };
    }

    if (dryRun) {
      const cands = await read((p) => findCandidateButtonsDeep(p, platform.keywords));
      let selHit = null;
      for (const sel of platform.clickSelectors) {
        try {
          if (await read((p) => p.locator(sel).first().isVisible({ timeout: 800 }))) {
            selHit = sel;
            break;
          }
        } catch (e) {
          if (e?.code === 'CHECKIN_PAGE_GONE') throw e;
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
          const clicked = await act(async (p) => {
            const loc = p.locator(sel).first();
            if (await loc.isVisible({ timeout: 1200 })) {
              logger?.step?.(`命中选择器 ${sel}，点击`);
              clickedOnce = true;
              await loc.click({ timeout: 5000 });
              await sleep(1500);
              const t3 = await pageVisibleText(p, 4000);
              const o3 = readOutcome(t3);
              if (o3.already) return { status: 'already', detail: '点击后提示已完成' };
              if (o3.success) return { status: 'success', detail: '点击后出现成功提示' };
              if (o3.fail) return { status: 'failed', detail: '点击后出现失败提示' };
              return { status: 'uncertain', detail: `已点击入口按钮，未能确认结果` };
            }
            return null;
          });
          if (clicked) return clicked;
        } catch (e) {
          if (e?.code === 'CHECKIN_PAGE_GONE') throw e;
          /* 换下一个 */
        }
      }
      logger?.step?.('选择器全部落空，退回按文案找');
    }

    // 6) 文案匹配点击（与网页端同一套逻辑）
    const login = await read((p) => detectLoginWall(p, text));
    if (login.needLogin) return { status: 'needs_login', detail: login.reason };

    clickedOnce = true; // clickFirstCandidate 内部会点击：从这里起页面再被关掉，只能报「结果待确认」
    let res = await act((p) => clickFirstCandidate(p, platform.keywords, logger, { label: platform.name }));
    // 已经点过候选按钮、只是页面没变化：不能再点第二次（可能重复领取），如实报待确认
    if (!res.clicked && res.tried?.length) {
      return { status: 'uncertain', detail: `已点击「${res.tried[0]}」，页面没有变化，结果待确认（请在客户端里看一眼）` };
    }
    if (!res.clicked) {
      logger?.step?.('首次未找到入口，等 3 秒重试（异步内容可能晚到）');
      await sleep(3000);
      res = await act((p) => clickFirstCandidate(p, platform.keywords, logger, { label: platform.name }));
    }
    const out = res.outcome || {};
    if (out.already) return { status: 'already', detail: `点击后提示已完成（${res.text}）` };
    if (out.success) return { status: 'success', detail: `点击「${res.text}」后出现成功提示` };
    if (out.fail) return { status: 'failed', detail: `点击「${res.text}」后出现失败提示` };
    if (res.clicked) {
      await sleep(1800);
      const t2 = await read((p) => pageVisibleTextDeep(p, 5000));
      const o2 = readOutcome(t2);
      const doneHit2 = platform.doneKeywords.find((k) => t2.includes(k));
      const stillThere = (await read((p) => findCandidateButtonsDeep(p, platform.keywords))).length > 0;
      const ruleDone = doneRuleHit(t2, platform.doneRule);
      // iframe 场景必须以「同一 frame 内的精确按钮」判断入口是否还在。
      // 旧逻辑只查主文档（永远 0 个候选），把「根本没点到」误报成「入口已消失」。
      const entryGone = res.inFrame ? Boolean(res.entryGone) : !stillThere;
      const snippet = String(res.frameText || t2).replace(/\s+/g, ' ').slice(0, 110);

      // 点击前（步骤 4）已排除完成态，这里的完成文案必然是本次点击带来的
      if (doneHit2 || ruleDone) {
        return { status: 'success', detail: `点击「${res.text}」后页面显示「${doneHit2 || '今日已完成'}」` };
      }
      if (o2.already) return { status: 'already', detail: `点击后提示已完成（${res.text}）` };
      if (o2.success) return { status: 'success', detail: `点击「${res.text}」后出现成功提示` };
      if (o2.fail) return { status: 'failed', detail: `点击后出现失败提示：${snippet}` };
      if (!entryGone) {
        return { status: 'uncertain', detail: `已点击「${res.text}」但入口仍在，可能点到了说明文字或遮挡层（页面片段：${snippet}）` };
      }
      // 点击前确认过按钮存在、点击后同一 frame 内消失且无失败提示 → 领取完成
      return { status: 'success', detail: `点击「${res.text}」后领取入口消失且无失败提示，判定已完成（页面片段：${snippet}）` };
    }
    return { status: 'not_found', detail: `页面上没有命中关键词的按钮：${platform.keywords.join('/')}` };
  } catch (e) {
    const pageDead = e?.code === 'CHECKIN_PAGE_GONE' || CLIENT_PAGE_DEAD.test(String(e?.message || e));
    // 已经点过领取按钮之后页面才没了：可能已经领到，不能报失败也不能重跑，交给用户确认
    if (pageDead && clickedOnce) return { status: 'uncertain', detail: '已点击领取，随后客户端关掉了签到页，结果待确认（请在客户端里看一眼今天是否已签到）' };
    if (pageDead) return { status: 'error', detail: '客户端把签到页关掉了，下次再试' };
    return { status: 'error', detail: firstLine(e?.message || e) };
  } finally {
    if (page && shotDir) await snapshot(page, shotDir, platform.id).catch(() => null);
    // 不管 keepRunning 与否，我们开的标签页都要关掉；用户自己的窗口绝不动
    if (openedByUs && page && !page.isClosed()) await page.close().catch(() => null);
    try {
      browser.close?.();
    } catch {
      /* ignore */
    }
    // 收尾按「谁开的谁关」：因签到拉起的才关，用户本来开着的绝不动
    // （为开调试端口重启过的也算用户开着的——签完保持运行，下次还能直接接管）
    if (launched && !wasRunningOriginally) {
      await quitClientGracefully(exe);
    } else if (launched) {
      logger?.info?.(`${platform.name} 原本就在运行，签到后保持运行不关闭`);
    }
  }
}

/* ======================================================================
 * client-open：只替用户把客户端打开，不接管、不读登录态
 * ======================================================================
 * Loomy 这类正式版会剥掉 --remote-debugging-port（连环境变量也忽略），CDP 接不上、
 * 积分页也读不到。铁律：绝不读它的登录文件/令牌，绝不报「已到账」这种假成功。
 */
export async function runClientOpen(platform, { logger, dryRun = false } = {}) {
  const probe = clientProbe(platform);
  const exe = probe.exe && !probe.launcherOnly ? probe.exe : '';
  if (!exe) {
    return {
      status: 'not_installed',
      detail: `没有找到 ${platform.name} 主程序；装在非默认目录的话，在 ~/.free-token/checkin/config.json 的 platforms.${platform.id}.app 填 exe 完整路径`,
    };
  }

  const running = await isClientRunning(exe);
  if (dryRun) {
    return {
      status: 'dry_run',
      detail: running
        ? `已找到 ${platform.name}，正在运行（检测不启动客户端）`
        : `已找到 ${platform.name}：${exe}（检测不启动客户端）`,
    };
  }
  if (running) {
    return {
      status: 'uncertain',
      detail: `${platform.name} 已在运行；它登录状态下每天打开会自动刷新每日积分。正式版禁止外部接管，控制台无法读取「设置 → 积分详情」核实，请自己看一眼今天有没有到账`,
    };
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 不删这个 Electron 会以纯 Node 模式启动并秒退
  delete env.NODE_OPTIONS;
  logger?.info?.(`启动 ${platform.name}：${exe}`);
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', env });
  child.on('error', () => {});
  child.unref(); // 只打开一次，永远不关闭这个客户端

  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    if (await isClientRunning(exe)) {
      return {
        status: 'uncertain',
        detail: `已打开 ${platform.name} 客户端（不会自动关闭）。登录状态下每日积分会自动刷新；正式版禁止外部接管，控制台无法读取「设置 → 积分详情」核实，请自己看一眼`,
      };
    }
    await sleep(1500);
  }
  return { status: 'error', detail: `启动 ${platform.name} 失败（30 秒内没看到进程）` };
}
