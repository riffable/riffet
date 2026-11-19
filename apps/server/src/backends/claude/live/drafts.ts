/**
 * Which part of what the screen shows is still to come in the transcript, as journal drafts (`LaneBatch.drafts`).
 *
 * The transcript stays the record. A draft stands for the text block the CLI is drawing and is taken back in the same
 * commit as the row that writes that block (`committed`), or when its turn is over (`plan`). Deciding that a block is
 * already written errs towards yes, since the cost is a moment without streaming, where a wrong no shows the answer
 * twice. Three checks, any one enough:
 *
 * 1. The turn's prompt echo is on screen and the screen has no more text blocks after it than the transcript has.
 * 2. The block starts like a text the transcript already has in this turn.
 * 3. The block starts like a draft the transcript replaced: the same drawing, so it matches whatever Markdown lost.
 *
 * Only a turn seen opening in this process is drafted: what it committed before is unknown after a restart.
 */
import { CLAUDE_LIVE_SCREEN_BUDGET } from '../../../../../../packages/contracts/src/index.js';
import type { NativeWorkbenchEvent } from '../../../../../../packages/contracts/src/index.js';
import { screenMarkdown } from './markdown.js';
import { CLAUDE_SCREEN_LAYOUT, readScreenTurn } from './screen.js';

export interface ScreenTail { text: string; cols: number }

export interface LiveDraftPlan { drafts: Array<{ finalId: string; event: NativeWorkbenchEvent }>; retire: string[] }

/** A draft whose transcript text says something else: the layout contract has likely moved (`screen.ts`). */
export interface LiveDrift { sessionId: string; turnId: string; ratio: number; draftChars: number; textChars: number }

/** Characters of a text's start compared: enough that two blocks cannot share it by chance. */
const KEY = 48;
/** Draft characters checked against the transcript text for drift, in pieces of this length. */
const DRIFT_CHARS = 4_096;
const DRIFT_PIECE = 16;

interface TurnState {
  /** The prompt, normalized; the echo is matched against it. */
  prompt?: string;
  runId?: string;
  /** Committed text blocks: ids and normalized starts. */
  ids: Set<string>;
  texts: string[];
  draft?: { id: string; text: string; key: string };
  /** Starts of drafts their text replaced, as drawn. */
  replaced: string[];
}

/** Letters and digits only: what Markdown and the TUI's rendering of it agree on. Link targets are not drawn. */
export function normalizeText(text: string): string {
  return text.replace(/\]\([^)\s]*\)/g, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

/**
 * Whether a block drawn starting with `key` is the one that started with `known` (both cut to `KEY`). A block just begun
 * matches any it could still grow into; a short one, done, only itself.
 */
function sameBlock(known: string, key: string): boolean {
  if (key.length < KEY) return known.startsWith(key);
  return known.length === KEY && known === key;
}

/** How much of the draft is found in the text, piece by piece. */
function overlap(draft: string, text: string): number {
  const sample = draft.slice(0, DRIFT_CHARS);
  let found = 0, pieces = 0;
  for (let at = 0; at + DRIFT_PIECE <= sample.length; at += DRIFT_PIECE, pieces += 1) if (text.includes(sample.slice(at, at + DRIFT_PIECE))) found += 1;
  return pieces ? found / pieces : 1;
}

function textOf(event: NativeWorkbenchEvent): string | undefined {
  const content = event.data.content as { type?: unknown; text?: unknown } | undefined;
  return event.data.hidden !== true && content?.type === 'text' && typeof content.text === 'string' && content.text.trim() ? content.text : undefined;
}

export class ClaudeLiveDrafts {
  private readonly turns = new Map<string, TurnState>();
  /** Drafts of turns no longer remembered, taken back by the next plan. */
  private orphans: string[] = [];
  private reportedAt = -Infinity;

  constructor(private readonly options: { sessionId: string; clip(text: string): string; report?(drift: LiveDrift): void }) {}

  /** A turn opened while this process read the transcript: what it commits from here on is all of it. */
  opened(turnId: string): void {
    if (this.turns.has(turnId)) return;
    this.turns.set(turnId, { ids: new Set(), texts: [], replaced: [] });
    for (const [id, turn] of this.turns) {
      if (this.turns.size <= CLAUDE_LIVE_SCREEN_BUDGET.turns) break;
      if (turn.draft) this.orphans.push(turn.draft.id);
      this.turns.delete(id);
    }
  }

