/*
 * Telegram inbound normalization, long-polling loop, callback query router, native stop handling
 * (`stopped_message_generation`), and `ForceReply` interception for `allowOther` interactions.
 */
import * as path from 'node:path';
import type { ChannelContext, InboundAttachment, InboundMessage } from '@riffet/plugin-api';
import {
  describeTelegramError, TelegramApiError,
  type TelegramApi, type TelegramCallbackQuery, type TelegramMessage, type TelegramStoppedGeneration,
  type TelegramUpdate, type TelegramUser,
} from './api.js';
import type { TelegramPanelStore } from './panels.js';
import { editHtmlSafe, renderActionRedraw, type TelegramLinkState } from './surface.js';

const POLL_TIMEOUT_SEC = 25;
const OTHER_PROMPT_TTL_MS = 10 * 60_000;
const ALLOWED_UPDATES = ['message', 'callback_query', 'stopped_message_generation'];
const DISCONNECT_THRESHOLD = 2;

interface PendingOther {
  ref: string;
  action: string;
  selectedIds?: string[];
  promptMessageId: number;
  at: number;
}

export interface NormalizeEnv {
  accountId: string;
  bot: Pick<TelegramUser, 'id' | 'username'>;
  api: Pick<TelegramApi, 'downloadFile'>;
  link: TelegramLinkState;
}

function senderDisplayName(user: TelegramUser): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || String(user.id);
}

function guessMime(filePath: string, explicit?: string): string {
  if (explicit) return explicit;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

function extractAttachments(msg: TelegramMessage, api: Pick<TelegramApi, 'downloadFile'>): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;
    out.push({
      kind: 'image',
      name: `photo_${msg.message_id}.jpg`,
      async download() {
        const res = await api.downloadFile(largest.file_id);
        const name = path.basename(res.filePath) || `photo_${msg.message_id}.jpg`;
        return { data: res.data, mimeType: guessMime(res.filePath, res.contentType || 'image/jpeg'), name };
      },
    });
  }
  if (msg.document) {
    const doc = msg.document;
    const isImage = Boolean(doc.mime_type?.startsWith('image/'));
    out.push({
      kind: isImage ? 'image' : 'file',
      name: doc.file_name,
      async download() {
        const res = await api.downloadFile(doc.file_id);
        const name = doc.file_name || path.basename(res.filePath) || `file_${msg.message_id}`;
        return { data: res.data, mimeType: guessMime(name, doc.mime_type || res.contentType), name };
      },
    });
  }
  for (const media of [msg.voice, msg.audio, msg.video]) {
    if (!media) continue;
    out.push({
      kind: 'file',
      name: media.file_name,
      async download() {
        const res = await api.downloadFile(media.file_id);
        const name = media.file_name || path.basename(res.filePath) || `media_${msg.message_id}`;
        return { data: res.data, mimeType: guessMime(name, media.mime_type || res.contentType), name };
      },
    });
  }
  return out;
}

/**
 * Strips `@botUsername` from mentions and `/cmd@botUsername` commands, returning both the clean
 * text and whether the message explicitly addressed this bot.
 */
export function stripBotMentions(
  rawText: string,
  entities: TelegramMessage['entities'],
  botUsername?: string,
): { text: string; mentionsBot: boolean } {
  if (!rawText) return { text: '', mentionsBot: false };
  const lowerBot = botUsername?.toLowerCase();
  if (!lowerBot || !entities?.length) {
    if (!lowerBot) return { text: rawText.trim(), mentionsBot: false };
    const mentionRe = new RegExp(`(^|\\s)@${escapeRegExp(lowerBot)}\\b`, 'gi');
    const matched = mentionRe.test(rawText);
    return { text: matched ? rawText.replace(mentionRe, '$1').replace(/\s{2,}/g, ' ').trim() : rawText.trim(), mentionsBot: matched };
  }

  // Process spans from right to left so offsets stay valid while slicing.
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  let mentionsBot = false;
  for (const entity of entities) {
    const slice = rawText.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === 'mention' && slice.toLowerCase() === `@${lowerBot}`) {
      mentionsBot = true;
      edits.push({ start: entity.offset, end: entity.offset + entity.length, replacement: '' });
    } else if (entity.type === 'bot_command') {
      const at = slice.indexOf('@');
      if (at > 0) {
        const target = slice.slice(at + 1).toLowerCase();
        if (target === lowerBot) {
          mentionsBot = true;
          edits.push({ start: entity.offset + at, end: entity.offset + entity.length, replacement: '' });
        }
      }
    }
  }
  if (!edits.length) return { text: rawText.trim(), mentionsBot };
  edits.sort((a, b) => b.start - a.start);
  let text = rawText;
  for (const edit of edits) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }
  return { text: text.replace(/[ \t]{2,}/g, ' ').trim(), mentionsBot };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalizes a Telegram `Message` into Riffet's platform-neutral `InboundMessage`. */
