import {
  catalogEntry, catalogSelection, parseSelection, resolveCatalogSelection,
  type NativeBackendCatalogEntry, type Project, type Session,
} from '../../../../packages/contracts/src/index.js';
import type { ChannelChat } from '../../../../packages/contracts/src/channels.js';
import { AppError } from '../errors.js';
import { configureNative } from '../native/configure.js';
import { defaultBackendForClient } from '../native/client-features.js';
import { REPLY } from './commands.js';
import { buildModelView } from './projector.js';
import {
  ANSWER_WAIT_MS, CATALOG_CACHE_MAX, CATALOG_TTL_MS, errorMessage, MODEL_NAMES_CAP,
  MODEL_NAMES_TTL_MS, type ChannelSharedState, type ModelNameCacheEntry, type ModelRef,
} from './shared.js';
import type { ActionReply, ChannelConnection, InboundAction, InboundMessage, ModelPickerView } from './types.js';

export class ChannelModelPicker {
  constructor(
    private readonly state: ChannelSharedState,
    private readonly onTrackerSchedule: (sessionId: string) => void,
  ) {}

  modelEntry(session: Session): ModelNameCacheEntry | undefined {
    if (!session.model || !session.backendId) return undefined;
    const key = `${session.backendId}:${session.backendProfileId ?? ''}`;
    const entry = this.state.modelNames.get(key);
    if (!entry || (!entry.loading && Date.now() - entry.at > MODEL_NAMES_TTL_MS)) this.loadModelNames(key, session);
    return this.state.modelNames.get(key);
  }

  modelName(session: Session): string | undefined {
    return this.modelEntry(session)?.names.get(parseSelection(session.model).model);
  }

  private loadModelNames(key: string, session: Session): void {
    const previous = this.state.modelNames.get(key);
    const entry: ModelNameCacheEntry = { names: previous?.names ?? new Map<string, string>(), models: previous?.models ?? [], at: Date.now() };
    this.state.modelNames.delete(key);
    this.state.modelNames.set(key, entry);
    while (this.state.modelNames.size > MODEL_NAMES_CAP) this.state.modelNames.delete(this.state.modelNames.keys().next().value!);
    entry.loading = (async () => {
      try {
        const { models } = await this.state.deps.nativeBackends.catalog.entry(session.backendId!, this.state.projectOf(session.projectId), undefined, session, { allModels: true });
        const names = new Map<string, string>();
        for (const model of models) for (const id of [model.value, ...(model.aliases ?? []), ...(model.nativeVariants ?? []).map(variant => variant.value)]) if (model.name) names.set(id, model.name);
        entry.names = names; entry.models = models;
        this.onTrackerSchedule(session.id);
      } catch { /* the tidied id stays */ }
      finally { entry.loading = undefined; }
    })();
  }

  private catalogOf(backendId: string, profileId: string | undefined, project: Project | undefined, session: Session | undefined, stale: boolean): Promise<NativeBackendCatalogEntry> {
    const key = `${backendId}:${profileId ?? ''}:${session?.id ?? ''}`;
    const hit = this.state.catalogs.get(key);
    const expired = !hit || Date.now() - hit.at > CATALOG_TTL_MS;
    if (hit && (!expired || stale)) {
      if (expired) void this.readCatalog(key, backendId, profileId, project, session).catch(() => undefined);
      return hit.value;
    }
    return this.readCatalog(key, backendId, profileId, project, session);
  }

  private readCatalog(key: string, backendId: string, profileId: string | undefined, project: Project | undefined, session: Session | undefined): Promise<NativeBackendCatalogEntry> {
    const value = this.state.deps.nativeBackends.catalog.entry(backendId, project, profileId, session, { allModels: true });
    this.state.catalogs.delete(key);
    this.state.catalogs.set(key, { at: Date.now(), value });
    while (this.state.catalogs.size > CATALOG_CACHE_MAX) this.state.catalogs.delete(this.state.catalogs.keys().next().value!);
    value.catch(() => { if (this.state.catalogs.get(key)?.value === value) this.state.catalogs.delete(key); });
    return value;
  }

