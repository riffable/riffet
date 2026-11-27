import type { NativeStatus } from '../../../../../packages/contracts/src/index.js';

/**
 * Claude Code's conversation state, as an event-sourced reducer.
 *
 * Four axes that used to be folded into one "busy/idle" guess are kept apart:
 *
 *   mainTurn    what the main agent is doing: idle | running | compacting | attention
 *   cliQueue    text the CLI itself has queued (`queue-operation` rows), not yet turned into a prompt
 *   background  background agents still working, independent of mainTurn
 *   process     the CLI: starting | alive | exited
 *
 * Evidence comes from two durable channels and is applied in the order it was observed: the transcript
 * (rows are written once, in order, and survive a server restart) and the participating hooks
 * (UserPromptSubmit / Stop / StopFailure / PermissionRequest / PreToolUse — low latency, but lossy).
 * The screen takes no part. A turn is opened by a prompt and closed by an end record; whichever channel
 * reports either first is believed, and the second report of the same fact is a no-op. A prompt that has
 * already started is remembered (`seen`), so a transcript row read after the hook that opened the same
 * turn — or after the Stop that closed it — can never reopen anything.
 */
export type ClaudeTurnOrigin = 'human' | 'task-notification' | 'peer' | 'other';
export type ClaudeProcess = 'starting' | 'alive' | 'exited';

export interface ActiveTurn {
  kind: 'running' | 'compacting';
  promptId?: string;
  origin: ClaudeTurnOrigin;
  /** A local command (`/name`, or a `!` shell command): it writes its output instead of a Stop (see `command_output`). */
  slash: boolean;
  /**
   * The transcript has shown this turn's own opening row. Until then a `turn_duration` can only be the
   * previous turn's, read late, and must not close this one.
   */
  transcriptSeen: boolean;
  /** A Stop hook blocked: the CLI goes on under this prompt, and the summary of that round ends nothing. */
  stopBlocked?: boolean;
}
export type MainTurn =
  | { kind: 'idle' }
  | ActiveTurn
  /** `resume` is absent when the request is a child agent's and the main agent has nothing running to go back to. */
  | { kind: 'attention'; requestId: string; resume?: ActiveTurn };

export interface CliQueueEntry {
  /** `input` is text a person submitted; `notification` is the CLI's own task report. */
  kind: 'input' | 'notification';
  /** Absent on an enqueue that does not name its content. */
  text?: string;
}
/**
 * Work that keeps running after the call that started it returned: a background agent, or a shell, a monitor
 * or a workflow. `toolUseId` is the call that started it (or the task id, when no call is known).
 */
export interface BackgroundAgent {
  toolUseId: string; agentId?: string; agentType?: string; description?: string;
  kind?: 'agent' | 'shell' | 'monitor' | 'workflow'; taskId?: string;
}

export interface ClaudeSessionState {
  mainTurn: MainTurn;
  cliQueue: CliQueueEntry[];
  background: BackgroundAgent[];
  process: ClaudeProcess;
  /** Prompt ids whose turn has started, oldest first. */
  seen: string[];
  /** Background agents known to be over, so an older metadata snapshot cannot bring them back. */
  gone: string[];
}

export type TurnEndReason = 'stop' | 'stop_failure' | 'duration' | 'interrupted' | 'compact' | 'command' | 'superseded' | 'session_end' | 'exit';

export type ClaudeSignal =
  | { type: 'prompt'; source: 'hook' | 'transcript'; promptId?: string; origin: ClaudeTurnOrigin; compact?: boolean; slash?: boolean; uuid?: string }
  /** `error`: what the CLI said when a turn failed (`stop_failure`), for the run's end. */
  | { type: 'turn_end'; source: 'hook' | 'transcript'; reason: Extract<TurnEndReason, 'stop' | 'stop_failure' | 'duration' | 'interrupted' | 'session_end'>; promptId?: string; error?: string }
  /**
   * The CLI's PreCompact hook: a compaction begins. Since 2.1.322 no row of a `/compact` is written before its boundary,
   * so an idle CLI is known to be compacting only from this; a turn already running goes on through its auto-compaction.
   */
  | { type: 'compact_start'; origin: ClaudeTurnOrigin }
  | { type: 'compact_boundary' }
  | { type: 'stop_blocked' }
  | { type: 'command_output' }
  | { type: 'queue'; operation: 'enqueue' | 'dequeue' | 'remove' | 'clear'; text?: string; reason?: string }
  | { type: 'agents_killed' }
  /** Auto mode can't check actions in this session (`rows.ts#AUTO_MODE_UNCHECKED`): a fact about the profile, not the turn. */
  | { type: 'auto_mode_unchecked' }
  | { type: 'background'; agents: BackgroundAgent[] }
  | { type: 'background_done'; toolUseId: string }
  /**
   * `requestId` opens (or keeps) attention for a pending participating request; absent closes it. `mainThread: false` is a
   * child agent's request: it can be raised while the main agent is idle and does not prove a main turn.
   */
  | { type: 'attention'; requestId?: string; mainThread?: boolean }
  | { type: 'process'; process: ClaudeProcess };

