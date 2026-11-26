import type { ChannelCardOptions, ChannelChat, ChannelKind } from '../../../../packages/contracts/src/channels.js';
import type { Store } from '../store.js';
import type { ChannelAddress, SurfaceState } from './types.js';

/*
 * Everything the channel core remembers, in the store's settings table under `channels:*`
 * (docs/design/channels.md, 持久化与恢复). Each read-modify-write is one synchronous step, so a
 * claim or a binding is atomic without a lock.
 */

const SEEN_TTL_MS = 7 * 24 * 60 * 60_000;
const SEEN_CAP = 2000;

export type CardPatch = Partial<Omit<ChannelCardOptions, 'footer'>> & { footer?: Partial<ChannelCardOptions['footer']> };
export const DEFAULT_CARD: ChannelCardOptions = { header: true, process: true, stopButton: true, footer: { model: true, changes: true, context: true, elapsed: true } };

/** The full options: defaults, then the stored values, then the patch; footer field by field. */
export function mergeCard(...layers: Array<CardPatch | undefined>): ChannelCardOptions {
  return layers.reduce<ChannelCardOptions>((card, layer) => layer ? { ...card, ...pickBooleans(layer), footer: { ...card.footer, ...pickBooleans(layer.footer) } } as ChannelCardOptions : card, DEFAULT_CARD);
}
function pickBooleans(value: object | undefined): Record<string, boolean> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key, item]) => key !== 'footer' && typeof item === 'boolean')) as Record<string, boolean>;
}

export interface StoredAccount {
  id: string;
  kind: ChannelKind;
  /** Non-secret platform configuration values keyed by `ChannelFieldSpec.key`. */
  config?: Record<string, string>;
  /** Stable platform identifier for deduplicating scan-to-create (e.g. Feishu App ID). */
  externalId?: string;
  /** Legacy Feishu fields kept for reading pre-generalization records. */
  appId?: string;
  domain?: string;
  enabled: boolean;
  /** How it was added; records from before this field are manual. */
  source?: 'scan' | 'manual';
  /** Only what was changed from the defaults; read through `mergeCard`. */
  card?: CardPatch;
  /** Fallback project for chats under this account that have not bound a project of their own. */
  defaultProjectId?: string;
}

/** Normalizes a stored account from either the legacy Feishu shape or the generic `config` shape. */
export function accountConfig(account: Pick<StoredAccount, 'config' | 'appId' | 'domain'>): Record<string, string> {
  const out: Record<string, string> = {};
  if (account.appId) out.appId = account.appId;
  if (account.domain) out.domain = account.domain;
  for (const [key, value] of Object.entries(account.config ?? {})) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}
export interface StoredIdentity { id: string; account: string; userId: string; name?: string; boundAt: string }
/** `anchorMessageId`: a real message of the chat to reply under (a topic's thread id is not one). */
export interface StoredConversation { sessionId: string; address: ChannelAddress; anchorMessageId?: string }
/** A turn card not yet finished: what a restart needs to take it over again. */
export interface StoredSurface {
  account: string; address: ChannelAddress; sessionId: string; runId: string;
  source: 'channel' | 'other-client'; anchor?: { messageId: string; inThread: boolean }; state: SurfaceState;
}

/** What new conversations of a chat start on, set by `/model`; `model` is the full selection string. */
export interface ChatModelDefaults { backendId?: string; model?: string }

/** Kinds stored or sent before platforms became plugin declarations (docs/design/channels.md「插件化」). */
const LEGACY_KINDS: Record<string, ChannelKind> = {
  feishu: 'riffet.channel-feishu/feishu',
  'riffet.feishu/feishu': 'riffet.channel-feishu/feishu',
};
export const channelKind = (kind: string): ChannelKind => Object.hasOwn(LEGACY_KINDS, kind) ? LEGACY_KINDS[kind]! : kind;

export const chatKey = (account: string, chatId: string) => `${account}:${chatId}`;

/** The keys one conversation is known by: its address, and every alias the platform may name the thread by. */
export function addressKeys(address: ChannelAddress, flat: boolean): string[] {
  const base = chatKey(address.account, address.chatId);
  if (flat) return [`${base}:*`];
  return [...new Set([address.threadKey ?? '*', ...(address.aliases ?? [])])].map(key => `${base}:${key}`);
}

