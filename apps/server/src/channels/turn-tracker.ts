import type { NativeInteraction, NativeStatus, Run } from '../../../../packages/contracts/src/index.js';
import type { ChannelCardOptions } from '../../../../packages/contracts/src/channels.js';
import { mergeCard } from './bindings.js';
import { followSession } from './follow.js';
import { isTerminalRun, projectTurn } from './projector.js';
import type { ChannelModelPicker } from './model-picker.js';
import {
  errorMessage, MIB, MODEL_NAMES_FINAL_WAIT_MS, PERSIST_EVERY_MS, PUSH_DELAY_MS,
  type ChannelSharedState, type SessionFollow, type Tracker,
} from './shared.js';
import type { ChannelAddress, ChannelConnection, InteractionView, ReplyAnchor, TurnSurface, TurnView } from './types.js';

export class ChannelTurnTracker {
  constructor(
    private readonly state: ChannelSharedState,
    private readonly models: ChannelModelPicker,
  ) {}

  private cardOf(accountId: string): ChannelCardOptions {
    return mergeCard(this.state.bindings.accounts().find(item => item.id === accountId)?.card);
  }

  runChanged(run: Run): void {
    if (this.state.isClosed()) return;
    const tracker = this.state.trackers.get(run.id);
    if (tracker) { if (isTerminalRun(run)) void this.finalize(tracker); else this.schedule(tracker); return; }
    if (!isTerminalRun(run)) this.track(run);
  }

  track(run: Run, resumed?: { surface: TurnSurface; address: ChannelAddress; anchor?: ReplyAnchor; source: TurnView['source'] }): Tracker | undefined {
    if (this.state.trackers.has(run.id)) return this.state.trackers.get(run.id);
    const address = resumed?.address ?? this.state.bindings.addressOf(run.sessionId);
    const runtime = address && this.state.runtimes.get(address.account);
    if (!address || !runtime) return undefined;
    if (!resumed && !runtime.resumed) { runtime.pending.add(run.id); return undefined; }
    const own = this.state.anchors.get(run.commandId);
    this.state.anchors.delete(run.commandId);
    const source = resumed?.source ?? (own ? 'channel' : 'other-client');
    const anchor = resumed ? resumed.anchor : own ?? this.state.threadAnchor(run.sessionId, address);
    const stopRef = this.state.addRef({ kind: 'stop', account: address.account, sessionId: run.sessionId, runId: run.id });
    const tracker: Tracker = { runId: run.id, sessionId: run.sessionId, commandId: run.commandId, address, source, ...(anchor ? { anchor } : {}), ...(resumed ? { surface: resumed.surface } : {}), finishing: false, stopRef };
    this.state.trackers.set(run.id, tracker);
    if (!isTerminalRun(run)) this.hold(tracker);
    this.schedule(tracker);
    return tracker;
  }

  trackPending(runId: string): void {
    let run: Run;
    try { run = this.state.deps.store.getRun(runId); } catch { return; }
    const tracker = this.track(run);
    if (tracker && isTerminalRun(run)) void this.finalize(tracker);
  }

  scheduleForSession(sessionId: string): void {
    for (const tracker of this.state.trackers.values()) if (tracker.sessionId === sessionId) this.schedule(tracker);
  }

  private hold(tracker: Tracker): void {
    let follow = this.state.follows.get(tracker.sessionId);
    if (!follow) {
      const created: SessionFollow = {
        sessionId: tracker.sessionId, trackers: new Set(), waiting: false, answered: new Set(), chain: Promise.resolve(),
        following: followSession({ ingest: this.state.deps.ingest, timeline: this.state.deps.timeline, control: (id, listener) => this.state.deps.nativeBackends.watchControl(id, listener) }, tracker.sessionId, {
          rows: () => { for (const id of created.trackers) { const item = this.state.trackers.get(id); if (item) this.schedule(item); } },
          status: status => this.onStatus(created, status),
          context: context => {
            const percent = context && context.size > 0 ? Math.max(0, Math.min(100, Math.round(context.used / context.size * 100))) : undefined;
            if (percent === created.contextPercent) return;
            created.contextPercent = percent;
            for (const id of created.trackers) { const item = this.state.trackers.get(id); if (item) this.schedule(item); }
          },
          controlFailed: error => console.warn('[channels] following without live status', errorMessage(error)),
        }),
      };
      this.state.follows.set(tracker.sessionId, follow = created);
    }
    follow.trackers.add(tracker.runId);
  }

  private onStatus(follow: SessionFollow, status: NativeStatus): void {
    follow.waiting = Boolean(status.interaction);
    for (const id of follow.trackers) { const tracker = this.state.trackers.get(id); if (tracker) this.schedule(tracker); }
    this.syncInteraction(follow, status.interaction);
  }

