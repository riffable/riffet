import { describe, expect, it, vi } from 'vitest';
import { OverlayBackNavigation, type OverlayNavigationHost } from './overlay-navigation';

const appUrl = 'https://riffet.test/#s=one';
const previousUrl = 'https://previous.test/';

function browser(previousPage = true, navigationApi = false) {
  const events = new EventTarget();
  const navigationEvents = new EventTarget();
  const navigations: Event[] = [];
  let activation = true;
  let nextKey = 0;
  const entries = [
    ...(previousPage ? [{ key: 'previous', url: previousUrl, state: null as unknown, document: 'previous' }] : []),
    { key: 'base', url: appUrl, state: { route: 'session' } as unknown, document: 'app' },
  ];
  let index = entries.length - 1;
  const queue: Array<() => void> = [];
  const enqueueTraversal = (delta: number, userInitiated = false) => queue.push(() => {
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    const previous = entries[index]!;
    if (navigationApi) {
      const sameDocument = entries[target]!.document === previous.document;
      const event = Object.assign(new Event('navigate', { cancelable: sameDocument && (!userInitiated || activation) }), {
        navigationType: 'traverse', userInitiated, destination: { key: entries[target]!.key, sameDocument },
      });
      navigations.push(event);
      navigationEvents.dispatchEvent(event);
      if (event.defaultPrevented) { if (userInitiated) activation = false; return; }
    }
    index = target;
    if (entries[index]!.document !== previous.document) events.dispatchEvent(new Event('pagehide'));
    else events.dispatchEvent(new Event('popstate'));
  });
  const history = {
    get state() { return entries[index]!.state; },
    replaceState: vi.fn((state: unknown, _unused: string, url?: string | URL | null) => {
      const current = entries[index]!;
      entries[index] = { ...current, state: structuredClone(state), url: url == null ? current.url : new URL(url, current.url).href };
    }),
    pushState: vi.fn((state: unknown, _unused: string, url?: string | URL | null) => {
      const current = entries[index]!;
      entries.splice(index + 1, entries.length, { ...current, key: `entry-${++nextKey}`, state: structuredClone(state), url: url == null ? current.url : new URL(url, current.url).href });
      index += 1;
    }),
    back: vi.fn(() => { enqueueTraversal(-1); }),
    forward: vi.fn(() => { enqueueTraversal(1); }),
  };
  const CloseWatcher = vi.fn();
  const host: OverlayNavigationHost & { CloseWatcher: typeof CloseWatcher } = {
    history,
    location: { get href() { return entries[index]!.url; } },
    addEventListener: (type, listener) => events.addEventListener(type, listener),
    removeEventListener: (type, listener) => events.removeEventListener(type, listener),
    // A WebView can expose this API while its system Back still traverses history.
    CloseWatcher,
    ...(navigationApi ? { navigation: {
      get currentEntry() { return { key: entries[index]!.key, index, sameDocument: true }; },
      entries: () => entries.map((entry, entryIndex) => ({ key: entry.key, index: entryIndex, sameDocument: entry.document === entries[index]!.document })),
      addEventListener: navigationEvents.addEventListener.bind(navigationEvents),
      removeEventListener: navigationEvents.removeEventListener.bind(navigationEvents),
    } } : {}),
  };
  const step = async () => {
    expect(queue.length).toBeGreaterThan(0);
    queue.shift()!();
    await Promise.resolve();
  };
  return {
    host, history, entries, navigations,
    // Browser Back/Forward are distinct from script calls to history.back/forward.
    back: () => enqueueTraversal(-1, true),
    forward: () => enqueueTraversal(1, true),
    step,
    async flush() {
      for (let turns = 0; queue.length; turns += 1) {
        if (turns >= 20) throw new Error('History traversal did not settle');
        await step();
      }
    },
    emit: (type: 'pageshow' | 'pagehide' | 'pointerdown') => {
      if (type === 'pointerdown') activation = true;
      return events.dispatchEvent(new Event(type));
    },
    escape(prevented = false) {
      const event = new Event('keydown', { cancelable: true });
      Object.defineProperty(event, 'key', { value: 'Escape' });
      if (prevented) event.preventDefault();
      events.dispatchEvent(event);
      return event;
    },
  };
}

