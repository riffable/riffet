import { providerTitlePatch, stripTerminalSequences } from '@riffet/plugin-api/kit';
import { type AgentSessionView, type AgentTerminalObservation } from '@riffet/plugin-api/experimental/agent';
import type { CursorPort } from './host-port.js';

/**
 * Best-effort "native 会话智能标题" backfill.
 *
 * When a native Cursor conversation is opened with `--resume`, the CLI paints its
 * resume picker inside the tmux pane and the workbench session keeps a placeholder
 * title such as "Untitled". This module observes raw terminal output *only* to guess
 * which remote session id the user resumed, and derives a clearly separated fallback
 * label from the same text. Terminal text is never used to drive session state,
 * tools, plans, prompts or runs.
 *
 * The design keeps all I/O at the edges: the parsing heuristics below are pure
 * string functions, and `ResumeTitleWatcher` composes them with the host port.
 */

export type SessionIdSource = 'labeled' | 'resume';

export interface SessionIdCandidate {
  id: string;
  source: SessionIdSource;
}

const LABELED_PATTERNS: readonly RegExp[] = [
  /(?:cursor[\s_-]?)?session[\s_-]?id\s*[:=]\s*["'`]?([A-Za-z0-9][A-Za-z0-9._:-]{5,127})/gi,
  /(?:conversation|chat)[\s_-]?(?:id|key)\s*[:=]\s*["'`]?([A-Za-z0-9][A-Za-z0-9._:-]{5,127})/gi,
];
// "Resume <id>", "Resumed session <id>", "resuming chat: <id>". Unlike the labeled
// patterns this is noisy, so the captured token must look concrete (see below).
const RESUME_PATTERN = /\bresum(?:e|ed|ing)\b(?:[^\p{L}\p{N}]{1,24}(?:session|chat|conversation|agent|thread)\b)?[^\p{L}\p{N}]{0,24}["'`]?([A-Za-z0-9][A-Za-z0-9._:-]{5,127})/giu;
const UUID_TEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A token that plausibly is an id rather than an English word from a picker prompt. */
function looksConcreteId(value: string): boolean {
  if (UUID_TEST.test(value)) return true;
  return value.length >= 6 && (/[0-9]/.test(value) || value.includes('-'));
}

/**
 * The id-like tokens the picker painted, deduplicated and ordered: explicitly labeled ids
 * first, then resume-adjacent ones. An unlabeled UUID elsewhere on screen is deliberately
 * not collected — it cannot be attributed to this conversation.
 */
export function findSessionIdCandidates(text: string): SessionIdCandidate[] {
  const clean = stripTerminalSequences(text);
  const candidates: SessionIdCandidate[] = [];
  const seen = new Set<string>();
  const push = (id: string, source: SessionIdSource): void => {
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ id, source });
  };
  for (const pattern of LABELED_PATTERNS) {
    for (const match of clean.matchAll(pattern)) push(match[1], 'labeled');
  }
  for (const match of clean.matchAll(RESUME_PATTERN)) {
    if (looksConcreteId(match[1])) push(match[1], 'resume');
  }
  return candidates;
}

/**
 * The strongest single id hint. Restricted to explicitly labeled/resume-adjacent tokens so a
 * stray UUID elsewhere on screen is never persisted as a `cursorSessionId` for a later `--resume`.
 */
export function extractLabeledSessionId(text: string): string | undefined {
  const candidate = findSessionIdCandidates(text).find(item => item.source === 'labeled' || item.source === 'resume');
  return candidate?.id;
}

/**
 * Conservative fallback label derived from terminal text. It picks the last plausible
 * non-chrome line; it is a pure guess and is clearly separated from the id it accompanies.
 */
export function deriveFallbackTitle(text: string): string | undefined {
  const clean = stripTerminalSequences(text);
  const chrome = /(press|esc to|enter to|tab to|arrow|ctrl\+|resume|quit|exit|loading|fetching|select a|choose a|no sessions|search)/i;
  const lines = clean
    .split('\n')
    .map(line => line.replace(/[│┃┆┊|]/g, ' ').replace(/^[\s>*•·❯➜→←\-=]+/u, '').replace(/\s+/g, ' ').trim())
    .filter(line => line.length >= 4 && line.length <= 120 && /[\p{L}]/u.test(line) && !chrome.test(line) && !/^[\d.]+$/.test(line));
  const last = lines.at(-1);
  return last ? last.slice(0, 100) : undefined;
}

export interface ResumeTitleWatcherOptions {
  port: Pick<CursorPort, 'getSession' | 'listSessions' | 'updateSession' | 'terminals'>;
  /** Bounded watch window; the watcher gives up after this many milliseconds. */
  timeoutMs?: number;
  /** Retained tail of raw output used for parsing. */
  bufferLimit?: number;
}

export interface ResumeWatchTarget {
  terminalId: string;
  sessionId: string;
  projectId: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BUFFER_LIMIT = 64 * 1024;

interface WatchState {
  target: ResumeWatchTarget;
  buffer: string;
  disposed: boolean;
  timer?: NodeJS.Timeout;
  unsubscribe: () => void;
}

export class ResumeTitleWatcher {
  private readonly port: ResumeTitleWatcherOptions['port'];
  private readonly timeoutMs: number;
  private readonly bufferLimit: number;
  private readonly active = new Map<string, WatchState>();

  constructor(options: ResumeTitleWatcherOptions) {
    this.port = options.port;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  }

  /**
   * Watch one resume-picker terminal. Returns a dispose function. Watching the same
   * session twice is a no-op and returns the existing dispose function. Never throws:
   * terminal startup must not depend on this feature, so callers may ignore failures.
   */
  watch(target: ResumeWatchTarget): () => void {
    const existing = this.active.get(target.sessionId);
    if (existing) return () => this.disposeState(existing);
    const state: WatchState = {
      target,
      buffer: '',
      disposed: false,
      unsubscribe: () => undefined,
    };
    this.active.set(target.sessionId, state);
    let disposeObserver: () => void;
    try {
      disposeObserver = this.port.terminals.observe(target.terminalId, observation => this.onObservation(state, observation));
    } catch {
      this.disposeState(state);
      return () => undefined;
    }
    state.unsubscribe = disposeObserver;
    // observe() may replay buffered output synchronously; if that already disposed the
    // watcher (e.g. the session id was known), the real unsubscribe must still run.
    if (state.disposed) {
      disposeObserver();
      return () => undefined;
    }
    state.timer = setTimeout(() => this.disposeState(state), this.timeoutMs);
    state.timer.unref?.();
    return () => this.disposeState(state);
  }

  disposeAll(): void {
    for (const state of [...this.active.values()]) this.disposeState(state);
  }

  private disposeState(state: WatchState): void {
    if (state.disposed) return;
    state.disposed = true;
    clearTimeout(state.timer);
    try { state.unsubscribe(); } catch { /* disposal is best-effort */ }
    if (this.active.get(state.target.sessionId) === state) this.active.delete(state.target.sessionId);
  }

  private onObservation(state: WatchState, observation: AgentTerminalObservation): void {
    if (state.disposed) return;
    if (observation.type === 'output') {
      state.buffer = state.buffer.length + observation.data.length > this.bufferLimit
        ? (state.buffer + observation.data).slice(-this.bufferLimit)
        : state.buffer + observation.data;
      // Pure and idempotent per buffer: a repainting picker simply re-runs this and
      // disposes itself as soon as a labeled id and the fallback label are available.
      try { this.resolve(state); } catch { /* best-effort: never surface here */ }
      return;
    }
    if (observation.type === 'exit') { this.disposeState(state); return; }
    if (observation.type === 'state' && observation.terminal.state === 'exited') this.disposeState(state);
  }

  /**
   * Accept only an explicitly labeled/resume-adjacent id; a stray UUID elsewhere on screen
   * is never persisted as the native session id. The title is a clearly separated text guess.
   */
  private resolve(state: WatchState): void {
    const { target } = state;
    let session: AgentSessionView;
    try {
      session = this.port.getSession(target.sessionId);
    } catch {
      this.disposeState(state);
      return;
    }
    // Re-read before every write: stop if the id is known. A user-set title is never
    // overwritten, but learning the id is still useful for a later --resume.
    if (session.nativeSessionId) { this.disposeState(state); return; }

    const resolvedId = extractLabeledSessionId(state.buffer);
    if (!resolvedId) return;
    const title = deriveFallbackTitle(state.buffer);

    let fresh: AgentSessionView;
    try {
      fresh = this.port.getSession(target.sessionId);
    } catch {
      this.disposeState(state);
      return;
    }
    if (fresh.nativeSessionId) { this.disposeState(state); return; }

    // A chat another live conversation owns cannot be used: keep watching, as for any id that does not fit.
    if (this.port.listSessions().some(other => other.id !== target.sessionId && other.nativeSessionId === resolvedId && !other.archivedAt)) return;
    // Only backfill the human-readable title while it is still a placeholder, and record that the
    // guess came from the CLI rather than from a human message. The id and the title are one write,
    // so a reader never sees the one without the other, and the host announces it once.
    const titlePatch = providerTitlePatch(fresh, title);
    const written = this.port.updateSession(target.sessionId, { nativeSessionId: resolvedId, ...titlePatch });
    if (written.nativeSessionId !== resolvedId) return;
    this.disposeState(state);
  }
}