export interface Transition {
  state: ClaudeSessionState;
  started?: { promptId?: string; origin: ClaudeTurnOrigin; compact: boolean; slash: boolean; uuid?: string; source: 'hook' | 'transcript' };
  ended?: { promptId?: string; reason: TurnEndReason; compact: boolean; error?: string };
  queue?: { operation: 'enqueue' | 'dequeue' | 'remove' | 'clear'; entry?: CliQueueEntry; reason?: string; text?: string };
}

const MAX_SEEN = 256;
const MAX_GONE = 256;

export function initialState(process: ClaudeProcess = 'exited'): ClaudeSessionState {
  return { mainTurn: { kind: 'idle' }, cliQueue: [], background: [], process, seen: [], gone: [] };
}

/** The turn in progress, whether or not a request is currently waiting on a person. */
export function activeTurnOf(mainTurn: MainTurn): ActiveTurn | undefined {
  return mainTurn.kind === 'idle' ? undefined : mainTurn.kind === 'attention' ? mainTurn.resume : mainTurn;
}

/** `NativeStatus.phase` is the process and the main turn; background work is reported on its own. */
export function phaseOf(state: ClaudeSessionState): NativeStatus['phase'] {
  if (state.process === 'exited') return 'offline';
  if (state.process === 'starting') return 'starting';
  switch (state.mainTurn.kind) {
    case 'idle': return 'idle';
    case 'attention': return 'attention';
    default: return 'busy';
  }
}

export function isNotificationText(text: string | undefined): boolean {
  return text !== undefined && (/^\s*<task-notification\b/i.test(text) || /^Background agent ".*" (?:was|has been) /.test(text.trim()));
}

const remember = (list: string[], value: string | undefined, limit: number): string[] => {
  if (!value || list.includes(value)) return list;
  const next = [...list, value];
  return next.length > limit ? next.slice(next.length - limit) : next;
};

function withTurn(state: ClaudeSessionState, turn: ActiveTurn): ClaudeSessionState {
  return { ...state, mainTurn: state.mainTurn.kind === 'attention' ? { ...state.mainTurn, resume: turn } : turn };
}

function prompt(state: ClaudeSessionState, signal: Extract<ClaudeSignal, { type: 'prompt' }>): Transition {
  const turn = activeTurnOf(state.mainTurn);
  const { promptId } = signal;
  if (promptId !== undefined && state.seen.includes(promptId)) {
    // The same prompt reported by the other channel: it only confirms the turn it already opened.
    if (turn?.promptId === promptId && signal.source === 'transcript' && !turn.transcriptSeen) {
      return { state: withTurn(state, { ...turn, transcriptSeen: true, origin: turn.origin === 'other' ? signal.origin : turn.origin }) };
    }
    return { state };
  }
  // A compaction its hook opened is the one a bare `/compact` row (written before the boundary up to 2.1.302) names.
  const joins = promptId === undefined || (turn?.kind === 'compacting' && signal.compact === true);
  if (joins && turn && turn.promptId === undefined && signal.source === 'transcript' && !turn.transcriptSeen) {
    return {
      state: { ...withTurn(state, { ...turn, ...(promptId ? { promptId } : {}), transcriptSeen: true, origin: turn.origin === 'other' ? signal.origin : turn.origin }), seen: remember(state.seen, promptId, MAX_SEEN) },
    };
  }
  const next: ActiveTurn = {
    kind: signal.compact ? 'compacting' : 'running', ...(promptId ? { promptId } : {}),
    origin: signal.origin, slash: signal.slash === true, transcriptSeen: signal.source === 'transcript',
  };
  return {
    state: { ...state, mainTurn: next, seen: remember(state.seen, promptId, MAX_SEEN) },
    started: { ...(promptId ? { promptId } : {}), origin: signal.origin, compact: signal.compact === true, slash: signal.slash === true, ...(signal.uuid ? { uuid: signal.uuid } : {}), source: signal.source },
    // A new prompt means the CLI moved on: the turn it was in can no longer be running.
    ...(turn ? { ended: { ...(turn.promptId ? { promptId: turn.promptId } : {}), reason: 'superseded' as const, compact: turn.kind === 'compacting' } } : {}),
  };
}

