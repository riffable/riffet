import type {
  AttemptGroup,
  Automation,
  AutomationRun,
  CapturedSessionReference,
  LaunchTarget,
  NativeRunInput,
  NativeSessionInput,
  Project,
  ReviewComment,
  RiffetWakeup,
  Run,
  Session,
  SessionOrigin,
} from '../../../../packages/contracts/src/index.js';
import type { AuxiliaryCallRecorder } from '../auxiliary/telemetry.js';
import { isNativeBackendId } from '../backends/registry.js';
import type { NativeBackendService } from '../backends/service.js';
import { AppError, requireString } from '../errors.js';
import type { GitService } from '../git/index.js';
import type { NativeDispatcher } from '../native/dispatch.js';
import type { NoticeLog } from '../riffet-mcp/notices.js';
import type { SettingsService } from '../settings/index.js';
import type { Store } from '../store.js';
import type { SessionCommands } from './session-commands.js';

export const GROUPS = 'orchestration:attempt-groups';
/** Before 0.7 templates, schedules and wake-ups were settings keys; `migrateLegacyAutomations` folds them in once. */
export const LEGACY_TEMPLATES = 'orchestration:templates';
export const LEGACY_SCHEDULES = 'orchestration:schedules';
export const LEGACY_WAKEUPS = 'orchestration:wakeups';
export const MAX_ATTEMPTS = 4;
export const MAX_AUTOMATIONS = 250;
export const MAX_AUTOMATIONS_PER_AGENT_SESSION = 10;
export const MIN_AGENT_CRON_GAP_MS = 15 * 60_000;
export const MAX_GROUPS_KEPT = 100;
/** A follow-up that should have run longer ago than this — the workbench was off — is recorded missed, not sent late. */
export const SKIP_CATCH_UP_MS = 60 * 60 * 1000;
/** `catchUp: 'latest'` still runs a time missed up to this long ago. */
export const LATEST_CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;
/** Later than this after its time, a run counts as a catch-up rather than on time. */
export const ON_TIME_MS = 2 * 60 * 1000;
export const SCHEDULER_INTERVAL_MS = 30_000;
export const MAX_PENDING_FOLLOW_UPS_PER_SESSION = 20;
export const MAX_FOLLOW_UPS = 500;
export const MAX_WAKEUP_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** Settled follow-ups are kept this long for `list_wakeups` and the conversation's own view. */
export const FOLLOW_UP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrchestrationDeps {
  store: Store;
  settings: SettingsService;
  nativeBackends: NativeBackendService;
  git: GitService;
  dispatch: NativeDispatcher;
  sessionCommands: SessionCommands;
  schedulerIntervalMs?: number;
  notices?: NoticeLog;
  recordAuxiliaryCall?: AuxiliaryCallRecorder;
  /** Told of every wake-up that was scheduled or left `pending`; device leases follow it (docs/DEVICES.md §3). */
  onWakeup?: (wakeup: RiffetWakeup) => void;
}

export interface Ids {
  sessionId?: string;
  commandId?: string;
}

export type StoredAttemptGroup = AttemptGroup & {
  requestId?: string;
  requestFingerprint?: string;
  warnings?: string[];
  runInput?: NativeRunInput;
};

/** What the route captured under one transaction: the composer's input beyond the text, and the frozen session references. */
export interface FrozenInput {
  input: NativeRunInput;
  snapshots: CapturedSessionReference[];
}

export interface FireOptions {
  cause?: AutomationRun['cause'];
  scheduledFor?: string;
  /** For an automation saved without a project. */
  projectId?: string;
  ids?: Ids;
  /** Fills in what the automation leaves unset (an old client's compatible backend). */
  target?: LaunchTarget;
}

export interface OrchestrationHost {
  isClosed(): boolean;
  withOperation<T>(key: string, operation: () => Promise<T>): Promise<T>;
  busy(sessionId: string): boolean;
  relaunched(ids: Ids, origin: SessionOrigin, projectId?: string): { session: Session; run: Run } | undefined;
  launch(input: NativeSessionInput, text: string | NativeRunInput, origin: SessionOrigin, ids?: Ids, attach?: (session: Session) => void): { session: Session; run: Run };
  send(sessionId: string, text: string | NativeRunInput, commandId?: string, snapshots?: CapturedSessionReference[]): Run;
  worktreeProject(origin: Project, base: string, label?: string, shadow?: boolean, checkpointId?: string): Promise<Project>;
  launchAutomation(automation: Automation, project: Project, ids: Ids, targetOverride?: LaunchTarget): Promise<{ session: Session; run: Run }>;
}

