/*
 * Outbound rendering and dual-mode streaming for Telegram:
 *
 * - Private chats prefer Bot API 9.5+ `sendMessageDraft` (native "Thinking…" + stop button), falling
 *   back transparently to `sendMessage` + `editMessageText` if the API endpoint rejects drafts.
 * - Group chats use `sendMessage` + throttled `editMessageText` with an inline Stop button.
 * - Every outgoing send/edit falls back from HTML to plain text on Telegram entity parse errors.
 */
import type {
  ChannelAddress, ChannelContext, InteractionView, PanelView, ProjectPickerView, ReplyAnchor,
  SentRef, SurfaceState, TurnSurface, TurnView,
} from '@riffet/plugin-api';
import { TELEGRAM_CHANNEL } from './constants.js';
import { TelegramApiError, type InlineKeyboardMarkup, type TelegramApi, type TelegramMessage } from './api.js';
import {
  htmlToPlainText, renderNoticePages, renderTurnFinalPages, renderTurnStreamHtml,
} from './format.js';
import type { TelegramPanelStore } from './panels.js';

const DRAFT_THROTTLE_MS = 600;
const EDIT_THROTTLE_MS = 950;
const MAX_TRACKED_MSGS = 2000;

export interface ActiveDraftStop {
  chatId: string;
  stopRef: string;
}

/** Shared per-connection outbound state so polling and surfaces coordinate reply chains & stop refs. */
export class TelegramLinkState {
  private readonly replyRoots = new Map<string, string>();
  private readonly inboundMeta = new Map<string, { chatId: string; threadId?: number }>();
  private readonly draftStops = new Map<number, ActiveDraftStop>();
  private nextDraftId = Math.floor(Date.now() % 1_000_000) + 1;
  draftSupported = true;
  buttonStyleSupported = true;

  private boundSet<K, V>(map: Map<K, V>, key: K, value: V, cap = MAX_TRACKED_MSGS): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > cap) map.delete(map.keys().next().value!);
  }

  recordInbound(messageId: string, chatId: string, threadId?: number): void {
    this.boundSet(this.inboundMeta, messageId, { chatId, threadId }, 500);
  }

  lookupInbound(messageId: string): { chatId: string; threadId?: number } | undefined {
    return this.inboundMeta.get(messageId);
  }

  recordReplyRoot(chatId: string, messageId: string, rootId: string): void {
    this.boundSet(this.replyRoots, `${chatId}:${messageId}`, rootId);
  }

  resolveReplyRoot(chatId: string, messageId: string): string {
    return this.replyRoots.get(`${chatId}:${messageId}`) ?? messageId;
  }

  allocateDraftId(): number {
    this.nextDraftId = (this.nextDraftId % 2_000_000_000) + 1;
    return this.nextDraftId;
  }

  setDraftStop(draftId: number, stop: ActiveDraftStop): void {
    this.boundSet(this.draftStops, draftId, stop, 200);
  }

  clearDraftStop(draftId: number): void {
    this.draftStops.delete(draftId);
  }

  lookupDraftStop(draftId: number): ActiveDraftStop | undefined {
    return this.draftStops.get(draftId);
  }
}

