import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { AppSettings } from '@contracts';
import { api } from '@/lib/api';

export function notificationBlocker(): string | undefined {
  if (!window.isSecureContext) return i18n._(msg`需要通过 localhost 或 HTTPS 访问才能启用通知。`);
  if (!('Notification' in window)) return i18n._(msg`此浏览器不支持通知。`);
  if (Notification.permission === 'denied') return i18n._(msg`浏览器已拒绝通知，请在网站设置中允许后重试。`);
  return undefined;
}

/** Whether a page may still ask this browser for notification permission. */
export const canAskNotifications = () => !notificationBlocker() && Notification.permission === 'default';

/**
 * Turns the server's session notifications on or off. Turning on first needs this browser's
 * permission; a refusal throws with the reason. Resolves with the server's answer and the patch sent.
 */
export async function saveNotifications(enabled: boolean): Promise<{ settings: AppSettings; patch: { notifications: boolean } }> {
  if (enabled) {
    const blocker = notificationBlocker();
    if (blocker) throw new Error(blocker);
    const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (result !== 'granted') throw new Error(result === 'denied' ? i18n._(msg`浏览器拒绝了通知权限。`) : i18n._(msg`未授予通知权限。`));
  }
  const patch = { notifications: enabled };
  return { settings: await api.updateSettings(patch), patch };
}
