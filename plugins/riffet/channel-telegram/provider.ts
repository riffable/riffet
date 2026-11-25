/*
 * Telegram IM channel provider (`ImChannelProvider`).
 *
 * Manual setup only requires a Bot Token from @BotFather (optional proxy / custom API base).
 * Connects via long polling, registers Telegram's native `/` command menu, and supports streaming
 * drafts (Bot API 9.5+) with transparent fallback to edited messages.
 */
import type {
  ChannelAccount, ChannelConnection, ChannelContext, ChannelProviderMeta, ImChannelProvider,
  ProviderHealth, ReplyAnchor, SurfaceState, TurnSurface,
} from '@riffet/plugin-api';
import {
  createTelegramApi, DEFAULT_API_BASE, describeTelegramError, TelegramApiError, type TelegramUser,
} from './api.js';
import { TELEGRAM_CHANNEL } from './constants.js';
import { TelegramPanelStore } from './panels.js';
import { startPollingLoop } from './polling.js';
import {
  createTurnSurface, sendMarkdownNotice, sendPanelMessage, TelegramLinkState, updatePanelMessage,
} from './surface.js';

export { TELEGRAM_CHANNEL };

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'new', description: '开始新会话' },
  { command: 'stop', description: '中断当前回复' },
  { command: 'status', description: '查看当前会话状态' },
  { command: 'model', description: '切换模型或参数' },
  { command: 'project', description: '切换默认项目' },
  { command: 'help', description: '查看全部命令' },
];

