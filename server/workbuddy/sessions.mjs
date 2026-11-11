/**
 * 完整版归一化分块比对：分块读两文件，各自把「自己 id」替换成占位符后逐块比对，
 * 返回**真实**的归一化公共前缀长度（不截断）。1MB 封顶的短版会在源/目标都很大的
 * 场景下把分叉点错误地截在 1MB，导致把几百 MB 的重复内容当「新增」整段追加
 * （2026-10-21 服务卡死实录）。等长替换不改长度，块偏移天然对齐。
 */
function findNormCommonPrefixFull(aPath, aId, bPath, bId) {
  const CHUNK = 64 * 1024 * 1024;
  const OV = aId.length - 1;
  // 两个 fd 都在 try 内取得：第二个 open 或 fstat 抛错时第一个不能泄漏（L15）
  let fa = null;
  let fb = null;
  try {
    fa = fs.openSync(aPath, 'r');
    fb = fs.openSync(bPath, 'r');
    const sizeA = fs.fstatSync(fa).size;
    const sizeB = fs.fstatSync(fb).size;
    const limit = Math.min(sizeA, sizeB);
    const ba = Buffer.alloc(CHUNK + OV + 1);
    const bb = Buffer.alloc(CHUNK + OV + 1);
    const pa = Buffer.from(aId);
    const pb = Buffer.from(bId);
    const ph = Buffer.alloc(aId.length, 0x58);
    let off = 0;
    while (off < limit) {
      const n = Math.min(CHUNK + OV, limit - off);
      fs.readSync(fa, ba, 0, n, off);
      fs.readSync(fb, bb, 0, n, off);
      // 各自归一化（块内完整替换，OV 保证跨界 id 完整）
      let base = 0;
      while (base + pa.length <= n) { const i = ba.indexOf(pa, base); if (i === -1) break; ph.copy(ba, i); base = i + pa.length; }
      base = 0;
      while (base + pb.length <= n) { const i = bb.indexOf(pb, base); if (i === -1) break; ph.copy(bb, i); base = i + pb.length; }
      // 比对有效区（去掉尾部 OV 防跨界 id 的部分）
      const valid = Math.min(n, limit - off);
      const cmp = Math.min(valid, n - (off + n < limit ? OV : 0));
      for (let i = 0; i < cmp; i++) {
        if (ba[i] !== bb[i]) return { prefix: off + i };
      }
      off += cmp;
      if (valid <= cmp) break;
    }
    return { prefix: limit };
  } finally {
    if (fa !== null) fs.closeSync(fa);
    if (fb !== null) fs.closeSync(fb);
  }
}

/**
 * WorkBuddy 会话（对话记录）的读取，以及「把会话复制给另一个账号」。
 *
 * ── 为什么复制能生效（读参考实现 workbuddy-switch 的 session.rs 得出，别再重查）──
 * 会话是「三件套」，缺一不可：
 *   1) 正文    `<数据根>/projects/<工作区>/<会话id>.jsonl`（每行一条 JSON，行内有 `sessionId`）
 *   2) 元数据  `<数据根>/workbuddy.db` 的 `sessions` 表（`user_id NOT NULL`，会话按账号归属）
 *   3) 云端归属 `<数据根>/edge-sync-mapping-v*.db` 的 `session_id → conversation_id` 映射
 * 复制 = 生成新 UUID → 正文里把旧会话 id **全量替换**成新 id → 在 `sessions` 表插一行、
 * `user_id` 写成目标账号。源账号数据一个字不动（新 UUID 与源会话不共享任何 id）。
 *
 * **故意不写第 3 项**：预写映射会让客户端的 edge-sync 判定「已迁移」而跳过上传，
 * 结果云端根本没有这条会话，客户端之后对它的改名/活跃度上报会全部 404。
 * 副本交给客户端下次启动时自行登记（参考实现的注释写得很明确）。
 *
 * ── 安全约束 ──
 * - 写 `sessions` 表要求 WorkBuddy **完全退出**：运行中的实例看不到我们的写入，
 *   继续对话会让副本与源会话状态分叉。账号切换本来就要求退出，所以不额外增加负担。
 * - 先备份 `workbuddy.db`(+`-wal`/`-shm`) 再写；单个会话失败只回滚该会话
 *   （删掉刚写的正文、刚插入的行），不影响已经复制成功的其他会话。
 * - 写后回读校验：正文不得残留旧 id、行内 `sessionId` 必须全是新 id、
 *   库里的行必须存在且 `user_id`/`deleted_at` 正确，否则按失败处理并回滚。
 *
 * ── 不要抄参考项目的「只查一层目录」 ──
 * 本机实测 `projects/` 下既有 `projects/<工作区>/<id>.jsonl`，也有
 * `projects/<工作区>/<子目录>/<id>.jsonl`（27 个两层目录）。参考实现的
 * `find_project_jsonl` 只看一层，会把这些会话判成「没有正文」。这里改成
 * 递归索引（限深 4 层），一次遍历建表、之后 O(1) 查找。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { dataRoot, getVariant, variantOf } from './variant.mjs';
import { STORE_DIR, findAccount, loadAccounts, accountDisplayName } from './accounts.mjs';
import { readAuthFile } from './auth.mjs';
import { atomicWriteJson, atomicWriteJsonAsync, persistTmpOverwrite } from '../store/config.mjs';
import { detectWorkbuddyProcess, stopWorkbuddy, workbuddyDir } from '../targets/workbuddy.mjs';
import { mergeUnion } from './merge-union.mjs';

/** 让出事件循环：长任务里每处理几项就调用一次，保证服务其它接口（健康检查等）能响应 */
const yieldToLoop = () => new Promise((r) => setImmediate(r));

/** 写库门禁文案（合并时曾丢失此定义导致门禁直接 ReferenceError，恢复自 7634c29） */
export const APP_RUNNING_MESSAGE =
  'WorkBuddy 正在运行，已阻止修改会话数据。请先退出 WorkBuddy，或勾选「先退出 WorkBuddy」由本工具自动结束它。';

/* ------------------------------------------------------------------ *
 * 字节级流式合并工具：会话正文可到数百 MB（单行可含超大 base64），任何
 * readFileSync/逐行 readline 都会卡死或爆堆——服务闪退的元凶。
 *
 * 核心洞察：复制副本 = 源正文做「源id → 副本id」的等长字节替换（UUID 恒 36 字符），
 * 因此副本与源在**各自追加新内容之前**共享逐字节相同的前缀。据此：
 *   1. 分块比对两文件找公共前缀长度 P（第一个差异字节）；
 *   2. P 回退到最近的换行边界；
 *   3. 源文件 [P, EOF) 的尾部 = 源侧独有的新增内容，流式读出、Buffer 内做
 *      等长 UUID 替换后追加进目标正文。
 * 全程 Buffer（外部内存，不占 V8 堆）、64MB 分块、内存恒定，与文件大小无关。
 * 前缀过短（<64KB）判为「不同对话」，拒绝合并（防误把无关会话塞在一起）。
 * ------------------------------------------------------------------ */

const MERGE_CHUNK = 64 * 1024 * 1024;
const MERGE_MIN_PREFIX = 64 * 1024;

/**
 * id 归一化版前缀比对：把两文件头部的各自会话 id 替换成等长占位符后，
 * 比较归一化后的公共前缀长度。同一段对话的不同副本，从第一行起就携带
 * 互不相同的会话 id——不做归一化，逐字节比对会在第一行就「分叉」，
 * 导致同一对话被误判为不同对话（2026-10-21 「优化C盘空间」×2 漏去重实录）。
 */
function findNormCommonPrefixLen(aPath, aId, bPath, bId) {
  const N = 1024 * 1024;
  const read = (f, id) => {
    const fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(N, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    const idB = Buffer.from(id);
    const ph = Buffer.alloc(idB.length, 0x58);
    let base = 0;
    while (base + idB.length <= len) {
      const idx = buf.indexOf(idB, base);
      if (idx === -1) break;
      ph.copy(buf, idx);
      base = idx + idB.length;
    }
    return buf;
  };
  const a = read(aPath, aId);
  const b = read(bPath, bId);
  const lim = Math.min(a.length, b.length);
  let p = 0;
  while (p < lim && a[p] === b[p]) p++;
  return { prefix: p };
}

/**
 * 目标账号「已删除」会话的内容指纹集合——用来尊重「用户删过的东西不要再冒出来」。
 * 只在需要时构建一次，调用方缓存。
 */
function deletedFingerprintsOf(db, tgtUid, index) {
  const out = new Set();
  let rows = [];
  try {
    rows = db
      .prepare("SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NOT NULL AND (status IS NULL OR status != 'pruned')")
      .all(tgtUid);
  } catch {
    return out;
  }
  for (const r of rows) {
    const p = index.get(String(r.id));
    if (!p) continue;
    const fp = contentFingerprint(p, String(r.id));
    if (fp) out.add(fp);
  }
  return out;
}

/** 行内消息 id 正则（与会话正文格式一致） */
const ID_RE = /"id"\s*:\s*"([^"]{1,64})"/;

/**
 * 读一个会话正文的「消息 id 集合」（逐行正则，流式、内存恒定）。
 * 用于判断「A 的全部消息是否都在 B 里」——安全删除的前提。
 */
function messageIdSet(filePath) {
  const set = new Set();
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const CH = 8 * 1024 * 1024;
    const buf = Buffer.alloc(CH + 65536);
    let pos = 0;
    let carry = '';
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CH, size - pos), pos);
      if (n <= 0) break;
      const text = carry + buf.subarray(0, n).toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() || '';
      for (const line of lines) {
        const m = ID_RE.exec(line);
        if (m) set.add(m[1]);
      }
      pos += n;
    }
    if (carry) {
      const m = ID_RE.exec(carry);
      if (m) set.add(m[1]);
    }
  } catch {
    /* 读失败返回已收集的部分 */
  } finally {
    try {
      if (fd != null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  return set;
}

/** A 的消息是否全部包含在 B 里（A ⊆ B） */
function isSubsetOf(aSet, bSet) {
  if (!aSet.size) return false;
  for (const id of aSet) if (!bSet.has(id)) return false;
  return true;
}

/**
 * 会话内容指纹：正文前 64KB 做「会话 id 归一化」后的 SHA1。
 * 同一段对话的副本（名字被改成什么、属于哪个账号都不影响）指纹相同；
 * 不同对话的指纹几乎不可能相同。只读 64KB，极快。
 */
function contentFingerprint(filePath, sessionId) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(65536, size);
    if (len === 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const idB = Buffer.from(sessionId);
    if (idB.length) {
      const ph = Buffer.alloc(idB.length, 0x58);
      replaceAllInPlace(buf, idB, ph);
    }
    return createHash('sha1').update(buf).digest('hex');
  } catch {
    return '';
  } finally {
    try {
      if (fd != null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 文案级指纹：只看前 20 条消息的「角色 + 正文」，忽略 id / 时间戳 / 结构差异。
 * 合并、改写、跨档位复制之后仍能认出「这是同一段对话」，避免反复复制出重复会话。
 */
function contentFingerprintText(filePath, sessionId) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(524288, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    fd = null;
    const parts = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.type !== 'message') continue;
      const c = o.message ? o.message.content : o.content;
      const text = Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('') : typeof c === 'string' ? c : '';
      parts.push((o.role || '') + '|' + text.replace(/\s+/g, '').slice(0, 200));
      if (parts.length >= 20) break;
    }
    if (!parts.length) return contentFingerprint(filePath, sessionId);
    return createHash('sha1').update(parts.join('\n')).digest('hex');
  } catch {
    return contentFingerprint(filePath, sessionId);
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * 消息指纹缓存：key = 正文路径，value = { mtimeMs, size, set }。
 * 文件一改（mtime/size 变化）就自动失效重算，所以只省重复读，不会读旧数据。
 * 一次汇总里同一份正文会被 4~5 个阶段各算一遍，命中缓存后只算一次。
 */
const SIGNATURE_CACHE = new Map();
const SIGNATURE_CACHE_MAX = 4000;

/** 消息指纹集合：角色 + 正文前 200 字，最多 150 条。合并、改写、复制之后仍能对上同一段对话。 */
function contentSignatureSet(filePath) {
  let st = null;
  try {
    st = fs.statSync(filePath);
  } catch {
    return new Set();
  }
  const hit = SIGNATURE_CACHE.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.set;
  // 刚被写过的文件（2 秒内）不进缓存：避免「同一毫秒内被改写、大小又恰好相同」的极端情况读到旧指纹
  const cacheable = Date.now() - st.mtimeMs > 2000;

  const set = new Set();
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(1048576, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.type !== 'message') continue;
      const c = o.message ? o.message.content : o.content;
      const text = Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('') : typeof c === 'string' ? c : '';
      const t = text.replace(/\s+/g, '');
      if (!t) continue;
      set.add((o.role || '') + '|' + t.slice(0, 200));
      if (set.size >= 150) break;
    }
  } catch {
    /* ignore */
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
  }
  if (cacheable) {
    if (SIGNATURE_CACHE.size >= SIGNATURE_CACHE_MAX) SIGNATURE_CACHE.clear();
    SIGNATURE_CACHE.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, set });
  }
  return set;
}

/**
 * 预热指纹缓存：把两个档位所有会话正文先算一遍（只读，不动任何数据）。
 * 调用方可以在「关闭 WorkBuddy」的同时跑它，等同步开始时全部命中缓存。
 */
export function warmSessionSignatures() {
  const t0 = Date.now();
  let files = 0;
  for (const variantId of ['cn', 'ai']) {
    let index;
    try {
      index = indexProjectBodies(variantId);
    } catch {
      continue;
    }
    for (const [, file] of index) {
      try {
        contentSignatureSet(file);
        files += 1;
      } catch {
        /* 单个文件失败不影响其它 */
      }
    }
  }
  return { files, ms: Date.now() - t0 };
}

/** 与已有会话的消息重合度 ≥85% 就认为「这段对话已经有了」，不再复制 */
function looksLikeExisting(sig, list, threshold = 0.85) {
  if (!sig || !sig.size) return false;
  for (const other of list) {
    if (!other || !other.size) continue;
    const small = sig.size <= other.size ? sig : other;
    const big = small === sig ? other : sig;
    let hit = 0;
    for (const x of small) if (big.has(x)) hit++;
    if (hit / small.size >= threshold) return true;
  }
  return false;
}

/**
 * 两份会话正文是否「严格全等」（会话 id 归一化后逐字节相同）。
 * 去重只删除这种「完全一样的重复」；内容有任何差异（哪怕同名）一律保留。
 * 分块流式比对（64MB/块），内存恒定。
 */
function filesIdenticalNorm(aPath, aId, bPath, bId) {
  let fa = null;
  let fb = null;
  try {
    fa = fs.openSync(aPath, 'r');
    fb = fs.openSync(bPath, 'r');
    const sizeA = fs.fstatSync(fa).size;
    const sizeB = fs.fstatSync(fb).size;
    if (sizeA !== sizeB) return false;
    if (sizeA === 0) return true;
    const fromA = Buffer.from(aId);
    const fromB = Buffer.from(bId);
    const phA = Buffer.alloc(fromA.length, 0x58);
    const phB = Buffer.alloc(fromB.length, 0x58);
    const ba = Buffer.alloc(MERGE_CHUNK + Math.max(fromA.length, fromB.length));
    const bb = Buffer.alloc(MERGE_CHUNK + Math.max(fromA.length, fromB.length));
    let pos = 0;
    while (pos < sizeA) {
      const n = Math.min(MERGE_CHUNK, sizeA - pos);
      fs.readSync(fa, ba, 0, n, pos);
      fs.readSync(fb, bb, 0, n, pos);
      const sa = ba.subarray(0, n);
      const sb = bb.subarray(0, n);
      replaceAllInPlace(sa, fromA, phA);
      replaceAllInPlace(sb, fromB, phB);
      if (!sa.equals(sb)) return false;
      pos += n;
    }
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (fa != null) fs.closeSync(fa);
    } catch {
      /* ignore */
    }
    try {
      if (fb != null) fs.closeSync(fb);
    } catch {
      /* ignore */
    }
  }
}

/** 在 Buffer 内把 from 字节序列全部替换成 to（等长或不等长均可，这里仅用等长占位） */
function replaceAllInPlace(buf, from, to) {
  if (!from.length) return;
  let base = 0;
  while (base + from.length <= buf.length) {
    const idx = buf.indexOf(from, base);
    if (idx === -1) break;
    to.copy(buf, idx);
    base = idx + to.length;
  }
}

/** 把 Buffer 内所有等长的 fromId 字节序列替换为 toId（UUID 等长，原位覆写） */
function replaceUuidInPlace(buf, fromB, toB) {
  let base = 0;
  while (base + fromB.length <= buf.length) {
    const idx = buf.indexOf(fromB, base);
    if (idx === -1) break;
    toB.copy(buf, idx);
    base = idx + toB.length;
  }
}

