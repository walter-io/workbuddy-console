/**
 * ZCode 免 key 上游实现（gift plan 链路）· 通用版
 * ---------------------------------------------------------------------------
 * 用途：像 magpie 那样，直接用**本机** ZCode 客户端的登录态（zcodejwttoken）反代，
 *      **不需要用户手工粘贴 API key**，请求消耗该用户自己的 ZCode 免费套餐额度
 *      （WEEKEND BUILD 五亿 / Start Plan 三百万）。
 *
 * ★ 本文件不含任何账号、邮箱、密钥、额度数字或本机路径硬编码。
 *   装到任何人的电脑上，它都自动发现：
 *     · 凭据目录（dataBaseDir → ZCODE_HOME → homedir）
 *     · 凭据文件 ~/.zcode/v2/credentials.json
 *     · 主密钥（OS 凭据管理器，account = sha256(凭据文件绝对路径).hex）
 *     · ZCode 安装目录与真实版本号（注册表 / 常见安装路径 / 环境变量）
 *   然后读取**该用户自己**的登录态与额度。
 *
 * 链路要点（全部经实机验证，见 docs/ZCODE-GIFT-UPSTREAM.md）：
 *   端点   POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
 *   鉴权   Authorization: Bearer <zcodejwttoken>
 *   body   必须 dress() 成 ZCode 的三段 cached system block，否则 405/3012
 *   头     必须全套客户端指纹头，app_version 需 >= 3.17.2
 *   并发   免费套餐有槽位上限，超限报 3008，需排队
 *
 * 与 key 链路的区别：
 *   旧的 key 链路（BigModel 官方 anthropic 端点 + x-api-key）扣的是 **付费余额**，
 *   且 gift-only 账号在 key 背后没有 coding plan（实测 "当前用户不存在coding plan"），
 *   不会扣到任何免费额度。本文件这条链路才是吃免费额度的。
 *
 * 安全红线：
 *   - token 只出现在 Authorization 头，绝不写日志、绝不回显到前端
 *   - 额度接口只返回数字，不回显 token
 *   - 不把任何登录态写进本文件或任何提交物
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { PROMPT } from './zcode_prompt_bytes.mjs';

export const ZCODE_GIFT_ORIGIN = 'https://zcode.z.ai';
export const GIFT_BASE = ZCODE_GIFT_ORIGIN + '/api/v1/zcode-plan/anthropic';
export const BALANCE_URL = ZCODE_GIFT_ORIGIN + '/api/v1/zcode-plan/billing/balance';
export const DEFAULT_APP_VERSION = '3.17.2';
export const MIN_APP_VERSION = '3.17.2';

const KEYRING_SVC = 'ZCode Credential Encryption';
const ENC_PREFIX = 'enc:v2:os:';

/* ── 稳定 ID 派生 ──────────────────────────────────────────────────────────── */

