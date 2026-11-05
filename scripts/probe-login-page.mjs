/**
 * 登录页侦查：无头打开目标站，导出最终 URL、可见文本行、按钮字样与 cookie 清单，
 * 用于给该平台写「登录成功」判定器（login.mjs 的 DETECTORS）。
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'https://www.vidu.cn';
const browser = await chromium.launch({ headless: false, channel: 'chromium' });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
await page.waitForTimeout(5000);

console.log('最终 URL:', page.url());
const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
console.log('--- 可见文本（前 30 行） ---');
for (const l of lines.slice(0, 30)) console.log('  ·', l.slice(0, 70));
console.log('--- 含 登录/注册/验证码 的行 ---');
for (const l of lines) if (/登录|注册|验证码|手机号/.test(l)) console.log('  ·', l.slice(0, 80));

const cookies = await ctx.cookies(url);
console.log('--- cookie 名 ---');
console.log(cookies.map((c) => c.name).join(', ') || '(无)');
await browser.close();
