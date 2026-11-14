import { useState } from 'react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { Session, SessionDeletionPreview } from '@contracts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, HttpError } from '@/lib/api';
import { errorMessage, textOf } from '@/lib/errors';
import { forgetSessions } from '@/lib/session-deletion';
import { createStore, useStore } from '@/lib/store';
import { toast } from '@/lib/toast';

interface DeletionState {
  request?: { session: Session; preview: SessionDeletionPreview };
  /** Conversations whose preview is being read; just their entry is disabled meanwhile. */
  loading: ReadonlySet<string>;
  busy: boolean;
  error: string;
}

const store = createStore<DeletionState>({ loading: new Set(), busy: false, error: '' });

const blockerText = (preview: SessionDeletionPreview): string => preview.blocker ? textOf(preview.blocker, preview.blocker.message) ?? preview.blocker.message : '';
const isGone = (error: unknown): boolean => error instanceof HttpError && error.status === 410 && error.code === 'SESSION_DELETED';

/** Whether the entry for [sessionId] is waiting on its preview. */
export const useDeletionLoading = (sessionId: string): boolean => useStore(store, (state) => state.loading.has(sessionId));

/** Reads what deleting would remove, then asks; a busy conversation only says why not. */
export async function requestSessionDeletion(session: Session): Promise<void> {
  if (store.get().loading.has(session.id)) return;
  store.set((state) => ({ loading: new Set(state.loading).add(session.id) }));
  try {
    const preview = await api.sessionDeletion(session.id);
    if (preview.blocker) toast.error(blockerText(preview));
    else store.set({ request: { session, preview }, busy: false, error: '' });
  } catch (error) {
    // Already deleted elsewhere: the 410 itself has cleaned this page up.
    if (!isGone(error)) toast.error(errorMessage(error));
  } finally {
    store.set((state) => { const loading = new Set(state.loading); loading.delete(session.id); return { loading }; });
  }
}

const finish = (ids: readonly string[]) => {
  store.set({ request: undefined, busy: false, error: '' });
  forgetSessions(ids);
};

async function confirm(): Promise<void> {
  const { request, busy } = store.get();
  if (!request || busy) return;
  store.set({ busy: true, error: '' });
  try {
    const receipt = await api.deleteSession(request.session.id, request.preview.sessionIds);
    finish([...new Set([...request.preview.sessionIds, ...receipt.sessionIds])]);
  } catch (error) {
    // Gone already is the outcome asked for.
    if (isGone(error)) { finish(request.preview.sessionIds); return; }
    if (error instanceof HttpError && error.code === 'SESSION_DELETE_SCOPE_CHANGED') {
      try {
        const preview = await api.sessionDeletion(request.session.id);
        if (preview.blocker) { store.set({ request: undefined, busy: false, error: '' }); toast.error(blockerText(preview)); }
        else store.set({ request: { session: request.session, preview }, busy: false });
      } catch (again) {
        if (isGone(again)) finish(request.preview.sessionIds); else store.set({ busy: false, error: errorMessage(again) });
      }
      return;
    }
    store.set({ busy: false, error: errorMessage(error) });
  }
}

export function SessionDeletionDialog() {
  const { t } = useLingui();
  const { request, busy, error } = useStore(store, (state) => state);
  // Keeps the content mounted while the dialog plays its exit.
  const [shown, setShown] = useState(request);
  if (request && request !== shown) setShown(request);
  const { discussions = 0, schedules = 0 } = shown?.preview.effects ?? {};
  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open && !store.get().busy) store.set({ request: undefined, error: '' }); }}>
      {shown && (
        <DialogContent mobileSheet size="confirm" hideClose onOpenAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader className="pr-5">
            <DialogTitle>{t`删除这个会话？`}</DialogTitle>
            <DialogDescription>{t`所有设备都会移除，无法恢复。项目文件和 CLI 历史保留。`}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-1.5 text-sm text-fg-3 empty:hidden">
            {discussions > 0 && <p><Plural value={discussions} other="同时删除 # 个侧边聊天。" /></p>}
            {schedules > 0 && <p><Plural value={schedules} other="# 个定时计划继续运行。" /></p>}
            {error && <p role="alert" className="text-danger">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" autoFocus disabled={busy} onClick={() => store.set({ request: undefined, error: '' })}><Trans context="common-cancel-action">取消</Trans></Button>
            <Button variant="danger" className="min-w-16" disabled={busy} onClick={() => void confirm()}><Trans>删除会话</Trans></Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
