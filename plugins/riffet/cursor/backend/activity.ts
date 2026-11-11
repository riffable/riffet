import type { NativeActivity, NativeJob, NativeStatus } from '@contracts';
import { activityId, activityOfEvent, activityTitle, ActivityLedger, clipDetail, withActivity } from '@riffet/plugin-api';
import type { WatchMessage } from '../native/watch.js';

/** The activity of one Cursor job; Cursor has no way to stop a job from outside, so it never carries `stop`. */
export function cursorJobActivity(job: NativeJob): NativeActivity {
  const status = job.status === 'succeeded' ? 'completed' : job.status === 'failed' ? 'failed' : job.status;
  return {
    id: activityId('cursor', job.toolCallId || job.id || ''),
    kind: 'background_task',
    status,
    title: activityTitle(job.title || job.command, '后台任务'),
    ...(job.output ? { detail: clipDetail(job.output) } : {}),
    toolCallId: job.toolCallId,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(status !== 'running' && status !== 'unknown' && job.runningMs ? { durationMs: job.runningMs } : {}),
    task: { kind: 'shell', ...(job.command ? { command: job.command } : {}), ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}) },
  };
}

/**
 * What one conversation's status says of its activities (`NativeStatus.activity`): the background jobs
 * the native service follows, and a compaction from the `preCompact` hook until the chat store archives
 * it. The activities themselves reach clients through the journal (`transcript-source.ts`).
 */
export class CursorActivities {
  private readonly ledger = new ActivityLedger(() => this.onChange?.());
  /** The compaction the `preCompact` hook reported and no archive has completed yet. */
  private liveCompactionId: string | undefined;
  private compactionStarts = 0;
  /** A changed activity changes the status summary; the owner of a live stream sets this. */
  onChange?: () => void;

  /**
   * The `preCompact` hook fired: the CLI is compacting now. There is no end hook, so this stays
   * running until the store archives it (see {@link observe}) or the turn ends without one.
   */
  compactionStarted(info: { generationId?: string; trigger?: 'manual' | 'auto'; preTokens?: number }): void {
    this.compactionStarts += 1;
    // A generation can compact twice; the ended first activity cannot come back to life.
    const base = activityId('cursor', `compaction:${info.generationId ?? 'live'}`);
    const known = this.ledger.get(base);
    const id = known && known.status !== 'running' && known.status !== 'stopping' ? `${base}:${this.compactionStarts}` : base;
    this.liveCompactionId = id;
    this.ledger.apply({
      id, kind: 'compaction', status: 'running', title: '上下文压缩', startedAt: new Date().toISOString(),
      compaction: { trigger: info.trigger ?? 'auto', ...(info.preTokens !== undefined ? { preTokens: info.preTokens } : {}) },
    });
  }

  /** The turn ended (or the CLI went away) with the live compaction still running and no archive landed: it will not finish. */
  settleLiveCompaction(): void {
    const current = this.liveCompactionId ? this.ledger.get(this.liveCompactionId) : undefined;
    if (current && (current.status === 'running' || current.status === 'stopping')) this.ledger.apply({ ...current, status: 'unknown' });
  }

  /** Takes in what the watch read: an archive that lands while the hook's compaction runs completes it, and a job changes its activity. */
  observe(message: WatchMessage): void {
    if (message.type === 'append' && this.liveCompactionId) {
      const live = this.ledger.get(this.liveCompactionId);
      const archived = message.events.some(event => activityOfEvent(event)?.kind === 'compaction');
      if (archived && live && (live.status === 'running' || live.status === 'stopping' || live.status === 'unknown')) {
        this.ledger.apply({ ...live, status: 'completed' });
        this.liveCompactionId = undefined;
      }
    } else if (message.type === 'job') this.ledger.apply(cursorJobActivity(message.job));
  }

  status(status: NativeStatus): NativeStatus { return withActivity(status, this.ledger.list()); }
}
