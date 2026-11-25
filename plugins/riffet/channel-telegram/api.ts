/*
 * Telegram Bot API client over native `fetch` (with optional HTTP/HTTPS CONNECT proxy using Node
 * built-ins so no third-party SDK is required). Token strings are always stripped from error text.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';

export const DEFAULT_API_BASE = 'https://api.telegram.org';
// perf-rules: allow Telegram Bot API getFile hard protocol limit (20 MB)
export const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  has_topics_enabled?: boolean;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMedia {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  reply_to_message?: TelegramMessage;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramMedia;
  voice?: TelegramMedia;
  video?: TelegramMedia;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramStoppedGeneration {
  chat?: TelegramChat;
  chat_id?: number;
  from?: TelegramUser;
  message_thread_id?: number;
  draft_id?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  stopped_message_generation?: TelegramStoppedGeneration;
}

export type InlineButtonStyle = 'primary' | 'success' | 'danger';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  style?: InlineButtonStyle;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface ForceReplyMarkup {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
}

export type ReplyMarkup = InlineKeyboardMarkup | ForceReplyMarkup;

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    public readonly description: string,
    public readonly retryAfterSec?: number,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = 'TelegramApiError';
  }

  isUnauthorized(): boolean { return this.code === 401; }
  isConflict(): boolean { return this.code === 409; }
  isRateLimit(): boolean { return this.code === 429; }
  isNotModified(): boolean { return this.code === 400 && /message is not modified/i.test(this.description); }
  isParseError(): boolean { return this.code === 400 && /can't parse entities/i.test(this.description); }
  isUnsupportedMethod(): boolean { return this.code === 400 || this.code === 404; }
  isTransient(): boolean { return this.code === 0 || this.code === 429 || this.code >= 500; }
}

export function sanitizeToken(text: string, token: string): string {
  return token ? text.split(token).join('<redacted>') : text;
}

function errorCauseText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [error.message];
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    if (code) parts.push(code);
    if (cause.message && cause.message !== error.message) parts.push(cause.message);
  } else if (typeof cause === 'string' && cause) {
    parts.push(cause);
  }
  return parts.join(': ');
}

/** Turns a Telegram API / transport failure into a short actionable message for the settings UI. */
export function describeTelegramError(error: unknown, options?: { hasProxy?: boolean }): string {
  const hasProxy = Boolean(options?.hasProxy);
  if (error instanceof TelegramApiError) {
    if (error.isUnauthorized()) return 'Bot Token 无效，请在 @BotFather 核对或重新生成';
    if (error.isConflict()) return '另一个实例正在使用这个机器人，请先停止另一处连接';
    if (error.code === 404) return 'Bot Token 无效或 API 基址不正确';
    if (error.code === 0) {
      const desc = error.description;
      if (hasProxy && /Proxy CONNECT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(desc)) {
        return '无法连接代理服务器，请检查代理地址和端口';
      }
      if (/timeout|aborted|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed/i.test(desc)) {
        return hasProxy
          ? '经代理连接 Telegram 超时，请检查代理是否可用'
          : '无法连接 api.telegram.org，若服务器无法直连请填写代理地址';
      }
    }
    return error.description;
  }
  return error instanceof Error ? error.message : String(error);
}

interface RawResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

