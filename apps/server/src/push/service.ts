import { createHash } from 'node:crypto';
import { CLIENT_FEATURES_HEADER, type DevicePlatform, type DevicePushRegistration, type DevicePushRoute, type NativeInteraction, type Session, type SessionState } from '../../../../packages/contracts/src/index.js';
import { isDoneUnseen, isRunningSession, needsYou } from '../../../../packages/contracts/src/session-attention.js';
import type { Auth } from '../auth.js';
import { withoutQuickChats } from '../chat/quick-chat.js';
import { sessionVisibleToClient } from '../native/client-features.js';
import type { DeviceChannel } from '../riffet-mcp/devices.js';
import type { Store } from '../store.js';
import type { ApnsClient, ApnsMessage } from './apns.js';

export type SessionAlertKind = 'finished' | 'waiting' | 'failed' | 'interrupted' | 'notice';

const ACTIVE: ReadonlySet<SessionState> = new Set(['running', 'starting', 'cancelling', 'waiting']);

/**
 * The clients' rule (`sessionAlerts` in the Kotlin `SessionActivity.kt`, the web's `noticeBackground`): a
 * conversation is reported when its state *moved* to one the reader acts on. A first sighting is not a
 * transition, so a restarted server does not announce what finished while it was down.
 */
export function sessionAlerts(previous: ReadonlyMap<string, SessionState>, incoming: readonly Session[]): Array<{ session: Session; kind: SessionAlertKind }> {
  const alerts: Array<{ session: Session; kind: SessionAlertKind }> = [];
  for (const session of incoming) {
    const before = previous.get(session.id);
    if (before === undefined || before === session.state || session.archivedAt) continue;
    const wasRunning = ACTIVE.has(before);
    const kind: SessionAlertKind | undefined = session.state === 'waiting' ? 'waiting'
      : session.state === 'failed' ? 'failed'
        : session.state === 'interrupted' && wasRunning ? 'interrupted'
          : session.state === 'idle' && wasRunning ? 'finished' : undefined;
    if (kind) alerts.push({ session, kind });
  }
  return alerts;
}

/**
 * Whether the owner has read the conversation since its last activity. Unlike the Unread filter, a
 * conversation without `seenActivityAt` (older than read state) counts as unseen here: a push is still due.
 */
export function seenSinceActivity(session: Pick<Session, 'seenActivityAt' | 'lastActivityAt' | 'createdAt'>): boolean {
  if (!session.seenActivityAt) return false;
  return Date.parse(session.seenActivityAt) >= Date.parse(session.lastActivityAt ?? session.createdAt);
}

/** The summary Live Activity's `content-state`; titles never leave the server. */
export interface ActivityCounts { waiting: number; running: number; unseen: number }
export function activityCounts(sessions: readonly Session[]): ActivityCounts {
  const live = sessions.filter(session => !session.archivedAt);
  return { waiting: live.filter(needsYou).length, running: live.filter(isRunningSession).length, unseen: live.filter(isDoneUnseen).length };
}
const zero = (counts: ActivityCounts) => !counts.waiting && !counts.running && !counts.unseen;
const same = (a: ActivityCounts | undefined, b: ActivityCounts) => Boolean(a) && a!.waiting === b.waiting && a!.running === b.running && a!.unseen === b.unseen;

/** One answer a notification button sends as `NativeInteractionResponse` (the device adds `requestId`). */
export interface PushAnswer { action: string; selectedIds?: string[]; text?: true }
const SELECTING = new Set(['answer', 'submit']);
const selectsOptions = (interaction: NativeInteraction) => (interaction.options.length > 0 || interaction.allowOther === true) && interaction.actions.some(action => SELECTING.has(action.id));

/**
 * The fixed notification category a waiting push uses, and what each of its buttons answers. Buttons are
 * offered only when they can answer honestly (the clients' `interactionChoices`): a dialog whose allow and
 * deny cannot both be told apart, a multi-select or a question group opens the app instead.
 */
