import { councilSeatLabel, type CouncilDiscussion, type CouncilPhase, type CouncilSeat, type CouncilSpeech } from '../../../../../packages/contracts/src/index.js';

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

/** One wording for every length cap: Chinese characters first, foreign words as the matching figure (about 0.75 per character). */
export function lengthCap(chars: number, words = Math.round(chars * 0.75 / 10) * 10): string {
  return `不超过 ${chars} 字（外文约 ${words} 词）`;
}

/** Stated once, in the first-turn brief of formats whose speeches name other participants. */
export const NAME_RULE = '在正文中提到参与者时，使用讨论中显示的名称，不要写内部席位编号。';

export function languageRule(source: '题目' | '文档'): string {
  return `请用${source}的语言作答。用 Markdown 直接写正文，省略开场白和标题行。`;
}

/** A seat's conversation is an Agent's: it could act, but here it only speaks. */
export const SEAT_RULE = '本次只参与讨论，不要修改文件。仅在需要核实某个说法时查阅资料，不得编造事实、数字或来源。';

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

/** How models refer to a participant in reader-facing prose. */
export function speaker(d: CouncilDiscussion, seatId: string): string {
  const item = seat(d, seatId);
  const name = councilSeatLabel(d.seats, item);
  if (item.role === 'pro') return `${name}（正方）`;
  if (item.role === 'con') return `${name}（反方）`;
  return name;
}

/** The private recording turn needs the exact IDs used by the structured fields. */
export function recordSeatIds(d: CouncilDiscussion, role: CouncilSeat['role']): string {
  return `在 JSON 的席位引用字段中填写下列编号，正文和说明中使用对应的显示名称。\n${seatsOf(d, role)
    .map((item) => `- ${item.id}：${councilSeatLabel(d.seats, item)}`).join('\n')}`;
}

export const speak = (...speeches: SpeechSpec[]): Step => ({ kind: 'speak', speeches });

export function closingRoundOf(d: CouncilDiscussion): number {
  return Math.min(d.closingRound ?? d.maxRounds, d.maxRounds);
}

const PHASE_NAMES: Record<CouncilPhase, string> = {
  opening: '立论', rebuttal: '驳论', closing: '结辩', ledger: '裁判记录',
  statement: '发言', summary: '主持小结',
  explore: '独立作答', probe: '观察者追问', deepen: '回应追问',
  review: '审阅意见', conclusion: '结论',
};

/**
 * The turn a seat is sent for `spec`: its brief on the first, then what others said and the reader noted since it last
 * spoke, then the task. Returns what the seat has now heard, to be kept once the turn is sent.
 */
export function compose(format: FormatSpec, d: CouncilDiscussion, target: CouncilSeat, spec: SpeechSpec): { text: string; heard: string[] } {
  const heard = new Set(target.heard ?? []);
  const first = !target.sessionId;
  // A new conversation for a seat that already spoke (its conversation was lost, or the reader swapped its model) is
  // also told its own earlier speeches. A seat that simply heard nothing new keeps its conversation and is not.
  const reopened = first && d.speeches.some(s => s.seatId === target.id && s.status === 'done');
  const news = d.speeches.filter(s => s.status === 'done' && !heard.has(s.id)
    && (s.seatId === target.id ? reopened : (format.hears?.(d, target, s) ?? true)));
  const notes = d.supplements.filter(note => !heard.has(`note:${note.id}`));
  const parts: string[] = [];
  if (first) parts.push(format.brief(d, target));
  if (news.length) {
    const heading = first || reopened ? '此前的发言' : '你上次发言后的新发言';
    const speeches = news.map(s => `### 第 ${s.round} 轮 · ${PHASE_NAMES[s.phase]} · ${s.seatId === target.id ? '你此前的发言' : speaker(d, s.seatId)}\n${s.text}`);
    parts.push(`${heading}：\n\n${speeches.join('\n\n')}`);
  }
  if (notes.length) parts.push(`读者补充（仅供参考，请自行判断）：\n${notes.map(note => `- ${note.text}`).join('\n')}`);
  parts.push(spec.prompt.task);
  return { text: parts.join('\n\n'), heard: [...heard, ...news.map(s => s.id), ...notes.map(note => `note:${note.id}`)] };
}

/** The follow-up turn that asks a seat for its notes. */
export function recordTurn(record: string): string {
  return `请把刚才的发言整理成供后续讨论使用的结构化记录。按以下格式只输出一个 JSON 对象，省略说明文字和代码围栏。\n${record}`;
}
