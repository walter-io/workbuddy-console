/**
 * 站点侦查（zaoba 式调研法）：拉取目标站首页与两层 JS bundle，
 * 统计「签到/积分/算力/领取」等关键词出现次数，并列出命中的 bundle 与
 * 含签到字样的上下文片段——用于判断平台的签到机制是网页按钮、接口还是不存在。
 */
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const NEEDLES = ['签到', '积分', '算力', '每日领取', '灵感值', 'checkin', 'check_in', 'sign_in'];

const scan = async (name, homeUrl) => {
  const seen = new Set();
  const queue = [homeUrl];
  const counter = {};
  const contexts = [];
  let fetched = 0;

  const grab = async (url) => {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) });
    return r.text();
  };

  // 第 1 层：首页；第 2 层：首页引用的 JS；第 3 层：JS 里再引用的同域 chunk
  for (let level = 0; level < 3 && queue.length; level++) {
    const batch = queue.splice(0, level === 0 ? 1 : 20);
    for (const url of batch) {
      if (seen.has(url) || fetched > 45) continue;
      seen.add(url);
      try {
        const text = await grab(url);
        fetched++;
        for (const n of NEEDLES) {
          const c = (text.match(new RegExp(n, 'gi')) || []).length;
          if (c) {
            counter[n] = (counter[n] || 0) + c;
            if ((n === '签到' || n === 'checkin' || n === 'check_in' || n === 'sign_in') && contexts.length < 8) {
              const i = text.toLowerCase().indexOf(n.toLowerCase());
              contexts.push(url.split('/').pop().slice(0, 50) + ' → …' + text.slice(Math.max(0, i - 60), i + 80).replace(/\s+/g, ' ') + '…');
            }
          }
        }
        if (level < 2) {
          const refs = [...text.matchAll(/["'(]((?:https?:\/\/[^"')\s]+)?\/[^"')\s]+?\.js(?:\?[^"')\s]*)?)/g)]
            .map((m) => new URL(m[1], url).href)
            .filter((u) => !u.includes('chrome-extension') && !seen.has(u));
          queue.push(...refs.slice(0, 15));
        }
      } catch {
        /* 单个资源失败跳过 */
      }
    }
  }
  console.log('[' + name + '] 抓取', fetched, '个文件 | 命中:', JSON.stringify(counter));
  for (const c of contexts) console.log('   ', c);
};

const SITES = { modelscope: ['魔搭', 'https://www.modelscope.cn/home'], jimeng: ['即梦', 'https://jimeng.jianying.com/'], liblib: ['哩布', 'https://www.liblib.art/'] };
const targets = process.argv[2] && process.argv[3] ? [[process.argv[2], process.argv[3]]] : process.argv[2] ? [SITES[process.argv[2]]] : [
  ['魔搭', 'https://www.modelscope.cn/home'],
  ['即梦', 'https://jimeng.jianying.com/'],
  ['哩布', 'https://www.liblib.art/'],
];
for (const [name, url] of targets) await scan(name, url);
