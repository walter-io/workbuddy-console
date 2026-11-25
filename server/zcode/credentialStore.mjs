/**
 * ZCode 凭据存取（只读 + 受控写入）。
 *
 * ZCode 桌面端把登录态放在 ~/.zcode/v2/credentials.json，值为两种格式：
 *   enc:v1:<iv.b64url>.<tag.b64url>.<cipher.b64url>   （ZCode 4.x 实际在用，密钥派生自平台/主目录/用户名）
 *   enc:v2:os:<24位指纹>:<iv b64url>.<tag b64url>.<cipher b64url>
 * 密钥是 32 字节随机数，base64url 后存进 Windows 凭据管理器：
 *   条目名 = "<sha256(credentials.json绝对路径)hex>.ZCode Credential Encryption"
 *   blob = 43 字符 base64url（UTF-16LE 存储），即密钥本体。
 * 算法 aes-256-gcm（实现在 ZCode asar 的 seal/open 函数）。
 *
 * 本模块只做三件事：读密钥、解 credentials.json、加密写回（切换账号用）。
 * 与 ZCode 自身的格式保持逐字节兼容——写回的文件 ZCode 必须能原样解开。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ENC_PREFIX = 'enc:v2:os:';
/** ZCode 4.x 实际写入的格式：enc:v1:<iv>.<tag>.<cipher>（密钥不进凭据管理器，由平台/主目录/用户名派生） */
const V1_PREFIX = 'enc:v1:';
const CRED_FILE = path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');

/** credentials.json 的绝对路径 → 凭据管理器条目的 user 名 */
export function keyringUserFor(filePath = CRED_FILE) {
  return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex');
}

function credmanReadBlob(user) {
  return new Promise((resolve) => {
    const script = [
      "$src = @'",
      'using System; using System.Runtime.InteropServices;',
      'public class ZCredR {',
      '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
      '  public struct CREDENTIAL {',
      '    public int Flags; public int Type; public string TargetName; public string Comment;',
      '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
      '    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;',
      '    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
      '  }',
      '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
      '  public static extern bool CredRead(string target, int type, int flag, out IntPtr cred);',
      '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
      '  public static extern void CredFree(IntPtr cred);',
      '  public static string Read(string target) {',
      '    IntPtr cp;',
      '    if (!CredRead(target, 1, 0, out cp)) return "FAIL " + Marshal.GetLastWin32Error();',
      '    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(cp, typeof(CREDENTIAL));',
      '    byte[] blob = new byte[c.CredentialBlobSize];',
      '    Marshal.Copy(c.CredentialBlob, blob, 0, c.CredentialBlobSize);',
      '    CredFree(cp);',
      '    return Convert.ToBase64String(blob);',
      '  }',
      '}',
      "'@",
      'Add-Type -TypeDefinition $src',
      '[ZCredR]::Read($args[0])',
    ].join('\n');
    // -Command 模式会把后续参数拼进同一行脚本（踩过：$args[0] 后直接跟了 user 文本）。
    // 改用 -EncodedCommand（UTF-16LE base64），user 内嵌进脚本，彻底绕开引号/换行问题。
    const encoded = Buffer.from(script.replace('$args[0]', "'" + user.replace(/'/g, "''") + "'"), 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const out = String(stdout || '').trim();
        resolve(out.startsWith('FAIL') || !out ? null : out);
      }
    );
  });
}

let keyCache = null; // { key: Buffer, at: ms }

/** 读解密密钥（32B）。进程内缓存 5 分钟；失败返回 null（上层给可操作提示）。 */
export async function loadKey() {
  if (keyCache && Date.now() - keyCache.at < 5 * 60_000) return keyCache.key;
  const user = keyringUserFor();
  const blob = await credmanReadBlob(user + '.ZCode Credential Encryption');
  if (!blob) return null;
  let key;
  try {
    const password = Buffer.from(blob, 'base64').toString('utf16le').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(password)) return null;
    key = Buffer.from(password, 'base64url');
  } catch {
    return null;
  }
  if (key.length !== 32) return null;
  keyCache = { key, at: Date.now() };
  return key;
}

/**
 * ZCode 4.x 的 enc:v1 密钥派生（对齐 ZCode asar 的 legacyKeyCandidates）：
 *   sha256(`zcode-credential-fallback:${platform}:${homedir}:${username}`)
 * 若用户显式配了 ZCODE_CREDENTIAL_SECRET，ZCode 会优先用它；这里保持同样优先级。
 */
let v1KeysCache = null;
function getV1Keys() {
  if (!v1KeysCache) {
    const managed = String(process.env.ZCODE_CREDENTIAL_SECRET || '').trim();
    let username = 'unknown';
    try { username = os.userInfo().username; } catch { /* 取不到用户名时用占位 */ }
    // 关键：ZCode 用原生 os.homedir()（Windows 是 C:\Users\xxx）；若控制台从 Git Bash 启动，
    // USERPROFILE 可能变成 C:/Users/xxx，直接拿来派生会得到完全不同的密钥。统一 resolve 成原生形式。
    const home = path.resolve(os.homedir());
    const fallback = `zcode-credential-fallback:${process.platform}:${home}:${username}`;
    const seeds = managed ? [managed, fallback] : [fallback];
    v1KeysCache = seeds.map((seed) => crypto.createHash('sha256').update(seed).digest());
  }
  return v1KeysCache;
}