export function extractTopicThreadId(threadKey?: string): number | undefined {
  if (!threadKey?.startsWith('topic:')) return undefined;
  const parsed = Number(threadKey.slice('topic:'.length));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractReplyRootId(threadKey?: string): string | undefined {
  return threadKey?.startsWith('reply:') ? threadKey.slice('reply:'.length) : undefined;
}

function numericMessageId(id?: string): number | undefined {
  if (!id) return undefined;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function stripButtonStyles(markup?: InlineKeyboardMarkup): InlineKeyboardMarkup | undefined {
  if (!markup) return undefined;
  return {
    inline_keyboard: markup.inline_keyboard.map(row =>
      row.map(({ style: _ignored, ...rest }) => rest),
    ),
  };
}

function hasButtonStyles(markup?: InlineKeyboardMarkup): boolean {
  return Boolean(markup?.inline_keyboard.some(row => row.some(btn => btn.style !== undefined)));
}

export async function sendHtmlSafe(
  api: TelegramApi,
  params: {
    chatId: string;
    threadId?: number;
    replyToMessageId?: number;
    html: string;
    replyMarkup?: InlineKeyboardMarkup;
    link?: TelegramLinkState;
  },
): Promise<TelegramMessage> {
  const effectiveMarkup = params.link && !params.link.buttonStyleSupported
    ? stripButtonStyles(params.replyMarkup)
    : params.replyMarkup;
  const build = (markup?: InlineKeyboardMarkup) => ({
    chat_id: params.chatId,
    ...(params.threadId !== undefined ? { message_thread_id: params.threadId } : {}),
    ...(params.replyToMessageId !== undefined
      ? { reply_parameters: { message_id: params.replyToMessageId, allow_sending_without_reply: true } }
      : {}),
    ...(markup ? { reply_markup: markup } : {}),
    link_preview_options: { is_disabled: true },
  });
  const send = async (markup?: InlineKeyboardMarkup) => {
    const base = build(markup);
    try {
      return await api.sendMessage({ ...base, text: params.html, parse_mode: 'HTML' });
    } catch (error) {
      if (error instanceof TelegramApiError && error.isParseError()) {
        return await api.sendMessage({ ...base, text: htmlToPlainText(params.html) });
      }
      throw error;
    }
  };
  try {
    return await send(effectiveMarkup);
  } catch (error) {
    if (error instanceof TelegramApiError && error.code === 400 && hasButtonStyles(effectiveMarkup)) {
      if (params.link) params.link.buttonStyleSupported = false;
      return await send(stripButtonStyles(effectiveMarkup));
    }
    throw error;
  }
}

export async function editHtmlSafe(
  api: TelegramApi,
  params: {
    chatId: string;
    messageId: number;
    html: string;
    replyMarkup?: InlineKeyboardMarkup;
    link?: TelegramLinkState;
  },
): Promise<void> {
  const effectiveMarkup = params.link && !params.link.buttonStyleSupported
    ? stripButtonStyles(params.replyMarkup)
    : params.replyMarkup;
  const edit = async (markup?: InlineKeyboardMarkup) => {
    const base = {
      chat_id: params.chatId,
      message_id: params.messageId,
      reply_markup: markup ?? { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    };
    try {
      await api.editMessageText({ ...base, text: params.html, parse_mode: 'HTML' });
    } catch (error) {
      if (error instanceof TelegramApiError && error.isNotModified()) return;
      if (error instanceof TelegramApiError && error.isParseError()) {
        try {
          await api.editMessageText({ ...base, text: htmlToPlainText(params.html) });
        } catch (fallbackError) {
          if (fallbackError instanceof TelegramApiError && fallbackError.isNotModified()) return;
          throw fallbackError;
        }
        return;
      }
      throw error;
    }
  };
  try {
    await edit(effectiveMarkup);
  } catch (error) {
    if (error instanceof TelegramApiError && error.code === 400 && hasButtonStyles(effectiveMarkup)) {
      if (params.link) params.link.buttonStyleSupported = false;
      await edit(stripButtonStyles(effectiveMarkup));
      return;
    }
    throw error;
  }
}

function replyTargetFor(address: ChannelAddress, anchor?: ReplyAnchor): { threadId?: number; replyTo?: number } {
  const threadId = extractTopicThreadId(address.threadKey);
  if (threadId !== undefined) return { threadId };
  if (address.chatType === 'group') {
    const anchorNum = numericMessageId(anchor?.messageId);
    if (anchorNum !== undefined) return { replyTo: anchorNum };
    const rootNum = numericMessageId(extractReplyRootId(address.threadKey));
    if (rootNum !== undefined) return { replyTo: rootNum };
  }
  return {};
}

function trackSentChain(link: TelegramLinkState, address: ChannelAddress, sent: TelegramMessage, replyTo?: number): void {
  if (address.chatType !== 'group' || extractTopicThreadId(address.threadKey) !== undefined) return;
  const root = extractReplyRootId(address.threadKey) ?? (replyTo ? link.resolveReplyRoot(address.chatId, String(replyTo)) : String(sent.message_id));
  link.recordReplyRoot(address.chatId, String(sent.message_id), root);
}

export function createTurnSurface(deps: {
  api: TelegramApi;
  panels: TelegramPanelStore;
  link: TelegramLinkState;
  context: ChannelContext;
  address: ChannelAddress;
  anchor?: ReplyAnchor;
  initialView?: TurnView;
  resumed?: { messageId?: number; mode?: 'draft' | 'edit' };
}): TurnSurface {
  const { api, panels, link, context, address, anchor } = deps;
  const target = replyTargetFor(address, anchor);
  let mode: 'draft' | 'edit' = deps.resumed?.mode
    ?? (address.chatType === 'p2p' && link.draftSupported ? 'draft' : 'edit');
  let draftId: number | undefined = mode === 'draft' ? link.allocateDraftId() : undefined;
  let messageId: number | undefined = deps.resumed?.messageId;
  let stopToken: string | undefined;
  let stopRefBound: string | undefined;
  let lastHtml = '';
  let latestView: TurnView | undefined = deps.initialView;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let nextAllowedAt = 0;
  let closed = false;

  const stopMarkup = (view: TurnView): InlineKeyboardMarkup | undefined => {
    if (!view.stopRef || !view.card.stopButton) return undefined;
    if (view.status !== 'queued' && view.status !== 'running' && view.status !== 'waiting') return undefined;
    if (stopRefBound !== view.stopRef) {
      stopRefBound = view.stopRef;
      stopToken = panels.register({ kind: 'core', ref: view.stopRef, action: 'stop' });
    }
    return { inline_keyboard: [[{ text: '中断', callback_data: stopToken, style: 'danger' }]] };
  };

  const handleRateLimit = (error: unknown) => {
    if (error instanceof TelegramApiError && error.isRateLimit()) {
      const waitMs = Math.max(1000, (error.retryAfterSec ?? 3) * 1000);
      nextAllowedAt = Math.max(nextAllowedAt, Date.now() + waitMs);
    }
  };

  const flushStream = async () => {
    if (closed || !latestView) return;
    const view = latestView;
    const isThinkingOnly = !view.answer.trim() && !view.steps.length && (view.status === 'queued' || view.status === 'running');
    const html = isThinkingOnly && mode === 'draft' ? '' : renderTurnStreamHtml(view);
    if (html === lastHtml && (messageId !== undefined || mode === 'draft')) return;

    if (mode === 'draft' && draftId !== undefined) {
      if (view.stopRef && view.card.stopButton) {
        link.setDraftStop(draftId, { chatId: address.chatId, stopRef: view.stopRef });
      }
      try {
        await api.sendMessageDraft({
          chat_id: address.chatId,
          ...(target.threadId !== undefined ? { message_thread_id: target.threadId } : {}),
          draft_id: draftId,
          text: html,
          ...(html ? { parse_mode: 'HTML' as const } : {}),
          ...(view.stopRef && view.card.stopButton ? { can_stop: true, keep_on_stop: false } : {}),
        });
        lastHtml = html;
        nextAllowedAt = Date.now() + DRAFT_THROTTLE_MS;
        return;
      } catch (error) {
        if (error instanceof TelegramApiError && error.isParseError()) {
          try {
            await api.sendMessageDraft({
              chat_id: address.chatId,
              ...(target.threadId !== undefined ? { message_thread_id: target.threadId } : {}),
              draft_id: draftId,
              text: htmlToPlainText(html),
              ...(view.stopRef && view.card.stopButton ? { can_stop: true, keep_on_stop: false } : {}),
            });
            lastHtml = html;
            nextAllowedAt = Date.now() + DRAFT_THROTTLE_MS;
            return;
          } catch { /* fall through to downgrade */ }
        }
        if (error instanceof TelegramApiError && error.isRateLimit()) {
          handleRateLimit(error);
          scheduleFlush();
          return;
        }
        // Bot API server does not support sendMessageDraft: downgrade cleanly to editMessageText.
        if (error instanceof TelegramApiError && error.isUnsupportedMethod()) {
          link.draftSupported = false;
          link.clearDraftStop(draftId);
          draftId = undefined;
          mode = 'edit';
        } else {
          context.log.warn('telegram sendMessageDraft failed', { error: String(error) });
          return;
        }
      }
    }

    const editHtml = html || renderTurnStreamHtml(view);
    const markup = stopMarkup(view);
    try {
      if (messageId === undefined) {
        const sent = await sendHtmlSafe(api, {
          chatId: address.chatId,
          threadId: target.threadId,
          replyToMessageId: target.replyTo,
          html: editHtml,
          replyMarkup: markup,
          link,
        });
        messageId = sent.message_id;
        trackSentChain(link, address, sent, target.replyTo);
      } else {
        await editHtmlSafe(api, {
          chatId: address.chatId,
          messageId,
          html: editHtml,
          replyMarkup: markup,
          link,
        });
      }
      lastHtml = editHtml;
      nextAllowedAt = Date.now() + EDIT_THROTTLE_MS;
    } catch (error) {
      handleRateLimit(error);
      if (!(error instanceof TelegramApiError && error.isRateLimit())) {
        context.log.warn('telegram stream edit failed', { error: String(error) });
      } else {
        scheduleFlush();
      }
    }
  };

  const scheduleFlush = () => {
    if (closed || timer) return;
    const delay = Math.max(0, nextAllowedAt - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = inFlight.then(flushStream).catch(() => {});
    }, delay);
  };

  if (deps.initialView) scheduleFlush();

  return {
    update(view) {
      if (closed) return;
      latestView = view;
      scheduleFlush();
    },
    async finish(view) {
      closed = true;
      latestView = view;
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (draftId !== undefined) {
        link.clearDraftStop(draftId);
      }
      await inFlight;
      const pages = renderTurnFinalPages(view);
      const safePages = pages.length ? pages : ['<i>已完成</i>'];

      let startIndex = 0;
      if (messageId !== undefined) {
        try {
          await editHtmlSafe(api, { chatId: address.chatId, messageId, html: safePages[0]!, link });
          startIndex = 1;
        } catch (error) {
          context.log.warn('telegram final edit failed, sending new message', { error: String(error) });
        }
      }

      for (let i = startIndex; i < safePages.length; i++) {
        const sent = await sendHtmlSafe(api, {
          chatId: address.chatId,
          threadId: target.threadId,
          replyToMessageId: i === 0 ? target.replyTo : undefined,
          html: safePages[i]!,
          link,
        });
        if (i === 0) messageId = sent.message_id;
        trackSentChain(link, address, sent, target.replyTo);
      }
    },
    state(): SurfaceState {
      return {
        kind: TELEGRAM_CHANNEL,
        data: {
          chatId: address.chatId,
          ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
          ...(messageId !== undefined ? { messageId } : {}),
          mode,
        },
      };
    },
  };
}

export async function sendPanelMessage(deps: {
  api: TelegramApi;
  link: TelegramLinkState;
  address: ChannelAddress;
  anchor?: ReplyAnchor;
  html: string;
  replyMarkup?: InlineKeyboardMarkup;
}): Promise<SentRef> {
  const target = replyTargetFor(deps.address, deps.anchor);
  const sent = await sendHtmlSafe(deps.api, {
    chatId: deps.address.chatId,
    threadId: target.threadId,
    replyToMessageId: target.replyTo,
    html: deps.html,
    replyMarkup: deps.replyMarkup,
    link: deps.link,
  });
  trackSentChain(deps.link, deps.address, sent, target.replyTo);
  return { messageId: String(sent.message_id), extra: { chatId: deps.address.chatId } };
}

export async function updatePanelMessage(
  api: TelegramApi,
  sent: SentRef,
  html: string,
  replyMarkup?: InlineKeyboardMarkup,
  link?: TelegramLinkState,
): Promise<void> {
  const chatId = sent.extra?.chatId;
  const messageId = numericMessageId(sent.messageId);
  if (!chatId || messageId === undefined) return;
  await editHtmlSafe(api, { chatId, messageId, html, replyMarkup, link });
}

export async function sendMarkdownNotice(deps: {
  api: TelegramApi;
  link: TelegramLinkState;
  address: ChannelAddress;
  anchor?: ReplyAnchor;
  markdown: string;
}): Promise<SentRef> {
  const target = replyTargetFor(deps.address, deps.anchor);
  const safePages = renderNoticePages(deps.markdown);
  let first: TelegramMessage | undefined;
  for (let i = 0; i < safePages.length; i++) {
    const sent = await sendHtmlSafe(deps.api, {
      chatId: deps.address.chatId,
      threadId: target.threadId,
      replyToMessageId: i === 0 ? target.replyTo : undefined,
      html: safePages[i]!,
      link: deps.link,
    });
    if (!first) first = sent;
    trackSentChain(deps.link, deps.address, sent, target.replyTo);
  }
  return { messageId: String(first!.message_id), extra: { chatId: deps.address.chatId } };
}

export function renderActionRedraw(
  panels: TelegramPanelStore,
  redraw: InteractionView | ProjectPickerView | PanelView,
): { html: string; replyMarkup?: InlineKeyboardMarkup } {
  if (redraw.kind === 'interaction') return panels.renderInteraction(redraw);
  if (redraw.kind === 'project-picker') return panels.renderProjectPicker(redraw);
  return panels.renderPanel(redraw);
}
