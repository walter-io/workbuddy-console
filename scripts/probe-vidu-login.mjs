/**
 * Vidu 登录流侦查：打开首页 → 点「去创作」→ 观察未登录时出现什么（弹窗/跳转），
 * 导出 URL、登录相关文本与 cookie，用于设计 Vidu 的登录成功判定器。
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false, channel: 'chromium' });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://www.vidu.cn', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
await page.waitForTimeout(5000);

// 点「去创作」（未登录应当触发登录提示）
let clicked = '';
for (const t of ['去创作', '立即创作', '立即体验']) {
  try {
    const loc = page.locator(`text=${t}`).first();
    if (await loc.isVisible({ timeout: 1500 })) {
      await loc.click({ timeout: 4000 });
      clicked = t;
      break;
    }
  } catch {
    /* 下一个 */
  }
}
console.log('点击:', clicked || '(没找到可点入口)');
await page.waitForTimeout(4000);
console.log('点击后 URL:', page.url());

const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
console.log('--- 登录相关行 ---');
for (const l of lines) if (/登录|注册|验证码|手机号|扫码/.test(l)) console.log('  ·', l.slice(0, 80));

const cookies = await ctx.cookies();
const tracking = /^(acw_tc|cdn_sec_tc|_c_|_nb_|_abfpc|Hm_|HMACCOUNT|AGL_USER_ID|cna|_uetsid|_uetvid|_clck|ssxmod_|_clsk)/i;
const sessionCookies = cookies.filter((c) => !tracking.test(c.name));
console.log('--- 非追踪 cookie（疑似会话） ---');
for (const c of sessionCookies) console.log('  ·', c.name, '=', String(c.value).slice(0, 20), `(domain=${c.domain})`);

console.log('--- 可见文本（前 15 行） ---');
for (const l of lines.slice(0, 15)) console.log('  ·', l.slice(0, 70));
await page.waitForTimeout(3000);
await browser.close();