  private schedule(tracker: Tracker): void {
    if (tracker.finishing || tracker.timer) return;
    tracker.timer = setTimeout(() => { tracker.timer = undefined; void this.push(tracker); }, PUSH_DELAY_MS);
    tracker.timer.unref?.();
  }

  private viewOf(tracker: Tracker, final = false): TurnView {
    const { store, timeline } = this.state.deps;
    const run = store.getRun(tracker.runId);
    const session = store.getSession(tracker.sessionId);
    const turn = timeline.outline(session.id, 'main', 10).turns.find(item => item.runId === run.id);
    const rows = turn ? timeline.page(session.id, 'main', { from: turn.startPos, rows: 500, bytes: MIB }).rows.filter(row => row.turn === turn.turn) : [];
    const finalAnswer = final && turn && run.state === 'completed' ? timeline.turnText(session.id, turn.turn)?.answer : undefined;
    const modelName = this.models.modelName(session);
    const models = this.models.modelEntry(session)?.models;
    const contextPercent = this.state.follows.get(session.id)?.contextPercent;
    return projectTurn({ session, run, rows, source: tracker.source, root: this.state.projectOf(session.projectId)?.cwd, waiting: this.state.follows.get(session.id)?.waiting, stopRef: tracker.stopRef, card: this.cardOf(tracker.address.account), ...(modelName ? { modelName } : {}), ...(models?.length ? { models } : {}), ...(contextPercent !== undefined ? { contextPercent } : {}), ...(finalAnswer ? { finalAnswer } : {}) });
  }

  private ensureSurface(tracker: Tracker, view: TurnView): Promise<TurnSurface | undefined> {
    if (tracker.surface) return Promise.resolve(tracker.surface);
    const connection = this.state.connectionOf(tracker.address.account);
    if (!connection) return Promise.resolve(undefined);
    tracker.opening ??= connection.openTurn(tracker.address, view, tracker.anchor).then(surface => { tracker.surface = surface; return surface; }, error => {
      console.warn('[channels] could not open the turn card', errorMessage(error));
      tracker.opening = undefined;
      return undefined;
    });
    return tracker.opening;
  }

  private persist(tracker: Tracker, surface: TurnSurface, force = false): void {
    const state = surface.state();
    const json = JSON.stringify(state);
    if (json === tracker.persisted) return;
    const cot = state.data.cot as { messageId?: unknown } | undefined;
    const ids = JSON.stringify([state.data.messageId, state.data.extra, cot?.messageId]);
    const now = Date.now();
    const idsMoved = tracker.persisted === undefined || ids !== tracker.persistedIds;
    if (!force && !idsMoved && now - (tracker.persistedAt ?? 0) < PERSIST_EVERY_MS) return;
    tracker.persisted = json;
    tracker.persistedAt = now;
    tracker.persistedIds = ids;
    this.state.bindings.setSurface({ account: tracker.address.account, address: tracker.address, sessionId: tracker.sessionId, runId: tracker.runId, source: tracker.source, ...(tracker.anchor ? { anchor: tracker.anchor } : {}), state });
  }

  private async push(tracker: Tracker): Promise<void> {
    if (tracker.finishing) return;
    let view: TurnView;
    try { view = this.viewOf(tracker); } catch { return; }
    const surface = await this.ensureSurface(tracker, view);
    if (!surface || tracker.finishing) return;
    surface.update(view);
    this.persist(tracker, surface);
  }

  private async finalize(tracker: Tracker): Promise<void> {
    if (tracker.finishing) return;
    tracker.finishing = true;
    clearTimeout(tracker.timer);
    const connection = this.state.connectionOf(tracker.address.account);
    try {
      await this.state.deps.ingest.read(tracker.sessionId)?.catch(() => undefined);
      await this.state.deps.timeline.ready(tracker.sessionId, 'main').catch(() => undefined);
      try {
        const loading = this.models.modelEntry(this.state.deps.store.getSession(tracker.sessionId))?.loading;
        if (loading) {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([loading, new Promise<void>(resolve => { timer = setTimeout(resolve, MODEL_NAMES_FINAL_WAIT_MS); timer.unref?.(); })]);
          clearTimeout(timer);
        }
      } catch { /* the session is gone; the lost view follows */ }
      let view: TurnView;
      try { view = this.viewOf(tracker, true); } catch { view = this.lostView(tracker); }
      const surface = await this.ensureSurface(tracker, view);
      if (surface) await surface.finish(view);
      else if (connection && (view.answer || view.error)) await connection.send(tracker.address, view.answer || view.error!, tracker.anchor).catch(() => undefined);
      if (surface || connection) this.state.bindings.removeSurface(tracker.runId);
      if (tracker.anchor && tracker.source === 'channel') void connection?.acknowledge(tracker.anchor, view.status === 'completed' ? 'done' : 'failed').catch(() => undefined);
    } catch (error) {
      console.warn('[channels] could not finish the turn card', errorMessage(error));
    } finally {
      this.release(tracker);
    }
  }

