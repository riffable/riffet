import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Session } from '@contracts';
import { IconSquareTerminal } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { HttpError } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { useStores } from '../state/stores';

/**
 * Stands where the composer does while the conversation is held by a terminal
 * (docs/TERMINAL-SESSIONS.md): that CLI is its only writer until the hold is released.
 */
export function TerminalHoldBar({ session }: { session: Session }) {
  const { t } = useLingui();
  const { lists } = useStores();
  const [busy, setBusy] = useState(false);

  const release = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let force = false;
      for (;;) {
        try {
          lists.upsertSession(await api.releaseTerminalHold(session.id, force));
          return;
        } catch (error) {
          if (force || !(error instanceof HttpError) || error.code !== 'TERMINAL_STILL_RUNNING') throw error;
          if (!(await confirmDialog({ title: t`结束终端中的进程？`, confirmLabel: t`结束`, destructive: true }))) return;
          force = true;
        }
      }
    } catch (error) {
      toast.error(errorMessage(error, t`无法收回`));
    } finally { setBusy(false); }
  };

  return (
    <div role="status" className="flex h-14 items-center gap-3 bg-elevated px-4 max-md:rounded-3xl max-md:border max-md:border-line-strong max-md:shadow-soft md:rounded-2xl md:shadow-composer">
      <IconSquareTerminal aria-hidden className="size-4 shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 truncate text-sm text-fg-2">{t`在终端中`}</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void release()}>{busy && <Spinner className="text-current" />}{t`收回`}</Button>
    </div>
  );
}