export const now = () => new Date().toISOString();
/** Where a user follow-up keeps the session references it froze when it was scheduled; the blobs belong to the conversation. */
export const snapshotsKey = (automationId: string): string => `automation-snapshots:${automationId}`;
export const textInput = (text: string): NativeRunInput => ({ text, attachmentIds: [], context: [] });

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new AppError('INVALID_INPUT', `${name} is invalid`);
  return value;
}

/** The backend fields of a request; whether the backend offers them is checked when the session is resolved. */
export function launchTarget(value: unknown): LaunchTarget {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new AppError('INVALID_INPUT', 'target must be an object');
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const backendId = optionalString(raw.backendId, 'backendId', 40);
  // A quick chat is started in its own project, never by an automation, fork or attempt.
  if (backendId !== undefined && (!isNativeBackendId(backendId) || backendId === 'chat')) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
  const target: LaunchTarget = {};
  if (backendId) target.backendId = backendId;
  for (const [key, max] of [['backendProfileId', 200], ['model', 200], ['mode', 100], ['approval', 100]] as const) {
    const item = optionalString(raw[key], key, max);
    if (item !== undefined) target[key] = item;
  }
  return target;
}

/** The message a set of review remarks becomes; each names its file and lines so the agent can find them without the diff. */
export function reviewMessage(comments: ReviewComment[], note?: string): string {
  const items = comments.map((comment, index) => {
    const where = comment.line === undefined ? comment.path : `${comment.path}:${comment.line}${comment.endLine && comment.endLine !== comment.line ? `-${comment.endLine}` : ''}`;
    const quote = comment.quote?.trim() ? `\n${comment.quote.trim().split('\n').slice(0, 12).map(line => `> ${line}`).join('\n')}` : '';
    return `${index + 1}. \`${where}\`${quote}\n${comment.body.trim()}`;
  });
  return [note?.trim() || '请根据以下代码审阅意见修改：', ...items].join('\n\n');
}

export function reviewComments(value: unknown): ReviewComment[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new AppError('INVALID_REVIEW', 'Send between 1 and 50 review comments');
  return value.map(item => {
    const raw = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const line = raw.line === undefined ? undefined : Number(raw.line), endLine = raw.endLine === undefined ? undefined : Number(raw.endLine);
    if ((line !== undefined && (!Number.isSafeInteger(line) || line < 1)) || (endLine !== undefined && (!Number.isSafeInteger(endLine) || line === undefined || endLine < line))) throw new AppError('INVALID_LINE', 'Review comment lines are invalid');
    return {
      path: requireString(raw.path, 'path', 8192), body: requireString(raw.body, 'body', 10_000),
      ...(line !== undefined ? { line } : {}), ...(endLine !== undefined ? { endLine } : {}),
      ...(typeof raw.quote === 'string' && raw.quote ? { quote: raw.quote.slice(0, 4_000) } : {}),
    };
  });
}

/** The turn a wake-up starts: the agent's own note, framed so it reads as the scheduled continuation. */
export function wakeupMessage(wakeup: Pick<RiffetWakeup, 'id' | 'createdAt' | 'dueAt' | 'note'>): string {
  return `[Riffet 唤醒] 这是你在 ${wakeup.createdAt} 用 schedule_wakeup 安排、定于 ${wakeup.dueAt} 的唤醒（${wakeup.id}）。说明：\n\n${wakeup.note}`;
}

/** The switched-off extensions a continuation keeps: names belong to one backend profile, so a different target starts clean. */
export function sameLaunchExtensions(source: Session, input: { backendId: string; backendProfileId: string }): { extensionsOff?: string[] } {
  const same = source.backendId === input.backendId && source.backendProfileId === input.backendProfileId;
  return same && source.extensionsOff?.length ? { extensionsOff: source.extensionsOff } : {};
}