const PROVIDER_META: ChannelProviderMeta = {
  fields: [
    {
      key: 'botToken',
      label: { 'zh-Hans': 'Bot Token', en: 'Bot Token' },
      kind: 'secret',
      required: true,
      mono: true,
      placeholder: { 'zh-Hans': '123456:ABC-DEF…', en: '123456:ABC-DEF…' },
    },
    {
      key: 'proxy',
      label: { 'zh-Hans': '代理地址', en: 'Proxy URL' },
      kind: 'text',
      advanced: true,
      mono: true,
      placeholder: { 'zh-Hans': 'http://127.0.0.1:7890', en: 'http://127.0.0.1:7890' },
    },
    {
      key: 'apiBase',
      label: { 'zh-Hans': 'API 基址', en: 'API Base URL' },
      kind: 'text',
      advanced: true,
      mono: true,
      placeholder: { 'zh-Hans': DEFAULT_API_BASE, en: DEFAULT_API_BASE },
    },
  ],
  card: {
    header: true,
    process: true,
    stopButton: true,
    footer: true,
  },
  hints: {
    summary: { 'zh-Hans': '使用 @BotFather 的 Bot Token', en: 'Connect with a Bot Token from @BotFather' },
    credentialSource: { 'zh-Hans': '向 @BotFather 发送 /newbot 获取 Token', en: 'Send /newbot to @BotFather to get a Bot Token' },
    credentialUrl: 'https://t.me/BotFather',
    credentialLinkLabel: { 'zh-Hans': '打开 @BotFather', en: 'Open @BotFather' },
    deleteNote: {
      'zh-Hans': '只移除 Riffet 里的连接，Telegram 里的机器人不会被删除。',
      en: 'Only removes the connection in Riffet; the bot in Telegram is unchanged.',
    },
  },
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function apiForAccount(account: ChannelAccount) {
  const token = account.secrets.botToken?.trim() ?? '';
  return createTelegramApi({
    token,
    apiBase: account.config.apiBase,
    proxy: account.config.proxy,
  });
}

export function createTelegramProvider(): ImChannelProvider {
  return {
    capabilities: { edit: true, actions: 'buttons', threads: true },
    meta: PROVIDER_META,

    links() {
      return { console: 'https://t.me/BotFather' };
    },

    identity(_account, connection) {
      return connection?.identity;
    },

    async health(account: ChannelAccount): Promise<ProviderHealth> {
      const token = account.secrets.botToken?.trim();
      if (!token) return { activated: false };
      try {
        const api = apiForAccount(account);
        const me = await api.getMe();
        return { activated: true, botName: me.first_name || me.username };
      } catch (error) {
        if (error instanceof TelegramApiError && error.isUnauthorized()) return { activated: false };
        return {};
      }
    },

    async connect(account: ChannelAccount, context: ChannelContext): Promise<ChannelConnection> {
      const token = account.secrets.botToken?.trim();
      if (!token) throw new Error('缺少 Telegram Bot Token');
      const api = apiForAccount(account);
      const panels = new TelegramPanelStore();
      const link = new TelegramLinkState();
      const hasProxy = Boolean(account.config.proxy?.trim());

      const stopController = new AbortController();
      const onOuterAbort = () => stopController.abort();
      context.signal.addEventListener('abort', onOuterAbort, { once: true });

      let me: TelegramUser | undefined;
      context.status({ state: 'connecting' });
      try {
        me = await api.getMe(stopController.signal);
      } catch (error) {
        // Invalid token is permanent; transient network errors keep retrying in the background.
        if (error instanceof TelegramApiError && error.isUnauthorized()) {
          context.signal.removeEventListener('abort', onOuterAbort);
          throw new Error(describeTelegramError(error, { hasProxy }));
        }
        if (stopController.signal.aborted) {
          context.signal.removeEventListener('abort', onOuterAbort);
          throw error;
        }
        context.status({ state: 'disconnected', error: describeTelegramError(error, { hasProxy }) });
      }

      const bootstrapAndPoll = async () => {
        let backoffMs = 2_000;
        while (!me && !stopController.signal.aborted) {
          await sleep(backoffMs, stopController.signal);
          if (stopController.signal.aborted) return;
          try {
            me = await api.getMe(stopController.signal);
          } catch (error) {
            if (stopController.signal.aborted) return;
            if (error instanceof TelegramApiError && error.isUnauthorized()) {
              context.status({ state: 'error', error: describeTelegramError(error, { hasProxy }) });
              return;
            }
            context.status({ state: 'disconnected', error: describeTelegramError(error, { hasProxy }) });
            backoffMs = Math.min(30_000, backoffMs * 2);
          }
        }
        if (!me || stopController.signal.aborted) return;

        // Long polling cannot run while a webhook is active.
        await api.deleteWebhook(false).catch(error => {
          context.log.warn('telegram deleteWebhook failed', { error: String(error) });
        });
        await api.setMyCommands(BOT_COMMANDS).catch(error => {
          context.log.warn('telegram setMyCommands failed', { error: String(error) });
        });
        if (stopController.signal.aborted) return;

        context.status({ state: 'connected' });
        await startPollingLoop({
          accountId: account.id,
          bot: me,
          api,
          panels,
          link,
          context,
          signal: stopController.signal,
          hasProxy,
        });
      };

      const loopDone = bootstrapAndPoll();

      const connection: ChannelConnection = {
        get botName() { return me ? (me.first_name || (me.username ? `@${me.username}` : undefined)) : undefined; },
        get identity() { return me?.username ? { label: { 'zh-Hans': '用户名', en: 'Username' }, value: `@${me.username}` } : undefined; },
        get links() {
          return me?.username
            ? { open: `https://t.me/${me.username}`, console: 'https://t.me/BotFather' }
            : { console: 'https://t.me/BotFather' };
        },

        async openTurn(address, view, anchor) {
          return createTurnSurface({ api, panels, link, context, address, anchor, initialView: view });
        },

        async resumeTurn(address, state: SurfaceState): Promise<TurnSurface | undefined> {
          if (state.kind !== TELEGRAM_CHANNEL) return undefined;
          const messageId = typeof state.data.messageId === 'number' ? state.data.messageId : undefined;
          const mode = state.data.mode === 'draft' || state.data.mode === 'edit' ? state.data.mode : 'edit';
          return createTurnSurface({
            api,
            panels,
            link,
            context,
            address,
            resumed: { messageId, mode: messageId !== undefined ? 'edit' : mode },
          });
        },

        async showInteraction(address, view, anchor) {
          const rendered = panels.renderInteraction(view);
          return sendPanelMessage({ api, link, address, anchor, html: rendered.html, replyMarkup: rendered.replyMarkup });
        },

        async updateInteraction(sent, view) {
          const rendered = panels.renderInteraction(view);
          await updatePanelMessage(api, sent, rendered.html, rendered.replyMarkup, link);
        },

        async showProjectPicker(address, view, anchor) {
          const rendered = panels.renderProjectPicker(view);
          return sendPanelMessage({ api, link, address, anchor, html: rendered.html, replyMarkup: rendered.replyMarkup });
        },

        async showPanel(address, view, anchor) {
          const rendered = panels.renderPanel(view);
          return sendPanelMessage({ api, link, address, anchor, html: rendered.html, replyMarkup: rendered.replyMarkup });
        },

        async updatePanel(sent, view) {
          const rendered = panels.renderPanel(view);
          await updatePanelMessage(api, sent, rendered.html, rendered.replyMarkup, link);
        },

        async send(address, markdown, anchor) {
          return sendMarkdownNotice({ api, link, address, anchor, markdown });
        },

        async acknowledge(anchor: ReplyAnchor, state: 'received' | 'done' | 'failed') {
          const meta = link.lookupInbound(anchor.messageId);
          const msgId = Number(anchor.messageId);
          if (!meta || !Number.isInteger(msgId) || msgId <= 0) return;
          if (state === 'received') {
            await api.setMessageReaction(meta.chatId, msgId, '👀').catch(async () => {
              await api.sendChatAction(meta.chatId, 'typing', meta.threadId).catch(() => {});
            });
          } else if (state === 'done') {
            await api.setMessageReaction(meta.chatId, msgId).catch(() => {});
          } else if (state === 'failed') {
            await api.setMessageReaction(meta.chatId, msgId, '👎').catch(() => {});
          }
        },

        async close() {
          context.signal.removeEventListener('abort', onOuterAbort);
          stopController.abort();
          await loopDone.catch(() => {});
        },
      };

      return connection;
    },
  };
}
