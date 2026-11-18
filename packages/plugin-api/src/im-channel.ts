// IM channels (docs/design/channels.md「插件化」): what a plugin that declares `contributes.imChannels` implements.
//
// A provider turns platform events into `InboundMessage` / `InboundAction` and renders what the channel layer hands it.
// It never reaches sessions, bindings or identities: the core owns them, the gate and the store.

import type { NativeInteraction } from '@riffet/contracts';
import type { ChannelAccountInfo, ChannelCardOptions, ChannelConnectionStatus, ChannelKind } from '@riffet/contracts';

export type { ChannelConnectionStatus, ChannelKind };


/** One configured bot, with its secret. The secret never leaves the server. */
export interface ChannelAccount extends Omit<ChannelAccountInfo, 'secretSet' | 'status' | 'links' | 'botName' | 'avatarUrl' | 'card'> {
  appSecret: string;
}

/**
 * Where a conversation lives on the platform. `threadKey` is the platform's thread identity, or
 * absent for a chat-wide (flat) conversation. `aliases` are other keys the same thread is also
 * known by (a Feishu topic is first seen by `thread_id`, later by `root_id`); the core binds all.
 */
export interface ChannelAddress {
  account: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadKey?: string;
  aliases?: string[];
}

/** What a reply attaches to: the platform message it answers, and whether to open/stay in a thread. */
export interface ReplyAnchor { messageId: string; inThread: boolean }

/** A message the provider sent, enough to edit or follow it after a restart. */
export interface SentRef { messageId: string; extra?: Record<string, string> }

export interface InboundAttachment {
  kind: 'image' | 'file';
  name?: string;
  /** Downloads the bytes from the platform; called only after the gate admitted the message. */
  download(): Promise<{ data: Buffer; mimeType: string; name: string }>;
}

export interface InboundMessage {
  account: string;
  /** The platform message id: the dedupe key and the run's commandId. */
  messageId: string;
  address: ChannelAddress;
  sender: { id: string; name?: string };
  /** Plain text with the bot's own mention removed. */
  text: string;
  attachments: InboundAttachment[];
  mentionsBot: boolean;
  /** Already inside a thread/topic (a reply there continues it). */
  inThread: boolean;
  /** Where a reply to this message goes. */
  anchor: ReplyAnchor;
}

/**
 * A press on something the core rendered. `ref` is the opaque id the core put on the control
 * (see `ActionSpec`); `value` is the chosen option ids / typed text for forms.
 */
export interface InboundAction {
  account: string;
  /** Platform callback id: idempotency key for answering an interaction. */
  eventId: string;
  operator: { id: string };
  ref: string;
  action: string;
  selectedIds?: string[];
  otherText?: string;
}

/** What the platform shows right away in reply to an action (a toast, and/or the card redrawn). */
export interface ActionReply {
  toast?: { tone: 'info' | 'success' | 'warning' | 'error'; text: string };
  /** Redraw the pressed message with this state; the provider renders it. */
  redraw?: InteractionView | ProjectPickerView | PanelView;
}

/** One step of the process, keyed by the timeline row it came from; text only ever grows. */
export interface TurnStep {
  id: string;
  kind: 'thought' | 'narration' | 'tool' | 'plan';
  /** Tool: its one-line label ("Read src/app.ts"); plan: "计划". */
  title?: string;
  text: string;
  state: 'running' | 'done' | 'failed';
  /** Tool output, already trimmed and redacted by the core. */
  output?: string;
}

/** What the card's footer may show; the provider lays it out and `card.footer` picks the parts. */
export interface TurnFooter {
  /** The model's display name ("Opus 5.5"), never the raw selection string. */
  model?: string;
  /** Marks of the model selection worth showing beside it: "fast", an effort like "high". */
  modelMarks?: string[];
  elapsedMs?: number;
  /** Context window use, 0-100, when the backend reports it. */
  contextPercent?: number;
  /** Lines added / removed by the turn's edits, when it made any. */
  changes?: { added: number; removed: number };
}

/** Everything a provider needs to draw one turn. Rebuilt whole on every change; providers diff. */
export interface TurnView {
  sessionId: string;
  runId: string;
  title: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** `other-client`: the turn was sent from Web/Mac/mobile, so the prompt is shown with it. */
  source: 'channel' | 'other-client';
  prompt?: string;
  steps: TurnStep[];
  /** Markdown. */
  answer: string;
  error?: string;
  footer: TurnFooter;
  /** The bot's card options at the time of this view; providers honour them on every render. */
  card: ChannelCardOptions;
  /** Opaque ref for the stop control; absent once the turn ended. */
  stopRef?: string;
}

export interface TurnSurface {
  /** Coalesced and throttled by the provider; never throws. */
  update(view: TurnView): void;
  /** Must be called on every terminal path; renders the final state and releases resources. */
  finish(view: TurnView): Promise<void>;
  /** Persisted by the core so a restart can take the surface over again (`resumeTurn`). */
  state(): SurfaceState;
}
export interface SurfaceState { kind: ChannelKind; data: Record<string, unknown> }

