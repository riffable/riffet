import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { councilModelName, type CouncilDiscussion, type CouncilFormat, type CouncilPhase, type CouncilReviewTask, type CouncilRole, type CouncilSeat, type CouncilSpeech, type CouncilStreamEvent, type TimelineRow } from '@contracts';

/** The names a discussion's formats, roles and phases go by on screen. */
export function useCouncilLabels() {
  const { t } = useLingui();
  return useMemo(() => {
    const formats: Record<CouncilFormat, string> = { ld: t`1v1 辩论`, roundtable: t`圆桌讨论`, prism: t`多视角`, review: t`审阅` };
    const roles: Record<CouncilRole, string> = {
      pro: t`正方`, con: t`反方`, judge: t`裁判`, debater: t`辩手`, moderator: t`主持人`,
      participant: t`参与者`, observer: t`观察者`, reviewer: t`审阅`, editor: t`修订`,
    };
    const tasks: Record<CouncilReviewTask, string> = { correct: t`纠错`, augment: t`补充`, diagnose: t`风险`, restructure: t`结构` };
    const phases: Record<Exclude<CouncilPhase, 'conclusion'>, string> = {
      opening: t`立论`, rebuttal: t`驳论`, closing: t`结辩`, ledger: t`本轮记录`,
      statement: t`发言`, summary: t`主持小结`,
      explore: t`独立作答`, probe: t`分歧`, deepen: t`回应`,
      review: t`审阅意见`,
    };
    const conclusions: Record<CouncilFormat, string> = { ld: t`裁决`, roundtable: t`结论`, prism: t`结论`, review: t`修订稿` };
    return {
      format: (format: CouncilFormat) => formats[format],
      role: (seat: Pick<CouncilSeat, 'role' | 'task'>) => seat.role === 'reviewer' && seat.task ? tasks[seat.task] : roles[seat.role],
      roleOf: (role: CouncilRole) => roles[role],
      task: (task: CouncilReviewTask) => tasks[task],
      phase: (format: CouncilFormat, phase: CouncilPhase) => phase === 'conclusion' ? conclusions[format] : phases[phase],
      round: (round: number) => t`第 ${round} 轮`,
    };
  }, [t]);
}

export function seatOf(discussion: CouncilDiscussion, seatId: string): CouncilSeat | undefined {
  return discussion.seats.find((seat) => seat.id === seatId);
}

export function conclusionOf(discussion: CouncilDiscussion): CouncilSpeech | undefined {
  return discussion.speeches.findLast((s) => s.phase === 'conclusion' && s.status === 'done');
}

/** Applies a speech event; one of an older run or another discussion is dropped. */
export function applyCouncilEvent(current: CouncilDiscussion | undefined, event: Extract<CouncilStreamEvent, { type: 'speech' }>): CouncilDiscussion | undefined {
  if (!current || event.discussionId !== current.id || event.version < current.version) return current;
  const at = current.speeches.findIndex((s) => s.id === event.speech.id);
  const speeches = at < 0 ? [...current.speeches, event.speech] : current.speeches.map((s, i) => (i === at ? event.speech : s));
  return { ...current, speeches };
}

/** The rows of each speech's turn held so far, by speech id, in place order. */
export type SpeechRows = Record<string, readonly TimelineRow[]>;

export function applySpeechRows(current: SpeechRows, speechId: string, upserts: readonly TimelineRow[], deletes: readonly string[]): SpeechRows {
  const byKey = new Map((current[speechId] ?? []).map((row) => [row.key, row]));
  for (const key of deletes) byKey.delete(key);
  for (const row of upserts) byKey.set(row.key, row);
  return { ...current, [speechId]: [...byKey.values()].sort((a, b) => a.pos - b.pos) };
}

/** The model a seat shows: the one picked, else the profile it runs on. */
export const seatName = (seat: CouncilSeat): string => councilModelName(seat.model) ?? seat.profileName;

/** Seats that speak for the format rather than in it: their speeches are notes on the round, drawn across the page. */
export const LEAD_ROLES: ReadonlySet<CouncilRole> = new Set(['judge', 'moderator', 'observer', 'editor']);

const ITEM = /^\s*(?:\d+[.)]|[-*•])\s+/;
const QUESTION_HEADING = /^\s*(?:#{1,6}\s*|\*\*)?[^\n]{0,24}(?:质询|质问|提问|反问|cross[- ]?exam|questions?)[^\n]{0,12}$/i;

/**
 * A debate speech split into what it argues and the questions it ends on: the list after its last rule (`---`, as the
 * prompt asks), or after a closing heading that names them, when nothing but that list follows. While the speech is
 * still being written the list may be partial.
 */
export function splitQuestions(text: string): { body: string; questions: string[] } {
  const lines = text.replace(/\s+$/, '').split('\n');
  const questionsFrom = (start: number): string[] | undefined => {
    const rest = lines.slice(start).filter((line) => line.trim());
    const items: string[] = [];
    for (const [index, line] of rest.entries()) {
      if (ITEM.test(line)) items.push(line.replace(ITEM, '').trim());
      else if (index === 0 && QUESTION_HEADING.test(line.replace(/\*\*$/, ''))) continue;
      else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
      else return undefined;
    }
    return items;
  };
  for (let at = lines.length - 1; at > 0; at -= 1) {
    const line = lines[at]!;
    const rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
    if (!rule && !QUESTION_HEADING.test(line)) continue;
    const questions = questionsFrom(rule ? at + 1 : at);
    if (questions === undefined) continue;
    if (!rule && !questions.length) continue;
    return { body: lines.slice(0, at).join('\n').replace(/\s+$/, ''), questions: questions.map((q) => q.replace(/^\*\*|\*\*$/g, '')) };
  }
  return { body: text, questions: [] };
}

const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Whether two quotes are the same question: one holds the other's opening, or most of their character pairs match. */
export function alike(a: string, b: string): boolean {
  const x = comparable(a), y = comparable(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // A prefix counts only when it is long enough to name one question, not a stock opening (为什么).
  if ((y.length >= 8 && x.includes(y.slice(0, 16))) || (x.length >= 8 && y.includes(x.slice(0, 16)))) return true;
  const pairs = (s: string) => { const chars = [...s]; return new Set(chars.slice(1).map((c, i) => chars[i]! + c)); };
  const p = pairs(x), q = pairs(y);
  let shared = 0;
  for (const pair of p) if (q.has(pair)) shared += 1;
  return shared / Math.max(1, Math.min(p.size, q.size)) >= 0.5;
}

export type QuestionState = 'direct' | 'dodged' | 'pending';

/** How the judge last counted each question a debate speech asked; undefined until a ledger names it. */
export function questionStates(discussion: CouncilDiscussion, speech: CouncilSpeech, questions: readonly string[]): Array<QuestionState | undefined> {
  const asker = seatOf(discussion, speech.seatId)?.role;
  if (asker !== 'pro' && asker !== 'con') return questions.map(() => undefined);
  const after = discussion.speeches.slice(discussion.speeches.indexOf(speech) + 1);
  const asked = after.flatMap((s) => (s.directive?.kind === 'ledger' ? s.directive.crossExam.filter((item) => item.asker === asker) : []));
  return questions.map((question) => asked.findLast((item) => alike(item.question, question))?.answered);
}