  watching(turnId: string | undefined): boolean {
    return turnId !== undefined && this.turns.has(turnId);
  }

  /** The main lane committed `events`; returns the drafts they replace, to retire in that commit. */
  committed(events: readonly NativeWorkbenchEvent[]): string[] {
    const retire: string[] = [];
    for (const event of events) {
      const turn = event.nativeTurnId ? this.turns.get(event.nativeTurnId) : undefined;
      if (!turn) continue;
      if (event.runId) turn.runId = event.runId;
      const text = textOf(event);
      if (!text) continue;
      if (event.type === 'user_message_chunk') { turn.prompt ??= normalizeText(text); continue; }
      if (event.type !== 'agent_message_chunk' || turn.ids.has(event.nativeId)) continue;
      turn.ids.add(event.nativeId);
      const normalized = normalizeText(text);
      turn.texts.push(normalized.slice(0, KEY));
      const draft = turn.draft;
      if (!draft) continue;
      retire.push(draft.id);
      turn.replaced.push(draft.key);
      turn.draft = undefined;
      this.checkDrift(event.nativeTurnId!, normalizeText(draft.text), normalized);
    }
    return retire;
  }

  /**
   * What the screen of turn `turnId` (the lane's open one, if any) changes in the lane. Drafts of any other turn are
   * taken back: it ended, and what it said is in the transcript or nowhere.
   */
  plan(turnId: string | undefined, tail: ScreenTail | undefined, at: string): LiveDraftPlan {
    const plan: LiveDraftPlan = { drafts: [], retire: this.orphans };
    this.orphans = [];
    for (const [id, turn] of this.turns) {
      if (id === turnId || !turn.draft) continue;
      plan.retire.push(turn.draft.id);
      turn.draft = undefined;
    }
    const turn = turnId !== undefined ? this.turns.get(turnId) : undefined;
    // A screen that does not read as the contract says leaves the draft as it was: it is drawn again shortly.
    const screen = turn && tail ? readScreenTurn(tail.text) : undefined;
    const last = screen?.blocks.at(-1);
    if (!turn || !screen || last?.kind !== 'text') return plan;
    const text = this.options.clip(screenMarkdown(last.lines, tail!.cols - CLAUDE_SCREEN_LAYOUT.indent.length));
    const key = normalizeText(text).slice(0, KEY);
    if (!key) return plan;
    const echo = screen.prompt !== undefined ? normalizeText(screen.prompt).slice(0, KEY) : undefined;
    const anchored = echo !== undefined && turn.prompt !== undefined && echo.length > 0 && turn.prompt.startsWith(echo);
    const written = (anchored && screen.blocks.filter(block => block.kind === 'text').length <= turn.texts.length)
      || turn.texts.some(known => sameBlock(known, key))
      || turn.replaced.some(known => sameBlock(known, key));
    if (written) return plan;
    const id = `claude-live:${turnId}:${turn.texts.length}`;
    if (turn.draft?.id === id && turn.draft.text === text) return plan;
    turn.draft = { id, text, key };
    plan.drafts.push({
      finalId: id,
      event: {
        sessionId: this.options.sessionId, nativeId: id, nativeTurnId: turnId!, ...(turn.runId ? { runId: turn.runId } : {}),
        sequence: 0, createdAt: at, type: 'agent_message_chunk',
        data: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    });
    return plan;
  }

  private checkDrift(turnId: string, draft: string, text: string): void {
    const ratio = overlap(draft, text);
    if (ratio * 100 >= CLAUDE_LIVE_SCREEN_BUDGET.driftPercent || !this.options.report) return;
    const now = Date.now();
    if (now - this.reportedAt < CLAUDE_LIVE_SCREEN_BUDGET.reportMs) return;
    this.reportedAt = now;
    this.options.report({ sessionId: this.options.sessionId, turnId, ratio: Math.round(ratio * 100) / 100, draftChars: draft.length, textChars: text.length });
  }
}