export function interactionCategory(interaction: NativeInteraction | undefined): { category: string; answers?: Record<string, PushAnswer> } {
  if (!interaction) return { category: 'riffet.question' };
  const selecting = selectsOptions(interaction);
  const submit = interaction.actions.find(action => SELECTING.has(action.id));
  const plain = (action: { id: string } | undefined): PushAnswer | undefined => action && { action: action.id };
  if (interaction.kind === 'permission' && !selecting) {
    const allow = interaction.actions.find(action => action.tone === 'primary') ?? interaction.actions.find(action => action.tone !== 'danger');
    const deny = interaction.actions.find(action => action.tone === 'danger');
    if (allow && deny && allow !== deny) return { category: 'riffet.permission', answers: { 'riffet.allow': plain(allow)!, 'riffet.deny': plain(deny)! } };
  }
  if (interaction.kind === 'plan') {
    let approve: PushAnswer | undefined;
    if (selecting) {
      const option = interaction.options.find(item => item.selected) ?? interaction.options[0];
      if (interaction.multiple !== true && submit && option) approve = { action: submit.id, selectedIds: [option.id] };
    } else approve = plain(interaction.actions.find(action => action.tone === 'primary') ?? interaction.actions.find(action => action.tone !== 'danger'));
    if (approve) return { category: 'riffet.plan', answers: { 'riffet.approve': approve } };
  }
  // Typed text answers a single free-text question; the next one of a group would need the app anyway.
  if (selecting && submit && interaction.allowOther === true && interaction.multiple !== true && (interaction.questionCount ?? 1) <= 1) {
    return { category: 'riffet.question.reply', answers: { 'riffet.reply': { action: submit.id, text: true } } };
  }
  return { category: 'riffet.question' };
}

/** Markdown reduced to one line of text for a notification body. */
export function plainSummary(text: string, limit = 600): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...plain];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : plain;
}

export interface PushTiming {
  /** A finished, failed or interrupted push waits this long, in case the owner reads it first. */
  finishedDelayMs?: number;
  /** Live Activity updates to one device are at least this far apart. */
  activityCoalesceMs?: number;
  /** The summary activity ends after every count stayed zero this long. */
  activityEndMs?: number;
  /** A device is asked to start the summary activity at most this often: its start token may be stale. */
  activityStartMs?: number;
  /** A waiting session whose dialog is not readable yet is looked at once more after this. */
  interactionRetryMs?: number;
  /** Bursts of list changes are read once. */
  debounceMs?: number;
}

export interface PushServiceDeps {
  /** `/health`'s `serverId`, the pushes' `server`: stable across restarts. */
  serverId: string;
  store: Pick<Store, 'listSessions' | 'getSession' | 'getProject' | 'onListsChanged'>;
  auth: Pick<Auth, 'listDevices' | 'devicePush' | 'clearDevicePush' | 'deviceFeatures'>;
  devices: Pick<DeviceChannel, 'online' | 'onChange' | 'pushRouteChanged'>;
  apns: Pick<ApnsClient, 'configured' | 'status' | 'send'>;
  interaction: (session: Session) => Promise<NativeInteraction | undefined>;
  latestReply?: (sessionId: string) => Promise<string | undefined>;
  timing?: PushTiming;
}

interface DeviceActivity {
  /** What this device's lists count now. */
  counts?: ActivityCounts;
  sent?: ActivityCounts; sentAt: number; timer?: NodeJS.Timeout;
  endTimer?: NodeJS.Timeout; startedAt?: number;
  /** The token of the activity this server ended; the device may report it once more before it is gone. */
  ended?: string;
}

/** At most this many waiting pushes are remembered for de-duplication. */
const SENT_LIMIT = 500;
/** A waiting push that reached no device is tried again no sooner than this. */
const WAITING_RETRY_MS = 30_000;

/**
 * Background pushes to iOS devices (docs/DEVICES.md §3「后台推送」): session alerts straight to APNs with the
 * owner's key, and one summary Live Activity per device. A device whose stream is open is in the foreground
 * and notifies itself; it gets no alert push. Nothing is withdrawn when a dialog is answered elsewhere.
 */
