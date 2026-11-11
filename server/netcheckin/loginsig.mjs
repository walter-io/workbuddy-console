/**
 * 登录凭据签名（cookie 签名）：登录检测的统一地基。
 *
 * 痛点：登录判定散在三处（登录窗口探测、领取侧登录墙、检测侧），且全部依赖页面
 * 文案正则——SPA 慢渲染、退出入口藏在悬停菜单、按钮纯图标，每接一个平台都要人工
 * 踩坑补正则（liblib 的 usertoken、comate 的 BDUSS、pai.video 的水合等待……全是实测踩出来的）。
 *
 * 原理：登录窗口是唯一能确定「用户刚登录过」的时刻。开窗加载完先拍一份该域 cookie
 * **名字**快照（不含值，凭据不落盘），会话结束再拍一份，差集就是这次登录真正带来的
 * 会话 cookie。签名落盘后，所有登录判定优先比对签名：
 *   - 全在   → 已登录（不碰页面文案，慢渲染/悬停菜单都骗不了它）
 *   - 全缺   → 登录失效，直接引导重登
 *   - 部分缺失 → 不武断，回退旧文案判定（防统计 cookie 轮换造成误报）
 * 没有签名的平台完全走老路，零行为回归。
 */

import { loadConfig, saveConfigAsync } from './store.mjs';

/** 平台的 cookie 归属域：登录页优先，官网兜底（两处不同时都收） */
export function cookieOriginsFor(platform) {
  const origins = [];
  for (const u of [platform.loginUrl, platform.homepage]) {
    if (!u) continue;
    try {
      const o = new URL(u).origin;
      if (!origins.includes(o)) origins.push(o);
    } catch {
      /* 非法 URL 忽略 */
    }
  }
  return origins;
}

/** 拍该平台全部归属域的 cookie 名快照。键用 `domain|name`：同名 cookie 在不同域
 *  各自独立，混在一起比对会把别的域的登录态误算进去 */
export async function snapshotCookieNames(ctx, platform) {
  const names = [];
  for (const origin of cookieOriginsFor(platform)) {
    const cs = await ctx.cookies(origin).catch(() => []);
    for (const c of cs) {
      const key = `${c.domain}|${c.name}`;
      if (!names.includes(key)) names.push(key);
    }
  }
  return names;
}

/** 学习签名：登录后快照相对登录前基线的差集。差集非空才落盘（只记名字），返回差集；
 *  没有新 cookie（比如窗口里本来就已登录）返回 null，不动旧签名 */
export async function learnSig(id, platform, beforeNames, afterNames) {
  const fresh = (afterNames || []).filter((n) => !(beforeNames || []).includes(n));
  if (!fresh.length) return null;
  const cfg = loadConfig();
  cfg.cookieSigs = {
    ...(cfg.cookieSigs || {}),
    [id]: { url: cookieOriginsFor(platform)[0] || '', names: fresh, at: Date.now() },
  };
  await saveConfigAsync(cfg);
  return fresh;
}

/** 签名校验：'valid' 全在 | 'invalid' 全缺 | 'partial' 部分缺失（回退文案判定）| 'none' 无签名 */
export async function sigCheck(platform, ctx) {
  const sig = platform.cookieSig;
  if (!ctx || !sig || !Array.isArray(sig.names) || !sig.names.length) return 'none';
  const current = new Set(await snapshotCookieNames(ctx, platform).catch(() => []));
  const missing = sig.names.filter((n) => !current.has(n));
  if (!missing.length) return 'valid';
  if (missing.length === sig.names.length) return 'invalid';
  return 'partial';
}
