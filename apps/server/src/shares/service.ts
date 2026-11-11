import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShareSelectionSchema, ShareAppearanceRequestSchema } from '../../../../packages/contracts/src/schema/share.js';
import type { PublishedPreview, SharePublisher, ShareIdentity } from '@riffet/plugin-api';
import type { SessionShare, ShareCapability, ShareDraft, ShareDraftProgress, ShareSelection, ShareAppearanceRequest, ShareAppearance, ShareSnapshot, ShareStatus, TextParams } from '../../../../packages/contracts/src/index.js';
import type { OwnedSharePublisher } from '../plugins/registry.js';
import type { RouteDeps } from '../routes/deps.js';
import { BUILTIN_THEME_PALETTES } from '../../../web/src/lib/theme-builtins.generated.js';
import { AppError } from '../errors.js';
import { captureShareSnapshot, shareTurnCatalog } from './capture.js';
import { buildSharePackage } from './package.js';
import { AppearanceService } from '../appearance/index.js';

const now = () => new Date().toISOString();
const id = () => randomUUID().replaceAll('-', '');
const VALID_ID = /^[a-f0-9]{32}$/;
const DRAFT_TTL = 24 * 60 * 60 * 1000;
const NO_PUBLISHER = '未启用分享发布集成';
const AVATAR_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const DEFAULT_APPEARANCE: ShareAppearanceRequest = { themeId: 'riffet', mode: 'system' };
/** Bound to the publisher and account it was previewed for; neither without a publisher, when it is a local preview only. */
interface DraftRecord extends ShareDraft { hash: string; username?: string; profile?: string; publisher?: string; title: string; localOnly?: true }
interface ShareRecord extends SessionShare {
  publisher: string;
  pending?: { kind: 'publish' | 'remove'; draftId?: string; hash?: string; capturedAt?: string; expiryDays?: number; unconfirmedPublish?: boolean; removalAcknowledged?: boolean; appearance?: ShareAppearanceRequest; author?: boolean };
}
type Dependencies = Pick<RouteDeps, 'store' | 'nativeBackends' | 'workspace' | 'stateDir' | 'themes' | 'owner'> & { plugins: Pick<RouteDeps['plugins'], 'sharePublisher' | 'sharePublishers' | 'defaultSharePublisher' | 'refresh' | 'appearanceSources'> };
interface Options {
  /** Reads the plugin palettes a share may freeze; the server's appearance service. */
  appearance?: Pick<AppearanceService, 'palette' | 'shareAssets'>;
  webAssetsDir?: string;
  capture?: typeof captureShareSnapshot;
  build?: typeof buildSharePackage;
}