/** Sends an HTTP/HTTPS request through an HTTP CONNECT proxy without extra dependencies. */
function requestViaProxy(
  targetUrl: URL,
  proxyUrl: URL,
  init: { method: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) { reject(new Error('Aborted')); return; }
    const targetPort = Number(targetUrl.port) || (targetUrl.protocol === 'https:' ? 443 : 80);
    const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);
    const proxyAuth = proxyUrl.username || proxyUrl.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`
      : undefined;

    let done = false;
    let activeSocket: { destroy(): void } | undefined;
    let tunnelSocket: tls.TLSSocket | undefined;
    const finish = (err: Error | undefined, value?: RawResponse) => {
      if (done) return;
      done = true;
      init.signal?.removeEventListener('abort', onAbort);
      if (err) {
        activeSocket?.destroy();
        tunnelSocket?.destroy();
        reject(err);
      } else {
        resolve(value!);
      }
    };
    const onAbort = () => { finish(new Error('Aborted')); };
    init.signal?.addEventListener('abort', onAbort, { once: true });

    const sendPlain = (socket?: tls.TLSSocket) => {
      const mod = targetUrl.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: targetUrl.hostname,
        port: targetPort,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: init.method,
        agent: false,
        headers: {
          ...init.headers,
          ...(init.body ? { 'content-length': String(init.body.byteLength) } : {}),
        },
        ...(socket ? { createConnection: () => socket } : {}),
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => finish(undefined, {
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks),
        }));
        res.on('error', err => finish(err));
      });
      activeSocket = req;
      req.on('error', err => finish(err));
      if (init.body) req.write(init.body);
      req.end();
    };

    if (targetUrl.protocol !== 'https:') {
      const mod = proxyUrl.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: proxyUrl.hostname,
        port: proxyPort,
        path: targetUrl.toString(),
        method: init.method,
        agent: false,
        headers: {
          host: targetUrl.host,
          ...init.headers,
          ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}),
          ...(init.body ? { 'content-length': String(init.body.byteLength) } : {}),
        },
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => finish(undefined, {
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks),
        }));
        res.on('error', err => finish(err));
      });
      activeSocket = req;
      req.on('error', err => finish(err));
      if (init.body) req.write(init.body);
      req.end();
      return;
    }

    const proxyMod = proxyUrl.protocol === 'https:' ? https : http;
    const connectReq = proxyMod.request({
      hostname: proxyUrl.hostname,
      port: proxyPort,
      method: 'CONNECT',
      agent: false,
      path: `${targetUrl.hostname}:${targetPort}`,
      headers: {
        host: `${targetUrl.hostname}:${targetPort}`,
        ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}),
      },
    });
    activeSocket = connectReq;
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`Proxy CONNECT failed (${res.statusCode ?? 0})`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: targetUrl.hostname });
      tunnelSocket = tlsSocket;
      activeSocket = tlsSocket;
      tlsSocket.on('error', err => finish(err));
      sendPlain(tlsSocket);
    });
    connectReq.on('error', err => finish(err));
    connectReq.end();
  });
}

export interface TelegramApiOptions {
  token: string;
  apiBase?: string;
  proxy?: string;
}

export interface TelegramApi {
  call<T>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
  getMe(signal?: AbortSignal): Promise<TelegramUser>;
  getUpdates(params: { offset?: number; timeout: number; allowed_updates: string[] }, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  deleteWebhook(dropPending?: boolean): Promise<boolean>;
  setMyCommands(commands: Array<{ command: string; description: string }>, scope?: Record<string, unknown>): Promise<boolean>;
  sendMessage(params: {
    chat_id: number | string;
    message_thread_id?: number;
    text: string;
    parse_mode?: 'HTML';
    reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
    reply_markup?: ReplyMarkup;
    link_preview_options?: { is_disabled: boolean };
  }): Promise<TelegramMessage>;
  editMessageText(params: {
    chat_id: number | string;
    message_id: number;
    text: string;
    parse_mode?: 'HTML';
    reply_markup?: InlineKeyboardMarkup;
    link_preview_options?: { is_disabled: boolean };
  }): Promise<TelegramMessage | boolean>;
  deleteMessage(chatId: number | string, messageId: number): Promise<boolean>;
  sendMessageDraft(params: {
    chat_id: number | string;
    message_thread_id?: number;
    draft_id: number;
    text: string;
    parse_mode?: 'HTML';
    can_stop?: boolean;
    keep_on_stop?: boolean;
  }): Promise<boolean>;
  answerCallbackQuery(params: { callback_query_id: string; text?: string; show_alert?: boolean }): Promise<boolean>;
  setMessageReaction(chatId: number | string, messageId: number, emoji?: string): Promise<boolean>;
  sendChatAction(chatId: number | string, action: 'typing', threadId?: number): Promise<boolean>;
  downloadFile(fileId: string): Promise<{ data: Buffer; filePath: string; contentType: string }>;
}

function resolveProxyUrl(explicit?: string): URL | undefined {
  const raw = explicit?.trim();
  if (raw) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    let parsed: URL;
    try { parsed = new URL(withScheme); } catch {
      throw new Error('代理地址格式无效，请使用如 http://127.0.0.1:7890 的格式');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`暂不支持 ${parsed.protocol.replace(/:$/, '')} 代理协议，请使用 HTTP 代理地址（如 http://127.0.0.1:7890）`);
    }
    return parsed;
  }
  const envRaw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!envRaw) return undefined;
  try {
    const parsed = new URL(envRaw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed;
  } catch { /* ignore invalid env proxy */ }
  return undefined;
}