/** 由种子派生的确定性 v4 形状 UUID：同一 seed 恒得同一 UUID。 */
export function uuidOf(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-` +
    `${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 会话 ID：调用方给的是 UUID 就用，否则由它派生，保证同一会话稳定。 */
export function sessionOf(id, device) {
  const own = typeof id === 'string' ? id.trim() : '';
  if (UUID_RE.test(own)) return own.toLowerCase();
  return uuidOf(own ? 'zcode-session\0' + own : 'zcode-session-device\0' + (device ?? ''));
}

/* ── 凭据目录 / 文件发现（无任何硬编码路径） ──────────────────────────────── */

/**
 * ZCode 数据根目录。规则来自客户端自身的 dataIn()：
 *   setting.json 的 dataBaseDir（绝对路径才认）→ ZCODE_HOME → homedir
 */
export function zcodeDataBase() {
  const candidates = [];
  const home = os.homedir();
  // setting.json 位于 <dataBase>/.zcode/v2/setting.json，先在默认位置找
  candidates.push(path.join(home, '.zcode', 'v2', 'setting.json'));
  if (process.env.ZCODE_HOME) candidates.push(path.join(process.env.ZCODE_HOME, '.zcode', 'v2', 'setting.json'));

  for (const settingFile of candidates) {
    try {
      const s = JSON.parse(fs.readFileSync(settingFile, 'utf8'));
      const d = typeof s.dataBaseDir === 'string' ? s.dataBaseDir.trim() : '';
      if (d && path.isAbsolute(d)) return d;
    } catch { /* 读不到就试下一个 */ }
  }
  if (process.env.ZCODE_HOME && process.env.ZCODE_HOME.trim()) {
    const z = process.env.ZCODE_HOME.trim();
    if (path.isAbsolute(z)) return z;
  }
  return home;
}

/** 凭据文件绝对路径：<dataBase>/.zcode/v2/credentials.json */
export function zcodeCredentialsFile() {
  return path.join(zcodeDataBase(), '.zcode', 'v2', 'credentials.json');
}

/** 凭据管理器条目的 account 名 = sha256(凭据文件绝对路径).hex（客户端源码实证）。 */
export function keyringAccountFor(credFile) {
  return crypto.createHash('sha256').update(path.resolve(credFile)).digest('hex');
}

/* ── ZCode 安装目录发现（注册表 / 常见路径 / 环境变量） ─────────────────────── */

/**
 * 找 ZCode 安装目录。优先级：
 *   1. ZCODE_INSTALL_DIR 环境变量
 *   2. Windows 注册表 Uninstall 项的 InstallLocation / DisplayIcon
 *   3. 常见安装路径
 * 找不到返回 null（调用方回退到默认版本号）。
 */
export function findZcodeInstallDir() {
  const roots = [];
  if (process.env.ZCODE_INSTALL_DIR) roots.push(process.env.ZCODE_INSTALL_DIR);

  if (process.platform === 'win32') {
    try {
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        "$keys = @(",
        "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
        "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
        "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
        ")",
        "Get-ItemProperty $keys | Where-Object { $_.DisplayName -like '*ZCode*' } | ForEach-Object {",
        "if ($_.InstallLocation) { $_.InstallLocation }",
        "if ($_.DisplayIcon) { [System.IO.Path]::GetDirectoryName($_.DisplayIcon) }",
        "}",
      ].join('\n');
      // 让 PowerShell 自己以 UTF-8 输出：Node 不支持 gbk 编码，
      // 直接用默认 ANSI 输出会把中文安装路径解成乱码，导致目录探测失败。
      const psUtf8 = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n" + ps;
      const raw = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psUtf8,
      ], { timeout: 20_000, windowsHide: true, encoding: 'utf8' });
      for (const line of String(raw).split(/\r?\n/)) {
        const t = line.trim().replace(/^"|"$/g, '');
        if (t) roots.push(t);
      }
    } catch { /* 注册表读不到就靠常见路径 */ }
  }

  const home = os.homedir();
  roots.push(
    path.join(home, 'AppData', 'Local', 'Programs', 'ZCode'),
    path.join(home, 'AppData', 'Local', 'ZCode'),
    path.join(home, 'Applications', 'ZCode.app'),
    '/Applications/ZCode.app',
    'C:\\Program Files\\ZCode',
    'C:\\Program Files (x86)\\ZCode',
  );

  const seen = new Set();
  for (const r of roots) {
    if (!r) continue;
    const key = r.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.existsSync(r) && fs.statSync(r).isDirectory()) return r;
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 找 ZCode 自带的 @napi-rs/keyring 原生模块（ZCode 装了才有）。 */
export function findKeyringModule() {
  const rels = [
    'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node',
    'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-win32-arm64-msvc/keyring.win32-arm64-msvc.node',
    'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node',
    'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node',
    'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-linux-x64-gnu/keyring.linux-x64-gnu.node',
    'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-linux-x64-musl/keyring.linux-x64-musl.node',
  ];
  const roots = [];
  const install = findZcodeInstallDir();
  if (install) roots.push(install);
  roots.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode'));

  for (const r of roots) {
    for (const rel of rels) {
      const p = path.join(r, rel);
      try { if (fs.existsSync(p)) return p; } catch { /* 忽略 */ }
    }
  }
  return null;
}

/**
 * 读主密钥（32 字节）候选列表。
 * 首选 ZCode 自带的 keyring 原生模块（account = sha256(凭据路径)）；
 * 回退到 Win32 凭据枚举（CredEnumerate flag=1，需管理员）。
 */