function end(state: ClaudeSessionState, turn: ActiveTurn, reason: TurnEndReason, error?: string): Transition {
  return {
    state: { ...state, mainTurn: { kind: 'idle' } },
    ended: { ...(turn.promptId ? { promptId: turn.promptId } : {}), reason, compact: turn.kind === 'compacting', ...(error ? { error } : {}) },
  };
}

function turnEnd(state: ClaudeSessionState, signal: Extract<ClaudeSignal, { type: 'turn_end' }>): Transition {
  const turn = activeTurnOf(state.mainTurn);
  if (!turn) return { state };
  if (signal.reason === 'session_end') return end(state, turn, 'session_end');
  // A report about another prompt (a delayed Stop, an old interruption marker) cannot end this one.
  if (signal.promptId !== undefined && turn.promptId !== undefined && signal.promptId !== turn.promptId) return { state };
  // A compaction has its own end record (`compact_boundary`); no Stop follows it and no turn_duration is written for it.
  // One that fails writes none: the interruption, a StopFailure and the command's error output are how it ends then.
  if (turn.kind === 'compacting' && signal.reason !== 'interrupted' && signal.reason !== 'stop_failure') return { state };
  // The rows that close a turn (its Stop summary, its duration, the API error it failed on) can be read after a hook opened the next one.
  if (signal.source === 'transcript' && signal.reason !== 'interrupted' && !turn.transcriptSeen) return { state };
  if (signal.source === 'transcript' && signal.reason === 'stop' && turn.stopBlocked) return { state: withTurn(state, { ...turn, stopBlocked: false }) };
  return end(state, turn, signal.reason, signal.error);
}

function queue(state: ClaudeSessionState, signal: Extract<ClaudeSignal, { type: 'queue' }>): Transition {
  const { operation, text, reason } = signal;
  if (operation === 'enqueue') {
    const entry: CliQueueEntry = { kind: isNotificationText(text) ? 'notification' : 'input', ...(text ? { text } : {}) };
    return { state: { ...state, cliQueue: [...state.cliQueue, entry] }, queue: { operation, entry, ...(text ? { text } : {}) } };
  }
  if (operation === 'clear') return { state: { ...state, cliQueue: [] }, queue: { operation } };
  if (operation === 'dequeue') {
    // The row does not name what was taken, and the CLI takes a message (typed input, an agent's reply) before a task
    // report queued earlier. The guess can still be wrong; an idle CLI's leftover queue is converged from its screen.
    let index = state.cliQueue.findIndex(entry => entry.kind === 'input');
    if (index < 0) index = 0;
    const entry = state.cliQueue[index];
    return { state: { ...state, cliQueue: state.cliQueue.filter((_, i) => i !== index) }, queue: { operation, ...(entry ? { entry } : {}) } };
  }
  // A removal names what it removed; an enqueue that did not name its content is matched by elimination.
  const wanted = text?.trim();
  let index = wanted ? state.cliQueue.findIndex(entry => entry.text?.trim() === wanted) : -1;
  if (index < 0) index = state.cliQueue.findIndex(entry => entry.text === undefined && (isNotificationText(text) ? entry.kind === 'notification' : entry.kind === 'input'));
  const entry = index >= 0 ? state.cliQueue[index] : undefined;
  return {
    state: index >= 0 ? { ...state, cliQueue: state.cliQueue.filter((_, i) => i !== index) } : state,
    queue: { operation, ...(entry ? { entry } : {}), ...(reason ? { reason } : {}), ...(text ? { text } : {}) },
  };
}

const withoutGone = (agents: BackgroundAgent[], gone: string[]) => agents.filter(agent => !gone.includes(agent.toolUseId));

