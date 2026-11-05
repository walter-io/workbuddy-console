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
  qoder: isMacOS ? ['/Applications/Qoder.app'] : [path.join(WIN_LOCAL, 'Programs', 'Qoder', 'Qoder.exe')],
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
    doneKeywords: ['已领取', '明天再来', '已签到'],
    notes: '需要先安装 Qoder 国内版并登录；领取入口在左下角用量面板的礼物图标。额度窗口是每天 10:00 到次日 10:00，错过不补。',
  },
  {
    id: 'zhipu',
    name: '智谱清言',
    kind: 'web',
    category: 'chat',
    engine: 'zhipu-api',
    defaultEnabled: true,
    reward: '每天登录就有积分入账',
    homepage: 'https://chatglm.cn/',
    loginUrl: 'https://chatglm.cn/',
    entryUrls: ['https://chatglm.cn/'],
    keywords: ['签到', '每日登录', '领取'],
    doneKeywords: ['今日登录积分已到账', '今日已领取'],
    notes: '直连官方接口完成每日领取，不依赖页面按钮；登录失效时点「登录」重新授权一次即可。',
  },
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
  {
    id: 'wanxiang',
    name: '通义万相',
    kind: 'web',
    category: 'art',
    engine: 'web',
    defaultEnabled: false,
    reward: '灵感值/天',
    homepage: 'https://wanxiang.aliyun.com/',
    loginUrl: 'https://wanxiang.aliyun.com/',
    entryUrls: ['https://wanxiang.aliyun.com/'],
    keywords: ['签到', '立即签到', '领取'],
    doneKeywords: ['今日已签到', '已签到', '已领取'],
    notes: '产品已并入千问，入口可能随时变化；默认关闭，确认能正常领取后再打开。',
  },
  {
    id: 'coze',
    name: '扣子',
    kind: 'web',
    category: 'chat',
    engine: 'web',
    defaultEnabled: false,
    reward: '60 积分/天（当日有效，登录自动发放）',
    homepage: 'https://www.coze.cn',
    visitClaim: true,
    loginProbePath: '/workspace',
    loginUrl: 'https://www.coze.cn',
    entryUrls: ['https://www.coze.cn/workspace', 'https://www.coze.cn'],
    keywords: ['签到', '领取', '积分中心'],
    doneKeywords: ['积分'],
    notes: '积分每天登录自动发放（60 点，当日作废）——打开工作台就算领到。状态显示「今日已领」即正常；若「入口未命中」也无需理会，积分已到账。',
  },
  {
    id: 'jimeng',
    name: '即梦',
    kind: 'web',
    category: 'video',
    engine: 'web',
    defaultEnabled: false,
    reward: '每日登录送积分（20~80 随活动浮动）',
    homepage: 'https://jimeng.jianying.com',
    visitClaim: true,
    loginProbePath: '/create',
    loginUrl: 'https://jimeng.jianying.com',
    entryUrls: ['https://jimeng.jianying.com'],
    keywords: ['签到', '立即签到', '领取'],
    doneKeywords: ['今日已签到', '已签到', '已领取', '明日再来'],
    notes: '每日登录送积分，数额随官方活动浮动（20~80 不等）；免费积分一般当日有效，建议当天用掉。',
  },
  {
    id: 'liblib',
    name: '哩布哩布',
    kind: 'web',
    category: 'art',
    engine: 'web',
    defaultEnabled: false,
    reward: '300 算力/天',
    homepage: 'https://www.liblib.art',
    loginUrl: 'https://www.liblib.art',
    entryUrls: ['https://www.liblib.art'],
    // 每日领取入口不稳定：页头的算力按钮（Topbar_powerBtn）弹出的面板实测只有充值；
    // 免费算力可能以登录弹窗/活动页形式发放。代领时会自动点开算力面板核对，
    // 显示「没找到入口」时打开官网核对，若活动页有领取按钮，把按钮文字补进 config 的 keywords。
    beforeClickSelectors: ['[class*="Topbar_powerBtn"]', '[class*="powerBtn"]'],
    keywords: ['签到', '领取', '每日领取'],
    doneKeywords: ['今日已领取', '已领取', '明日再来', '今日已签到'],
    notes: '免费用户每日登录可领 300 点算力（领取形式随活动变化，可能以登录弹窗或活动页发放）。代领会自动点开页头算力按钮的面板核对；显示「没找到入口」时请打开官网看看活动页，把按钮文字补进 config 的 keywords 即可。',
  },
  {
    id: 'tusiart',
    name: '吐司',
    kind: 'web',
    category: 'art',
    engine: 'web',
    defaultEnabled: false,
    reward: '50~100 算力/天 + 20 次免费生图',
    homepage: 'https://tusiart.com',
    loginUrl: 'https://tusiart.com',
    // 算力是「登录即送」：页头出现「算力」余额字样即视为已到账（没有签到按钮可点）
    visitClaim: true,
    loginOkTexts: ['算力'],
    entryUrls: ['https://tusiart.com'],
    keywords: ['签到', '领取'],
    doneKeywords: ['算力'],
    notes: '每天登录自动送算力（约 50~100）并有 20 次不耗算力的生图次数，打开页面即到账、无签到按钮；历史记录免费版只保留 14 天。',
  },
  {
    id: 'comate',
    name: '百度 Comate',
    kind: 'web',
    category: 'code',
    engine: 'web',
    defaultEnabled: false,
    reward: '注册送 5000 积分，每日签到得积分',
    homepage: 'https://comate.baidu.com/',
    loginUrl: 'https://comate.baidu.com/',
    entryUrls: ['https://comate.baidu.com/'],
    keywords: ['签到', '领取'],
    doneKeywords: ['今日已签到', '已签到', '我的积分'],
    // 网页端没有可靠的代领入口：积分要下载 Comate / 在 IDE 插件里做每日任务。
    // claimViaApp=true 时，运行结果一旦「入口未命中」，工具会主动提醒而不是让用户翻运行记录。
    claimViaApp: true,
    appOnlyNote: '实测网页端通常没有可代领的签到入口——百度的积分需要下载 Comate 客户端 / 在 IDE 插件内完成每日任务才能领取，请以官网活动页为准。',
    notes: '百度 AI 编程助手：官方定价页确认个人版可通过每日签到获取积分（用于代码补全/生成消耗）。签到入口在网页个人中心，也可能只在 IDE 插件里——显示「入口未命中」时以官网为准。',
  },
  {
    id: 'pixverse',
    name: 'PixVerse',
    kind: 'web',
    engine: 'web',
    defaultEnabled: false,
    category: 'video',
    reward: '30 积分/天（注册另送 60）',
    homepage: 'https://pixverse.ai/zh',
    loginUrl: 'https://pixverse.ai/zh',
    entryUrls: ['https://pixverse.ai/zh'],
    keywords: ['签到', '领取', '每日积分'],
    doneKeywords: ['今日已领取', '已领取', '已签到'],
    notes: '官方信息页确认每日 30 积分（注册另送 60），用于视频生成。到账方式与领取入口需登录后确认——若自动领取显示「入口未命中」，说明积分是登录自动发放或入口在 App 内。',
  },
  {
    id: 'vidu',
    name: 'Vidu',
    kind: 'web',
    category: 'video',
    engine: 'web',
    defaultEnabled: false,
    reward: '80 积分/天（登录即送）',
    // 站点风控对无头浏览器必弹人机验证——Vidu 的领取必须用可见窗口
    headed: true,
    // 每天登录即送积分，没有「签到按钮」可点：确认已登录就算领取完成
    visitClaim: true,
    homepage: 'https://www.vidu.cn',
    visitClaim: true,
    loginProbePath: '/create',
    loginUrl: 'https://www.vidu.cn/create/img2video',
    entryUrls: ['https://www.vidu.cn/create/img2video', 'https://www.vidu.cn'],
    keywords: ['签到', '领取'],
    doneKeywords: ['积分'],
    notes: '每天登录自动送 80 积分（月上限约 800），积分用于文生视频。站点风控对无头浏览器必弹人机验证——领取时会弹出一个可见的浏览器窗口，属正常现象。',
  },
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

/** 客户端可执行文件解析：显式路径存在 → 用它；否则在候选里找第一个真实存在的 */
export function resolveClientExe(p) {
  const candidates = [];
  if (p.app) candidates.push(p.app);
  if (Array.isArray(p.appCandidates)) candidates.push(...p.appCandidates);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // 都不存在时返回第一个候选（调用方靠「文件不存在」判定未安装，给出可执行的提示）
  return candidates[0] || '';
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
 * 羊毛情报：确认有免费福利、但**无法由控制台代领**的平台。
 * 挂在这里只做展示（告诉用户去哪手动领），不进执行队列。
 * 原因标签 why 要写清楚是哪种「不能」：App 内、客户端非浏览器内核、规则未证实、
 * 无需代领（自动到账）等——用户据此决定要不要自己动手。
 */
export const MANUAL_PLATFORMS = [
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
    id: 'tiangong',
    name: '天工',
    category: 'chat',
    reward: '注册送 7500 积分 + 邀请好友各得奖励',
    why: '没有每日签到，只有注册与邀请的一次性奖励',
    homepage: 'https://www.tiangong.cn',
  },
];