/*
 * Feishu / Lark onboarding (docs/design/channels.md, 接入与管理): scan-to-create through the SDK's
 * `registerApp`, the live health checks behind the bot page's checklist, and the deep links.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import type { ChannelAccount, ChannelProvider, ProviderHealth, ProviderRegistration } from '../types.js';
import { createFeishuApi, FeishuApiError } from './openapi.js';

/** What the provider calls, by the names in the platform's scan-to-create default template. */
export const REQUIRED_SCOPES = [
  'im:message:send_as_bot',
  'im:message:update',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:resource',
  'im:message.reactions:write_only',
];

const APP_NAME = 'Riffet';
const APP_DESC = '在飞书里使用 Riffet 会话';
const APP_AVATAR = 'https://raw.githubusercontent.com/riffable/riffet/main/docs/brand/avatar.png';
const AVATAR_PROBE_MS = 2000;
/** The platform's "app not installed" code. */
const NOT_INSTALLED = 212100;

async function reachableAvatar(): Promise<string | undefined> {
  try {
    const response = await fetch(APP_AVATAR, { signal: AbortSignal.timeout(AVATAR_PROBE_MS) });
    const ok = response.status === 200 && (response.headers.get('content-type') ?? '').startsWith('image/');
    void response.body?.cancel().catch(() => undefined);
    return ok ? APP_AVATAR : undefined;
  } catch { return undefined; }
}

const register: NonNullable<ChannelProvider['register']> = async ({ appId, signal, ready }): Promise<ProviderRegistration> => {
  const avatar = await reachableAvatar();
  const result = await Lark.registerApp({
    signal,
    ...(appId ? { appId } : {}),
    appPreset: { name: APP_NAME, desc: APP_DESC, ...(avatar ? { avatar } : {}) },
    onQRCodeReady: ({ url, expireIn }) => ready(url, expireIn),
  });
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    domain: result.user_info?.tenant_brand ?? 'feishu',
    ...(result.user_info?.open_id ? { userId: result.user_info.open_id } : {}),
  };
};

const health: NonNullable<ChannelProvider['health']> = async (account: ChannelAccount): Promise<ProviderHealth> => {
  const api = createFeishuApi({ appId: account.appId, appSecret: account.appSecret, domain: account.domain });
  const out: ProviderHealth = {};
  const [bot, scopes] = await Promise.allSettled([
    api.callRaw('GET', '/open-apis/bot/v3/info', { label: 'bot-info' }),
    api.call('GET', '/open-apis/application/v6/scopes', { label: 'app-scopes' }),
  ]);
  let notInstalled = false;
  if (bot.status === 'fulfilled') {
    const info = (bot.value.bot ?? {}) as { activate_status?: number; app_name?: string; avatar_url?: string };
    if (typeof info.activate_status === 'number') out.activated = info.activate_status === 2;
    if (info.app_name) out.botName = info.app_name;
    if (info.avatar_url) out.avatarUrl = info.avatar_url;
  } else if (bot.reason instanceof FeishuApiError && bot.reason.code === NOT_INSTALLED) notInstalled = true;
  if (scopes.status === 'fulfilled') {
    const list = Array.isArray(scopes.value.scopes) ? scopes.value.scopes as Array<{ scope_name?: string; grant_status?: number }> : [];
    const granted = new Set(list.filter(item => item.grant_status === 1).map(item => item.scope_name));
    out.missingScopes = REQUIRED_SCOPES.filter(name => !granted.has(name));
  } else if (scopes.reason instanceof FeishuApiError && scopes.reason.code === NOT_INSTALLED) notInstalled = true;
  if (notInstalled) { out.activated = false; delete out.missingScopes; }
  return out;
};

const links: ChannelProvider['links'] = (account, missingScopes) => {
  const lark = account.domain === 'lark';
  const console = lark ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  return {
    open: `https://applink.${lark ? 'larksuite' : 'feishu'}.${lark ? 'com' : 'cn'}/client/bot/open?appId=${account.appId}`,
    console: `${console}/app/${account.appId}`,
    ...(missingScopes?.length ? { grant: `${console}/app/${account.appId}/auth?q=${missingScopes.join(',')}&op_from=openapi&token_type=tenant` } : {}),
  };
};

export const onboarding = { register, health, links };
