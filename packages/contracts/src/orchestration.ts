import type { NativeBackendId } from './agent-ids.js';
import type { WorktreeComparison } from './git.js';
import type { NativeRunInput } from './run.js';
import type { SessionState } from './session.js';
import type { AuxiliaryModelOption } from './settings.js';

/** A backend choice for a launch; unset fields take the backend's saved defaults, as in the composer. */
export interface LaunchTarget { backendId?: NativeBackendId; backendProfileId?: string; model?: string; mode?: string; approval?: string; }
/**
 * The opening message proposed for a handoff, for the reader to edit before it is sent. `generatedBy`
 * names the auxiliary model that wrote it; without one it was assembled from the transcript, and
 * `fallbackReason` says why when a configured model could not write it.
 */
export interface HandoffDraft { text: string; generatedBy?: AuxiliaryModelOption; fallbackReason?: string; }
/**
 * One prompt run by several backends side by side, each in a worktree cut from the same commit, so
 * the results can be compared and one of them merged back.
 */
export interface AttemptGroup {
  id: string; projectId: string; prompt: string; base: string; createdAt: string;
  attempts: Array<{ sessionId: string; projectId: string; branch: string; target: LaunchTarget; discardedAt?: string }>;
  adopted?: { sessionId: string; at: string; head?: string };
}
/** What adopting one attempt does to the others: leave them, archive their conversations, or archive and remove their worktrees. */
export type AttemptCleanup = 'keep' | 'archive' | 'remove';
export interface AttemptComparison {
  sessionId: string; projectId: string; branch: string; target: LaunchTarget;
  state?: SessionState; title?: string; comparison?: WorktreeComparison; error?: string;
}
/**
 * When an automation runs by itself. `once` fires a single time; `cron` repeats (five fields, see
 * docs/ORCHESTRATION.md §5). `timeZone` is the IANA zone of whoever set it, not the server's: cron
 * is read in it, and `{{date}}` is filled in by it.
 */
export type AutomationTrigger =
  | { kind: 'once'; at: string; timeZone?: string }
  | { kind: 'cron'; cron: string; timeZone: string };
export type AutomationRunResult = 'started' | 'skipped' | 'missed' | 'failed';
/**
 * Saved work: what to run (prompt, backend, project), when it runs by itself (`triggers`; none means
 * by hand only, what used to be a template) and where each run goes. `{{date}}` and `{{project}}`
 * in the prompt are filled in when it runs. A run whose previous conversation is still working is
 * skipped, not queued.
 */
export interface Automation extends LaunchTarget {
  id: string; name: string; prompt: string;
  /** Where runs start. Unset: chosen at each run by hand; a trigger needs one. */
  projectId?: string;
  /** Run each time in a fresh worktree of the project instead of its own checkout. */
  isolate?: boolean;
  triggers: AutomationTrigger[];
  /** `new` opens a conversation per run; `same` continues the conversation of the last run. */
  delivery: 'new' | 'same';
  /** A time passed while the server was off: `latest` runs the most recent one once (up to 7 days late), `skip` records it missed. */
  catchUp: 'latest' | 'skip';
  enabled: boolean;
  /**
   * A follow-up of one conversation: a single `once` trigger whose run is a turn in `sessionId`, never a new conversation.
   * `agent` ones come from `schedule_wakeup` and are framed as the agent's own wake-up; `user` ones
   * (send later) send `prompt` as typed. Settled follow-ups are removed after a week.
   */
  followUp?: { sessionId: string; by: 'agent' | 'user' };
  /** What a user follow-up sends besides `prompt`, as the composer gave it; references are frozen when it is scheduled. */
  input?: Omit<NativeRunInput, 'text'>;
  /** The conversation whose agent set this up (`schedule_task`). */
  createdBySessionId?: string;
  nextRunAt?: string;
  lastRunAt?: string; lastResult?: AutomationRunResult; lastError?: string; lastSessionId?: string;
  createdAt: string; updatedAt: string;
}
/** One firing of an automation; the latest 50 of each are kept. */
export interface AutomationRun {
  id: string; automationId: string;
  cause: 'schedule' | 'catch-up' | 'manual';
  /** The trigger time this run stands for; absent for a run by hand. */
  scheduledFor?: string;
  at: string;
  result: AutomationRunResult;
  /** Why it was skipped or missed: the last conversation was busy, the server was off, or the project or conversation is gone or archived. */
  reason?: 'busy' | 'offline' | 'project-unavailable' | 'session-unavailable';
  /** What a failed run failed with. */
  error?: string;
  sessionId?: string; runId?: string;
}
/** One review remark on a diff line or range, sent back to the agent as a message. */
export interface ReviewComment { path: string; line?: number; endLine?: number; body: string; quote?: string; }
