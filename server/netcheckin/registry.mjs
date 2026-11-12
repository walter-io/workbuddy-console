/**
 * 「全网签到」平台注册表。
 *
 * 每个平台的签到形态天生分成两类，这个差异无法消除：
 * - web    签到在网页里 → 用共享的 Playwright 持久化 profile 打开页面，点按钮或调接口；
 * - client 签到只存在于桌面客户端内 → 通过调试端口（CDP）接管客户端自己的会话去点。
 *
 * 平台的默认参数集中写在这里（实测调研结论，含踩坑记录）；用户可以在
 * `~/.free-token/checkin/config.json` 里逐字段覆盖（store.mjs 的 resolvePlatforms），
 * 也可以注册全新的自定义平台——改文案/换入口不需要动这里的代码。
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import iconv from 'iconv-lite';
import os from 'node:os';
import path from 'node:path';

export const isWindows = process.platform === 'win32';
export const isMacOS = process.platform === 'darwin';

const WIN_LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const WIN_PF = process.env.ProgramFiles || 'C:\\Program Files';
const WIN_PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

/**
 * 客户端类平台的可执行文件候选路径（按可能性排序，store.mjs 取第一个真实存在的）。
 * 注意 Electron 客户端大多只认环境变量方式开调试端口，命令行传
 * --remote-debugging-port 会被部分客户端拒绝（bad option）。
 */
export const KNOWN_CLIENT_PATHS = {
  // 「豆包」桌面客户端与曾经的「豆包工作」安装都归到这组候选里：两者打开的是
  // 同一个 doubao.com 账号体系，「免费用豆包」活动额度记在同一个账号上，一天只领一次
  doubao: isMacOS
    ? ['/Applications/Doubao.app']
    : [
        path.join(WIN_LOCAL, 'Doubao', 'Application', 'Doubao.exe'),
        path.join(WIN_LOCAL, 'Programs', 'Doubao', 'Doubao.exe'),
        path.join(WIN_PF, 'Doubao', 'Doubao.exe'),
        path.join(WIN_LOCAL, 'Programs', 'DoubaoWork', 'DoubaoWork.exe'),
        path.join(WIN_PF, 'DoubaoWork', 'DoubaoWork.exe'),
        path.join(WIN_PF86, 'DoubaoWork', 'DoubaoWork.exe'),
        path.join(WIN_LOCAL, 'DoubaoWork', 'DoubaoWork.exe'),
      ],
  trae: isMacOS ? ['/Applications/Trae CN.app'] : [path.join(WIN_LOCAL, 'Programs', 'Trae CN', 'Trae CN.exe')],
  // Qoder 有两代安装布局：新版装到 LOCALAPPDATA\Qoder（启动器在 Qoder Launcher 子目录），
  // NSIS 自定义目录安装常见于 Program Files / 自选盘符（exe 名 Qoder.exe 或 Qoder CN.exe）。
  // 2026-11-12 用户实测：装在 E:\Program Files\Qoder CN\Qoder CN.exe 被判「未安装」——
  // 候选列表只认一种布局漏的。Launcher 只是引导壳，真正的主程序是根目录的 Qoder*.exe。
  qoder: isMacOS
    ? ['/Applications/Qoder.app']
    : [
        path.join(WIN_LOCAL, 'Programs', 'Qoder', 'Qoder.exe'),
        path.join(WIN_LOCAL, 'Qoder', 'Qoder.exe'),
        path.join(WIN_PF, 'Qoder', 'Qoder.exe'),
        path.join(WIN_PF, 'Qoder CN', 'Qoder CN.exe'),
        path.join(WIN_PF86, 'Qoder', 'Qoder.exe'),
        path.join(WIN_LOCAL, 'Qoder', 'Qoder Launcher', 'Qoder Launcher.exe'),
        path.join(WIN_LOCAL, 'Qoder CN', 'Qoder CN Launcher', 'Qoder CN Launcher.exe'),
      ],
};

/**
 * 内置平台清单。数组顺序即执行顺序：客户端类在前（不开浏览器就能跑），
 * 网页类在后（需要启动内置浏览器，放后面缩短浏览器在线时间）。
 * 执行按这里的数组顺序；页面展示按类别分组排序（模型 → 编程 → 视频 → 美术），开关状态不影响排序。
 *
 * WorkBuddy 本身不在清单里——它账号级的每日领取由「WorkBuddy 管理 → WorkBuddy 设置」
 * 的每日签到负责（走官方接口 + 成长中心，能力更全），这里再做一个只会重复请求。
 */
