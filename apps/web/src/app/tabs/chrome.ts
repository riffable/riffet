import { createContext } from 'react';

/**
 * Provided by the workbench while session tabs are on (desktop only). The tab bar owns the row at
 * the top of the work area; a page's header draws no row of its own and puts its actions into
 * `actions`, the slot at the right end of the tab bar. Null when tabs are off or on a phone, where
 * the header keeps its own title row.
 */
export interface TabChrome {
  /** The element the header portals its actions into; null until the tab bar has mounted. */
  actions: HTMLElement | null;
}

export const TabChromeContext = createContext<TabChrome | null>(null);