export function normalizeMessage(msg: TelegramMessage, env: NormalizeEnv): InboundMessage | undefined {
  if (!msg.from || msg.from.is_bot) return undefined;
  if (msg.chat.type === 'channel') return undefined;

  const rawText = msg.text ?? msg.caption ?? '';
  const entities = msg.text !== undefined ? msg.entities : msg.caption_entities;
  const attachments = extractAttachments(msg, env.api);
  if (!rawText.trim() && !attachments.length) return undefined;

  const chatId = String(msg.chat.id);
  const messageId = String(msg.message_id);
  const chatType: 'p2p' | 'group' = msg.chat.type === 'private' ? 'p2p' : 'group';
  const stripped = stripBotMentions(rawText, entities, env.bot.username);
  // Deep-link `/start bind_<code>` turns into `/bind <code>` so the core pairing flow handles it identically.
  const startBind = chatType === 'p2p' ? /^\/start\s+bind_([A-Za-z0-9-]+)$/.exec(stripped.text) : null;
  const text = startBind ? `/bind ${startBind[1]}` : stripped.text;
  const repliesToBot = msg.reply_to_message?.from?.id === env.bot.id;
  const mentionsBot = chatType === 'p2p' || stripped.mentionsBot || repliesToBot;

  let threadKey: string | undefined;
  let aliases: string[] | undefined;
  let inThread = false;

  if (chatType === 'p2p') {
    if (msg.message_thread_id !== undefined) {
      threadKey = `topic:${msg.message_thread_id}`;
      inThread = true;
    }
  } else if (msg.is_topic_message && msg.message_thread_id !== undefined) {
    threadKey = `topic:${msg.message_thread_id}`;
    inThread = true;
  } else if (msg.reply_to_message) {
    const parentId = String(msg.reply_to_message.message_id);
    const rootId = env.link.resolveReplyRoot(chatId, parentId);
    env.link.recordReplyRoot(chatId, messageId, rootId);
    threadKey = `reply:${rootId}`;
    aliases = Array.from(new Set([`reply:${parentId}`, `reply:${messageId}`].filter(key => key !== threadKey)));
    inThread = true;
  } else {
    env.link.recordReplyRoot(chatId, messageId, messageId);
    threadKey = `reply:${messageId}`;
  }

  env.link.recordInbound(messageId, chatId, msg.message_thread_id);

  return {
    account: env.accountId,
    messageId,
    address: {
      account: env.accountId,
      chatId,
      chatType,
      ...(threadKey ? { threadKey } : {}),
      ...(aliases?.length ? { aliases } : {}),
    },
    sender: { id: String(msg.from.id), name: senderDisplayName(msg.from) },
    text,
    attachments,
    mentionsBot,
    inThread,
    anchor: { messageId, inThread: chatType === 'group' || inThread },
  };
}

export class PendingOtherStore {
  private readonly items = new Map<string, PendingOther>();

  private key(chatId: string, userId: string): string {
    return `${chatId}:${userId}`;
  }

  set(chatId: string, userId: string, entry: PendingOther): void {
    this.prune();
    this.items.set(this.key(chatId, userId), entry);
    if (this.items.size > 200) this.items.delete(this.items.keys().next().value!);
  }

  consume(chatId: string, userId: string, text: string, replyToId?: number): PendingOther | undefined {
    this.prune();
    const k = this.key(chatId, userId);
    const entry = this.items.get(k);
    if (!entry) return undefined;
    // Slash commands cancel or bypass free-text capture unless explicitly replying to the ForceReply prompt.
    if (text.trim().startsWith('/') && replyToId !== entry.promptMessageId) {
      this.items.delete(k);
      return undefined;
    }
    this.items.delete(k);
    return entry;
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.items) {
      if (now - v.at > OTHER_PROMPT_TTL_MS) this.items.delete(k);
    }
  }
}

