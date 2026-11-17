import { useEffect, useSyncExternalStore } from 'react';
import { UPDATE_CHECK_BUDGET, type UpdateCheck } from '@contracts';
import { api } from './api';

/*
 * The newer release, if the server's last check found one. The sidebar and the About page read the
 * same value: the page's "Check for updates" result replaces it, and opening About for a version marks
 * that version seen, which turns the sidebar's notice into its quiet form.
 */

const SEEN_KEY = 'riffet.update.seen';
const REFRESH_MS = UPDATE_CHECK_BUDGET.clientRefreshHours * 60 * 60 * 1000;

let status: UpdateCheck | null = null;
let seen: string | null = (() => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } })();
let loadedAt = 0;
let loading: Promise<void> | undefined;
// perf-rules: allow subscribers remove themselves when they unmount
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** `v0.7.1`, whatever the install (a Git tag, or an npm version). */
export function availableVersion(check: UpdateCheck | null): string | undefined {
  if (check?.status !== 'available') return undefined;
  return check.latest?.tag ?? (check.latestVersion ? `v${check.latestVersion}` : undefined);
}

export function setUpdateStatus(next: UpdateCheck): void {
  status = next;
  loadedAt = Date.now();
  emit();
}

function load(): void {
  if (loading || Date.now() - loadedAt < REFRESH_MS) return;
  // No answer yet means the server has just started its first check: ask again when the page comes back.
  loading = api.updateStatus().then(value => { if (value) setUpdateStatus(value); })
    .catch(() => undefined).finally(() => { loading = undefined; });
}

export function markUpdateSeen(version: string): void {
  if (seen === version) return;
  seen = version;
  try { localStorage.setItem(SEEN_KEY, version); } catch { /* private mode: the notice stays prominent */ }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let snapshot: { status: UpdateCheck | null; seen: string | null } = { status, seen };
const read = () => (snapshot.status === status && snapshot.seen === seen ? snapshot : (snapshot = { status, seen }));

/** The available version and whether it was seen (in any tab); asks the server again when the page comes back after a while. */
export function useAvailableUpdate(): { version?: string; seen: boolean; status: UpdateCheck | null } {
  const value = useSyncExternalStore(subscribe, read);
  useEffect(() => {
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    // Another tab opened About for this version.
    const onStorage = (event: StorageEvent) => { if (event.key === SEEN_KEY && event.newValue !== seen) { seen = event.newValue; emit(); } };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('storage', onStorage); };
  }, []);
  const version = availableVersion(value.status);
  return { version, seen: Boolean(version && value.seen === version), status: value.status };
}