/** Applies one signal. Pure: the caller performs whatever `started`/`ended`/`queue` imply. */
export function reduce(state: ClaudeSessionState, signal: ClaudeSignal): Transition {
  switch (signal.type) {
    case 'prompt': return prompt(state, signal);
    case 'turn_end': return turnEnd(state, signal);
    case 'stop_blocked': {
      const turn = activeTurnOf(state.mainTurn);
      return turn ? { state: withTurn(state, { ...turn, stopBlocked: true }) } : { state };
    }
    case 'compact_start': {
      if (state.mainTurn.kind !== 'idle') return { state };
      const slash = signal.origin === 'human';
      return {
        state: { ...state, mainTurn: { kind: 'compacting', origin: signal.origin, slash, transcriptSeen: false } },
        started: { origin: signal.origin, compact: true, slash, source: 'hook' },
      };
    }
    case 'compact_boundary': {
      const turn = state.mainTurn.kind === 'compacting' ? state.mainTurn : undefined;
      return turn ? end(state, turn, 'compact') : { state };
    }
    case 'command_output': {
      // A local command's output ends the command; for `/compact` that is a compaction which failed (success ends at its boundary).
      const turn = (state.mainTurn.kind === 'running' && state.mainTurn.slash) || state.mainTurn.kind === 'compacting' ? state.mainTurn : undefined;
      return turn ? end(state, turn, 'command') : { state };
    }
    case 'queue': return queue(state, signal);
    case 'auto_mode_unchecked': return { state };
    case 'agents_killed': {
      // The CLI stops its background agents; shells, monitors and workflows are stopped one at a time and report on their own.
      const killed = state.background.filter(agent => agent.kind === undefined || agent.kind === 'agent');
      const gone = killed.reduce((list, agent) => remember(list, agent.toolUseId, MAX_GONE), state.gone);
      return { state: { ...state, background: state.background.filter(agent => !killed.includes(agent)), gone } };
    }
    case 'background_done': {
      return { state: { ...state, gone: remember(state.gone, signal.toolUseId, MAX_GONE), background: state.background.filter(agent => agent.toolUseId !== signal.toolUseId) } };
    }
    // Work belongs to a CLI that is running: after a crash or a relaunch, metadata still naming agents says nothing about now.
    case 'background': return { state: { ...state, background: state.process === 'alive' ? withoutGone(signal.agents, state.gone) : [] } };
    case 'attention': {
      const { mainTurn } = state;
      if (signal.requestId !== undefined) {
        if (mainTurn.kind === 'attention') return { state: { ...state, mainTurn: { ...mainTurn, requestId: signal.requestId } } };
        const open = activeTurnOf(mainTurn);
        // A child agent's request is raised while the main agent is idle all the time; it proves no main turn.
        if (!open && signal.mainThread === false) return { state: { ...state, mainTurn: { kind: 'attention', requestId: signal.requestId } } };
        // The main agent's own request can only be raised inside a turn; one that arrives first proves a turn this process missed.
        const resume: ActiveTurn = open ?? { kind: 'running', origin: 'other', slash: false, transcriptSeen: false };
        return { state: { ...state, mainTurn: { kind: 'attention', requestId: signal.requestId, resume } } };
      }
      return mainTurn.kind === 'attention' ? { state: { ...state, mainTurn: mainTurn.resume ?? { kind: 'idle' } } } : { state };
    }
    case 'process': {
      if (signal.process === 'alive') return { state: { ...state, process: 'alive' } };
      const turn = activeTurnOf(state.mainTurn);
      const cleared = { ...state, mainTurn: { kind: 'idle' } as const, cliQueue: [], background: [], process: signal.process };
      // A fresh launch starts a conversation turn-free; an exit ends whatever was running.
      return turn && signal.process === 'exited' ? { state: cleared, ended: { ...(turn.promptId ? { promptId: turn.promptId } : {}), reason: 'exit', compact: turn.kind === 'compacting' } } : { state: cleared };
    }
  }
}

/** Re-read durable state without forgetting a newer prompt or a Stop already observed by a hook. */
export function replay(previous: ClaudeSessionState, signals: readonly ClaudeSignal[]): ClaudeSessionState {
  let state = initialState(previous.process);
  for (const signal of signals) state = reduce(state, signal).state;
  const opened = activeTurnOf(previous.mainTurn);
  const replayed = activeTurnOf(state.mainTurn);
  // A rewrite can precede the duration row that makes a Stop durable. Re-reading that
  // prompt must not undo the end we already observed through its hook.
  if (replayed?.promptId && previous.seen.includes(replayed.promptId) && opened?.promptId !== replayed.promptId) {
    state = { ...state, mainTurn: { kind: 'idle' } };
  }
  // The hook's newest prompt may not have reached the file yet.
  if (opened && !opened.transcriptSeen && state.mainTurn.kind === 'idle' && opened.promptId && !state.seen.includes(opened.promptId)) {
    state = { ...state, mainTurn: previous.mainTurn };
  }
  return { ...state, seen: [...new Set([...previous.seen, ...state.seen])].slice(-MAX_SEEN) };
}
