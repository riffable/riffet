import type { Session, TurnOutlineV3 } from '@contracts';
import { attachmentsOf, callLabel, plainText, turnKey, type Actor, type Artifact, type FileChange, type Step, type Track, type TurnDetail } from './detail';

/*
 * One conversation as a timeline. Time runs left to right: each turn is a column, its question on
 * a spine along the top that carries the conversation from one turn to the next, its answer below.
 *
 * Beneath the answers the row splits into tracks, each a timeline of one kind of work on the same
 * columns: the files written (one track per directory, the project's first, each a ledger printed
 * on the track), what the turn showed or made (images and pages, as thumbnails), the subagents and
 * background tasks (each a bar from the turn that started it to the turn it reported in), the
 * commands run, what was read and searched, what was looked up on the web, what the reader was
 * asked, and any other tool. Down a column is that moment in cross-section; along a track, how one
 * kind of work went. The calls are not cards but marks on a strip, each column's width its turn's
 * own clock, so the strips of one column read as one moment, and a few calls are named beneath.
 * Joined end to end those clocks make the row's clock, which the subagents' bars run on. Where the
 * context was compacted the row has a seam: a narrow column of its own for a `/compact`, a dashed
 * line through the tracks at the moment it happened for one the agent made mid-turn. A forked conversation is a row of its own beneath, starting under the turn it
 * branched from, the way a branch leaves a commit.
 *
 * The layout has two levels. `summary` keeps every card compact; `detail` (the reader has zoomed in)
 * opens each answer into its thinking and words, each sheet into its changed lines, and names more
 * of the calls on each strip. Every node carries the time it came to be (`t`), so the same layout
 * replays the conversation by revealing what existed at a moment.
 */

/** A path under the home directory, written with `~`. */
const tildePath = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');

export type Level = 'summary' | 'detail';

/** A column's width and the gap between columns (room for a silence). */
const SIZE = {
  summary: { colW: 320, gap: 96 },
  detail: { colW: 460, gap: 112 },
} as const;
/**
 * The track names' margin, the title row, the time row above the questions, the drop to the answers,
 * the space above the first track and between tracks, between stacked bars, and between rows.
 */
const LABEL_W = 132, HEADER_H = 44, TIME_H = 26, LEAD_GAP = 28, TRACKS_TOP = 40, TRACK_GAP = 28, BAR_GAP = 10, LANE_GAP = 120, FRAME_PAD = 28;

/** Pixel heights the cards render at; the renderer uses the same numbers, so the layout's sizes are the cards' own. */
export const ROW = {
  agentPad: 14,
  meta: 22,
  line: 19,
  toolRow: 22,
  planRow: 20,
  actorRow: 28,
  divider: 20,
  blockGap: 8,
  steerLine: 17,
  attachments: 24,
  /** Thumbnails of image attachments, and the space above them. */
  thumbs: 52,
  signalRow: 22,
} as const;
/** A ledger of writes: its head, one file's row, one previewed line, a preview's inset and the space beneath it. */
export const CHANGE = { head: 24, file: 22, line: 15, inset: 5, gap: 4, files: { summary: 3, detail: 4 }, lines: 6 } as const;
/** An artifact's thumbnail, the gap between them, and the caption beneath. */
export const ART = { w: 96, h: 64, gap: 10, caption: 22 } as const;
/** A strip's padding, the row its marks sit on, one row of names beneath, and the margin at each end of its column. */
export const STRIP = { pad: 6, marks: 20, callout: 17, inset: 8 } as const;
/** A subagent's bar: its padding, its name's row above the bar, the bar's row, and its conclusion's row. */
export const BAR = { pad: 4, label: 18, bar: 12, line: 16 } as const;
/** A compaction's own column, and the pin it shows on the spine. */
const SEAM_W = 168, PIN_H = 26;
/** The empty question after the last one, where the next is written. */
const NEXT_H = 44;
/** Where a track's line runs below its top: through the middle of a strip's marks or a subagent's bar, or of a card's head. */
export const trackLine = (track: { kind: string }) => track.kind === 'write' ? CHANGE.head / 2 : track.kind === 'artifacts' ? ART.h / 2 : track.kind === 'actors' ? BAR.pad + BAR.label + BAR.bar / 2 : STRIP.pad + STRIP.marks / 2;
/** How many of a strip's calls are named beneath it, compact and opened. */
const CALLOUTS: Record<Track, { summary: number; detail: number }> = {
  shell: { summary: 3, detail: 4 },
  explore: { summary: 2, detail: 3 },
  web: { summary: 2, detail: 3 },
  ask: { summary: 2, detail: 2 },
  other: { summary: 2, detail: 3 },
};
const MAX_PLAN_SHOWN = 6, ANSWER_LINES = 14, USER_LINES = 14;

type Box = { x: number; y: number; w: number; h: number };
type OriginKind = NonNullable<Session['origin']>['kind'];