  private lostView(tracker: Pick<Tracker, 'sessionId' | 'runId' | 'source' | 'address'>): TurnView {
    return { sessionId: tracker.sessionId, runId: tracker.runId, title: '会话', status: 'interrupted', source: tracker.source, steps: [], answer: '', error: '会话已不存在', card: this.cardOf(tracker.address.account), footer: {} };
  }

  private release(tracker: Tracker): void {
    this.state.trackers.delete(tracker.runId);
    this.state.refs.delete(tracker.stopRef);
    const follow = this.state.follows.get(tracker.sessionId);
    if (!follow) return;
    follow.trackers.delete(tracker.runId);
    if (follow.trackers.size) return;
    this.state.follows.delete(tracker.sessionId);
    follow.chain = follow.chain.then(() => this.closeShown(follow, 'cancelled')).catch(() => undefined).finally(() => follow.following.close());
  }

  syncInteraction(follow: SessionFollow, next: NativeInteraction | undefined): void {
    follow.chain = follow.chain.then(() => this.drawInteraction(follow, next)).catch(error => console.warn('[channels] interaction card failed', errorMessage(error)));
  }

  interactionView(interaction: NativeInteraction, ref: string, closed?: InteractionView['closed']): InteractionView {
    return { kind: 'interaction', interaction, ref, ...(closed ? { closed } : {}) };
  }

  private async drawInteraction(follow: SessionFollow, next: NativeInteraction | undefined): Promise<void> {
    const address = this.state.bindings.addressOf(follow.sessionId);
    const connection = address && this.state.connectionOf(address.account);
    if (!address || !connection) return;
    const shown = follow.shown;
    if (shown && next && shown.interaction.id === next.id) {
      if (shown.interaction.revision === next.revision) return;
      const ref = this.state.addRef({ kind: 'interaction', account: address.account, sessionId: follow.sessionId, interactionId: next.id, revision: next.revision });
      shown.interaction = next;
      shown.ref = ref;
      shown.refs.push(ref);
      await connection.updateInteraction(shown.sent, this.interactionView(next, ref));
      return;
    }
    if (shown) await this.closeShown(follow, [...follow.answered].some(key => key.startsWith(`${shown.interaction.id}\n`)) ? 'answered' : 'answered-elsewhere');
    if (!next) return;
    const ref = this.state.addRef({ kind: 'interaction', account: address.account, sessionId: follow.sessionId, interactionId: next.id, revision: next.revision });
    const anchor = [...follow.trackers].map(id => this.state.trackers.get(id)?.anchor).findLast(Boolean) ?? this.state.threadAnchor(follow.sessionId, address);
    follow.shown = { ref, refs: [ref], interaction: next, sent: await connection.showInteraction(address, this.interactionView(next, ref), anchor) };
  }

  private async closeShown(follow: SessionFollow, outcome: NonNullable<InteractionView['closed']>['outcome']): Promise<void> {
    const shown = follow.shown;
    if (!shown) return;
    follow.shown = undefined;
    for (const ref of shown.refs) this.state.refs.delete(ref);
    const address = this.state.bindings.addressOf(follow.sessionId);
    const connection = address && this.state.connectionOf(address.account);
    if (connection) await connection.updateInteraction(shown.sent, this.interactionView(shown.interaction, shown.ref, { outcome })).catch(() => undefined);
  }

  async resume(account: string, connection: ChannelConnection): Promise<void> {
    for (const record of this.state.bindings.surfaces().filter(item => item.address.account === account)) {
      const existing = this.state.trackers.get(record.runId);
      if (existing?.surface || existing?.opening) continue;
      const surface = await connection.resumeTurn(record.address, record.state).catch(() => undefined);
      if (!surface) { this.state.bindings.removeSurface(record.runId); continue; }
      let run: Run | undefined;
      try { run = this.state.deps.store.getRun(record.runId); } catch { run = undefined; }
      if (!run) {
        await surface.finish({ sessionId: record.sessionId, runId: record.runId, title: '会话', status: 'interrupted', source: record.source, steps: [], answer: '', error: '会话已不存在', card: this.cardOf(record.address.account), footer: {} }).catch(() => undefined);
        this.state.bindings.removeSurface(record.runId);
        continue;
      }
      const tracker = this.state.trackers.get(record.runId) ?? this.track(run, { surface, address: record.address, source: record.source, ...(record.anchor ? { anchor: record.anchor } : {}) });
      if (!tracker) { await surface.finish(this.lostView(record)).catch(() => undefined); this.state.bindings.removeSurface(record.runId); continue; }
      if (!tracker.surface) tracker.surface = surface;
      if (isTerminalRun(run)) await this.finalize(tracker);
    }
  }
}
