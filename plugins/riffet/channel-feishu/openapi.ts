/*
 * The Feishu / Lark OpenAPI over plain `fetch`: tenant token (cached per app, refreshed early,
 * concurrent requests coalesced), one error class that sorts failures by code, and the handful of
 * endpoints the channel uses. Only the long connection itself goes through the SDK.
 */
export type FeishuDomain = 'feishu' | 'lark';

export const DOMAIN_BASE: Record<FeishuDomain, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

export const feishuDomain = (value: string | undefined): FeishuDomain => value === 'lark' ? 'lark' : 'feishu';

const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Business codes meaning the tenant token is unusable; one fresh token and one retry. */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991668, 99991671]);
const REQUEST_TIMEOUT_MS = 30_000;

const CARD_LIMIT_CODES = new Set([230099, 11310]);
const ELEMENT_LIMIT = /element exceeds the limit|element count over limit/i;
const TABLE_LIMIT = /table number over limit|table count over limit/i;
const BUILD_FAILURE = /errcode\s*:\s*200800|create universal card fail/i;
const BAD_IMAGE_KEY = /errcode\s*:\s*200570|invalid image keys?|image key .+ (?:is )?invalid/i;
const DETAIL_HINT = new RegExp([ELEMENT_LIMIT, TABLE_LIMIT, BUILD_FAILURE, BAD_IMAGE_KEY, /sensitive|audit/i].map(r => r.source).join('|'), 'i');

export class FeishuApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | undefined,
    readonly label: string,
    readonly msg: string,
    /** The most specific detail string found anywhere in the response; the outer `msg` often hides it. */
    readonly detail?: string,
  ) {
    super(`${label}: http=${httpStatus} code=${code ?? ''} msg=${msg}${detail ? `, detail=${detail}` : ''}`);
    this.name = 'FeishuApiError';
  }
  private text(): string { return `${this.msg} ${this.detail ?? ''}`; }
  /** 230028: the content was blocked by moderation; only this payload is refused. */
  isModeration(): boolean { return this.code === 230028; }
  isRateLimit(): boolean { return this.httpStatus === 429 || this.code === 230020; }
  isCardElementLimit(): boolean { return this.code !== undefined && CARD_LIMIT_CODES.has(this.code) && ELEMENT_LIMIT.test(this.text()); }
  isCardTableLimit(): boolean { return this.code !== undefined && CARD_LIMIT_CODES.has(this.code) && TABLE_LIMIT.test(this.text()); }
  /** 200800 is wrapped in 230099 like the limits, but is no size problem. */
  isCardBuildFailure(): boolean { return this.code === 230099 && BUILD_FAILURE.test(this.text()); }
  isInvalidImageKey(): boolean { return (this.code === 230099 || this.code === 200570) && BAD_IMAGE_KEY.test(this.text()); }
  /** Whether trying again later could work; a malformed payload never will. */
  isTransient(): boolean { return this.isRateLimit() || this.httpStatus >= 500 || this.httpStatus === 0; }
}

export interface FeishuApiOptions { appId: string; appSecret: string; domain: FeishuDomain }

interface TokenEntry { token: string; expiresAt: number }
const tokens = new Map<string, TokenEntry>();
const refreshing = new Map<string, Promise<string>>();

