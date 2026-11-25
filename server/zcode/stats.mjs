/**
 * ZCode Token 统计：读 ~/.zcode/cli/db/db.sqlite 的 model_usage 表。
 *
 * 口径（对齐 WorkBuddy 统计页，务必保留）：
 * - input 已包含缓存命中部分：total = input + output + cacheWrite（不加 cacheRead，避免重复计入）
 * - uncachedInput = input - cacheRead
 *
 * 隐私：只读计数字段与模型名/时间戳，不读会话正文。
 *
 * node:sqlite 在 Electron 44 主进程可用（Node 24 内置）；查询都是小聚合，直接执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_FILE = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30, all: null };

function zero() {
  return { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

async function openDb() {
  if (!fs.existsSync(DB_FILE)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(DB_FILE, { readOnly: true });
}

export async function getZcodeStats({ range = '30d', model = '' } = {}) {
  const days = RANGE_DAYS[range] !== undefined ? RANGE_DAYS[range] : 30;
  const conn = await openDb();
  if (!conn) {
    return { available: false, reason: '未找到 ZCode 数据库（~/.zcode/cli/db/db.sqlite）', totals: zero(), days: [], models: [], recent: [] };
  }
  try {
    const since = days ? Date.now() - days * 86_400_000 : 0;
    const modelCond = model ? 'AND model_id = ?' : '';
    const args = model ? [since, model] : [since];
    const q = (sql, params) => conn.prepare(sql).all(...(params || args));

    const totalsSql =
      'SELECT COUNT(*) c, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, ' +
      'COALESCE(SUM(reasoning_tokens),0) r, COALESCE(SUM(cache_read_input_tokens),0) cr, ' +
      'COALESCE(SUM(cache_creation_input_tokens),0) cw ' +
      'FROM model_usage WHERE started_at >= ? ' + modelCond;
    const totalsRow = q(totalsSql)[0];
    const totals = {
      requests: Number(totalsRow.c),
      input: Number(totalsRow.i),
      output: Number(totalsRow.o),
      reasoning: Number(totalsRow.r),
      cacheRead: Number(totalsRow.cr),
      cacheWrite: Number(totalsRow.cw),
      total: Number(totalsRow.i) + Number(totalsRow.o) + Number(totalsRow.cw),
    };

    const daySql =
      "SELECT date(started_at/1000, 'unixepoch', 'localtime') d, COUNT(*) c, " +
      'SUM(input_tokens) i, SUM(output_tokens) o, ' +
      'SUM(cache_read_input_tokens) cr, SUM(cache_creation_input_tokens) cw ' +
      'FROM model_usage WHERE started_at >= ? ' + modelCond + ' GROUP BY d ORDER BY d';
    const dayRows = q(daySql);
    const daysOut = dayRows.map((r) => ({
      date: r.d,
      requests: Number(r.c),
      input: Number(r.i || 0),
      output: Number(r.o || 0),
      cacheRead: Number(r.cr || 0),
      cacheWrite: Number(r.cw || 0),
      total: Number(r.i || 0) + Number(r.o || 0) + Number(r.cw || 0),
    }));

    const modelSql =
      'SELECT model_id, COUNT(*) c, SUM(input_tokens) i, SUM(output_tokens) o, ' +
      'SUM(cache_read_input_tokens) cr, SUM(cache_creation_input_tokens) cw ' +
      'FROM model_usage WHERE started_at >= ? ' + modelCond +
      ' GROUP BY model_id ORDER BY (SUM(input_tokens)+SUM(output_tokens)) DESC';
    const modelRows = q(modelSql);
    const models = modelRows.map((r) => ({
      model: r.model_id,
      requests: Number(r.c),
      input: Number(r.i || 0),
      output: Number(r.o || 0),
      cacheRead: Number(r.cr || 0),
      cacheWrite: Number(r.cw || 0),
      total: Number(r.i || 0) + Number(r.o || 0) + Number(r.cw || 0),
    }));

    // recent 同样吃 range/model 过滤（审查 Z-8）：筛选视图下不能展示未筛选数据
    const recentRows = conn
      .prepare(
        'SELECT started_at, model_id, provider_id, status, input_tokens, output_tokens, ' +
          'cache_read_input_tokens, computed_total_tokens, error_message ' +
          'FROM model_usage WHERE started_at >= ? ' + modelCond + ' ORDER BY started_at DESC LIMIT 20'
      )
      .all(...args);
    const recent = recentRows.map((r) => ({
      at: Number(r.started_at),
      model: r.model_id,
      provider: r.provider_id,
      status: r.status,
      input: Number(r.input_tokens || 0),
      output: Number(r.output_tokens || 0),
      cacheRead: Number(r.cache_read_input_tokens || 0),
      total: Number(r.computed_total_tokens || 0),
      error: r.error_message || null,
    }));

    return { available: true, dbFile: DB_FILE, totals, days: daysOut, models, recent };
  } finally {
    try { conn.close(); } catch { /* 已关闭 */ }
  }
}
