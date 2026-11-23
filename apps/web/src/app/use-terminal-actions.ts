import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { TerminalInfo } from '@contracts';
import { api } from '@/lib/api';
import { isShellTerminal } from '@/lib/backends';
import { confirmDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { useStores } from './state/stores';

export interface CreateShellOptions {
  profileId?: string;
  cwd?: string;
  /** When true, return the newly created terminal without replacing the active tab selection. */
  keepSelection?: boolean;
}

/** Opening and closing the dock's shell terminals. */
export function useTerminalActions() {
  const { t } = useLingui();
  const { lists, nav, ui } = useStores();
  const upsertTerminal = lists.upsertTerminal;

  const createShell = useCallback(async (options?: CreateShellOptions): Promise<TerminalInfo | undefined> => {
    const current = lists.get().projects.find((item) => item.id === nav.get().projectId);
    if (!current) return undefined;
    try {
      const shells = lists.get().terminals.filter((terminal) => !terminal.sessionId && isShellTerminal(terminal) && terminal.projectId === current.id);
      const selected = shells.find((terminal) => terminal.id === ui.get().selectedTerminalId);
      const inheritedCwd = options?.profileId ? options.cwd : (options?.cwd ?? selected?.cwd);
      const terminal = await api.createTerminal({
        projectId: current.id,
        kind: 'shell',
        ...(options?.profileId ? { profileId: options.profileId } : { title: `${current.name} · ${shells.length + 1}` }),
        ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
      });
      upsertTerminal(terminal);
      if (!options?.keepSelection) ui.set({ selectedTerminalId: terminal.id });
      ui.setDockOpen(true);
      return terminal;
    } catch (error) {
      toast.error(errorMessage(error, t`无法启动终端`));
      return undefined;
    }
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
