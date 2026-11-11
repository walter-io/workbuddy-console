/**
 * 设置变更的前端广播。
 *
 * 为什么需要：页面之间是**常驻挂载 + hidden 切换**（见 App.tsx 的 visited 列表），
 * 免费模型页只在它自己的子页签变化时才会重新取数，所以「在设置里打开『显示全部平台』
 * 再切回免费模型」时，那一页拿的还是旧列表——用户必须按 F5 才看到平台被放开
 * （2026-10-19 用户反馈）。设置保存成功后广播一次，相关页面就地刷新。
 */
import type { SettingsInfo } from './types';

const SETTINGS_CHANGED_EVENT = 'wb:settings-changed';

/** 变更补丁：只带被改动的字段，取值与服务端返回一致 */
export type SettingsPatch = Partial<
  Pick<
    SettingsInfo,
    'autoCheckin' | 'autoRefreshToken' | 'autoCheckUpdate' | 'unlockAllPlatforms' | 'allowCrossAccountOps' | 'workbuddyDir' | 'proxyUrl'
  >
>;

/** 广播一次设置变更（设置页 → 其它常驻页面） */
export function emitSettingsChanged(patch: SettingsPatch) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<SettingsPatch>(SETTINGS_CHANGED_EVENT, { detail: patch }));
}

/** 订阅设置变更，返回取消订阅函数 */
export function onSettingsChanged(cb: (patch: SettingsPatch) => void) {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<SettingsPatch>).detail;
    if (detail) cb(detail);
  };
  window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
}