export class ChannelBindings {
  constructor(private readonly store: Store) {}

  private read<T>(key: string): Record<string, T> { return Object.assign(Object.create(null) as Record<string, T>, this.store.getSetting<Record<string, T>>(`channels:${key}`, {})); }
  private write<T>(key: string, value: Record<string, T>): void {
    if (key === 'conversations') this.sessionIndex = undefined;
    this.store.setSetting(`channels:${key}`, value);
  }
  /** Run changes are frequent; whether a session is bound must not parse the table each time. */
  private sessionIndex?: Map<string, StoredConversation>;

  // ---- accounts and identities -----------------------------------------------------------------

  accounts(): StoredAccount[] {
    return Object.values(this.read<StoredAccount>('accounts')).map(account => {
      const config = accountConfig(account);
      const externalId = account.externalId ?? config.appId;
      return { ...account, kind: channelKind(account.kind), config, ...(externalId ? { externalId } : {}) };
    });
  }
  setAccount(account: StoredAccount): void { const all = this.read<StoredAccount>('accounts'); all[account.id] = account; this.write('accounts', all); }
  removeAccount(id: string): void {
    const accounts = this.read<StoredAccount>('accounts'); delete accounts[id]; this.write('accounts', accounts);
    const identities = this.read<StoredIdentity>('identities');
    for (const [key, value] of Object.entries(identities)) if (value.account === id) delete identities[key];
    this.write('identities', identities);
    const chats = this.read<ChannelChat>('chats');
    for (const [key, value] of Object.entries(chats)) if (value.account === id) delete chats[key];
    this.write('chats', chats);
    const models = this.read<ChatModelDefaults>('chat-models');
    for (const key of Object.keys(models)) if (key.startsWith(`${id}:`)) delete models[key];
    this.write('chat-models', models);
    const conversations = this.read<StoredConversation>('conversations');
    for (const [key, value] of Object.entries(conversations)) if (value.address.account === id) delete conversations[key];
    this.write('conversations', conversations);
  }

  identities(): StoredIdentity[] { return Object.values(this.read<StoredIdentity>('identities')); }
  identity(account: string, userId: string): StoredIdentity | undefined { return this.identities().find(item => item.account === account && item.userId === userId); }
  setIdentity(identity: StoredIdentity): void { const all = this.read<StoredIdentity>('identities'); all[identity.id] = identity; this.write('identities', all); }
  removeIdentity(id: string): boolean {
    const all = this.read<StoredIdentity>('identities');
    if (!all[id]) return false;
    delete all[id]; this.write('identities', all);
    return true;
  }

  // ---- dedupe ------------------------------------------------------------------------------------

  /** Records `account:messageId` and says whether this was the first time. Rejected messages are recorded too. */
  claim(key: string, now = Date.now()): boolean {
    const seen = this.read<number>('seen');
    if (seen[key] !== undefined) return false;
    seen[key] = now;
    const entries = Object.entries(seen);
    if (entries.length > SEEN_CAP || entries.some(([, at]) => now - at > SEEN_TTL_MS)) {
      const kept = entries.filter(([, at]) => now - at <= SEEN_TTL_MS).sort((left, right) => right[1] - left[1]).slice(0, SEEN_CAP);
      this.write('seen', Object.fromEntries(kept));
    } else this.write('seen', seen);
    return true;
  }

  // ---- chats -------------------------------------------------------------------------------------