export const BUILTIN_PLATFORMS = [
  {
    id: 'doubao',
    name: '豆包',
    kind: 'client',
    category: 'chat',
    engine: 'client-cdp',
    defaultEnabled: false,
    reward: '200 额度/天，周一翻倍',
    app: KNOWN_CLIENT_PATHS.doubao[0],
    appCandidates: KNOWN_CLIENT_PATHS.doubao,
    homepage: 'https://www.doubao.com/chat/',
    port: 9445,
    cdpMode: 'arg',
    // 「免费用豆包」活动页就是签到面板：资料菜单点进去最终开的也是这个地址，
    // 所以不点菜单、直接带登录态开这个 URL 即可；送的额度在「订阅与额度管理」
    // 的「活动赠送额度」里累计（上限会随连签涨，最早一批 30 天左右到期）。
    openUrl: 'https://www.doubao.com/pc/agent-explore',
    keywords: ['立即签到'],
    doneKeywords: ['今日已签到', '今日已领取', '明日再来', '已连续签到'],
    // 领取成功后按钮直接消失（不是变灰）：页面还在活动页（「每日签到」在）而
    // 「立即签到」不在 → 今日已完成。doneKeywords 在这个平台上永远等不到。
    doneRule: { present: ['每日签到'], absent: ['立即签到'] },
    autoRestart: true,
    quitAppName: 'Doubao',
    keepRunning: true,
    notes: '先装好豆包桌面版并登录，领取入口在左下角头像资料区的「免费用豆包」面板里。豆包没装在常规位置的话，把 exe 的完整路径填进 config.json 的 platforms.doubao.app。',
  },
  {
    id: 'trae-cn',
    name: 'Trae 国内版',
    kind: 'client',
    category: 'code',
    engine: 'client-cdp',
    defaultEnabled: false,
    reward: '100 积分/天',
    app: KNOWN_CLIENT_PATHS.trae[0],
    appCandidates: KNOWN_CLIENT_PATHS.trae,
    homepage: 'https://www.trae.cn/',
    port: 9223, // 9222 常被其它 Chromium 应用占用，默认让开
    cdpMode: 'arg',
    autoRestart: true,
    quitAppName: 'Trae CN',
    pageUrlMatch: 'vscode-app',
    // 账户菜单是切换式的：这些文案出现说明菜单已打开，不能再点
    menuOpenTexts: ['每日领 100 积分', '邀请好友得积分', '已签到'],
    beforeClickSelectors: ['[class*="accountTrigger"]', 'button[class*="accountTrigger"]', '[class*="account-trigger"]'],
    keywords: ['签到', '立即签到'],
    doneKeywords: ['已签到', '今日已签到', '明日再来', '今日已领'],
    notes: '需要先安装 Trae 国内版并登录（国际版没有此活动）；领取入口在左下角头像菜单，工具会临时接管客户端完成点击。',
  },
  {
    id: 'qoder-cn',
    name: 'Qoder 国内版',
    kind: 'client',
    category: 'code',
    engine: 'client-cdp',
    defaultEnabled: false,
    reward: '100 Credits/天',
    app: KNOWN_CLIENT_PATHS.qoder[0],
    appCandidates: KNOWN_CLIENT_PATHS.qoder,
    homepage: 'https://qoder.com/',
    port: 9224,
    cdpMode: 'arg',
    clickSelectors: ['[class*="gift"]', '[class*="Gift"]', '[class*="check-in"]', '[class*="checkin"]'],
    keywords: ['领取', '签到', '立即领取'],
    doneKeywords: ['已领取', '已经领过', '明日再来', '明天再来', '今日已领', '领取成功', '已签到'],
    notes: '需要先安装 Qoder 国内版并登录；领取入口在左下角用量面板的礼物图标。额度窗口是每天 10:00 到次日 10:00，错过不补。',
  },
  // 智谱清言（zhipu）：2026-11 移入 MANUAL_PLATFORMS（羊毛情报）。积分是登录自动到账、
  // 每日刷新的额度，没有值得维护的「代领」动作；zhipu-api 专用引擎与登录判定一并移除。
  // 用户配置里遗留的 platforms.zhipu / logins.zhipu 会被自动忽略，历史记录仍留在流水里。
  {
    id: 'minimax',
    name: 'MiniMax Code',
    kind: 'web',
    category: 'code',
    engine: 'minimax-web',
    defaultEnabled: false,
    reward: '400 积分/天，连签第 4、7 天加倍',
    homepage: 'https://agent.minimax.cn/',
    loginUrl: 'https://agent.minimax.cn/',
    entryUrls: ['https://agent.minimax.cn/'],
    keywords: ['每日签到', '签到'],
    doneKeywords: ['今日已签到', '已签到', '明天再来'],
    notes: '从账户菜单进入每日签到，登录一次后即可每天自动领取；积分 30 天内有效。',
  },
  // 扣子（coze）：2026-11 移除。字节已公告企业版停止售卖、专业版停服（2027 年底全面停服），
  // 平台处于收缩期；个人版「登录送 60 积分、当日作废」价值低，不值得继续维护代领。
  // 用户配置里遗留的 platforms.coze / logins.coze 会被自动忽略，历史记录仍留在流水里。
  // 哩布哩布 / 吐司 / PixVerse（拍我AI）/ Vidu：2026-11 移入 MANUAL_PLATFORMS（羊毛情报）。
  // 四家都是「登录即送」（visitClaim）：奖励打开官网就自动到账，没有可点的领取动作，
  // 「代领」只是替用户开一次页面，没有价值——与智谱清言同理，无法累计/攒库存的都归羊毛情报。
  // 用户配置里遗留的 platforms.<id> / logins.<id> 会被自动忽略，历史记录仍留在流水里。
];

