/**
 * 跨账号会话操作总闸（前端侧）。
 *
 * 与 server/index.mjs 的 CROSS_ACCOUNT_SESSION_OPS 对应——恢复功能时两端一起改。
 *
 * 背景：2026-10-29 用户实测，把会话复制/转移到其他账号后，同机的关联账号被上游
 * 风控批量封禁——风控已能识别「跨账号会话重放 + 同机多账号关联」。受影响入口：
 *   - 账号卡片「转到此账号」
 *   - 切换确认框「同时复制会话」
 *   - 「一键去重」「全账号会话同步汇总」（会向官方接口做跨账号删除/写入）
 */
export const CROSS_ACCOUNT_SESSION_OPS_DISABLED = true;

export const CROSS_ACCOUNT_OPS_REASON =
  '跨账号会话操作已临时停用：上游风控会识别跨账号会话重放并批量封禁关联账号（2026-10-29 用户实测）。';
