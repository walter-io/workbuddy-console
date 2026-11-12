/**
 * 网页类签到的 DOM 操作层。
 *
 * 核心思路是「文案命中 + 真实鼠标点击」，而不是 Playwright 的 getByText：
 * - 各家按钮叫法五花八门（签到/立即签到/打卡/领取/领积分…），同一串字还常出现
 *   嵌在三四层 div 里，按文案定位器枚举反而更慢更脆；
 * - 在页面里直接枚举元素、按「命中关键词 + 可见 + 尺寸合理 + 只取最深节点」筛出
 *   候选，最后用真实鼠标坐标点击——比 el.click() 更容易被前端框架正确响应。
 *
 * 另一块是登录墙识别：每天自动跑最容易失败的地方不是点击，而是登录态过期后
 * 「点不到按钮 → 静默失败」。三级判定把这种情况显式暴露成 needs_login。
 */

import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面可见文本快照：判断「点了之后界面有没有变化」全靠它 */
export async function pageVisibleText(page, limit = 20_000) {
  try {
    const t = await page.evaluate(() => document.body?.innerText || '');
    return t.slice(0, limit);
  } catch {
    return '';
  }
}

/** 单个 frame 的可见文本（iframe 里的活动弹窗用它） */
export async function frameVisibleText(frame, limit = 20_000) {
  try {
    const t = await frame.evaluate(() => document.body?.innerText || '');
    return String(t || '').slice(0, limit);
  } catch {
    return '';
  }
}

/**
 * 主文档 + 所有可访问 iframe 的可见文本。
 * Qoder/Trae 这类 Electron 客户端常把活动面板整块挂在 iframe 里，
 * 只读 document.body.innerText 会既看不到成功提示、也看不到「已领取」，
 * 甚至连「入口还在不在」都判断不了（主文档永远 0 个候选 → 恒判「入口已消失」）。
 */
export async function pageVisibleTextDeep(page, limit = 20_000) {
  const parts = [];
  const main = await pageVisibleText(page, limit);
  if (main) parts.push(main);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const t = await frameVisibleText(frame, limit);
    if (t) parts.push(t);
  }
  return parts.join('\n').slice(0, limit);
}

const LOGIN_URL_RE = /(login|signin|sign-in|passport|sso|oauth|authorize|account\/login)/i;
const LOGIN_TEXT_RE =
  /(扫码登录|登录后|请先登录|手机号登录|验证码登录|账号登录|立即登录|登录\/注册|登录或注册|登录以同步|登录以使用|登录以查看|未登录)/;
/** 已登录的强信号：出现任意一个就说明页面里的「登录」字样只是普通链接。
 *  注意不能放「头像」这类弱词：pai.video 的未登录首页模板文案里就有「头像」，
 *  会被误判成已登录、跳过登录墙检查（2026-11-06 实测） */
const LOGGED_IN_RE = /(退出登录|切换账号|个人中心|我的主页|账户设置)/;
const LOGIN_BUTTON_TEXTS = ['登录', '立即登录', '登录/注册', '登录或注册', '扫码登录', '登录以同步历史会话', '登录以使用'];

/**
 * 是否被踢回了登录页。
 * 三级判断：URL 跳到登录域 > 文本出现明确登录提示 > 页面上只有「登录」入口按钮
 * 且没有任何已登录标志。
 */
export function looksLikeLoginWall(url, text) {
  const t = norm(text);
  if (LOGIN_URL_RE.test(url)) return { needLogin: true, reason: `地址被带去了登录页: ${url}` };
  if (LOGIN_TEXT_RE.test(t)) return { needLogin: true, reason: '页面弹出了登录/扫码字样' };
  return { needLogin: false, reason: '' };
}

