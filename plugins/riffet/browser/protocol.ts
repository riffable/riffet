// The live channel `riffet.browser/live` (docs/BROWSER.md §5), shared by the server side and the web panel; the macOS
// panel speaks the same messages. Text messages are JSON; a binary message is one JPEG frame of the active tab, drawn
// at `BrowserLiveState.viewport` (CSS pixels). Pure types and constants: no Node, no DOM.

export const BROWSER_PLUGIN_ID = 'riffet.browser';
export const BROWSER_TOOL_GROUP = 'riffet.browser/browser';
export const BROWSER_VIEW = 'riffet.browser/panel';
/** The channel's name, the part after the plugin id. */
export const BROWSER_LIVE_CHANNEL = 'live';

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

/** What the agent is waiting on the user for. `confirm` is a risky step (docs/BROWSER.md §6); `handoff` is `browser_handoff`. */
export type BrowserPending =
  | { id: string; kind: 'confirm'; category: BrowserRiskCategory; target: string; text?: string; url: string; expiresAt: string }
  | { id: string; kind: 'handoff'; reason: string; url: string; expiresAt?: string };

export type BrowserRiskCategory = 'send' | 'submit' | 'delete' | 'order' | 'pay';

/** Sent on connect and after every change. */
export interface BrowserLiveState {
  type: 'state';
  /** Whether a browser is installed; when not, the panel offers nothing but the plugin's settings. */
  installed: boolean;
  /** Whether the conversation's browser is running (it starts on the first tool call and stops when idle). */
  running: boolean;
  tabs: BrowserTab[];
  viewport: { width: number; height: number };
  pending?: BrowserPending;
}

export type BrowserLiveServerMessage = BrowserLiveState | { type: 'error'; code: string; message: string };

export interface BrowserModifiers { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }

/**
 * From a viewer. Input (`mouse`, `key`, `text`, navigation) goes to the page whatever the agent is doing; the agent's
 * next result says the user operated it. `done` answers a `browser_handoff`. Coordinates are viewport CSS pixels.
 */
export type BrowserLiveClientMessage =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: BrowserModifiers }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: BrowserModifiers }
  | { type: 'key'; action: 'down' | 'up'; key: string; code?: string; modifiers?: BrowserModifiers }
  /** Committed IME text or a paste. */
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' } | { type: 'forward' } | { type: 'reload' }
  | { type: 'select'; tab: string }
  | { type: 'close'; tab: string }
  | { type: 'done' }
  | { type: 'answer'; id: string; allow: boolean };
