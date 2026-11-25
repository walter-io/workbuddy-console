/**
 * ZCode 设置读写：只读 ~/.zcode 的关键配置（setting.json / provider_config.json / onboarding-record.json），
 * 加上控制台自己落盘的 zcode 相关项（config.json 的 zcodeProxy 段）。
 * 与 WorkBuddy 设置页对齐：只读展示 + 可写的项单独列出，绝不改 ZCode 的私有文件格式。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ZCODE_V2 = path.join(os.homedir(), '.zcode', 'v2');
/** ZCode 安装目录探测（审查 R004-1：不能写死单一盘符路径）：常见位置 + 环境变量覆盖 */
let zcodeInstallProbeCache = null;
/** R019-3：目录自动探测（不写死任何人的盘符）——注册表卸载项 → 环境变量 → 常见安装根扫描 */
function probeZcodeInstall() {
  if (zcodeInstallProbeCache) return zcodeInstallProbeCache;
  const found = [];
  try {
    // 注册表卸载项：ZCode/智谱 的 InstallLocation / DisplayIcon
    const reg = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'ZCode|智谱' } | ForEach-Object { $_.InstallLocation; $_.DisplayIcon }"].join(''),
      { encoding: 'utf8', timeout: 15000 });
    for (const line of reg.split(/\r?\n/)) {
      const p = line.trim().replace(/",?"?$/, '');
      if (p && /ZCode\.exe$/i.test(p)) found.push(path.dirname(p));
      else if (p && /zcode/i.test(p) && fs.existsSync(p)) found.push(p);
    }
  } catch {}
  if (process.env.ZCODE_INSTALL_DIR) found.push(process.env.ZCODE_INSTALL_DIR);
  // 常见根扫描（存在 ZCode.exe 才收录）：每盘扫 1-2 级目录名含 zcode 的文件夹
  for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
    for (const sub of [drive + '/Program Files/zcode', drive + '/Program Files (x86)/zcode', drive + '/zcode', drive + '/软件/zcode', drive + '/软件安装/zcode', drive + '/app/zcode']) {
      try { if (fs.existsSync(path.join(sub, 'ZCode.exe'))) found.push(sub); } catch {}
    }
    try {
      for (const lvl1 of fs.readdirSync(drive + '/', { withFileTypes: true })) {
        if (!lvl1.isDirectory() || /^(windows|program files|program files (x86)|users|\$recycle\.bin|system volume information|perflogs)$/i.test(lvl1.name)) continue;
        const p1 = path.join(drive, lvl1.name);
        try { if (fs.existsSync(path.join(p1, 'ZCode.exe'))) { found.push(p1); continue; } } catch {}
        try {
          for (const lvl2 of fs.readdirSync(p1, { withFileTypes: true })) {
            if (!lvl2.isDirectory() || !/zcode/i.test(lvl2.name)) continue;
            const p2 = path.join(p1, lvl2.name);
            try { if (fs.existsSync(path.join(p2, 'ZCode.exe'))) { found.push(p2); break; } } catch {}
            try {
              for (const lvl3 of fs.readdirSync(p2, { withFileTypes: true })) {
                if (!lvl3.isDirectory() || !/zcode/i.test(lvl3.name)) continue;
                const p3 = path.join(p2, lvl3.name);
                try { if (fs.existsSync(path.join(p3, 'ZCode.exe'))) { found.push(p3); break; } } catch {}
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }
  zcodeInstallProbeCache = [...new Set(found.filter(Boolean))];
  return zcodeInstallProbeCache;
}
const ZCODE_INSTALL_CANDIDATES = probeZcodeInstall();
let zcodeInstallCache = null;
function detectZcodeInstall() {
  if (zcodeInstallCache && fs.existsSync(zcodeInstallCache)) return zcodeInstallCache;
  for (const dir of ZCODE_INSTALL_CANDIDATES) {
    if (fs.existsSync(path.join(dir, 'ZCode.exe'))) {
      zcodeInstallCache = dir;
      return dir;
    }
  }
  return null;
}
const ZCODE_INSTALL = detectZcodeInstall() || ZCODE_INSTALL_CANDIDATES[0] || null;

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 汇总 ZCode 侧设置（GET /api/zcode/settings 的数据源） */
export function readZcodeSettings() {
  const setting = readJsonSafe(path.join(ZCODE_V2, 'setting.json')) || {};
  const onboarding = readJsonSafe(path.join(ZCODE_V2, 'onboarding-record.json')) || {};
  const credSource = fs.existsSync(path.join(ZCODE_V2, 'credential-source'))
    ? String(fs.readFileSync(path.join(ZCODE_V2, 'credential-source'), 'utf8')).trim()
    : null;
  const cliConfig = readJsonSafe(path.join(os.homedir(), '.zcode', 'cli', 'config.json')) || {};

  // 摘要 ZCode 自身的关键设置（只挑对用户有意义的，不做全量透传）
  const zcodeSettings = {
    locale: setting.locale || setting.uiLocale || null,
    closeToTray: !!setting.closeToTrayOnWindows,
    keepAwakeWhileRunning: !!setting.keepAwakeWhileRunning,
    mobilePushEnabled: !!setting.mobilePushEnabled,
    messageStreamShowReasoning: !!setting.messageStreamShowReasoning,
    autoDownloadUpdates: !!setting.autoDownloadAndInstallUpdates,
    receivePreviewUpdates: !!setting.receivePreviewUpdates,
    recentWorkspaces: Array.isArray(setting.recentProjects) ? setting.recentProjects.slice(0, 5) : [],
    lastActiveWorkspace: setting.lastActiveWorkspace || null,
    enabledCliProviders: Array.isArray(setting.enabledBuiltinAgentCliProviders) ? setting.enabledBuiltinAgentCliProviders : [],
  };

  const entries = Array.isArray(onboarding.entries) ? onboarding.entries : [];
  const firstEntry = entries[0] || null;
  return {
    installDir: ZCODE_INSTALL && fs.existsSync(ZCODE_INSTALL) ? ZCODE_INSTALL : null,
    installExe: ZCODE_INSTALL ? (fs.existsSync(path.join(ZCODE_INSTALL, 'ZCode.exe')) ? path.join(ZCODE_INSTALL, 'ZCode.exe') : null) : null,
    dataDir: ZCODE_V2,
    credentialsFile: path.join(ZCODE_V2, 'credentials.json'),
    credentialSource: credSource,
    userId: firstEntry?.userId || null,
    occupation: firstEntry?.occupation || null,
    interfaceMode: firstEntry?.interfaceMode || null,
    memoryEnabled: !!firstEntry?.memoryEnabled,
    deviceMid: onboarding.deviceMid || null,
    cliPlugins: cliConfig.plugins?.enabledPlugins || {},
    settings: zcodeSettings,
  };
}

/** 控制台侧 ZCode 配置读写（只覆盖 config.json 的 zcodeCheckin 等自有键，不碰 ZCode 文件） */
/** R019-3：客户端行为开关真实写回 ZCode setting.json（客户端重启后生效），控制台不缓存 */
export function writeZcodeClientSetting(key, value) {
  const file = path.join(ZCODE_V2, 'setting.json');
  const raw = readJsonSafe(file) || {};
  const map = {
    closeToTray: 'closeToTrayOnWindows',
    keepAwakeWhileRunning: 'keepAwakeWhileRunning',
    mobilePushEnabled: 'mobilePushEnabled',
    messageStreamShowReasoning: 'messageStreamShowReasoning',
    autoDownloadUpdates: 'autoDownloadAndInstallUpdates',
  };
  const target = map[key];
  if (!target) throw new Error('不支持的开关: ' + key);
  raw[target] = !!value;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  return { key, target, value: !!value };
}
export function readConsoleZcodeConfig(cfg) {
  return {
    proxyEnabled: !!cfg.zcodeProxy?.enabled,
    proxyTimeoutMs: cfg.zcodeProxy?.timeoutMs || 120_000,
    proxyMinIntervalMs: cfg.zcodeProxy?.minIntervalMs ?? 3000,
  };
}