/** One block of an answer opened at the `detail` level. */
export type Block =
  | { kind: 'thought'; key: string; text: string; h: number }
  | { kind: 'commentary'; key: string; text: string; h: number }
  /** A run of tool calls folded to counts, where the tracks below show them in full. */
  | { kind: 'calls'; key: string; steps: Step[]; h: number }
  | { kind: 'plan'; key: string; step: Step; hidden: number; h: number }
  | { kind: 'actor'; key: string; step: Step; h: number }
  | { kind: 'compaction'; key: string; step: Step; h: number }
  | { kind: 'status'; key: string; step: Step; h: number }
  | { kind: 'answer'; key: string; text: string; lines: number; h: number };

/**
 * What started a turn. A `prompt` is the reader's own message; a `brief` the summary a fork or
 * handoff opened with; `scheduled` a task the workbench ran on its own; a `command` a slash command.
 */
export type PromptKind = 'prompt' | 'brief' | 'scheduled' | 'command';

export type FlowNode =
  | (Box & { kind: 'header'; id: string; session: Session; t: number; fork?: OriginKind; written?: { files: number; added: number; removed: number } })
  | (Box & { kind: 'user'; id: string; session: Session; turn: TurnOutlineV3; variant: PromptKind; origin?: OriginKind; text: string; lines: number; detail?: TurnDetail; t: number })
  | (Box & { kind: 'signal'; id: string; session: Session; turn: TurnOutlineV3; detail?: TurnDetail; t: number })
  | (Box & { kind: 'agent'; id: string; session: Session; turn: TurnOutlineV3; detail?: TurnDetail; blocks?: Block[]; summary?: string; previewLines: number; t: number; end: number })
  /**
   * A subagent or background task as a bar on the row's clock, [bar] wide from the node's left, with
   * a dotted run on to where it reported in ([report]); its own calls ticked along it once its lane
   * is read, and opened, the first line of what it concluded.
   */
  | (Box & { kind: 'actor'; id: string; session: Session; turn: TurnOutlineV3; actor: Actor; inner?: TurnDetail; bar: number; report?: number; steps: Step[]; marks: Mark[]; conclusion?: string; t: number; end: number })
  /** A `/compact` turn: a pin on the spine, its seam running down the row. */
  | (Box & { kind: 'fold'; id: string; session: Session; turn: TurnOutlineV3; tokens: string; t: number })
  /**
   * What an answer wrote under one directory ([base], shown paths are relative to it), as a ledger;
   * `lines` is how many preview lines each shown file opens to (none in summary).
   */
  | (Box & { kind: 'change'; id: string; session: Session; turn: TurnOutlineV3; agent: string; base: string; changes: FileChange[]; shown: number; lines: number[]; t: number })
  /** What a turn showed or made: its [items] as thumbnails, the first [shown] of them, the rest a count. */
  | (Box & { kind: 'artifacts'; id: string; session: Session; turn: TurnOutlineV3; agent: string; items: Artifact[]; shown: number; t: number })
  /** An answer's calls of one kind, as marks on its turn's clock, a few named beneath. */
  | (Box & { kind: 'tools'; id: string; session: Session; turn: TurnOutlineV3; agent: string; track: Track; steps: Step[]; marks: Mark[]; callouts: Callout[]; t: number });

/** One call on a strip: which step, and where it starts and ends across the column. */
export interface Mark { index: number; x: number; x2: number }
/** A call named beneath a strip: its leader's x, its row, which side of the leader the name runs, and how wide. */
export interface Callout { index: number; x: number; row: number; side: 'left' | 'right'; w: number }

export type EdgeKind = 'prompt' | 'reply' | 'fork';

export interface FlowEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  path: string;
  t: number;
  /** A reply edge across a long silence: how long it was, and where to say so. */
  gap?: number;
  mid?: [number, number];
}

/** The project a column ran in. */
export interface Frame extends Box { id: string; session: Session; project?: string; branch?: string }

export interface GutterMark { id: string; x: number; y: number; t: number; day: boolean }

/** Where the context was compacted: a dashed line down the row, with its tokens before and after where the agent did it mid-turn. */
export interface Seam { id: string; x: number; top: number; bottom: number; t: number; tokens?: string }

/** One track of a row: its kind, its name (a directory's, for writes), and the band it occupies. */
export interface TrackBand { id: string; sessionId: string; kind: 'write' | 'artifacts' | 'actors' | Track; label: string; external: boolean; x: number; w: number; y: number; h: number }

/** The slot for the conversation's next question: one column past the last, shaped like a question. */
export type FlowNext = Box & { id: string; session: Session };

export interface FlowLayout {
  nodes: FlowNode[];
  /** Only on the row of the session asked for. */
  next?: FlowNext;
  edges: FlowEdge[];
  frames: Frame[];
  gutter: GutterMark[];
  tracks: TrackBand[];
  seams: Seam[];
  bounds: Box;
}

const time = (value: string | undefined) => value ? Date.parse(value) || 0 : 0;
const GAP_MS = 30 * 60_000;

/** How many lines [text] wraps to in [width] pixels at [font] pixels: CJK glyphs are square, Latin about half. */
export function lineCount(text: string, width: number, font = 13): number {
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    let px = 0;
    for (const char of paragraph) px += /[⺀-鿿가-힯＀-￯]/.test(char) ? font : font * 0.52;
    lines += Math.max(1, Math.ceil(px / width));
  }
  return lines;
}

