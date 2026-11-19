import { councilModelName, type CouncilDiscussion, type CouncilPhase, type CouncilSeat, type CouncilSpeech } from '../../../../../packages/contracts/src/index.js';

/**
 * What one speech asks of its seat. The seat's conversation remembers what it was told and said, so a
 * turn carries only the task; the service puts what others said since in front of it (`compose`).
 */
export interface SpeechPrompt {
  task: string;
  /**
   * A speech whose notes later prompts read: the JSON shape and its rules, asked for in a turn of its own after the
   * speech, so the speech itself stays prose.
   */
  record?: string;
}

/** One speech the format wants next; the speeches of one step run at the same time. */
export interface SpeechSpec {
  seatId: string;
  round: number;
  phase: CouncilPhase;
  prompt: SpeechPrompt;
}

/**
 * - `speak`: run these speeches, then plan again.
 * - `round-end`: the reader's round is over and another may follow; `auto` goes on, `pause` waits.
 * - `done`: nothing is left.
 */
export type Step = { kind: 'speak'; speeches: SpeechSpec[] } | { kind: 'round-end' } | { kind: 'done' };

export interface FormatSpec {
  /** What runs next, read off the speeches alone so a stopped or restarted discussion resumes in place. */
  plan(d: CouncilDiscussion): Step;
  /** Who the seat is, how it speaks and what the discussion is about: the opening of its conversation. */
  brief(d: CouncilDiscussion, seat: CouncilSeat): string;
  /** Whether `seat` is told of another seat's `speech`; every one by default. */
  hears?(d: CouncilDiscussion, seat: CouncilSeat, speech: CouncilSpeech): boolean;
  /** At a round end in `auto`, before the next round is let run: the format may decide to wrap up. */
  autoAdvance?(d: CouncilDiscussion): void;
  /** The reader asks to wrap up at a round end. */
  conclude(d: CouncilDiscussion): void;
}

export const LANGUAGE_RULE = 'Write in the language the topic is written in. Plain Markdown; no preamble, no title line.';

/** A seat's conversation is an Agent's: it could act, but here it only speaks. */
export const SEAT_RULE = 'This is a discussion, not a task: do not change any file. Look things up only when a claim needs checking, and never invent facts, figures or sources.';

export function seat(d: CouncilDiscussion, seatId: string): CouncilSeat {
  const found = d.seats.find(item => item.id === seatId);
  if (!found) throw new Error(`Seat ${seatId} is missing`);
  return found;
}

export function seatsOf(d: CouncilDiscussion, role: CouncilSeat['role']): CouncilSeat[] {
  return d.seats.filter(item => item.role === role);
}

export function spoken(d: CouncilDiscussion, round: number, phase: CouncilPhase, seatId?: string): CouncilSpeech | undefined {
  return d.speeches.find(s => s.round === round && s.phase === phase && (seatId === undefined || s.seatId === seatId));
}

/** Directive of the latest speech in `phase`, if it recorded one. */
export function latestDirective<K extends NonNullable<CouncilSpeech['directive']>['kind']>(d: CouncilDiscussion, phase: CouncilPhase, kind: K) {
  const speech = d.speeches.findLast(s => s.phase === phase && s.directive?.kind === kind);
  return speech?.directive as Extract<NonNullable<CouncilSpeech['directive']>, { kind: K }> | undefined;
}

/** How models name a seat: its id, which the notes use, and its model. */
export function speaker(d: CouncilDiscussion, seatId: string): string {
  const item = seat(d, seatId);
  return `[${item.id}] ${councilModelName(item.model) ?? item.profileName}`;
}

export const speak = (...speeches: SpeechSpec[]): Step => ({ kind: 'speak', speeches });

export function wordLimit(base: number, speakers: number): number {
  return Math.max(150, Math.round(base / Math.max(1, speakers)));
}

export function closingRoundOf(d: CouncilDiscussion): number {
  return Math.min(d.closingRound ?? d.maxRounds, d.maxRounds);
}

const PHASE_NAMES: Record<CouncilPhase, string> = {
  opening: 'opening', rebuttal: 'rebuttal', closing: 'closing', ledger: "judge's notes",
  statement: 'statement', summary: "moderator's summary",
  explore: 'first answer', probe: "observer's probe", deepen: 'response to the probe',
  review: 'review', conclusion: 'conclusion',
};

/**
 * The turn a seat is sent for `spec`: its brief on the first, then what others said and the reader noted since it last
 * spoke, then the task. Returns what the seat has now heard, to be kept once the turn is sent.
 */
export function compose(format: FormatSpec, d: CouncilDiscussion, target: CouncilSeat, spec: SpeechSpec): { text: string; heard: string[] } {
  const heard = new Set(target.heard ?? []);
  const first = !target.sessionId;
  const news = d.speeches.filter(s => s.seatId !== target.id && s.status === 'done' && !heard.has(s.id) && (format.hears?.(d, target, s) ?? true));
  const notes = d.supplements.filter(note => !heard.has(`note:${note.id}`));
  const parts: string[] = [];
  if (first) parts.push(format.brief(d, target));
  if (news.length) {
    parts.push(`${first ? 'The discussion so far' : 'Said since your last turn'}:\n\n${news.map(s => `### Round ${s.round}, ${PHASE_NAMES[s.phase]} — ${speaker(d, s.seatId)}\n${s.text}`).join('\n\n')}`);
  }
  if (notes.length) parts.push(`Notes the reader added (context to weigh, not authority):\n${notes.map(note => `- ${note.text}`).join('\n')}`);
  parts.push(spec.prompt.task);
  return { text: parts.join('\n\n'), heard: [...heard, ...news.map(s => s.id), ...notes.map(note => `note:${note.id}`)] };
}

/** The follow-up turn that asks a seat for its notes. */
export function recordTurn(record: string): string {
  return `Now record your notes on that speech for the discussion's bookkeeping; the reader does not see them. Reply with one JSON object and nothing else — no prose, no code fence — of this shape:\n${record}`;
}