/** 异步版：多一步 DOM 检查「页面上有没有孤立的『登录』入口按钮」 */
export async function detectLoginWall(page, text) {
  const quick = looksLikeLoginWall(page.url(), text);
  if (quick.needLogin) return quick;

  const t = norm(text);
  if (LOGGED_IN_RE.test(t)) return { needLogin: false, reason: '' };

  const findLoginButton = () =>
    page
      .evaluate(
        ({ texts }) => {
          const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();
          for (const el of document.querySelectorAll('*')) {
            const tt = norm(el.textContent);
            if (!texts.includes(tt)) continue;
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width < 6 || r.height < 6) continue;
            return tt;
          }
          return null;
        },
        { texts: LOGIN_BUTTON_TEXTS },
      )
      .catch(() => null);

  const hit = await findLoginButton();
  if (hit) return { needLogin: true, reason: '登录已失效（页面上只剩登录入口）' };
  // 慢渲染站（pai.video 实测）：topbar 和登录按钮可能晚 10 秒才画出来，单点检查会被
  // 「页面还没水合」骗过去。轮询等页面定型——登录按钮出现=未登录；强登录信号出现=已登录；
  // 文本长度连续两轮不变且始终没有登录按钮，才认定「已登录/无登录墙」放行
  let lastLen = norm(text).length;
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const t2 = norm(await pageVisibleText(page, 4000).catch(() => ''));
    if (LOGGED_IN_RE.test(t2)) return { needLogin: false, reason: '' };
    const found = await findLoginButton();
    if (found) return { needLogin: true, reason: '登录已失效（页面上只剩登录入口）' };
    if (t2.length === lastLen && i >= 2) break; // 页面已定型，别干等满 8 秒
    lastLen = t2.length;
  }
  return { needLogin: false, reason: '' };
}


/**
 * 候选按钮扫描：主文档与 iframe 共用同一份逻辑。
 * 作为 evaluate 回调传入，函数体必须自包含（不能引用外部闭包变量）。
 * - exactOnly: 只保留「文本恰好等于关键词」的节点，避免点到
 *   「每日 10:00 刷新，领取后 30 天有效」「活动权益以领取时的账户状态为准」这类说明文字。
 * - mark: 给第一个命中元素打上属性，供 frame.locator() 做真实点击
 *   （iframe 内的坐标是相对 frame 的，不能直接交给 page.mouse.click）。
 */
function scanCandidatesInDocument({ kw, maxTextLen = 14, exactOnly = false, mark = '' }) {
  const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();
  const isVisible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    if (parseFloat(st.opacity || '1') < 0.15) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  };

  const hits = [];
  const nodes = document.querySelectorAll(
    'button,a,[role="button"],[role="link"],div,span,li,label,p,strong,em,b,section,article,img,svg',
  );
  for (const el of nodes) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') continue;
    let text = norm(el.textContent);
    if (!text && el.getAttribute) {
      text = norm(el.getAttribute('aria-label') || el.getAttribute('title') || '');
    }
    if (!text || text.length > maxTextLen) continue;
    if (!kw.some((k) => text.includes(k))) continue;
    if (exactOnly && !kw.some((k) => text === k)) continue;
    if (!isVisible(el)) continue;
    hits.push({ el, text, tag, cls: typeof el.className === 'string' ? el.className : '' });
  }

  // 只留最深节点：外层容器常含同样的关键词，点它的中心点不到真按钮
  const covered = new Set();
  for (const h of hits) {
    let p = h.el.parentElement;
    while (p && !covered.has(p)) {
      covered.add(p);
      p = p.parentElement;
    }
  }
  const deepest = hits.filter((h) => !covered.has(h.el));

  const out = [];
  for (const h of deepest.slice(0, 12)) {
    try {
      h.el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
      /* 滚不了就按原坐标点 */
    }
    const r = h.el.getBoundingClientRect();
    out.push({
      text: h.text,
      tag: h.tag,
      cls: h.cls.slice(0, 120),
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  if (mark && deepest.length) {
    try {
      deepest[0].el.setAttribute(mark, '1');
    } catch {
      /* 忽略 */
    }
  }
  return out;
}

/** 找出页面上「像签到按钮」的候选元素（返回坐标，由外层真实点击）。 */
export async function findCandidateButtons(page, keywords, { maxTextLen = 14 } = {}) {
  const kw = keywords.map((s) => (s || '').replace(/[\s\u3000]+/g, '').trim()).filter(Boolean);
  if (!kw.length) return [];
  return page.evaluate(scanCandidatesInDocument, { kw, maxTextLen, exactOnly: false, mark: '' });
}

/** 主文档 + 所有 iframe 的候选按钮：点击后判断「入口是否还在」必须用它 */
export async function findCandidateButtonsDeep(page, keywords, { maxTextLen = 14 } = {}) {
  const kw = keywords.map((s) => (s || '').replace(/[\s\u3000]+/g, '').trim()).filter(Boolean);
  if (!kw.length) return [];
  const out = [];
  try {
    const main = await page.evaluate(scanCandidatesInDocument, { kw, maxTextLen, exactOnly: false, mark: '' });
    out.push(...main.map((c) => ({ ...c, inFrame: false })));
  } catch {
    /* 主文档不可用继续看 iframe */
  }
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const hits = await frame.evaluate(scanCandidatesInDocument, { kw, maxTextLen, exactOnly: false, mark: '' });
      out.push(...hits.map((c) => ({ ...c, inFrame: true })));
    } catch {
      /* 跨域/已销毁的 frame 跳过 */
    }
  }
  return out;
}

