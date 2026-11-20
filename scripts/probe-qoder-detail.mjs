/**
 * Qoder 探测第 3 步：打开左下角「我的用量」面板 → 点「查看详情」→
 * 列出所有新开的 CDP 页面目标与 iframe，找领取入口。
 *
 * 用法：node scripts/probe-qoder-detail.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const PORT = 9224;
const OUT = path.join(import.meta.dirname, 'probe-out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 20_000 });

  let page = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ps = browser.contexts().flatMap((c) => c.pages());
    page = ps.find((p) => p.url().includes('qoder-cn-app')) || ps[0] || null;
    if (page) break;
    await sleep(800);
  }
  if (!page) throw new Error('没找到主页面');
  console.log('主页面:', page.url().slice(0, 80));

  // 点开「我的用量」面板（左下角第 4 个图标），再点「查看详情」
  const openUsage = await page.evaluate(() => {
    const h = window.innerHeight;
    const btns = [...document.querySelectorAll('button,[role="button"]')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width && r.height && r.x < 320 && r.y > h - 160)
      .sort((a, b) => a.r.x - b.r.x);
    // 第 4 个 = 用量（第 5 个是设置齿轮）
    const target = btns[3] || btns[btns.length - 2];
    if (!target) return false;
    target.el.click();
    return true;
  });
  console.log('打开用量面板:', openUsage);
  await sleep(1500);

  const detail = page.locator('text=查看详情').first();
  if (await detail.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('点击「查看详情」');
    await detail.click({ timeout: 4000 }).catch((e) => console.log('点击失败:', e.message.split('\n')[0]));
  } else {
    console.log('「查看详情」不可见');
  }
  await sleep(6000);

  // 列出所有页面目标与 frame
  const pages = browser.contexts().flatMap((c) => c.pages());
  console.log(`\n当前 ${pages.length} 个页面目标:`);
  for (const p of pages) console.log('  -', p.url().slice(0, 110));

  const dump = async (p, tag) => {
    try {
      const info = await p.evaluate(() => {
        const btns = [];
        for (const el of document.querySelectorAll('button,[role="button"],a')) {
          const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
          const cls = String(el.className?.baseVal ?? el.className ?? '').slice(0, 100);
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          if (!t && !/gift|claim|check|sign/i.test(cls)) continue;
          btns.push({ t, cls });
        }
        const text = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 2000);
        return { url: location.href, btns: btns.slice(0, 60), text };
      });
      fs.writeFileSync(path.join(OUT, `qoder-${tag}.json`), JSON.stringify(info, null, 2), 'utf8');
      console.log(`\n[${tag}] ${info.url.slice(0, 100)}`);
      for (const b of info.btns.filter((x) => x.t).slice(0, 25)) console.log(`  "${b.t}"  <== ${b.cls.slice(0, 70)}`);
      console.log('  文本:', info.text.slice(0, 600));
      await p.screenshot({ path: path.join(OUT, `qoder-${tag}.png`) }).catch(() => null);
    } catch (e) {
      console.log(`[${tag}] 读取失败: ${e.message.split('\n')[0]}`);
    }
    // frame 级深挖
    for (const f of p.frames()) {
      if (f === p.mainFrame()) continue;
      console.log(`  [${tag}] iframe: ${f.url().slice(0, 110)}`);
      try {
        const t = (await f.locator('body').innerText({ timeout: 4000 })).replace(/\s+/g, ' ').slice(0, 800);
        console.log('    文本:', t);
        for (const b of await f.locator('button,[role="button"]').all()) {
          const bt = (await b.innerText().catch(() => '')).trim();
          if (bt) console.log('    按钮:', JSON.stringify(bt.slice(0, 40)));
        }
      } catch {
        /* 不可读 */
      }
    }
  };

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (p.url().includes('qoder-cn-app') && pages.length > 1) continue;
    await dump(p, `detail-${i}`);
  }

  await browser.close();
  console.log('\n探测完成（未点任何领取按钮）');
}

main().catch((e) => {
  console.error('探测失败:', e.message);
  process.exit(1);
});