describe('overlay browser navigation', () => {
  it('cancels an activated same-document Back before commit, including guards from an older page load', async () => {
    const b = browser(true, true);
    const { navigation: _api, ...legacyHost } = b.host;
    const legacy = new OverlayBackNavigation(legacyHost);
    legacy.start();
    legacy.dispose();
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    const root = Symbol('editor');
    const dismiss = vi.fn(() => removeRoot());
    const removeRoot = navigation.register(root, [], dismiss);
    const childDismiss = vi.fn(() => removeChild());
    const removeChild = navigation.register(Symbol('confirmation'), [root], childDismiss);
    navigation.replaceUrl('/?view=stats#s=two');
    b.back();
    await b.flush();
    expect(childDismiss).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
    expect(b.navigations).toHaveLength(1);
    expect(b.navigations[0]!.defaultPrevented).toBe(true);
    expect(b.history.forward).not.toHaveBeenCalled();
    expect(b.host.location.href).toBe('https://riffet.test/?view=stats#s=two');
    // Cancellation consumes activation. The next Back still dismisses exactly one layer through
    // the original history fallback; canceling the programmatic restoration would break it.
    b.back();
    await b.flush();
    expect(b.navigations[1]!.cancelable).toBe(false);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(childDismiss).toHaveBeenCalledTimes(1);
    expect(b.history.forward).toHaveBeenCalledTimes(1);
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
    b.emit('pointerdown');
    const reopenedDismiss = vi.fn(() => removeReopened());
    const removeReopened = navigation.register(Symbol('reopened'), [], reopenedDismiss);
    b.back();
    await b.flush();
    expect(reopenedDismiss).toHaveBeenCalledTimes(1);
    expect(b.history.forward).toHaveBeenCalledTimes(1);
    b.back();
    await b.flush();
    expect(b.host.location.href).toBe(previousUrl);
    navigation.dispose();
  });

  it('does not cancel traversals from unrelated entries or after disposal', async () => {
    const b = browser(true, true);
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    const dismiss = vi.fn();
    navigation.register(Symbol('details'), [], dismiss);
    b.history.pushState({ route: 'unmanaged' }, '', '/unmanaged');
    b.back();
    await b.flush();
    expect(b.navigations[0]!.defaultPrevented).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
    b.forward();
    await b.flush();
    expect(b.host.location.href).toBe('https://riffet.test/unmanaged');
    expect(b.navigations[1]!.defaultPrevented).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
    b.back();
    await b.flush();
    navigation.dispose();
    b.back();
    await b.flush();
    expect(b.navigations.at(-1)!.defaultPrevented).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
    expect(b.history.forward).not.toHaveBeenCalled();
  });

  it('initializes once and keeps explicit open/close and remounts local', () => {
    const b = browser();
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    navigation.start();
    const root = Symbol('sidebar');
    const dismiss = vi.fn();
    const staleRemove = navigation.register(root, [], dismiss);
    staleRemove();
    const removeRoot = navigation.register(root, [], dismiss);
    staleRemove();
    navigation.register(Symbol('menu'), [root], dismiss)();
    removeRoot();
    navigation.dispose();
    expect(dismiss).not.toHaveBeenCalled();
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
    expect(b.history.replaceState).toHaveBeenCalledTimes(1);
    expect(b.history.state).toMatchObject({ route: 'session' });
    expect(b.host.location.href).toBe(appUrl);
    expect(b.history.back).not.toHaveBeenCalled();
    expect(b.history.forward).not.toHaveBeenCalled();
    expect(b.host.CloseWatcher).not.toHaveBeenCalled();
  });

  it('handles browser Back even when CloseWatcher exists, reusing the guard for every level', async () => {
    const b = browser();
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    const root = Symbol('settings');
    const closed: string[] = [];
    let page = 1;
    // Child effects mount first; scope must decide the order, rather than registration order.
    const removeMenu = navigation.register(Symbol('menu'), [root], () => { closed.push('menu'); removeMenu(); });
    const removeRoot = navigation.register(root, [], () => {
      if (page) page -= 1;
      else { closed.push('settings'); removeRoot(); }
    });
    b.back();
    await b.step();
    expect(closed).toEqual([]);
    await b.step();
    expect(closed).toEqual(['menu']);
    expect(page).toBe(1);
    b.back();
    await b.flush();
    expect(page).toBe(0);
    expect(closed).toEqual(['menu']);
    b.back();
    await b.flush();
    expect(closed).toEqual(['menu', 'settings']);
    expect(b.history.forward).toHaveBeenCalledTimes(3);
    expect(b.history.back).not.toHaveBeenCalled();
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
    expect(b.entries).toHaveLength(3);
    expect(b.host.location.href).toBe(appUrl);
    expect(b.host.CloseWatcher).not.toHaveBeenCalled();
    navigation.dispose();
  });

  it('does not dismiss a parent again after Radix consumes Escape', () => {
    const b = browser();
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    const root = Symbol('settings');
    const dismiss = vi.fn(() => removeRoot());
    const removeRoot = navigation.register(root, [], dismiss);
    const removeMenu = navigation.register(Symbol('menu'), [root], vi.fn());
    // Radix has already dismissed its menu at document level before bubbling to window.
    removeMenu();
    b.escape(true);
    expect(dismiss).not.toHaveBeenCalled();
    expect(b.escape().defaultPrevented).toBe(true);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(b.escape().defaultPrevented).toBe(false);
    expect(b.history.back).not.toHaveBeenCalled();
    expect(b.history.forward).not.toHaveBeenCalled();
    navigation.dispose();
  });

  it('keeps an editor open when Back cancels its asynchronous discard confirmation', async () => {
    const b = browser(true, true);
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    let removeRoot: () => void;
    const back = vi.fn(() => {
      void new Promise<boolean>((resolve) => {
        const removeConfirmation = navigation.register(Symbol('confirmation'), [], () => {
          removeConfirmation();
          resolve(false);
        });
      }).then((discard) => { if (discard) removeRoot(); });
    });
    removeRoot = navigation.register(Symbol('editor'), [], back);
    b.back();
    await b.flush();
    expect(back).toHaveBeenCalledTimes(1);
    b.back();
    await b.flush();
    expect(back).toHaveBeenCalledTimes(1);
    b.back();
    await b.flush();
    expect(back).toHaveBeenCalledTimes(2);
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
    expect(b.history.back).not.toHaveBeenCalled();
    navigation.dispose();
  });

  it('does not dismiss a replacement or newly opened child during asynchronous guard restoration', async () => {
    const b = browser();
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    const root = Symbol('details');
    const oldDismiss = vi.fn();
    const removeOld = navigation.register(root, [], oldDismiss);
    b.back();
    await b.step();
    removeOld();
    const replacementDismiss = vi.fn();
    navigation.register(root, [], replacementDismiss);
    await b.flush();
    expect(oldDismiss).not.toHaveBeenCalled();
    expect(replacementDismiss).not.toHaveBeenCalled();
    b.back();
    await b.step();
    const childDismiss = vi.fn();
    navigation.register(Symbol('menu'), [root], childDismiss);
    b.escape();
    await b.flush();
    expect(replacementDismiss).not.toHaveBeenCalled();
    expect(childDismiss).not.toHaveBeenCalled();
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
    navigation.dispose();
  });

  it('caches URL changes during restoration and applies them only to the restored guard', async () => {
    const b = browser();
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    navigation.replaceUrl('/?view=stats#s=two');
    const dismiss = vi.fn(() => removeRoot());
    const removeRoot = navigation.register(Symbol('details'), [], dismiss);
    b.back();
    await b.step();
    const replaces = b.history.replaceState.mock.calls.length;
    navigation.replaceUrl('/?view=marks#s=three');
    expect(b.host.location.href).toBe(appUrl);
    expect(b.history.replaceState).toHaveBeenCalledTimes(replaces);
    await b.flush();
    expect(b.host.location.href).toBe('https://riffet.test/?view=marks#s=three');
    expect(b.entries[1]!.url).toBe(appUrl);
    expect(b.history.state).toMatchObject({ route: 'session' });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
    navigation.dispose();
  });

  it('lets Back leave for the previous document when no layer is open, without bouncing back', async () => {
    const b = browser();
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    b.back();
    await b.flush();
    expect(b.host.location.href).toBe(previousUrl);
    expect(b.history.back).toHaveBeenCalledTimes(1);
    expect(b.history.forward).not.toHaveBeenCalled();
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
    navigation.dispose();
  });

  it('protects a new interaction after Back had no previous document to visit', async () => {
    const b = browser(false);
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    b.back();
    await b.flush();
    expect(b.host.location.href).toBe(appUrl);
    expect(b.history.back).toHaveBeenCalledTimes(1);
    b.emit('pointerdown');
    const dismiss = vi.fn(() => removeRoot());
    const removeRoot = navigation.register(Symbol('details'), [], dismiss);
    b.back();
    await b.flush();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(b.history.forward).toHaveBeenCalledTimes(1);
    expect(b.entries).toHaveLength(2);
    navigation.dispose();
  });

  it('adopts an existing guard after reload instead of adding another history entry', () => {
    const b = browser();
    const first = new OverlayBackNavigation(b.host);
    first.start();
    first.dispose();
    const reloaded = new OverlayBackNavigation(b.host);
    reloaded.start();
    reloaded.start();
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
    expect(b.history.replaceState).toHaveBeenCalledTimes(1);
    expect(b.entries).toHaveLength(3);
    reloaded.dispose();
  });

  it('restores the current URL after a cached page returns, without forcing navigation or dismissal', async () => {
    const b = browser();
    const navigation = new OverlayBackNavigation(b.host);
    navigation.start();
    navigation.replaceUrl('/#s=two');
    b.back();
    await b.flush();
    expect(b.host.location.href).toBe(previousUrl);
    b.forward();
    await b.flush();
    expect(b.host.location.href).toBe(appUrl);
    b.emit('pageshow');
    expect(b.host.location.href).toBe('https://riffet.test/#s=two');
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
    expect(b.history.forward).not.toHaveBeenCalled();
    // A real interaction on the restored page establishes protection without following an
    // unknown forward entry. Further explicit open/close remains local.
    b.emit('pointerdown');
    const removeRestored = navigation.register(Symbol('restored'), [], () => removeRestored());
    b.back();
    await b.flush();
    expect(b.host.location.href).toBe('https://riffet.test/#s=two');
    const dismiss = vi.fn();
    navigation.register(Symbol('details'), [], dismiss);
    const replaces = b.history.replaceState.mock.calls.length;
    b.history.pushState({ route: 'unmanaged' }, '', '/unmanaged');
    b.back();
    await b.flush();
    b.forward();
    await b.flush();
    b.emit('pageshow');
    expect(b.host.location.href).toBe('https://riffet.test/unmanaged');
    expect(dismiss).not.toHaveBeenCalled();
    expect(b.history.pushState).toHaveBeenCalledTimes(3);
    expect(b.history.replaceState).toHaveBeenCalledTimes(replaces);
    expect(b.history.back).toHaveBeenCalledTimes(1);
    expect(b.history.forward).toHaveBeenCalledTimes(1);
    navigation.dispose();
  });
});
