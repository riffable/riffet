import { useEffect } from 'react';
import { useStores } from './state/stores';
import { isApplePlatform } from '@/lib/platform';
import { isComposingKey } from './session/composerKeyboard';
import { isPageOpen } from './tabs/tabsStore';

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

/**
 * ⌘K opens search, ⌘⇧P opens commands, ⌘B toggles the sidebar, and ⌃` toggles the terminal dock.
 * With session tabs on, ⌥ (Alt) drives them by physical key: 1–8 and 9 pick a tab, [ and ] step, W
 * closes, ⇧T reopens, T starts a conversation, I toggles 会话信息. ⌘/Ctrl with T, W and digits belong
 * to the browser, and ⌃W is delete-word in a terminal.
 */
export function useGlobalShortcuts(desktop: boolean, newSession: () => void) {
  const { nav, ui, tabs } = useStores();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isComposingKey(event)) return;
      // One command modifier per platform: on a Mac, Ctrl+K and Ctrl+B are the text field's own
      // Emacs bindings (kill line, move back), so only ⌘ may claim them.
      const mod = isApplePlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey && !event.shiftKey && key === 'k') {
        event.preventDefault();
        if (!event.repeat) ui.openSearch();
      } else if (mod && !event.altKey && event.shiftKey && key === 'p') {
        event.preventDefault();
        if (!event.repeat) ui.openPalette();
      } else if (mod && !event.altKey && !event.shiftKey && key === 'b') {
        event.preventDefault();
        if (event.repeat) return;
        if (desktop) ui.setSidebarCollapsed((value) => !value); else ui.setMobileSidebar((value) => !value);
      } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === '`') {
        event.preventDefault();
        if (!event.repeat) void nav.navigate(() => ui.setDockOpen((value) => !value));
      } else if (event.altKey && !event.metaKey && !event.ctrlKey && desktop) {
        // The terminal keeps ⌥ for itself (Meta-key combinations in the shell).
        if ((event.target as Element | null)?.closest?.('.xterm')) return;
        // In a text field a Mac layout that types with ⌥ (⌥5–9 are [ ] | { } on German and Nordic) keeps its characters.
        if (isApplePlatform && /^[\x20-\x7e]$/.test(event.key) && editable(event.target)) return;
        const digit = /^Digit([1-9])$/.exec(event.code);
        const shifted = event.shiftKey;
        // 会话信息 is there with or without tabs; the rest move between tabs.
        if (event.code === 'KeyI' && !shifted) { if (!event.repeat && nav.get().sessionId && !isPageOpen(nav.get())) ui.set({ sessionInfoOpen: !ui.get().sessionInfoOpen }); }
        else if (tabs.get().style === 'off') return;
        else if (digit && !shifted) tabs.goTo(Number(digit[1]));
        else if (event.code === 'BracketLeft' && !shifted) tabs.step(-1);
        else if (event.code === 'BracketRight' && !shifted) tabs.step(1);
        else if (event.code === 'KeyW' && !shifted) { if (!event.repeat) { const { sessionId } = nav.get(); if (sessionId && !isPageOpen(nav.get())) tabs.close(sessionId); } }
        else if (event.code === 'KeyT' && shifted) { if (!event.repeat) tabs.reopen(); }
        else if (event.code === 'KeyT') { if (!event.repeat) newSession(); }
        else return;
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [desktop, nav, ui, tabs, newSession]);
}
