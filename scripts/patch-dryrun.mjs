import fs from 'node:fs';

let s = fs.readFileSync('server/netcheckin/engines.mjs', 'utf8');
const from = "  if (login.needLogin) return { status: 'needs_login', detail: login.reason, url: page.url(), candidates: [], buttons: allButtons };";
const toLines = [
  "  if (login.needLogin) return { status: 'needs_login', detail: login.reason, url: page.url(), candidates: [], buttons: allButtons };",
  '  // 登录即到账的平台：检测语义与正式运行一致（被人机验证拦截/登录入口仍在/已登录）',
  '  if (platform.visitClaim) {',
  '    if (/验证您是真人|请按住滑块|拖动到最右|人机验证|安全验证/.test(text)) {',
  "      return { status: 'uncertain', detail: '被人机验证拦截，稍后自动重试', url: page.url(), candidates: [], buttons: allButtons };",
    '    }',
  '    if (/(^|\\n)\\s*(登录 \\/ 注册|登录\\/注册|登录|注册)\\s*(\\n|$)/.test(text)) {',
  "      return { status: 'needs_login', detail: '登录入口仍在（点「登录」授权一次）', url: page.url(), candidates: [], buttons: allButtons };",
    '    }',
  "    return { status: 'dry_run', detail: '检测通过：已登录（登录即送平台，访问即到账）', url: page.url(), candidates: [], buttons: allButtons };",
  '  }',
];
if (!s.includes(from)) {
  console.error('dryRunWeb 锚点未命中');
  process.exit(1);
}
s = s.replace(from, toLines.join('\n'));
fs.writeFileSync('server/netcheckin/engines.mjs', s);
console.log('dryRunWeb visitClaim 已加');