export async function readMasterKeyCandidates(credFile = zcodeCredentialsFile()) {
  const keys = [];
  const push = (buf) => { if (buf && buf.length === 32 && !keys.some(k => k.equals(buf))) keys.push(buf); };

  // ① 原生 keyring 模块
  const modPath = findKeyringModule();
  if (modPath) {
    try {
      const keyring = require(modPath);
      const AsyncEntry = keyring.AsyncEntry || keyring.Entry;
      const account = keyringAccountFor(credFile);
      const entry = new AsyncEntry(KEYRING_SVC, account);
      const pw = await entry.getPassword();
      if (pw) push(Buffer.from(pw, 'base64url'));
    } catch { /* 模块不可用，走回退 */ }
  }

  // ② Win32 凭据枚举（需要管理员权限）
  if (!keys.length) {
    try {
      const script = [
        "$src = @'",
        'using System; using System.Runtime.InteropServices;',
        'public class ZCredEnum {',
        '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
        '  public struct CREDENTIAL {',
        '    public int Flags; public int Type; public string TargetName; public string Comment;',
        '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
        '    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;',
        '    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
        '  }',
        '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
        '  public static extern bool CredEnumerate(string filter, int flag, out IntPtr creds, out int count);',
        '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
        '  public static string List(string needle) {',
        '    IntPtr pCreds; int count;',
        '    if (!CredEnumerate(null, 1, out pCreds, out count)) return "";',
        '    var hits = new System.Collections.Generic.List<string>();',
        '    for (int i = 0; i < count; i++) {',
        '      IntPtr p = Marshal.ReadIntPtr(pCreds, i * IntPtr.Size);',
        '      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));',
        '      if (c.TargetName == null) continue;',
        '      if (c.TargetName.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;',
        '      if (c.CredentialBlobSize != 32 || c.CredentialBlob == IntPtr.Zero) continue;',
        '      byte[] blob = new byte[c.CredentialBlobSize];',
        '      Marshal.Copy(c.CredentialBlob, blob, 0, c.CredentialBlobSize);',
        '      hits.Add(Convert.ToBase64String(blob));',
        '    }',
        '    CredFree(pCreds);',
        '    return string.Join(";", hits.ToArray());',
        '  }',
        '}',
        "'@",
        'Add-Type -TypeDefinition $src',
        '[ZCredEnum]::List($args[0])',
      ].join('\n');
      const encoded = Buffer.from(
        script.replace('$args[0]', "'" + KEYRING_SVC.replace(/'/g, "''") + "'"),
        'utf16le'
      ).toString('base64');
      const raw = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
      ], { timeout: 20_000, windowsHide: true, encoding: 'utf8' });
      for (const m of String(raw).match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []) {
        try { push(Buffer.from(m, 'base64')); } catch { /* 跳过 */ }
      }
    } catch { /* 无权限或不可用 */ }
  }

  return keys;
}

/**
 * 解密一个 enc:v2:os: 值；非加密值原样返回。
 *
 * 格式（ZCode 3.17+）：enc:v2:os:<24位指纹>:<iv>.<tag>.<密文>，全部 base64url
 * 指纹段之后还有一个冒号——载荷在 **最后一段**，不是索引 2。
 * 指纹 = sha256(主密钥).hex 前 24 位，可用于校验主密钥是否正确。
 */
export function decryptValue(v, key) {
  if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) return v;
  const parts = v.slice(ENC_PREFIX.length).split(':');
  const blob = parts[parts.length - 1];
  if (!blob) throw new Error('密文格式异常');
  const [iv, tag, data] = blob.split('.').map(x => Buffer.from(x, 'base64url'));
  if (!iv?.length || !tag?.length || !data?.length) throw new Error('密文分段异常');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** 主密钥指纹（与凭据文件里的 24 位指纹一致即说明密钥正确）。 */
export function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

/* ── 登录态（带缓存） ─────────────────────────────────────────────────────── */

let loginCache = null;   // { jwt, userId, email, device, at }
let masterKeyCache = null;

/**
 * 用候选主密钥试着解 zcodejwttoken；
 * 优先用「指纹自校验」——凭据文件里自带主密钥指纹，能直接判定密钥对不对。
 */