/** 全页面文本里扫「是否已签过 / 是否成功 / 是否失败」 */
export function readOutcome(text) {
  const t = norm(text);
  const already = /(今日已签到|今日已签|已经签到|已签到|已领取|已经领过|已领过|今天已领|明天再来|明日再来|签到已完成|今日签到已完成)/.test(t);
  const success = /(签到成功|领取成功|签到完成|领取完成|获得|已到账|签到获得)/.test(t);
  const fail = /(签到失败|领取失败|操作失败|系统繁忙|请稍后|网络异常|重复签到)/.test(t);
  return { already, success, fail };
}

/** 截当前页面存盘（排障的第一手现场），返回文件路径或 null */
export async function snapshot(page, dir, name) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

/** 存 HTML 快照：关键词对不上时靠它离线分析该把哪个文案加进 keywords */
export async function dumpHtml(page, dir, name) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.html`);
    fs.writeFileSync(file, await page.content(), 'utf8');
    return file;
  } catch {
    return null;
  }
}

/**
 * 主流程：按关键词定位按钮 → 真实点击 → 读回结果。
 * 返回 { clicked, text, outcome, tried }。
 */
export async function clickFirstCandidate(page, keywords, logger, { label = '' } = {}) {
  const candidates = await findCandidateButtons(page, keywords);
  logger?.step?.(
    `${label} 候选元素 ${candidates.length} 个${candidates.length ? '：' + candidates.map((c) => c.text).slice(0, 6).join(' / ') : ''}`,
  );

  const tried = [];
  for (const c of candidates.slice(0, 4)) {
    const before = await pageVisibleText(page, 4000);
    tried.push(c.text);
    try {
      await page.mouse.click(c.x, c.y);
    } catch {
      // 坐标点击失败（元素刚好被移除/遮挡）：退化为 DOM click
      try {
        await page.evaluate(
          ({ text }) => {
            const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();
            const nodes = document.querySelectorAll('button,a,[role="button"],div,span');
            for (const el of nodes) {
              if (norm(el.textContent) === text) {
                el.click();
                return true;
              }
            }
            return false;
          },
          { text: c.text },
        );
      } catch {
        /* ignore */
      }
    }

    await sleep(1200 + Math.random() * 800);
    const after = await pageVisibleText(page, 4000);
    const outcome = readOutcome(after);
    const changed = after !== before;

    if (outcome.already || outcome.success || outcome.fail || changed) {
      return { clicked: true, text: c.text, outcome, changed };
    }
  }

  // 主文档没找到时到 iframe 里找（Qoder 的「每天领 100 Credits」弹窗整块挂在 iframe）。
  // 旧写法 frame.getByText(/领取/).first() 命中的常是「领取后 30 天有效」这类说明文字，
  // 点完毫无反应；这里改成「文本恰好等于关键词」+ 打标记 + frame.locator 真实点击。
  const kwExact = keywords.map((s) => (s || '').replace(/[\s\u3000]+/g, '').trim()).filter(Boolean);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const MARK = 'data-wb-checkin';
    let hits = [];
    try {
      hits = await frame.evaluate(scanCandidatesInDocument, { kw: kwExact, maxTextLen: 14, exactOnly: true, mark: MARK });
    } catch {
      continue;
    }
    if (!hits.length) continue;
    const btn = hits[0];
    const before = await frameVisibleText(frame, 4000);
    try {
      const loc = frame.locator(`[${MARK}="1"]`).first();
      if (!(await loc.isVisible({ timeout: 1200 }))) continue;
      logger?.step?.(`iframe 内命中按钮「${btn.text}」，点击`);
      await loc.click({ timeout: 4000 });
    } catch {
      continue;
    }
    await sleep(1200);
    const after = await frameVisibleText(frame, 4000);
    const afterHits = await frame
      .evaluate(scanCandidatesInDocument, { kw: kwExact, maxTextLen: 14, exactOnly: true, mark: '' })
      .catch(() => []);
    const mainAfter = await pageVisibleText(page, 4000);
    return {
      clicked: true,
      text: `[iframe] ${btn.text}`,
      outcome: readOutcome(`${after}\n${mainAfter}`),
      changed: after !== before,
      frameText: after,
      entryGone: afterHits.length === 0,
      inFrame: true,
    };
  }

  return { clicked: false, text: null, outcome: readOutcome(await pageVisibleText(page, 4000)), changed: false, tried };
}

/** 打开页面并等它基本可用（domcontentloaded + networkidle 尽力等 + 抖动） */
export async function openAndWait(page, url, logger, { settle = 1500 } = {}) {
  logger?.info?.(`打开 ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(settle + Math.random() * 800);
  try {
    // SPA 在 domcontentloaded 之后还要拉数据；有长轮询的站永远不 idle，别等死
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch {
    /* ignore */
  }
  await sleep(600 + Math.random() * 800);
  return page;
}