export class PushService {
  private previous = new Map<string, SessionState>();
  private readonly finished = new Map<string, NodeJS.Timeout>();
  private readonly sentWaiting = new Set<string>();
  /** Waiting questions being sent (`Infinity`) or whose send reached no device (retry not before this time). */
  private readonly waitingBlockedUntil = new Map<string, number>();
  /** What the last scan saw that can change an alert or a count; an unchanged scan does nothing. */
  private scanSignature?: string;
  private readonly activities = new Map<string, DeviceActivity>();
  private readonly failures = new Map<string, string>();
  private scanTimer?: NodeJS.Timeout;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly timing: Required<PushTiming>;
  private closed = false;

  constructor(private readonly deps: PushServiceDeps) {
    this.timing = { finishedDelayMs: 60_000, activityCoalesceMs: 5_000, activityEndMs: 10 * 60_000, activityStartMs: 10 * 60_000, interactionRetryMs: 1_000, debounceMs: 100, ...deps.timing };
    this.previous = new Map(deps.store.listSessions().map(session => [session.id, session.state]));
    this.unsubscribe.push(deps.store.onListsChanged(() => this.schedule()), deps.devices.onChange(() => this.schedule()));
  }

  close(): void {
    this.closed = true;
    for (const off of this.unsubscribe) off();
    for (const timer of this.finished.values()) clearTimeout(timer);
    for (const activity of this.activities.values()) { clearTimeout(activity.timer); clearTimeout(activity.endTimer); }
    clearTimeout(this.scanTimer);
  }

  /** `DeviceInfo.push`: only for iOS devices and devices that registered. */
  route(deviceId: string, platform?: DevicePlatform): DevicePushRoute | undefined {
    const registration = this.deps.auth.devicePush(deviceId);
    if (!registration && platform !== 'ios') return undefined;
    if (!this.deps.apns.configured()) return { route: 'none', reason: 'no_key' };
    if (!registration) return { route: 'none', reason: 'no_token' };
    const failure = this.failures.get(deviceId) ?? (this.deps.apns.status().status === 'invalid' ? this.deps.apns.status().detail : undefined);
    return failure ? { route: 'none', reason: 'failed', detail: failure } : { route: 'direct' };
  }

  /** The key changed: earlier failures said nothing about the new one. */
  keyChanged(): void {
    this.failures.clear();
    this.deps.devices.pushRouteChanged();
  }

  private schedule(): void {
    if (this.closed || this.scanTimer) return;
    this.scanTimer = setTimeout(() => { this.scanTimer = undefined; this.scan(); }, this.timing.debounceMs);
    this.scanTimer.unref();
  }

  /** Reads the list once: alerts for the transitions since the last read, and the activity counts. */
  scan(): void {
    if (this.closed) return;
    const sessions = this.deps.store.listSessions();
    const signature = this.signature(sessions);
    if (signature === this.scanSignature) return;
    this.scanSignature = signature;
    const alerts = sessionAlerts(this.previous, sessions);
    this.previous = new Map(sessions.map(session => [session.id, session.state]));
    if (this.deps.apns.configured()) {
      for (const { session, kind } of alerts) {
        if (kind === 'waiting') void this.sendWaiting(session.id);
        else this.scheduleDone(session, kind);
      }
    }
    this.updateActivities(sessions);
  }

  /** Only fields that move an alert, a count or what a device lists: a running session's `lastActivityAt` does not. */
  private signature(sessions: readonly Session[]): string {
    const parts: string[] = [String(this.deps.apns.configured())];
    for (const session of sessions) parts.push(`${session.id}|${session.state}|${session.archivedAt ?? ''}|${session.projectId}|${session.backendId ?? ''}|${isDoneUnseen(session) ? 1 : 0}`);
    for (const device of this.deps.auth.listDevices()) {
      const push = this.deps.auth.devicePush(device.id);
      parts.push(`${device.id}|${push ? `${push.token ?? ''}|${push.activityToken ?? ''}|${push.activityStartToken ?? ''}|${push.environment ?? ''}` : ''}|${(this.deps.auth.deviceFeatures(device.id) ?? []).join(',')}|${this.deps.devices.online(device.id) ? 1 : 0}`);
    }
    return parts.join('\n');
  }

