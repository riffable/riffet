import type { NativeActivity } from '../../../../../packages/contracts/src/index.js';
import { activityId, activityTitle, clipDetail, isLiveActivity, type ActivityLedger } from '../../journal/activity.js';
import { asRecord, nonEmpty } from './util.js';

/**
 * A job shorter than this was a command the model waited for, not a background task: DSH registers
 * every shell call with `ctx.jobs`, and a foreground call that finishes inside a moment would otherwise
 * flash through the background list.
 */
export const JOB_GRACE_MS = 2_000;
/** What every DSH job activity id starts with; the rest is DSH's job id. */
export const JOB_ACTIVITY_PREFIX = activityId('dsh', 'job:');
/** DSH settles a killed job on its own schedule; a stop it never acts on this long after the kill was acknowledged is a failed stop. */
export const STOP_DEADLINE_MS = 30_000;

/** The job as the bridge forwards it (`jobWire` in the bridge runtime), and as DSH's `job/*` records describe it. */
export interface JobWire { id: string; kind: string; label: string; status: string; progress?: string; detail?: string; startedAt?: number; finishedAt?: number }

const iso = (ms: unknown): string | undefined => typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;

function taskKind(kind: string): NonNullable<NativeActivity['task']>['kind'] {
  if (kind === 'subagent') return 'agent';
  if (/workflow/i.test(kind)) return 'workflow';
  if (/monitor/i.test(kind)) return 'monitor';
  return 'shell';
}

/** The activity a job state stands for. A finished shell job with a non-zero exit code failed, whatever DSH calls it. */
export function jobActivity(job: JobWire, stopRequested = false): NativeActivity {
  const exit = /exit code:\s*(-?\d+)/i.exec(job.detail ?? '');
  const exitCode = exit ? Number(exit[1]) : undefined;
  const live = job.status === 'running' || job.status === 'stopping';
  const status: NativeActivity['status'] = job.status === 'stopping' || (job.status === 'running' && stopRequested) ? 'stopping'
    : job.status === 'running' ? 'running'
    : job.status === 'killed' ? 'stopped'
    : job.status === 'failed' ? 'failed'
    : job.status === 'completed' ? (exitCode !== undefined && exitCode !== 0 ? 'failed' : 'completed')
    : 'unknown';
  const detail = job.progress && live ? job.progress : job.detail;
  return {
    id: activityId('dsh', `job:${job.id}`), kind: 'background_task', status,
    title: activityTitle(job.label, job.kind), ...(detail ? { detail: clipDetail(detail) } : {}),
    ...(iso(job.startedAt) ? { startedAt: iso(job.startedAt) } : {}), ...(iso(job.finishedAt) ? { endedAt: iso(job.finishedAt) } : {}),
    ...(live ? { stop: { via: 'protocol' as const } } : {}),
    task: { kind: taskKind(job.kind), ...(job.kind === 'bash' || job.kind === 'shell' ? { command: job.label.slice(0, 2048) } : {}), ...(exitCode !== undefined ? { exitCode } : {}) },
  };
}

/**
 * The bridge's answer to a kill: its view of the job, which is evidence when the job had already ended. A
 * state this code does not know says nothing about the job: it must not turn a running task into `unknown`.
 */
export function noteKilled(ledger: ActivityLedger, job: JobWire | undefined): void {
  if (!job) return;
  const activity = jobActivity(job);
  if (activity.status !== 'unknown' && !isLiveActivity(activity)) ledger.apply(activity);
}

/**
 * The `job/event` notifications of one conversation as states of its activities in `ledger()`: a job
 * is reported once it has lived {@link JOB_GRACE_MS}, and only a reported job's end is. One the ledger
 * already holds as live (reported by an earlier process, or read from the log) counts as reported.
 */
export class DshJobFeed {
  /** Jobs seen but not yet old enough to report, and the ones already reported. */
  private readonly pending = new Map<string, { job: JobWire; timer: NodeJS.Timeout }>();
  private readonly announced = new Set<string>();

  constructor(private readonly ledger: () => ActivityLedger) {}

  private idOf(job: JobWire): string { return activityId('dsh', `job:${job.id}`); }

  /** One `job/event` notification from the bridge. */
  onJobEvent(params: Record<string, unknown>): void {
    const raw = asRecord(params.job);
    const type = nonEmpty(params.type);
    if (!raw || !type || typeof raw.id !== 'string') return;
    const job = raw as unknown as JobWire;
    const id = this.idOf(job);
    const known = this.ledger().get(id);
    const reported = this.announced.has(id) || (known !== undefined && isLiveActivity(known));
    if (type === 'settled' || type === 'removed') {
      const wait = this.pending.get(job.id);
      if (wait) { clearTimeout(wait.timer); this.pending.delete(job.id); }
      // A job that ended before it was ever reported was no background task.
      if (!reported) return;
      if (type === 'removed') { this.ledger().settleWhere(activity => activity.id === id, 'completed'); return; }
      this.ledger().apply(jobActivity(job));
      return;
    }
    if (reported) {
      this.ledger().apply(jobActivity(job, known?.status === 'stopping'));
      return;
    }
    // The first sight of a job that is already old (reported on reconnect) needs no grace.
    const age = typeof job.startedAt === 'number' ? Date.now() - job.startedAt : 0;
    if (age >= JOB_GRACE_MS) { this.announce(job); return; }
    const existing = this.pending.get(job.id);
    if (existing) { existing.job = job; return; }
    const timer = setTimeout(() => {
      const wait = this.pending.get(job.id);
      this.pending.delete(job.id);
      if (wait) this.announce(wait.job);
    }, Math.max(0, JOB_GRACE_MS - age));
    timer.unref();
    this.pending.set(job.id, { job, timer });
  }

  /** The DSH process that ran the jobs is gone, and so are they: whatever is still live ends as `status`. */
  settle(status: 'unknown' | 'stopped'): void {
    this.ledger().settleWhere(activity => activity.id.startsWith(JOB_ACTIVITY_PREFIX), status);
  }

  private announce(job: JobWire): void {
    this.announced.add(this.idOf(job));
    this.ledger().apply(jobActivity(job));
  }

  dispose(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