export interface InteractionView {
  kind: 'interaction';
  interaction: NativeInteraction;
  /** Opaque ref the provider puts on every control of this card. */
  ref: string;
  /** Set once answered elsewhere, expired, or the turn ended. */
  closed?: { outcome: 'answered' | 'answered-elsewhere' | 'expired' | 'cancelled'; label?: string };
}

export interface ProjectPickerView {
  kind: 'project-picker';
  ref: string;
  projects: Array<{ id: string; name: string; path?: string }>;
  selectedId?: string;
  /** Set once picked. */
  closed?: boolean;
}

/**
 * `/model`: the model of the current conversation (`scope: 'session'`) or of this chat's new
 * conversations (`'chat'`, where the agent can be chosen too). Each control's choices are already
 * narrowed to what the selected model offers; a press redraws the card in place.
 */
export interface ModelPickerView {
  kind: 'model-picker';
  ref: string;
  scope: 'session' | 'chat';
  /** The agent (backend); `backends` only when `scope` is 'chat'. */
  backend: { id: string; name: string };
  backends?: Array<{ id: string; name: string }>;
  models: Array<{ id: string; name: string }>;
  modelId: string;
  /** Effort, context window, speed… of the selected model; a control the model lacks is absent. */
  params: Array<{ id: string; label: string; value: string; options: Array<{ value: string; label: string }> }>;
  /** The selection as the footer shows it: "Opus 5.5 · fast · high". */
  summary: string;
  /** A short note under the summary, e.g. that the change applies from the next turn. */
  note?: string;
  error?: string;
}

/** `/` or `/help`: the commands by group, then a few quick buttons; a button press runs its command as if typed. */
export interface CommandPanelView {
  kind: 'command-panel';
  ref: string;
  sections: Array<{ title: string; commands: Array<{ usage: string; description: string }> }>;
  quick: Array<{ action: string; label: string }>;
  note?: string;
}

export type PanelView = ModelPickerView | CommandPanelView;

export interface ChannelContext {
  inbound(message: InboundMessage): void;
  action(action: InboundAction): Promise<ActionReply>;
  /** The provider reports connection changes here; the core shows them in settings. */
  status(status: ChannelConnectionStatus): void;
  signal: AbortSignal;
  log: { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void };
}

export interface ChannelConnection {
  /** The bot's display name on the platform, once known. */
  readonly botName?: string;
  readonly avatarUrl?: string;
  openTurn(address: ChannelAddress, view: TurnView, anchor?: ReplyAnchor): Promise<TurnSurface>;
  /** Takes a surface persisted before a restart over again; undefined when it cannot. */
  resumeTurn(address: ChannelAddress, state: SurfaceState): Promise<TurnSurface | undefined>;
  showInteraction(address: ChannelAddress, view: InteractionView, anchor?: ReplyAnchor): Promise<SentRef>;
  updateInteraction(sent: SentRef, view: InteractionView): Promise<void>;
  showProjectPicker(address: ChannelAddress, view: ProjectPickerView, anchor: ReplyAnchor): Promise<SentRef>;
  /**
   * A model picker or command panel. Presses come back as `InboundAction`s on `view.ref`: a command
   * button as `action: <command action>`; a picker select as `action: 'backend' | 'model' | 'param:<id>'`
   * with the chosen value in `selectedIds[0]`.
   */
  showPanel(address: ChannelAddress, view: PanelView, anchor?: ReplyAnchor): Promise<SentRef>;
  /** Redraws a panel after work done outside the callback (e.g. a change that failed later). */
  updatePanel(sent: SentRef, view: PanelView): Promise<void>;
  /** A short markdown notice (command results, errors, bind confirmations). */
  send(address: ChannelAddress, markdown: string, anchor?: ReplyAnchor): Promise<SentRef>;
  /** Marks the user's message as received / done (Feishu: a reaction). Best effort. */
  acknowledge(anchor: ReplyAnchor, state: 'received' | 'done' | 'failed'): Promise<void>;
  close(): Promise<void>;
}

/** What a provider reports for the checklist; undefined fields are checks it could not make. */
export interface ProviderHealth { activated?: boolean; missingScopes?: string[]; botName?: string; avatarUrl?: string }

/** The result of a platform's scan-to-create (or re-authorize) flow. */
export interface ProviderRegistration {
  appId: string;
  appSecret: string;
  domain: ChannelAccount['domain'];
  /** The platform user who scanned: becomes a bound identity of the new bot. */
  userId?: string;
}

/** One IM platform, keyed in `Contributions.imChannels` by the id declared in `contributes.imChannels`. */
export interface ImChannelProvider {
  capabilities: { edit: boolean; actions: 'forms' | 'buttons' | 'none'; threads: boolean };
  connect(account: ChannelAccount, context: ChannelContext): Promise<ChannelConnection>;
  /** Scan-to-create: calls `ready` with the URL to show, resolves once the user confirmed. `appId` re-authorizes that bot. */
  register?(input: { appId?: string; ownerName?: string; signal: AbortSignal; ready: (url: string, expiresInSeconds: number) => void }): Promise<ProviderRegistration>;
  /** Live checks with the stored credentials; never throws. */
  health?(account: ChannelAccount): Promise<ProviderHealth>;
  links(account: Pick<ChannelAccount, 'appId' | 'domain'>, missingScopes?: string[]): { open?: string; console?: string; grant?: string };
}
