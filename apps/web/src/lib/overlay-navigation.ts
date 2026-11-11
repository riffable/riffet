import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

const HISTORY_MARKER = 'riffet.navigation';
interface NavigationEntry { version: 1; id: string; role: 'base' | 'guard' }
type NavigationEvent = 'popstate' | 'pageshow' | 'pagehide' | 'pointerdown' | 'keydown';
type BrowserHistoryEntry = Pick<NavigationHistoryEntry, 'key' | 'index' | 'sameDocument'>;
interface BrowserNavigation extends Pick<EventTarget, 'addEventListener' | 'removeEventListener'> {
  readonly currentEntry: BrowserHistoryEntry | null;
  entries(): BrowserHistoryEntry[];
}
interface BrowserNavigateEvent extends Event {
  readonly navigationType: string;
  readonly destination: Pick<BrowserHistoryEntry, 'key' | 'sameDocument'>;
}

export interface OverlayNavigationHost {
  history: Pick<History, 'state' | 'replaceState' | 'pushState' | 'back' | 'forward'>;
  location: Pick<Location, 'href'>;
  navigation?: BrowserNavigation;
  addEventListener(type: NavigationEvent, listener: (event: Event) => void): void;
  removeEventListener(type: NavigationEvent, listener: (event: Event) => void): void;
}

interface OverlayLayer {
  id: symbol;
  ancestors: readonly symbol[];
  dismiss: () => void;
}

/** One browser Back dismisses one active operation, including portalled child menus. */
export class OverlayBackNavigation {
  private readonly layers = new Map<symbol, OverlayLayer>();
  private started = false;
  private phase: 'unguarded' | 'guarded' | 'restoring' | 'leaving' = 'unguarded';
  private pairId?: string;
  private pendingBack?: OverlayLayer;
  private pageUrl?: string;
  private browserPair?: { base: string; guard: string };

  constructor(private readonly host: OverlayNavigationHost) {}

  /** Called once after login credentials have been removed from the URL, before opening UI. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.host.addEventListener('popstate', this.onPopState);
    this.host.addEventListener('pageshow', this.onPageShow);
    this.host.addEventListener('pagehide', this.onPageHide);
    this.host.addEventListener('pointerdown', this.onInteraction);
    this.host.addEventListener('keydown', this.onKeyDown);
    this.host.navigation?.addEventListener('navigate', this.onNavigate);
    this.installGuard();
  }

  private entry(): NavigationEntry | undefined {
    const state: unknown = this.host.history.state;
    const value = state && typeof state === 'object' ? (state as Record<string, unknown>)[HISTORY_MARKER] : undefined;
    if (!value || typeof value !== 'object') return;
    const entry = value as Partial<NavigationEntry>;
    if (entry.version === 1 && typeof entry.id === 'string' && (entry.role === 'base' || entry.role === 'guard')) return entry as NavigationEntry;
  }

  private state(role: NavigationEntry['role']): Record<string, unknown> {
    const previous: unknown = this.host.history.state;
    return { ...(previous && typeof previous === 'object' ? previous : {}), [HISTORY_MARKER]: { version: 1, id: this.pairId, role } };
  }

  private installGuard(): void {
    const entry = this.entry();
    this.pairId = entry?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.pageUrl ??= this.host.location.href;
    // A reload on the existing guard adopts it rather than growing the tab's history.
    if (entry?.role !== 'guard') {
      this.host.history.replaceState(this.state('base'), '', this.pageUrl);
      this.host.history.pushState(this.state('guard'), '', this.pageUrl);
    }
    this.phase = 'guarded';
    const current = this.host.navigation?.currentEntry;
    // Our guard is always pushed immediately after its base. Recover their native keys on reload
    // too, including guards created before Navigation API handling was introduced. Keys survive
    // replaceState; URLs and NavigationHistoryEntry.getState() cannot identify classic history.
    const base = current && this.host.navigation?.entries().find(entry => entry.index === current.index - 1 && entry.sameDocument);
    this.browserPair = current && base ? { base: base.key, guard: current.key } : undefined;
    this.applyUrl();
  }

  /** Route changes during a pending Back belong on the guard, never on its older base URL. */
  replaceUrl(url: string): void {
    this.pageUrl = new URL(url, this.host.location.href).href;
    if (this.phase === 'restoring' || this.phase === 'leaving') return;
    this.applyUrl();
  }

  private applyUrl(): void {
    if (this.pageUrl && this.pageUrl !== this.host.location.href) this.host.history.replaceState(this.host.history.state, '', this.pageUrl);
  }

  private onNavigate = (event: Event): void => {
    const navigation = event as BrowserNavigateEvent;
    if (this.phase !== 'guarded' || event.defaultPrevented || !event.cancelable || navigation.navigationType !== 'traverse'
      || !navigation.destination.sameDocument || !this.browserPair
      || navigation.destination.key !== this.browserPair.base || this.host.navigation?.currentEntry?.key !== this.browserPair.guard) return;
    const entry = this.entry();
    const top = this.topLayer();
    if (entry?.role !== 'guard' || entry.id !== this.pairId || !top) return;
    // Cancel before the URL/history commit, avoiding the Back/Forward round trip and its loads.
    // Browser UI cancellation consumes activation; a subsequent non-cancelable Back still uses
    // onPopState's fallback, as do browsers without this API. Never intercept leaving the page.
    event.preventDefault();
    if (event.defaultPrevented) top.dismiss();
  };

