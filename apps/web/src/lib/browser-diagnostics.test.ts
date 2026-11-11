import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserDiagnosticsReport, clearBrowserDiagnostics, startBrowserDiagnostics, stopBrowserDiagnostics } from './browser-diagnostics';

const methods = ['pushState', 'replaceState', 'back', 'forward', 'go'] as const;

class TestElement extends EventTarget {
  textContent = 'PRIVATE_DOM_TEXT';
  value = 'PRIVATE_INPUT_VALUE';
  constructor(readonly tagName: string, readonly attributes: Record<string, string> = {}) { super(); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
  matches() { return true; }
  querySelectorAll() { return []; }
}
class TestFrame extends TestElement {
  src = 'https://riffet.test/private-frame?token=PRIVATE_FRAME_QUERY#PRIVATE_FRAME_HASH';
  constructor(attributes: Record<string, string> = {}) { super('IFRAME', attributes); }
}

function browser() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  const originals = Object.fromEntries(methods.map(method => [method, vi.fn((..._args: unknown[]) => method)])) as Record<typeof methods[number], ReturnType<typeof vi.fn>>;
  const history = Object.assign(Object.create(originals) as typeof originals & { state: unknown; length: number }, {
    state: { credential: 'PRIVATE_HISTORY_STATE', 'riffet.navigation': { id: 'PRIVATE_PAIR_ID', role: 'guard' } }, length: 2,
  });
  // Browser methods normally live on History.prototype; an existing own descriptor also survives.
  Object.defineProperty(history, 'replaceState', { value: originals.replaceState, configurable: true, writable: true, enumerable: false });
  const navigation = new EventTarget();
  const location = new URL('https://riffet.test/private-route?token=PRIVATE_LOCATION_QUERY#PRIVATE_LOCATION_HASH');
  const window = Object.assign(new EventTarget(), { history, location, navigation, innerWidth: 390, innerHeight: 800, isSecureContext: true });
  const document = Object.assign(new EventTarget(), {
    body: new TestElement('BODY'), readyState: 'complete', visibilityState: 'visible',
    createElement: vi.fn(),
    querySelectorAll: () => [
      { src: 'https://riffet.test/assets/index-test.js?token=PRIVATE_SCRIPT_QUERY#PRIVATE_SCRIPT_HASH' },
      { src: 'https://private-script.example/PRIVATE_SCRIPT_PATH' },
    ],
  });
  let mutations: MutationCallback | undefined;
  let resources: PerformanceObserverCallback | undefined;
  const disconnectMutations = vi.fn();
  const disconnectResources = vi.fn();
  class Observer {
    constructor(callback: MutationCallback) { mutations = callback; }
    observe() {}
    disconnect = disconnectMutations;
  }
  class ResourceObserver {
    constructor(callback: PerformanceObserverCallback) { resources = callback; }
    observe() {}
    disconnect = disconnectResources;
  }
  const fetcher = vi.fn();
  const xhr = vi.fn();
  const beacon = vi.fn();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('navigator', { userAgent: 'Test browser', sendBeacon: beacon });
  vi.stubGlobal('Element', TestElement);
  vi.stubGlobal('HTMLIFrameElement', TestFrame);
  vi.stubGlobal('MutationObserver', Observer);
  vi.stubGlobal('PerformanceObserver', ResourceObserver);
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('XMLHttpRequest', xhr);
  return {
    window, document, history, originals, storage, values, fetcher, xhr, beacon, disconnectMutations, disconnectResources,
    elementEvent(type: string, target: TestElement) {
      const event = new Event(type);
      Object.defineProperty(event, 'target', { value: target });
      document.dispatchEvent(event);
    },
    addElement(target: TestElement) {
      mutations?.([{ type: 'childList', addedNodes: [target], removedNodes: [] } as unknown as MutationRecord], {} as MutationObserver);
    },
    resource(name: string) {
      resources?.({ getEntries: () => [{ name, initiatorType: 'iframe', startTime: performance.now(), duration: 1 }] } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver);
    },
  };
}