/** 内置平台的 id 集合（用于区分自定义平台） */
export const BUILTIN_IDS = new Set(BUILTIN_PLATFORMS.map((p) => p.id));

/** 平台对象的字段默认值（自定义平台也按这个补全） */
export function normalizePlatform(p) {
  return {
    id: p.id,
    name: p.name || p.id,
    kind: p.kind === 'client' ? 'client' : 'web',
    engine: p.engine || (p.kind === 'client' ? 'client-cdp' : 'web'),
    defaultEnabled: false,
    category: ['chat', 'code', 'video', 'art'].includes(p.category) ? p.category : 'chat',
    headed: Boolean(p.headed),
    // 'direct' = 强制直连（绕过系统代理）：站点走代理节点反而不通时用（pixverse 实测）
    proxy: p.proxy === 'direct' ? 'direct' : undefined,
    // 重登窗口先清掉本平台 profile 的 cookie：token 过期后站点 SPA 仍停在
    // 「已登录」页面，不清掉用户没法重新扫码（zhipu 实测）
    reloginClearCookies: Boolean(p.reloginClearCookies),
    visitClaim: Boolean(p.visitClaim),
    // 登录即送类平台：页面出现这些字样即视为已登录（Vidu 的 /create、吐司页头的「算力」等）
    loginOkTexts: Array.isArray(p.loginOkTexts) ? p.loginOkTexts : [],
    // 积分需要下载客户端/在 App 内领取的平台：入口未命中时主动提醒，而不是让用户翻运行记录
    claimViaApp: Boolean(p.claimViaApp),
    appOnlyNote: p.appOnlyNote || '',
    loginProbePath: p.loginProbePath || '',
    reward: p.reward || '',
    homepage: p.homepage || p.url || '',
    loginUrl: p.loginUrl || p.homepage || p.url || '',
    entryUrls: Array.isArray(p.entryUrls) && p.entryUrls.length ? p.entryUrls : [p.homepage || p.url].filter(Boolean),
    keywords: Array.isArray(p.keywords) && p.keywords.length ? p.keywords : ['签到', '每日签到', '立即签到', '打卡', '领取'],
    doneKeywords: Array.isArray(p.doneKeywords) ? p.doneKeywords : ['今日已签到', '已签到', '已领取', '明天再来'],
    // 页面余额正则（可选）：命中后首个捕获组作为积分余额，随每次运行/检测更新到 UI
    creditsPattern: typeof p.creditsPattern === 'string' && p.creditsPattern ? p.creditsPattern : '',
    doneRule:
      p.doneRule && (Array.isArray(p.doneRule.present) || Array.isArray(p.doneRule.absent))
        ? { present: p.doneRule.present || [], absent: p.doneRule.absent || [] }
        : null,
    timeout: Number(p.timeout) || 180_000,
    notes: p.notes || '',
    // 前置入口选择器：签到入口藏在顶栏按钮/菜单里的平台，先点开再找领取按钮
    // （客户端类用 accountTrigger，网页类如哩布哩布的算力面板）——web/client 通用
    beforeClickSelectors: Array.isArray(p.beforeClickSelectors) ? p.beforeClickSelectors : [],
    // 客户端类专属字段原样透传，引擎自己挑着用
    ...(p.kind === 'client' || p.app
      ? {
          app: p.app || '',
          appCandidates: Array.isArray(p.appCandidates) ? p.appCandidates : [],
          port: Number(p.port) || 9445,
          cdpMode: p.cdpMode === 'env' ? 'env' : 'arg',
          cdpEnv: p.cdpEnv || '',
          openUrl: p.openUrl || '',
          pageUrlMatch: p.pageUrlMatch || '',
          clickSelectors: Array.isArray(p.clickSelectors) ? p.clickSelectors : [],
          menuOpenTexts: Array.isArray(p.menuOpenTexts) ? p.menuOpenTexts : [],
          autoRestart: Boolean(p.autoRestart),
          quitAppName: p.quitAppName || '',
          keepRunning: Boolean(p.keepRunning),
          launchTimeoutMs: Number(p.launchTimeoutMs) || 60_000,
        }
      : {}),
  };
}