function findDetail(value: unknown, depth = 0): string | undefined {
  if (value == null || depth > 6) return undefined;
  if (typeof value === 'string') return DETAIL_HINT.test(value) ? value : undefined;
  if (typeof value !== 'object') return undefined;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findDetail(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  label?: string;
}

export interface FeishuApi {
  readonly appId: string;
  /** One call; resolves with the `data` object (empty when the response has none). */
  call(method: string, path: string, options?: RequestOptions): Promise<Record<string, unknown>>;
  /** The raw JSON response, for the few endpoints that answer outside `data` (bot info). */
  callRaw(method: string, path: string, options?: RequestOptions): Promise<Record<string, unknown>>;
  botInfo(): Promise<{ openId: string; name?: string; avatarUrl?: string }>;
  /** `uuid`: Feishu's idempotency key; the same one on a retry returns the first message instead of a duplicate. */
  sendCard(chatId: string, card: unknown, uuid?: string): Promise<string>;
  replyCard(messageId: string, card: unknown, inThread: boolean, uuid?: string): Promise<string>;
  patchCard(messageId: string, card: unknown): Promise<void>;
  addReaction(messageId: string, emoji: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  downloadResource(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<{ data: Buffer; mimeType: string }>;
}

export function createFeishuApi(options: FeishuApiOptions): FeishuApi {
  const base = DOMAIN_BASE[options.domain];
  const cacheKey = `${base}|${options.appId}`;

  async function fetchToken(): Promise<string> {
    const response = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await response.json().catch(() => ({})) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || json.code !== 0 || !json.tenant_access_token) {
      throw new FeishuApiError(response.status, json.code, 'tenant_access_token', json.msg ?? '');
    }
    tokens.set(cacheKey, { token: json.tenant_access_token, expiresAt: Date.now() + (json.expire ?? 7200) * 1000 });
    return json.tenant_access_token;
  }

  function tenantToken(): Promise<string> {
    const cached = tokens.get(cacheKey);
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return Promise.resolve(cached.token);
    let inflight = refreshing.get(cacheKey);
    if (!inflight) {
      inflight = fetchToken().finally(() => refreshing.delete(cacheKey));
      refreshing.set(cacheKey, inflight);
    }
    return inflight;
  }

  function url(path: string, query?: RequestOptions['query']): string {
    const target = new URL(path, base);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) target.searchParams.set(key, value);
    return target.toString();
  }

  async function send(method: string, path: string, opts: RequestOptions, retried = false): Promise<Record<string, unknown>> {
    const label = opts.label ?? `${method} ${path}`;
    const token = await tenantToken();
    let response: Response;
    try {
      response = await fetch(url(path, opts.query), {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new FeishuApiError(0, undefined, label, error instanceof Error ? error.message : String(error));
    }
    const json = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = typeof json.code === 'number' ? json.code : undefined;
    if (response.ok && (code === undefined || code === 0)) return json;
    if (!retried && code !== undefined && TOKEN_INVALID_CODES.has(code)) {
      tokens.delete(cacheKey);
      return send(method, path, opts, true);
    }
    throw new FeishuApiError(response.status, code, label, typeof json.msg === 'string' ? json.msg : '', findDetail(json.error) ?? findDetail(json));
  }

  const call: FeishuApi['call'] = async (method, path, opts = {}) => {
    const json = await send(method, path, opts);
    return (json.data && typeof json.data === 'object' ? json.data : {}) as Record<string, unknown>;
  };
  const messageId = (data: Record<string, unknown>, label: string): string => {
    const id = data.message_id;
    if (typeof id !== 'string' || !id) throw new FeishuApiError(200, undefined, label, 'response has no message_id');
    return id;
  };
  const interactive = (card: unknown) => ({ msg_type: 'interactive', content: JSON.stringify(card) });

  return {
    appId: options.appId,
    call,
    callRaw: (method, path, opts = {}) => send(method, path, opts),
    async botInfo() {
      const json = await send('GET', '/open-apis/bot/v3/info', { label: 'bot-info' });
      const bot = (json.bot ?? (json.data as { bot?: unknown } | undefined)?.bot ?? json.data) as { open_id?: string; app_name?: string; avatar_url?: string } | undefined;
      if (!bot?.open_id) throw new FeishuApiError(200, undefined, 'bot-info', 'bot open_id is missing; is the bot capability enabled for this app');
      return { openId: bot.open_id, ...(bot.app_name ? { name: bot.app_name } : {}), ...(bot.avatar_url ? { avatarUrl: bot.avatar_url } : {}) };
    },
    async sendCard(chatId, card, uuid) {
      return messageId(await call('POST', '/open-apis/im/v1/messages', { query: { receive_id_type: 'chat_id' }, body: { receive_id: chatId, ...interactive(card), ...(uuid ? { uuid } : {}) }, label: 'send-card' }), 'send-card');
    },
    async replyCard(id, card, inThread, uuid) {
      return messageId(await call('POST', `/open-apis/im/v1/messages/${encodeURIComponent(id)}/reply`, { body: { ...interactive(card), reply_in_thread: inThread, ...(uuid ? { uuid } : {}) }, label: 'reply-card' }), 'reply-card');
    },
    async patchCard(id, card) {
      await call('PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(id)}`, { body: { content: JSON.stringify(card) }, label: 'patch-card' });
    },
    async addReaction(id, emoji) {
      const data = await call('POST', `/open-apis/im/v1/messages/${encodeURIComponent(id)}/reactions`, { body: { reaction_type: { emoji_type: emoji } }, label: 'add-reaction' });
      return typeof data.reaction_id === 'string' ? data.reaction_id : '';
    },
    async removeReaction(id, reactionId) {
      if (reactionId) await call('DELETE', `/open-apis/im/v1/messages/${encodeURIComponent(id)}/reactions/${encodeURIComponent(reactionId)}`, { label: 'remove-reaction' });
    },
    async downloadResource(id, fileKey, type) {
      const token = await tenantToken();
      const response = await fetch(url(`/open-apis/im/v1/messages/${encodeURIComponent(id)}/resources/${encodeURIComponent(fileKey)}`, { type }), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new FeishuApiError(response.status, undefined, 'download-resource', (await response.text().catch(() => '')).slice(0, 200));
      return { data: Buffer.from(await response.arrayBuffer()), mimeType: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim() };
    },
  };
}