/**
 * 目标按钮「看得到但点不到」的检测。
 *
 * isVisible() 只管 CSS 可见性，不管上面压了多少层。运营弹窗/活动公告一盖，
 * elementFromPoint 落在遮罩上，locator.click() 会一直等到超时——外面看起来
 * 就是「找到了入口却没找到可点击的按钮」这类自相矛盾的报错。
 * 这里直接问浏览器：按钮中心点到底落在哪个元素上？
 */
export async function elementCoverage(page, selector) {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { exists: false, covered: false, hit: null, rect: null, label: '' };
      const r = el.getBoundingClientRect();
      const rect = { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      const st = getComputedStyle(el);
      const hidden = st.display === 'none' || st.visibility === 'hidden' || r.width < 4 || r.height < 4;
      const hit = document.elementFromPoint(rect.cx, rect.cy);
      const owned = !!hit && (hit === el || el.contains(hit));
      return {
        exists: true,
        covered: !hidden && !owned,
        label: (el.getAttribute('aria-label') || (el.textContent || '').trim() || '').slice(0, 60),
        disabled: !!el.disabled,
        rect,
        hit: hit
          ? {
              tag: hit.tagName,
              cls: typeof hit.className === 'string' ? hit.className.slice(0, 120) : '',
              aria: hit.getAttribute?.('aria-label') || '',
              text: (hit.textContent || '').trim().slice(0, 80),
            }
          : null,
      };
    }, selector)
    .catch((e) => ({
      exists: false,
      covered: false,
      hit: null,
      rect: null,
      label: '',
      error: String(e?.message || e).split('\n')[0].slice(0, 120),
    }));
}

const UNBLOCK_MARK = 'data-wb-unblock-close';

/**
 * 在「遮住目标按钮的那一层」里找关闭控件并打标记。
 * 必须限定在覆盖层内部：页面同时可能有「关闭签到」这类卡片按钮，
 * 全局按「关闭」文案扫会先把签到面板本身关掉（2026-11-12 MiniMax 实测）。
 */
async function markBlockingCloseButton(page, selector) {
  return page
    .evaluate(
      ({ sel, mark }) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        if (!hit) return null;
        // 从命中的遮罩往上找到铺满视口的那层 fixed/absolute 容器
        let scope = hit;
        let top = null;
        while (scope && scope !== document.body && scope !== document.documentElement) {
          const cs = getComputedStyle(scope);
          const sr = scope.getBoundingClientRect();
          if ((cs.position === 'fixed' || cs.position === 'absolute') && sr.width >= innerWidth * 0.6 && sr.height >= innerHeight * 0.6) top = scope;
          scope = scope.parentElement;
        }
        if (!top) return null;
        const isClose = (b) => {
          const t = `${b.getAttribute?.('aria-label') || ''} ${b.getAttribute?.('title') || ''} ${(b.textContent || '').trim()}`;
          if (!/关闭|close|跳过|我知道了|稍后再说/i.test(t)) return false;
          if (/签到|signin|claim/i.test(t)) return false;
          const br = b.getBoundingClientRect();
          return br.width >= 8 && br.height >= 8;
        };
        const btn = [...top.querySelectorAll('button,[role="button"]')].find(isClose);
        if (!btn) return { close: null, blocker: top.getAttribute?.('aria-label') || (top.textContent || '').trim().slice(0, 40) };
        btn.setAttribute(mark, '1');
        return { close: btn.getAttribute?.('aria-label') || (btn.textContent || '').trim() || '(关闭按钮)', blocker: top.getAttribute?.('aria-label') || '' };
      },
      { sel: selector, mark: UNBLOCK_MARK },
    )
    .catch(() => null);
}

/**
 * 把挡在目标按钮前面的弹层清掉，每轮复检，直到真的能点到为止。
 * 顺序：弹层内的关闭按钮 → Esc → 直接摘掉全屏遮罩 DOM（最后手段）。
 * 返回 { covered, cleared, blocker, attempts } 供引擎写进失败原因里。
 */
