/**
 * 页面截图自审工具（开发辅助，不进构建流程）。
 * 用法: node scripts/shot.mjs <url> <输出.png> [等待毫秒]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [, , url, out, waitMs = '2600'] = process.argv;
if (!url || !out) {
  console.error('用法: node scripts/shot.mjs <url> <输出.png> [等待毫秒]');
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
await page.waitForTimeout(Number(waitMs));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('saved:', out);
