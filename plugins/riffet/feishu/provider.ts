/*
 * The Feishu / Lark provider: a long connection in, cards and a native process message out.
 * Platform details stay in this directory; the channel core only sees `ImChannelProvider` (`contributes.imChannels`).
 */
import type {
  ChannelAccount, ChannelAddress, ChannelConnection, ChannelContext, ImChannelProvider, InteractionView, ProjectPickerView, ReplyAnchor, SentRef,
} from '@riffet/plugin-api';
import { interactionCard, noticeCard, panelCard, projectPickerCard } from './cards.js';
import { openSocket } from './connection.js';
import { onboarding } from './onboarding.js';
import { createFeishuApi, FeishuApiError, type FeishuApi } from './openapi.js';
import { closeOrphanedSurface, deliverCard, openTurnSurface, replyTarget, resumeTurnSurface, type SurfaceDeps } from './surface.js';

const REACTION_RECEIVED = 'Typing';
const REACTION_DONE = 'DONE';
/** Tried in order; the first the platform accepts is used. */
const REACTION_FAILED = ['CrossMark', 'ERROR'];
const REACTION_MEMORY = 500;

/** The reactions this process put on user messages, so the next state can replace them. */
function createReactions(api: FeishuApi) {
  const placed = new Map<string, string>();
  const remember = (messageId: string, reactionId: string): void => {
    placed.delete(messageId);
    if (reactionId) placed.set(messageId, reactionId);
    if (placed.size > REACTION_MEMORY) placed.delete(placed.keys().next().value!);
  };

  async function clear(messageId: string): Promise<void> {
    const known = placed.get(messageId);
    if (known) {
      placed.delete(messageId);
      await api.removeReaction(messageId, known);
      return;
    }
    // After a restart the id is gone: look the app's own received marker up instead.
    const data = await api.call('GET', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, { query: { reaction_type: REACTION_RECEIVED, page_size: '20' }, label: 'list-reactions' });
    for (const item of Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : []) {
      const operator = item.operator as { operator_type?: string } | undefined;
      if (operator?.operator_type === 'app' && typeof item.reaction_id === 'string') await api.removeReaction(messageId, item.reaction_id);
    }
  }

  async function add(messageId: string, emoji: string[]): Promise<void> {
    for (const type of emoji) {
      try {
        remember(messageId, await api.addReaction(messageId, type));
        return;
      } catch (error) {
        if (!(error instanceof FeishuApiError) || error.isRateLimit()) throw error;
      }
    }
  }

  return {
    async set(messageId: string, state: 'received' | 'done' | 'failed'): Promise<void> {
      if (state !== 'received') await clear(messageId).catch(() => undefined);
      await add(messageId, state === 'received' ? [REACTION_RECEIVED] : state === 'done' ? [REACTION_DONE] : REACTION_FAILED);
    },
  };
}

async function connect(account: ChannelAccount, ctx: ChannelContext): Promise<ChannelConnection> {
  ctx.status({ state: 'connecting' });
  const api = createFeishuApi({ appId: account.appId, appSecret: account.appSecret, domain: account.domain });
  const fail = (error: unknown): never => {
    ctx.status({ state: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  };

  // The bot's own open_id is what tells a mention of the bot from any other.
  const bot = await api.botInfo().catch(fail);
  const socket = await openSocket({ account, api, botOpenId: bot.openId, ctx }).catch(fail);
  ctx.log.info('feishu connected', { bot: bot.name });

  const surfaces: SurfaceDeps = { api, log: ctx.log };
  const reactions = createReactions(api);
  let closed = false;

  const send = async (address: ChannelAddress, card: Record<string, unknown>, anchor?: ReplyAnchor): Promise<SentRef> => ({
    messageId: await deliverCard(api, address.chatId, replyTarget(address, anchor), card),
  });

  const connection: ChannelConnection = {
    botName: bot.name,
    ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}),
    openTurn: (address, view, anchor) => openTurnSurface(surfaces, address, view, anchor),
    async resumeTurn(address, state) {
      const surface = await resumeTurnSurface(surfaces, address, state);
      if (!surface) await closeOrphanedSurface(surfaces, state);
      return surface;
    },
    showInteraction: (address, view: InteractionView, anchor) => send(address, interactionCard(view), anchor),
    async updateInteraction(sent, view) {
      try { await api.patchCard(sent.messageId, interactionCard(view)); } catch (error) { ctx.log.warn('feishu interaction update failed', { error: String(error) }); }
    },
    showProjectPicker: (address, view: ProjectPickerView, anchor) => send(address, projectPickerCard(view), anchor),
    showPanel: (address, view, anchor) => send(address, panelCard(view), anchor),
    async updatePanel(sent, view) {
      try { await api.patchCard(sent.messageId, panelCard(view)); } catch (error) { ctx.log.warn('feishu panel update failed', { error: String(error) }); }
    },
    send: (address, markdown, anchor) => send(address, noticeCard(markdown), anchor),
    async acknowledge(anchor, state) {
      try { await reactions.set(anchor.messageId, state); } catch { /* a missing reaction is not worth a failure */ }
    },
    async close() {
      if (closed) return;
      closed = true;
      socket.close();
    },
  };
  ctx.signal.addEventListener('abort', () => void connection.close(), { once: true });
  if (ctx.signal.aborted) await connection.close();
  return connection;
}

export const feishuProvider: ImChannelProvider = {
  capabilities: { edit: true, actions: 'forms', threads: true },
  connect,
  ...onboarding,
};