  chats(): ChannelChat[] { return Object.values(this.read<ChannelChat>('chats')); }
  chat(key: string): ChannelChat | undefined { return this.read<ChannelChat>('chats')[key]; }
  /** Creates the chat on first sight and returns it; `patch` fields replace stored ones. */
  touchChat(account: string, chatId: string, chatType: 'p2p' | 'group', patch: Partial<Pick<ChannelChat, 'projectId' | 'flat' | 'name'>> = {}): ChannelChat {
    const key = chatKey(account, chatId);
    const all = this.read<ChannelChat>('chats');
    const chat: ChannelChat = { ...(all[key] ?? { key, account, chatId, chatType, flat: false }), ...patch, updatedAt: new Date().toISOString() };
    all[key] = chat;
    this.write('chats', all);
    return chat;
  }
  clearChatProject(key: string): ChannelChat | undefined {
    const all = this.read<ChannelChat>('chats');
    const chat = all[key];
    if (!chat) return undefined;
    delete chat.projectId;
    chat.updatedAt = new Date().toISOString();
    this.write('chats', all);
    return chat;
  }
  chatModel(key: string): ChatModelDefaults { return this.read<ChatModelDefaults>('chat-models')[key] ?? {}; }
  setChatModel(key: string, value: ChatModelDefaults): void {
    const all = this.read<ChatModelDefaults>('chat-models');
    if (value.backendId || value.model) all[key] = value; else delete all[key];
    this.write('chat-models', all);
  }
  /** Forgets the chat and every conversation binding under it. */
  removeChat(key: string): boolean {
    const all = this.read<ChannelChat>('chats');
    if (!all[key]) return false;
    delete all[key]; this.write('chats', all);
    const models = this.read<ChatModelDefaults>('chat-models');
    delete models[key]; this.write('chat-models', models);
    const conversations = this.read<StoredConversation>('conversations');
    for (const [name, value] of Object.entries(conversations)) if (chatKey(value.address.account, value.address.chatId) === key) delete conversations[name];
    this.write('conversations', conversations);
    return true;
  }

  // ---- conversations -----------------------------------------------------------------------------

  conversations(): StoredConversation[] { return Object.values(this.read<StoredConversation>('conversations')); }
  /** The conversation any key of the address names; the keys it was missing are written, so the next lookup hits either. */
  conversation(address: ChannelAddress, flat: boolean): StoredConversation | undefined {
    const keys = addressKeys(address, flat);
    const all = this.read<StoredConversation>('conversations');
    const hit = keys.map(key => all[key]).find(value => value !== undefined);
    if (hit && keys.some(key => all[key] === undefined)) { for (const key of keys) all[key] ??= hit; this.write('conversations', all); }
    return hit;
  }
  bind(address: ChannelAddress, flat: boolean, sessionId: string, anchorMessageId?: string): void {
    const all = this.read<StoredConversation>('conversations');
    const { aliases: _aliases, chatName: _chatName, ...primary } = address;
    for (const key of addressKeys(address, flat)) all[key] = { sessionId, address: primary, ...(anchorMessageId ? { anchorMessageId } : {}) };
    this.write('conversations', all);
  }
  /** Remembers the latest inbound message of a bound conversation as where unprompted replies attach. */
  setAnchor(sessionId: string, anchorMessageId: string): void {
    const all = this.read<StoredConversation>('conversations');
    let changed = false;
    for (const value of Object.values(all)) if (value.sessionId === sessionId && value.anchorMessageId !== anchorMessageId) { value.anchorMessageId = anchorMessageId; changed = true; }
    if (changed) this.write('conversations', all);
  }
  unbind(address: ChannelAddress, flat: boolean): void {
    const all = this.read<StoredConversation>('conversations');
    const hit = this.conversation(address, flat);
    for (const key of addressKeys(address, flat)) delete all[key];
    // The aliases a later turn added under another key still name the same conversation.
    if (hit) for (const [key, value] of Object.entries(all)) if (value.sessionId === hit.sessionId && value.address.chatId === address.chatId) delete all[key];
    this.write('conversations', all);
  }
  /** The address a session's turns are written back to. */
  addressOf(sessionId: string): ChannelAddress | undefined { return this.conversationOf(sessionId)?.address; }
  /** The reply anchor message stored with the session's conversation. */
  anchorOf(sessionId: string): string | undefined { return this.conversationOf(sessionId)?.anchorMessageId; }
  private conversationOf(sessionId: string): StoredConversation | undefined {
    if (!this.sessionIndex) this.sessionIndex = new Map(Object.values(this.read<StoredConversation>('conversations')).map(value => [value.sessionId, value]));
    return this.sessionIndex.get(sessionId);
  }

  // ---- unfinished turn cards -----------------------------------------------------------------------

  surfaces(): StoredSurface[] { return Object.values(this.read<StoredSurface>('surfaces')); }
  setSurface(surface: StoredSurface): void { const all = this.read<StoredSurface>('surfaces'); all[surface.runId] = surface; this.write('surfaces', all); }
  removeSurface(runId: string): void {
    const all = this.read<StoredSurface>('surfaces');
    if (!all[runId]) return;
    delete all[runId]; this.write('surfaces', all);
  }
}