function readShare(json: string): ShareRecord {
  const value = JSON.parse(json) as ShareRecord;
  // A row that names no publisher matches none, so it is listed but cannot be updated or cancelled.
  return { ...value, publisher: value.publisher ?? '' };
}
function draftPublisher(draft: DraftRecord): string | undefined { return draft.username ? draft.publisher : undefined; }
function operationError(error: unknown): string {
  return error instanceof AppError ? error.message : '分享操作未完成，请核对平台状态';
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // Only stop this caller's wait: capability checks may be shared by other requests.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Local receipts, immutable draft packages, and one operation per share. The platform owns access.
 *
 * The publisher comes from the enabled plugins and is looked up per operation, since one can be
 * turned on or off at any time. A new share goes to the default publisher; an existing one always
 * to the plugin that published it: while that one is not enabled the share is listed but cannot
 * be checked, updated or cancelled.
 */
export class ShareService {
  private readonly active = new Map<string, Promise<void>>();
  private readonly locks = new Set<string>();
  private closed = false;
  readonly draftsRoot: string;
  private readonly pluginAppearance: Pick<AppearanceService, 'palette' | 'shareAssets'>;
  constructor(private readonly deps: Dependencies, private readonly options: Options = {}) {
    this.pluginAppearance = options.appearance ?? new AppearanceService(deps.plugins);
    this.draftsRoot = join(deps.stateDir, 'shares', 'drafts');
    // A process restart cannot know whether an in-flight external write committed.
    for (const share of this.records()) if (share.operation && share.operation !== 'uncertain') {
      this.save({ ...share, operation: 'uncertain', error: '上次操作中断，请核对平台状态', updatedAt: now() });
    }
  }
  /** Of publisher `owner` when it is enabled, else of the default one. */
  async capability(fresh = false, owner?: string): Promise<ShareCapability> {
    // An explicit refresh also notices a publisher that became available, such as a CLI installed since.
    if (fresh) await this.deps.plugins.refresh();
    const { plugins } = this.deps;
    const current = (owner ? plugins.sharePublisher(owner) : undefined) ?? plugins.defaultSharePublisher();
    if (!current) return { available: false, reason: 'unavailable', message: NO_PUBLISHER };
    const { owner: id, publisher } = current;
    const choices = plugins.sharePublishers();
    return {
      ...await this.check(publisher, fresh), publisher: { id, label: publisher.label, audience: publisher.audience },
      ...(choices.length > 1 ? { publishers: choices.map(item => ({ id: item.owner, label: item.publisher.label, audience: item.publisher.audience })) } : {}),
    };
  }
  async status(sessionId: string, fresh = false): Promise<ShareStatus> {
    this.deps.store.getSession(sessionId);
    const share = this.bySession(sessionId);
    const capability = await this.capability(fresh, share?.publisher);
    const actions = { preview: false, publish: false, remove: false, reconcile: false, retry: false };
    const result: ShareStatus = { capability, share: share ? this.publicShare(share) : null, actions };
    const block = (code: string, message: string, params?: TextParams) => {
      result.blocker = { code, message, messageRef: { code, ...(params ? { params } : {}) } };
      return result;
    };
    if (this.closed || this.locks.has(sessionId) || (share?.operation && share.operation !== 'uncertain')) return block('SHARE_BUSY', 'A share operation is already running');
    if (!capability.publisher) {
      actions.preview = !share?.operation;
      return share ? block('SHARE_PUBLISHER_UNAVAILABLE', 'The integration that published this share is not enabled') : result;
    }
    if (share && share.publisher !== capability.publisher.id) return block('SHARE_PUBLISHER_UNAVAILABLE', 'The integration that published this share is not enabled');
    if (!capability.available || !capability.username) return block('SHARE_UNAVAILABLE', capability.message ?? 'Sharing is unavailable', { reason: capability.reason ?? 'unavailable' });
    if (share && (share.username !== capability.username || (share.profile ?? '') !== (capability.profile ?? ''))) return block('SHARE_ACCOUNT_CHANGED', 'Switch to the publishing account', { reason: 'switch', username: share.username });
    actions.remove = Boolean(share && (share.operation === 'uncertain' || share.state !== 'removed') && (share.state === 'published' || share.url || share.previewId || share.deploymentId));
    if (share?.operation === 'uncertain') {
      actions.reconcile = true;
      actions.retry = true;
      return block('SHARE_UNCONFIRMED', 'Reconcile the previous share operation first');
    }
    actions.preview = true;
    actions.publish = true;
    return result;
  }
  /** What the request asks for and what to freeze for it; a plugin's palette is read from the plugin, so `frozen` is then read when needed. */
  private appearance(value: unknown): { request: ShareAppearanceRequest; frozen: ShareAppearance | (() => Promise<ShareAppearance>); assets: { uiFont?: string; monoFont?: string; background?: string } } {
    const parsed = ShareAppearanceRequestSchema.safeParse(value ?? DEFAULT_APPEARANCE);
    if (!parsed.success) throw new AppError('INVALID_SHARE_APPEARANCE', 'Choose a valid share appearance');
    const { uiFont, monoFont, background, ...theme } = parsed.data;
    // The fonts and background are read from the plugins when the package is built; the request that is kept and returned is the theme alone.
    return { ...this.themeOf(theme), assets: { ...(uiFont ? { uiFont } : {}), ...(monoFont ? { monoFont } : {}), ...(background ? { background } : {}) } };
  }
  private themeOf(request: ShareAppearanceRequest): { request: ShareAppearanceRequest; frozen: ShareAppearance | (() => Promise<ShareAppearance>) } {
    if (Object.hasOwn(BUILTIN_THEME_PALETTES, request.themeId)) return { request: { themeId: request.themeId, mode: request.mode }, frozen: { themeId: request.themeId, mode: request.mode } };
    // A plugin's palette is frozen as a theme of its own, so the share does not depend on the plugin staying installed.
    if (request.themeId.startsWith('plugin-')) {
      return { request: { themeId: request.themeId, mode: request.mode }, frozen: async () => {
        const palette = await this.pluginAppearance.palette(request.themeId);
        if (!palette) throw new AppError('SHARE_THEME_CHANGED', 'The theme changed; generate the preview again', 409);
        return { themeId: palette.id, mode: request.mode, customTheme: palette };
      } };
    }
    const library = this.deps.themes.getLibrary();
    const customTheme = library.themes.find(theme => theme.id === request.themeId);
    if (!customTheme || !request.themeRevision || request.themeRevision !== library.revision) throw new AppError('SHARE_THEME_CHANGED', 'The theme changed; generate the preview again', 409);
    return { request, frozen: { themeId: request.themeId, mode: request.mode, customTheme: structuredClone(customTheme) } };
  }
  turns(sessionId: string, signal?: AbortSignal) { return shareTurnCatalog(this.deps, sessionId, signal); }
  list(): SessionShare[] { return this.records().map(value => this.publicShare(value)); }
  /** Whether a share operation (a preview, publish or removal) of the conversation is in progress. */
  busy(sessionId: string): boolean {
    if (this.locks.has(sessionId)) return true;
    const share = this.bySession(sessionId);
    return Boolean(share?.operation && share.operation !== 'uncertain' && this.active.has(share.id));
  }
  get(sessionId: string): SessionShare | null { const value = this.bySession(sessionId); return value ? this.publicShare(value) : null; }
  private publicShare({ pending: _pending, ...value }: ShareRecord): SessionShare {
    const publisher = value.url ? this.deps.plugins.sharePublisher(value.publisher)?.publisher : undefined;
    if (value.url && publisher?.publicUrl) {
      try {
        const url = publisher.publicUrl(value.alias);
        if (['https:', 'http:'].includes(new URL(url).protocol)) return { ...value, url };
      } catch { /* A display projection must not prevent reading or managing the receipt. */ }
    }
    return value;
  }
  private records(): ShareRecord[] {
    return (this.deps.store.db.prepare('SELECT json FROM session_shares ORDER BY rowid DESC').all() as Array<{ json: string }>).map(row => readShare(row.json));
  }
  private bySession(sessionId: string): ShareRecord | undefined {
    const row = this.deps.store.db.prepare('SELECT json FROM session_shares WHERE session_id=?').get(sessionId) as { json: string } | undefined;
    return row ? readShare(row.json) : undefined;
  }
  private byId(shareId: string): ShareRecord {
    const row = this.deps.store.db.prepare('SELECT json FROM session_shares WHERE id=?').get(shareId) as { json: string } | undefined;
    if (!row) throw new AppError('SHARE_NOT_FOUND', 'The share does not exist', 404);
    return readShare(row.json);
  }
  private save(value: ShareRecord): void {
    if (this.closed) return;
    this.deps.store.db.prepare('INSERT INTO session_shares(id,session_id,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id, value.sessionId, JSON.stringify(value));
  }
  /** Plugin code is not ours: a check that throws reads as unavailable. */
  private check(publisher: SharePublisher, fresh: boolean): Promise<ShareCapability> {
    return publisher.capability({ fresh }).catch((): ShareCapability => ({ available: false, reason: 'unavailable', message: '无法检查分享能力' }));
  }
  /** For an existing share, the publisher that published it; otherwise the default one. */
  private publisher(share?: ShareRecord): OwnedSharePublisher {
    const { plugins } = this.deps;
    const owned = share ? plugins.sharePublisher(share.publisher) : plugins.defaultSharePublisher();
    if (owned) return owned;
    if (share && plugins.defaultSharePublisher()) throw new AppError('SHARE_PUBLISHER_UNAVAILABLE', 'The integration that published this share is not enabled', 409);
    throw new AppError('SHARE_UNAVAILABLE', 'Sharing is unavailable', 400, undefined, { reason: 'no_publisher' });
  }
  private async identity(publisher: SharePublisher, expected?: { username?: string; profile?: string }, fresh = true, signal?: AbortSignal): Promise<ShareIdentity> {
    signal?.throwIfAborted();
    const capability = await abortable(this.check(publisher, fresh), signal);
    if (!capability.available || !capability.username) throw new AppError('SHARE_UNAVAILABLE', 'Sharing is unavailable', 400, undefined, { reason: capability.reason ?? 'unavailable' });
    if (expected && (expected.username !== capability.username || (expected.profile ?? '') !== (capability.profile ?? ''))) {
      throw new AppError('SHARE_ACCOUNT_CHANGED', 'Switch to the publishing account', 409, undefined, { reason: 'switch', username: expected.username ?? '' });
    }
    return { username: capability.username, ...(capability.profile ? { profile: capability.profile } : {}) };
  }
  private lock(sessionId: string): () => void {
    if (this.closed) throw new AppError('SHARE_CLOSED', 'The service is shutting down', 409);
    if (this.locks.has(sessionId)) throw new AppError('SHARE_BUSY', 'A share operation is already running', 409);
    this.locks.add(sessionId);
    return () => this.locks.delete(sessionId);
  }
  /** The owner as it is now, ready to freeze; nothing when there is neither a name nor an avatar. */
  private author(): { frozen: NonNullable<ShareSnapshot['author']>; file?: { name: string; data: Buffer } } | undefined {
    const { name, avatar } = this.deps.owner.get();
    let file: { name: string; data: Buffer } | undefined;
    if (avatar) {
      try {
        const found = this.deps.owner.avatar(avatar.sha256);
        file = { name: `assets/owner-${avatar.sha256.slice(0, 16)}.${AVATAR_EXTENSIONS[found.type]}`, data: readFileSync(found.file) };
      } catch { /* A name alone still identifies the sharer. */ }
    }
    if (!name && !file) return undefined;
    return { frozen: { ...(name ? { name } : {}), ...(file ? { avatar: `./${file.name}` } : {}) }, ...(file ? { file } : {}) };
  }
  private packageDir(draftId: string): string {
    if (!VALID_ID.test(draftId)) throw new AppError('INVALID_SHARE_DRAFT', 'The share preview is invalid');
    return join(this.draftsRoot, draftId, 'public');
  }
  async draft(sessionId: string, allowOutsideRead = false, options: { onProgress?: (progress: ShareDraftProgress) => void; signal?: AbortSignal; selection?: unknown; appearance?: unknown; author?: unknown; localOnly?: boolean } = {}): Promise<ShareDraft> {
    const parsed = ShareSelectionSchema.safeParse(options.selection ?? { mode: 'all' });
    if (!parsed.success) throw new AppError('INVALID_SHARE_SELECTION', 'Choose a valid share range');
    const selection: ShareSelection = parsed.data;
    const appearance = this.appearance(options.appearance);
    if (options.author !== undefined && typeof options.author !== 'boolean') throw new AppError('INVALID_SHARE_AUTHOR', 'Choose whether to show the sharer');
    const showAuthor = options.author === true;
    const unlock = this.lock(sessionId);
    let draftId: string | undefined;
    const progress = (value: ShareDraftProgress) => { options.signal?.throwIfAborted(); options.onProgress?.(value); };
    try {
      this.deps.store.getSession(sessionId);
      const frozenTheme = typeof appearance.frozen === 'function' ? await appearance.frozen() : appearance.frozen;
      // Plugin fonts and background that are redistributable travel with the share; the rest are left out.
      const { files: appearanceFiles, ...frozenAssets } = Object.keys(appearance.assets).length ? await this.pluginAppearance.shareAssets(appearance.assets) : { files: [] };
      const frozenAppearance: ShareAppearance = { ...frozenTheme, ...frozenAssets };
      // Printing is independent of the remote publisher, its account and any unconfirmed write.
      const existing = options.localOnly ? undefined : this.bySession(sessionId);
      if (existing?.operation) throw new AppError('SHARE_UNCONFIRMED', 'Reconcile the previous share operation first', 409);
      // With no publisher enabled at all a draft is a local preview only.
      const current = !options.localOnly && this.deps.plugins.defaultSharePublisher() ? this.publisher(existing) : undefined;
      let identity: Pick<DraftRecord, 'username' | 'profile' | 'publisher'> = {};
      if (current) {
        progress({ stage: 'auth' });
        identity = { ...await this.identity(current.publisher, existing, false, options.signal), publisher: current.owner };
      }
      progress({ stage: 'history' });
      const snapshot = await (this.options.capture ?? captureShareSnapshot)(this.deps, sessionId, { selection, signal: options.signal });
      options.signal?.throwIfAborted();
      snapshot.appearance = frozenAppearance;
      // The owner is read now and frozen: a later profile change never alters this draft or a page published from it.
      const author = showAuthor ? this.author() : undefined;
      if (author) { snapshot.author = author.frozen; if (author.file) appearanceFiles.push(author.file); }
      draftId = id();
      const outputDir = this.packageDir(draftId);
      const packaged = fileURLToPath(new URL('./share/', import.meta.url));
      const sourceBuild = fileURLToPath(new URL('../../../../dist/share/', import.meta.url));
      const webAssetsDir = this.options.webAssetsDir ?? (existsSync(join(packaged, 'index.html')) ? packaged : sourceBuild);
      await mkdir(dirname(outputDir), { recursive: true, mode: 0o700 });
      const built = await (this.options.build ?? buildSharePackage)({ ...this.deps, snapshot, sessionId, outputDir, webAssetsDir, appearanceFiles, allowOutsideRead, onProgress: progress, signal: options.signal });
      options.signal?.throwIfAborted();
      await writeFile(join(outputDir, 'share-manifest.json'), JSON.stringify({ format: 'riffet-share-v1', hash: built.hash, capturedAt: snapshot.capturedAt }), { mode: 0o600 });
      const draft: DraftRecord = { id: draftId, sessionId, title: snapshot.title, capturedAt: snapshot.capturedAt,
        previewUrl: `/api/shares/drafts/${draftId}/files/index.html`, warnings: built.warnings, bytes: built.bytes, hash: built.hash, appearance: appearance.request, author: showAuthor, ...identity,
        ...(options.localOnly ? { localOnly: true as const } : {}) };
      await writeFile(join(this.draftsRoot, draftId, 'draft.json'), JSON.stringify(draft), { flag: 'wx', mode: 0o600 });
      return { id: draft.id, sessionId, capturedAt: draft.capturedAt, previewUrl: draft.previewUrl, warnings: draft.warnings, bytes: draft.bytes, appearance: draft.appearance, author: draft.author };
    } catch (error) {
      if (draftId) await rm(join(this.draftsRoot, draftId), { recursive: true, force: true });
      throw error;
    } finally { unlock(); }
  }
  private async readDraft(draftId: string, retained = false): Promise<DraftRecord> {
    this.packageDir(draftId);
    let draft: DraftRecord;
    try { draft = JSON.parse(await readFile(join(this.draftsRoot, draftId, 'draft.json'), 'utf8')) as DraftRecord; }
    catch { throw new AppError('SHARE_DRAFT_NOT_FOUND', 'The share preview has expired; generate it again', 404); }
    if (!retained && Date.now() - Date.parse(draft.capturedAt) > DRAFT_TTL) throw new AppError('SHARE_DRAFT_EXPIRED', 'The share preview has expired; generate it again', 410);
    return draft;
  }
  async previewDirectory(draftId: string): Promise<string> { await this.readDraft(draftId); return this.packageDir(draftId); }
  async previewExpiresAt(draftId: string): Promise<number> { return Date.parse((await this.readDraft(draftId)).capturedAt) + DRAFT_TTL; }

  async publish(sessionId: string, draftId: string, expiryDays: number): Promise<SessionShare> {
    if (!Number.isInteger(expiryDays) || ![7, 30, 90, 365].includes(expiryDays)) throw new AppError('INVALID_SHARE_EXPIRY', 'The share expiry is invalid');
    const existing = this.bySession(sessionId);
    if (existing?.operation === 'publishing' && existing.pending?.draftId === draftId && this.active.has(existing.id)) return this.publicShare(existing);
    const unlock = this.lock(sessionId);
    let started = false;
    try {
      this.deps.store.getSession(sessionId);
      const draft = await this.readDraft(draftId);
      if (draft.sessionId !== sessionId) throw new AppError('SHARE_DRAFT_MISMATCH', 'The share preview belongs to another conversation', 409, undefined, { reason: 'session' });
      if (draft.localOnly) throw new AppError('INVALID_SHARE_DRAFT', 'The share preview is invalid', 409);
      if (existing?.operation) throw new AppError('SHARE_UNCONFIRMED', 'Reconcile the previous share operation first', 409);
      const current = this.publisher(existing);
      if (draftPublisher(draft) !== current.owner) throw new AppError('SHARE_PUBLISHER_CHANGED', 'The publishing target changed; generate the preview again', 409);
      const identity = await this.identity(current.publisher, existing ?? draft);
      if (draft.username !== identity.username || (draft.profile ?? '') !== (identity.profile ?? '')) throw new AppError('SHARE_ACCOUNT_CHANGED', 'The account changed; generate the preview again', 409, undefined, { reason: 'changed' });
      // A repeated successful request is a receipt lookup, not another remote publish.
      if (existing?.state === 'published' && existing.publishedHash === draft.hash) return this.publicShare(existing);
      const shareId = existing?.id ?? id();
      const share: ShareRecord = { ...(existing ?? { id: shareId, sessionId, alias: `riffet-${shareId}`, state: 'unpublished' as const }),
        ...identity, publisher: current.owner, title: draft.title, updatedAt: now(), operation: 'publishing', error: undefined,
        pending: { kind: 'publish', draftId, hash: draft.hash, capturedAt: draft.capturedAt, expiryDays, appearance: draft.appearance ?? DEFAULT_APPEARANCE, author: draft.author ?? false } };
      this.save(share);
      const task = this.publishNow(current.publisher, share, draft, expiryDays).finally(() => { this.active.delete(share.id); unlock(); });
      this.active.set(share.id, task);
      started = true;
      return this.publicShare(share);
    } finally { if (!started) unlock(); }
  }
  private async publishNow(publisher: SharePublisher, share: ShareRecord, draft: DraftRecord, expiryDays: number, override = share.state === 'published'): Promise<void> {
    try {
      const preview = await publisher.deploy(this.packageDir(draft.id), share.alias, expiryDays, share, override);
      share = this.withRemote(share, preview);
      this.save(share);
      if (!await publisher.verify(share.alias, draft.hash)) throw new AppError('SHARE_NOT_VERIFIED', 'The page was submitted but its content has not been verified; check the status later');
      this.save({ ...share, state: 'published', operation: undefined, error: undefined, pending: undefined,
        publishedHash: draft.hash, capturedAt: draft.capturedAt, appearance: draft.appearance ?? DEFAULT_APPEARANCE, author: draft.author ?? false, updatedAt: now() });
    } catch (error) {
      // Even an authentication error can occur in the readiness poll after the upload committed.
      this.save({ ...share, operation: 'uncertain', error: operationError(error), updatedAt: now() });
    }
  }
  private withRemote(share: ShareRecord, preview: PublishedPreview): ShareRecord {
    let url: URL | undefined;
    try { url = new URL(preview.url); } catch { /* rejected below */ }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new AppError('SHARE_CLI_PROTOCOL', 'The platform returned invalid share data');
    return { ...share, previewId: preview.id, url: preview.url, expiresAt: preview.expiresAt,
      ...(preview.deploymentId != null ? { deploymentId: preview.deploymentId } : {}), updatedAt: now() };
  }
  async retry(shareId: string): Promise<SessionShare> {
    const share = this.byId(shareId);
    if (this.active.has(share.id)) return this.publicShare(share);
    if (share.pending?.kind === 'remove') return this.remove(shareId);
    if (!share.pending) return this.reconcile(shareId);
    const unlock = this.lock(share.sessionId);
    let started = false;
    try {
      const { publisher } = this.publisher(share);
      await this.identity(publisher, share);
      const next: ShareRecord = { ...share, operation: 'publishing', error: undefined, updatedAt: now() };
      this.save(next);
      const task = this.retryPublishNow(publisher, next).finally(() => { this.active.delete(shareId); unlock(); });
      this.active.set(shareId, task); started = true;
      return this.publicShare(next);
    } finally { if (!started) unlock(); }
  }
  private async retryPublishNow(publisher: SharePublisher, share: ShareRecord): Promise<void> {
    try {
      const pending = share.pending!;
      const remote = await publisher.find(share.alias, share);
      if (remote && pending.hash && await publisher.verify(share.alias, pending.hash)) {
        this.save({ ...this.withRemote(share, remote), state: 'published', publishedHash: pending.hash,
          capturedAt: pending.capturedAt, appearance: pending.appearance ?? DEFAULT_APPEARANCE, author: pending.author ?? false, operation: undefined, pending: undefined, error: undefined });
        return;
      }
      if (!pending.draftId || !pending.hash || !pending.expiryDays) throw new AppError('SHARE_RETRY_UNAVAILABLE', 'The original share preview is unavailable; check the platform status', 409);
      // Pending receipts retain their package beyond the normal preview lifetime.
      const draft = await this.readDraft(pending.draftId, true);
      if (draft.sessionId !== share.sessionId || draft.hash !== pending.hash || draftPublisher(draft) !== share.publisher || draft.username !== share.username || (draft.profile ?? '') !== (share.profile ?? '')) {
        throw new AppError('SHARE_DRAFT_MISMATCH', 'The original share preview does not match the publish record', 409, undefined, { reason: 'record' });
      }
      await this.publishNow(publisher, share, draft, pending.expiryDays, true);
    } catch (error) {
      this.save({ ...share, operation: 'uncertain', error: operationError(error), updatedAt: now() });
    }
  }
  async remove(shareId: string): Promise<SessionShare> {
    const share = this.byId(shareId);
    if (share.operation === 'removing' && this.active.has(share.id)) return this.publicShare(share);
    const unlock = this.lock(share.sessionId);
    let started = false;
    try {
      const { publisher } = this.publisher(share);
      await this.identity(publisher, share);
      if (share.state === 'removed' && !share.operation) return this.publicShare(share);
      const next: ShareRecord = { ...share, operation: 'removing', pending: { ...share.pending, kind: 'remove',
        unconfirmedPublish: share.pending?.kind === 'publish' || share.pending?.unconfirmedPublish }, error: undefined, updatedAt: now() };
      this.save(next);
      const task = this.removeNow(publisher, next).finally(() => { this.active.delete(shareId); unlock(); });
      this.active.set(shareId, task); started = true;
      return this.publicShare(next);
    } finally { if (!started) unlock(); }
  }
  private async removeNow(publisher: SharePublisher, share: ShareRecord): Promise<void> {
    try {
      const remote = await publisher.find(share.alias, share);
      if (!remote && share.pending?.unconfirmedPublish && !share.pending.removalAcknowledged) throw new AppError('SHARE_REMOVE_UNCONFIRMED', 'The previous publish result is unconfirmed; check the platform status before removing', undefined, undefined, { reason: 'publish' });
      if (remote) {
        await publisher.remove(remote.id, share);
        share = { ...share, pending: { ...share.pending, kind: 'remove', removalAcknowledged: true } };
        this.save(share);
      }
      if (await publisher.find(share.alias, share)) throw new AppError('SHARE_REMOVE_UNCONFIRMED', 'The platform still lists this share; check the status later', undefined, undefined, { reason: 'remote' });
      this.save({ ...share, state: 'removed', operation: undefined, pending: undefined, error: undefined, updatedAt: now() });
    } catch (error) { this.save({ ...share, operation: 'uncertain', error: operationError(error), updatedAt: now() }); }
  }
  async reconcile(shareId: string): Promise<SessionShare> {
    let share = this.byId(shareId);
    const unlock = this.lock(share.sessionId);
    try {
      const { publisher } = this.publisher(share);
      await this.identity(publisher, share);
      const remote = await publisher.find(share.alias, share);
      if (!remote) {
        if (share.pending?.kind === 'publish' || (share.pending?.unconfirmedPublish && !share.pending.removalAcknowledged)) {
          share = { ...share, operation: 'uncertain', error: '平台尚未找到此分享，发布结果仍待核对', updatedAt: now() };
        } else share = { ...share, state: share.state === 'unpublished' ? 'unpublished' : 'removed', operation: undefined, pending: undefined, error: undefined, updatedAt: now() };
      } else {
        share = this.withRemote(share, remote);
        if (share.pending?.kind === 'remove') share = { ...share, operation: 'uncertain', error: '分享仍在平台，可重试取消' };
        else {
          const hash = share.pending?.hash ?? share.publishedHash;
          if (hash && await publisher.verify(share.alias, hash)) {
            share = { ...share, state: 'published', publishedHash: hash, capturedAt: share.pending?.capturedAt ?? share.capturedAt,
              appearance: share.pending?.appearance ?? share.appearance ?? DEFAULT_APPEARANCE, author: share.pending?.author ?? share.author ?? false, pending: undefined, operation: undefined, error: undefined };
          } else share = { ...share, operation: 'uncertain', error: '页面内容尚未核对，请稍后重试' };
        }
      }
      this.save(share);
      return this.publicShare(share);
    } finally { unlock(); }
  }
  async sweepDrafts(): Promise<void> {
    const kept = new Set(this.records().flatMap(share => share.pending?.draftId ? [share.pending.draftId] : []));
    for (const entry of await readdir(this.draftsRoot).catch(() => [])) {
      if (!VALID_ID.test(entry) || kept.has(entry)) continue;
      const path = join(this.draftsRoot, entry);
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > DRAFT_TTL) await rm(path, { recursive: true, force: true });
    }
  }
  async recover(): Promise<void> {
    for (const share of this.records()) {
      if (this.closed) return;
      if (share.operation === 'uncertain') await this.reconcile(share.id).catch(() => undefined);
    }
  }
  /** Leave persisted pending receipts for reconciliation rather than racing SQLite shutdown. */
  close(): void { this.closed = true; }
  async settled(): Promise<void> { await Promise.all([...this.active.values()]); }
}