  /**
   * What the device's conversation list shows: `GET /api/sessions` with the client features it last reported.
   * A device that never reported them is an old client and sees neither quick chats nor negotiated backends.
   */
  private listedFor(deviceId: string, sessions: readonly Session[]): Session[] {
    const request = { headers: { [CLIENT_FEATURES_HEADER]: (this.deps.auth.deviceFeatures(deviceId) ?? []).join(',') } };
    const getProject = (id: string) => this.deps.store.getProject(id);
    // The 助理's background runs are its own work, not the owner's conversations (docs/ASSISTANT.md §7.1).
    return withoutQuickChats(sessions, request).filter(session => {
      if (session.origin?.kind === 'assistant' || session.origin?.kind === 'council') return false;
      try { return sessionVisibleToClient(request.headers, session, getProject); } catch { return false; }
    });
  }

  /** Registered devices that are not in the foreground right now. */
  private background(): Array<{ id: string; push: DevicePushRegistration }> {
    return this.deps.auth.listDevices().flatMap(device => {
      const push = this.deps.auth.devicePush(device.id);
      return push && !this.deps.devices.online(device.id) ? [{ id: device.id, push }] : [];
    });
  }

  private session(id: string): Session | undefined { try { return this.deps.store.getSession(id); } catch { return undefined; } }
  private projectName(session: Session): string | undefined { try { return this.deps.store.getProject(session.projectId).name; } catch { return undefined; } }

  // ---- Alerts ------------------------------------------------------------------------------

  private async sendWaiting(sessionId: string): Promise<void> {
    const read = async () => {
      const session = this.session(sessionId);
      if (!session || session.kind !== 'native') return undefined;
      try { return await this.deps.interaction(session); } catch { return undefined; }
    };
    let interaction = await read(), key: string | undefined;
    // The state can flip before the dialog is readable; one more look before falling back to "open".
    if (!interaction) { await new Promise(resolve => setTimeout(resolve, this.timing.interactionRetryMs).unref()); interaction = await read(); }
    const session = this.session(sessionId);
    if (this.closed || !session || session.state !== 'waiting' || session.archivedAt) return;
    // A CLI that redraws the same dialog flickers through another state; the same question is not pushed twice.
    if (interaction) {
      key = `${sessionId}\n${interaction.id}\n${interaction.revision}`;
      if (this.sentWaiting.has(key) || (this.waitingBlockedUntil.get(key) ?? 0) > Date.now()) return;
      this.waitingBlockedUntil.set(key, Infinity);
    }
    const { category, answers } = interactionCategory(interaction);
    const text = interaction ? [interaction.title, interaction.message].filter(Boolean).join(' · ') : '';
    const expiresAt = interaction?.expiresAt ? Math.floor(Date.parse(interaction.expiresAt) / 1000) : undefined;
    const outcome = await this.alert(session, 'waiting', {
      category, body: text ? plainSummary(text) : undefined, timeSensitive: true,
      expiration: expiresAt && Number.isFinite(expiresAt) ? Math.min(expiresAt, this.dayAhead()) : this.dayAhead(),
      info: { ...(interaction ? { interactionId: interaction.id, revision: interaction.revision, interactionKind: interaction.kind } : {}), ...(answers ? { answers } : {}) },
    });
    if (!key) return;
    // Recorded as sent only once a device took it. A total failure retries on the next redraw, not sooner than a backoff;
    // with no device to send to nothing is recorded, so a device registered later can still get the question.
    if (outcome.delivered) {
      this.waitingBlockedUntil.delete(key);
      this.sentWaiting.add(key);
      if (this.sentWaiting.size > SENT_LIMIT) this.sentWaiting.delete(this.sentWaiting.values().next().value!);
    } else if (outcome.attempted) {
      this.waitingBlockedUntil.set(key, Date.now() + WAITING_RETRY_MS);
      if (this.waitingBlockedUntil.size > SENT_LIMIT) this.waitingBlockedUntil.delete(this.waitingBlockedUntil.keys().next().value!);
    } else this.waitingBlockedUntil.delete(key);
  }

