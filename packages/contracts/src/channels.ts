/*
 * IM channels (docs/design/channels.md): what `GET /api/channels` and its writes exchange with the
 * Web settings page. Secrets never appear here: `secretSet` only says they are stored.
 */

import type { LocalizedText } from './plugins.js';

/** The declaration id of the IM platform (`contributes.imChannels`), e.g. `riffet.channel-feishu/feishu`. Inputs still accept the bare `feishu` of older clients. */
export type ChannelKind = string;
/** @deprecated Legacy Feishu region string; new platforms store non-secret fields in `config`. */
export type ChannelDomain = string;

export interface ChannelConnectionStatus {
  state: 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error';
  /** Readable reason for `disconnected` / `error`. */
  error?: string;
  /** ISO time of the last event received from the platform. */
  lastEventAt?: string;
}

/** One option of a `select` credential/config field declared by a channel provider. */
export interface ChannelFieldOption {
  value: string;
  label: LocalizedText;
}

/** One manual setup / credential field declared by a channel provider. */
export interface ChannelFieldSpec {
  key: string;
  label: LocalizedText;
  kind: 'text' | 'secret' | 'select';
  required?: boolean;
  /** Collapsed under an optional section unless already filled or editing after a failure. */
  advanced?: boolean;
  /** Cannot be edited once the bot account has been created (e.g. Feishu App ID). */
  immutable?: boolean;
  /** Monospace font for IDs, tokens and URLs. */
  mono?: boolean;
  placeholder?: LocalizedText;
  defaultValue?: string;
  options?: ChannelFieldOption[];
}

/** Which turn-card customization toggles a channel platform honors. */
export interface ChannelCardCapabilities {
  process?: boolean;
  header?: boolean;
  stopButton?: boolean;
  footer?: boolean;
}

/** Short platform-specific facts shown in onboarding and account management. */
export interface ChannelProviderHints {
  /** One-line setup method shown under the platform name in the picker. */
  summary?: LocalizedText;
  /** One-line source of manual credentials shown above the form (e.g. "向 @BotFather 发送 /newbot 获取 Token"). */
  credentialSource?: LocalizedText;
  /** Link to the external console / bot creator alongside `credentialSource`. */
  credentialUrl?: string;
  credentialLinkLabel?: LocalizedText;
  /** Extra step in the platform console after connecting a manually configured bot (e.g. Feishu long connection). */
  manualSetupStep?: LocalizedText;
  /** Note shown when deleting a bot account (e.g. "飞书里的应用不会被删除"). */
  deleteNote?: LocalizedText;
}

/** Copyable platform identifier shown under the bot's name (e.g. Feishu App ID or Telegram @username). */
export interface ChannelAccountIdentity {
  label: LocalizedText;
  value: string;
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
  /** Non-secret platform configuration values keyed by `ChannelFieldSpec.key`. */
  config: Record<string, string>;
  /** Legacy Feishu fields kept for older clients (e.g. frozen macOS settings). */
  appId: string;
  domain: ChannelDomain;
  enabled: boolean;
  /** The bot's display name and avatar, once known. */
  botName?: string;
  avatarUrl?: string;
  /** Optional short badge shown next to the bot name in the list (e.g. "Lark"). */
  badge?: string;
  /** Optional copyable identifier shown under the bot name on the detail page. */
  identity?: ChannelAccountIdentity;
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
  /** Manual setup only: whether the platform console still needs a post-connect step (described by `provider.hints.manualSetupStep`). */
  needsLongConnection?: boolean;
}

/** `POST /api/channels/registrations`: the platform's scan-to-create flow; `externalId` (or legacy `appId`) re-authorizes an existing bot. */
export interface ChannelRegistrationInput { kind: ChannelKind; externalId?: string; appId?: string }
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
  /** Platform-scoped user identifier (e.g. Feishu open_id, Telegram user id). */
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

/** An IM platform a plugin that is on provides; drives generic onboarding and settings UI. */
export interface ChannelProviderInfo {
  id: ChannelKind;
  title: LocalizedText;
  register: boolean;
  fields: ChannelFieldSpec[];
  capabilities: { edit: boolean; actions: 'forms' | 'buttons' | 'none'; threads: boolean };
  card?: ChannelCardCapabilities;
  hints?: ChannelProviderHints;
}

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
  /** Non-secret platform configuration values keyed by `ChannelFieldSpec.key`. */
  config?: Record<string, string>;
  /** Secret values keyed by `ChannelFieldSpec.key`; omitted keys on PATCH keep stored values. */
  secrets?: Record<string, string>;
  /** Legacy Feishu inputs accepted for backward compatibility with older clients. */
  appId?: string;
  /** Omitted on PATCH keeps the stored secret. */
  appSecret?: string;
  domain?: ChannelDomain;
  enabled?: boolean;
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