export async function handleCallbackQuery(deps: {
  query: TelegramCallbackQuery;
  accountId: string;
  api: TelegramApi;
  panels: TelegramPanelStore;
  pendingOther: PendingOtherStore;
  context: ChannelContext;
  link?: TelegramLinkState;
}): Promise<void> {
  const { query, accountId, api, panels, pendingOther, context, link } = deps;
  const payload = panels.resolve(query.data);
  if (!payload) {
    await api.answerCallbackQuery({ callback_query_id: query.id, text: '按钮已过期，请重新打开面板' }).catch(() => {});
    return;
  }

  const chatId = query.message ? String(query.message.chat.id) : undefined;
  const messageId = query.message?.message_id;
  const threadId = query.message?.message_thread_id;

  if (payload.kind === 'page') {
    const view = panels.projectView(payload.ref);
    const rendered = view ? panels.renderProjectPicker(view, payload.page) : undefined;
    if (rendered && chatId && messageId !== undefined) {
      await editHtmlSafe(api, { chatId, messageId, html: rendered.html, replyMarkup: rendered.replyMarkup, link }).catch(() => {});
    }
    await api.answerCallbackQuery({ callback_query_id: query.id }).catch(() => {});
    return;
  }

  if (payload.kind === 'model-tab') {
    const view = panels.modelView(payload.ref);
    const rendered = view ? panels.renderModelPicker(view, { tab: payload.tab, page: payload.page }) : undefined;
    if (rendered && chatId && messageId !== undefined) {
      await editHtmlSafe(api, { chatId, messageId, html: rendered.html, replyMarkup: rendered.replyMarkup, link }).catch(() => {});
    }
    await api.answerCallbackQuery({ callback_query_id: query.id }).catch(() => {});
    return;
  }

  if (payload.kind === 'toggle') {
    panels.toggleOption(payload.ref, payload.optionId);
    const view = panels.interactionView(payload.ref);
    if (view && chatId && messageId !== undefined) {
      const rendered = panels.renderInteraction(view);
      await editHtmlSafe(api, { chatId, messageId, html: rendered.html, replyMarkup: rendered.replyMarkup, link }).catch(() => {});
    }
    await api.answerCallbackQuery({ callback_query_id: query.id }).catch(() => {});
    return;
  }

  if (payload.kind === 'other') {
    if (!chatId) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: '无法发起回复' }).catch(() => {});
      return;
    }
    try {
      const prompt = await api.sendMessage({
        chat_id: chatId,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        text: '<b>输入回复</b>\n<i>直接回复这条消息即可提交</i>',
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: '输入回复内容…' },
        ...(messageId !== undefined ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {}),
      });
      pendingOther.set(chatId, String(query.from.id), {
        ref: payload.ref,
        action: payload.action,
        selectedIds: panels.selectedOf(payload.ref),
        promptMessageId: prompt.message_id,
        at: Date.now(),
      });
      await api.answerCallbackQuery({ callback_query_id: query.id, text: '请输入回复' }).catch(() => {});
    } catch {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: '发起回复失败，请重试' }).catch(() => {});
    }
    return;
  }

  const selectedIds = payload.kind === 'submit-multi'
    ? panels.selectedOf(payload.ref)
    : payload.selectedIds;

  if (payload.kind === 'submit-multi' && (!selectedIds || !selectedIds.length)) {
    await api.answerCallbackQuery({ callback_query_id: query.id, text: '请先选择至少一项' }).catch(() => {});
    return;
  }

  let reply: Awaited<ReturnType<ChannelContext['action']>>;
  try {
    reply = await context.action({
      account: accountId,
      eventId: query.id,
      operator: { id: String(query.from.id) },
      ref: payload.ref,
      action: payload.action,
      ...(selectedIds ? { selectedIds } : {}),
    });
  } catch (error) {
    context.log.warn('telegram callback action failed', { error: String(error) });
    await api.answerCallbackQuery({ callback_query_id: query.id, text: '操作失败，请重试' }).catch(() => {});
    return;
  }

  if (payload.kind === 'submit-multi') panels.clearSelection(payload.ref);

  await api.answerCallbackQuery({
    callback_query_id: query.id,
    ...(reply.toast?.text ? { text: reply.toast.text.slice(0, 180) } : {}),
  }).catch(() => {});

  if (reply.redraw && chatId && messageId !== undefined) {
    const rendered = renderActionRedraw(panels, reply.redraw);
    await editHtmlSafe(api, { chatId, messageId, html: rendered.html, replyMarkup: rendered.replyMarkup, link }).catch(() => {});
  }
}