/* ==================================================================== *
 * 客户端可执行文件发现（2026-11-12 重写）
 *
 * 旧实现只认几个写死的候选目录，且注册表兜底用 `reg query /f /d` 搜数据——
 * 该模式只输出命中的那一行，拿不到同键的 UninstallString/DisplayIcon，
 * 再加上 reg.exe 在部分环境被安全策略禁用，于是「装在自选盘符」恒判未安装。
 *
 * 现在按可靠性分层探测，任何一层失败都不影响下一层：
 *   1. config.json 里用户显式填的 app
 *   2. 内置静态候选（跳过 Launcher 引导壳）
 *   3. 盘符扫描：C:~Z: 的 Program Files / 根目录 × 品牌目录 × 主 exe（纯 fs，零外部依赖）
 *   4. 系统快照：PowerShell 一次取回卸载项 + 运行中客户端的真实 exe 路径
 *      （PowerShell 不可用时退回 reg.exe 全量 /s 分块解析）
 *   5. Launcher 目录里 install.ini/state.ini 记的 installDir（要排除指向国际版的情形）
 *   6. Launcher 兜底：只作为「存在但不是主程序」的诊断信息，绝不拿去开 CDP
 *
 * 国内版平台（qoder-cn / trae-cn）必须排除国际版安装：本机同时装有
 * E:\Program Files\Qoder（0.5.5）与 E:\Program Files\Qoder CN（0.3.3），
 * Launcher 的 ini 指向的是前者，误用会拉起没有签到活动的国际版。
 * ==================================================================== */

/** 平台 id → 发现规格。display 用于匹配卸载项/进程名，cnOnly 表示只认国内版目录 */
const CLIENT_DISCOVERY = {
  doubao: {
    display: /豆包|doubao/i,
    cnOnly: false,
    dirNames: ['Doubao', '豆包', 'DoubaoWork'],
    exeNames: ['Doubao.exe', 'DoubaoWork.exe'],
    subDirs: ['app', 'Application', ''],
  },
  'trae-cn': {
    display: /trae/i,
    cnOnly: true,
    dirNames: ['Trae CN', 'TraeCN'],
    exeNames: ['Trae CN.exe', 'TraeCN.exe'],
    subDirs: [''],
  },
  'qoder-cn': {
    display: /qoder/i,
    cnOnly: true,
    dirNames: ['Qoder CN', 'QoderCN'],
    exeNames: ['Qoder CN.exe', 'QoderCN.exe'],
    subDirs: [''],
  },
};

const isLauncherExe = (c) => /launcher/i.test(String(c || ''));
const isServiceExe = (c) => /uninstall|setup|installer|launcher|update|elevate|crash|helper/i.test(String(c || ''));

/** 系统快照：一次 PowerShell 拿到卸载项与运行中客户端路径，进程内缓存 5 分钟 */
const EMPTY_SNAPSHOT = { uninstall: [], processes: [] };
let SNAPSHOT = { at: 0, data: null };
const SNAPSHOT_TTL_MS = 5 * 60_000;
const SNAPSHOT_FAIL_TTL_MS = 30_000;

function powershellCandidates() {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  return ['powershell.exe', path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
}

/**
 * 用 -EncodedCommand 传脚本（UTF-16LE + base64），彻底绕开 -Command 的引号/转义地狱。
 * 输出一个 JSON 对象 { uninstall: [...], processes: [...] }。
 */
function querySystemSnapshot() {
  const script = [
    // Windows PowerShell 5.1 默认按 OEM 代码页写 stdout，中文 DisplayName（如「豆包」）
    // 被 Node 按 utf8 解码会变成替换字符，品牌匹配恒失败——先强制 UTF-8 输出
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    "$roots = @(",
    " 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    " 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    " 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ')',
    '$u = @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Select-Object DisplayName, DisplayIcon, InstallLocation, UninstallString)',
    "$p = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -match 'Qoder|Doubao|Trae' } | Select-Object -ExpandProperty Path -Unique)",
    '@{ uninstall = $u; processes = $p } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
  for (const cmd of powershellCandidates()) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const parsed = JSON.parse(String(out || '').trim() || '{}');
      const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
      return { uninstall: asArray(parsed.uninstall), processes: asArray(parsed.processes).filter((x) => typeof x === 'string') };
    } catch (e) {
      // 只有「找不到 powershell.exe」才值得换绝对路径重试；其它错误直接走 reg 备用
      if (e?.code !== 'ENOENT') break;
    }
  }
  return null;
}

