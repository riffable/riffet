import { useEffect } from 'react';
import { useStores } from './state/stores';
import { matchIndex, matches } from './shortcuts';
import { isPageOpen } from './tabs/tabsStore';

/**
 * Answers the workbench's shortcuts. Which keys they are is the table's (`shortcuts/`, rebindable in
 * settings); this only says what each does. With session tabs on, 1–8 and 9 pick a tab, the step keys
 * move, close and reopen act. New conversation and session info work with or without tabs.
 */
export function useGlobalShortcuts(desktop: boolean, newSession: () => void) {
  const { nav, ui, tabs } = useStores();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const once = (run: () => void) => { event.preventDefault(); if (!event.repeat) run(); };
      if (matches(event, 'search')) return once(() => ui.openSearch());
      if (matches(event, 'commandPalette')) return once(() => ui.openPalette());
      if (matches(event, 'toggleSidebar')) return once(() => { if (desktop) ui.setSidebarCollapsed((value) => !value); else ui.setMobileSidebar((value) => !value); });
      if (matches(event, 'toggleTerminal')) return once(() => void nav.navigate(() => ui.setDockOpen((value) => !value)));
      if (!desktop) return;
      if (matches(event, 'sessionInfo')) {
        event.preventDefault();
        if (!event.repeat && nav.get().sessionId && !isPageOpen(nav.get())) ui.set({ sessionInfoOpen: !ui.get().sessionInfoOpen });
        return;
      }
      if (matches(event, 'newSession')) return once(newSession);
      if (tabs.get().style === 'off') return;
      const goTo = matchIndex(event, 'tabGoTo');
      if (goTo >= 0) { event.preventDefault(); tabs.goTo(goTo + 1); return; }
      if (matches(event, 'tabLast')) { event.preventDefault(); tabs.goTo(9); return; }
      if (matches(event, 'tabPrevious')) { event.preventDefault(); tabs.step(-1); return; }
      if (matches(event, 'tabNext')) { event.preventDefault(); tabs.step(1); return; }
      if (matches(event, 'tabClose')) return once(() => { const { sessionId } = nav.get(); if (sessionId && !isPageOpen(nav.get())) tabs.close(sessionId); });
      if (matches(event, 'tabReopen')) return once(() => tabs.reopen());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [desktop, nav, ui, tabs, newSession]);
}