export async function handleStoppedGeneration(deps: {
  stopped: TelegramStoppedGeneration;
  updateId: number;
  accountId: string;
  link: TelegramLinkState;
  context: ChannelContext;
}): Promise<void> {
  const { stopped, updateId, accountId, link, context } = deps;
  if (stopped.draft_id === undefined) return;
  const active = link.lookupDraftStop(stopped.draft_id);
  if (!active) return;
  link.clearDraftStop(stopped.draft_id);
  const operatorId = stopped.from ? String(stopped.from.id) : active.chatId;
  await context.action({
    account: accountId,
    eventId: `stop:${updateId}`,
    operator: { id: operatorId },
    ref: active.stopRef,
    action: 'stop',
  }).catch(error => {
    context.log.warn('telegram stop action failed', { error: String(error) });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function startPollingLoop(deps: {
  accountId: string;
  bot: TelegramUser;
  api: TelegramApi;
  panels: TelegramPanelStore;
  link: TelegramLinkState;
  context: ChannelContext;
  signal: AbortSignal;
  hasProxy?: boolean;
}): Promise<void> {
  const { accountId, bot, api, panels, link, context, signal, hasProxy } = deps;
  const pendingOther = new PendingOtherStore();
  let offset: number | undefined;
  let backoffMs = 1_000;
  let connected = true;
  let consecutiveFailures = 0;

  const dispatchUpdate = async (update: TelegramUpdate) => {
    if (update.callback_query) {
      await handleCallbackQuery({ query: update.callback_query, accountId, api, panels, pendingOther, context, link });
      return;
    }
    if (update.stopped_message_generation) {
      await handleStoppedGeneration({
        stopped: update.stopped_message_generation,
        updateId: update.update_id,
        accountId,
        link,
        context,
      });
      return;
    }
    if (!update.message) return;
    const msg = update.message;
    if (msg.from && !msg.from.is_bot && msg.text?.trim()) {
      const pending = pendingOther.consume(String(msg.chat.id), String(msg.from.id), msg.text, msg.reply_to_message?.message_id);
      if (pending) {
        const reply = await context.action({
          account: accountId,
          eventId: `other:${msg.message_id}`,
          operator: { id: String(msg.from.id) },
          ref: pending.ref,
          action: pending.action,
          ...(pending.selectedIds?.length ? { selectedIds: pending.selectedIds } : {}),
          otherText: msg.text.trim(),
        });
        await api.deleteMessage(msg.chat.id, pending.promptMessageId).catch(() => {});
        if (reply.toast?.text) {
          await api.sendMessage({
            chat_id: msg.chat.id,
            ...(msg.message_thread_id !== undefined ? { message_thread_id: msg.message_thread_id } : {}),
            text: reply.toast.text,
          }).catch(() => {});
        }
        return;
      }
    }
    const inbound = normalizeMessage(msg, { accountId, bot, api, link });
    if (inbound) context.inbound(inbound);
  };

  return (async () => {
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates({
          ...(offset !== undefined ? { offset } : {}),
          timeout: POLL_TIMEOUT_SEC,
          allowed_updates: ALLOWED_UPDATES,
        }, signal);
        consecutiveFailures = 0;
        if (!connected) {
          connected = true;
          context.status({ state: 'connected' });
        }
        backoffMs = 1_000;
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await dispatchUpdate(update);
          } catch (error) {
            context.log.warn('telegram update handler failed', { updateId: update.update_id, error: String(error) });
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof TelegramApiError && error.isUnauthorized()) {
          connected = false;
          context.status({ state: 'error', error: describeTelegramError(error, { hasProxy }) });
          return;
        }
        if (error instanceof TelegramApiError && error.isConflict()) {
          connected = false;
          context.status({ state: 'error', error: describeTelegramError(error, { hasProxy }) });
          await sleep(Math.min(30_000, Math.max(5_000, backoffMs)), signal);
          backoffMs = Math.min(30_000, backoffMs * 2);
          continue;
        }
        if (error instanceof TelegramApiError && error.isRateLimit()) {
          await sleep(Math.max(1_000, (error.retryAfterSec ?? 5) * 1000), signal);
          continue;
        }
        consecutiveFailures += 1;
        // Single long-poll timeout or proxy hiccup retries quietly before flashing disconnected.
        if (connected && consecutiveFailures >= DISCONNECT_THRESHOLD) {
          connected = false;
          context.status({ state: 'disconnected', error: describeTelegramError(error, { hasProxy }) });
        }
        await sleep(backoffMs, signal);
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  })();
}
