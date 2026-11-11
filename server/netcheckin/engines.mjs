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
      if (/(^|\n)\s*(登录 \/ 注册|登录\/注册|登录|注册)\s*(\n|$)/.test(text)) {
        return { status: 'needs_login', detail: '登录入口仍在，点「重新登录」授权一次', url: page.url() };
      }
      if (platform.loginProbePath && page.url().includes(platform.loginProbePath)) {
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
      if (!/(登录|注册)/.test(text)) {
        return { status: 'success', detail: '已到账（页面上没有「登录/注册」入口，视为已登录；登录即送到账）', url: page.url(), meta: { credits: captureCredits(platform, text) } };
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
    if (/(^|\n)\s*(登录 \/ 注册|登录\/注册|登录|注册)\s*(\n|$)/.test(text)) {
      return { status: 'needs_login', detail: '登录入口仍在（点「登录」授权一次）', url: page.url(), candidates: [], buttons: allButtons };
    }
    // 探测路径命中（登录后仍停留的页面地址）= 已登录的正证
    if (platform.loginProbePath && page.url().includes(platform.loginProbePath)) {
      return { status: 'dry_run', detail: '检测通过：已登录（登录即送平台，访问即到账）', url: page.url(), candidates: [], buttons: allButtons, meta: { credits: captureCredits(platform, text) } };
    }
    // 页面出现平台专属的登录后字样（如吐司页头的「算力」余额）= 已登录
    const okHit = (platform.loginOkTexts || []).find((k) => k && text.includes(k));
    if (okHit) {
      return { status: 'dry_run', detail: `检测通过：页面出现「${okHit}」，已登录且已到账`, url: page.url(), candidates: [], buttons: allButtons, meta: { credits: captureCredits(platform, text) } };
    }
    // 兜底正证：全文没有「登录/注册」字样 = 登录入口已消失 = 已登录（同正式运行的判定）
    if (!/(登录|注册)/.test(text)) {
      return { status: 'dry_run', detail: '检测通过：页面上没有「登录/注册」入口，视为已登录', url: page.url(), candidates: [], buttons: allButtons, meta: { credits: captureCredits(platform, text) } };
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
