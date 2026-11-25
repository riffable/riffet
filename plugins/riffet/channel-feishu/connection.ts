/*
 * The long connection (SDK WSClient + EventDispatcher) and the normalization of what arrives on it.
 * Only one Riffet instance may hold a given app's connection: Feishu hands each event to a random
 * one of them, so a second connection shows up as lost messages.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import type { ChannelAccount, ChannelAddress, ChannelContext, InboundAttachment, InboundMessage } from '@riffet/plugin-api';
import { normalizeCardAction, toCallbackResponse } from './actions.js';
import type { FeishuApi } from './openapi.js';

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose => (value && typeof value === 'object' ? value as Loose : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const READY_TIMEOUT_MS = 25_000;
const HEALTH_CHECK_MS = 30_000;
const STATUS_REPORT_MS = 5_000;

// ── Event normalization ──

export interface NormalizeDeps {
  account: string;
  botOpenId: string;
  download(messageId: string, key: string, type: 'image' | 'file'): Promise<{ data: Buffer; mimeType: string }>;
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/heic': 'heic' };

interface Mention { key: string; openId?: string; name?: string }

/** A post's content is `{ title, content }`, or the same under a locale key. */
function postBody(content: Loose): { title?: string; rows: unknown[][] } {
  const body = Array.isArray(content.content) ? content : Object.values(content).map(record).find(candidate => Array.isArray(candidate.content)) ?? {};
  return { title: text(body.title), rows: Array.isArray(body.content) ? body.content.filter(Array.isArray) as unknown[][] : [] };
}

/**
 * One `im.message.receive_v1` event as an `InboundMessage`, or undefined for what the channel does
 * not handle: another bot's or its own messages, and message types other than text, post, image, file.
 */
export function normalizeMessageEvent(raw: unknown, deps: NormalizeDeps): InboundMessage | undefined {
  const root = record(raw);
  const event = record(root.event ?? root);
  const sender = record(event.sender);
  const senderId = text(record(sender.sender_id).open_id);
  const message = record(event.message);
  const messageId = text(message.message_id);
  const chatId = text(message.chat_id);
  const messageType = text(message.message_type);
  if (!senderId || !messageId || !chatId || !messageType || typeof message.content !== 'string') return undefined;
  if ((sender.sender_type !== undefined && sender.sender_type !== 'user') || senderId === deps.botOpenId) return undefined;

  // The chat's own `chat_type` decides: an id's prefix says nothing reliable about it.
  const chatType: ChannelAddress['chatType'] = message.chat_type === 'p2p' ? 'p2p' : 'group';
  const rootId = text(message.root_id);
  const parentId = text(message.parent_id);
  const threadId = text(message.thread_id);
  // `root_id` is a message id, `thread_id` a topic id: they are two names for one conversation, never substitutes.
  const threadKey = rootId ?? parentId ?? threadId ?? messageId;
  const aliases = [...new Set([rootId, threadId, !rootId && !parentId && threadId ? messageId : undefined].filter((key): key is string => Boolean(key) && key !== threadKey))];

  const mentions: Mention[] = (Array.isArray(message.mentions) ? message.mentions : []).map(record).map(mention => ({
    key: text(mention.key) ?? '', openId: text(record(mention.id).open_id), name: text(mention.name),
  }));
  const mentionOf = (key: string): Mention | undefined => mentions.find(mention => mention.key === key || (mention.openId && mention.openId === key));
  let mentionsBot = mentions.some(mention => mention.openId === deps.botOpenId);

  let content: Loose;
  try { content = record(JSON.parse(message.content)); } catch { return undefined; }

  const attachments: InboundAttachment[] = [];
  const attach = (kind: 'image' | 'file', key: string, name?: string): void => {
    attachments.push({
      kind,
      ...(name ? { name } : {}),
      async download() {
        const { data, mimeType } = await deps.download(messageId, key, kind);
        return { data, mimeType, name: name ?? `${kind}-${key.slice(-8)}${EXTENSIONS[mimeType] ? `.${EXTENSIONS[mimeType]}` : ''}` };
      },
    });
  };

  let body = '';
  if (messageType === 'text') {
    body = text(content.text) ?? '';
    for (const mention of mentions) {
      if (!mention.key) continue;
      body = body.split(mention.key).join(mention.openId === deps.botOpenId ? '' : `@${mention.name ?? ''}`);
    }
  } else if (messageType === 'post') {
    const { title, rows } = postBody(content);
    const lines = rows.map(row => row.map(record).map(element => {
      switch (element.tag) {
        case 'text': return text(element.text) ?? '';
        case 'a': return text(element.text) ?? text(element.href) ?? '';
        case 'md': return text(element.text) ?? '';
        case 'code_block': return `\n\`\`\`${text(element.language) ?? ''}\n${text(element.text) ?? ''}\n\`\`\`\n`;
        case 'at': {
          const mention = mentionOf(text(element.user_id) ?? '');
          if (mention?.openId === deps.botOpenId || text(element.user_id) === deps.botOpenId) { mentionsBot = true; return ''; }
          return `@${text(element.user_name) ?? mention?.name ?? ''}`;
        }
        case 'img': { const key = text(element.image_key); if (key) attach('image', key); return ''; }
        default: return '';
      }
    }).join(''));
    body = [title, ...lines].filter(Boolean).join('\n');
  } else if (messageType === 'image') {
    const key = text(content.image_key);
    if (!key) return undefined;
    attach('image', key);
  } else if (messageType === 'file') {
    const key = text(content.file_key);
    if (!key) return undefined;
    attach('file', key, text(content.file_name));
  } else {
    return undefined;
  }

  const inThread = Boolean(threadId);
  return {
    account: deps.account,
    messageId,
    address: { account: deps.account, chatId, chatType, threadKey, ...(aliases.length ? { aliases } : {}) },
    sender: { id: senderId },
    text: body.replace(/[ \t]+\n/g, '\n').trim(),
    attachments,
    mentionsBot,
    inThread,
    anchor: { messageId, inThread },
  };
}