export function createTelegramApi(options: TelegramApiOptions): TelegramApi {
  const token = options.token.trim();
  const base = (options.apiBase?.trim() || DEFAULT_API_BASE).replace(/\/+$/, '');
  const proxyUrl = resolveProxyUrl(options.proxy);

  async function rawFetch(url: string, init: { method: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal }): Promise<RawResponse> {
    if (proxyUrl) return requestViaProxy(new URL(url), proxyUrl, init);
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body ? { body: new Uint8Array(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    const arrayBuffer = await response.arrayBuffer();
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: Buffer.from(arrayBuffer) };
  }

  async function call<T>(method: string, params?: Record<string, unknown>, callOptions?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
    const timeoutMs = callOptions?.timeoutMs ?? 20_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callOptions?.signal ? AbortSignal.any([callOptions.signal, timeoutSignal]) : timeoutSignal;
    const url = `${base}/bot${token}/${method}`;
    const body = params ? Buffer.from(JSON.stringify(params), 'utf8') : undefined;
    let raw: RawResponse;
    try {
      raw = await rawFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body ? { body } : {}),
        signal,
      });
    } catch (error) {
      const message = sanitizeToken(errorCauseText(error), token);
      throw new TelegramApiError(method, 0, message);
    }
    let parsed: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    try {
      parsed = JSON.parse(raw.body.toString('utf8')) as typeof parsed;
    } catch {
      throw new TelegramApiError(method, raw.status, sanitizeToken(raw.body.toString('utf8').slice(0, 200), token));
    }
    if (!parsed.ok) {
      throw new TelegramApiError(
        method,
        parsed.error_code ?? raw.status,
        sanitizeToken(parsed.description ?? 'Unknown error', token),
        parsed.parameters?.retry_after,
      );
    }
    return parsed.result as T;
  }

  return {
    call,
    getMe: signal => call<TelegramUser>('getMe', undefined, { signal, timeoutMs: 15_000 }),
    getUpdates: (params, signal) => call<TelegramUpdate[]>('getUpdates', params, { signal, timeoutMs: (params.timeout + 15) * 1000 }),
    deleteWebhook: (dropPending = false) => call<boolean>('deleteWebhook', { drop_pending_updates: dropPending }),
    setMyCommands: (commands, scope) => call<boolean>('setMyCommands', { commands, ...(scope ? { scope } : {}) }),
    sendMessage: params => call<TelegramMessage>('sendMessage', params),
    editMessageText: params => call<TelegramMessage | boolean>('editMessageText', params),
    deleteMessage: (chat_id, message_id) => call<boolean>('deleteMessage', { chat_id, message_id }),
    sendMessageDraft: params => call<boolean>('sendMessageDraft', params),
    answerCallbackQuery: params => call<boolean>('answerCallbackQuery', params),
    setMessageReaction: (chat_id, message_id, emoji) => call<boolean>('setMessageReaction', {
      chat_id,
      message_id,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    }),
    sendChatAction: (chat_id, action, message_thread_id) => call<boolean>('sendChatAction', {
      chat_id,
      action,
      ...(message_thread_id !== undefined ? { message_thread_id } : {}),
    }),
    async downloadFile(fileId: string) {
      const info = await call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
      if (info.file_size && info.file_size > MAX_TELEGRAM_FILE_BYTES) {
        throw new Error('Telegram Bot API limits downloads to 20 MB');
      }
      if (!info.file_path) throw new Error('Telegram did not return a file path');
      const url = `${base}/file/bot${token}/${info.file_path}`;
      let raw: RawResponse;
      try {
        raw = await rawFetch(url, { method: 'GET', headers: {}, signal: AbortSignal.timeout(60_000) });
      } catch (error) {
        throw new Error(sanitizeToken(errorCauseText(error), token));
      }
      if (raw.status < 200 || raw.status >= 300) throw new Error(`File download failed (${raw.status})`);
      if (raw.body.byteLength > MAX_TELEGRAM_FILE_BYTES) {
        throw new Error('Telegram Bot API limits downloads to 20 MB');
      }
      return { data: raw.body, filePath: info.file_path, contentType: raw.contentType };
    },
  };
}
