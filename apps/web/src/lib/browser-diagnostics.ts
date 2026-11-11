import { WEB_BUILD } from './build-info';

export interface BrowserDiagnosticsStatus { recording: boolean; count: number }
interface DiagnosticEvent { at: number; type: string; detail?: unknown }
interface DiagnosticReport {
  version: 1;
  startedAt: string;
  stoppedAt?: string;
  environment: unknown;
  events: DiagnosticEvent[];
}

const STORAGE_KEY = 'riffet.browser-diagnostics';
const MAX_EVENTS = 500;
const listeners = new Set<() => void>();
let status: BrowserDiagnosticsStatus = { recording: false, count: 0 };
let report: DiagnosticReport | undefined;
let restored = false;
let started = 0;
let cleanup: Array<() => void> = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function publish(): void {
  status = { recording: status.recording, count: report?.events.length ?? 0 };
  for (const listener of listeners) {
    try { listener(); } catch { /* A diagnostic view must not interrupt navigation or cleanup. */ }
  }
}

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    if (report) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(report));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* Diagnostics must also work when tab storage is unavailable. */ }
}

function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored || stored.length > 256_000) return;
    const value = JSON.parse(stored) as DiagnosticReport;
    if (value?.version !== 1 || typeof value.startedAt !== 'string' || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) return;
    report = value;
    status = { recording: false, count: value.events.length };
  } catch { /* A fresh tab has nothing to restore. Recording never resumes automatically. */ }
}

function record(type: string, detail?: unknown): void {
  if (!status.recording || !report) return;
  report.events.push({ at: Math.round(performance.now() - started), type, ...(detail === undefined ? {} : { detail }) });
  if (report.events.length > MAX_EVENTS) report.events.shift();
  if (saveTimer === undefined) saveTimer = setTimeout(save, 250);
  publish();
}

/** Only shipped asset names are retained; routes, queries, fragments and external hosts are not. */
function resourceName(value: string): string {
  try {
    const url = new URL(value, window.location.href);
    if (!['http:', 'https:'].includes(url.protocol)) return url.protocol;
    if (url.origin !== window.location.origin) return 'external';
    if (/^\/assets\/[\w.-]+$/.test(url.pathname)) return url.pathname;
    if (['/sw.js', '/theme-init.js', '/favicon.svg'].includes(url.pathname)) return url.pathname;
    return url.pathname.startsWith('/api/') ? 'api' : 'document';
  } catch { return 'unknown'; }
}

function elementInfo(target: EventTarget | null): Record<string, unknown> | undefined {
  if (!(target instanceof Element)) return;
  const role = target.getAttribute('role');
  const state = target.getAttribute('data-state');
  return {
    tag: target.tagName.toLowerCase(),
    ...(role && ['dialog', 'alertdialog', 'menu', 'menuitem', 'button', 'listbox', 'option', 'textbox'].includes(role) ? { role } : {}),
    ...(state === 'open' || state === 'closed' ? { state } : {}),
    ...(target instanceof HTMLIFrameElement ? { resource: target.hasAttribute('srcdoc') ? 'srcdoc' : resourceName(target.src) } : {}),
  };
}

function historyRole(): string {
  const role: unknown = window.history.state?.['riffet.navigation']?.role;
  return role === 'base' || role === 'guard' ? role : 'unmanaged';
}

export function subscribeBrowserDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function browserDiagnosticsStatus(): BrowserDiagnosticsStatus {
  restore();
  return status;
}