/** 解单条 enc:v1: 值 → UTF-8 明文（失败抛错） */
export function openValueV1(body, key) {
  const [ivB, tagB, ctB] = body.split('.');
  if (!ivB || !tagB || !ctB || !/^[A-Za-z0-9_-]*$/.test(ivB + tagB + ctB)) throw new Error('credential body malformed');
  const iv = Buffer.from(ivB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const ct = Buffer.from(ctB, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('credential iv/tag length invalid');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** 加密为 enc:v1: 值（与 ZCode 4.x seal() 同构：iv.tag.ct 三段 base64url，无指纹前缀） */
export function sealValueV1(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return V1_PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

/** 解单条 enc:v2:os: 值 → UTF-8 明文（失败抛错） */
export function openValue(body, key) {
  const parts = body.split(':'); // [fingerprint(24hex), iv.tag.ct]
  if (parts.length !== 2 || !/^[0-9a-f]{24}$/.test(parts[0])) throw new Error('credential body malformed');
  const [ivB, tagB, ctB] = parts[1].split('.');
  const iv = Buffer.from(ivB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const ct = Buffer.from(ctB, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('credential iv/tag length invalid');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** 加密为 enc:v2:os: 值（与 ZCode seal() 同构：iv.tag.ct 三段 base64url + 指纹前缀） */
export function sealValue(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  return ENC_PREFIX + fp + ':' + [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
}

/** 读整份 credentials.json → { values: 明文map, raw: 原始对象 }；明文条目原样返回 */
export async function readCredentialsDecrypted(filePath = CRED_FILE) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const values = Object.values(raw);
  const needV2 = values.some((v) => typeof v === 'string' && v.startsWith(ENC_PREFIX));
  const needV1 = values.some((v) => typeof v === 'string' && v.startsWith(V1_PREFIX));
  let v2Key = null;
  if (needV2) {
    v2Key = await loadKey();
    if (!v2Key) throw new Error('无法从 Windows 凭据管理器读取 ZCode 密钥（ZCode 是否登录过？）');
  }
  const v1Keys = needV1 ? getV1Keys() : [];
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') {
      out[k] = v;
    } else if (v.startsWith(ENC_PREFIX)) {
      try {
        out[k] = openValue(v.slice(ENC_PREFIX.length), v2Key);
      } catch {
        out[k] = null; // 单条失败不拖垮整份
      }
    } else if (v.startsWith(V1_PREFIX)) {
      let plain = null;
      for (const key of v1Keys) {
        try {
          plain = openValueV1(v.slice(V1_PREFIX.length), key);
          break;
        } catch { /* 换下一个候选密钥 */ }
      }
      out[k] = plain;
    } else {
      out[k] = v;
    }
  }
  return { values: out, raw, key: v2Key || v1Keys[0] || null };
}

/** 把明文 map 写回 credentials.json（加密条目自动重新加密；原子写 + 备份） */
export async function writeCredentialsFromMap(map, filePath = CRED_FILE) {
  // 审查 R004-4：写回必须用**当前**密钥——loadKey 有 5 分钟缓存，用户若刚在 ZCode 里重新登录
  //（密钥轮换），用旧 key 加密写回会让 ZCode 解不开。绕过缓存现读一次。
  keyCache = null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const needV2 = Object.values(raw).some((v) => typeof v === 'string' && v.startsWith(ENC_PREFIX));
  const v2Key = needV2 ? await loadKey() : null;
  if (needV2 && !v2Key) throw new Error('无法读取 ZCode 密钥，拒绝写回（避免写坏登录态）');
  const v1Key = getV1Keys()[0];
  const next = {};
  for (const k of Object.keys(raw)) {
    const v = map[k];
    if (v === undefined) {
      next[k] = raw[k]; // 没给的就保留原值
    } else if (v === null) {
      continue; // null = 删除该条目
    } else if (typeof raw[k] === 'string' && raw[k].startsWith(ENC_PREFIX)) {
      next[k] = sealValue(v, v2Key);
    } else if (typeof raw[k] === 'string' && raw[k].startsWith(V1_PREFIX)) {
      next[k] = sealValueV1(v, v1Key); // 保持 ZCode 4.x 的 v1 格式，客户端才解得开
    } else {
      next[k] = v; // 非加密条目按明文写
    }
  }
  const bak = filePath + '.console-bak';
  try {
    fs.copyFileSync(filePath, bak);
  } catch {
    /* 备份失败不阻塞 */
  }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  return { ok: true, backup: bak };
}