/** 字节级替换复制：源正文流式做「fromId → toId」等长替换写入 dest（不读全文） */
let sharedCopyBuf = null;
function byteCopyReplace(sourcePath, fromId, destPath, toId) {
  const fd = fs.openSync(sourcePath, 'r');
  const out = fs.openSync(destPath, 'w');
  const fromB = Buffer.from(fromId);
  const toB = Buffer.from(toId);
  const size = fs.fstatSync(fd).size;
  if (!sharedCopyBuf || sharedCopyBuf.length < MERGE_CHUNK + fromB.length) {
    sharedCopyBuf = Buffer.alloc(MERGE_CHUNK + 64);
  }
  const chunk = sharedCopyBuf;
  let pos = 0;
  try {
    while (pos < size) {
      const n = fs.readSync(fd, chunk, 0, MERGE_CHUNK, pos);
      if (n <= 0) break;
      replaceUuidInPlace(chunk.subarray(0, n), fromB, toB);
      const overlap = pos + n < size ? fromB.length - 1 : 0;
      const writeLen = n - overlap;
      fs.writeSync(out, chunk, 0, writeLen);
      pos += writeLen;
    }
  } finally {
    fs.closeSync(out);
    fs.closeSync(fd);
  }
}

/**
 * 把 fromPath 中「from 侧独有」的尾部（相对 toPath 的公共前缀之后的部分）
 * 做 UUID 替换后追加进 toPath。dryRun 只返回将追加的字节/行数，不写。
 * 返回 { appendedBytes, appendedLines, unrelated }。
 */
function byteMergeAppend(fromPath, fromId, toPath, toId, { dryRun = false, backupDir = null } = {}) {
  // 归一化比对（完整版：扫到真实分叉点，不截断）
  const { prefix } = findNormCommonPrefixFull(fromPath, fromId, toPath, toId);
  const sizeT = fs.statSync(toPath).size;
  // 目标正文必须几乎完全落在公共前缀内（它本来就是源前缀的替换产物），
  // 否则两者不是同一对话——拒绝合并，防把无关内容塞在一起。
  if (prefix < Math.min(sizeT, MERGE_MIN_PREFIX)) return { appendedBytes: 0, appendedLines: 0, unrelated: true };

  const fa = fs.openSync(fromPath, 'r');
  const sizeF = fs.fstatSync(fa).size;
  // P 回退到最近的换行边界（追加必须从行首开始）
  let start = prefix;
  const back = Math.min(4096, start);
  const rb = Buffer.alloc(back);
  fs.readSync(fa, rb, 0, back, start - back);
  const nl = rb.lastIndexOf(10);
  if (nl >= 0) start = start - back + nl + 1;
  const tailBytes = sizeF - start;
  if (tailBytes <= 0) {
    fs.closeSync(fa);
    return { appendedBytes: 0, appendedLines: 0 };
  }
  if (dryRun) {
    fs.closeSync(fa);
    // 数尾部段行数（分块计数）
    let lines = 0;
    const cb = Buffer.alloc(MERGE_CHUNK);
    let pos = start;
    while (pos < sizeF) {
      const n = fs.readSync(fa, cb, 0, MERGE_CHUNK, pos);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) if (cb[i] === 10) lines++;
      pos += n;
    }
    fs.closeSync(fa);
    return { appendedBytes: tailBytes, appendedLines: lines };
  }
  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(toPath, path.join(backupDir, path.basename(toPath) + '.pre-merge'));
  }
  const fromB = Buffer.from(fromId);
  const toB = Buffer.from(toId);
  const out = fs.openSync(toPath, 'a');
  const chunk = Buffer.alloc(MERGE_CHUNK + fromB.length);
  let pos = start;
  let appendedBytes = 0;
  let appendedLines = 0;
  try {
    while (pos < sizeF) {
      const n = fs.readSync(fa, chunk, 0, MERGE_CHUNK, pos);
      if (n <= 0) break;
      let valid = n;
      // 多读的 fromB.length-1 字节用于跨块 UUID：只写到最后一个完整换行之前会破坏内容——
      // 改为：本块写 n 字节（含可能的半截 UUID）？不行。稳妥：读到 sizeF 尾且按块处理时，
      // 每块实际写入 = 替换后的字节数（等长替换不改变长度），跨块 UUID 由下一块从
      // pos+n-fromB.length+1 重读修正。为简单可靠：重叠读、只写「上一个块末尾重叠区之后」
      // 的部分。实现：读 n 字节，替换，写 (n - (pos + n < sizeF ? fromB.length - 1 : 0)) 字节，
      // 下一块从 pos + n - (fromB.length - 1) 重读。
      replaceUuidInPlace(chunk.subarray(0, n), fromB, toB);
      const overlap = pos + n < sizeF ? fromB.length - 1 : 0;
      const writeLen = n - overlap;
      fs.writeSync(out, chunk, 0, writeLen);
      appendedBytes += writeLen;
      for (let i = 0; i < writeLen; i++) if (chunk[i] === 10) appendedLines++;
      pos += writeLen;
    }
  } finally {
    fs.closeSync(out);
    fs.closeSync(fa);
  }
  return { appendedBytes, appendedLines };
}
/* ------------------------------------------------------------------ *
 * 门禁
 * ------------------------------------------------------------------ */

/**
 * 写会话前的门禁：WorkBuddy 必须已退出。
 *
 * `stop: true` 时由本工具**直接结束 WorkBuddy 的全部相关进程**并确认退出
 * （用户不必自己动手；关不掉就抛错，绝不带着运行中的实例往库里写）。
 *
 * 探测本身失败时**保守拦截**——宁可要求用户重试，也不做「无法判定的写入」。
 *
 * 测试专用开关：`WB_FAKE_APP_RUNNING`（`1`/`true` 假装在运行、`0`/`false` 假装已退出）——
 * 测试机上真实 WorkBuddy 多半正在运行，会让门禁变成「永远拒绝」，两条分支都没法验证；
 * `WB_FAKE_STOP_FAIL=1` 配合前者模拟「进程关不掉」。生产路径不设置它们，走真实探测与真实关进程。
 */
export async function ensureAppClosed({ stop = false } = {}) {
  const fake = process.env.WB_FAKE_APP_RUNNING;
  if (fake === '1' || fake === 'true') {
    if (!stop) throw new Error(APP_RUNNING_MESSAGE);
    if (process.env.WB_FAKE_STOP_FAIL === '1') {
      throw new Error('无法退出 WorkBuddy（测试模拟：进程关不掉），请手动退出后重试');
    }
    return { stopped: true, wasRunning: true, killed: [], forced: false, exePath: null, fake: true };
  }
  if (fake === '0' || fake === 'false') {
    return { stopped: true, wasRunning: false, killed: [], forced: false, exePath: null, fake: true };
  }

  const proc = await detectWorkbuddyProcess();
  if (proc.running) {
    if (!stop) throw new Error(APP_RUNNING_MESSAGE);
    // 关不掉时 stopWorkbuddy 会抛错，这里不吞
    return await stopWorkbuddy();
  }
  if (proc.error) {
    throw new Error(
      `无法确认 WorkBuddy 是否已退出（进程检测失败：${proc.error}）。为安全起见已阻止会话写入，请确认已退出后重试`
    );
  }
  return { stopped: true, wasRunning: false, killed: [], forced: false, exePath: proc.exePath || null };
}

/* ------------------------------------------------------------------ *
 * 列表
 * ------------------------------------------------------------------ */

/**
 * 目标账号的会话复制视图：源是**该档位当前登录账号**，目标是传入的账号。
 *
 * 返回 `{ variant, sourceUid, targetUid, supported, sessions, stats }`。
 * 每个会话带 `hasBody`（有无正文，没有正文的不能复制）、`bytes`、`copied`（账本里已有记录）。
 */
export async function listSessionsForSwitch({ targetAccountId }) {
  const target = findAccount(targetAccountId);
  if (!target) throw new Error('账号不存在');
  const variantId = variantOf(target).id;
  const targetUid = String(target.uid || '').trim();
  if (!targetUid) throw new Error('目标账号缺少 uid，无法列出会话');

  const sourceUid = currentUidOfVariant(variantId);
  if (!sourceUid) throw new Error('未读取到本档位的登录态，无法确定来源账号');
  if (sourceUid === targetUid) throw new Error('源账号与目标账号相同，无需复制会话');

  const supported = await sessionCopySupported(variantId);
  if (!supported) {
    return {
      variant: variantId,
      sourceUid,
      targetUid,
      supported: false,
      sessions: [],
      stats: { total: 0, withBody: 0, bytes: 0 },
    };
  }

  const index = indexProjectBodies(variantId);
  const ledger = sessionCopyLedger(variantId, sourceUid, targetUid);
  // 家族表：用于判定「这段对话在目标账号里已经有了吗」——跨全部账号对，而不是只看这一对
  const family = copyFamilyMap();
  const db = await openSessionDb(variantId, { readOnly: true });
  let rows = [];
  let targetAlive = new Set();
  /** 家族根 → 目标账号里对应的那份会话 id（同一家族有多份时取最近活动的） */
  const targetFamily = new Map();
  try {
    rows = db
      .prepare(
        `SELECT id, cwd, title, custom_title, status, updated_at, is_playground
           FROM sessions
          WHERE user_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC`
      )
      .all(sourceUid);
    // 账本只是「曾经复制过」的记录，目标账号里那份副本可能早就被用户删了。
    // 副本已不在时不能再算「已复制」——界面上会被标记成已复制（默认还会被隐藏、
    // 不可勾选），用户就再也找不到入口把它重新复制过去。
    const targetRows = db
      .prepare('SELECT id, updated_at FROM sessions WHERE user_id = ? AND deleted_at IS NULL')
      .all(targetUid);
    targetAlive = new Set(targetRows.map((r) => String(r.id)));
    for (const r of targetRows) {
      const root = family.rootOf(String(r.id));
      const prev = targetFamily.get(root);
      if (!prev || (Number(r.updated_at) || 0) > (Number(prev.updatedAt) || 0)) {
        targetFamily.set(root, { id: String(r.id), updatedAt: Number(r.updated_at) || 0 });
      }
    }
  } finally {
    db.close();
  }

  const sessions = [];
  let bytes = 0;
  for (const r of rows) {
    const id = String(r.id || '');
    if (!id) continue;
    const cwd = String(r.cwd || '');
    // Claw 工作区绑定的是当前账号的 IM 渠道，复制行也没用，直接剔除
    if (isClawWorkspace(cwd)) continue;
    const body = index.get(id) || null;
    const size = body ? bodySize(body) : 0;
    if (body) bytes += size;
    // 直接复制记录优先（这一对账号自己的账本），没有再看整段对话的家族
    const directId = Object.prototype.hasOwnProperty.call(ledger, id) ? String(ledger[id] || '') : '';
    const directAlive = directId && targetAlive.has(directId) ? directId : '';
    const familyHit = directAlive ? '' : targetFamily.get(family.rootOf(id))?.id || '';
    const copiedTo = directAlive || familyHit || null;
    sessions.push({
      id,
      title: displayTitle(r.title, r.custom_title),
      cwd,
      workspace: workspaceName(cwd),
      status: String(r.status || ''),
      updatedAt: Number(r.updated_at) || 0,
      isPlayground: Number(r.is_playground) === 1,
      hasBody: !!body,
      bytes: size,
      copied: !!copiedTo,
      copiedTo,
      /** direct=这一对账号直接复制过；family=经由其它账号间接同步过去的 */
      copiedScope: directAlive ? 'direct' : familyHit ? 'family' : null,
    });
  }
  return {
    variant: variantId,
    sourceUid,
    targetUid,
    supported: true,
    sessions,
    stats: {
      total: sessions.length,
      withBody: sessions.filter((s) => s.hasBody).length,
      bytes,
    },
  };
}

/**
 * 切换前的「自动增量同步」候选：本档位当前登录账号 → 目标账号之间，
 * 账本/家族里已有副本、副本仍在目标账号里活着、且有正文的会话。
 *
 * 为什么只挑「已复制过」的：自动同步的本分是把既有副本的最新内容与改名带过去
 * （2026-10-21 用户反馈：在 vv 里改了会话名、又聊了新内容，切换账号后什么都没跟过去
 * ——因为切换本身不触发同步，必须手动勾选，用户不知道也不会做）。
 * 没有副本的会话保持原样，要不要复制仍由用户手动勾选决定。
 */
export async function sessionIdsNeedingSync({ targetAccountId }) {
  const view = await listSessionsForSwitch({ targetAccountId });
  if (!view.supported) return [];
  return view.sessions.filter((s) => s.copied && s.hasBody).map((s) => s.id);
}

/** 会话展示名：优先用户改名（custom_title），再回落到自动标题 */
function displayTitle(title, customTitle) {
  const custom = String(customTitle || '').trim();
  if (custom) return custom;
  const t = String(title || '').trim();
  return t || '(无标题)';
}

/**
 * 副本要"钉住"的标题（写进 custom_title）。
 *
 * 为什么必须钉：WorkBuddy 会给**导入的副本重新生成自动标题**，把我们复制过去的
 * `title` 覆盖掉（v0.2.6 之前已实测，见 8acce29 的提交说明）；而 `custom_title`
 * 一旦有值就不会再被自动命名改写。
 *
 * 所以复制时不能只搬 title——那等于把名字交给客户端重写。有用户改名就用改名，
 * 否则把自动标题本身钉成 custom_title（2026-10-20 用户反馈：内容同步过去了、名字没跟过去）。
 * 没有标题（连自动标题都没生成）时返回 null，让它按原样交给客户端。
 */
function pinnedTitle(title, customTitle) {
  const custom = String(customTitle || '').trim();
  if (custom) return custom;
  const t = String(title || '').trim();
  return t || null;
}

/** 会话所属工作区名（取 cwd 最后一段）；没有 cwd 的归入「(无工作区)」 */
function workspaceName(cwd) {
  const s = String(cwd || '').replace(/[/\\]+$/, '');
  if (!s) return '(无工作区)';
  const seg = s.split(/[/\\]/).pop();
  return seg || '(无工作区)';
}

/** Claw 是账号绑定的 IM 渠道工作区，复制到别的账号也用不了 */
function isClawWorkspace(cwd) {
  return workspaceName(cwd).toLowerCase() === 'claw';
}

/** 某档位当前登录态里的 uid */
export function currentUidOfVariant(variantId) {
  const doc = readAuthFile(variantId);
  const uid = doc?.account?.uid;
  return typeof uid === 'string' && uid.trim() ? uid.trim() : null;
}

/* ------------------------------------------------------------------ *
 * 复制
 * ------------------------------------------------------------------ */

/** 名字里只允许出现 UUID 字符，防止把路径拼串到目录之外 */
function assertSafeSessionId(id) {
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(String(id || ''))) {
    throw new Error(`会话 id 形状异常，已拒绝：${String(id).slice(0, 40)}`);
  }
}

/** 备份 workbuddy.db（含 -wal/-shm），任何一步失败都算备份失败 */
/** 档位的会话数据库路径（与 byteMerge/去重共享） */
function sessionDbPath(variantId) {
  return path.join(workbuddyDataRoot(variantId), 'workbuddy.db');
}

/** 档位的 projects/ 目录（会话正文所在） */
function sessionProjectsDir(variantId) {
  return path.join(workbuddyDataRoot(variantId), 'projects');
}

/** 档位的数据根目录：国内版尊重设置页的「WorkBuddy 目录」覆盖，国际版用 ~/.workbuddy-ai */
function workbuddyDataRoot(variantId) {
  const id = variantId === 'ai' ? 'ai' : 'cn';
  if (id === 'ai') return path.join(os.homedir(), '.workbuddy-ai');
  return workbuddyDir();
}

function tableExists(db, name) {
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?").get(name);
    return Number(row?.n) > 0;
  } catch {
    return false;
  }
}