/** PowerShell 不可用时的备用：reg query /s 全量输出，按 HKEY_ 分块解析整个卸载键 */
function queryUninstallViaReg() {
  const rows = [];
  for (const root of ['HKCU', 'HKLM']) {
    let out = '';
    try {
      const key = [root, 'SOFTWARE', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall'].join('\\');
      const buf = execFileSync('reg', ['query', key, '/s'], { encoding: 'buffer', timeout: 12_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      // 中文 Windows 的 reg.exe 用本地代码页（GBK）输出，按 utf8 解会把「豆包」变乱码
      const asUtf8 = buf.toString('utf8');
      out = asUtf8.includes('\uFFFD') ? iconv.decode(buf, 'gbk') : asUtf8;
    } catch {
      continue;
    }
    let cur = null;
    for (const line of String(out).split(/\r?\n/)) {
      if (/^\s*HKEY_/i.test(line)) {
        if (cur) rows.push(cur);
        cur = {};
        continue;
      }
      if (!cur) continue;
      const m = line.match(/^\s*(DisplayName|DisplayIcon|InstallLocation|UninstallString)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i);
      if (m) cur[m[1]] = m[2].trim();
    }
    if (cur) rows.push(cur);
  }
  return { uninstall: rows.filter((r) => r.DisplayName), processes: [] };
}

function readSystemSnapshot() {
  if (!isWindows) return EMPTY_SNAPSHOT;
  const now = Date.now();
  const ttl = SNAPSHOT.data ? SNAPSHOT_TTL_MS : SNAPSHOT_FAIL_TTL_MS;
  if (SNAPSHOT.at && now - SNAPSHOT.at < ttl) return SNAPSHOT.data || EMPTY_SNAPSHOT;
  const data = querySystemSnapshot() || queryUninstallViaReg();
  const usable = data.uninstall.length > 0 || data.processes.length > 0;
  SNAPSHOT = { at: now, data: usable ? data : null };
  return usable ? data : EMPTY_SNAPSHOT;
}

/** 盘符扫描：不依赖注册表/PowerShell，覆盖 NSIS 自选盘符安装 */
function scanDrives(spec) {
  const roots = [];
  for (let code = 67; code <= 90; code++) {
    const drive = String.fromCharCode(code) + ':\\';
    try {
      if (!fs.existsSync(drive)) continue;
    } catch {
      continue;
    }
    roots.push(path.join(drive, 'Program Files'), path.join(drive, 'Program Files (x86)'), drive);
  }
  for (const root of roots) {
    for (const dir of spec.dirNames) {
      for (const sub of spec.subDirs) {
        for (const name of spec.exeNames) {
          const candidate = path.join(root, dir, sub, name);
          try {
            if (fs.existsSync(candidate)) return candidate;
          } catch {
            /* 单个路径不可读继续下一个 */
          }
        }
      }
    }
  }
  return '';
}

/** 从一条卸载记录推出可能的安装目录（UninstallString 最可靠，DisplayIcon 次之） */
function dirsFromUninstall(row) {
  const dirs = [];
  const push = (v) => {
    if (!v || typeof v !== 'string') return;
    const clean = v.trim().replace(/^"|"$/g, '');
    if (!clean || !/[\\/]/.test(clean)) return;
    const dir = /\.exe$/i.test(clean) || /\.(ico|dll)$/i.test(clean) ? path.dirname(clean) : clean;
    if (dir && dir !== '.') dirs.push(dir);
  };
  const quoted = String(row.UninstallString || '').match(/"([^"]+\.exe)"/i)?.[1];
  push(quoted || String(row.UninstallString || '').split(/\s+\//)[0]);
  push(String(row.DisplayIcon || '').split(',')[0]);
  push(row.InstallLocation);
  return [...new Set(dirs)];
}

/** 在安装目录里定位主 exe：品牌文件名 → 同目录同类 exe → 体积最大者 */
function findMainExeInDir(dir, spec) {
  const usable = (p) => {
    try {
      return fs.existsSync(p) && !isServiceExe(path.basename(p)) ? p : '';
    } catch {
      return '';
    }
  };
  for (const sub of spec.subDirs) {
    for (const name of spec.exeNames) {
      const hit = usable(path.join(dir, sub, name));
      if (hit) return hit;
    }
  }
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f) && !isServiceExe(f));
    for (const f of files) {
      if (spec.exeNames.some((n) => n.toLowerCase() === f.toLowerCase())) {
        const hit = usable(path.join(dir, f));
        if (hit) return hit;
      }
    }
    let best = null;
    let bestSize = 20 * 1024 * 1024; // Electron 主程序通常几十 MB，排除小工具壳
    for (const f of files) {
      try {
        const size = fs.statSync(path.join(dir, f)).size;
        if (size > bestSize) {
          bestSize = size;
          best = f;
        }
      } catch {
        /* 忽略单个文件 */
      }
    }
    if (best) return usable(path.join(dir, best));
  } catch {
    /* 目录不可读 */
  }
  return '';
}

/** Launcher 的 ini 会记真实安装目录；国内版平台必须拒绝指向国际版的目录 */
function fromLauncherIni(candidates, spec) {
  for (const c of candidates) {
    if (!isLauncherExe(c)) continue;
    const dir = path.dirname(c);
    for (const ini of ['state.ini', 'install.ini']) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, ini), 'utf8');
      } catch {
        continue;
      }
      const installDir = /^\s*installDir\s*=\s*(.+)$/im.exec(text)?.[1]?.trim();
      const appExe = /^\s*appExecutable\s*=\s*(.+)$/im.exec(text)?.[1]?.trim();
      if (!installDir || !appExe) continue;
      if (spec.cnOnly && !/cn/i.test(installDir)) continue;
      const candidate = path.join(installDir, appExe);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* 忽略 */
      }
    }
  }
  return '';
}

