/**
 * Qoder 国内版 UI 改版探测：拉起客户端（带调试端口）→ 连 CDP →
 * 点开首页卡片的「Credits」标签 → 深挖可见按钮与文案，找每日领取入口。
 * 只点「Credits」标签（导航行为），不点任何领取按钮。
 *
 * 用法：node scripts/probe-qoder-credits.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXE = 'E:\\Program Files\\Qoder CN\\Qoder CN.exe';
const PORT = 9224;
const OUT = path.join(import.meta.dirname, 'probe-out');

const cdpVersion = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let version = await cdpVersion();
  if (!version) {
    console.log('拉起 Qoder CN（调试端口 9224）…');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: 'ignore', env });
    child.unref();
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      version = await cdpVersion();
      if (version) break;
      await sleep(1200);
    }
    if (!version) throw new Error('调试端口 60s 未就绪');
  }
  console.log('CDP 就绪:', version.Browser);

  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 20_000 });
  const deadline = Date.now() + 30_000;
  let page = null;
  while (Date.now() < deadline) {
    const ps = browser.contexts().flatMap((c) => c.pages());
    page = ps.find((p) => p.url().includes('qoder-cn-app')) || ps[0] || null;
    if (page) break;
    await sleep(800);
  }
  if (!page) throw new Error('没找到可操作页面');
  console.log('页面:', page.url().slice(0, 100));
  await sleep(4000);

  const dump = async (tag) => {
    const info = await page.evaluate(() => {
      const btns = [];
      for (const el of document.querySelectorAll('button,[role="button"],a,[class*="gift"],[class*="Gift"],[class*="credit"],[class*="Credit"],[class*="check"],[class*="tab"],[class*="Tab"]')) {
        const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        const cls = String(el.className?.baseVal ?? el.className ?? '').slice(0, 90);
        const r = el.getBoundingClientRect();
        if (!t && !cls) continue;
        if (r.width < 6 || r.height < 6) continue;
        btns.push({ t, cls, visible: r.width > 0 && getComputedStyle(el).visibility !== 'hidden' });
      }
      return { title: document.title, url: location.href, btns: btns.slice(0, 60) };
    });
    fs.writeFileSync(path.join(OUT, `qoder-${tag}.json`), JSON.stringify(info, null, 2), 'utf8');
    console.log(`[${tag}] ${info.btns.length} 个元素 → qoder-${tag}.json`);
    for (const b of info.btns.filter((x) => x.t).slice(0, 30)) console.log(`  "${b.t}"  <== ${b.cls}`);
    await page.screenshot({ path: path.join(OUT, `qoder-${tag}.png`) }).catch(() => null);
    return info;
  };

  await dump('home');

  // 点「Credits」标签（首页卡片的会话/Credits 切换），不点领取
  for (const label of ['Credits', '积分', '额度']) {
    try {
      const loc = page.locator(`text=${label}`).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        console.log(`点击「${label}」标签`);
        await loc.click({ timeout: 4000 });
        await sleep(2500);
        break;
      }
    } catch {
      /* 换下一个 */
    }
  }
  await dump('credits-tab');

  // 深挖 iframe（活动面板可能仍挂在跨域 iframe）
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    console.log('iframe:', frame.url().slice(0, 100));
    try {
      const txt = (await frame.locator('body').innerText({ timeout: 3000 })).replace(/\s+/g, ' ').slice(0, 600);
      console.log('  文本片段:', txt);
    } catch {
      /* 不可读 */
    }
  }

  await browser.close();
  console.log('探测完成（未点任何领取按钮）');
}

main().catch((e) => {
  console.error('探测失败:', e.message);
  process.exit(1);
});
