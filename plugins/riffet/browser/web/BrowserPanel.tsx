import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { PLUGIN_CHANNEL_ROUTE } from '@contracts';
import { useMessages, usePluginHost, type ViewProps } from '@riffet/plugin-web';
import { BROWSER_LIVE_CHANNEL, BROWSER_PLUGIN_ID, type BrowserLiveClientMessage, type BrowserLiveServerMessage, type BrowserLiveState, type BrowserModifiers } from '../protocol';
import { catalogs } from './messages';

/*
 * The conversation's browser, live (docs/BROWSER.md §5): JPEG frames of the active tab drawn on a canvas, and the
 * user's pointer, wheel, keys and text sent back over the plugin's channel. The user and the agent share the page:
 * input goes through whatever the agent is doing.
 */

const MOVE_INTERVAL_MS = 16;
/** Keys the page gets as key events; printable text goes as `text`, so IME and keyboard layouts are the OS's. */
const NAMED_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Insert', ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)]);

function socketUrl(sessionId: string): string {
  const url = new URL(PLUGIN_CHANNEL_ROUTE(BROWSER_PLUGIN_ID, BROWSER_LIVE_CHANNEL), window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}

const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): BrowserModifiers | undefined => {
  const value: BrowserModifiers = { ...(event.altKey ? { alt: true } : {}), ...(event.ctrlKey ? { ctrl: true } : {}), ...(event.metaKey ? { meta: true } : {}), ...(event.shiftKey ? { shift: true } : {}) };
  return Object.keys(value).length ? value : undefined;
};

export default function BrowserPanel({ context }: ViewProps) {
  if (!context.sessionId) return null;
  return <LiveBrowser key={context.sessionId} sessionId={context.sessionId} visible={context.visible} signal={context.signal} />;
}

