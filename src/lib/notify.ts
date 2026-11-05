/**
 * 应用内提示的本地存档。
 *
 * 界面上的 toast 转瞬即逝，事后想核对"刚才那句提示说了什么"就找不到了。
 * 这里把每条提示按时间落入 localStorage（最多 100 条），设置页可查看与清空。
 * 只存文本，不存 token 等敏感内容；localStorage 不可用时静默降级。
 */

export interface NotificationItem {
  at: number;
  type: 'ok' | 'err' | 'info' | 'warn';
  text: string;
}

const KEY = 'wbhub.notifications';
const MAX = 100;

function safeRead(): NotificationItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.text === 'string') : [];
  } catch {
    return [];
  }
}

function safeWrite(items: NotificationItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* 私密模式 / 配额用尽：提示存档不可用，不影响主流程 */
  }
}

/** 追加一条提示（最新在前，超出上限截断） */
export function pushNotification(type: NotificationItem['type'], text: string) {
  const items = safeRead();
  items.unshift({ at: Date.now(), type, text });
  safeWrite(items.slice(0, MAX));
}

/** 读取全部提示（最新在前） */
export function readNotifications(): NotificationItem[] {
  return safeRead();
}

export function clearNotifications() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

export const NOTIFICATION_MAX = MAX;