// ── The connection ──

export interface FeishuSocket { close(): void }

export interface SocketOptions {
  account: ChannelAccount;
  api: FeishuApi;
  botOpenId: string;
  ctx: ChannelContext;
}

const redactUrls = (message: string): string => message.replace(/\bwss?:\/\/\S+/gi, '[url]');
const flatten = (parts: unknown[]): string => redactUrls(parts.map(part => (typeof part === 'string' ? part : part instanceof Error ? part.message : JSON.stringify(part))).join(' ').replace(/\s+/g, ' ').trim());

/** Starts the long connection and resolves once it is really up; rejects when it is not within the timeout. */
export async function openSocket({ account, api, botOpenId, ctx }: SocketOptions): Promise<FeishuSocket> {
  let state: 'connecting' | 'connected' | 'disconnected' | 'error' = 'connecting';
  let reason: string | undefined;
  let lastEventAt: string | undefined;
  let reported = 0;
  let reportTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const report = (): void => {
    if (closed) return;
    reported = Date.now();
    reportTimer = undefined;
    ctx.status({ state, ...(reason ? { error: reason } : {}), ...(lastEventAt ? { lastEventAt } : {}) });
  };
  const setState = (next: typeof state, why?: string): void => {
    if (state === next && reason === why) return;
    state = next;
    reason = why;
    report();
  };
  /** Event times are reported at most every few seconds. */
  const touch = (): void => {
    lastEventAt = new Date().toISOString();
    if (!reportTimer) reportTimer = setTimeout(report, Math.max(STATUS_REPORT_MS - (Date.now() - reported), 0));
  };

  let markReady: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const log = { warn: (...parts: unknown[]) => ctx.log.warn(`feishu sdk: ${flatten(parts)}`), info: (...parts: unknown[]) => ctx.log.info(`feishu sdk: ${flatten(parts)}`) };

  const appId = account.config.appId ?? '';
  const appSecret = account.secrets.appSecret ?? '';
  const client = new Lark.WSClient({
    appId,
    appSecret,
    domain: account.config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
    logger: { error: log.warn, warn: log.warn, info: log.info, debug: () => undefined, trace: () => undefined },
    onReady: () => { setState('connected'); markReady(); },
    onReconnecting: () => setState('disconnected', '正在重连'),
    onReconnected: () => setState('connected'),
    onError: error => setState('error', redactUrls(error.message)),
  });

  const normalizeDeps: NormalizeDeps = { account: account.id, botOpenId, download: (messageId, key, type) => api.downloadResource(messageId, key, type) };
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      touch();
      try {
        const message = normalizeMessageEvent(data, normalizeDeps);
        if (message) ctx.inbound(message);
      } catch (error) {
        ctx.log.warn('feishu message event dropped', { error: String(error) });
      }
    },
    // Awaited and returned: the SDK sends the result back as the callback response.
    'card.action.trigger': async (data: unknown) => {
      touch();
      const action = normalizeCardAction(data, account.id);
      if (!action) return undefined;
      try {
        return toCallbackResponse(await ctx.action(action));
      } catch (error) {
        ctx.log.warn('feishu card action failed', { error: String(error) });
        return { toast: { type: 'error', content: '操作失败' } };
      }
    },
  });

  // The callbacks above can miss a transition; the connection's own status is the fallback.
  const health = setInterval(() => {
    if (closed) return;
    const status = client.getConnectionStatus();
    if (status.state === 'connected') { setState('connected'); markReady(); }
    else if (status.state === 'failed') setState('error', state === 'error' ? reason : '连接失败');
    else if (status.state === 'reconnecting' || status.state === 'connecting') { if (state === 'connected') setState('disconnected', '正在重连'); }
  }, HEALTH_CHECK_MS);
  health.unref();

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(health);
    if (reportTimer) clearTimeout(reportTimer);
    try { client.close({ force: true }); } catch { /* already closed */ }
  };

  try {
    await client.start({ eventDispatcher: dispatcher });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // `start()` resolves before the socket is up, so readiness is awaited separately.
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('连接飞书超时')), READY_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timeout));
  } catch (error) {
    close();
    throw error;
  }
  return { close };
}
