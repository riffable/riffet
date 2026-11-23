import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { councilModelName, councilSeatLabel, type CouncilDiscussion, type CouncilFormat, type CouncilPhase, type CouncilReviewTask, type CouncilRole, type CouncilSeat, type CouncilSpeech, type CouncilStreamEvent, type TimelineRow } from '@contracts';

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

export function debateRoundPhase(discussion: CouncilDiscussion, round: number): CouncilPhase {
  return round === 1 ? 'opening' : round >= (discussion.closingRound ?? discussion.maxRounds) ? 'closing' : 'rebuttal';
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

const councilMarkdown = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const seatReference = /(?<![\\\w[\/@-])(?:\[([a-z][a-z0-9]*)\]|([spr][1-9][0-9]*))(?![\w/@-]|\.[a-z0-9])/g;
const speakerVerb = /^\s*(?:认为|指出|主张|提出|提到|质疑|回应|质询|建议|说|(?:said|argues?|argued|asks?|asked|notes?|noted|claims?|claimed|proposed|disagrees?)\b)/i;
const toSpeaker = /(?:回应|同意|追问|质疑|不同意|\b(?:agree with|respond to|challenge|according to))\s*$/i;
const noticedSpeaker = /(?:注意到|\bI notice(?:d)?)\s*$/i;
const comparedWithSpeaker = /(?:和|与|跟|按|像|\b(?:with|like|unlike))\s*$/i;
const fromSpeaker = /^\s*(?:看来|的(?:回答|说法|观点|判断|比喻|提问|论证|前提|立场)|(?:用|举|把|就|只)\S|(?:and|or)\s+[spr]\d+\b|(?:和|与|及|、)\s*[spr]\d+)/i;
const literalReference = /(?:文献|论文|脚注|来源|占位符|变量|字符类|\b(?:paper|citation|reference|source|footnote|placeholder|variable|character class))\s*$/i;
const sentenceStart = /(?:^|[。！？.!?；;：:\n])\s*$/;
const htmlTag = /^<(\/?)([a-z][\w:-]*)(?=[\s/>])/i;
const voidHtmlTag = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

/** Decode older generated prose while leaving stored answers, code, equations and links intact. */
export function readableCouncilText(text: string, seats: readonly CouncilSeat[], markdown = true): string {
  if (!text || !seats.some((seat) => text.includes(seat.id))) return text;
  const roster = new Map(seats.map((seat) => [seat.id, seat]));
  if (!Array.from(text.matchAll(seatReference)).some((match) => roster.has(match[1] ?? match[2]!))) return text;
  // The renderer also accepts backslash-delimited formulas. Keep these original offsets as the
  // Markdown parser below understands dollar-delimited math only.
  const slashMath = Array.from(text.matchAll(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g));
  const tagged = new Set<string>();
  const references: { start: number; end: number; label: string; id: string; certain: boolean }[] = [];
  function visit(node: Root | RootContent) {
    if (node.type === 'link' || node.type === 'linkReference') return;
    if ('children' in node) {
      // Markdown emits inline HTML tags and the text between them as separate nodes.
      const html: string[] = [];
      for (const child of node.children) {
        if (child.type === 'html' && node.type !== 'root') {
          const tag = htmlTag.exec(child.value);
          const name = tag?.[2]?.toLowerCase();
          if (!name) continue;
          if (tag?.[1]) {
            const opening = html.lastIndexOf(name);
            if (opening >= 0) html.length = opening;
          } else if (!voidHtmlTag.test(name) && !child.value.endsWith('/>')) {
            html.push(name);
          }
        } else if (!html.length) visit(child);
      }
      return;
    }
    if (node.type !== 'text') return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const source = text.slice(start, end);
    for (const match of source.matchAll(seatReference)) {
      const seat = roster.get(match[1] ?? match[2]!);
      const from = start + match.index;
      if (!seat || slashMath.some((formula) => from >= formula.index && from < formula.index + formula[0].length)) continue;
      const to = from + match[0].length;
      const before = text.slice(Math.max(start, from - 32), from);
      const after = text.slice(to, Math.min(end, to + 48));
      if (literalReference.test(before) || /^\s*[=+*/<>≈≠≤≥]/.test(after)) continue;
      const bracketed = match[1] !== undefined;
      const label = councilSeatLabel(seats, seat);
      const name = councilModelName(seat.model) ?? seat.profileName;
      const gap = bracketed ? (/^[ \t]+/.exec(after)?.[0].length ?? 0) : 0;
      const following = text.slice(to + gap, Math.min(end, to + gap + label.length + 2)).toLowerCase();
      const named = gap ? [label, name].find(value => value && following.startsWith(value.toLowerCase())
        && !/^(?:[\w/@-]|\.[a-z0-9])/i.test(following.slice(value.length))) : undefined;
      const certain = Boolean(named) || speakerVerb.test(after) || toSpeaker.test(before)
        || (bracketed && fromSpeaker.test(after) && (sentenceStart.test(before) || noticedSpeaker.test(before)));
      const contextual = !bracketed && (comparedWithSpeaker.test(before) || fromSpeaker.test(after));
      if (bracketed && certain) tagged.add(seat.id);
      if (certain || contextual) references.push({
        start: from, end: named ? to + gap + named.length : to, label, id: seat.id, certain,
      });
    }
  }
  visit(councilMarkdown.parse(text));
  let output = '';
  let offset = 0;
  for (const { start, end, label, id, certain } of references) {
    if (start < offset || (!certain && !tagged.has(id))) continue;
    output += text.slice(offset, start) + (markdown ? label.replace(/[\\`*_~\[\]<>|$]/g, '\\$&') : label);
    offset = end;
  }
  return output + text.slice(offset);
}

export const seatName = (seat: CouncilSeat, seats: readonly CouncilSeat[]) => councilSeatLabel(seats, seat);

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
