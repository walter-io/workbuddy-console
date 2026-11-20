/**
 * Qoder 国内版 UI 改版探测第 2 步：逐个点开左下角账号行的小图标（↺ / 时钟 / 齿轮），
 * 每次点完深挖可见按钮与文案，找每日领取入口。只点图标（导航行为），不点领取。
 *
 * 前置：Qoder 已带调试端口 9224 运行（probe-qoder-credits.mjs 已拉起的话直接复用）。
 * 用法：node scripts/probe-qoder-icons.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
    console.log('拉起 Qoder CN…');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    spawn(EXE, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: 'ignore', env }).unref();
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      version = await cdpVersion();
      if (version) break;
      await sleep(1200);
    }
    if (!version) throw new Error('调试端口 60s 未就绪');
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 20_000 });
  let page = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ps = browser.contexts().flatMap((c) => c.pages());
    page = ps.find((p) => p.url().includes('qoder-cn-app')) || ps[0] || null;
    if (page) break;
    await sleep(800);
  }
  if (!page) throw new Error('没找到可操作页面');
  await sleep(3000);

  // 找到左下角账号行（含账号名）右侧的小图标按钮，逐个点开
  const icons = await page.evaluate(() => {
    const h = window.innerHeight;
    const out = [];
    for (const el of document.querySelectorAll('button,[role="button"],[class*="icon"],svg')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // 只看左下角区域（x < 320, y > 底部 160px）
      if (r.x > 320 || r.y < h - 160) continue;
      const cls = String(el.className?.baseVal ?? el.className ?? '').slice(0, 80);
      out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), cls, tag: el.tagName });
    }
    // 按 x 去重排序
    const seen = new Set();
    return out
      .filter((i) => {
        const k = Math.round(i.x / 12);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.x - b.x)
      .slice(0, 6);
  });
  console.log('左下角图标:', JSON.stringify(icons, null, 1));

  const dump = async (tag) => {
    const info = await page.evaluate(() => {
      const btns = [];
      for (const el of document.querySelectorAll('button,[role="button"],a,[class*="gift"],[class*="Gift"],[class*="claim"],[class*="Claim"],[class*="check"],[class*="popover"],[class*="Popover"],[class*="menu"],[class*="Menu"]')) {
        const r = el.getBoundingClientRect();
        const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
        const cls = String(el.className?.baseVal ?? el.className ?? '').slice(0, 100);
        if (!t && !cls) continue;
        if (!r.width || !r.height) continue;
        btns.push({ t, cls });
      }
      const text = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500);
      return { btns: btns.slice(0, 50), text };
    });
    fs.writeFileSync(path.join(OUT, `qoder-${tag}.json`), JSON.stringify(info, null, 2), 'utf8');
    console.log(`\n[${tag}] 按钮:`);
    for (const b of info.btns.filter((x) => x.t).slice(0, 20)) console.log(`  "${b.t}"  <== ${b.cls.slice(0, 70)}`);
    console.log(`  页面文本: ${info.text.slice(0, 400)}`);
    await page.screenshot({ path: path.join(OUT, `qoder-${tag}.png`) }).catch(() => null);
  };

  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    console.log(`\n=== 点图标 ${i + 1} (${ic.tag} @ ${ic.x},${ic.y}) cls=${ic.cls.slice(0, 50)} ===`);
    try {
      await page.mouse.click(ic.x, ic.y);
      await sleep(2000);
      await dump(`icon-${i + 1}`);
      // 按 Esc 关掉弹层再试下一个
      await page.keyboard.press('Escape').catch(() => null);
      await sleep(800);
    } catch (e) {
      console.log('  点击失败:', e.message.split('\n')[0]);
    }
  }

  await browser.close();
  console.log('\n探测完成（未点任何领取按钮）');
}

main().catch((e) => {
  console.error('探测失败:', e.message);
  process.exit(1);
});
