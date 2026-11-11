import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { SessionShare, ShareCapability, ShareAppearanceRequest, ShareStatus, ShareDraft, ShareDraftEvent, ShareDraftProgress, ShareSelection, ShareTurnCatalog } from '@contracts';
import { request, requestResponse } from './api';
import { HttpError } from './errors';

const sessionUrl = (id: string) => `/api/sessions/${encodeURIComponent(id)}/share`;
const shareUrl = (id: string) => `/api/shares/${encodeURIComponent(id)}`;
const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

const prepareDraft = (route: 'draft' | 'print') => async (sessionId: string, onProgress?: (progress: ShareDraftProgress) => void, signal?: AbortSignal, selection?: ShareSelection, appearance?: ShareAppearanceRequest, author?: boolean): Promise<ShareDraft> => {
  const response = await requestResponse(`${sessionUrl(sessionId)}/${route}`, { ...post({ ...(selection ? { selection } : {}), ...(appearance ? { appearance } : {}), ...(author ? { author } : {}) }), headers: { Accept: 'application/x-ndjson' }, signal });
  if (!(response.headers.get('content-type') ?? '').includes('application/x-ndjson')) return response.json() as Promise<ShareDraft>;
  if (!response.body) throw new Error(i18n._(msg`预览连接已中断，请重试`));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let draft: ShareDraft | undefined;
  const receive = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as ShareDraftEvent;
    if (event.type === 'progress') onProgress?.(event.progress);
    else if (event.type === 'ready') draft = event.draft;
    else if (event.type === 'error') throw new HttpError(500, event.message, event.messageRef?.code, undefined, event.messageRef?.params);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        receive(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) { receive(buffer); break; }
    }
    if (!draft) throw new Error(i18n._(msg`预览连接已中断，请重试`));
    return draft;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

export const shares = {
  /** Of `publisher` when it is enabled, else of the one new shares use. */
  capability: (fresh = false, signal?: AbortSignal, publisher?: string) => {
    const query = new URLSearchParams();
    if (fresh) query.set('fresh', 'true');
    if (publisher) query.set('publisher', publisher);
    return request<ShareCapability>(`/api/shares/capability${query.size ? `?${query}` : ''}`, { signal });
  },
  status: (sessionId: string, fresh = false, signal?: AbortSignal) => request<ShareStatus>(`${sessionUrl(sessionId)}/status${fresh ? '?fresh=true' : ''}`, { signal }),
  list: () => request<SessionShare[]>('/api/shares'),
  get: (sessionId: string, signal?: AbortSignal) => request<SessionShare | null>(sessionUrl(sessionId), { signal }),
  turns: (sessionId: string, signal?: AbortSignal) => request<ShareTurnCatalog>(`${sessionUrl(sessionId)}/turns`, { signal }),
  draft: prepareDraft('draft'),
  /** A local print preview, independent of a configured publisher or publishing account. */
  printDraft: prepareDraft('print'),
  publish: (sessionId: string, draftId: string, expiryDays: number) => request<SessionShare>(sessionUrl(sessionId), post({ draftId, expiryDays })),
  remove: (id: string) => request<SessionShare>(shareUrl(id), { method: 'DELETE' }),
  reconcile: (id: string) => request<SessionShare>(`${shareUrl(id)}/reconcile`, post()),
  retry: (id: string) => request<SessionShare>(`${shareUrl(id)}/retry`, post()),
};

/** The publisher's own message when it gave one: only it knows which tool or account it needs. */
export function shareCapabilityMessage(capability: ShareCapability): string {
  if (capability.message) return capability.message;
  switch (capability.reason) {
    case 'missing_cli': return i18n._(msg`未安装发布所需的命令行工具`);
    case 'unsupported_cli': return i18n._(msg`请更新发布所需的命令行工具`);
    case 'login_required': return i18n._(msg`请先登录发布账号`);
    case 'permission_denied': return i18n._(msg`当前账号没有发布权限`);
    default: return i18n._(msg`分享服务暂不可用`);
  }
}

/** Why `share` cannot be checked or cancelled: another integration than the active publisher made it. With no publisher at all, the capability says so. */
export function shareManagedElsewhere(share: SessionShare, capability?: ShareCapability): string | undefined {
  return capability?.publisher && share.publisher && share.publisher !== capability.publisher.id ? i18n._(msg`发布此分享的插件未启用`) : undefined;
}