/** 探测结果缓存：命中且文件仍在就直接复用；未找到只缓存 60 秒，装好客户端后能自愈 */
const PROBE_CACHE = new Map();
const PROBE_TTL_MS = 60_000;

/** 清空发现缓存（配置改了 app、或用户刚装完客户端想立刻重查时调用） */
export function clearClientDiscoveryCache() {
  PROBE_CACHE.clear();
  SNAPSHOT = { at: 0, data: null };
}

/**
 * 完整探测，返回 { exe, source, launcherOnly, tried }。
 * source: config / static / drive-scan / running-process / registry / launcher-ini / launcher / none
 * launcherOnly=true 表示只找到引导壳，不能拿去开 CDP。
 */
export function clientProbe(p, opts = {}) {
  const key = `${p.id}|${p.app || ''}|${(p.appCandidates || []).join('|')}|${opts.skipDriveScan ? 'nodrive' : ''}`;
  const cached = PROBE_CACHE.get(key);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    if (!cached.probe.exe || fs.existsSync(cached.probe.exe)) return cached.probe;
    PROBE_CACHE.delete(key);
  }
  const probe = probeClientNow(p, opts);
  PROBE_CACHE.set(key, { at: Date.now(), probe });
  return probe;
}

function probeClientNow(p, opts = {}) {
  const spec = CLIENT_DISCOVERY[p.id] || {};
  const candidates = [p.app, ...(Array.isArray(p.appCandidates) ? p.appCandidates : [])].filter(Boolean);
  const tried = [];
  const hit = (exe, source) => {
    tried.push({ path: exe, source });
    return { exe, source, launcherOnly: false, tried };
  };

  // 1) 用户显式配置
  if (p.app) {
    try {
      if (fs.existsSync(p.app)) return hit(p.app, 'config');
    } catch {
      /* 路径不可读 */
    }
    tried.push({ path: p.app, source: 'config' });
  }

  // 2) 内置静态候选
  for (const c of candidates) {
    if (isLauncherExe(c)) continue;
    try {
      if (fs.existsSync(c)) return hit(c, 'static');
    } catch {
      /* 路径不可读 */
    }
  }

  // 3) 盘符扫描（纯文件系统，最不容易被环境限制）
  if (!opts.skipDriveScan && isWindows && spec.dirNames) {
    const found = scanDrives(spec);
    if (found) return hit(found, 'drive-scan');
  }

  // 4) 系统快照：先认正在运行的真实进程路径，再查卸载项推安装目录
  if (isWindows && spec.display) {
    const snap = readSystemSnapshot();
    for (const proc of snap.processes) {
      const file = String(proc);
      if (!spec.display.test(path.basename(file))) continue;
      if (spec.cnOnly && !/cn/i.test(file)) continue;
      if (isServiceExe(path.basename(file))) continue;
      try {
        if (fs.existsSync(file)) return hit(file, 'running-process');
      } catch {
        /* 忽略 */
      }
    }
    const rows = snap.uninstall.filter((r) => spec.display.test(String(r.DisplayName || '')));
    const hasCn = rows.some((r) => /cn/i.test(String(r.DisplayName || '')));
    const ordered = spec.cnOnly && hasCn ? [...rows].sort((a, b) => Number(/cn/i.test(String(b.DisplayName || ''))) - Number(/cn/i.test(String(a.DisplayName || '')))) : rows;
    for (const row of ordered) {
      if (spec.cnOnly && hasCn && !/cn/i.test(String(row.DisplayName || ''))) continue;
      for (const dir of dirsFromUninstall(row)) {
        if (spec.cnOnly && !/cn/i.test(dir)) continue;
        const found = findMainExeInDir(dir, spec);
        if (found) return hit(found, 'registry');
      }
    }
  }

  // 5) Launcher ini 反查
  if (isWindows) {
    const found = fromLauncherIni(candidates, spec);
    if (found) return hit(found, 'launcher-ini');
  }

  // 6) 只剩 Launcher：保留路径供诊断，但标记成不可用于 CDP
  for (const c of candidates) {
    if (!isLauncherExe(c)) continue;
    try {
      if (fs.existsSync(c)) return { exe: c, source: 'launcher', launcherOnly: true, tried: [...tried, { path: c, source: 'launcher' }] };
    } catch {
      /* 忽略 */
    }
  }

  return {
    exe: '',
    source: 'none',
    launcherOnly: false,
    tried: candidates.length ? candidates.map((c) => ({ path: c, source: 'candidate' })) : [],
  };
}

/** 排障用：直接查看系统快照（卸载项与运行中客户端路径），不触发任何写操作 */
export function debugSystemSnapshot() {
  const s = readSystemSnapshot();
  return { uninstallCount: s.uninstall.length, processes: s.processes };
}

