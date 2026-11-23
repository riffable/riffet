import type { NativeBackendId } from './agent-ids.js';
import type { RunMetrics } from './run.js';
import type { TimelineRow } from './sync.js';

/**
 * Multi-model discussions. Each seat is an Agent conversation of its own, kept for the discussion's life
 * and hidden from the conversation list; a speech is one turn of it, drawn with the session's row
 * components. Formats only decide who speaks next and what they are told.
 *
 * - `ld`: one-on-one Lincoln-Douglas debate. Pro and con speak in turn within a round, a judge keeps
 *   a ledger after each round, the closing round reverses the order so pro speaks last.
 * - `roundtable`: free debate among several models. All speak at once each round, a moderator sums
 *   up and names who challenged whom; it ends on convergence, the round limit or the reader's call.
 * - `prism`: independent answers, an observer probes the contradictions, each answers the probe,
 *   the observer concludes.
 * - `review`: reviewers each propose edits to a document from their own angle, the reader accepts
 *   some, an editor merges the accepted ones into a revised document.
 */
export type CouncilFormat = 'ld' | 'roundtable' | 'prism' | 'review';

/** `paused` waits for the reader at a round boundary or after a stop; `failed` stopped on an error. */
export type CouncilStatus = 'running' | 'paused' | 'done' | 'failed';
export type CouncilRhythm = 'pause' | 'auto';

export type CouncilRole = 'pro' | 'con' | 'judge' | 'debater' | 'moderator' | 'participant' | 'observer' | 'reviewer' | 'editor';
export type CouncilReviewTask = 'correct' | 'augment' | 'diagnose' | 'restructure';

export type CouncilPhase =
  | 'opening' | 'rebuttal' | 'closing' | 'ledger'
  | 'statement' | 'summary'
  | 'explore' | 'probe' | 'deepen'
  | 'review'
  | 'conclusion';

/** The Agent a seat runs on, as the composer picks one. `model` absent: the profile's default. */
export interface CouncilAgent {
  backendId: NativeBackendId;
  profileId: string;
  model?: string;
}

/**
 * The model a seat names when it speaks: its choice without parameters, and a quick chat's without the provider it
 * goes through (`<backend>:<profile>:<model>`). Undefined when the seat runs on its Agent's default.
 */
export function councilModelName(agent: CouncilAgent): string | undefined {
  const model = agent.model?.replace(/\[[^\]]*\]$/, '');
  if (!model) return undefined;
  return agent.backendId === 'chat' ? /^[a-z]+:[^:]+:(.+)$/.exec(model)?.[1] ?? model : model;
}

export interface CouncilSeat {
  /** Short and stable within the discussion (`pro`, `s2`, `mod` …); used in structured records. */
  id: string;
  role: CouncilRole;
  model: CouncilAgent;
  profileName: string;
  /** Reviewers only. */
  task?: CouncilReviewTask;
  /** The seat's conversation, once it first spoke. */
  sessionId?: string;
  /** Speeches of others and reader notes the conversation has been given, so the next turn tells only what is new. */
  heard?: string[];
}

/** Names the model in prose and distinguishes repeated selections by their roster order. */
export function councilSeatLabel(seats: readonly CouncilSeat[], seat: CouncilSeat): string {
  const modelName = (item: CouncilSeat) => councilModelName(item.model) ?? item.profileName;
  const label = modelName(seat);
  const namesakes = seats.filter((item) => modelName(item) === label);
  return namesakes.length > 1 ? `${label} #${namesakes.findIndex((item) => item.id === seat.id) + 1}` : label;
}

/** The judge's account of one LD round. */
export interface CouncilLedger {
  kind: 'ledger';
  sides: Partial<Record<'pro' | 'con', { claim: string; reinforced?: string; broken?: string }>>;
  crossExam: Array<{ asker: 'pro' | 'con'; question: string; answered: 'direct' | 'dodged' | 'pending' }>;
  intensity: 'clashing' | 'stalling';
  action: 'continue' | 'closing';
}

/** The moderator's account of one roundtable round. */
export interface CouncilModeration {
  kind: 'moderation';
  positions: Array<{ seatId: string; stance: string }>;
  challenges: Array<{ from: string; to: string; point: string }>;
  unanswered?: string;
  convergence: 'divergent' | 'partial' | 'converging' | 'consensus';
  action: 'continue' | 'conclude';
}

/** The observer's probe of the first Prism answers. */
export interface CouncilProbe {
  kind: 'probe';
  contradictions: Array<{ title: string; seats: string[]; question: string }>;
  gaps: string[];
}

/** Edits one reviewer proposes; `id` is unique within the discussion. */
export interface CouncilEdits {
  kind: 'edits';
  edits: Array<{ id: string; para: string; title: string; before: string; after: string }>;
}

export type CouncilDirective = CouncilLedger | CouncilModeration | CouncilProbe | CouncilEdits;