/** Explicit, temporary observation. No requests, navigation, DOM changes or uploads are initiated. */
export function startBrowserDiagnostics(): void {
  if (status.recording || typeof window === 'undefined') return;
  restored = true;
  started = performance.now();
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  report = {
    version: 1,
    startedAt: new Date().toISOString(),
    environment: {
      build: WEB_BUILD,
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      navigationApi: Boolean(navigation),
      closeWatcher: 'CloseWatcher' in window,
      serviceWorker: Boolean(navigator.serviceWorker?.controller),
      entryScripts: [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map(script => resourceName(script.src)),
      viewport: { width: window.innerWidth, height: window.innerHeight, scale: window.visualViewport?.scale },
      readyState: document.readyState,
      historyLength: window.history.length,
      historyRole: historyRole(),
    },
    events: [],
  };
  status = { recording: true, count: 0 };
  record('recording.start');

  const listen = (target: EventTarget, type: string, listener: EventListener, capture = false) => {
    target.addEventListener(type, listener, capture);
    cleanup.push(() => target.removeEventListener(type, listener, capture));
  };
  // A later owner may retain our wrapper. Permanently retire this recording's observers on stop;
  // the next recording must not reactivate that older wrapper through the shared status flag.
  let observing = true;
  cleanup.push(() => { observing = false; });
  for (const method of ['pushState', 'replaceState', 'back', 'forward', 'go'] as const) {
    const history = window.history;
    const original = history[method];
    const own = Object.getOwnPropertyDescriptor(history, method);
    const wrapped = function(this: History, ...args: unknown[]) {
      // Do not inspect state or raw arguments: they can contain credentials and private routes.
      if (observing) {
        try {
          const callers = new Error().stack?.match(/\/assets\/[\w.-]+\.js:\d+:\d+/g)?.slice(0, 5);
          record(`history.${method}`, { role: historyRole(), callers });
        } catch { /* An observation failure must never suppress the original navigation. */ }
      }
      return Reflect.apply(original, this, args);
    };
    try {
      history[method] = wrapped;
      cleanup.push(() => {
        // Do not remove a wrapper another owner installed while recording was active.
        if (history[method] !== wrapped) return;
        if (own) Object.defineProperty(history, method, own);
        else Reflect.deleteProperty(history, method);
      });
    } catch { record('observation.unavailable', { kind: `history.${method}` }); }
  }
  for (const type of ['popstate', 'hashchange', 'pageshow', 'focus', 'blur', 'load']) {
    listen(window, type, () => record(type, { role: historyRole(), readyState: document.readyState }));
  }
  listen(window, 'pagehide', (event) => {
    record('pagehide', { persisted: (event as PageTransitionEvent).persisted });
    stopBrowserDiagnostics();
  });
  listen(document, 'visibilitychange', () => record('visibilitychange', { state: document.visibilityState }));
  for (const type of ['click', 'focusin', 'focusout']) {
    listen(document, type, (event) => record(type, elementInfo(event.target)), true);
  }
  listen(document, 'load', (event) => {
    if (event.target instanceof Element) record('element.load', elementInfo(event.target));
  }, true);
  if (navigation) listen(navigation, 'navigate', (event) => {
    const nav = event as Event & { navigationType: string; destination: { sameDocument: boolean }; userInitiated: boolean };
    record('navigate', { kind: nav.navigationType, sameDocument: nav.destination.sameDocument, cancelable: nav.cancelable, prevented: nav.defaultPrevented, userInitiated: nav.userInitiated });
  });

  if (typeof MutationObserver !== 'undefined') {
    const selector = 'iframe,dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          if (mutation.target instanceof Element && mutation.target.matches(selector)) record('element.change', { ...elementInfo(mutation.target), attribute: mutation.attributeName });
          continue;
        }
        for (const [type, nodes] of [['element.add', mutation.addedNodes], ['element.remove', mutation.removedNodes]] as const) {
          for (const node of nodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches(selector)) record(type, elementInfo(node));
            for (const child of node.querySelectorAll(selector)) record(type, elementInfo(child));
          }
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcdoc', 'data-state', 'open'] });
    cleanup.push(() => observer.disconnect());
  }
  if (typeof PerformanceObserver !== 'undefined') {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        record('resource', { kind: entry.initiatorType, resource: resourceName(entry.name), started: Math.round(entry.startTime - started), duration: Math.round(entry.duration) });
      }
    });
    try {
      observer.observe({ type: 'resource' });
      cleanup.push(() => observer.disconnect());
    } catch { observer.disconnect(); }
  }
  const timeout = setTimeout(stopBrowserDiagnostics, 10 * 60_000);
  cleanup.push(() => clearTimeout(timeout));
}

export function stopBrowserDiagnostics(): void {
  if (!status.recording) return;
  record('recording.stop');
  status = { ...status, recording: false };
  if (report) report.stoppedAt = new Date().toISOString();
  for (const release of cleanup.splice(0).reverse()) {
    try { release(); } catch { /* Keep releasing the other observers if an owner changed a method. */ }
  }
  save();
  publish();
}

export function clearBrowserDiagnostics(): void {
  stopBrowserDiagnostics();
  restored = true;
  report = undefined;
  save();
  publish();
}

export function browserDiagnosticsReport(): string {
  restore();
  return JSON.stringify(report ?? { version: 1, events: [] }, null, 2);
}