/** Horizontal S-curve from [a] to [b]. */
function across(a: readonly [number, number], b: readonly [number, number]): string {
  const dx = Math.max(36, Math.abs(b[0] - a[0]) * 0.5);
  return `M ${a[0]} ${a[1]} C ${a[0] + dx} ${a[1]} ${b[0] - dx} ${b[1]} ${b[0]} ${b[1]}`;
}
/** About how wide [text] sets at [font] pixels: CJK glyphs square, monospace 0.6 of the size, other Latin 0.55. */
function textWidth(text: string, font: number, mono: boolean): number {
  let px = 0;
  for (const char of text) px += /[⺀-鿿가-힯＀-￯]/.test(char) ? font : font * (mono ? 0.6 : 0.55);
  return px;
}

/**
 * One turn's calls of one kind as a strip across its column, start to end of the turn: where each
 * call ran on that clock, and which few to name beneath — what is running, what failed, then the
 * track's own choice (the longest commands, the searches before the reads, the rest in order).
 * Names stack in rows so that none overlaps another, nor a leader dropping past it to a lower row.
 */
function stripOf(track: Track, steps: readonly Step[], from: number, to: number, width: number, names: number): { marks: Mark[]; callouts: Callout[]; h: number } {
  const span = Math.max(to, ...steps.map((step) => step.end), from + 1000) - from;
  const inner = width - STRIP.inset * 2;
  const at = (value: number) => STRIP.inset + Math.min(1, Math.max(0, ((value || from) - from) / span)) * inner;
  // A turn read back from a transcript can stamp every call with the moment it began; its calls are
  // then only in order, and are spaced evenly.
  const timed = steps.length < 2 || new Set(steps.map((step) => Math.round(step.start / 1000))).size > steps.length / 2;
  const marks = timed
    ? steps.map((step, index) => ({ index, x: at(step.start), x2: Math.max(at(step.start), at(step.end)) }))
    : steps.map((_, index) => { const x = STRIP.inset + ((index + 0.5) / steps.length) * inner; return { index, x, x2: x }; });

  const weight = (step: Step) => (step.running ? 0 : step.failed ? 1 : 2);
  const ranked = steps.map((step, index) => ({ step, index })).sort((a, b) => weight(a.step) - weight(b.step)
    || (track === 'shell' ? (b.step.end - b.step.start) - (a.step.end - a.step.start)
      : track === 'explore' ? (a.step.kindName === 'search' ? 0 : 1) - (b.step.kindName === 'search' ? 0 : 1) || a.index - b.index
        : a.index - b.index));
  const rows: Array<Array<[number, number]>> = [];
  const leaders: Array<{ x: number; row: number }> = [];
  const callouts: Callout[] = [];
  const said = new Set<string>();
  const most = Math.min(Math.round(width * 0.68), 300);
  for (const { step, index } of ranked) {
    if (callouts.length >= names) break;
    const label = callLabel(step, track);
    if (said.has(label.text)) continue;
    const mark = marks[index]!;
    const x = track === 'shell' ? Math.min((mark.x + mark.x2) / 2, mark.x + 6) : mark.x;
    const want = Math.min(most, textWidth(label.text, label.mono ? 10.5 : 11, label.mono) + (label.aside ? 8 + textWidth(label.aside, 10.5, false) : 0) + 2);
    const room = { right: width - STRIP.inset - x - 6, left: x - STRIP.inset - 6 };
    const side = room.right >= want || room.right >= room.left ? 'right' : 'left';
    const w = Math.min(want, room[side]);
    if (w < 48) continue;
    const reach: [number, number] = side === 'right' ? [x, x + 6 + w] : [x - 6 - w, x];
    let row = 0;
    for (; row < names; row += 1) {
      const free = !(rows[row] ?? []).some(([a, b]) => reach[0] < b + 10 && a < reach[1] + 10)
        && !leaders.some((leader) => leader.row > row && leader.x >= reach[0] - 4 && leader.x <= reach[1] + 4)
        && !rows.slice(0, row).some((spans) => spans.some(([a, b]) => x >= a - 4 && x <= b + 4));
      if (free) break;
    }
    if (row >= names) continue;
    (rows[row] ??= []).push(reach);
    leaders.push({ x, row });
    callouts.push({ index, x, row, side, w });
    said.add(label.text);
  }
  const used = callouts.length ? Math.max(...callouts.map((callout) => callout.row)) + 1 : 0;
  return { marks, callouts, h: STRIP.pad + STRIP.marks + (used ? used * STRIP.callout + 4 : 0) + STRIP.pad };
}

/**
 * The directory a written file belongs to: the project for a path inside it, else a folder two
 * levels into the home directory (or the filesystem root), which is where a separate project usually sits.
 */
function writeRoot(path: string): { key: string; base: string } {
  if (!path.startsWith('/') && !path.startsWith('~')) return { key: '', base: '' };
  const parts = path.split('/');
  const home = parts[1] === 'Users' || parts[1] === 'home' ? 3 : 1;
  const base = parts.slice(0, Math.min(parts.length - 1, home + 2)).join('/');
  return { key: base, base };
}