  /** Finished, failed and interrupted wait a minute: read by then, or moved on, it is not sent. */
  private scheduleDone(session: Session, kind: Exclude<SessionAlertKind, 'waiting'>): void {
    clearTimeout(this.finished.get(session.id));
    const state = session.state;
    const timer = setTimeout(() => {
      this.finished.delete(session.id);
      void this.sendDone(session.id, kind, state);
    }, this.timing.finishedDelayMs);
    timer.unref();
    this.finished.set(session.id, timer);
  }

  private async sendDone(sessionId: string, kind: Exclude<SessionAlertKind, 'waiting'>, state: SessionState): Promise<void> {
    const session = this.session(sessionId);
    if (this.closed || !session || session.archivedAt || session.state !== state || seenSinceActivity(session)) return;
    let body: string | undefined;
    if (kind === 'failed') body = session.error;
    if (kind === 'finished' && this.deps.latestReply) {
      try { body = await Promise.race([this.deps.latestReply(sessionId), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5_000).unref())]); } catch { body = undefined; }
    }
    // Read while the reply was being looked up.
    const current = this.session(sessionId);
    if (!current || current.state !== state || seenSinceActivity(current)) return;
    await this.alert(current, kind, {
      ...(kind === 'finished' ? { category: 'riffet.finished' } : {}),
      body: body ? plainSummary(body) : undefined, expiration: this.dayAhead(),
      info: kind === 'finished' ? { configRevision: current.configRevision ?? 0 } : {},
    });
  }

  /**
   * Something the 助理 says the owner should know now (docs/ASSISTANT.md §7.1), as an alert in [sessionId], its main
   * conversation. True when a device took it, or when there is no device it could reach.
   */
  async notice(sessionId: string, body: string, key: string): Promise<boolean> {
    const session = this.session(sessionId);
    if (this.closed || !session || !this.deps.apns.configured()) return true;
    const outcome = await this.alert(session, 'notice', { body: plainSummary(body), timeSensitive: true, expiration: this.dayAhead(), info: { notice: key } });
    return outcome.delivered || !outcome.attempted;
  }

  /**
   * A plugin asked the owner to approve something (docs/TASK-BOARD.md §7): an alert for the new inbox item, to the devices
   * that are not in the foreground. It belongs to no conversation, so there is no thread or session to open. Deciding stays
   * in the app; nothing is withdrawn from the lock screen when it is decided elsewhere.
   */
  async approval(approval: { pluginId: string; id: string; pluginName: string; title: string; body: string; expiresAt?: string }): Promise<boolean> {
    if (this.closed || !this.deps.apns.configured()) return true;
    const expiresAt = approval.expiresAt ? Math.floor(Date.parse(approval.expiresAt) / 1000) : undefined;
    const expiration = expiresAt && Number.isFinite(expiresAt) ? Math.min(expiresAt, this.dayAhead()) : this.dayAhead();
    const key = `${approval.pluginId}/${approval.id}`;
    const results = await Promise.all(this.background().map(device => this.deliver(device, 'token', {
      topic: device.push.topic, pushType: 'alert', priority: 10, collapseId: createHash('sha1').update(key).digest('hex').slice(0, 32), expiration,
      payload: {
        aps: {
          alert: { title: approval.title, subtitle: approval.pluginName, ...(approval.body ? { body: plainSummary(approval.body) } : {}) },
          sound: 'default', 'thread-id': 'riffet.approvals', 'interruption-level': 'time-sensitive',
        },
        server: this.deps.serverId, kind: 'approval', approval: key,
      },
    })));
    return results.length === 0 || results.some(Boolean);
  }

  /**
   * A device was paired or a server linked (docs/TRANSPORT-SECURITY.md §7). Every registered device hears of it, in the
   * foreground too, so one the owner did not add is noticed; [except] is the new device itself. The name is the body,
   * the app words the title (`push.device-paired`, `push.link-added`).
   */
  async security(event: { kind: 'device-paired' | 'link-added'; name: string; except?: string }): Promise<void> {
    if (this.closed || !this.deps.apns.configured()) return;
    const devices = this.deps.auth.listDevices().flatMap(device => {
      const push = device.id === event.except ? undefined : this.deps.auth.devicePush(device.id);
      return push ? [{ id: device.id, push }] : [];
    });
    await Promise.all(devices.map(device => this.deliver(device, 'token', {
      topic: device.push.topic, pushType: 'alert', priority: 10, expiration: this.dayAhead(),
      payload: {
        aps: { alert: { 'title-loc-key': `push.${event.kind}`, body: event.name }, sound: 'default', 'thread-id': 'riffet.security' },
        server: this.deps.serverId, kind: 'security',
      },
    })));
  }

  private dayAhead(): number { return Math.floor(Date.now() / 1000) + 24 * 60 * 60; }

  private async alert(session: Session, kind: SessionAlertKind, options: { category?: string; body?: string; timeSensitive?: boolean; expiration: number; info: Record<string, unknown> }): Promise<{ attempted: number; delivered: boolean }> {
    const subtitle = this.projectName(session);
    const results = await Promise.all(this.background().filter(device => this.listedFor(device.id, [session]).length).map(async device => {
      const payload: Record<string, unknown> = {
        aps: {
          alert: {
            title: session.displayTitle || session.title || 'Riffet',
            ...(subtitle ? { subtitle } : {}),
            // Without text of its own, the app words the kind (`push.waiting`, `push.finished`, …).
            ...(options.body ? { body: options.body } : { 'loc-key': `push.${kind}` }),
          },
          sound: 'default',
          'thread-id': session.id,
          ...(options.category ? { category: options.category } : {}),
          ...(options.timeSensitive ? { 'interruption-level': 'time-sensitive' } : {}),
        },
        server: this.deps.serverId, sessionId: session.id, kind, ...options.info,
      };
      return await this.deliver(device, 'token', { topic: device.push.topic, pushType: 'alert', priority: 10, collapseId: `${session.id}:${kind}`, expiration: options.expiration, payload });
    }));
    return { attempted: results.length, delivered: results.some(Boolean) };
  }

  /** Sends one push and keeps the device's route current: a gone token is forgotten, a failure remembered. */
  private async deliver(device: { id: string; push: DevicePushRegistration }, field: 'token' | 'activityStartToken' | 'activityToken', message: ApnsMessage): Promise<boolean> {
    const token = device.push[field];
    if (!token) return false;
    const outcome = await this.deps.apns.send({ environment: device.push.environment, token }, message);
    const before = this.failures.get(device.id);
    if (outcome.ok) this.failures.delete(device.id);
    else if (outcome.gone) {
      if (this.deps.auth.clearDevicePush(device.id, field, token) && field === 'token') this.failures.delete(device.id);
    } else this.failures.set(device.id, outcome.reason);
    if (before !== this.failures.get(device.id) || (!outcome.ok && outcome.gone)) this.deps.devices.pushRouteChanged();
    return outcome.ok;
  }

  // ---- Live Activity -----------------------------------------------------------------------

  private activity(deviceId: string): DeviceActivity {
    let activity = this.activities.get(deviceId);
    if (!activity) { activity = { sentAt: 0 }; this.activities.set(deviceId, activity); }
    return activity;
  }

  /** A running activity this server has not ended; an ended one's token is not updated again. */
  private liveToken(deviceId: string, push: DevicePushRegistration): string | undefined {
    const token = push.activityToken;
    return token && token !== this.activities.get(deviceId)?.ended ? token : undefined;
  }

  /**
   * Each device counts what its own lists show. A device with something to show and no running activity is
   * asked to start one, whether or not the counts just left zero (it may have dismissed or missed the last).
   */
  private updateActivities(sessions: readonly Session[]): void {
    if (!this.deps.apns.configured()) return;
    for (const device of this.deps.auth.listDevices()) {
      const push = this.deps.auth.devicePush(device.id);
      if (!push) continue;
      const activity = this.activity(device.id);
      const counts = activityCounts(this.listedFor(device.id, sessions));
      activity.counts = counts;
      if (zero(counts)) {
        if (!activity.endTimer) {
          activity.endTimer = setTimeout(() => { activity.endTimer = undefined; void this.endActivity(device.id); }, this.timing.activityEndMs);
          activity.endTimer.unref();
        }
      } else { clearTimeout(activity.endTimer); activity.endTimer = undefined; }
      if (this.liveToken(device.id, push)) this.scheduleUpdate(device.id);
      else if (!zero(counts) && push.activityStartToken && (activity.startedAt === undefined || Date.now() - activity.startedAt >= this.timing.activityStartMs)) {
        void this.startActivity({ id: device.id, push }, counts);
      }
    }
  }

  private async startActivity(device: { id: string; push: DevicePushRegistration }, counts: ActivityCounts): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const activity = this.activity(device.id);
    activity.sent = counts; activity.sentAt = Date.now(); activity.startedAt = Date.now();
    await this.deliver(device, 'activityStartToken', {
      topic: device.push.topic, pushType: 'liveactivity', priority: 10,
      payload: { aps: {
        timestamp: now, event: 'start', 'content-state': counts, 'attributes-type': 'RiffetSummaryAttributes', attributes: {},
        alert: { title: { 'loc-key': 'push.activity.title' }, body: { 'loc-key': 'push.activity.body' } },
      } },
    });
  }

  private scheduleUpdate(deviceId: string): void {
    const activity = this.activity(deviceId);
    if (activity.timer) return;
    activity.timer = setTimeout(() => { activity.timer = undefined; void this.flushUpdate(deviceId); }, Math.max(0, activity.sentAt + this.timing.activityCoalesceMs - Date.now()));
    activity.timer.unref();
  }

  private async flushUpdate(deviceId: string): Promise<void> {
    const push = this.deps.auth.devicePush(deviceId);
    const token = push && this.liveToken(deviceId, push);
    const activity = this.activity(deviceId), counts = activity.counts;
    if (this.closed || !push || !token || !counts || same(activity.sent, counts)) return;
    const raised = counts.waiting > (activity.sent?.waiting ?? 0);
    activity.sent = counts; activity.sentAt = Date.now();
    await this.deliver({ id: deviceId, push }, 'activityToken', {
      topic: push.topic, pushType: 'liveactivity', priority: raised ? 10 : 5,
      payload: { aps: { timestamp: Math.floor(Date.now() / 1000), event: 'update', 'content-state': counts } },
    });
  }

  /** Ends a device's activity whose counts stayed zero; its token is forgotten, so a restart does not update it again. */
  private async endActivity(deviceId: string): Promise<void> {
    const activity = this.activities.get(deviceId);
    const push = this.deps.auth.devicePush(deviceId);
    const token = push && this.liveToken(deviceId, push);
    if (this.closed || !activity?.counts || !zero(activity.counts) || !push || !token) return;
    clearTimeout(activity.timer); activity.timer = undefined;
    activity.ended = token; activity.sent = undefined; activity.sentAt = Date.now();
    const now = Math.floor(Date.now() / 1000);
    await this.deliver({ id: deviceId, push: { ...push } }, 'activityToken', {
      topic: push.topic, pushType: 'liveactivity', priority: 5,
      payload: { aps: { timestamp: now, event: 'end', 'content-state': activity.counts, 'dismissal-date': now } },
    });
    this.deps.auth.clearDevicePush(deviceId, 'activityToken', token);
  }
}