function LiveBrowser({ sessionId, visible, signal }: { sessionId: string; visible: boolean; signal: AbortSignal }) {
  const m = useMessages(catalogs);
  const { ui, navigation } = usePluginHost();
  const [state, setState] = useState<BrowserLiveState>();
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const socket = useRef<WebSocket | undefined>(undefined);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const lastMove = useRef(0);
  const decoding = useRef(false);
  const queued = useRef<ArrayBuffer | undefined>(undefined);

  const send = useCallback((message: BrowserLiveClientMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  /** Draws the newest frame; frames that arrive while one decodes replace each other. */
  const draw = useCallback((data: ArrayBuffer) => {
    if (decoding.current) { queued.current = data; return; }
    decoding.current = true;
    void createImageBitmap(new Blob([data], { type: 'image/jpeg' })).then((bitmap) => {
      const element = canvas.current;
      if (element) {
        if (element.width !== bitmap.width || element.height !== bitmap.height) { element.width = bitmap.width; element.height = bitmap.height; }
        element.getContext('2d')?.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
    }).catch(() => undefined).finally(() => {
      decoding.current = false;
      const next = queued.current;
      queued.current = undefined;
      if (next) draw(next);
    });
  }, []);

  useEffect(() => {
    if (!visible) return;
    let closed = false;
    let retry: number | undefined;
    let delay = 1000;
    const connect = () => {
      const ws = new WebSocket(socketUrl(sessionId));
      ws.binaryType = 'arraybuffer';
      socket.current = ws;
      ws.onopen = () => { delay = 1000; };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') { draw(event.data as ArrayBuffer); return; }
        let message: BrowserLiveServerMessage;
        try { message = JSON.parse(event.data) as BrowserLiveServerMessage; } catch { return; }
        if (message.type === 'state') setState(message);
      };
      ws.onclose = (event) => {
        if (socket.current === ws) socket.current = undefined;
        // 4404 (no such conversation) and 4503 (plugin off) do not get better by retrying soon.
        if (closed || event.code === 4404) return;
        retry = window.setTimeout(connect, event.code === 4503 ? 10_000 : delay);
        delay = Math.min(delay * 2, 10_000);
      };
    };
    connect();
    const stop = () => { closed = true; window.clearTimeout(retry); socket.current?.close(); socket.current = undefined; };
    signal.addEventListener('abort', stop, { once: true });
    return () => { signal.removeEventListener('abort', stop); stop(); };
  }, [sessionId, visible, signal, draw]);

  const active = state?.tabs.find((tab) => tab.active);
  useEffect(() => { if (!editing) setAddress(active?.url ?? ''); }, [active?.url, editing]);

  /** Viewport CSS pixels of a pointer on the canvas. */
  const point = (event: { clientX: number; clientY: number }) => {
    const element = canvas.current;
    const viewport = state?.viewport;
    if (!element || !viewport) return undefined;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    return { x: Math.round(((event.clientX - rect.left) / rect.width) * viewport.width), y: Math.round(((event.clientY - rect.top) / rect.height) * viewport.height) };
  };
  const buttonOf = (button: number) => (button === 2 ? 'right' : button === 1 ? 'middle' : 'left');

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const at = point(event);
    if (!at) return;
    event.preventDefault();
    keys.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    send({ type: 'mouse', action: 'down', ...at, button: buttonOf(event.button), clickCount: Math.min(Math.max(event.detail, 1), 3), ...(modifiersOf(event) ? { modifiers: modifiersOf(event)! } : {}) });
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const at = point(event);
    if (at) send({ type: 'mouse', action: 'up', ...at, button: buttonOf(event.button), clickCount: Math.min(Math.max(event.detail, 1), 3) });
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const now = performance.now();
    if (now - lastMove.current < MOVE_INTERVAL_MS) return;
    lastMove.current = now;
    const at = point(event);
    if (at) send({ type: 'mouse', action: 'move', ...at });
  };

  // React's wheel listener is passive; the panel must not scroll while the page does.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const at = point(event);
      if (!at) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      send({ type: 'wheel', ...at, deltaX: event.deltaX * scale, deltaY: event.deltaY * scale });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  });

  const onKey = (action: 'down' | 'up') => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.key === 'Process' || event.key === 'Dead') return;
    const shortcut = event.ctrlKey || event.metaKey;
    // A paste is read from the clipboard event, so the system shortcut is left alone.
    if (shortcut && event.key.toLowerCase() === 'v') return;
    if (!NAMED_KEYS.has(event.key) && !(shortcut && event.key.length === 1)) return;
    event.preventDefault();
    send({ type: 'key', action, key: event.key, code: event.code, ...(modifiersOf(event) ? { modifiers: modifiersOf(event)! } : {}) });
  };
  const flushText = (target: HTMLTextAreaElement) => {
    if (target.value) send({ type: 'text', text: target.value });
    target.value = '';
  };

  const pending = state?.pending;
  const Icon = ui.icon;
  const BackIcon = Icon('chevron-right');
  const ReloadIcon = Icon('refresh-cw');
  const GlobeIcon = Icon('globe');
  const CloseIcon = Icon('x');
  const navButton = (label: string, onClick: () => void, icon: ReactNode, disabled = false) => (
    <ui.Tip label={label}><ui.Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick}>{icon}</ui.Button></ui.Tip>
  );
  const running = Boolean(state?.tabs.length);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        {navButton(m.back, () => send({ type: 'back' }), <BackIcon className="size-4 rotate-180" />, !running)}
        {navButton(m.forward, () => send({ type: 'forward' }), <BackIcon className="size-4" />, !running)}
        {navButton(m.reload, () => send({ type: 'reload' }), <ReloadIcon className="size-4" />, !running)}
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); if (address.trim()) send({ type: 'navigate', url: address.trim() }); setEditing(false); (document.activeElement as HTMLElement | null)?.blur(); }}>
          <ui.Input
            aria-label={m.address}
            value={address}
            disabled={!state?.installed}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(event) => setAddress(event.target.value)}
            className="h-7 w-full text-xs"
          />
        </form>
      </div>
      {(state?.tabs.length ?? 0) > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1">
          {state!.tabs.map((tab) => (
            <div key={tab.id} title={tab.url}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); send({ type: 'close', tab: tab.id }); } }}
              className={`group flex max-w-44 shrink-0 items-center rounded text-xs ${tab.active ? 'bg-hover text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg'}`}>
              <button type="button" onClick={() => send({ type: 'select', tab: tab.id })} className="min-w-0 truncate py-0.5 pl-2 text-left">
                {tab.title || tab.url}
              </button>
              <button type="button" aria-label={m.closeTab} onClick={() => send({ type: 'close', tab: tab.id })}
                className={`mx-0.5 grid size-4 shrink-0 place-items-center rounded text-fg-3 hover:bg-active hover:text-fg ${tab.active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}>
                <CloseIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {pending && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-warning-soft px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-fg">
            {pending.kind === 'confirm' ? `${m.category[pending.category]} · ${pending.target}` : pending.reason}
          </span>
          {pending.kind === 'confirm' ? (
            <>
              <ui.Button variant="ghost" size="xs" onClick={() => send({ type: 'answer', id: pending.id, allow: false })}>{m.deny}</ui.Button>
              <ui.Button variant="primary" size="xs" onClick={() => send({ type: 'answer', id: pending.id, allow: true })}>{m.allow}</ui.Button>
            </>
          ) : <ui.Button variant="primary" size="xs" onClick={() => send({ type: 'done' })}>{m.done}</ui.Button>}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-subtle">
        {state && !state.installed ? <div className="flex flex-col items-center gap-3 px-6 text-center text-sm text-fg-3">
            {m.notInstalled}
            {navigation.openPluginPage && <ui.Button variant="secondary" size="xs" onClick={() => navigation.openPluginPage?.()}>{m.openSettings}</ui.Button>}
          </div>
          : !running ? <GlobeIcon className="size-8 text-fg-4" />
            : (
              <canvas
                ref={canvas}
                tabIndex={-1}
                className={`block max-h-full max-w-full touch-none select-none cursor-default`}
                style={state ? { aspectRatio: `${state.viewport.width} / ${state.viewport.height}` } : undefined}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerMove={onPointerMove}
                onContextMenu={(event) => event.preventDefault()}
              />
            )}
        <textarea
          ref={keys}
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
          onKeyDown={onKey('down')}
          onKeyUp={onKey('up')}
          onInput={(event) => { if (!(event.nativeEvent as InputEvent).isComposing) flushText(event.currentTarget); }}
          onCompositionEnd={(event) => flushText(event.currentTarget)}
          onPaste={(event) => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); if (text) send({ type: 'text', text }); }}
        />
      </div>
    </div>
  );
}