  private backendChoices(stale: boolean): Promise<Array<{ id: string; name: string }>> {
    const hit = this.state.backendList.value;
    if (hit && (stale || Date.now() - this.state.backendList.at <= CATALOG_TTL_MS)) return hit;
    const offered = new Set<string>(this.state.deps.nativeBackends.offeredBackendIds());
    const value = this.state.deps.nativeBackends.catalog.listBackends().then(entries => entries.filter(entry => offered.has(entry.backendId) && entry.backendId !== 'chat' && entry.available).map(entry => ({ id: entry.backendId as string, name: entry.label })));
    this.state.backendList.value = value; this.state.backendList.at = Date.now();
    value.catch(() => { if (this.state.backendList.value === value) this.state.backendList.value = undefined; });
    return value;
  }

  private async modelTarget(entry: ModelRef): Promise<{ backendId: string; profileId?: string; project?: Project; session?: Session; selection: string } | undefined> {
    if (entry.scope === 'session') {
      let session: Session;
      try { session = this.state.deps.store.getSession(entry.sessionId!); } catch { return undefined; }
      if (!session.backendId) return undefined;
      return { backendId: session.backendId, ...(session.backendProfileId ? { profileId: session.backendProfileId } : {}), project: this.state.projectOf(session.projectId), session, selection: entry.pending ?? session.model ?? '' };
    }
    const chat = this.state.bindings.chat(entry.chat);
    if (!chat) return undefined;
    const defaults = this.state.bindings.chatModel(chat.key);
    const backendId = defaults.backendId ?? await defaultBackendForClient(undefined, this.state.deps.settings.getSettings().defaultBackendId, this.state.deps.nativeBackends);
    return { backendId, project: chat.projectId ? this.state.projectOf(chat.projectId) : undefined, selection: defaults.model ?? '' };
  }

  private async modelView(entry: ModelRef, ref: string, options: { selection?: string; error?: string; stale?: boolean } = {}): Promise<ModelPickerView> {
    const target = await this.modelTarget(entry);
    if (!target) throw new AppError('SESSION_NOT_FOUND', 'The conversation no longer exists', 404);
    const stale = options.stale ?? false;
    const catalog = await this.catalogOf(target.backendId, target.profileId, target.project, target.session, stale)
      .catch(error => { if (entry.scope === 'chat') return undefined; throw error; });
    if (!catalog?.models.length && entry.scope !== 'chat') throw new AppError('NATIVE_MODEL_UNSUPPORTED', catalog?.reason ?? 'This agent has no model list', 409);
    const backends = entry.scope === 'chat' ? await this.backendChoices(stale).catch(() => undefined) : undefined;
    const running = target.session ? this.state.deps.nativeBackends.status(target.session.id).phase === 'busy' : false;
    return buildModelView({
      ref, scope: entry.scope, backend: { id: target.backendId, name: catalog?.label ?? backends?.find(item => item.id === target.backendId)?.name ?? target.backendId },
      ...(backends?.length ? { backends } : {}),
      models: catalog?.models ?? [], selection: options.selection ?? target.selection, ...(catalog?.defaultModel ? { defaultModel: catalog.defaultModel } : {}),
      ...(entry.scope === 'session' && running ? { note: REPLY.modelNextTurn } : {}),
      ...(options.error ? { error: options.error } : {}),
    });
  }

  async askModel(m: InboundMessage, chat: ChannelChat, sessionId: string | undefined, connection: ChannelConnection): Promise<void> {
    let bound: string | undefined;
    if (sessionId) { try { bound = this.state.deps.store.getSession(sessionId).id; } catch { bound = undefined; } }
    const entry: ModelRef = { kind: 'model', account: m.account, address: m.address, anchor: m.anchor, at: Date.now(), scope: bound ? 'session' : 'chat', chat: chat.key, ...(bound ? { sessionId: bound } : {}) };
    const ref = this.state.addRef(entry);
    try {
      const view = await this.modelView(entry, ref);
      try { entry.sent = await connection.showPanel(m.address, view, m.anchor); }
      catch (error) { console.warn('[channels] model card failed', errorMessage(error)); await this.state.reply(connection, m.address, m.anchor, `${REPLY.modelUnavailable}：${view.summary}`); }
    } catch (error) {
      this.state.refs.delete(ref);
      await this.state.reply(connection, m.address, m.anchor, REPLY.failed(error instanceof AppError && error.statusCode < 500 ? error.message : REPLY.modelUnavailable));
    }
  }

