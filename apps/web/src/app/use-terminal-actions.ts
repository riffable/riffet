import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { TerminalInfo } from '@contracts';
import { api } from '@/lib/api';
import { isShellTerminal } from '@/lib/backends';
import { confirmDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { useStores } from './state/stores';

/** Opening and closing the dock's shell terminals. */
export function useTerminalActions() {
  const { t } = useLingui();
  const { lists, nav, ui } = useStores();
  const upsertTerminal = lists.upsertTerminal;

  const createShell = useCallback(async () => {
    const current = lists.get().projects.find((item) => item.id === nav.get().projectId);
    if (!current) return;
    try {
      const count = lists.get().terminals.filter((terminal) => !terminal.sessionId && isShellTerminal(terminal) && terminal.projectId === current.id).length;
      const terminal = await api.createTerminal({ projectId: current.id, kind: 'shell', title: `${current.name} · ${count + 1}` });
      upsertTerminal(terminal);
      ui.set({ selectedTerminalId: terminal.id });
      ui.setDockOpen(true);
    } catch (error) { toast.error(errorMessage(error, t`无法启动终端`)); }
  }, [lists, nav, ui, upsertTerminal, t]);

  const closeTerminal = useCallback(async (terminal: TerminalInfo) => {
    const ok = await confirmDialog({ title: t`关闭「${terminal.title}」？`, description: t`终端中的进程会被结束。`, confirmLabel: t`关闭`, destructive: true });
    if (!ok) return;
    try {
      await api.deleteTerminal(terminal.id);
      lists.removeTerminal(terminal.id);
    } catch (error) { toast.error(errorMessage(error, t`无法关闭终端`)); }
  }, [lists, t]);

  return { createShell, closeTerminal };
}
