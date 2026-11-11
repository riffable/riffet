import { useCallback, useEffect, useRef } from 'react';
import { useLingui } from '@lingui/react/macro';
import { createStore, useStore } from './store';
import { toast } from './toast';

export type DialogRequest =
  | { id: number; type: 'confirm'; title: string; description?: string; detail?: string; confirmLabel?: string; destructive?: boolean; resolve: (value: boolean) => void }
  | { id: number; type: 'prompt'; title: string; description?: string; label?: string; initial?: string; placeholder?: string; confirmLabel?: string; multiline?: boolean; resolve: (value: string | null) => void };

const store = createStore<{ current?: DialogRequest }>({});
let sequence = 0;

/** Settles whatever request is open, so replacing it never leaves a caller waiting. */
function open(request: DialogRequest): void {
  const { current } = store.get();
  current?.type === 'confirm' ? current.resolve(false) : current?.resolve(null);
  store.set({ current: request });
}

export function closeDialog(): void {
  store.set({ current: undefined });
}

export function confirmDialog(options: { title: string; description?: string; detail?: string; confirmLabel?: string; destructive?: boolean }): Promise<boolean> {
  return new Promise((resolve) => open({ id: ++sequence, type: 'confirm', ...options, resolve }));
}

/**
 * `multiline` wraps a long single-line value (a session title) across a few rows so all of it can be
 * read while editing; Enter still confirms and line breaks never reach the value.
 */
export function promptDialog(options: { title: string; description?: string; label?: string; initial?: string; placeholder?: string; confirmLabel?: string; multiline?: boolean }): Promise<string | null> {
  return new Promise((resolve) => open({ id: ++sequence, type: 'prompt', ...options, resolve }));
}

export function useDialogRequest(): DialogRequest | undefined {
  return useStore(store, (state) => state.current);
}

/**
 * Keeps an editor's unsaved draft from going away unasked: `close` runs a close at once while the
 * draft is clean and after 放弃修改 is confirmed while it is dirty, and the tab asks before it closes.
 * Pass a dialog's `onOpenChange` through it and Radix's close button, Escape, a click outside and
 * the browser's Back (see `useOverlayState`) all ask, since each of them arrives there; a close
 * after a successful save calls the caller's handler directly. `busy` (a save in flight) refuses to
 * leave at all.
 */
export function useDiscardGuard(dirty: boolean, busy = false) {
  const { t } = useLingui();
  const latest = useRef({ dirty, busy });
  latest.current = { dirty, busy };
  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy]);
  /** Resolves true when there is nothing to lose, or the reader chose to lose it. */
  const confirm = useCallback(async () => {
    if (latest.current.busy) { toast.info(t`正在处理，请稍候再离开`); return false; }
    return !latest.current.dirty || await confirmDialog({ title: t`放弃未保存的修改？`, confirmLabel: t`放弃修改`, destructive: true });
  }, [t]);
  /** Synchronous while clean, so a Back that closes the dialog commits before the next one arrives. */
  const close = useCallback((onClose: () => void) => {
    if (!latest.current.dirty && !latest.current.busy) { onClose(); return; }
    void confirm().then((discard) => { if (discard) onClose(); });
  }, [confirm]);
  return { confirm, close };
}