let b: ReturnType<typeof browser>;
beforeEach(() => {
  vi.useFakeTimers();
  b = browser();
  clearBrowserDiagnostics();
});
afterEach(() => {
  stopBrowserDiagnostics();
  clearBrowserDiagnostics();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('manual browser diagnostics', () => {
  it('observes without requests or extra navigation and restores original history descriptors', () => {
    const descriptor = Object.getOwnPropertyDescriptor(b.history, 'replaceState');
    startBrowserDiagnostics();
    startBrowserDiagnostics();
    for (const method of methods) expect(b.originals[method]).not.toHaveBeenCalled();

    const calls = {
      pushState: [{ secret: 'PRIVATE_CALL_STATE' }, '', '/?token=PRIVATE_CALL_QUERY#PRIVATE_CALL_HASH'],
      replaceState: [{ secret: 'PRIVATE_REPLACE_STATE' }, '', '/?token=PRIVATE_REPLACE_QUERY'],
      back: [], forward: [], go: [-1],
    };
    for (const method of methods) {
      expect(b.history[method](...calls[method])).toBe(method);
      expect(b.originals[method]).toHaveBeenCalledExactlyOnceWith(...calls[method]);
      expect(b.originals[method].mock.contexts[0]).toBe(b.history);
    }
    vi.advanceTimersByTime(250);
    stopBrowserDiagnostics();
    stopBrowserDiagnostics();
    for (const method of methods) {
      expect(b.history[method]).toBe(b.originals[method]);
      expect(b.originals[method]).toHaveBeenCalledTimes(1);
    }
    expect(Object.getOwnPropertyDescriptor(b.history, 'replaceState')).toEqual(descriptor);
    expect(Object.hasOwn(b.history, 'back')).toBe(false);
    expect(b.fetcher).not.toHaveBeenCalled();
    expect(b.xhr).not.toHaveBeenCalled();
    expect(b.beacon).not.toHaveBeenCalled();
    expect(b.document.createElement).not.toHaveBeenCalled();
    expect(b.disconnectMutations).toHaveBeenCalledTimes(1);
    expect(b.disconnectResources).toHaveBeenCalledTimes(1);
    const stopped = browserDiagnosticsReport();
    b.window.dispatchEvent(new Event('popstate'));
    expect(browserDiagnosticsReport()).toBe(stopped);
    expect(stopped).not.toContain('PRIVATE_');
  });

  it('leaves a later owner’s wrapper intact and does not reactivate retired observers on restart', () => {
    startBrowserDiagnostics();
    const observedBack = b.history.back;
    const laterWrapper = vi.fn(function(this: unknown, ...args: unknown[]) { return Reflect.apply(observedBack, this, args); });
    b.history.back = laterWrapper;
    stopBrowserDiagnostics();
    const stopped = browserDiagnosticsReport();
    expect(b.history.back).toBe(laterWrapper);
    expect(b.history.back()).toBe('back');
    expect(laterWrapper).toHaveBeenCalledTimes(1);
    expect(b.originals.back).toHaveBeenCalledExactlyOnceWith();
    expect(b.originals.back.mock.contexts[0]).toBe(b.history);
    expect(browserDiagnosticsReport()).toBe(stopped);

    b.originals.back.mockClear();
    laterWrapper.mockClear();
    startBrowserDiagnostics();
    b.history.back();
    stopBrowserDiagnostics();
    expect(b.history.back).toBe(laterWrapper);
    expect(laterWrapper).toHaveBeenCalledExactlyOnceWith();
    expect(b.originals.back).toHaveBeenCalledExactlyOnceWith();
    expect(b.originals.back.mock.contexts[0]).toBe(b.history);
    expect(JSON.parse(browserDiagnosticsReport()).events.filter((event: { type: string }) => event.type === 'history.back')).toHaveLength(1);
  });

  it('keeps credentials, navigation state, input values and DOM content out of exported and saved reports', () => {
    startBrowserDiagnostics();
    b.history.pushState({ secret: 'PRIVATE_CALL_STATE' }, '', '/?token=PRIVATE_CALL_QUERY#PRIVATE_CALL_HASH');
    const input = new TestElement('INPUT', { role: 'textbox', id: 'PRIVATE_ELEMENT_ID', 'aria-label': 'PRIVATE_LABEL' });
    b.elementEvent('click', input);
    b.elementEvent('focusin', input);
    const frame = new TestFrame();
    b.addElement(frame);
    b.elementEvent('load', frame);
    b.addElement(new TestFrame({ srcdoc: '<p>PRIVATE_SRCDOC</p>' }));
    b.resource('https://riffet.test/api/files/PRIVATE_FILE_PATH?token=PRIVATE_RESOURCE_QUERY#PRIVATE_RESOURCE_HASH');
    b.resource('https://private-resource.example/PRIVATE_RESOURCE_PATH?secret=PRIVATE_EXTERNAL_QUERY');
    b.resource('https://riffet.test/assets/index-test.js?token=PRIVATE_ASSET_QUERY#PRIVATE_ASSET_HASH');
    const navigate = Object.assign(new Event('navigate'), {
      navigationType: 'traverse', userInitiated: true,
      destination: { sameDocument: true, url: 'https://riffet.test/PRIVATE_DESTINATION?token=PRIVATE_DESTINATION_QUERY' },
    });
    b.window.navigation.dispatchEvent(navigate);
    vi.advanceTimersByTime(250);
    stopBrowserDiagnostics();

    const exported = browserDiagnosticsReport();
    const saved = [...b.values.values()].join('\n');
    expect(exported + saved).not.toMatch(/PRIVATE_|private-(?:script|resource)\.example|private-(?:route|frame)/);
    expect(JSON.parse(exported).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'focusin', detail: { tag: 'input', role: 'textbox' } }),
      expect.objectContaining({ type: 'element.add', detail: { tag: 'iframe', resource: 'srcdoc' } }),
      expect.objectContaining({ type: 'resource', detail: expect.objectContaining({ resource: 'api' }) }),
      expect.objectContaining({ type: 'resource', detail: expect.objectContaining({ resource: 'external' }) }),
      expect.objectContaining({ type: 'resource', detail: expect.objectContaining({ resource: '/assets/index-test.js' }) }),
    ]));
    expect(JSON.parse(saved)).toEqual(JSON.parse(exported));
  });
});