  private onPopState = (): void => {
    const entry = this.entry();
    if (!entry || entry.id !== this.pairId) {
      this.phase = 'unguarded';
      this.pendingBack = undefined;
      return;
    }
    if (entry.role === 'guard') {
      const pending = this.phase === 'restoring' ? this.pendingBack : undefined;
      this.pendingBack = undefined;
      this.phase = 'guarded';
      this.applyUrl();
      // The user may have explicitly closed it or opened another layer while forward was pending.
      if (pending && this.topLayer() === pending) this.dismissTop();
      return;
    }
    if (this.phase !== 'guarded') {
      if (this.phase === 'unguarded') this.applyUrl();
      return;
    }
    const top = this.topLayer();
    if (top) {
      this.pendingBack = top;
      this.phase = 'restoring';
      // Reuse the activated entry. Pushing after Back can make Chromium skip same-document entries
      // on the next Back, and would reintroduce navigation on each subsequent popup open.
      this.host.history.forward();
    } else {
      this.phase = 'leaving';
      // The base is our extra same-document entry. With no operation to cancel, let Back leave.
      this.host.history.back();
    }
  };

  private onPageHide = (): void => {
    this.phase = 'unguarded';
    this.pendingBack = undefined;
  };

  private onPageShow = (): void => {
    if (this.phase !== 'unguarded') return;
    this.pendingBack = undefined;
    const entry = this.entry();
    this.phase = entry && entry.id === this.pairId && entry.role === 'guard' ? 'guarded' : 'unguarded';
    // Back/Forward cache restores do not establish a new guard or force a navigation. If the
    // reader interacts again, establish protection then; never pull them back while leaving.
    if (entry && entry.id === this.pairId) this.applyUrl();
  };

  private onInteraction = (): void => {
    // Also handles a new tab whose first Back had no previous page to visit.
    if (this.phase === 'unguarded' || this.phase === 'leaving') this.installGuard();
  };

  private onKeyDown = (event: Event): void => {
    const key = event as KeyboardEvent;
    // Radix's document listener gets Escape first. Only handle it here for layers that do not
    // use a Radix dismissable layer, such as full-page views; never dismiss their parent twice.
    if (key.defaultPrevented || key.isComposing) return;
    if (key.key === 'Escape') {
      if (this.phase !== 'restoring' && this.topLayer()) { key.preventDefault(); this.dismissTop(); }
      return;
    }
    this.onInteraction();
  };

  register(id: symbol, ancestors: readonly symbol[], dismiss: () => void): () => void {
    const layer = { id, ancestors, dismiss };
    this.layers.set(id, layer);
    return () => {
      if (this.layers.get(id) !== layer) return;
      this.layers.delete(id);
    };
  }

  dispose(): void {
    this.layers.clear();
    this.host.removeEventListener('popstate', this.onPopState);
    this.host.removeEventListener('pageshow', this.onPageShow);
    this.host.removeEventListener('pagehide', this.onPageHide);
    this.host.removeEventListener('pointerdown', this.onInteraction);
    this.host.removeEventListener('keydown', this.onKeyDown);
    this.host.navigation?.removeEventListener('navigate', this.onNavigate);
    this.started = false;
    this.phase = 'unguarded';
    this.pendingBack = undefined;
    this.browserPair = undefined;
  }

  private topLayer(): OverlayLayer | undefined {
    const layers = [...this.layers.values()];
    // React mounts child effects before parent effects; registration order alone would close the
    // outer dialog first when a child menu is initially open. Among leaf layers, the latest wins.
    return layers.filter((layer) => !layers.some((other) => other.ancestors.includes(layer.id))).at(-1);
  }

  private dismissTop(): void {
    this.topLayer()?.dismiss();
  }
}

export const OverlayScopeContext = createContext<readonly symbol[]>([]);
/** Whether the nearest overlay root is open. A surface outside one never freezes. */
export const OverlayOpenContext = createContext(true);

/**
 * A surface's children while it is open, and the children it last showed open while it plays its
 * exit. Choosing an item usually changes the state the surface is drawn from (the pick sorts first,
 * its check moves, a row it offered goes away, a label flips); the fading surface keeps showing the
 * one the reader chose from. State inside the content still updates; only the caller's re-renders stop.
 */
export function useClosingSnapshot<T>(children: T): T {
  const open = useContext(OverlayOpenContext);
  const shown = useRef(children);
  if (open) shown.current = children;
  return shown.current;
}

let navigation: OverlayBackNavigation | undefined;

function browserNavigation(): OverlayBackNavigation {
  return navigation ??= new OverlayBackNavigation(window);
}

export function startOverlayNavigation(): void {
  browserNavigation().start();
}

export function replacePageUrl(url: string): void {
  browserNavigation().replaceUrl(url);
}

interface OverlayOpenProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A browser Back may pop an internal page while an explicit Close still dismisses the root. */
  onBack?: () => void;
}

/** Preserve Radix's controlled/uncontrolled contract while registering only actually open roots. */
export function useOverlayState({ open: controlledOpen, defaultOpen = false, onOpenChange, onBack }: OverlayOpenProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const controlled = useRef(controlledOpen !== undefined);
  const callback = useRef(onOpenChange);
  const backCallback = useRef(onBack);
  controlled.current = controlledOpen !== undefined;
  callback.current = onOpenChange;
  backCallback.current = onBack;
  const open = controlledOpen ?? localOpen;
  const id = useRef(Symbol('overlay'));
  const ancestors = useContext(OverlayScopeContext);
  const scope = useMemo(() => [...ancestors, id.current], [ancestors]);
  const changeOpen = useCallback((next: boolean) => {
    if (!controlled.current) setLocalOpen(next);
    callback.current?.(next);
  }, []);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    return browserNavigation().register(id.current, ancestors, () => {
      // Browser callbacks run outside React. Commit the close before another Back chooses a layer.
      flushSync(() => backCallback.current ? backCallback.current() : changeOpen(false));
    });
  }, [open, ancestors, changeOpen]);

  return { open, onOpenChange: changeOpen, scope };
}
