import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'netcheckin-shot.png');
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:57913/#netcheckin', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
await page.evaluate(() => { const el = [...document.querySelectorAll('h2,span,div')].find((e) => e.textContent === '领取记录'); el?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: out });
console.log('截图:', out);
await browser.close();