export type CouncilSpeechStatus = 'waiting' | 'streaming' | 'done' | 'failed' | 'stopped';

export interface CouncilSpeech {
  id: string;
  seatId: string;
  round: number;
  phase: CouncilPhase;
  /** The turn's answer, once it ended: what later speeches quote. */
  text: string;
  status: CouncilSpeechStatus;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  /** The seat conversation's run this speech is. */
  runId?: string;
  /** The follow-up turn that requested structured notes, when recorded. */
  recordRunId?: string;
  metrics?: RunMetrics;
  /** Notes the seat recorded for the next prompts in a turn of its own after the speech; not part of the speech. */
  directive?: CouncilDirective;
}

export interface CouncilSupplement {
  id: string;
  text: string;
  at: string;
  /** How many speeches existed when it was added: it is drawn after them and read by every later one. */
  after: number;
}

export interface CouncilDocument {
  title?: string;
  paragraphs: Array<{ id: string; text: string }>;
}

export interface CouncilDiscussion {
  id: string;
  format: CouncilFormat;
  title: string;
  topic: string;
  document?: CouncilDocument;
  seats: CouncilSeat[];
  maxRounds: number;
  rhythm: CouncilRhythm;
  status: CouncilStatus;
  error?: string;
  /** The round the reader has let run; the format stops at its end unless the rhythm is `auto`. */
  round: number;
  /** LD: the round that closes (defaults to `maxRounds`). */
  closingRound?: number;
  /** The reader or the moderator asked to wrap up. */
  concluding?: boolean;
  speeches: CouncilSpeech[];
  supplements: CouncilSupplement[];
  /** Review: accepted edit ids. */
  accepted?: string[];
  /** Grows with every run, so a superseded run's late writes are dropped. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** The same round-end recommendation drives automatic advancement and the primary action at a pause. */
export function councilSuggestsClosing(discussion: CouncilDiscussion): boolean {
  const { speeches, round } = discussion;
  if (discussion.format === 'roundtable') {
    const summary = speeches.findLast(s => s.round === round && s.phase === 'summary')?.directive;
    return summary?.kind === 'moderation' && summary.action === 'conclude';
  }
  if (discussion.format !== 'ld') return false;
  const ledger = speeches.findLast(s => s.round === round && s.phase === 'ledger')?.directive;
  if (ledger?.kind !== 'ledger') return false;
  if (ledger.action === 'closing') return true;
  const previous = speeches.findLast(s => s.round === round - 1 && s.phase === 'ledger')?.directive;
  return ledger.intensity === 'stalling' && previous?.kind === 'ledger' && previous.intensity === 'stalling';
}

/** A discussion as the history list shows it. */
/** A seat as a new discussion of the same format would take it again. */
export type CouncilSeatChoice = Pick<CouncilSeat, 'role' | 'model' | 'task'>;
export type CouncilSummary = Pick<CouncilDiscussion, 'id' | 'format' | 'title' | 'status' | 'createdAt' | 'updatedAt' | 'maxRounds' | 'rhythm'> & {
  /** Who sat where: what the launch page starts the next discussion of this format from. */
  seats: CouncilSeatChoice[];
};

export interface CouncilSeatRequest {
  role: CouncilRole;
  model: CouncilAgent;
  task?: CouncilReviewTask;
}

export interface CouncilCreateRequest {
  format: CouncilFormat;
  topic: string;
  seats: CouncilSeatRequest[];
  maxRounds?: number;
  rhythm?: CouncilRhythm;
  /** Review: the document text. */
  document?: string;
  documentTitle?: string;
}

export interface CouncilContinueRequest {
  /** `next` runs the next round; `conclude` wraps up (LD: the next round is the closing one). */
  action?: 'next' | 'conclude';
}

export interface CouncilSupplementRequest {
  text: string;
}

export interface CouncilPatchRequest {
  /** Review: accept or drop one proposed edit. */
  edit?: { id: string; accepted: boolean };
}

export interface CouncilExportRequest {
  kind: 'task' | 'session';
  body: string;
  projectId?: string;
  backendId?: NativeBackendId;
  model?: string;
}

export interface CouncilExportResult {
  kind: 'task' | 'session';
  id: string;
}

export type CouncilStreamEvent =
  | { type: 'snapshot'; discussion: CouncilDiscussion }
  | { type: 'speech'; discussionId: string; version: number; speech: CouncilSpeech }
  /** The rows of a speech's turn in its seat conversation as they change: thinking, tool calls, the answer. */
  | { type: 'rows'; discussionId: string; speechId: string; upserts: TimelineRow[]; deletes: string[] };

/** Current seat brief, or the original input of a selected speech and its bookkeeping turn. */
export interface CouncilPrompts { prompt?: string; record?: string }

/** `GET /api/council/:id/speeches/:speechId/rows`: a finished speech's turn, read when the reader opens it. */
export interface CouncilSpeechRows { rows: TimelineRow[] }