function tryDecryptJwt(store, key) {
  const raw = store.zcodejwttoken ?? '';
  if (typeof raw === 'string' && raw.startsWith(ENC_PREFIX)) {
    // 切掉 'enc:v2:os:' 后是 "<24位指纹>:<载荷>"，按 ':' 切两段
    const fp = raw.slice(ENC_PREFIX.length).split(':')[0];
    if (fp && keyFingerprint(key) !== fp) return null;   // 指纹不符，这把钥匙不是这台机器的
  }
  try {
    const dec = decryptValue(raw, key);
    const jwt = String(dec ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt || jwt.split('.').length !== 3) return null;
    return jwt;
  } catch { return null; }
}

/** 读取并解密本机 ZCode 登录态。 */
export async function readZcodeLogin({ force = false } = {}) {
  if (!force && loginCache && Date.now() - loginCache.at < 30_000) return loginCache;
  const credFile = zcodeCredentialsFile();
  if (!fs.existsSync(credFile)) {
    throw new Error('ZCode 未登录：本机找不到 ' + credFile + '（请先安装并登录 ZCode 客户端）');
  }

  const store = JSON.parse(fs.readFileSync(credFile, 'utf8'));

  // 候选主密钥：先试缓存，再问凭据管理器
  const candidates = [];
  if (masterKeyCache) candidates.push(masterKeyCache);
  for (const k of await readMasterKeyCandidates(credFile)) candidates.push(k);

  let jwt = null, usedKey = null;
  for (const key of candidates) {
    jwt = tryDecryptJwt(store, key);
    if (jwt) { usedKey = key; break; }
  }
  if (!jwt) {
    throw new Error(
      '读不到 ZCode 登录态：凭据管理器里没找到可用的主密钥' +
      '（服务 ' + KEYRING_SVC + '）。请确认 ZCode 客户端已登录且本账号可读该条目。'
    );
  }
  masterKeyCache = usedKey;

  let userId = '', email = '';
  // 单个字段解密失败不该拖垮整个登录态读取（坏字段只少一条信息，不影响 token）
  const safeDecrypt = (v) => { try { return String(decryptValue(v ?? '', usedKey) ?? '').trim(); } catch { return ''; } };
  const active = safeDecrypt(store['oauth:active_provider']);
  const families = [...new Set([active, 'zai', 'zai_cn', 'bigmodel'].filter(Boolean))];
  for (const fam of families) {
    const raw = safeDecrypt(store[`oauth:${fam}:user_info`]);
    if (!raw) continue;
    try {
      const info = JSON.parse(raw);
      userId = String(info.user_id ?? info.id ?? '');
      email = String(info.email ?? '');
      if (userId) break;
    } catch { /* 跳过坏的 user_info */ }
  }
  // 设备 ID 由登录态派生：同一账号同一台机器恒定，换号即变
  const device = uuidOf('zcode-device\0' + jwt);
  loginCache = { jwt, userId, email, device, at: Date.now() };
  return loginCache;
}

/** 清掉登录态缓存（凭据变化 / 换号后调用）。 */
export function invalidateLoginCache() { loginCache = null; }

/** JWT 是否已过期（payload.exp 与当前时间比较）。 */
export function jwtExpired(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number') return false;
    return Date.now() / 1000 >= payload.exp;
  } catch { return false; }
}

/* ── app_version 探测 ─────────────────────────────────────────────────────── */

let appVersionCache = null;   // { value, at }
const APP_TTL = 10 * 60 * 1000;

/** 探测本机 ZCode 版本；失败回退到 DEFAULT_APP_VERSION。 */
export function zcodeAppVersion({ force = false } = {}) {
  if (!force && appVersionCache && Date.now() - appVersionCache.at < APP_TTL) return appVersionCache.value;
  let value = DEFAULT_APP_VERSION;
  try {
    const exe = findZcodeExe();
    if (exe) {
      // 同上：强制 UTF-8 输出，避免中文安装路径在默认 ANSI 编码下被解成乱码
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
      ], { timeout: 15_000, windowsHide: true, encoding: 'utf8' }).trim();
      if (/^\d+\.\d+\.\d+/.test(out)) value = out.split('.').slice(0, 3).join('.');
    }
  } catch { /* 探测失败就用回退值 */ }
  // 风控要求 >= 3.17.2
  const [a, b] = value.split('.').map(Number);
  const [ma, mb] = MIN_APP_VERSION.split('.').map(Number);
  if (a < ma || (a === ma && b < mb)) value = DEFAULT_APP_VERSION;
  appVersionCache = { value, at: Date.now() };
  return value;
}