/** 兼容旧调用方：只要可执行文件字符串 */
export function resolveClientExe(p) {
  return clientProbe(p).exe;
}

/** 客户端是否在本机运行（Windows 按 exe 名匹配进程，mac 按 pgrep） */
export async function isClientRunning(exePath) {
  if (!exePath) return false;
  try {
    if (isWindows) {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const name = path.basename(exePath);
      const { stdout } = await promisify(execFile)('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { timeout: 8000 });
      return stdout.toLowerCase().includes(name.toLowerCase());
    }
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('pgrep', ['-f', exePath], { timeout: 8000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** 温和地结束客户端进程：先普通关闭窗口，超时再强制（只在我们自己拉起时使用） */
export async function quitClientGracefully(exePath, { waitMs = 15_000 } = {}) {
  if (!exePath || !isWindows) return;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const name = path.basename(exePath);
    await promisify(execFile)('taskkill', ['/IM', name, '/T'], { timeout: 10_000 }).catch(() => null);
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      if (!(await isClientRunning(exePath))) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    await promisify(execFile)('taskkill', ['/F', '/IM', name, '/T'], { timeout: 10_000 }).catch(() => null);
  } catch {
    /* 结束失败不影响主流程 */
  }
}
;
/**
 * 羊毛情报：有免费福利、但**无法或不值得由控制台代领**的平台。
 * 挂在这里只做展示（告诉用户去哪手动领），不进执行队列。归类标准：
 * - 代领不了：App 内、客户端非浏览器内核、规则未证实、重登成本高（如百度 Comate）
 * - 不值得：积分当日作废、数额太小，登录即自动到账没有「代领」动作（即梦/海艺等）
 * 原因标签 why 要写清楚是哪种，用户据此决定要不要自己动手。
 */
export const MANUAL_PLATFORMS = [
  {
    id: 'wanxiang',
    name: '通义万相',
    category: 'art',
    reward: '灵感值/天（需在通义 App / 千问内做每日任务获取）',
    why: '2026-11 实测：wanxiang.aliyun.com 已整站重定向到 tongyi.aliyun.com/wan 产品介绍页，网页端没有任何签到/积分入口，无法代领',
    homepage: 'https://tongyi.aliyun.com/wan/',
  },
  {
    id: 'yuanbao',
    name: '腾讯元宝',
    category: 'chat',
    reward: 'App 福利中心每日签到 5000~10000 积分（可兑腾讯视频 / QQ 音乐等）',
    why: '签到只在手机 App 的福利中心里，网页端无法自动化',
    homepage: 'https://yuanbao.tencent.com',
  },
  {
    id: 'toclaw',
    name: 'ToClaw（ToDesk）',
    category: 'code',
    reward: '每天 8 点送 1000 积分（公测期，用于 AI 任务消耗）',
    why: '签到入口在 ToDesk 客户端内部——原生应用，没有浏览器内核可接管',
    homepage: 'https://www.todesk.com',
  },
  {
    id: 'kling',
    name: '可灵 AI',
    category: 'video',
    reward: '绑定快手后每日登录奖励灵感值',
    why: '免费奖励与快手账号绑定挂钩，网页签到入口未证实',
    homepage: 'https://klingai.com',
  },
  {
    id: 'hailuo',
    name: '海螺 AI',
    category: 'video',
    reward: '新人 500 积分；曾有每日赠送（政策已调整）',
    why: '每日赠送的规则不稳定，自动化没有稳定收益',
    homepage: 'https://hailuoai.com',
  },
  {
    id: 'pixverse',
    name: 'PixVerse（拍我AI）',
    category: 'video',
    reward: '基础版每日免费 60 积分（登录自动发放）',
    why: '积分登录自动发放、无需点任何按钮——自己打开网站就有，不需要代领（国内版为 pai.video）',
    homepage: 'https://pai.video/',
  },
  {
    id: 'vidu',
    name: 'Vidu',
    category: 'video',
    reward: '80 积分/天（登录即送，月上限约 800）',
    why: '积分每天登录自动到账、没有领取动作——自己打开网站就有，不需要代领',
    homepage: 'https://www.vidu.cn',
  },
  {
    id: 'seaart',
    name: '海艺 AI',
    category: 'art',
    reward: '每日 150 体力自动刷新（免费生图约 150 次）',
    why: '体力登录自动到账、无需签到——自己打开网站就有，不需要代领',
    homepage: 'https://www.seaart.ai',
  },
  {
    id: 'hunyuan3d',
    name: '腾讯混元 3D',
    category: 'art',
    reward: '每日 20 次免费生成（自动重置，邀请好友可加）',
    why: '额度按天自动重置、无需签到——自己打开网站就有，不需要代领',
    homepage: 'https://3d.hunyuan.tencent.com',
  },
  {
    id: 'liblib',
    name: '哩布哩布',
    category: 'art',
    reward: '每日免费 20 积分（打开官网自动到账）',
    why: '积分打开官网即自动到账、没有领取按钮——自己打开网站就有，不需要代领',
    homepage: 'https://www.liblib.art',
  },
  {
    id: 'tusiart',
    name: '吐司',
    category: 'art',
    reward: '50~100 算力/天 + 20 次免费生图（登录自动到账）',
    why: '算力登录自动到账、无签到按钮——自己打开网站就有，不需要代领',
    homepage: 'https://tusiart.com',
  },
  {
    id: 'duiyou',
    name: '堆友',
    category: 'art',
    reward: '疑似有签到领算力（未证实）',
    why: '签到规则未证实，官网没有公开活动页——有羊毛的话需要自己蹲',
    homepage: 'https://d.design',
  },
  {
    id: 'huiwa',
    name: '绘蛙',
    category: 'art',
    reward: '疑似有每日积分（未证实，用于电商 AI 商品图 / 模特）',
    why: '签到规则未证实，站点有反爬无法验证——有羊毛的话需要自己蹲',
    homepage: 'https://huiwa.cn',
  },
  {
    id: 'qiyu',
    name: '奇域 AI',
    category: 'art',
    reward: '疑似有签到领算力（未证实，中式审美 AI 绘画）',
    why: '签到机制只有社区推测，无官方规则页——需要自己验证',
    homepage: 'https://www.qiyai.com',
  },
  {
    id: 'gaoding',
    name: '稿定设计',
    category: 'art',
    reward: '「豆」权益（每日签到等方式获取，用于智能抠图 / AI 服务）',
    why: '豆的获取与消耗规则在会员中心，AI 功能按次扣豆——自动化价值待评估',
    homepage: 'https://www.gaoding.com',
  },
  {
    id: 'manus',
    name: 'Manus',
    category: 'chat',
    reward: '免费档每日自动刷新 300 积分（仅限 lite 模型，当日有效）',
    why: '积分每日自动到账、无需签到——用多少算多少，不用就清零',
    homepage: 'https://manus.cn',
  },
  {
    id: 'genspark',
    name: 'Genspark',
    category: 'chat',
    reward: '免费档每天自动补充 100 积分（有终身额度上限）',
    why: '积分每日自动到账、无需签到——用多少算多少，终身额度用尽后停止补充',
    homepage: 'https://www.genspark.ai',
  },
  {
    id: 'zhipu',
    name: '智谱清言',
    category: 'chat',
    reward: '每天登录自动送积分（每日刷新）',
    why: '积分登录自动到账、每日刷新——自己打开网站就有，不需要代领',
    homepage: 'https://chatglm.cn/',
  },
  {
    id: 'volcark',
    name: '火山方舟',
    category: 'code',
    reward: '协作奖励计划：按用量 T+1 返还免费 Tokens，单模型最高 500 万/天',
    why: '不是签到制——需先授权模型参与计划，额度随实际用量次日返还（自动化需每日跑推理，属另一个功能模块）',
    homepage: 'https://www.volcengine.com/product/ark',
  },
  {
    id: 'sensenova',
    name: '商汤 SenseNova',
    category: 'code',
    reward: '免费公测配额，每 5 小时刷新',
    why: '配额自动刷新，控制台领取规则以官方为准',
    homepage: 'https://console.sensecore.cn',
  },
  {
    id: 'tingwu',
    name: '通义听悟',
    category: 'chat',
    reward: '每天 48 小时免费转写额度（自动重置）+ 权益加油站签到/任务加时长',
    why: '免费额度每日自动重置；权益加油站的签到/口令活动在登录后的头像菜单里，无固定按钮不可靠',
    homepage: 'https://tingwu.aliyun.com',
  },
  {
    id: 'huiyan',
    name: '慧言 AI',
    category: 'chat',
    reward: '每日自动更新 30 积分（注册另送 100）',
    why: '积分每日自动到账、无需签到——用多少算多少',
    homepage: 'https://www.huiyan.ai',
  },
  {
    id: 'comate',
    name: '百度 Comate',
    category: 'code',
    reward: '注册送 5000 积分 + 每日签到得积分（用于代码补全/生成消耗）',
    why: '积分要下载 Comate 客户端或在 IDE 插件里完成每日任务，网页端没有可代领的入口（2026-11 实测网页代领恒为「入口未命中」）',
    homepage: 'https://comate.baidu.com/',
  },
  {
    id: 'jimeng',
    name: '即梦',
    category: 'video',
    reward: '每日登录送 20~80 积分（随官方活动浮动，当日作废）',
    why: '积分当日作废、价值低，登录官网即自动到账——不值得维护自动代领；想要的话自己打开 jimeng.jianying.com 就有',
    homepage: 'https://jimeng.jianying.com',
  },
  {
    id: 'tiangong',
    name: '天工',
    category: 'chat',
    reward: '注册送 7500 积分 + 邀请好友各得奖励',
    why: '没有每日签到，只有注册与邀请的一次性奖励',
    homepage: 'https://www.tiangong.cn',
  },
];