/*
 * IM channels (docs/design/channels.md): what `GET /api/channels` and its writes exchange with the
 * Web settings page. Secrets never appear here: `secretSet` only says one is stored.
 */

/** The declaration id of the IM platform (`contributes.imChannels`), e.g. `riffet.feishu/feishu`. Inputs still accept the bare `feishu` of older clients. */
export type ChannelKind = string;
export type ChannelDomain = 'feishu' | 'lark';

export interface ChannelConnectionStatus {
  state: 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error';
  /** Readable reason for `disconnected` / `error`. */
  error?: string;
  /** ISO time of the last event received from the platform. */
  lastEventAt?: string;
}

/** How a bot's reply card looks, per bot. Everything is on by default. */
export interface ChannelCardOptions {
  /** The title bar with the conversation's title. */
  header: boolean;
  /** Thinking and tool steps as the platform's process message above the card. */
  process: boolean;
  /** 中断 while the turn runs. */
  stopButton: boolean;
  /** Footer, left: the model with its fast / effort marks. Right: line changes, context use, elapsed time. */
  footer: { model: boolean; changes: boolean; context: boolean; elapsed: boolean };
}

export interface ChannelAccountInfo {
  id: string;
  kind: ChannelKind;
  appId: string;
  domain: ChannelDomain;
  enabled: boolean;
  /** The bot's display name and avatar, once known. */
  botName?: string;
  avatarUrl?: string;
  secretSet: boolean;
  status: ChannelConnectionStatus;
  /** `open`: a chat with the bot in the platform's client; `console`: the app in the developer console. */
  links: { open?: string; console?: string };
  card: ChannelCardOptions;
}

/**
 * Live checks behind the bot page's checklist (`GET /api/channels/accounts/:id/health`), cached
 * about a minute on the server. A check the platform could not answer is left undefined.
 */
export interface ChannelHealth {
  connected: boolean;
  /** The bot capability is on and the app is installed. */
  activated?: boolean;
  /** Required scopes not granted yet; empty when all are. */
  missingScopes?: string[];
  /** Opens the console page that requests `missingScopes`. */
  grantUrl?: string;
  /** Set once any message reached the bot. */
  lastEventAt?: string;
  /** Manual setup only: whether the console still needs the long-connection subscription saved. */
  needsLongConnection?: boolean;
}

/** `POST /api/channels/registrations`: the platform's scan-to-create flow; `appId` re-authorizes an existing bot instead. */
export interface ChannelRegistrationInput { kind: ChannelKind; appId?: string }
export interface ChannelRegistration {
  id: string;
  /** The verification URL the QR encodes; also opened directly in a browser. */
  url: string;
  /** The QR as an SVG document. */
  qr: string;
  expiresAt: string;
}
export interface ChannelRegistrationState {
  state: 'waiting' | 'done' | 'expired' | 'failed' | 'cancelled';
  /** Set when done: the bot created or re-authorized. */
  accountId?: string;
  error?: string;
}

/** A platform user allowed to drive this server through a channel. */
export interface ChannelIdentity {
  id: string;
  account: string;
  /** Feishu: the user's open_id under this app. */
  userId: string;
  name?: string;
  boundAt: string;
}

/** A chat the bot has been used in: its project and whether it shares one conversation. */
export interface ChannelChat {
  key: string;
  account: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  name?: string;
  projectId?: string;
  /** One conversation for the whole chat instead of one per thread. */
  flat: boolean;
  updatedAt: string;
}

/** An IM platform a plugin that is on provides; `register` when it offers scan-to-create. */
export interface ChannelProviderInfo { id: ChannelKind; register: boolean }

export interface ChannelsState {
  /** What a new bot can be added for; an account of a platform not listed stays, but cannot connect. */
  providers: ChannelProviderInfo[];
  accounts: ChannelAccountInfo[];
  identities: ChannelIdentity[];
  chats: ChannelChat[];
}

/** `POST /api/channels/accounts` (create) and `PATCH /api/channels/accounts/:id` (all optional). */
export interface ChannelAccountInput {
  kind: ChannelKind;
  appId: string;
  /** Omitted on PATCH keeps the stored secret. */
  appSecret?: string;
  domain: ChannelDomain;
  enabled: boolean;
  /** PATCH only; a partial value is merged (and `footer` field by field). Changing it never reconnects. */
  card?: Partial<Omit<ChannelCardOptions, 'footer'>> & { footer?: Partial<ChannelCardOptions['footer']> };
}

/** `POST /api/channels/accounts/:id/bind-code`: the user sends `/bind <code>` to the bot in a private chat. */
export interface ChannelBindCode { code: string; expiresAt: string }

/*
 * Routes (all behind the normal login):
 *   GET    /api/channels                          → ChannelsState
 *   POST   /api/channels/accounts                 ChannelAccountInput → ChannelAccountInfo
 *   PATCH  /api/channels/accounts/:id             Partial<ChannelAccountInput> → ChannelAccountInfo
 *   DELETE /api/channels/accounts/:id             → { ok: true }
 *   POST   /api/channels/accounts/:id/bind-code   → ChannelBindCode
 *   DELETE /api/channels/identities/:id           → { ok: true }
 *   PATCH  /api/channels/chats/:key               { projectId?: string | null; flat?: boolean } → ChannelChat
 *   DELETE /api/channels/chats/:key               → { ok: true }   (forgets the chat and its conversation bindings)
 *   GET    /api/channels/accounts/:id/health      → ChannelHealth
 *   POST   /api/channels/registrations            ChannelRegistrationInput → ChannelRegistration
 *   GET    /api/channels/registrations/:id        → ChannelRegistrationState   (the page polls every 2s)
 *   DELETE /api/channels/registrations/:id        → { ok: true }
 * Changes are also announced on `/api/lists/stream` as `event: channels` (no payload) so the page refetches.
 */
