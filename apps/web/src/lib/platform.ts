/**
 * The platform the page is running on. Workbench shortcuts bind ⌘ on Apple platforms and Ctrl
 * elsewhere, so a Mac text field keeps its own Ctrl+K / Ctrl+B editing keys.
 */
export const isApplePlatform: boolean = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent);

/** `⌘K` on Apple platforms, `Ctrl+K` elsewhere. */
export function shortcutLabel(key: string): string {
  return isApplePlatform ? `⌘${key}` : `Ctrl+${key}`;
}

/** Which machine this workbench is served from: the reader's own, or one reached over the network. */
export function hostInfo(): { local: boolean; address: string } {
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
  return { local, address: window.location.host };
}
