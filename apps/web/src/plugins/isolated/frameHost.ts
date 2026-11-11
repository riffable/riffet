import { BRIDGE_INIT, BRIDGE_READY, BRIDGE_VERSION, type BridgeEvent, type BridgeEvents } from '@riffet/plugin-web';
import { serveBridge, type Bridge, type BridgeGrant, type BridgePort, type BridgeServices } from './bridgeHost';

/*
 * Hands a frame its channel. The page the host built asks (`BRIDGE_READY`, see `CHANNEL_SCRIPT` in
 * `document.ts`) before any of the view's code exists, and the host answers only the window it embedded:
 * `event.source` is the browser's own account of who posted, so another frame, another window or a
 * script on the page cannot get a port, and a message that names a plugin means nothing. The reply
 * carries one end of a fresh `MessageChannel`; every later request arrives on that port, which is what
 * binds it to this view's context and grant. One channel per attach: the page's own ask is the first
 * the window can have sent (messages of one sender arrive in order), and any later ask, such as one from
 * a page the frame navigated to, is ignored, so it cannot take over the bridge, and a handshake cannot
 * reset the channel's limits. A navigation is a second `load`, which drops the view (`IsolatedView`).
 * The ask is not gated on the frame's first `load`: Chrome fires `load` before it delivers a message
 * the page posted while loading, so a gate there would refuse the page's own ask.
 */

export interface FrameChannel {
  push<E extends BridgeEvent>(event: E, data: BridgeEvents[E]): void;
  /** Stops listening and closes the channel. Idempotent. */
  dispose(): void;
}

/** What the host needs of the window it listens on: the real `window`, or a stand-in in a test. */
export interface MessageSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** The embedded window: `postMessage` with a transferred port. */
export interface FrameWindow {
  postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void;
}

export function attachFrame({ frame, grant, services, listenOn = window, createChannel = () => new MessageChannel() }: {
  /** The frame's window now; null before it exists or after it is gone. */
  frame: () => FrameWindow | null;
  grant: BridgeGrant;
  services: BridgeServices;
  listenOn?: MessageSource;
  createChannel?: () => { port1: BridgePort; port2: MessagePort };
}): FrameChannel {
  let bridge: Bridge | undefined;
  let disposed = false;

  const onMessage = (event: MessageEvent) => {
    const target = frame();
    const data = event.data as { type?: unknown; version?: unknown } | null;
    if (disposed || !target || (event.source as unknown) !== target) return;
    if (!data || typeof data !== 'object' || data.type !== BRIDGE_READY || data.version !== BRIDGE_VERSION) return;
    if (bridge) return;
    const channel = createChannel();
    bridge = serveBridge({ port: channel.port1, grant, services });
    // An opaque origin cannot be named, so the target is any origin: the port goes to `target`, the window this host embedded.
    target.postMessage({ type: BRIDGE_INIT, version: BRIDGE_VERSION }, '*', [channel.port2]);
  };
  listenOn.addEventListener('message', onMessage);

  return {
    push: (event, data) => bridge?.push(event, data),
    dispose() {
      if (disposed) return;
      disposed = true;
      listenOn.removeEventListener('message', onMessage);
      bridge?.close();
      bridge = undefined;
    },
  };
}