/** How tall a ledger stands with [shown] files, each opened to [lines] preview lines, and [hidden] more. */
export function changeHeight(shown: number, lines: readonly number[], hidden: boolean): number {
  let h: number = CHANGE.head;
  for (let index = 0; index < shown; index += 1) {
    const count = lines[index] ?? 0;
    h += CHANGE.file + (count ? count * CHANGE.line + CHANGE.inset * 2 + CHANGE.gap : 0);
  }
  return h + (hidden ? CHANGE.file : 0);
}

/** An answer's steps as the blocks its opened card lists, top to bottom. */
export function blocksOf(detail: TurnDetail, width: number): Block[] {
  const blocks: Block[] = [];
  const inner = width - ROW.agentPad * 2;
  let tools: Step[] = [];
  const flush = () => {
    if (!tools.length) return;
    blocks.push({ kind: 'calls', key: `calls|${tools[0]!.key}`, steps: tools, h: ROW.toolRow });
    tools = [];
  };
  for (const step of detail.steps) {
    if (step.kind === 'tool') { tools.push(step); continue; }
    flush();
    if (step.kind === 'thought') blocks.push({ kind: 'thought', key: step.key, text: step.label, h: Math.min(2, lineCount(step.label, inner - 20, 12)) * 18 });
    else if (step.kind === 'commentary') blocks.push({ kind: 'commentary', key: step.key, text: step.label, h: Math.min(2, lineCount(step.label, inner, 12.5)) * 18 });
    else if (step.kind === 'subagent' || step.kind === 'background') blocks.push({ kind: 'actor', key: step.key, step, h: ROW.actorRow });
    else if (step.kind === 'plan' && step.entries?.length) {
      const shown = Math.min(step.entries.length, MAX_PLAN_SHOWN);
      const hidden = step.entries.length - shown;
      blocks.push({ kind: 'plan', key: step.key, step, hidden, h: 22 + (shown + (hidden ? 1 : 0)) * ROW.planRow + 6 });
    } else if (step.kind === 'compaction') blocks.push({ kind: 'compaction', key: step.key, step, h: ROW.divider });
    else if (step.kind === 'status' && step.failed) blocks.push({ kind: 'status', key: step.key, step, h: ROW.toolRow });
  }
  flush();
  if (detail.answer) {
    const text = plainText(detail.answer);
    const lines = Math.min(ANSWER_LINES, lineCount(text, inner, 13));
    blocks.push({ kind: 'answer', key: 'answer', text, lines, h: lines * ROW.line + 10 });
  }
  return blocks;
}

export function blocksHeight(blocks: readonly Block[]): number {
  return blocks.reduce((sum, block) => sum + block.h + ROW.blockGap, 0);
}

function anchorTurn(turns: readonly TurnOutlineV3[], runId: string | undefined, createdAt: string): TurnOutlineV3 | undefined {
  if (runId) {
    const named = turns.find((turn) => turn.runId === runId);
    if (named) return named;
  }
  return turns.filter((turn) => turn.at <= createdAt).at(-1) ?? turns.at(-1);
}

function promptKind(text: string, first: boolean, origin: OriginKind | undefined): PromptKind {
  if (first && (origin === 'fork' || origin === 'handoff')) return 'brief';
  if (first && (origin === 'schedule' || origin === 'template')) return 'scheduled';
  if (/^\/[\w:-]+(\s|$)/.test(text) && !text.includes('\n')) return 'command';
  return 'prompt';
}

/**
 * [sessions] is one family: a conversation with what it was forked from and what was forked from it.
 * [lanes] holds the subagent transcripts read so far, by `sessionId|lane`; [projectOf] names where a
 * session ran.
 */
