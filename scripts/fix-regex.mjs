import fs from 'node:fs';

let s = fs.readFileSync('server/netcheckin/engines.mjs', 'utf8');
// 修复被 bash 转义损坏的正则行：还原为正确的单行正则
const broken = "      if (/(^|\n)\\s*(登录 / 注册|登录\\/注册|登录|注册)\\s*(\n|$)/.test(text)) {";
const fixed = "      if (/(^|\\n)\\s*(登录 \\/ 注册|登录\\/注册|登录|注册)\\s*(\\n|\$)/.test(text)) {";
if (!s.includes(broken)) {
  console.error('损坏行未找到');
  process.exit(1);
}
s = s.replace(broken, fixed);
fs.writeFileSync('server/netcheckin/engines.mjs', s);
console.log('正则已修复');
