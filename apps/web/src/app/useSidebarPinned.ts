import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { errorMessage } from '@/lib/errors';
import { useStore } from '@/lib/store';
import { toast } from '@/lib/toast';
import { useStores } from './state/stores';

export function useSidebarPinned(onError: (message: string) => void = toast.error) {
  const { t } = useLingui();
  const { settings, lists } = useStores();
  const { updateSidebarPinned } = settings;
  const saved = useStore(settings, (state) => state.sidebarPinnedDraft ?? state.settings.sidebarPinned);
  const loaded = useStore(settings, (state) => state.loaded);
  const fresh = useStore(lists, (state) => state.status === 'fresh');
  const save = useCallback((change: Parameters<typeof updateSidebarPinned>[0]) => {
    // Session polling can report a fresh list before bootstrap has loaded the server's settings.
    if (!settings.get().loaded || lists.get().status !== 'fresh') return;
    void updateSidebarPinned(change).then(
      (committed) => { if (committed) lists.refreshCache(); },
      (error: unknown) => onError(errorMessage(error, t`无法保存侧栏设置`)),
    );
  }, [lists, onError, settings, t, updateSidebarPinned]);
  return { saved, save, canEdit: loaded && fresh };
}

export function useTeamMemberOrder(onError: (message: string) => void = toast.error) {
  const { t } = useLingui();
  const { settings, lists } = useStores();
  const { updateTeamMemberOrder } = settings;
  const saved = useStore(settings, (state) => state.teamMemberOrderDraft ?? state.settings.teamMemberOrder);
  const loaded = useStore(settings, (state) => state.loaded);
  const fresh = useStore(lists, (state) => state.status === 'fresh');
  const save = useCallback((change: Parameters<typeof updateTeamMemberOrder>[0]) => {
    if (!settings.get().loaded || lists.get().status !== 'fresh') return;
    void updateTeamMemberOrder(change).then(
      (committed) => { if (committed) lists.refreshCache(); },
      (error: unknown) => onError(errorMessage(error, t`无法保存团队顺序`)),
    );
  }, [lists, onError, settings, t, updateTeamMemberOrder]);
  return { saved, save, canEdit: loaded && fresh };
}