export function layoutFlow(
  sessions: readonly Session[],
  outlines: ReadonlyMap<string, readonly TurnOutlineV3[]>,
  details: ReadonlyMap<string, TurnDetail>,
  lanes: ReadonlyMap<string, TurnDetail | null>,
  now: number,
  level: Level,
  projectOf: (session: Session) => { name?: string; branch?: string },
  /**
   * [summaries] are the one-sentence answers by turn key; [broken] the artifacts whose image would not load; [next] the session whose row ends
   * in a slot for its next question; [sending] that a question was sent from the slot and its turn has not come yet.
   */
  { summaries = new Map<string, string>(), broken = new Set<string>(), next, sending = false }: { summaries?: ReadonlyMap<string, string>; broken?: ReadonlySet<string>; next?: string; sending?: boolean } = {},
): FlowLayout {
  const { colW, gap } = SIZE[level];
  const nextSlots: FlowNext[] = [];
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const frames: Frame[] = [];
  const gutter: GutterMark[] = [];
  const tracks: TrackBand[] = [];
  const seams: Seam[] = [];
  const agents = new Map<string, Extract<FlowNode, { kind: 'agent' }>>();
  /** Where each row's frame ends, for a branch to leave from beneath it. */
  const laneBottom = new Map<string, number>();
  const ids = new Set(sessions.map((session) => session.id));
  const parentOf = (session: Session) => session.origin?.sessionId && ids.has(session.origin.sessionId) && session.origin.sessionId !== session.id ? session.origin.sessionId : undefined;
  const children = new Map<string, Session[]>();
  const roots: Session[] = [];
  for (const session of sessions) {
    const parent = parentOf(session);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), session]);
    else roots.push(session);
  }
  for (const list of [roots, ...children.values()]) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  /** Where the next row may start: below everything placed so far. */
  let floor = -LANE_GAP;
  const placed = new Set<string>();

  const placeLane = (session: Session, left: number, fork?: { agent: Extract<FlowNode, { kind: 'agent' }>; kind: OriginKind }) => {
    if (placed.has(session.id)) return;
    placed.add(session.id);
    const top = floor + LANE_GAP + FRAME_PAD + 8;
    const turns = outlines.get(session.id) ?? [];
    const turnDetails = turns.map((turn) => details.get(turnKey(session.id, turn.turn)));
    const place = projectOf(session);
    // A `/compact` turn says nothing and does nothing else: it is a seam, narrower than a turn's column.
    const folds = turnDetails.map((detail) => {
      const step = detail?.steps.find((item) => item.kind === 'compaction');
      return step && !detail!.answer && !detail!.tools && !detail!.actors.length && (!detail!.userText || /^\/compact\b/.test(detail!.userText.trim())) ? step : undefined;
    });
    const widths = turns.map((_, index) => folds[index] ? SEAM_W : colW);
    const xs: number[] = [];
    widths.forEach((width, index) => xs.push(index ? xs[index - 1]! + widths[index - 1]! + gap : left + LABEL_W));
    const columnX = (index: number) => xs[index]!;

    // Everything the conversation wrote, file by file, for the line beside its title.
    const written = new Map<string, { added: number; removed: number }>();
    for (const change of turnDetails.flatMap((detail) => detail?.changes ?? [])) {
      const sum = written.get(change.path) ?? { added: 0, removed: 0 };
      written.set(change.path, { added: sum.added + change.added, removed: sum.removed + change.removed });
    }
    const totals = [...written.values()].reduce((sum, item) => ({ added: sum.added + item.added, removed: sum.removed + item.removed }), { added: 0, removed: 0 });

    // The questions first: they share one row. Compact, the answers start together beneath the
    // tallest; opened, a long question would leave the rest hanging far above theirs, so each answer
    // follows its own.
    const leadTop = top + HEADER_H + TIME_H;
    const leadW = colW - 32;
    const leads = turns.map((outline, index): Extract<FlowNode, { kind: 'user' | 'signal' | 'fold' }> => {
      const detail = turnDetails[index];
      const x = columnX(index);
      const t = time(outline.at);
      const fold = folds[index];
      if (fold) return { kind: 'fold', id: `fold|${session.id}|${outline.turn}`, session, turn: outline, tokens: fold.label, x, y: leadTop + 20 - PIN_H / 2, w: SEAM_W, h: PIN_H, t };
      if (outline.hasUserMessage === false) {
        const arrivals = detail?.arrivals.length ?? 0;
        return { kind: 'signal', id: `signal|${session.id}|${outline.turn}`, session, turn: outline, ...(detail ? { detail } : {}), x, y: leadTop, w: leadW, h: 16 + Math.max(1, arrivals) * ROW.signalRow, t };
      }
      const text = (detail?.userText ?? outline.preview ?? '').trim();
      const variant = promptKind(text, index === 0, session.origin?.kind);
      const width = leadW - 32;
      const cap = variant === 'brief' ? (level === 'detail' ? 8 : 3) : level === 'detail' ? USER_LINES : 3;
      const lines = variant === 'command' ? 1 : Math.min(cap, lineCount(text, width, 13));
      const attached = attachmentsOf(detail?.attachments ?? []);
      const steers = detail?.steers ?? [];
      const steerH = steers.reduce((sum, steer) => sum + 10 + Math.min(level === 'detail' ? 4 : 2, lineCount(steer.text, width - 16, 12)) * ROW.steerLine, 0);
      const h = variant === 'command' ? 40 : (variant === 'brief' || variant === 'scheduled' ? 20 : 0) + 24 + lines * ROW.line + (attached.images.length ? ROW.thumbs : attached.others ? ROW.attachments : 0) + steerH;
      return { kind: 'user', id: `user|${session.id}|${outline.turn}`, session, turn: outline, variant, ...(session.origin && index === 0 ? { origin: session.origin.kind } : {}), text, lines, ...(detail ? { detail } : {}), x, y: leadTop, w: leadW, h, t };
    });
    const agentTop = leadTop + Math.max(40, ...leads.map((lead) => lead.h)) + LEAD_GAP;
    const spine = leadTop + 20;

    let right = left + LABEL_W + colW, answersBottom = agentTop;
    let previous: Extract<FlowNode, { kind: 'agent' }> | undefined;
    let lastDay = '';
    const laneAgents: Array<Extract<FlowNode, { kind: 'agent' }>> = [];
    turns.forEach((outline, index) => {
      const detail = turnDetails[index];
      const lead = leads[index]!;
      const x = lead.x;
      const t = lead.t;
      const end = outline.status === 'running' ? now : time(outline.endedAt) || detail?.end || t;

      // The answer: a preview and its activity in summary; opened, its thinking and words, its calls folded to counts.
      const blocks = level === 'detail' && detail ? blocksOf(detail, colW) : undefined;
      // Compact, a one-sentence summary stands in for the preview.
      const summary = outline.status === 'running' ? undefined : summaries.get(turnKey(session.id, outline.turn));
      const previewLines = summary && level === 'summary' ? Math.min(2, lineCount(summary, colW - ROW.agentPad * 2, 13))
        : detail?.answer ? Math.min(3, lineCount(plainText(detail.answer), colW - ROW.agentPad * 2, 13)) : 1;
      const activity = detail && (detail.tools || detail.actors.length) ? 26 : 0;
      const h = blocks
        ? ROW.agentPad + ROW.meta + 6 + Math.max(blocksHeight(blocks), ROW.line) + ROW.agentPad - ROW.blockGap
        : ROW.agentPad + ROW.meta + 6 + previewLines * ROW.line + activity + ROW.agentPad;
      const fold = lead.kind === 'fold';
      // A seam's turn keeps an answer for the row's clock and the edges to hang from, but draws none.
      const agent = { kind: 'agent' as const, id: `agent|${session.id}|${outline.turn}`, session, turn: outline, ...(detail ? { detail } : {}), ...(blocks ? { blocks } : {}), ...(summary ? { summary } : {}), previewLines, x, y: level === 'detail' && !fold ? lead.y + lead.h + LEAD_GAP : agentTop, w: fold ? SEAM_W : colW, h: fold ? 0 : h, t, end };

      nodes.push(lead);
      laneAgents.push(agent);
      agents.set(turnKey(session.id, outline.turn), agent);
      if (!fold) {
        nodes.push(agent);
        edges.push({ id: `prompt|${agent.id}`, kind: 'prompt', from: lead.id, to: agent.id, t, path: `M ${x + 24} ${lead.y + lead.h} L ${x + 24} ${agent.y}` });
      }
      // The spine: from the last question to this one, across the silence between them.
      if (previous) {
        const before = leads[index - 1]!;
        const from: [number, number] = [before.x + before.w, spine], to: [number, number] = [x, spine];
        const silence = t - previous.end;
        edges.push({ id: `reply|${agent.id}`, kind: 'reply', from: previous.id, to: lead.id, t, path: `M ${from[0]} ${from[1]} L ${to[0]} ${to[1]}`, ...(silence > GAP_MS ? { gap: silence, mid: [(from[0] + to[0]) / 2, spine] as [number, number] } : {}) });
      }

      // When it happened, above the question: the date where a new day starts.
      const day = new Date(t).toDateString();
      gutter.push({ id: `time|${session.id}|${outline.turn}`, x, y: top + HEADER_H + 4, t, day: day !== lastDay });
      lastDay = day;
      answersBottom = Math.max(answersBottom, agent.y + agent.h);
      right = Math.max(right, x + agent.w);
      previous = agent;
    });

    // The next question's slot: the column after the last, on the same spine, joined to the last question. It stands outside the
    // row's frame, which holds only what happened; a question sent from it is taken in, so the frame widens as the conversation goes on.
    let frameRight = right;
    if (next === session.id) {
      const last = leads.at(-1);
      const x = last ? last.x + widths.at(-1)! + gap : left + LABEL_W;
      const slot = { id: `next|${session.id}`, session, x, y: leadTop, w: leadW, h: NEXT_H };
      nextSlots.push(slot);
      const before = laneAgents.at(-1);
      if (last && before) edges.push({ id: `reply|${slot.id}`, kind: 'reply', from: before.id, to: slot.id, t: last.t, path: `M ${last.x + last.w} ${spine} L ${x} ${spine}` });
      if (sending) frameRight = Math.max(right, x + colW);
    }

    // The tracks, each a band as tall as its tallest card; a track with nothing in it is left out.
    let y = answersBottom + TRACKS_TOP;
    const band = (kind: TrackBand['kind'], key: string, label: string, external: boolean, cards: FlowNode[], h: number) => {
      if (!cards.length) return;
      for (const card of cards) { card.y += y; nodes.push(card); }
      tracks.push({ id: `track|${session.id}|${kind}|${key}`, sessionId: session.id, kind, label, external, x: left, w: right - left, y, h });
      y += h + TRACK_GAP;
    };

    // Writes, one track per directory: the project's, then any outside it.
    const dirs = new Map<string, { base: string; byTurn: Map<number, FileChange[]> }>();
    turnDetails.forEach((detail, index) => {
      for (const change of detail?.changes ?? []) {
        const { key, base } = writeRoot(change.path);
        const dir = dirs.get(key) ?? { base, byTurn: new Map() };
        dir.byTurn.set(index, [...(dir.byTurn.get(index) ?? []), change]);
        dirs.set(key, dir);
      }
    });
    for (const [key, root] of [...dirs].sort((a, b) => (a[0] ? 1 : 0) - (b[0] ? 1 : 0) || a[0].localeCompare(b[0]))) {
      const cards: FlowNode[] = [];
      for (const [index, changes] of root.byTurn) {
        const agent = laneAgents[index]!;
        const shown = Math.min(changes.length, CHANGE.files[level]);
        const lines = level === 'detail' ? changes.slice(0, shown).map((change) => Math.min(CHANGE.lines, change.preview.length)) : [];
        cards.push({
          kind: 'change', id: `change|${session.id}|${agent.turn.turn}|${key}`, session, turn: agent.turn, agent: agent.id, base: root.base, changes, shown, lines,
          x: agent.x, y: 0, w: colW, h: changeHeight(shown, lines, changes.length > shown), t: Math.min(...changes.map((change) => change.at)) || agent.t,
        });
      }
      band('write', key || 'project', key ? tildePath(root.base) : place.name ?? '', Boolean(key), cards, Math.max(...cards.map((card) => card.h)));
    }

    // What each turn showed or made, as thumbnails: as many as fit across the column, the rest a count.
    const slots = Math.floor((colW + ART.gap) / (ART.w + ART.gap));
    const shelves: FlowNode[] = [];
    turnDetails.forEach((detail, index) => {
      const items = folds[index] ? [] : (detail?.artifacts ?? []).filter((item) => !broken.has(item.key));
      if (!items.length) return;
      const agent = laneAgents[index]!;
      shelves.push({ kind: 'artifacts', id: `artifacts|${session.id}|${agent.turn.turn}`, session, turn: agent.turn, agent: agent.id, items, shown: items.length > slots ? slots - 1 : items.length, x: agent.x, y: 0, w: colW, h: ART.h + ART.caption, t: agent.t });
    });
    band('artifacts', 'artifacts', '', false, shelves, ART.h + ART.caption);

    // The row's clock: each column's own, start to end of its turn, joined across the silences between.
    const points: Array<[number, number]> = [];
    // A turn ends by the time the next begins, whatever its record says (one left marked running would otherwise swallow the rest).
    laneAgents.forEach((agent, index) => {
      const from = Math.max(agent.t, points.at(-1)?.[1] ?? -Infinity);
      const next = laneAgents[index + 1]?.t ?? Infinity;
      points.push([agent.x + STRIP.inset, from], [agent.x + agent.w - STRIP.inset, Math.max(Math.min(agent.end, next), from + 1)]);
    });
    const clock = (at: number) => {
      if (!points.length || at <= points[0]![1]) return points[0]?.[0] ?? left;
      for (let index = 1; index < points.length; index += 1) {
        const [x1, t1] = points[index]!;
        if (at > t1) continue;
        const [x0, t0] = points[index - 1]!;
        return x0 + (x1 - x0) * ((at - t0) / Math.max(1, t1 - t0));
      }
      return points.at(-1)![0];
    };

    // Subagents and background tasks: each a bar on the row's clock from when it began to when it
    // ended (or now), run on to the turn it reported in; bars share a row where they and their
    // names do not overlap.
    const reportedIn = (actor: Actor, from: number) => {
      for (let index = from + 1; index < turns.length; index += 1) if (turnDetails[index]?.notifies.some((id) => actor.refs.includes(id))) return index;
      return undefined;
    };
    const bars: Array<{ reach: number; h: number; nodes: FlowNode[] }> = [];
    turnDetails.forEach((detail, index) => {
      const agent = laneAgents[index]!;
      for (const actor of detail?.actors ?? []) {
        const x0 = clock(actor.start);
        const inner = actor.lane ? lanes.get(`${session.id}|${actor.lane}`) ?? undefined : undefined;
        const steps = inner?.steps.filter((step) => step.kind === 'tool') ?? [];
        // Some transcripts give a subagent no end of its own; its last call is the next best.
        const ended = actor.running ? now : Math.max(actor.end, ...steps.map((step) => step.end));
        const x1 = Math.max(x0 + 6, clock(ended));
        const reported = reportedIn(actor, index);
        const report = reported !== undefined ? laneAgents[reported]!.x + STRIP.inset - x0 : undefined;
        const marks = steps.map((step, at) => {
          const a = Math.min(x1, Math.max(x0, clock(step.start)));
          return { index: at, x: a - x0, x2: Math.max(a, Math.min(x1, clock(step.end))) - x0 };
        });
        const conclusion = level === 'detail' && inner?.answer ? plainText(inner.answer).split('\n').map((line) => line.trim()).find(Boolean) : undefined;
        const subagent = actor.kind === 'subagent';
        const name = subagent ? actor.label : actor.note ?? actor.label;
        const named = 18 + textWidth(name, 11.5, !subagent) + (subagent && actor.note ? 8 + textWidth(actor.note, 10.5, true) : 0) + 52;
        const bar = x1 - x0;
        const w = Math.max(report !== undefined && report > bar + 4 ? report + 4 : bar, Math.min(named, 320), conclusion ? Math.min(textWidth(conclusion, 11, false) + 4, Math.max(bar, 320)) : 0);
        const h = BAR.pad + BAR.label + BAR.bar + (conclusion ? BAR.line : 0) + BAR.pad;
        const node = {
          kind: 'actor' as const, id: `actor|${session.id}|${actor.key}`, session, turn: agent.turn, actor, ...(inner ? { inner } : {}),
          bar, ...(report !== undefined && report > bar + 4 ? { report } : {}), steps, marks, ...(conclusion ? { conclusion } : {}),
          x: x0, y: 0, w, h, t: actor.start, end: ended,
        };
        let row = bars.find((item) => item.reach + 20 < x0);
        if (!row) { row = { reach: -Infinity, h: 0, nodes: [] }; bars.push(row); }
        row.reach = x0 + w;
        row.h = Math.max(row.h, h);
        row.nodes.push(node);
      }
    });
    if (bars.length) {
      let offset = 0;
      for (const row of bars) { for (const node of row.nodes) node.y = offset; offset += row.h; }
      band('actors', 'actors', '', false, bars.flatMap((row) => row.nodes), offset);
    }

    // The calls, one track per kind of work.
    for (const track of ['shell', 'explore', 'web', 'ask', 'other'] as const) {
      const cards: FlowNode[] = [];
      turnDetails.forEach((detail, index) => {
        const steps = detail?.steps.filter((step) => step.kind === 'tool' && step.track === track) ?? [];
        if (!steps.length) return;
        const agent = laneAgents[index]!;
        const { marks, callouts, h } = stripOf(track, steps, agent.t, agent.end, colW, CALLOUTS[track][level]);
        cards.push({
          kind: 'tools', id: `tools|${session.id}|${agent.turn.turn}|${track}`, session, turn: agent.turn, agent: agent.id, track, steps, marks, callouts,
          x: agent.x, y: 0, w: colW, h, t: steps[0]!.start || agent.t,
        });
      });
      if (cards.length) band(track, track, '', false, cards, Math.max(...cards.map((card) => card.h)));
    }

    const lowest = Math.max(y - TRACK_GAP, answersBottom, top + HEADER_H + 40);
    // The seams: a `/compact` turn's down its own column, one made mid-turn through the tracks at its moment.
    turnDetails.forEach((detail, index) => {
      const agent = laneAgents[index]!;
      if (folds[index]) { seams.push({ id: `seam|${session.id}|${agent.turn.turn}`, x: agent.x + SEAM_W / 2, top: leadTop + 20 + PIN_H / 2, bottom: lowest + FRAME_PAD / 2, t: agent.t }); return; }
      for (const step of detail?.steps ?? []) {
        if (step.kind === 'compaction') seams.push({ id: `seam|${session.id}|${step.key}`, x: clock(step.start), top: answersBottom + 12, bottom: lowest + FRAME_PAD / 2, t: step.start, ...(step.label ? { tokens: step.label } : {}) });
      }
    });
    const header = {
      kind: 'header' as const, id: `header|${session.id}`, session, x: left, y: top, w: Math.min(Math.max(colW, right - left), colW * 2 + gap + LABEL_W), h: HEADER_H, t: time(session.createdAt),
      ...(fork ? { fork: fork.kind } : {}), ...(written.size ? { written: { files: written.size, ...totals } } : {}),
    };
    nodes.push(header);
    const frameTop = top - FRAME_PAD - 8;
    // The branch drops from beneath the row it left, under the turn it left from, onto this row's project label.
    if (fork) {
      const from = laneBottom.get(fork.agent.session.id) ?? fork.agent.y + fork.agent.h;
      edges.push({ id: `fork|${session.id}`, kind: 'fork', from: fork.agent.id, to: header.id, t: header.t, path: `M ${fork.agent.x + 18} ${from} L ${fork.agent.x + 18} ${frameTop - 12}` });
    }
    frames.push({ id: `frame|${session.id}`, session, x: left - FRAME_PAD, y: frameTop, w: Math.max(right, frameRight) - left + FRAME_PAD * 2, h: lowest - top + FRAME_PAD * 2 + 8, ...(place.name ? { project: place.name } : {}), ...(place.branch ? { branch: place.branch } : {}) });
    laneBottom.set(session.id, lowest + FRAME_PAD);
    floor = Math.max(floor, lowest + FRAME_PAD);

    for (const child of children.get(session.id) ?? []) {
      const anchor = anchorTurn(turns, child.origin?.runId, child.createdAt);
      const agent = anchor ? agents.get(turnKey(session.id, anchor.turn)) : undefined;
      // The branch's row lines its columns up under the turn it left from.
      placeLane(child, agent ? agent.x - LABEL_W : left, agent ? { agent, kind: child.origin?.kind ?? 'fork' } : undefined);
    }
  };
  for (const root of roots) placeLane(root, 0);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const box of [...nodes, ...frames, ...nextSlots]) {
    minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w); maxY = Math.max(maxY, box.y + box.h);
  }
  return { nodes, ...(nextSlots[0] ? { next: nextSlots[0] } : {}), edges, frames, gutter, tracks, seams, bounds: nodes.length ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 } };
}

/** A conversation's family: the root it was forked from, and everything forked from that root since. */
export function sessionFamily(sessionId: string, sessions: readonly Session[]): Session[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  // The conversation asked for and the line it came down by are always in it, archived or not; the
  // rest of the family only while unarchived, and up to a size.
  const line = new Set<string>();
  let root = byId.get(sessionId);
  if (root) line.add(root.id);
  for (let hops = 0; root?.origin?.sessionId && byId.has(root.origin.sessionId) && hops < 16; hops += 1) { root = byId.get(root.origin.sessionId); line.add(root!.id); }
  if (!root) return [];
  const family = [root];
  for (let index = 0; index < family.length; index += 1) {
    const parent = family[index]!;
    for (const session of sessions) {
      if (session.origin?.sessionId !== parent.id || family.includes(session)) continue;
      if (line.has(session.id) || (!session.archivedAt && family.length < 24)) family.push(session);
    }
  }
  return family.filter((session) => session.kind === 'native');
}