/** 档位是否具备会话复制能力：projects/ 目录 + workbuddy.db 的 sessions 表（回归测试也直接引用） */
export async function sessionCopySupported(variantId) {
  if (!fs.existsSync(sessionProjectsDir(variantId))) return false;
  if (!fs.existsSync(sessionDbPath(variantId))) return false;
  let db = null;
  try {
    db = await openSessionDb(variantId, { readOnly: true });
    return tableExists(db, 'sessions');
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* 关闭失败无所谓 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 会话数据库与复制账本的基础设施
 * ------------------------------------------------------------------ */

const MAX_PROJECT_DEPTH = 4;

/** 会话数据库（node:sqlite）的惰性加载与连接 */
let sqliteModule = null;
async function sqlite() {
  if (!sqliteModule) {
    try {
      sqliteModule = await import('node:sqlite');
    } catch {
      throw new Error('当前运行环境不支持 node:sqlite（需要 Node 22.5+），无法读写会话数据库');
    }
  }
  return sqliteModule;
}

/** 档位的数据根目录：国内版尊重设置页的「WorkBuddy 目录」覆盖，国际版 ~/.workbuddy-ai */
export function sessionDataRoot(variantId) {
  const id = variantId === 'ai' ? 'ai' : 'cn';
  if (process.env[`WB_DATA_ROOT_${id.toUpperCase()}`] || process.env.WB_DATA_ROOT) {
    return path.resolve(process.env[`WB_DATA_ROOT_${id.toUpperCase()}`] || process.env.WB_DATA_ROOT);
  }
  return id === 'cn' ? workbuddyDir() : path.join(os.homedir(), '.workbuddy-ai');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * SQLite 瞬时错误重试。
 *
 * WorkBuddy 被结束后可能被系统的「崩溃自动恢复」在几秒内重新拉起，新实例会立刻打开
 * workbuddy.db；写入撞锁（SQLITE_BUSY / SQLITE_LOCKED）或被杀软拦一下（EPERM/EBUSY）
 * 都是瞬时的，隔几百毫秒再来一次基本就过了。
 * 此前一次失败就把整条会话记成错误——用户看到的就是「转移会话失败」，而实际只是一次抖动。
 */
async function retryDbWrite(fn, { tries = 4, delays = [120, 300, 700] } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const text = `${err?.code || ''} ${err?.message || err}`;
      const retryable = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|table is locked|EBUSY|EPERM|EACCES|disk I\/O error/i.test(
        text
      );
      if (!retryable || i === tries - 1) break;
      await sleep(delays[Math.min(i, delays.length - 1)]);
    }
  }
  throw lastErr;
}

/** 本进程内打开的全部会话库连接：closeAllSessionDbs 用来在只读降级自愈时整体重置 */
const OPEN_SESSION_DBS = new Set();

/** 关闭本进程内（除 except 外）全部会话库连接并清出登记表 */
export function closeAllSessionDbs(except = null) {
  for (const d of [...OPEN_SESSION_DBS]) {
    if (d === except) continue;
    try {
      d.close();
    } catch {
      /* 已关闭/已损坏都无所谓 */
    }
    OPEN_SESSION_DBS.delete(d);
  }
}

const READONLY_CANARY_SQL = 'UPDATE sessions SET updated_at = updated_at WHERE id = "__readonly_canary__"';

/** 打开会话数据库；readOnly 用于只读查询，写操作必须用读写连接 */
async function openSessionDb(variantId, { readOnly = false } = {}) {
  const { DatabaseSync } = await sqlite();
  const file = sessionDbPath(variantId);
  if (!fs.existsSync(file)) throw new Error(`会话数据库不存在：${file}（请先运行一次 WorkBuddy）`);
  // 连接登记 + close 包一层：closeAllSessionDbs 重置时能把登记表同步清干净
  const wrapClose = (db) => {
    OPEN_SESSION_DBS.add(db);
    const origClose = db.close.bind(db);
    db.close = (...args) => {
      OPEN_SESSION_DBS.delete(db);
      return origClose(...args);
    };
    return db;
  };
  const db = wrapClose(new DatabaseSync(file, { readOnly, timeout: readOnly ? 5000 : 8000 }));
  // ⚠️ 实测（2026-11-03，另一台机器的并行调试定稿）：WAL 模式下两个辅助文件（-shm/-wal）
  // 会被 WorkBuddy 复活实例间歇性锁住，SQLite 把连接**静默降级成只读**，所有写报
  // 「attempt to write a readonly database」。回滚日志模式（DELETE，WorkBuddy 原生）
  // 从未出现此问题。journal_mode 持久化在库头，必须显式改回去；WorkBuddy 运行中会
  // BUSY 静默跳过——届时由冻结 WorkBuddy 后的写路径再改。
  if (readOnly) return db;
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA synchronous = FULL');
  } catch {
    /* WorkBuddy 在跑时会 BUSY，静默跳过；冻结后可写路径再恢复 */
  }
  // 只读降级探测（安全网）：若仍处于 WAL 且辅助文件被锁，零行 UPDATE 会报 readonly
  // ——立即自愈（重置本进程全部连接）或抛出明确错误，不让用户撞到搬到一半的失败。
  try {
    db.prepare(READONLY_CANARY_SQL).run();
    return db;
  } catch (err) {
    if (!/readonly/i.test(String(err?.message || err))) {
      closeAllSessionDbs(db);
      db.close();
      throw err;
    }
  }
  // 只读降级 → 自愈：关掉本进程内其它连接（清除坏映射）→ 关掉自己 → 稍候重开再探
  console.log('[sessions] 会话库连接被降级为只读，重置本进程全部会话库连接后重试');
  closeAllSessionDbs(db);
  try {
    db.close();
  } catch {
    /* ignore */
  }
  await sleep(1500);
  const d2 = wrapClose(new DatabaseSync(file, { readOnly: false, timeout: 8000 }));
  try {
    d2.exec('PRAGMA journal_mode = DELETE');
    d2.exec('PRAGMA synchronous = FULL');
    d2.prepare(READONLY_CANARY_SQL).run();
    console.log('[sessions] 连接重置后恢复可写');
    return d2;
  } catch (err) {
    closeAllSessionDbs(d2);
    try {
      d2.close();
    } catch {
      /* ignore */
    }
    throw new Error(`会话库被锁为只读（${String(err?.message || err).slice(0, 60)}）：请确认 WorkBuddy 已完全退出后重试`);
  }
}

/** 递归索引 projects/：会话id → 正文完整路径（符号链接天然被排除） */
function indexProjectBodies(variantId) {
  const root = sessionProjectsDir(variantId);
  const index = new Map();
  if (!fs.existsSync(root)) return index;
  const walk = (dir, depth) => {
    if (depth > MAX_PROJECT_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const id = entry.name.slice(0, -'.jsonl'.length);
        if (!index.has(id)) index.set(id, full);
      }
    }
  };
  walk(root, 1);
  return index;
}

/** 单文件字节大小（读不到按 0） */
function bodySize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/* ---------------- 复制账本（本工具私有，~/.wb-switch/session_copies.json） ---------------- */

/** 账本文件（合并时曾丢失此定义导致 loadCopies 直接 ReferenceError，恢复自 7634c29） */
export const SESSION_COPIES_FILE = path.join(STORE_DIR, 'session_copies.json');

/**
 * 账本结构：{ version: 1, pairs: { "<档位>|<源uid>|<目标uid>": { "<源会话id>": "<副本会话id>" } } }
 * 「一对账号一张表」：查「这个会话有没有复制给这个账号」是 O(1)。
 */
function loadCopies() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_COPIES_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.pairs && typeof raw.pairs === 'object') return raw;
  } catch {
    /* 文件不存在或损坏：当成空账本 */
  }
  return { version: 1, pairs: {} };
}

const pairKey = (variantId, sourceUid, targetUid) => `${variantId}|${sourceUid}|${targetUid}`;

/** 某对账号的复制记录：源会话id → 副本会话id */
/** 账本「一对账号一张表」的只读查询（回归测试也直接引用） */
export function sessionCopyLedger(variantId, sourceUid, targetUid) {
  const ledger = loadCopies();
  return ledger.pairs[pairKey(variantId, sourceUid, targetUid)] || {};
}

/** 全账本反查表：副本会话id → 它的来源会话id（不分账号方向） */
function copyAncestorMap() {
  const map = new Map();
  for (const table of Object.values(loadCopies().pairs)) {
    for (const [sourceId, copyId] of Object.entries(table)) {
      if (!map.has(copyId)) map.set(copyId, sourceId);
    }
  }
  return map;
}

/** 全账本家族表：把每条「副本 → 来源」边做并查集，得到 会话id → 家族根 */
function copyFamilyMap() {
  const par = new Map();
  const find = (x) => {
    let p = par.get(x);
    if (p === undefined) {
      par.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = find(p);
    par.set(x, root);
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) par.set(ra, rb);
  };
  for (const table of Object.values(loadCopies().pairs)) {
    for (const [sourceId, copyId] of Object.entries(table)) {
      if (!sourceId || !copyId) continue;
      union(String(copyId), String(sourceId));
    }
  }
  const rootOf = (id) => {
    const key = String(id || '');
    if (!key) return '';
    return par.has(key) ? find(key) : key;
  };
  return { rootOf, size: par.size };
}

/** 记录复制结果到账本（业务完成之后才落盘：写失败只会让下次重复复制） */
async function recordCopies(variantId, sourceUid, targetUid, pairs) {
  if (!pairs.length) return;
  const ledger = loadCopies();
  const key = pairKey(variantId, sourceUid, targetUid);
  const table = ledger.pairs[key] || {};
  for (const { sourceId, newId } of pairs) table[sourceId] = newId;
  ledger.pairs[key] = table;
  ledger.version = 1;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  // 异步落盘：这条路径跑在切号/复制请求里，同步写撞上 EPERM 锁窗会把整个服务冻住
  await atomicWriteJsonAsync(SESSION_COPIES_FILE, ledger);
}

/** 会话备份保留期：session-copy / merge / replace 三类目录各自只留最近 N 份（备份无清理会持续吃磁盘） */
const SESSION_BACKUP_KEEP = 10;

