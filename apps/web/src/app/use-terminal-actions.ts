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

  /** The new-session card: show the dock's shells if it is hidden, otherwise start another one. */
  const openShell = useCallback(async () => {
    const projectId = nav.get().projectId;
    const existing = lists.get().terminals.some((terminal) => !terminal.sessionId && isShellTerminal(terminal) && terminal.projectId === projectId && terminal.state !== 'exited');
    if (existing && !ui.get().dockOpen) { ui.setDockOpen(true); return; }
    await createShell();
  }, [createShell, lists, nav, ui]);

  /**
   * A shell waiting at its prompt closes at once, like an IDE's. A running command, or a shell that
   * never reported its prompt (no shell integration), asks first. The server's copy is read because a
   * tab not on screen gets no live updates.
   */
  const closeTerminal = useCallback(async (terminal: TerminalInfo) => {
    const current = await api.getTerminal(terminal.id).catch(() => terminal);
    if (current.commandRunning !== false) {
      const ok = await confirmDialog({ title: t`关闭终端？`, description: t`正在运行的命令会被结束。`, confirmLabel: t`关闭`, destructive: true });
      if (!ok) return;
    }
    try {
      await api.deleteTerminal(terminal.id);
      // Closing the last shell hides the dock here, before the list empties, so the dock never reads
      // it as a stale tab to replace with a fresh shell.
      const others = lists.get().terminals.some((item) => item.id !== terminal.id && !item.sessionId && isShellTerminal(item) && item.projectId === terminal.projectId && item.state !== 'exited');
      if (!others) ui.setDockOpen(false);
      lists.removeTerminal(terminal.id);
    } catch (error) { toast.error(errorMessage(error, t`无法关闭终端`)); }
  }, [lists, t, ui]);

  return { createShell, openShell, closeTerminal };
}