  async pressModel(a: InboundAction, ref: string, entry: ModelRef): Promise<ActionReply> {
    const pending = this.settleModelPress(a, ref, entry);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([pending, new Promise<'slow'>(resolve => { timer = setTimeout(() => resolve('slow'), ANSWER_WAIT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    if (outcome !== 'slow') return outcome;
    void pending.then(async reply => {
      const connection = this.state.connectionOf(a.account);
      if (!entry.sent || !connection) return;
      try {
        const view = reply.redraw?.kind === 'model-picker' ? reply.redraw : await this.modelView(entry, ref, { stale: true, ...(reply.toast?.tone === 'error' ? { error: REPLY.failed(reply.toast.text) } : {}) });
        await connection.updatePanel(entry.sent, view);
      } catch { /* the next press redraws */ }
    });
    return { toast: { tone: 'info', text: '正在切换…' } };
  }

  private async settleModelPress(a: InboundAction, ref: string, entry: ModelRef): Promise<ActionReply> {
    const value = a.selectedIds?.[0];
    const target = await this.modelTarget(entry);
    if (!target) return { toast: { tone: 'info', text: REPLY.cardExpired } };
    if (!value) return {};
    try {
      if (a.action === 'backend') {
        if (entry.scope !== 'chat' || !(await this.backendChoices(true)).some(item => item.id === value)) return { toast: { tone: 'error', text: '这个 Agent 不可用' } };
        this.state.bindings.setChatModel(entry.chat, { backendId: value });
        return { toast: { tone: 'success', text: '已切换' }, redraw: await this.modelView(entry, ref, { stale: true }) };
      }
      const catalog = await this.catalogOf(target.backendId, target.profileId, target.project, target.session, true);
      const models = catalog.models;
      const selection = target.selection || catalog.defaultModel || '';
      const current = parseSelection(resolveCatalogSelection(models, selection) ?? selection);
      const currentModel = catalogEntry(models, current.model)?.value ?? current.model;
      let next: string | undefined;
      if (a.action === 'model') {
        if (!catalogEntry(models, value)) return { toast: { tone: 'error', text: '这个模型不可用' } };
        next = catalogSelection(models, value, current.params);
      } else if (a.action.startsWith('param:')) {
        const id = a.action.slice('param:'.length);
        next = catalogSelection(models, currentModel, { ...current.params, [id]: value }, id);
      }
      if (!next) return {};
      const view = await this.modelView(entry, ref, { selection: next, stale: true });
      const toast = { tone: 'success' as const, text: REPLY.modelSwitched(view.summary) };
      if (entry.scope === 'chat') {
        this.state.bindings.setChatModel(entry.chat, { backendId: target.backendId, model: next });
        return { toast, redraw: view };
      }
      this.applyModel(entry, ref, target.session!.id, next, a.account);
      return { toast, redraw: view };
    } catch (error) {
      return { toast: { tone: 'error', text: error instanceof AppError && error.statusCode < 500 ? error.message : REPLY.modelUnavailable } };
    }
  }

  private applyModel(entry: ModelRef, ref: string, sessionId: string, next: string, account: string): void {
    entry.pending = next;
    const run = (entry.chain ?? Promise.resolve()).then(() => configureNative(this.state.deps, sessionId, { model: next }));
    entry.chain = run.then(() => undefined, () => undefined);
    void run.then(() => {
      if (entry.pending === next) entry.pending = undefined;
      this.state.changed();
    }, async (error: unknown) => {
      const latest = entry.pending === next;
      if (latest) entry.pending = undefined;
      const text = REPLY.failed(error instanceof AppError && error.statusCode < 500 ? error.message : '服务暂时不可用');
      const connection = this.state.connectionOf(account);
      if (latest && entry.sent && connection) {
        try { await connection.updatePanel(entry.sent, await this.modelView(entry, ref, { error: text, stale: true })); } catch { /* the notice below still tells */ }
      }
      this.state.notify(sessionId, text);
    });
  }
}