/** 刚建完新备份就顺手清理过期备份；清理失败绝不影响主流程 */
function pruneSessionBackups() {
  try {
    const root = path.join(STORE_DIR, 'backups');
    for (const prefix of ['session-copy-', 'merge-', 'replace-']) {
      const dirs = fs
        .readdirSync(root)
        .filter((n) => n.startsWith(prefix))
        .map((n) => {
          const dir = path.join(root, n);
          return { dir, ts: fs.statSync(dir).mtimeMs };
        })
        .sort((a, b) => b.ts - a.ts);
      for (const d of dirs.slice(SESSION_BACKUP_KEEP)) {
        try {
          fs.rmSync(d.dir, { recursive: true, force: true });
        } catch {
          /* 单个删不掉留着，下次再清 */
        }
      }
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

function backupSessionDb(variantId) {
  const dbPath = sessionDbPath(variantId);
  if (!fs.existsSync(dbPath)) throw new Error('会话数据库不存在，未复制');
  const backupsRoot = path.join(STORE_DIR, 'backups');
  const today = new Date().toISOString().slice(0, 10);
  const sizeNow = fs.statSync(dbPath).size;

  // 当天已有「同尺寸」备份就直接复用：同一天、库没变大，再拷一份只是白等。
  // ⚠️ 尺寸必须连同 -wal 一起比：主库没变但新写入还在 WAL 里时，旧备份其实落后于
  // 上一次操作（2026-10-26 体检发现）
  const walSig = (db) => {
    const w = `${db}-wal`;
    try {
      const st = fs.statSync(w);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return 'none';
    }
  };
  try {
    for (const name of fs.readdirSync(backupsRoot)) {
      if (!name.startsWith(`session-copy-${today}`)) continue;
      const cand = path.join(backupsRoot, name, 'workbuddy.db');
      if (fs.existsSync(cand) && fs.statSync(cand).size === sizeNow && walSig(cand) === walSig(dbPath)) return path.join(backupsRoot, name);
    }
  } catch {
    /* 读不到备份目录就正常走下面的全量备份 */
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupsRoot, `session-copy-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${dbPath}${suffix}`;
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, `workbuddy.db${suffix}`);
    fs.copyFileSync(src, dest);
    const srcLen = fs.statSync(src).size;
    const destLen = fs.statSync(dest).size;
    if (srcLen !== destLen) throw new Error(`备份 workbuddy.db${suffix} 校验失败：大小不一致，未复制`);
  }
  pruneSessionBackups();
  return dir;
}

/**
 * 目标正文路径：沿用源文件在 `projects/` 下的相对目录。
 *
 * 客户端按会话行的 `cwd` 推导工作区目录名，而 `cwd` 复制时原样保留，
 * 所以目录名必须跟着源文件走（不能自己按 cwd 重算 slug，规则一旦不一致客户端就读不到）。
 */
function targetBodyPath(sourcePath, root, newId) {
  const relativeDir = path.relative(path.join(root, 'projects'), path.dirname(sourcePath));
  const base = path.join(root, 'projects');
  const dir = relativeDir && !relativeDir.startsWith('..') ? path.join(base, relativeDir) : base;
  return path.join(dir, `${newId}.jsonl`);
}

/** 复制时清空的列：云端同步痕迹（副本是新起点，不能带着旧账号的同步状态） */
const CLEAR_ON_COPY = ['agent_dirty', 'agent_dirty_at', 'agent_last_synced', 'verified_at'];
/** 复制时归零的列：未读数（副本对用户是「没看过」的会话） */
const ZERO_ON_COPY = ['unread'];

/** 把源行改写成副本行（身份改写 + 云端同步状态清空） */
function buildCopyRow(sourceRow, { newId, targetUid, now }) {
  const row = { ...sourceRow };
  row.id = newId;
  row.user_id = targetUid;
  row.created_at = now;
  row.updated_at = now;
  if ('last_activity_at' in row) row.last_activity_at = now;
  row.deleted_at = null;
  for (const col of CLEAR_ON_COPY) if (col in row) row[col] = null;
  for (const col of ZERO_ON_COPY) if (col in row) row[col] = 0;
  // 源会话可能正处于 working：副本是「已完成的快照」，留着 working 会让客户端
  // 以为还有未结束的回合而尝试续跑，与源账号抢同一段对话内容。
  if (row.status === 'working') row.status = 'completed';
  // 名字要跟过去：title 会被客户端重新生成，必须同时钉进 custom_title（见 pinnedTitle）
  row.custom_title = pinnedTitle(sourceRow.title, sourceRow.custom_title);
  if (!row.title && row.custom_title) row.title = row.custom_title;
  return row;
}

/** node:sqlite 不接受布尔值，统一压成 0/1；undefined 压成 null */
function normalizeValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function insertSessionRow(db, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO sessions (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
    .map(() => '?')
    .join(', ')})`;
  db.prepare(sql).run(...cols.map((c) => normalizeValue(row[c])));
}

function readRowOwner(db, id) {
  try {
    const r = db.prepare('SELECT user_id, deleted_at FROM sessions WHERE id = ?').get(id);
    if (!r) return null;
    return { user_id: r.user_id == null ? '' : String(r.user_id), deletedAt: r.deleted_at };
  } catch {
    return null;
  }
}

/**
 * 把选中的会话复制给目标账号。
 *
 * @param {object}   opts
 * @param {string}   opts.targetAccountId 目标账号（账号库 id 或 uid）
 * @param {string[]} opts.ids             要复制的源会话 id
 * @param {boolean}  opts.stopApp         WorkBuddy 在运行时是否直接结束它（默认 false＝拒绝）
 * @param {boolean}  opts.skipGate        跳过「WorkBuddy 必须退出」的门禁。仅供切换流程使用：
 *                                        切换已把 WorkBuddy **冻结**（线程挂起，进程活着但
 *                                        无法写任何数据），写库/写正文与冻结实例不冲突。
 * @returns {Promise<object>} 复制报告
 */
export async function copySessions({ targetAccountId, ids, stopApp = false, skipGate = false }) {
  const started = Date.now();
  const list = Array.isArray(ids) ? [...new Set(ids.map((s) => String(s || '').trim()).filter(Boolean))] : [];
  if (!list.length) throw new Error('没有选择要复制的会话');

  const target = findAccount(targetAccountId);
  if (!target) throw new Error('账号不存在');
  const variantId = variantOf(target).id;
  const targetUid = String(target.uid || '').trim();
  if (!targetUid) throw new Error('目标账号缺少 uid，无法复制会话');

  const sourceUid = currentUidOfVariant(variantId);
  if (!sourceUid) throw new Error('未读取到本档位的登录态，无法确定来源账号');
  if (sourceUid === targetUid) throw new Error('源账号与目标账号相同，无需复制会话');

  if (!(await sessionCopySupported(variantId))) {
    throw new Error(`该档位（${getVariant(variantId).label}）暂不支持会话复制：缺少 projects/ 目录或 sessions 表`);
  }

  // 写库前必须确认 App 已退出——这是唯一能保证副本不与源会话分叉的前提。
  // stopApp=true 时由本工具直接结束 WorkBuddy 的进程（关不掉就抛错中止，不做无法判定的写入）。
  // skipGate=true 时由调用方（切换流程）保证 App 已冻结，跳过这道检查。
  const appStop = skipGate ? null : await ensureAppClosed({ stop: stopApp });

  const root = sessionDataRoot(variantId);
  const index = indexProjectBodies(variantId);
  const ledger = sessionCopyLedger(variantId, sourceUid, targetUid);
  // 祖先链：查「这份会话当初是从哪一份复制出来的」，**跨全部账号对**。
  // 只反查「目标 → 本账号」这一层是不够的：A→B→C→A 这类接力（或某个会话早先用
  // 别的方式复制过）时单层查不到祖先，会话就被当成新会话又复制一份——实测能复现出
  // 「复制了一模一样的会话」。改成整张账本反查后，由 resolveOrigin 沿链往上找落点。
  const ancestorOf = copyAncestorMap();

  const backupPath = backupSessionDb(variantId);

  const db = await openSessionDb(variantId);
  const copied = [];
  const skipped = [];
  const errors = [];
  const titleSynced = [];
  const contentSynced = [];
  const ledgerAdds = [];
  let totalBytes = 0;

  /**
   * 标题回写：把源会话当前的 title / custom_title 写到目标账号的原会话行上。
   * 只动这两个列，内容一字不碰；字段没变化时不写。返回同步结果或 null（无需同步）。
   */
  const syncTitleBack = (originId, sourceTitle, sourceCustomTitle) => {
    const nextCustom = pinnedTitle(sourceTitle, sourceCustomTitle);
    const cur = db.prepare('SELECT title, custom_title FROM sessions WHERE id = ? AND user_id = ?').get(originId, targetUid);
    if (!cur) return null;
    const same =
      String(cur.title ?? '') === String(sourceTitle ?? '') && String(cur.custom_title ?? '') === String(nextCustom ?? '');
    if (same) return null;
    db.prepare('UPDATE sessions SET title = ?, custom_title = ? WHERE id = ? AND user_id = ?').run(
      sourceTitle ?? null,
      nextCustom,
      originId,
      targetUid
    );
    return { originId, title: displayTitle(sourceTitle, nextCustom) };
  };

  /**
   * 内容增量同步：把 `fromId` 正文里**目标那侧还没有的行**补进 `toId` 正文。
   *
   * 两个方向共用：
   * - 往返（副本 → 原会话）：在目标账号里继续聊出来的新消息补回原会话；
   * - 正向（本账号会话 → 之前复制过去的那份副本）：本账号又聊了新内容时补进旧副本，
   *   否则「已复制过」就只是什么都不做，用户切过去看到的是一份过期的会话。
   *
   * 为什么按「逐行去重」而不是「取最长公共前缀后追加尾部」：
   * 复制时副本正文 = 原正文逐行做 `原id → 副本id` 替换的产物，所以把副本行反向替换回目标视角后，
   * 两边共有的行是**逐字节相等**的。取公共前缀只在「目标侧严格是来源的前缀」时才成立；一旦两侧
   * 都各自新增过内容（用户在两边都聊过），公共前缀会停在复制时刻的快照边界，同一段增量每次重跑
   * 都会被再追加一遍。改成「来源里有、目标里没有的行」没有这个问题：天然幂等，两侧的新内容都
   * 不会丢（每行是一条带唯一消息 id 的 JSON，重复行 == 同一条消息）。
   *
   * 无增量（目标已经是来源的超集）时不做任何写入，返回 null。
   */
  const syncContentTo = (fromId, toId) => {
    const fromPath = index.get(fromId);
    const toPath = index.get(toId);
    if (!fromPath || !toPath) return null; // 任一侧没有正文：只做标题同步，内容无从合并

    // 幂等护栏：目标已包含来源的全部消息 id → 无增量，直接跳过。
    // 字节前缀合并没法自证幂等——分叉场景（两侧都各自聊过）下前缀会停在「目标
    // 独有的那一行」，重复往返会把副本尾部整段反复追加（测试 session-copy §10
    // 专门守这条）。消息 id 是逐行唯一键，「来源 ⊆ 目标」即数学意义上的无增量。
    // 全程流式读（8MB 块），内存恒定。
    try {
      const srcIds = messageIdSet(fromPath);
      const dstIds = messageIdSet(toPath);
      if (srcIds.size && isSubsetOf(srcIds, dstIds)) return null;
    } catch {
      /* 指纹读不出来就交给字节合并自己判（宁可多读，不误判无增量） */
    }

    // 字节级流式合并：找公共前缀 → 源尾部（源侧独有新增）UUID 替换后追加进目标。
    // 全程 Buffer 分块，内存恒定，与正文大小无关（大会话曾把服务撑爆）。
    const r = byteMergeAppend(fromPath, fromId, toPath, toId, {
      dryRun: false,
      backupDir: backupPath,
    });
    if (r.unrelated || !r.appendedLines) return null;

    // 写后尾部抽查：不得残留来源会话 id（等长替换在数学上保证不残留，此处双保险）
    const tailSize = fs.statSync(toPath).size;
    const tailLen = Math.min(2_000_000, tailSize);
    const tailBuf = Buffer.alloc(tailLen);
    const tailFd = fs.openSync(toPath, 'r');
    try {
      fs.readSync(tailFd, tailBuf, 0, tailLen, tailSize - tailLen);
    } finally {
      fs.closeSync(tailFd);
    }
    if (tailBuf.toString('utf8').includes(fromId)) {
      throw new Error('内容同步后的目标正文仍残留来源会话 id');
    }

    // 目标会话行的活动时间推进到两侧较新的值（App 已冻结，无并发写）
    const fromRow = db.prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ?').get(fromId);
    const toRow = db
      .prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ? AND user_id = ?')
      .get(toId, targetUid);
    if (fromRow && toRow) {
      const nextUpdated = Math.max(Number(toRow.updated_at) || 0, Number(fromRow.updated_at) || 0);
      const nextActivity = Math.max(Number(toRow.last_activity_at) || 0, Number(fromRow.last_activity_at) || 0);
      if (nextUpdated > (Number(toRow.updated_at) || 0) || nextActivity > (Number(toRow.last_activity_at) || 0)) {
        db.prepare('UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ? AND user_id = ?').run(
          nextUpdated,
          nextActivity > 0 ? nextActivity : null,
          toId,
          targetUid
        );
      }
    }

    return { targetId: toId, appendedLines: r.appendedLines };
  };

  /** 目标账号里这份会话行是否仍然存在且未删除（账本可能记着一份早就被删掉的副本） */
  const rowAlive = (id, uid) =>
    !!db.prepare('SELECT 1 AS k FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, uid);

  /**
   * 把 `fromId` 的增量内容与改名同步到目标账号里的 `toId`。两个方向共用；
   * 失败只记错误，不中断其它会话。
   */
  const syncSessionInto = (fromId, toId) => {
    try {
      const synced = syncContentTo(fromId, toId);
      if (synced) contentSynced.push({ sourceId: fromId, ...synced });
    } catch (err) {
      errors.push({ id: fromId, error: `内容同步失败（本次未复制）：${err?.message || err}` });
    }
    try {
      const row = db.prepare('SELECT title, custom_title FROM sessions WHERE id = ?').get(fromId);
      if (row) {
        const synced = syncTitleBack(toId, row.title, row.custom_title);
        if (synced) titleSynced.push({ sourceId: fromId, ...synced });
      }
    } catch (err) {
      errors.push({ id: fromId, error: `标题同步失败（内容不受影响）：${err?.message || err}` });
    }
  };

  /**
   * 沿祖先链往上找「目标账号里确实存在」的那一份，作为合并落点。
   *
   * 限深 32 且带 visited：账本万一被手工改坏成环也不会死循环。
   * 找不到（这个会话跟目标账号毫无血缘）时返回 null，调用方按普通复制处理。
   */
  const resolveOrigin = (cid) => {
    const seen = new Set([cid]);
    let cur = ancestorOf.get(cid);
    for (let hop = 0; cur && hop < 32 && !seen.has(cur); hop++) {
      if (rowAlive(cur, targetUid)) return cur;
      seen.add(cur);
      cur = ancestorOf.get(cur);
    }
    return null;
  };

  try {
    for (const cid of list) {
      try {
        assertSafeSessionId(cid);
        // 往返识别**优先于一切复制判定**：cid 的血缘上有一份已经落在目标账号里时，
        // 既不能"照旧重新复制"（会产生内容重复的新会话——0.2.2 用户实测踩过，
        // 改名前后的会话都被复制了一份；跨账号接力时单层反查还会漏判），
        // 也不能"只跳过"（新聊的内容会永远留在副本里）。正确动作是原位合并：
        // 内容增量 + 改名都同步到那一份上。
        const originId = resolveOrigin(cid);
        if (originId) {
          assertSafeSessionId(originId);
          syncSessionInto(cid, originId);
          skipped.push({
            id: cid,
            reason: '往返副本：新增内容与改名已同步回原会话，不再重复复制',
            newId: originId,
          });
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(ledger, cid)) {
          // 账本命中的那份副本也可能**已经在目标账号里被删掉了**：此时"跳过"等于用户点了
          // 复制却什么都没发生（真实账本里就有 3 条这种记录），所以只在副本确实还在时才走
          // 同步；否则按未复制处理，重新复制一份并覆盖账本。
          // 副本还在时也不再只是"跳过"：本账号这一侧可能又聊了新内容，要同步过去，
          // 不然用户切过去看到的是一份过期的会话。
          const prevId = String(ledger[cid] || '');
          if (prevId && rowAlive(prevId, targetUid)) {
            assertSafeSessionId(prevId);
            syncSessionInto(cid, prevId);
            skipped.push({ id: cid, reason: '已复制过（账本命中）：本次只同步新增内容与改名', newId: prevId });
            continue;
          }
        }
        const sourcePath = index.get(cid);
        if (!sourcePath) throw new Error('会话正文不存在，未复制');

        const sourceRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(cid);
        if (!sourceRow) throw new Error('数据库中找不到该会话记录，未复制');
        if (String(sourceRow.user_id || '') !== sourceUid) throw new Error('该会话不属于当前登录账号，未复制');
        if (sourceRow.deleted_at != null) throw new Error('该会话已被删除，未复制');
        if (isClawWorkspace(sourceRow.cwd)) throw new Error('Claw 工作区绑定当前账号渠道，不支持复制');

        const newId = crypto.randomUUID();
        const dest = targetBodyPath(sourcePath, root, newId);
        if (fs.existsSync(dest)) throw new Error('目标位置已存在同名文件，已停止复制');
        fs.mkdirSync(path.dirname(dest), { recursive: true });

        // 正文：流式把旧 id 全量替换成副本 id（源文件一个字节都不动；
        // 正文可到数百 MB，全文读入会撑爆堆——已实测服务的「闪退」元凶）
        byteCopyReplace(sourcePath, cid, dest, newId);
        // 校验：等长 UUID 替换不改变文件尺寸，尺寸一致 + 全局替换的数学保证即足够
        const writtenBytes = fs.statSync(dest).size;

        // 元数据：插入副本行（用 INSERT 而非 REPLACE，撞库宁可失败也不覆盖既有会话）
        let inserted = false;
        try {
          insertSessionRow(db, buildCopyRow(sourceRow, { newId, targetUid, now: Date.now() }));
          inserted = true;
          const owner = readRowOwner(db, newId);
          if (!owner) throw new Error('会话记录保存后不可见，未按成功处理');
          if (owner.user_id !== targetUid) {
            throw new Error(`会话记录归属校验失败：期望 ${targetUid}，实际 ${owner.user_id}`);
          }
          if (owner.deletedAt != null) throw new Error('会话记录保存后被标记删除，未按成功处理');
        } catch (err) {
          // 回滚本会话：先删行（若已插入），再删刚写的正文
          if (inserted) {
            try {
              db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(newId, targetUid);
            } catch {
              /* 回滚尽力而为，下面的报错里会带上说明 */
            }
          }
          fs.rmSync(dest, { force: true });
          throw err;
        }

        copied.push({
          id: cid,
          newId,
          title: displayTitle(sourceRow.title, sourceRow.custom_title),
          workspace: workspaceName(sourceRow.cwd),
          bytes: writtenBytes,
        });
        ledgerAdds.push({ sourceId: cid, newId });
        totalBytes += writtenBytes;
      } catch (err) {
        errors.push({ id: cid, error: err?.message || String(err) });
      }
    }
  } finally {
    db.close();
  }

  // 账本在业务完成之后才落盘：写失败只会让下次重复复制（用户能看到重复会话），
  // 而提前记账会让失败的会话被永久跳过（用户看不到副本还以为成功了）。
  try {
    await recordCopies(variantId, sourceUid, targetUid, ledgerAdds);
  } catch (err) {
    errors.push({ id: '(账本)', error: `复制账本写入失败（下次可能重复复制）：${err?.message || err}` });
  }

  return {
    ok: errors.length === 0,
    variant: variantId,
    sourceUid,
    targetUid,
    copied,
    skipped,
    errors,
    /** 往返复制时同步回原会话的改名（含会话 id、原会话 id 与新标题） */
    titleSynced,
    /** 往返复制时追加回原会话正文的增量内容（含追加行数与字节数） */
    contentSynced,
    totalBytes,
    backupPath,
    /** 本次是否结束了 WorkBuddy 的进程（供界面提示"客户端已被关闭，需要重新打开"） */
    appStop,
    elapsedMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ *
 * 一键同步所有账号
 * ------------------------------------------------------------------ */

/**
 * 把账号库里**全部本机账号**两两互相同步：内容按「两侧并集取最新」（逐行去重合并，
 * 谁的新内容都不会丢），改名跟随最新，已有副本的会话永远原位合并、绝不重复复制。
 *
 * 与 copySessions 的本质区别：**不依赖「源 = 当前登录账号」**——所有账号的会话行
 * 都在同一个 workbuddy.db、正文都在同一个 projects/ 下，`user_id` 只是归属标记，
 * 直接按账号对遍历即可，一次跑完全部方向，不需要真的来回切换登录。
 *
 * @param {object}  opts
 * @param {boolean} opts.stopApp    WorkBuddy 在运行时是否直接结束它（默认 false＝拒绝写入）
 * @param {boolean} opts.fillMissing 目标账号里**从来没有**这份会话时，是否补全复制
 *                                  （false＝只同步已同步过的；true＝全量对齐，会显著占用磁盘）
 * @param {boolean} opts.dryRun     预演模式：只计算「会补多少行 / 改哪些名 / 复制哪些」，
 *                                  **不做任何写入**（也不要求 WorkBuddy 退出，只读访问）
 * @returns {Promise<object>} 汇总报告
 */
export async function syncAllAccounts({ stopApp = false, fillMissing = false, dryRun = false, pruneOthers = false, keepVariant = null, assumeClosed = false } = {}) {
  const started = Date.now();
  // 预演只读：不结束 WorkBuddy、用只读连接打开库，App 运行中也能跑
  // assumeClosed：调用方（withAppRestart）已经关过应用，别再枚举一次进程——
  // 目标机器起一个子进程可能要 3~7 秒，多枚举一次就多等这么久。
  const appStop = dryRun
    ? null
    : assumeClosed
      ? { stopped: true, wasRunning: true, assumed: true }
      : await ensureAppClosed({ stop: stopApp });

  const report = {
    ok: true,
    dryRun,
    accounts: 0,
    pairsRun: 0,
    copied: [],
    skipped: [],
    titleSynced: [],
    contentSynced: [],
    skippedDeleted: [],
    errors: [],
    totalBytes: 0,
    backupPath: null,
    appStop,
    elapsedMs: 0,
  };

  // 按档位分组（国内版/国际版的数据根与登录态互不相通）
  const groups = new Map();
  for (const a of loadAccounts()) {
    const uid = String(a?.uid || '').trim();
    if (!uid) continue;
    const v = variantOf(a).id;
    if (!groups.has(v)) groups.set(v, new Set());
    groups.get(v).add(uid);
  }

  for (const [variantId, uidSet] of groups) {
    const uids = [...uidSet];
    report.accounts += uids.length;
    if (uids.length < 2) continue;
    if (!(await sessionCopySupported(variantId))) continue;

    const root = sessionDataRoot(variantId);
    const index = indexProjectBodies(variantId);
    const ancestorOf = copyAncestorMap();
    const family = copyFamilyMap();
    // 预演不写任何东西：不备份、只读开库
    const backupPath = dryRun ? null : backupSessionDb(variantId);
    if (!report.backupPath) report.backupPath = backupPath;

    const db = await openSessionDb(variantId, { readOnly: dryRun });
    const ledgerAdds = []; // { variantId, srcUid, tgtUid, sourceId, newId }
    // 落点解析缓存：同一（会话，目标账号）组合只解析一次
    const targetCache = new Map();
    // 目标账号「已删除会话指纹」缓存（尊重删除：删过的不再回填）
    const deletedFpCache = new Map();

    const rowAlive = (id, uid) =>
      !!db.prepare('SELECT 1 AS k FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, uid);

    const syncContentBetween = (fromId, toId, tgtUid) => {
      const fromPath = index.get(fromId);
      const toPath = index.get(toId);
      if (!fromPath || !toPath) return null;
      let srcIds = null;
      let dstIds = null;
      try {
        srcIds = messageIdSet(fromPath);
        dstIds = messageIdSet(toPath);
      } catch {
        return null;
      }
      if (!srcIds.size || !dstIds.size) return null;
      const srcHasNew = [...srcIds].some((x) => !dstIds.has(x));
      const dstHasNew = [...dstIds].some((x) => !srcIds.has(x));
      if (!srcHasNew) return null; // 目标已含源的全部消息 → 无需动作
      const srcCoversAll = !dstHasNew; // 目标 ⊂ 源：源更全
      if (!srcCoversAll) {
        // 分叉：两边各有独有内容 → 并集合并进目标（内容有多有少也合并，不丢消息）
        const srcOnly = [...srcIds].filter((x) => !dstIds.has(x)).length;
        const dstOnly = [...dstIds].filter((x) => !srcIds.has(x)).length;
        if (dryRun) return { targetId: toId, diverged: true, mergeable: true, srcOnly, dstOnly, dryRun: true };
        try {
          // 目标正文先备份再合并。⚠️ 这里曾有引用未定义 backupDir 的分支——每次同步
          // 都抛 ReferenceError 被 catch 吞成错误条目，内容同步自合并功能引入起就
          // 100% 静默失败（2026-10-26 体检发现）；改为无条件自建备份目录
          const bd = path.join(STORE_DIR, 'backups', 'merge-' + Date.now());
          fs.mkdirSync(bd, { recursive: true });
          fs.copyFileSync(toPath, path.join(bd, toId + '.before-merge.jsonl'));
          const mr = mergeUnion(
            [
              { id: fromId, file: fromPath },
              { id: toId, file: toPath },
            ],
            toId,
            toPath
          );
          if (!mr.ok) return { targetId: toId, error: `合并失败：${mr.error}` };
          const fromRow = db.prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ?').get(fromId);
          const toRow = db
            .prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ? AND user_id = ?')
            .get(toId, tgtUid);
          if (fromRow && toRow) {
            const nextUpdated = Math.max(Number(toRow.updated_at) || 0, Number(fromRow.updated_at) || 0, Number(mr.lastTs) || 0);
            const nextActivity = Math.max(Number(toRow.last_activity_at) || 0, Number(fromRow.last_activity_at) || 0);
            db.prepare('UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ? AND user_id = ?').run(
              nextUpdated,
              nextActivity > 0 ? nextActivity : null,
              toId,
              tgtUid
            );
          }
          return { targetId: toId, merged: true, lines: mr.lines, srcOnly, dstOnly };
        } catch (err) {
          return { targetId: toId, error: err?.message || String(err) };
        }
      }
      const gain = [...srcIds].filter((x) => !dstIds.has(x)).length;
      if (dryRun) return { targetId: toId, replacedByComplete: true, appendedLines: gain, dryRun: true };
      // 备份目标后用源内容替换（源更全）
      try {
        const bd = path.join(STORE_DIR, 'backups', 'replace-' + Date.now());
        fs.mkdirSync(bd, { recursive: true });
        fs.copyFileSync(toPath, path.join(bd, toId + '.before-replace.jsonl'));
        byteCopyReplace(fromPath, fromId, toPath, toId);
      } catch (err) {
        return { targetId: toId, error: err?.message || String(err) };
      }
      const fromRow = db.prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ?').get(fromId);
      const toRow = db
        .prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ? AND user_id = ?')
        .get(toId, tgtUid);
      if (fromRow && toRow) {
        const nextUpdated = Math.max(Number(toRow.updated_at) || 0, Number(fromRow.updated_at) || 0);
        const nextActivity = Math.max(Number(toRow.last_activity_at) || 0, Number(fromRow.last_activity_at) || 0);
        if (nextUpdated > (Number(toRow.updated_at) || 0) || nextActivity > (Number(toRow.last_activity_at) || 0)) {
          db.prepare('UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ? AND user_id = ?').run(
            nextUpdated,
            nextActivity > 0 ? nextActivity : null,
            toId,
            tgtUid
          );
        }
      }
      return { targetId: toId, replacedByComplete: true, appendedLines: gain };
    };

    const syncTitleBetween = (fromId, toId, tgtUid) => {
      const row = db.prepare('SELECT title, custom_title, updated_at FROM sessions WHERE id = ?').get(fromId);
      if (!row) return null;
      // 只传播「用户手动改过的名字」（custom_title）：
      // 各副本的 title 是客户端自动命名的，账号间本来就不同，互相覆盖既无意义又会
      // 让用户看到满屏名字变动（实测预演里 488 个「将更新名称」几乎全是自动标题差异）。
      // 源没有 custom_title ＝ 用户没改名 → 不动目标的名字。
      const srcCustom = String(row.custom_title || '').trim();
      if (!srcCustom) return null;
      const cur = db
        .prepare('SELECT title, custom_title, updated_at FROM sessions WHERE id = ? AND user_id = ?')
        .get(toId, tgtUid);
      if (!cur) return null;
      if (String(cur.custom_title || '').trim() === srcCustom) return null;
      // 双向会打架（A 说我叫 X、B 说我叫 Y，互写回不死循环也会来回横跳）：
      // 名字只从「最近活跃的那一行」向较旧的一侧传播——活跃账号的名字算最新状态。
      if (Number(cur.updated_at || 0) > Number(row.updated_at || 0)) return null;
      if (dryRun) return { originId: toId, title: srcCustom, dryRun: true };
      db.prepare('UPDATE sessions SET custom_title = ? WHERE id = ? AND user_id = ?').run(srcCustom, toId, tgtUid);
      return { originId: toId, title: srcCustom };
    };

    const syncInto = (fromId, toId, tgtUid, srcUid) => {
      try {
        const c = syncContentBetween(fromId, toId, tgtUid);
        if (c) report.contentSynced.push({ sourceId: fromId, sourceUid: srcUid, ...c });
      } catch (err) {
        report.errors.push({ id: fromId, error: `内容同步失败：${err?.message || err}` });
      }
      try {
        const t = syncTitleBetween(fromId, toId, tgtUid);
        if (t) report.titleSynced.push({ sourceId: fromId, sourceUid: srcUid, ...t });
      } catch (err) {
        report.errors.push({ id: fromId, error: `标题同步失败：${err?.message || err}` });
      }
    };

    /** 在 tgtUid 里找这份会话的家族/账本落点 */
    const normTitleOf = (row) =>
      String(row?.custom_title || row?.title || '')
        .replace(/[\s《》「」"'‘’“”（）()\[\]【】—\-–_.·]/g, '')
        .toLowerCase();

    const resolveTarget = (cid, tgtUid, srcUid, sourceRow = null) => {
      const cacheKey = `${cid}|${tgtUid}`;
      if (targetCache.has(cacheKey)) return targetCache.get(cacheKey);
      const resolve = () => {
        const seen = new Set([cid]);
        let cur = ancestorOf.get(cid);
        for (let hop = 0; cur && hop < 32 && !seen.has(cur); hop++) {
          if (rowAlive(cur, tgtUid)) return cur;
          seen.add(cur);
          cur = ancestorOf.get(cur);
        }
        const ledger = sessionCopyLedger(variantId, srcUid, tgtUid);
        const prevId = String(ledger[cid] || '');
        if (prevId && rowAlive(prevId, tgtUid)) return prevId;
        // 家族兜底：目标账号里同家族最近的那份
        const famRoot = family.rootOf(cid);
        const tgtIds = db
          .prepare('SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
          .all(tgtUid)
          .map((r) => String(r.id));
        if (famRoot && famRoot !== cid) {
          const hit = tgtIds.find((id) => family.rootOf(id) === famRoot);
          if (hit) return hit;
        }
        // 内容指纹兜底：同一段对话的副本指纹相同——**与名字无关**（名字被改过也能认亲）
        {
          const srcPath = index.get(cid);
          if (srcPath) {
            const fp = contentFingerprintText(srcPath, cid);
            if (fp) {
              const cands = db
                .prepare('SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL')
                .all(tgtUid);
              for (const cand of cands) {
                const candPath = index.get(String(cand.id));
                if (!candPath) continue;
                try {
                  if (contentFingerprintText(candPath, String(cand.id)) === fp) return String(cand.id);
                } catch {
                  /* 比对失败继续 */
                }
              }
            }
          }
        }
        return null;
      };
      const result = resolve();
      targetCache.set(cacheKey, result);
      return result;
    };

    try {
      // 遍历顺序刻意做成「会话外层、目标账号内层」：
      // 源正文可能大到 140MB+/份（本机实测 46 份合计 6.5GB），必须逐会话处理、
      // 用完立即从缓存释放，把内存峰值压在「单个正文 + 单次比对临时量」以内。
      const countedPairs = new Set();
      for (const srcUid of uids) {
        const rows = db
          .prepare('SELECT * FROM sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
          .all(srcUid);
        let __yieldCounter = 0;
        for (const sourceRow of rows) {
          if (++__yieldCounter % 3 === 0) await yieldToLoop();
          const cid = String(sourceRow.id || '');
          if (!cid) continue;
          for (const tgtUid of uids) {
            if (tgtUid === srcUid) continue;
            const pairKeyStr = `${srcUid}|${tgtUid}`;
            if (!countedPairs.has(pairKeyStr)) {
              countedPairs.add(pairKeyStr);
              report.pairsRun += 1;
            }
            try {
              assertSafeSessionId(cid);
              if (isClawWorkspace(sourceRow.cwd)) continue;
              const originId = resolveTarget(cid, tgtUid, srcUid, sourceRow);
              if (originId) {
                assertSafeSessionId(originId);
                syncInto(cid, originId, tgtUid, srcUid);
                report.skipped.push({ id: cid, pair: `${srcUid.slice(0, 8)}→${tgtUid.slice(0, 8)}`, newId: originId });
                continue;
              }
              if (!fillMissing || pruneOthers) continue;
              // 目标账号从来没有这份会话：全量复制（与 copySessions 主路径同款）
              const sourcePath = index.get(cid);
              if (!sourcePath) continue;
              // 尊重删除：目标账号曾删过同一对话（指纹一致）→ 不回填
              try {
                if (!deletedFpCache.has(tgtUid)) {
                  deletedFpCache.set(tgtUid, deletedFingerprintsOf(db, tgtUid, index));
                }
                const banned = deletedFpCache.get(tgtUid);
                if (banned && banned.size) {
                  // ⚠️ 指纹必须与 deletedFingerprintsOf 的收集口径一致（contentFingerprint，
                  // 字节级归一化）。这里曾误用 contentFingerprintText（文本级），两种算法
                  // 永不相等 → 「尊重删除」禁令完全失效，删掉的对话会被原样回填
                  const fp = contentFingerprint(sourcePath, cid);
                  if (fp && banned.has(fp)) {
                    report.skippedDeleted = report.skippedDeleted || [];
                    report.skippedDeleted.push({
                      id: cid,
                      pair: srcUid.slice(0, 8) + '→' + tgtUid.slice(0, 8),
                      title: displayTitle(sourceRow.title, sourceRow.custom_title),
                    });
                    continue;
                  }
                }
              } catch {
                /* 检查失败按未删除处理（宁可多复制，不误删） */
              }
              if (dryRun) {
                // 预演：只统计将复制的会话，不写文件、不插行
                const st = fs.statSync(sourcePath);
                report.copied.push({
                  id: cid,
                  newId: '(预演)',
                  pair: `${srcUid.slice(0, 8)}→${tgtUid.slice(0, 8)}`,
                  title: displayTitle(sourceRow.title, sourceRow.custom_title),
                  bytes: st.size,
                  dryRun: true,
                });
                report.totalBytes += st.size;
                continue;
              }
              // 检查磁盘剩余空间：留 1.2 倍余量，不够就中止（绝不把磁盘写满）
              try {
                const st = fs.statfsSync(sessionDataRoot(variantId));
                const free = Number(st.bavail) * Number(st.bsize);
                const need = fs.statSync(sourcePath).size;
                if (free < need * 1.2) {
                  throw new Error('磁盘空间不足：需要 ' + (need / 1073741824).toFixed(2) + 'GB，剩余 ' + (free / 1073741824).toFixed(2) + 'GB');
                }
              } catch (err) {
                if (/磁盘空间不足/.test(String(err && err.message))) throw err;
              }
              const newId = crypto.randomUUID();
              const dest = targetBodyPath(sourcePath, root, newId);
              if (fs.existsSync(dest)) continue;
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              byteCopyReplace(sourcePath, cid, dest, newId);
              const writtenBytes = fs.statSync(dest).size;
              let inserted = false;
              try {
                insertSessionRow(db, buildCopyRow(sourceRow, { newId, targetUid: tgtUid, now: Date.now() }));
                inserted = true;
                const owner = readRowOwner(db, newId);
                if (!owner || owner.user_id !== tgtUid || owner.deletedAt != null) {
                  throw new Error('会话记录保存后校验失败');
                }
              } catch (err) {
                if (inserted) {
                  try {
                    db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(newId, tgtUid);
                  } catch {
                    /* 尽力回滚 */
                  }
                }
                fs.rmSync(dest, { force: true });
                throw err;
              }
              report.copied.push({
                id: cid,
                newId,
                pair: `${srcUid.slice(0, 8)}→${tgtUid.slice(0, 8)}`,
                title: displayTitle(sourceRow.title, sourceRow.custom_title),
                bytes: writtenBytes,
              });
              ledgerAdds.push({ variantId, srcUid, tgtUid, sourceId: cid, newId });
              report.totalBytes += writtenBytes;
            } catch (err) {
              report.errors.push({ id: cid, pair: `${srcUid.slice(0, 8)}→${tgtUid.slice(0, 8)}`, error: err?.message || String(err) });
            }
          }
        }
      }
    } finally {
      db.close();
    }

    if (ledgerAdds.length && !dryRun) {
      try {
        for (const { srcUid, tgtUid, sourceId, newId } of ledgerAdds) {
          const ledger = loadCopies();
          const key = pairKey(variantId, srcUid, tgtUid);
          const table = ledger.pairs[key] || {};
          table[sourceId] = newId;
          ledger.pairs[key] = table;
          ledger.version = 1;
          fs.mkdirSync(STORE_DIR, { recursive: true });
          await atomicWriteJsonAsync(SESSION_COPIES_FILE, ledger);
        }
      } catch (err) {
        report.errors.push({ id: '(账本)', error: `复制账本写入失败：${err?.message || err}` });
      }
    }
  }

  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  // 汇总后清理：铺满完成后删掉其他账号的冗余副本，磁盘回到「只占一份」
  if (pruneOthers) {
    // 保留哪个档位由调用方决定（在国内 tab 点就保留国内账号，在国际 tab 点就保留国际账号）
    const kv = ['cn', 'ai'].includes(String(keepVariant)) ? String(keepVariant) : (currentUidOfVariant('cn') ? 'cn' : 'ai');
    const ov = kv === 'cn' ? 'ai' : 'cn';
    // ⓪先把「另一档位」的会话复制进保留档位的当前账号——切换过去能直接看到
    try {
      const keepUid0 = currentUidOfVariant(kv) || '';
      const __pt = Date.now();
      const cross = await copyVariantIntoAccount({ sourceVariant: ov, targetVariant: kv, targetUid: keepUid0, dryRun });
      console.log(`[sync] 跨档位复制 ${Date.now() - __pt}ms`);
      report.crossVariantCopy = {
        copied: cross.copied.length,
        skipped: cross.skipped.length,
        freedBytes: cross.totalBytes,
        errors: cross.errors.length,
        dryRun: cross.dryRun,
        from: ov,
        to: kv,
      };
      if (cross.errors.length) {
        report.errors.push(...cross.errors.map((e) => ({ id: e.id, error: `跨档位复制失败：${e.error}` })));
      }
    } catch (err) {
      report.errors.push({ id: '', error: `跨档位复制失败：${err?.message || err}` });
    }
    // ①先把「其他国内账号独有的对话」汇总进当前账号（单向，不铺满）
    try {
      const __pt = Date.now();
      const collected = await collectIntoCurrent({ variantId: kv, dryRun });
      console.log(`[sync] 汇总独有会话 ${Date.now() - __pt}ms`);
      report.collected = {
        copied: collected.copied.length,
        skipped: collected.skipped.length,
        bytes: collected.totalBytes,
        errors: collected.errors.length,
        dryRun: collected.dryRun,
        items: collected.copied.slice(0, 50).map((x) => ({ title: x.title, mb: +((x.bytes || 0) / 1048576).toFixed(2) })),
      };
      if (collected.errors.length) {
        report.errors.push(...collected.errors.map((e) => ({ id: e.id, error: `汇总会话失败：${e.error}` })));
      }
    } catch (err) {
      report.errors.push({ id: '', error: `汇总会话失败：${err?.message || err}` });
    }
    // ②先处理「当前账号内同一对话多份」：合并成最完整的一份（内容取全）
    try {
      const mergeUid = currentUidOfVariant(kv) || '';
      const __pt = Date.now();
      const merged = await mergeWithinAccount({ uid: mergeUid, variantId: kv, dryRun });
      console.log(`[sync] 同账号合并 ${Date.now() - __pt}ms`);
      report.mergedWithin = {
        groups: merged.groups.length,
        removed: merged.groups.reduce((s, g) => s + g.merged.length, 0),
        freedBytes: merged.freedBytes,
        errors: merged.errors.length,
        dryRun: merged.dryRun,
      };
      if (merged.errors.length) {
        report.errors.push(...merged.errors.map((e) => ({ id: e.id, error: `同账号合并失败：${e.error}` })));
      }
    } catch (err) {
      report.errors.push({ id: '', error: `同账号合并失败：${err?.message || err}` });
    }
    try {
      const keepUid = currentUidOfVariant('cn') || currentUidOfVariant('ai') || '';
      // 安全闸：只要汇总阶段有失败，就不清理其他账号（避免「没复制成功却把源删了」）
      if (report.collected && report.collected.errors) {
        report.prune = { pruned: 0, kept: 0, freedBytes: 0, errors: 0, dryRun, skipped: true };
      } else {
        const __pt = Date.now();
        const pruned = await pruneOtherAccounts({ keepUid, dryRun });
        console.log(`[sync] 其它账号清理 ${Date.now() - __pt}ms`);
        report.prune = {
          pruned: pruned.pruned.length,
          kept: pruned.kept.length,
          freedBytes: pruned.freedBytes,
          errors: pruned.errors.length,
          dryRun: pruned.dryRun,
        };
        if (pruned.errors.length) {
          report.errors.push(...pruned.errors.map((e) => ({ id: e.id, error: `清理失败：${e.error}` })));
        }
      }
    } catch (err) {
      report.errors.push({ id: '', error: `汇总后清理失败：${err?.message || err}` });
    }
    // ③跨档位清理：另一档位里已经和保留账号重复的会话也要删掉，做到「全局只留一份」
    try {
      const keepUid2 = currentUidOfVariant(kv) || '';
      if (report.crossVariantCopy && report.crossVariantCopy.errors) {
        // 安全闸：跨档位复制有失败就不删，避免「没复制成功却把源删了」
        report.variantPrune = { pruned: 0, kept: 0, freedBytes: 0, errors: 0, dryRun, skipped: true };
      } else {
        const __pt = Date.now();
        const vp = await pruneVariantAgainst({ keepVariant: kv, otherVariant: ov, keepUid: keepUid2, dryRun });
        console.log(`[sync] 跨档位清理 ${Date.now() - __pt}ms`);
        report.variantPrune = {
          pruned: vp.pruned.length,
          kept: vp.kept.length,
          freedBytes: vp.freedBytes,
          errors: vp.errors.length,
          dryRun: vp.dryRun,
          from: ov,
        };
        if (vp.errors.length) {
          report.errors.push(...vp.errors.map((e) => ({ id: e.id, error: `跨档位清理失败：${e.error}` })));
        }
      }
    } catch (err) {
      report.errors.push({ id: '', error: `跨档位清理失败：${err?.message || err}` });
    }
  }

  return report;
}

/* ------------------------------------------------------------------ *
 * 一键去重：同账号内同一家族的多余副本合并进最完整的一份
 * ------------------------------------------------------------------ */

/**
 * 清理重复会话（最简安全版）：
 *   每个账号内，把「标题相同 + 正文前 1MB（会话 id 归一化后）完全一致」的会话判为
 *   同一对话的多份副本 → 保留正文最大的那份，其余软删除（deleted_at 打标记，与
 *   客户端删除同款；正文文件保留在磁盘上，随时可恢复）。复制账本同步改指保留者，
 *   保证后续一键同步仍走原位合并、不再产生新副本。
 *
 * 为什么不做「内容合并」：同一对话的副本内容本就 99% 相同，合并的复杂度（超大单行
 * / 内存 / 卡死）远大于收益；先把重复清掉，用户真正的诉求（列表只有一份）即达成，
 * 且全程有 db 备份 + 正文保留，任何情况都能恢复。
 *
 * @param {object}  opts
 * @param {boolean} opts.dryRun 预演：只统计不做任何写入
 */
export async function dedupeSessions({ dryRun = false } = {}) {
  const started = Date.now();
  const report = { ok: true, dryRun, groups: [], removed: [], renamed: [], errors: [], elapsedMs: 0 };
  const accounts = loadAccounts().filter((a) => a?.uid);
  const byVariant = new Map();
  for (const a of accounts) {
    const v = variantOf(a).id;
    if (!byVariant.has(v)) byVariant.set(v, []);
    byVariant.get(v).push(String(a.uid));
  }

  for (const [variantId, uids] of byVariant) {
    if (!(await sessionCopySupported(variantId))) continue;
    const index = indexProjectBodies(variantId);
    const family = copyFamilyMap();
    const backupPath = dryRun ? null : backupSessionDb(variantId);
    const db = await openSessionDb(variantId, { readOnly: dryRun });
    try {
      let __dc = 0;
      for (const uid of uids) {
        if (++__dc % 2 === 0) await yieldToLoop();
        const rows = db
          .prepare('SELECT * FROM sessions WHERE user_id = ? AND deleted_at IS NULL')
          .all(uid);
        // 按「内容指纹」分组：同一段对话的副本指纹相同——名字被改成什么都能认出来；
        // 名字相同但内容不同的对话不会被误判（它们指纹不同）。
        const byFingerprint = new Map();
        for (const r of rows) {
          const p = index.get(String(r.id));
          if (!p) continue;
          const fp = contentFingerprintText(p, String(r.id));
          if (!fp) continue;
          if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
          byFingerprint.get(fp).push(r);
        }
        for (const [, group] of byFingerprint) {
          if (group.length < 2) continue;
          // 两两判同一对话（id 归一化前缀比对，已在生产数据上验证 0.0s）
          const par = new Map(group.map((r) => [String(r.id), String(r.id)]));
          const fnd = (x) => {
            let r = x;
            while (par.get(r) !== undefined && par.get(r) !== r) r = par.get(r);
            let c = x;
            while (par.get(c) !== undefined && par.get(c) !== r) {
              const n = par.get(c);
              par.set(c, r);
              c = n;
            }
            return r;
          };
          const paths = new Map();
          for (const r of group) {
            const p = index.get(String(r.id));
            if (p) paths.set(String(r.id), p);
          }
          const ids = [...paths.keys()];
          // 指纹相同的再确认「逐字节全等」：完全一样才删；有差异的（内容多少不同）保留
          for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
              let same = false;
              try {
                same = filesIdenticalNorm(paths.get(ids[i]), ids[i], paths.get(ids[j]), ids[j]);
              } catch {
                same = false;
              }
              if (same) {
                const ri = fnd(ids[i]);
                const rj = fnd(ids[j]);
                if (ri !== rj) par.set(ri, rj);
              }
            }
          }
          // 按并查集的连通分量分簇处理：只有「id 归一化后逐字节全等」的会话才是
          // 同一份的副本。⚠️ 此前这里写的是 `new Map([['ALL', group]])`——把整个
          // 指纹组当一簇合并，上面 O(n²) 全等比对的结果算完即弃（死代码）：两个
          // **不同对话**只要前 20 条消息文本相同（同模板/同开场白极常见）就会被
          // 并集合并成一份再软删其余，内容混串（2026-10-26 体检 M8）。内容有多有少
          // 但确属同一对话的场景由「同步」功能（syncContentBetween）负责，去重只删
          // 真正的全等副本——宁可少删，不可错并
          const rowOf = new Map(group.map((r) => [String(r.id), r]));
          const byRoot = new Map();
          for (const id of ids) {
            const root = fnd(id);
            if (!byRoot.has(root)) byRoot.set(root, []);
            byRoot.get(root).push(rowOf.get(id));
          }
          const clusters = byRoot;
          for (const [, cluster] of clusters) {
            if (cluster.length < 2) continue;
            const sized = cluster
              .map((r) => ({ row: r, id: String(r.id), size: bodySize(index.get(String(r.id))) }))
              .sort((a, b) => b.size - a.size || Number(b.row.updated_at) - Number(a.row.updated_at));
            const keeper = sized[0];
            const droppers = sized.slice(1);
            const g = {
              account: uid,
              accountName: nameOfUid(uid),
              keeper: { id: keeper.id, title: displayTitle(keeper.row.title, keeper.row.custom_title), bytes: keeper.size },
              removed: droppers.map((d) => ({ id: d.id, title: displayTitle(d.row.title, d.row.custom_title), bytes: d.size })),
            };
            try {
              // 内容有多有少但同属一个对话 → 并集合并进保留者正文（先合并，再删副本）
              // 合并失败则整组跳过，谁都不删，避免丢内容
              if (!dryRun && droppers.length) {
                const parts = sized
                  .map((x) => ({ id: x.id, file: index.get(String(x.id)) }))
                  .filter((x) => x.file);
                const keeperPath = index.get(keeper.id);
                if (keeperPath && parts.length > 1) {
                  // keeper 正文合并前先备份（db 备份不含正文；与 moveSessionsToAccount 的
                  // before-merge 备份对齐——此前这里合并坏了没有任何还原点）
                  if (backupPath) {
                    try {
                      const bd = path.join(backupPath, 'bodies');
                      fs.mkdirSync(bd, { recursive: true });
                      fs.copyFileSync(keeperPath, path.join(bd, keeper.id + '.before-merge.jsonl'));
                    } catch {
                      /* 备份失败不阻断合并（mergeUnion 自带校验，失败不落地） */
                    }
                  }
                  const mr = mergeUnion(parts, keeper.id, keeperPath);
                  if (!mr.ok) {
                    report.errors.push({ account: uid, error: `合并失败，已跳过该组：${mr.error}`, keeper: keeper.id });
                    continue;
                  }
                  g.mergedLines = mr.lines;
                  g.mergedBytes = mr.bytes;
                  g.deduped = mr.dup;
                }
              }
              // 名字：组内最新的手改名（源侧改名随同步传播，这里兜住孤儿）
              const named = cluster
                .filter((r) => String(r.custom_title || '').trim())
                .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))[0];
              if (named && String(named.custom_title).trim() !== String(keeper.row.custom_title || '').trim()) {
                if (!dryRun) db.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run(String(named.custom_title).trim(), keeper.id);
                report.renamed.push({ id: keeper.id, title: String(named.custom_title).trim() });
              }
              // 软删多余副本 + 账本改指保留者
              if (!dryRun) {
                const now = Date.now();
                const dropIds = new Set(droppers.map((d) => d.id));
                for (const d of droppers) {
                  db.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ? AND user_id = ?').run(now, d.id, uid);
                }
                const ledger = loadCopies();
                let changed = false;
                for (const [, table] of Object.entries(ledger.pairs)) {
                  for (const [srcId, copyId] of Object.entries(table)) {
                    if (dropIds.has(String(copyId))) {
                      table[srcId] = keeper.id;
                      changed = true;
                    }
                  }
                  for (const srcId of Object.keys(table).filter((k) => dropIds.has(k))) {
                    if (!(keeper.id in table)) table[keeper.id] = table[srcId];
                    delete table[srcId];
                    changed = true;
                  }
                }
                if (changed) {
                  ledger.version = 1;
                  fs.mkdirSync(STORE_DIR, { recursive: true });
                  await atomicWriteJsonAsync(SESSION_COPIES_FILE, ledger);
                }
              }
              report.removed.push(...g.removed.map((r) => ({ ...r, account: uid })));
              report.appendedLines = (report.appendedLines || 0) + (g.mergedLines || 0);
              report.groups.push(g);
            } catch (err) {
              report.errors.push({ account: uid, error: err?.message || String(err) });
            }
          }
        }
      }
    } finally {
      db.close();
    }
    if (!dryRun && backupPath) report.backupPath = backupPath;
  }
  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  return report;
}


function nameOfUid(uid) {
  const a = findAccount(uid) || loadAccounts().find((x) => String(x.uid) === String(uid));
  return a ? accountDisplayName(a) : String(uid || '').slice(0, 8);
}

/* ------------------------------------------------------------------ *
 * 搬家式转移（零额外磁盘）：会话跟着当前账号走
 * ------------------------------------------------------------------ */

/**
 * 把当前登录账号的会话「过户」给目标账号——不复制、不占额外磁盘。
 *
 * 核心事实：WorkBuddy 的会话正文按「会话编号」存放（projects/<项目>/<会话id>.jsonl），
 * 路径不含账号。因此「换个账号拥有同一会话」只需改数据库里的 user_id 归属，
 * 正文文件原地不动（毫秒级、磁盘零增长）。
 *
 * 对每个源会话：
 *   - 目标账号已有同一对话（账本/家族/标题+内容判定）→ 内容合并取全（字节级流式），
 *     目标副本留下、源副本软删除；
 *   - 目标账号没有 → 会话行直接过户（UPDATE user_id），正文文件不动。
 * 结束后：目标账号拥有两边会话的并集，每个对话只有一份；源账号名下清空。
 *
 * @param {object}   opts
 * @param {string}   opts.targetAccountId 目标账号
 * @param {string[]} [opts.ids]           只处理这些源会话 id（缺省＝全部）
 * @param {boolean}  [opts.dryRun]        预演：只统计不动任何数据
 */
export async function moveSessionsToAccount({ targetAccountId, ids = null, dryRun = false, sourceVariant = null } = {}) {
  const started = Date.now();
  const report = {
    ok: true,
    dryRun,
    sourceUid: '',
    targetUid: '',
    moved: [],      // 直接过户的会话
    merged: [],     // 合并进目标已有副本的会话
    renamed: [],
    skippedDeleted: [], // 目标账号已删除同一对话 → 不搬（尊重删除）
    errors: [],
    totalBytes: 0,
    elapsedMs: 0,
  };

  const target = findAccount(targetAccountId);
  if (!target) throw Object.assign(new Error('找不到目标账号'), { status: 404 });
  const targetVariant = variantOf(target).id;
  const targetUid = String(target.uid || '').trim();
  if (!targetUid) throw new Error('目标账号缺少 uid');

  // 源档位：优先用前端传入的「当前正在看的档位」；缺省回落到目标账号所在档位。
  // 这样「国内 tab 里点国际版账号的同步会话」= 把国内会话搬到国际版，反之亦然。
  const sourceVariantId = ['cn', 'ai'].includes(String(sourceVariant)) ? String(sourceVariant) : targetVariant;
  const sourceUid = currentUidOfVariant(sourceVariantId);
  if (!sourceUid) throw new Error('未读取到当前档位的登录态');
  if (sourceUid === targetUid) throw new Error('源账号与目标账号相同，无需搬家');

  report.sourceUid = sourceUid;
  report.targetUid = targetUid;
  report.sourceVariant = sourceVariantId;
  report.targetVariant = targetVariant;

  if (sourceVariantId !== targetVariant) {
    return moveAcrossVariants({ sourceVariant: sourceVariantId, targetVariant, sourceUid, targetUid, ids, dryRun, report, started });
  }

  const variantId = targetVariant;
  if (!(await sessionCopySupported(variantId))) throw new Error('当前档位的会话数据不可用');

  const index = indexProjectBodies(variantId);
  const family = copyFamilyMap();
  const ancestorOf = copyAncestorMap();
  const db = await openSessionDb(variantId, { readOnly: dryRun });
  const backupPath = dryRun ? null : backupSessionDb(variantId);
  if (backupPath) report.backupPath = backupPath;

  try {
    let sourceRows = db
      .prepare('SELECT * FROM sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(sourceUid);
    if (Array.isArray(ids) && ids.length) {
      const want = new Set(ids.map(String));
      sourceRows = sourceRows.filter((r) => want.has(String(r.id)));
    }
    const targetRows = db
      .prepare('SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL')
      .all(targetUid)
      .map((r) => String(r.id));

    // 目标账号：家族根 → 会话 id（用于「同一对话」匹配）
    const byFamRoot = new Map();
    for (const tid of targetRows) byFamRoot.set(family.rootOf(tid), tid);
    // 标题归一化 → 目标会话 id（家族之外的孤儿兜底）
    const normTitle = (row) =>
      String(row.custom_title || row.title || '')
        .replace(/[\s《》「」"'‘’“”（）()\[\]【】—\-–_.·]/g, '')
        .toLowerCase();
    const targetById = new Map(
      db.prepare('SELECT * FROM sessions WHERE user_id = ? AND deleted_at IS NULL').all(targetUid).map((r) => [String(r.id), r])
    );
    const byTitle = new Map();
    for (const [tid, row] of targetById) {
      const k = normTitle(row);
      if (k && !byTitle.has(k)) byTitle.set(k, tid);
    }

    const findPeer = (cid, row) => {
      // 1) 家族根（含账本、祖先链）
      const root = family.rootOf(cid);
      if (byFamRoot.has(root) && byFamRoot.get(root) !== cid) return byFamRoot.get(root);
      // 2) 账本记录
      const ledger = sessionCopyLedger(variantId, sourceUid, targetUid);
      const prev = String(ledger[cid] || '');
      if (prev && targetById.has(prev)) return prev;
      // 3) 内容指纹兜底（与名字无关：名字被改过、账本编号失效都能认亲）
      {
        const a = index.get(String(cid));
        if (a) {
          const fp = contentFingerprintText(a, cid);
          if (fp) {
            for (const [tid, tpath] of index.entries()) {
              if (!targetById.has(String(tid))) continue;
              if (String(tid) === String(cid)) continue;
              try {
                if (contentFingerprintText(tpath, String(tid)) === fp) return String(tid);
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
      return null;
    };

    const ledgerAdds = [];
    // 尊重删除：目标账号里「用户手动删过」的对话指纹，搬家前先比对，命中就不搬
    const deletedFps = deletedFingerprintsOf(db, targetUid, index);
    for (const row of sourceRows) {
      const cid = String(row.id);
      const size = bodySize(index.get(cid)) || 0;
      try {
        // 目标账号已删过同一对话 → 不搬，避免删掉的会话又冒出来
        {
          const srcPath = index.get(cid);
          const srcFp = srcPath ? contentFingerprint(srcPath, cid) : '';
          if (srcFp && deletedFps.has(srcFp)) {
            report.skippedDeleted.push({
              id: cid,
              title: displayTitle(row.title, row.custom_title),
              bytes: size,
              reason: '目标账号已删除同一对话',
            });
            continue;
          }
        }
        const peer = findPeer(cid, row);
        if (peer) {
          // 目标已有同一对话：内容合并取全 + 名字取最新 + 软删源副本
          if (!dryRun) {
            const fromPath = index.get(cid);
            const toPath = index.get(peer);
            const moveBackupDir = path.join(STORE_DIR, 'backups', 'moved-out');
            if (fromPath && toPath) {
              fs.mkdirSync(moveBackupDir, { recursive: true });
              try {
                fs.copyFileSync(toPath, path.join(moveBackupDir, 'before-merge-' + peer + '.jsonl'));
              } catch {
                /* 备份失败不阻断 */
              }
              const mr = mergeUnion(
                [
                  { id: cid, file: fromPath },
                  { id: peer, file: toPath },
                ],
                peer,
                toPath
              );
              if (!mr.ok) {
                // 合并失败 → 不删源、不过户，避免丢内容
                report.errors.push({ id: cid, error: `合并失败，已保留源副本：${mr.error}` });
                continue;
              }
            }
            const peerRow = targetById.get(peer);
            const newer =
              (!peerRow || Number(row.updated_at) > Number(peerRow.updated_at)) && String(row.custom_title || '').trim()
                ? String(row.custom_title).trim()
                : null;
            if (newer)
              await retryDbWrite(() =>
                db.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run(newer, peer)
              );
            await retryDbWrite(() =>
              db.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(Date.now(), cid)
            );
            ledgerAdds.push({ sourceId: cid, newId: peer });
            // 源正文同盘移动进备份目录：磁盘不再保留重复内容，但随时可找回
            if (fromPath && toPath && fromPath !== toPath) {
              try {
                fs.mkdirSync(moveBackupDir, { recursive: true });
                fs.renameSync(fromPath, path.join(moveBackupDir, cid + '.jsonl'));
              } catch {
                /* 移动失败不影响主流程 */
              }
            }
          }
          report.merged.push({ sourceId: cid, targetId: peer, title: displayTitle(row.title, row.custom_title), bytes: size });
        } else {
          // 目标没有：直接过户（改归属，正文文件不动）
          if (!dryRun) {
            // 撞锁/被杀软拦一下就重试：一次抖动不该让整条会话算失败
            const res = await retryDbWrite(() =>
              db
                .prepare('UPDATE sessions SET user_id = ?, updated_at = MAX(updated_at, ?) WHERE id = ?')
                .run(targetUid, Date.now(), cid)
            );
            if (!res || Number(res.changes) < 1) {
              throw new Error('UPDATE 未命中任何行（会话可能已被删除或已被别的连接改走）');
            }
          }
          report.moved.push({ id: cid, title: displayTitle(row.title, row.custom_title), bytes: size });
          byFamRoot.set(family.rootOf(cid), cid);
          targetById.set(cid, row);
          const k = normTitle(row);
          if (k && !byTitle.has(k)) byTitle.set(k, cid);
        }
        report.totalBytes += size;
      } catch (err) {
        report.errors.push({ id: cid, error: err?.message || String(err) });
      }
    }

    if (!dryRun && ledgerAdds.length) {
      await recordCopies(variantId, sourceUid, targetUid, ledgerAdds);
    }
  } finally {
    db.close();
  }

  /**
   * 写后回读校验（新连接）。
   *
   * node:sqlite 的 UPDATE 偶尔会「报告成功但没生效」——库被正在重启的 WorkBuddy 实例
   * 或安全软件回滚了。此前这种静默失败会直接算进 moved，界面提示成功、用户回到会话列表
   * 却发现会话还在原账号（2026-10-25 反馈）。这里复核一遍，把静默失败变成明确错误。
   */
  if (!dryRun && (report.moved.length || report.merged.length)) {
    try {
      const checkDb = await openSessionDb(variantId, { readOnly: true });
      try {
        const notApplied = [];
        for (const m of report.moved) {
          const row = checkDb.prepare('SELECT user_id FROM sessions WHERE id = ?').get(String(m.id));
          if (!row || String(row.user_id) !== String(targetUid)) notApplied.push(m.id);
        }
        for (const m of report.merged) {
          const row = checkDb.prepare('SELECT user_id, deleted_at FROM sessions WHERE id = ?').get(String(m.sourceId));
          if (row && row.deleted_at == null) notApplied.push(m.sourceId);
        }
        report.verified = notApplied.length === 0;
        for (const id of notApplied) {
          report.errors.push({
            id,
            error: '写入未生效（库被其它进程回滚，通常是有 WorkBuddy 实例正在运行），请退出 WorkBuddy 后重试',
          });
        }
      } finally {
        checkDb.close();
      }
    } catch (err) {
      report.verified = null;
      report.verifyError = err?.message || String(err);
    }
  }

  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  return report;
}

/* ------------------------------------------------------------------ *
 * 跨档位搬家（国内 ↔ 国际版）：两套独立数据库 + 两套 projects 目录，
 * 同一块磁盘内用 rename 移动正文（秒级、零额外磁盘）。
 * ------------------------------------------------------------------ */

/** 在目标档位找同一对话：标题相同 + 内容会话-id-归一化后前缀一致（前 1MB） */
function findPeerInVariant({ sourceRow, sourceVariant, targetVariant, targetUid, sourceIndex }) {
  const normTitle = (r) =>
    String(r.custom_title || r.title || '')
      .replace(/[\s《》「」"'‘’“”（）()\[\]【】—\-–_.·]/g, '')
      .toLowerCase();
  const key = normTitle(sourceRow);
  const targetIndex = indexProjectBodies(targetVariant);
  const { DatabaseSync } = sqliteModule || {};
  // 用同步方式打开目标库（已在 async 上下文，node:sqlite 的 DatabaseSync 本身同步）
  const dbPath = sessionDbPath(targetVariant);
  if (!fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    const rows = db
      .prepare('SELECT * FROM sessions WHERE user_id = ? AND deleted_at IS NULL')
      .all(targetUid);
    const candidates = rows.filter((r) => normTitle(r) === key);
    const srcPath = sourceIndex.get(String(sourceRow.id));
    if (!srcPath) return candidates[0] ? { row: candidates[0], path: targetIndex.get(String(candidates[0].id)) || null } : null;
    for (const cand of candidates) {
      const candPath = targetIndex.get(String(cand.id));
      if (!candPath) continue;
      try {
        if (findNormCommonPrefixLen(srcPath, String(sourceRow.id), candPath, String(cand.id)).prefix > 1024) {
          return { row: cand, path: candPath };
        }
      } catch {
        /* 比对失败跳过 */
      }
    }
    return null;
  } finally {
    db.close();
  }
}

/** 跨档位搬家：逐会话合并或过户到目标档位 */
async function moveAcrossVariants({ sourceVariant, targetVariant, sourceUid, targetUid, ids, dryRun, report, started }) {
  const { DatabaseSync } = await sqlite();
  if (!(await sessionCopySupported(sourceVariant))) throw new Error('源档位的会话数据不可用');
  if (!(await sessionCopySupported(targetVariant))) throw new Error('目标档位的会话数据不可用');

  const sourceIndex = indexProjectBodies(sourceVariant);
  const targetRoot = sessionDataRoot(targetVariant);
  const targetProjects = path.join(targetRoot, 'projects');
  const backupDir = path.join(STORE_DIR, 'backups', 'moved-out');

  const srcDb = await openSessionDb(sourceVariant, { readOnly: dryRun });
  const dstDb = await openSessionDb(targetVariant, { readOnly: false });
  const dstPath = sessionDbPath(targetVariant);
  // 目标库与源库都要备份：下面会对**源库**执行不可逆的软删（UPDATE deleted_at），
  // 只备份目标库的话源库没有任何还原点（2026-10-26 体检发现）
  const srcBackup = dryRun ? null : backupSessionDb(sourceVariant);
  const dstBackup = dryRun ? null : backupSessionDb(targetVariant);
  if (dstBackup) report.backupPath = dstBackup;
  if (srcBackup) report.sourceBackupPath = srcBackup;

  // 尊重删除：目标档位里被用户手动删过的对话指纹
  const targetIndex = indexProjectBodies(targetVariant);
  const deletedFps = deletedFingerprintsOf(dstDb, targetUid, targetIndex);

  try {
    let rows = srcDb
      .prepare('SELECT * FROM sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(sourceUid);
    if (Array.isArray(ids) && ids.length) {
      const want = new Set(ids.map(String));
      rows = rows.filter((r) => want.has(String(r.id)));
    }

    for (const row of rows) {
      const cid = String(row.id);
      const size = bodySize(sourceIndex.get(cid)) || 0;
      try {
        // 目标档位已删过同一对话 → 不搬
        {
          const srcPath = sourceIndex.get(cid);
          const srcFp = srcPath ? contentFingerprint(srcPath, cid) : '';
          if (srcFp && deletedFps.has(srcFp)) {
            report.skippedDeleted.push({
              id: cid,
              title: displayTitle(row.title, row.custom_title),
              bytes: size,
              reason: '目标档位已删除同一对话',
            });
            continue;
          }
        }
        const peer = findPeerInVariant({ sourceRow: row, sourceVariant, targetVariant, targetUid, sourceIndex });
        if (peer && peer.path) {
          // 目标档位已有同一对话：把源正文复制进目标档位，按时间有序合并，然后移走源文件
          if (!dryRun) {
            const fromPath = sourceIndex.get(cid);
            if (fromPath) {
              const tmpDir = path.join(targetProjects, '.incoming');
              fs.mkdirSync(tmpDir, { recursive: true });
              const tmp = path.join(tmpDir, cid + '.jsonl');
              fs.copyFileSync(fromPath, tmp);
              const peerId = String(peer.row.id);
              // 目标（peer）正文合并前先备份到搬家备份目录（此前跨档位合并无正文还原点）
              if (dstBackup) {
                try {
                  const bd = path.join(dstBackup, 'bodies');
                  fs.mkdirSync(bd, { recursive: true });
                  fs.copyFileSync(peer.path, path.join(bd, peerId + '.before-merge.jsonl'));
                } catch {
                  /* 备份失败不阻断合并 */
                }
              }
              let mr;
              try {
                mr = mergeUnion(
                  [
                    { id: cid, file: tmp },
                    { id: peerId, file: peer.path },
                  ],
                  peerId,
                  peer.path
                );
              } finally {
                fs.rmSync(tmp, { force: true });
              }
              if (!mr || !mr.ok) {
                report.errors.push({ id: cid, error: `跨档位合并失败，已保留源副本：${mr?.error || '未知错误'}` });
                continue;
              }
              // 名字取更新
              if (
                String(row.custom_title || '').trim() &&
                Number(row.updated_at) > Number(peer.row.updated_at || 0)
              ) {
                dstDb.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run(String(row.custom_title).trim(), String(peer.row.id));
              }
              // 源行软删 + 源正文移入备份（省磁盘）
              srcDb.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(Date.now(), cid);
              try {
                fs.mkdirSync(backupDir, { recursive: true });
                fs.renameSync(fromPath, path.join(backupDir, cid + '.jsonl'));
              } catch {
                /* 移动失败不影响结果 */
              }
            }
          }
          report.merged.push({ sourceId: cid, targetId: String(peer.row.id), title: displayTitle(row.title, row.custom_title), bytes: size });
        } else {
          // 目标档位没有：在目标库插入会话行（沿用同一会话 id）+ 正文移动到目标 projects 同相对路径
          if (!dryRun) {
            const fromPath = sourceIndex.get(cid);
            if (fromPath) {
              const rel = path.relative(path.join(sessionDataRoot(sourceVariant), 'projects'), fromPath);
              const destPath = path.join(targetProjects, rel);
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              // 先插行、后移正文：插行失败时源数据原封不动；移正文失败时补偿删掉
              // 已插的行——绝不能出现「正文已搬走、两边库里都没有行」的孤儿
              // （此前先 rename 再 INSERT，INSERT 一失败正文就成孤儿，2026-10-26 体检发现）
              const cols = Object.keys(row);
              const placeholders = cols.map(() => '?').join(', ');
              const values = cols.map((c) => (c === 'user_id' ? targetUid : row[c]));
              dstDb.prepare(`INSERT OR REPLACE INTO sessions (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`).run(...values);
              try {
                fs.renameSync(fromPath, destPath);
              } catch (err) {
                try {
                  dstDb.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(cid, targetUid);
                } catch {
                  /* 补偿失败只能如实报错 */
                }
                throw err;
              }
              srcDb.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(Date.now(), cid);
            }
          }
          report.moved.push({ id: cid, title: displayTitle(row.title, row.custom_title), bytes: size });
        }
        report.totalBytes += size;
      } catch (err) {
        report.errors.push({ id: cid, error: err?.message || String(err) });
      }
    }
  } finally {
    srcDb.close();
    dstDb.close();
  }

  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  return report;
}

/**
 * 跨档位内容同步（国内 ↔ 国际）：把两个档位里「同一对话」的内容按时间有序合并到两边，
 * 名字取最新——两边都保留各自的会话（不搬动归属、不删除任何会话）。
 * 只处理标题相同且内容前缀一致的配对；内容无关的同名会话一律跳过。
 */
export async function syncAcrossVariants({ dryRun = false, backupDir = null } = {}) {
  const started = Date.now();
  const report = { ok: true, dryRun, pairs: 0, synced: [], errors: [], elapsedMs: 0 };
  const accs = loadAccounts().filter((a) => a?.uid);
  const groups = new Map();
  for (const a of accs) {
    const v = variantOf(a).id;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(String(a.uid));
  }
  const variants = [...groups.keys()];
  if (variants.length < 2) return report;

  const { DatabaseSync } = await sqlite();
  const normTitle = (r) =>
    String(r.custom_title || r.title || '')
      .replace(/[\s《》「」"'‘’“”（）()\[\]【】—\-–_.·]/g, '')
      .toLowerCase();

  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const vA = variants[i];
      const vB = variants[j];
      if (!(await sessionCopySupported(vA)) || !(await sessionCopySupported(vB))) continue;
      const idxA = indexProjectBodies(vA);
      const idxB = indexProjectBodies(vB);
      const dbA = new DatabaseSync(sessionDbPath(vA), { readOnly: dryRun, timeout: 8000 });
      const dbB = new DatabaseSync(sessionDbPath(vB), { readOnly: dryRun, timeout: 8000 });
      try {
        const listA = groups.get(vA);
        const listB = groups.get(vB);
        const rowsA = dbA
          .prepare('SELECT * FROM sessions WHERE user_id IN (' + listA.map(() => '?').join(',') + ') AND deleted_at IS NULL')
          .all(...listA);
        const rowsB = dbB
          .prepare('SELECT * FROM sessions WHERE user_id IN (' + listB.map(() => '?').join(',') + ') AND deleted_at IS NULL')
          .all(...listB);
        let __cy = 0;
        for (const aRow of rowsA) {
          if (++__cy % 3 === 0) await yieldToLoop();
          const keyA = normTitle(aRow);
          if (!keyA) continue;
          const pathA = idxA.get(String(aRow.id));
          if (!pathA) continue;
          for (const bRow of rowsB) {
            if (normTitle(bRow) !== keyA) continue;
            const pathB = idxB.get(String(bRow.id));
            if (!pathB) continue;
            let same = false;
            try {
              same = findNormCommonPrefixLen(pathA, String(aRow.id), pathB, String(bRow.id)).prefix > 1024;
            } catch {
              same = false;
            }
            if (!same) continue;
            report.pairs++;
            if (dryRun) {
              report.synced.push({ a: String(aRow.id), b: String(bRow.id), title: displayTitle(aRow.title, aRow.custom_title), dryRun: true });
              continue;
            }
            try {
              // 并集合并进 A 侧，再等长复制到 B 侧（两边都拿到全量，不丢消息）
              const mr = mergeUnion(
                [
                  { id: String(aRow.id), file: pathA },
                  { id: String(bRow.id), file: pathB },
                ],
                String(aRow.id),
                pathA
              );
              if (!mr.ok) {
                report.errors.push({ a: String(aRow.id), b: String(bRow.id), error: `合并失败：${mr.error}` });
                break;
              }
              byteCopyReplace(pathA, String(aRow.id), pathB, String(bRow.id));
              if (String(aRow.custom_title || '').trim() && Number(aRow.updated_at) > Number(bRow.updated_at || 0)) {
                dbB.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run(String(aRow.custom_title).trim(), String(bRow.id));
              } else if (String(bRow.custom_title || '').trim() && Number(bRow.updated_at) > Number(aRow.updated_at || 0)) {
                dbA.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run(String(bRow.custom_title).trim(), String(aRow.id));
              }
              report.synced.push({ a: String(aRow.id), b: String(bRow.id), title: displayTitle(aRow.title, aRow.custom_title) });
            } catch (err) {
              report.errors.push({ a: String(aRow.id), b: String(bRow.id), error: err?.message || String(err) });
            }
            break;
          }
        }
      } finally {
        dbA.close();
        dbB.close();
      }
    }
  }
  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  return report;
}

/**
 * 汇总后清理：把「非当前登录账号」里的会话副本删掉（软删 + 正文移入备份目录），
 * 只保留当前账号的一份完整汇总——磁盘永久回到「只占一份」。
 *
 * 安全约束：**只删那些「当前账号有同一对话（内容指纹一致）」的副本**；
 * 当前账号没有的会话（独有的）一律保留，绝不让数据凭空消失。
 */
export async function pruneOtherAccounts({ keepUid = null, dryRun = false, backupDir = null } = {}) {
  const started = Date.now();
  const report = { ok: true, dryRun, keptUid: '', pruned: [], kept: [], errors: [], freedBytes: 0, elapsedMs: 0 };
  const keep = String(keepUid || '').trim();
  if (!keep) throw new Error('缺少要保留的账号');
  report.keptUid = keep;

  const targetVariant = variantOf(findAccount(keep) || {}).id || 'cn';
  if (!(await sessionCopySupported(targetVariant))) throw new Error('当前档位的会话数据不可用');

  const index = indexProjectBodies(targetVariant);
  const db = await openSessionDb(targetVariant, { readOnly: dryRun });
  const backupPath = dryRun ? null : backupSessionDb(targetVariant);
  if (backupPath) report.backupPath = backupPath;

  try {
    // 当前账号每个会话的内容指纹集合
    const keepRows = db.prepare('SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL').all(keep);
    const keepSigs = []; // 当前账号每条对话的消息集合
    const keepPaths = []; // 与 keepSigs 同下标：当前账号该对话的正文路径
    for (const r of keepRows) {
      const p = index.get(String(r.id));
      if (!p) continue;
      const sig = contentSignatureSet(p);
      if (sig.size) {
        keepSigs.push(sig);
        keepPaths.push(p);
      }
    }
    // 当前账号「已删除」的对话指纹：这些对话在其他账号里也不该再出现（删除传播）
    const deletedFps = deletedFingerprintsOf(db, keep, index);

    const others = db
      .prepare('SELECT id, user_id, title, custom_title FROM sessions WHERE user_id != ? AND deleted_at IS NULL')
      .all(keep);
    const now = Date.now();
    let __pc = 0;
    for (const row of others) {
      if (++__pc % 20 === 0) await yieldToLoop();
      const cid = String(row.id);
      const p = index.get(cid);
      if (!p) continue;
      const fp = contentFingerprint(p, cid);
      const sig = contentSignatureSet(p);
      const isDeletedInKeep = fp && deletedFps.has(fp);
      if (!isDeletedInKeep) {
        // 只有「当前账号存在同对话」的副本才可能删（按内容重合度判断，合并改写后依然能认出）
        const kIdx = keepSigs.findIndex((k) => looksLikeExisting(sig, [k]));
        if (kIdx < 0) {
          report.kept.push({ id: cid, user_id: String(row.user_id), title: displayTitle(row.title, row.custom_title) });
          continue;
        }
        // 安全判定：该副本的全部消息必须在「当前账号同对话」里存在，否则保留（可能有更全的内容）
        try {
          const keeperPath = keepPaths[kIdx];
          if (!keeperPath) {
            report.kept.push({ id: cid, user_id: String(row.user_id), title: displayTitle(row.title, row.custom_title), reason: 'keeper-missing' });
            continue;
          }
          const copyIds = messageIdSet(p);
          const keeperIds = messageIdSet(keeperPath);
          if (!isSubsetOf(copyIds, keeperIds)) {
            report.kept.push({
              id: cid,
              user_id: String(row.user_id),
              title: displayTitle(row.title, row.custom_title),
              reason: 'more-complete',
              extraMessages: copyIds.size - [...copyIds].filter((x) => keeperIds.has(x)).length,
            });
            continue;
          }
        } catch {
          // 校验失败 → 保守保留
          report.kept.push({ id: cid, user_id: String(row.user_id), title: displayTitle(row.title, row.custom_title), reason: 'check-failed' });
          continue;
        }
      }
      const size = bodySize(p) || 0;
      try {
        if (!dryRun) {
          db.prepare("UPDATE sessions SET deleted_at = ?, status = 'pruned' WHERE id = ? AND user_id = ?").run(now, cid, String(row.user_id));
          const dest = path.join(backupDir || path.join(STORE_DIR, 'backups', 'pruned'), String(row.user_id));
          fs.mkdirSync(dest, { recursive: true });
          fs.renameSync(p, path.join(dest, cid + '.jsonl'));
        }
        report.pruned.push({ id: cid, user_id: String(row.user_id), title: displayTitle(row.title, row.custom_title), bytes: size });
        report.freedBytes += size;
      } catch (err) {
        report.errors.push({ id: cid, error: err?.message || String(err) });
      }
    }
  } finally {
    db.close();
  }

  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  return report;
}

/**
 * 同账号内合并：当前账号里同一对话（内容指纹相同）有多份时，
 * 把它们按时间有序合并进「最完整的那份」，其余副本软删 + 正文移入备份。
 * 用于全量汇总：保证汇总完成后，当前账号每个对话只有一份且内容最全。
 */
export async function mergeWithinAccount({ uid = null, variantId = 'cn', dryRun = false, backupDir = null } = {}) {
  const started = Date.now();
  const report = { ok: true, dryRun, groups: [], errors: [], freedBytes: 0, elapsedMs: 0 };
  const keepUid = String(uid || currentUidOfVariant(variantId) || '').trim();
  if (!keepUid) throw new Error('缺少要处理的账号');
  if (!(await sessionCopySupported(variantId))) throw new Error('当前档位的会话数据不可用');

  const index = indexProjectBodies(variantId);
  const db = await openSessionDb(variantId, { readOnly: dryRun });
  const backupPath = dryRun ? null : backupSessionDb(variantId);
  if (backupPath) report.backupPath = backupPath;

  try {
    const rows = db.prepare('SELECT id, title, custom_title FROM sessions WHERE user_id = ? AND deleted_at IS NULL').all(keepUid);
    const byFp = new Map();
    for (const r of rows) {
      const p = index.get(String(r.id));
      if (!p) continue;
      const fp = contentFingerprintText(p, String(r.id));
      if (!fp) continue;
      if (!byFp.has(fp)) byFp.set(fp, []);
      byFp.get(fp).push(r);
    }

    let yi = 0;
    for (const [, group] of byFp) {
      if (group.length < 2) continue;
      if (++yi % 2 === 0) await yieldToLoop();
      try {
        // 选「消息条数最多」的当主份（最完整）
        const sized = group
          .map((r) => {
            const p = index.get(String(r.id));
            let msgCount = 0;
            try {
              msgCount = p ? messageIdSet(p).size : 0;
            } catch {
              msgCount = 0;
            }
            return { row: r, id: String(r.id), path: p, msgCount, bytes: p ? fs.statSync(p).size : 0 };
          })
          .sort((a, b) => b.msgCount - a.msgCount || b.bytes - a.bytes);
        const keeper = sized[0];
        const others = sized.slice(1);
        const title = displayTitle(keeper.row.title, keeper.row.custom_title);
        const entry = { title, keeper: keeper.id, merged: [], bytes: 0, keptDiverged: 0 };
        // 先并集合并进主份（内容有多有少也合并），失败则整组跳过
        if (!dryRun && keeper.path) {
          const parts = sized.map((x) => ({ id: x.id, file: x.path })).filter((x) => x.file);
          if (parts.length > 1) {
            // keeper 正文合并前先备份（db 备份不含正文；2026-10-26 体检 M6）
            if (backupPath) {
              try {
                const bd = path.join(backupPath, 'bodies');
                fs.mkdirSync(bd, { recursive: true });
                fs.copyFileSync(keeper.path, path.join(bd, keeper.id + '.before-merge.jsonl'));
              } catch {
                /* 备份失败不阻断合并 */
              }
            }
            const mr = mergeUnion(parts, keeper.id, keeper.path);
            if (!mr.ok) {
              report.errors.push({ id: keeper.id, error: `合并失败，已跳过该组：${mr.error}` });
              continue;
            }
            entry.mergedLines = mr.lines;
            entry.deduped = mr.dup;
          }
        }

        for (const o of others) {
          if (!o.path || !keeper.path) continue;
          if (!dryRun) {
            try {
              const dest = path.join(backupDir || path.join(STORE_DIR, 'backups', 'merged-in'), keepUid);
              fs.mkdirSync(dest, { recursive: true });
              fs.renameSync(o.path, path.join(dest, o.id + '.jsonl'));
            } catch {
              /* 移动失败不影响 */
            }
            db.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ? AND user_id = ?').run(Date.now(), o.id, keepUid);
          }
          report.freedBytes += o.bytes;
          entry.merged.push({ id: o.id, bytes: o.bytes });
        }
        if (entry.merged.length || entry.keptDiverged) report.groups.push(entry);
      } catch (err) {
        report.errors.push({ id: String(group[0].id), error: err?.message || String(err) });
      }
    }
  } finally {
    db.close();
  }

  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  return report;
}

/**
 * 把一个档位（如国际版）的全部存活会话「复制一份」到当前档位当前账号。
 * 源档位原样保留；目标已存在同对话（指纹相同）则跳过。
 * 正文用新会话 id（复制并等长替换），落在目标档位对应项目目录下。
 */
/**
 * 把「同一档位里其他账号独有的对话」单向汇总进当前账号（不铺满、不反向复制）。
 * 已有同一对话（指纹一致）→ 跳过，交给内容合并处理；没有 → 新 id 复制正文 + 插行。
 */
export async function collectIntoCurrent({ variantId = 'cn', dryRun = false } = {}) {
  const started = Date.now();
  const report = { ok: true, dryRun, copied: [], skipped: [], errors: [], totalBytes: 0, elapsedMs: 0 };
  const keepUid = currentUidOfVariant(variantId);
  if (!keepUid) throw new Error('缺少当前账号');
  if (!(await sessionCopySupported(variantId))) return report;

  const root = sessionDataRoot(variantId);
  const index = indexProjectBodies(variantId);
  const db = await openSessionDb(variantId, { readOnly: dryRun });
  const backupPath = dryRun ? null : backupSessionDb(variantId);
  if (backupPath) report.backupPath = backupPath;

  try {
    const dstSigs = [];
    for (const r of db.prepare('SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL').all(keepUid)) {
      const p = index.get(String(r.id));
      if (!p) continue;
      const sig = contentSignatureSet(p);
      if (sig.size) dstSigs.push(sig);
    }
    const rows = db
      .prepare('SELECT * FROM sessions WHERE user_id <> ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(keepUid);
    let i = 0;
    for (const row of rows) {
      if (++i % 5 === 0) await yieldToLoop();
      const sid = String(row.id);
      const p = index.get(sid);
      if (!p) continue;
      const size = bodySize(p) || 0;
      try {
        const sig = contentSignatureSet(p);
        if (sig.size && looksLikeExisting(sig, dstSigs)) {
          report.skipped.push({ id: sid, title: displayTitle(row.title, row.custom_title) });
          continue;
        }
        report.copied.push({ id: sid, title: displayTitle(row.title, row.custom_title), bytes: size, fromUid: String(row.user_id), dryRun });
        report.totalBytes += size;
        if (dryRun) continue;

        const newId = crypto.randomUUID();
        const rel = path.relative(path.join(root, 'projects'), p);
        const dest = path.join(root, 'projects', rel).replace(new RegExp(sid + '\\.jsonl$'), newId + '.jsonl');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        byteCopyReplace(p, sid, dest, newId);
        const cols = Object.keys(row);
        const values = cols.map((c) => (c === 'id' ? newId : c === 'user_id' ? keepUid : row[c]));
        db.prepare(
          'INSERT OR REPLACE INTO sessions (' + cols.map((c) => '"' + c + '"').join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')'
        ).run(...values);
        if (sig.size) dstSigs.push(sig);
      } catch (err) {
        report.errors.push({ id: sid, error: err?.message || String(err) });
      }
    }
  } finally {
    db.close();
  }
  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  return report;
}

/**
 * 跨档位清理：把「另一档位」里内容已经存在于保留账号的会话软删 + 正文移入备份。
 * 只有消息重合度 ≥85% 才删（保守），独有内容一律保留，交给跨档位复制先补过来。
 */
export async function pruneVariantAgainst({ keepVariant = 'cn', otherVariant = 'ai', keepUid = null, dryRun = false } = {}) {
  const started = Date.now();
  const report = { ok: true, dryRun, keepVariant, otherVariant, pruned: [], kept: [], errors: [], freedBytes: 0, elapsedMs: 0 };
  if (!keepUid || keepVariant === otherVariant) return report;
  if (!(await sessionCopySupported(otherVariant))) return report;

  const keepIndex = indexProjectBodies(keepVariant);
  const otherIndex = indexProjectBodies(otherVariant);
  const keepDb = await openSessionDb(keepVariant, { readOnly: true });
  const otherDb = await openSessionDb(otherVariant, { readOnly: dryRun });
  const backupDir = path.join(STORE_DIR, 'backups', 'pruned-variant', new Date().toISOString().slice(0, 10));

  try {
    const keepSigs = [];
    for (const r of keepDb.prepare('SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL').all(keepUid)) {
      const p = keepIndex.get(String(r.id));
      if (!p) continue;
      const s = contentSignatureSet(p);
      if (s.size) keepSigs.push(s);
    }

    const rows = otherDb.prepare('SELECT id, user_id, title, custom_title FROM sessions WHERE deleted_at IS NULL').all();
    let __vr = 0;
    for (const row of rows) {
      if (++__vr % 5 === 0) await yieldToLoop();
      const cid = String(row.id);
      const p = otherIndex.get(cid);
      if (!p) continue;
      const title = displayTitle(row.title, row.custom_title);
      const sig = contentSignatureSet(p);
      if (!sig.size || !looksLikeExisting(sig, keepSigs)) {
        report.kept.push({ id: cid, user_id: String(row.user_id), title, reason: 'unique' });
        continue;
      }
      try {
        const size = fs.statSync(p).size;
        if (!dryRun) {
          otherDb
            .prepare("UPDATE sessions SET deleted_at = ?, status = 'pruned' WHERE id = ? AND user_id = ?")
            .run(Date.now(), cid, String(row.user_id));
          fs.mkdirSync(backupDir, { recursive: true });
          fs.renameSync(p, path.join(backupDir, cid + '.jsonl'));
        }
        report.pruned.push({ id: cid, user_id: String(row.user_id), title, bytes: size });
        report.freedBytes += size;
      } catch (err) {
        report.errors.push({ id: cid, error: err?.message || String(err) });
      }
    }
  } finally {
    try { keepDb.close(); } catch { /* ignore */ }
    try { otherDb.close(); } catch { /* ignore */ }
  }

  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  return report;
}

export async function copyVariantIntoAccount({ sourceVariant = 'ai', targetVariant = 'cn', targetUid = null, dryRun = false } = {}) {
  const started = Date.now();
  const report = { ok: true, dryRun, copied: [], skipped: [], errors: [], totalBytes: 0, elapsedMs: 0 };
  const keepUid = String(targetUid || currentUidOfVariant(targetVariant) || '').trim();
  if (!keepUid) throw new Error('缺少目标账号');
  if (sourceVariant === targetVariant) return report;
  if (!(await sessionCopySupported(sourceVariant)) || !(await sessionCopySupported(targetVariant))) return report;

  const srcIndex = indexProjectBodies(sourceVariant);
  const dstIndex = indexProjectBodies(targetVariant);
  const dstRoot = sessionDataRoot(targetVariant);
  const dstDrb = await openSessionDb(targetVariant, { readOnly: false });
  const srcDb = await openSessionDb(sourceVariant, { readOnly: dryRun });
  const backupPath = dryRun ? null : backupSessionDb(targetVariant);
  if (backupPath) report.backupPath = backupPath;

  try {
    // 目标账号已有对话的指纹集合
    const dstRows = dstDrb.prepare('SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL').all(keepUid);
    const dstSigs = [];
    for (const r of dstRows) {
      const p = dstIndex.get(String(r.id));
      if (!p) continue;
      const sig = contentSignatureSet(p);
      if (sig.size) dstSigs.push(sig);
    }

    const srcRows = srcDb
      .prepare('SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC')
      .all();
    let i = 0;
    for (const row of srcRows) {
      if (++i % 5 === 0) await yieldToLoop();
      const sid = String(row.id);
      const p = srcIndex.get(sid);
      if (!p) continue;
      const size = bodySize(p) || 0;
      try {
        const sig = contentSignatureSet(p);
        if (sig.size && looksLikeExisting(sig, dstSigs)) {
          report.skipped.push({ id: sid, title: displayTitle(row.title, row.custom_title) });
          continue;
        }
        report.copied.push({ id: sid, title: displayTitle(row.title, row.custom_title), bytes: size, dryRun });
        report.totalBytes += size;
        if (dryRun) continue;

        // 复制到目标档位：新 id + 等长替换 + 插行
        const newId = crypto.randomUUID();
        const rel = path.relative(path.join(sessionDataRoot(sourceVariant), 'projects'), p);
        const dest = path.join(dstRoot, 'projects', rel).replace(new RegExp(sid + '\\.jsonl$'), newId + '.jsonl');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        byteCopyReplace(p, sid, dest, newId);
        // 插行：源行字段照搬，改 id / user_id
        const cols = Object.keys(row);
        const values = cols.map((c) => {
          if (c === 'id') return newId;
          if (c === 'user_id') return keepUid;
          return row[c];
        });
        dstDrb
          .prepare('INSERT OR REPLACE INTO sessions (' + cols.map((c) => '"' + c + '"').join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')')
          .run(...values);
        if (sig.size) dstSigs.push(sig);
      } catch (err) {
        report.errors.push({ id: sid, error: err?.message || String(err) });
      }
    }
  } finally {
    srcDb.close();
    dstDrb.close();
  }

  report.ok = report.errors.length === 0;
  report.elapsedMs = Date.now() - started;
  return report;
}