function findZcodeExe() {
  const cands = [];
  const install = findZcodeInstallDir();
  if (install) {
    cands.push(path.join(install, 'ZCode.exe'));
    cands.push(path.join(install, 'Contents', 'MacOS', 'ZCode'));
    cands.push(path.join(install, 'zcode'));
  }
  cands.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode', 'ZCode.exe'));
  return cands.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/* ── body 改写（dress） ───────────────────────────────────────────────────── */

const cached = (t) => ({ type: 'text', text: t, cache_control: { type: 'ephemeral' } });

function today() {
  const n = new Date(), p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

function osVersion() {
  return `${process.platform} ${os.release()} ${process.arch}`;
}

/** 环境段（与 ZCode 客户端一致）。 */
function environmentBlock() {
  const e = PROMPT.environment;
  const lines = [e.heading, e.invokedLine];
  lines.push(` - ${e.platformLabel}: ${process.platform}`);
  lines.push(` - ${e.osVersionLabel}: ${osVersion()}`);
  lines.push(` - ${e.untrustedNote}`);
  return lines.join('\n');
}

/** 上下文前缀（第一条 user turn）。 */
function contextPrefix() {
  const c = PROMPT.context;
  return {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>' + c.currentDateLine.replace('{date}', today()) + '</system-reminder>' }],
  };
}

/**
 * 把请求体改写成 ZCode 客户端的形态：
 *   - 恰好三段 cached system block（多一段会被 405/3012 拒）
 *   - 调用方自己的 system 文本并入第三段尾部
 *   - messages 前插上下文前缀
 *   - cache 标记只留在最后一条消息的最后一个 block 上，tools 上全删
 *   - metadata.user_id 命名设备
 */
export function dressBody(text, { model = '', site = 'zai', device = '', session = '' } = {}) {
  if (typeof text !== 'string' || !text.includes('messages')) return text;
  let b;
  try { b = JSON.parse(text); } catch { return text; }
  if (!b || typeof b !== 'object' || !Array.isArray(b.messages)) return text;

  const provider = site === 'bigmodel' ? 'bigmodel-api' : 'zai-api';

  const own = [];
  if (typeof b.system === 'string') {
    if (b.system.trim()) own.push(b.system);
  } else if (Array.isArray(b.system)) {
    for (const x of b.system) {
      if (x?.type === 'text' && typeof x.text === 'string' && x.text.trim()) own.push(x.text);
    }
  }

  const hasSkill = Array.isArray(b.tools) && b.tools.some(t => t && typeof t === 'object' && t.name === 'Skill');
  const dynamic = [
    PROMPT.dynamicBehavior,
    ...(hasSkill ? [PROMPT.sessionGuidance] : []),
    environmentBlock(),
    ...(model ? [PROMPT.poweredBy.replace('{provider}', provider).replace('{model}', model)] : []),
    PROMPT.contextManagement,
    ...own,
  ];

  b.system = [
    cached(PROMPT.cliPrefix),
    cached(PROMPT.stableSections.join('\n\n')),
    cached('\n\n' + dynamic.join('\n\n')),
  ];
  b.messages = [contextPrefix(), ...b.messages];

  let last = null;
  for (const m of b.messages) {
    if (!m || m.role === 'system') continue;
    last = m;
    if (Array.isArray(m.content)) {
      for (const x of m.content) if (x && typeof x === 'object') delete x.cache_control;
    }
  }
  if (last && typeof last.content === 'string') {
    last.content = [cached(last.content)];
  } else if (last && Array.isArray(last.content) && last.content.length) {
    const x = last.content[last.content.length - 1];
    if (x && typeof x === 'object' && !x.cache_control) x.cache_control = { type: 'ephemeral' };
  }
  if (Array.isArray(b.tools)) {
    for (const t of b.tools) if (t && typeof t === 'object') delete t.cache_control;
  }

  const meta = b.metadata && typeof b.metadata === 'object' ? b.metadata : {};
  b.metadata = {
    ...meta,
    user_id: JSON.stringify({ device_id: device, account_uuid: '', session_id: session }),
  };
  return JSON.stringify(b);
}

/** 请求头（ZCode 客户端指纹全套）。 */
export function giftHeaders({ jwt, device, session, appVersion }) {
  const h = {
    'content-type': 'application/json',
    'Authorization': 'Bearer ' + jwt,
    'anthropic-version': '2023-06-01',
    'HTTP-Referer': ZCODE_GIFT_ORIGIN,
    'User-Agent': 'ZCode/' + appVersion + ' ai-sdk/anthropic/3.0.81',
    'X-ZCode-App-Version': appVersion,
    'X-Title': 'Z Code@electron',
    'X-Release-Channel': 'production',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-ZCode-Agent': 'glm',
    'X-Platform': `${process.platform}-${process.arch}`,
    'X-Os-Category': process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    'X-Os-Version': os.release(),
    'x-request-id': crypto.randomUUID(),
    'x-zcode-session-type': 'main',
    'x-zcode-trace-id': crypto.randomUUID(),
    'x-zcode-query-source': 'main_turn',
    'X-Device-Mid': device,
  };
  if (session) h['x-session-id'] = session;
  return h;
}

/* ── 并发槽位（防 3008） ─────────────────────────────────────────────────── */

const slots = new Map();          // key -> 占用数
const MAX_PER_ACCOUNT = 2;
const MAX_GLOBAL = 3;
const ACQUIRE_TIMEOUT_MS = 120_000;

/**
 * 取一个并发槽位。超限则轮询等待。
 * 等待必须有上限：否则上游长时间不返回时，等待者会永久挂住，
 * 表现为"请求一直不返回"，比报错更难排查。
 */
async function acquire(key, startedAt = Date.now()) {
  const state = { per: slots.get(key) ?? 0, global: 0 };
  for (const s of slots.values()) state.global += s;
  if (state.per >= MAX_PER_ACCOUNT || state.global >= MAX_GLOBAL) {
    if (Date.now() - startedAt > ACQUIRE_TIMEOUT_MS) {
      throw new Error(
        'ZCode 并发槽位等待超时（' + Math.round(ACQUIRE_TIMEOUT_MS / 1000) + 's）：' +
        '上游槽位未释放，请稍后重试或降低并发'
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    return acquire(key, startedAt);
  }
  slots.set(key, state.per + 1);
  return () => { const n = (slots.get(key) ?? 1) - 1; if (n <= 0) slots.delete(key); else slots.set(key, n); };
}

/* ── 主调用 ───────────────────────────────────────────────────────────────── */

/**
 * 免 key 上游请求。
 * @param {object} req  { model, max_tokens, messages, system, tools, stream, sessionId }
 * @returns {Promise<{res: Response, body: string}>}
 */
/** 3008（并发超限）退避重试：本地槽位是进程内的，挡不住别的客户端（magpie / 另一个控制台实例）
 *  同时占用同一账号的槽位，所以服务端拒绝必须靠退避重试自愈，而不是直接失败。 */
const MAX_3008_RETRY = 3;
const RETRY_BASE_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function giftFetch(req = {}) {
  const login = await readZcodeLogin();
  if (jwtExpired(login.jwt)) {
    invalidateLoginCache();
    throw new Error("ZCode 的登录已过期，请在 ZCode 客户端重新登录后重试");
  }
  const appVersion = zcodeAppVersion();
  const device = login.device;
  const session = sessionOf(req.sessionId ?? '', device);

  const raw = JSON.stringify({
    model: req.model ?? 'GLM-5.3-Flash',
    max_tokens: req.max_tokens ?? 4096,
    messages: req.messages ?? [],
    ...(req.system !== undefined ? { system: req.system } : {}),
    ...(req.tools !== undefined ? { tools: req.tools } : {}),
    ...(req.stream ? { stream: true } : {}),
  });
  const body = dressBody(raw, { model: req.model ?? '', device, session });

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_3008_RETRY; attempt++) {
    const release = await acquire(login.userId || 'zcode');
    // 幂等释放：槽位只放一次，多路径调用 releaseOnce 安全
    let released = false;
    const releaseOnce = () => { if (released) return; released = true; release(); };
    // 是否已把槽位移交给调用方（流式：槽位要活到流结束）
    let handedOff = false;
    try {
      const res = await fetch(GIFT_BASE + '/v1/messages', {
        method: 'POST',
        headers: giftHeaders({ jwt: login.jwt, device, session, appVersion }),
        body,
        signal: buildSignal(req),
      });
      // 状态码检查必须在 raw 分支之前：
      // 否则流式模式会把 3008/405 的错误响应当正常流透传出去，调用方无从察觉。
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let envelope = null;
        try { envelope = JSON.parse(text); } catch { /* 非 JSON */ }
        const code = envelope?.code;
        const msg = envelope?.msg || envelope?.error?.message || text.slice(0, 200);
        if (res.status === 429 || code === 3008) {
          lastErr = new Error(
            'ZCode 并发超限（3008）：已退避重试 ' + attempt + '/' + MAX_3008_RETRY +
            ' 次仍被拒。该账号的并发槽位可能被其它客户端占用，请降低并发或稍后重试'
          );
          if (attempt < MAX_3008_RETRY) {
            await sleep(RETRY_BASE_MS * Math.pow(2, attempt));   // 1s → 2s → 4s
            continue;                                          // finally 会释放槽位后重入
          }
          throw lastErr;
        }
        if (res.status === 405 || code === 3012) {
          throw new Error(
            'ZCode 客户端指纹被拒（405/3012）：app_version=' + appVersion +
            '，请检查 dress() 的 system 三段是否字节一致、客户端头是否齐全'
          );
        }
        throw new Error('ZCode 上游错误 ' + res.status + (code ? ' code ' + code : '') + '：' + msg);
      }
      if (req.raw) {
        // 流式透传模式——res.body 由调用方消费，槽位由调用方在流结束时 releaseOnce() 释放。
        // 注意：这里必须把手移交出去，否则 finally 会提前放掉槽位（并发失控），
        // 而调用方再放一次又会二次释放（计数变负 → 槽位被删除 → 并发闸门失效）。
        handedOff = true;
        return { res, release: releaseOnce };
      }
      const text = await res.text();
      return { res, body: text };
    } finally {
      // 只有"没交出去"的路径才在这里释放：正常非流式、fetch 抛错、3008 退避重入、流式移交前的异常
      if (!handedOff) releaseOnce();
    }
  }
  throw lastErr || new Error('ZCode 上游请求失败');
}

/**
 * 组装请求取消信号：外部 signal + 可选超时。
 * 流式场景由调用方（upstream）自己管首字节超时，这里只在传了 timeoutMs 时叠加。
 */
function buildSignal(req) {
  const ext = req.signal;
  const ms = Number(req.timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return ext || undefined;
  const t = AbortSignal.timeout(ms);
  if (!ext) return t;
  return (typeof AbortSignal.any === 'function') ? AbortSignal.any([ext, t]) : t;
}

/** 读取免费套餐额度（余额）。返回 { plans, balances }，不含任何 token。 */
export async function giftBalance({ force = false } = {}) {
  const login = await readZcodeLogin({ force });
  const appVersion = zcodeAppVersion();
  const res = await fetch(BALANCE_URL + '?app_version=' + appVersion, {
    headers: {
      Authorization: 'Bearer ' + login.jwt,
      'X-Device-Mid': login.device,
      'X-ZCode-App-Version': appVersion,
      'User-Agent': 'ZCode/' + appVersion,
      'content-type': 'application/json',
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('读取 ZCode 额度失败 ' + res.status + '：' + text.slice(0, 200));
  const json = JSON.parse(text);
  const data = json.data ?? {};
  return {
    serverTime: data.server_time ?? null,
    plans: (data.plans ?? []).map(p => ({
      planId: p.plan_id, userPlanId: p.user_plan_id, name: p.name,
      status: p.status, startsAt: p.starts_at, endsAt: p.ends_at,
    })),
    balances: (data.balances ?? []).map(b => ({
      bucketId: b.bucket_id, planId: b.plan_id, entitlementId: b.entitlement_id,
      name: b.show_name, capabilities: b.capabilities ?? [],
      total: b.total_units, used: b.used_units, remaining: b.remaining_units,
      available: b.available_units, expiresAt: b.expires_at,
    })),
  };
}

/** 当前登录账号信息（给控制台显示用；不含 token）。 */
export async function currentAccount() {
  const login = await readZcodeLogin();
  return { userId: login.userId, email: login.email, device: login.device };
}
