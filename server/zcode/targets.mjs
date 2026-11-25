/**
 * ZCode 客户端进程检测与结束（账号切换前必须关掉：运行中的 ZCode 会把内存登录态写回磁盘）。
 * 对齐 WorkBuddy 的 targets/workbuddy.mjs 语义；启动走 /api/zcode/launch。
 * 可执行文件位置全部走通用探测，不含任何个人电脑路径。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { findZcodeInstallDir } from './gift.mjs';

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    /* 忽略探测失败 */
    return false;
  }
};

/**
 * 找 ZCode 可执行文件，按顺序：
 *   1. 环境变量 ZCODE_INSTALL_DIR 下的 ZCode.exe
 *   2. findZcodeInstallDir()（注册表 / 常见安装路径）返回目录下的 ZCode.exe
 *   3. LOCALAPPDATA 下两种大小写目录、ProgramFiles 下的 ZCode.exe
 * 第一个存在的就返回，都没有返回 null。
 */
export function findZcodeExe() {
  const envDir = typeof process.env.ZCODE_INSTALL_DIR === 'string' ? process.env.ZCODE_INSTALL_DIR.trim() : '';
  if (envDir) {
    const p = path.join(envDir, 'ZCode.exe');
    if (exists(p)) return p;
  }

  const installDir = findZcodeInstallDir();
  if (installDir) {
    const p = path.join(installDir, 'ZCode.exe');
    if (exists(p)) return p;
  }

  // 环境变量缺失时用通用的用户目录推导，不写死具体盘符或个人路径。
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(localAppData, 'Programs', 'ZCode', 'ZCode.exe'),
    path.join(localAppData, 'Programs', 'zcode', 'ZCode.exe'),
  ];
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'ZCode', 'ZCode.exe'));
  return candidates.find(exists) || null;
}

/** 检测 ZCode 是否在运行 → { running, pids } */
export function detectZcodeProcess() {
  return new Promise((resolve) => {
    // -Command 模式的参数拼接会踩引号坑（'-join ','' 被拆成两个 argv → ParserError，恒返回 running:false）。
    // 与 credentialStore 同款方案：-EncodedCommand（UTF-16LE base64），彻底绕开 argv 引号层。
    const script = '(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ","';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ running: false, pids: [], error: String(err.message || err) });
        const pids = String(stdout || '').trim().split(',').filter(Boolean).map(Number).filter(Number.isFinite);
        resolve({ running: pids.length > 0, pids });
      }
    );
  });
}

/** 结束全部 ZCode 进程（先温和关窗，3 秒后强杀残余） */
export function stopZcode() {
  return new Promise((resolve) => {
    // 同 detectZcodeProcess：走 -EncodedCommand 避免 argv 引号层（CloseMainWindow/Stop-Process 含 $_ 与嵌套引号）
    const script = [
      '$ps = Get-Process -Name ZCode -ErrorAction SilentlyContinue',
      'if ($ps) { $ps | ForEach-Object { $_.CloseMainWindow() } | Out-Null; Start-Sleep -Seconds 3 }',
      '$left = Get-Process -Name ZCode -ErrorAction SilentlyContinue',
      'if ($left) { $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800 }',
      '(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Measure-Object).Count',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err.message || err) });
        resolve({ ok: true, remaining: Number(String(stdout || '0').trim()) || 0 });
      }
    );
  });
}
