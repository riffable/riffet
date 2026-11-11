import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';

/** Pending submissions are separate from the disposable transcript cache and tab-local drafts. */
const prefix = 'riffet.outbox.v1.';
const legacyPrefixes = ['riffet.native-create.', 'riffet.native-send.', 'riffet.native-steer.v2.', 'riffet.discussion-create.'];

function keys(storage: Storage): string[] {
  try { return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key)); } catch { return []; }
}

/** Migration only copies records. It never performs a network operation or drops an unreadable one. */
export function migrateNativeOutbox(): void {
  for (const key of keys(sessionStorage).filter(key => legacyPrefixes.some(value => key.startsWith(value)))) {
    const value = sessionStorage.getItem(key);
    if (value === null) continue;
    try {
      const destination = prefix + key;
      const prior = localStorage.getItem(destination);
      if (prior !== null && prior !== value) continue;
      localStorage.setItem(destination, value);
      if (localStorage.getItem(destination) === value) sessionStorage.removeItem(key);
    } catch { /* Keep the tab's recovery copy until persistent storage accepts it. */ }
  }
}

export function writeNativeOutbox(key: string, value: string): void {
  const destination = prefix + key;
  const prior = localStorage.getItem(destination);
  if (prior !== null && prior !== value) {
    const old = JSON.parse(prior);
    const next = JSON.parse(value);
    // Recovery annotations may change; the submitted body, action and target may never change.
    const { invalidReason: _oldReason, draftCleared: _oldDraft, rejected: _oldRejected, ...oldInput } = old;
    const { invalidReason: _nextReason, draftCleared: _nextDraft, rejected: _nextRejected, ...nextInput } = next;
    if (JSON.stringify(oldInput) !== JSON.stringify(nextInput)) throw new Error(i18n._(msg`保存的消息存在冲突，无法重试`));
  }
  localStorage.setItem(destination, value);
  if (localStorage.getItem(destination) !== value) throw new Error(i18n._(msg`无法保存待发送消息，请检查浏览器存储空间`));
}

export function removeNativeOutbox(key: string): void {
  try { localStorage.removeItem(prefix + key); } catch { /* Known acceptance must not become an unknown send. */ }
  try { sessionStorage.removeItem(key); } catch { /* The receipt will settle this copy after storage returns. */ }
}

export function readNativeOutbox(startsWith: string[]): Array<{ key: string; value: string }> {
  try { migrateNativeOutbox(); } catch { /* A blocked tab store must not prevent persistent recovery. */ }
  const result: Array<{ key: string; value: string }> = [];
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    let storage: Storage;
    try { storage = globalThis[kind]; } catch { continue; }
    const scope = kind === 'localStorage' ? prefix : '';
    for (const storedKey of keys(storage)) {
      if (!startsWith.some(start => storedKey.startsWith(scope + start))) continue;
      let value: string | null;
      try { value = storage.getItem(storedKey); } catch { continue; }
      if (value !== null) result.push({ key: storedKey.slice(scope.length), value });
    }
  }
  return result;
}

/** Explicit sign-out ends this browser's account boundary; transient authentication loss does not. */
export function clearNativeOutbox(): void {
  try { for (const key of keys(localStorage)) if (key.startsWith(prefix) || key.startsWith('riffet.stop.')) localStorage.removeItem(key); } catch { /* Sign-out still ends the authenticated UI. */ }
  try { for (const key of keys(sessionStorage)) if (legacyPrefixes.some(value => key.startsWith(value))) sessionStorage.removeItem(key); } catch { /* Blocked storage cannot be enumerated. */ }
}