export async function unblockElement(page, selector, logger, { maxRounds = 3 } = {}) {
  const attempts = [];
  let blocker = '';
  let cov = await elementCoverage(page, selector);
  if (!cov.exists || !cov.covered) return { covered: false, cleared: false, blocker, attempts, coverage: cov };
  blocker = cov.hit?.aria || cov.hit?.text || cov.hit?.cls?.slice(0, 40) || '';

  for (let i = 0; i < maxRounds && cov.covered; i++) {
    let acted = false;
    const found = await markBlockingCloseButton(page, selector);
    if (found?.blocker) blocker = found.blocker;
    if (found?.close) {
      try {
        await page.locator(`[${UNBLOCK_MARK}="1"]`).first().click({ timeout: 3000 });
        attempts.push(`关闭弹层「${found.close}」`);
        acted = true;
      } catch (e) {
        attempts.push(`关闭按钮点不动：${String(e?.message || e).split('\n')[0].slice(0, 70)}`);
      } finally {
        await page.evaluate((mark) => document.querySelectorAll(`[${mark}]`).forEach((el) => el.removeAttribute(mark)), UNBLOCK_MARK).catch(() => null);
      }
    }
    if (!acted && i < maxRounds - 1) {
      await page.keyboard.press('Escape').catch(() => null);
      attempts.push('按 Esc');
    }
    // 最后一轮仍被挡：摘掉铺满视口的遮罩（只动覆盖层，不碰签到卡片）
    if (!acted && i === maxRounds - 1) {
      const removed = await page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return 0;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          let scope = hit;
          let top = null;
          while (scope && scope !== document.body && scope !== document.documentElement) {
            const cs = getComputedStyle(scope);
            const sr = scope.getBoundingClientRect();
            if ((cs.position === 'fixed' || cs.position === 'absolute') && sr.width >= innerWidth * 0.6 && sr.height >= innerHeight * 0.6) top = scope;
            scope = scope.parentElement;
          }
          if (!top || top.contains(el)) return 0;
          top.remove();
          return 1;
        }, selector)
        .catch(() => 0);
      if (removed) attempts.push('移除全屏遮罩层');
    }
    await sleep(900);
    cov = await elementCoverage(page, selector);
  }
  const cleared = !cov.covered;
  logger?.step?.(cleared ? `遮挡已清除（${attempts.join('、') || '无需处理'}）` : `遮挡仍在：${blocker || '未知弹层'}`);
  return { covered: !cleared, cleared, blocker, attempts, coverage: cov };
}

/**
 * 清掉挡在按钮前面的弹层与遮罩。
 * 实战里最常见的两类「假故障」：隐私协议/活动公告把签到按钮盖住、全屏遮罩让
 * 鼠标点击落在遮罩上。点掉的顺序把「取消/暂不」放最后，避免误取消真操作。
 */
const OVERLAY_TEXTS = ['我知道了', '知道了', '我已知晓', '同意并继续', '我同意', '同意', '接受', '关闭', '稍后再说', '暂不', '跳过', '取消'];

export async function closeOverlays(page, logger, { maxClicks = 2 } = {}) {
  let clicked = 0;
  for (let i = 0; i < maxClicks; i++) {
    const cands = (await findCandidateButtons(page, OVERLAY_TEXTS, { maxTextLen: 8 }))
      // 「关闭签到」「关闭领取面板」这类按钮属于目标本身，点了等于自己把入口关掉
      .filter((c) => !/签到|签领|signin|claim|领取/i.test(`${c.text} ${c.cls}`));
    if (!cands.length) break;
    const c = cands[0];
    try {
      await page.mouse.click(c.x, c.y);
      clicked++;
      logger?.step?.(`关闭弹窗: 「${c.text}」`);
      await sleep(800);
    } catch {
      break;
    }
  }
  return clicked;
}

/** 页面上所有可见短文案按钮（检测时列出来，用于校准 keywords） */
export async function listVisibleButtons(page, { limit = 40 } = {}) {
  return page
    .evaluate(
      ({ limit }) => {
        const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();
        const out = [];
        for (const el of document.querySelectorAll('button,[role="button"],a')) {
          const t = norm(el.textContent);
          if (t && t.length <= 20 && out.length < limit) out.push(t);
        }
        return [...new Set(out)];
      },
      { limit },
    )
    .catch(() => []);
}
