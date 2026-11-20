import { samePromptText, type GitStatus, type Run, type Session } from '../../../../packages/contracts/src/index.js';
import { briefPart, type BriefLanguage, type BriefPart } from '../prompts/index.js';
import type { IdentifiedSession } from '../session-identity.js';

/** Upper bound on a brief, in characters: enough to carry a long thread's gist without crowding out the work. */
const BRIEF_BUDGET = 24_000;
const PROMPT_LIMIT = 2_000;
const ANSWER_LIMIT = 1_500;
const ACTIONS_LIMIT = 600;
/** An earlier handoff or fork carried in this conversation's first message; kept ahead of any turn. */
const INHERITED_LIMIT = 8_000;
/**
 * Upper bound on what a handoff model reads, in estimated tokens. Generous, since condensing is its
 * job, yet with its answer still inside the 128k context of the small models auxiliary jobs run on.
 */
const MATERIAL_BUDGET = 64_000;
const WIDE = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
/** A tokenizer-free estimate: about one token per CJK character, and four characters per token otherwise. */
const tokens = (text: string) => { const wide = text.match(WIDE)?.length ?? 0; return wide + Math.ceil((text.length - wide) / 4); };

export interface BriefSource {
  session: IdentifiedSession;
  runs: Run[];
  /**
   * The conversation's text and tool activity, oldest first: the transcript itself when the backend
   * can be read, else what the search index holds — where replies may be clipped, or missing for a
   * conversation never opened here.
   */
  messages: Array<{ kind: 'user' | 'assistant' | 'tool'; text: string; at: string; messageId?: string; turnId?: string; runId?: string }>;
  status?: GitStatus;
  /** Only turns up to and including this run, for a fork from the middle of a conversation. */
  upToRunId?: string;
}

interface Turn {
  prompt: string;
  /** The turn opened by an earlier brief; its prompt is carried once, as `inherited`, not here. */
  continues?: boolean;
  replies: string[];
  /** Tool calls by name, path and command, deduplicated. */
  actions: string[];
}

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;
/** The end of a text: what an answer concludes with is what the next agent needs. */
const clipEnd = (text: string, limit: number) => text.length > limit ? `…${text.slice(text.length - limit)}` : text;
/** Both ends of a text, for an earlier brief: its goal leads and its latest state trails. */
const clipMiddle = (text: string, limit: number) => text.length > limit
  ? `${text.slice(0, Math.floor(limit * 0.4))}\n\n…\n\n${text.slice(text.length - Math.ceil(limit * 0.6))}` : text;

interface SegmentedTurn extends Turn {
  at: string;
  messageId?: string;
  turnId?: string;
  runId?: string;
}

function matchesRunIdentity(run: Run, seg: Pick<SegmentedTurn, 'messageId' | 'turnId' | 'runId'>): boolean {
  if (seg.runId && seg.runId === run.id) return true;
  if (seg.messageId && run.native?.nativeMessageId && seg.messageId === run.native.nativeMessageId) return true;
  if (seg.turnId && run.native?.nativeTurnId && seg.turnId === run.native.nativeTurnId && run.native.intent !== 'steer') return true;
  return false;
}

function matchesRunPrompt(run: Run, messageText: string): boolean {
  const cleaned = messageText.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '').trim();
  for (const candidate of [run.native?.renderedText, run.prompt]) {
    const sent = candidate?.trim();
    if (!sent) continue;
    for (const stored of [messageText.trim(), cleaned]) {
      if (!stored) continue;
      if (samePromptText(sent, stored)) return true;
      // Search-index fallback rows are capped at MAX_INDEXED_TEXT (4,000 chars).
      if (stored.length >= 3_900 && sent.length > stored.length && samePromptText(sent.slice(0, stored.length), stored)) return true;
    }
  }
  return false;
}

/**
 * The conversation as turns, plus the earlier brief its first message carried when it was itself
 * continued from another one. A brief is the oldest message, so it would be the first thing a
 * budget drops, and with it everything before the previous handoff.
 */
function collect(source: BriefSource): { inherited?: string; turns: Turn[] } {
  const startedAt = (run: Run): number | undefined => {
    const timings = run.native?.timings;
    const sent = timings?.dispatchAt ?? timings?.inputSentAt ?? timings?.providerAcceptedAt;
    if (sent !== undefined && Number.isFinite(sent)) return sent;
    if (run.native && ['queued', 'preparing', 'failed', 'cancelled'].includes(run.native.delivery)) return undefined;
    return Date.parse(run.createdAt);
  };
  const starts = source.runs.filter(run => run.native?.intent !== 'steer').map(startedAt).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const nextStart = (run: Run) => { const start = startedAt(run); return start === undefined ? undefined : starts.find(value => value > start); };
  let runs = source.runs;
  let until: number | undefined;
  if (source.upToRunId) {
    let index = runs.findIndex(run => run.id === source.upToRunId);
    if (index >= 0) {
      until = nextStart(runs[index]!);
      while (index + 1 < runs.length && runs[index + 1]?.native?.intent === 'steer') index += 1;
      runs = runs.slice(0, index + 1);
    }
  }
  const continued = source.session.origin?.kind === 'fork' || source.session.origin?.kind === 'handoff';
  const opening = continued && runs[0]?.prompt.trim() ? runs[0] : undefined;
  runs = runs.filter(run => run.prompt.trim());
  const firstRunAt = source.runs[0]?.createdAt;
  const firstRunTime = firstRunAt === undefined ? undefined : Date.parse(firstRunAt);
  const allDispatched = source.runs.filter(run => run.prompt.trim() && startedAt(run) !== undefined);
  const targetDispatched = runs.filter(run => startedAt(run) !== undefined);
  // Provider transcripts carry each turn's user message in order, while their item timestamps can
  // be rounded to whole seconds or minutes (before `dispatchAt`); segmenting by user message keeps
  // every turn's tools and replies with the turn that ran them.
  if (source.messages[0]?.kind === 'user' && (!allDispatched.length || source.messages.some(message => message.kind === 'user' && allDispatched.some(run => matchesRunIdentity(run, message) || matchesRunPrompt(run, message.text))))) {
    const segmented: SegmentedTurn[] = [];
    for (const message of source.messages) {
      if (message.kind === 'user') {
        segmented.push({
          prompt: message.text.trim(), at: message.at, replies: [], actions: [],
          ...(message.messageId ? { messageId: message.messageId } : {}),
          ...(message.turnId ? { turnId: message.turnId } : {}),
          ...(message.runId ? { runId: message.runId } : {}),
        });
      } else if (segmented.length) {
        if (message.kind === 'assistant') segmented.at(-1)!.replies.push(message.text);
        else if (!segmented.at(-1)!.actions.includes(message.text)) segmented.at(-1)!.actions.push(message.text);
      }
    }
    let cursor = 0, lastTargetSegment = -1, lastTargetRun: Run | undefined, firstExcludedSegment = segmented.length;
    for (let index = 0; index < segmented.length && cursor < allDispatched.length; index++) {
      const seg = segmented[index]!;
      const identityMatch = allDispatched.slice(cursor).findIndex(run => matchesRunIdentity(run, seg));
      let match = identityMatch;
      if (match < 0) {
        const laterSegments = segmented.slice(index + 1).filter(later => samePromptText(seg.prompt, later.prompt)).length;
        match = allDispatched.slice(cursor).findIndex((run, offset) => {
          if (!matchesRunPrompt(run, seg.prompt)) return false;
          // Hook-delivered steers do not emit a separate user_message_chunk, so do
          // not let an un-echoed steer claim a prompt that a later non-steer turn needs.
          if (run.native?.intent === 'steer') {
            const laterNonSteer = allDispatched.slice(cursor + offset + 1).filter(later => later.native?.intent !== 'steer' && matchesRunPrompt(later, seg.prompt)).length;
            if (laterSegments < laterNonSteer) return false;
          }
          return true;
        });
      }
      if (match < 0) continue;
      // Do not skip an earlier dispatched run that still has a matching transcript turn ahead, or
      // spend a run on an older CLI-typed turn when later segments need the same prompt.
      if (identityMatch < 0) {
        if (match > 0 && allDispatched.slice(cursor, cursor + match).some(skipped => skipped.native?.intent !== 'steer' && segmented.slice(index + 1).some(later => matchesRunIdentity(skipped, later) || matchesRunPrompt(skipped, later.prompt)))) continue;
        const candidate = allDispatched[cursor + match]!;
        const laterMatchingSegments = segmented.slice(index + 1).filter(later => matchesRunPrompt(candidate, later.prompt)).length;
        const laterRuns = allDispatched.slice(cursor + match + 1).filter(later => matchesRunPrompt(later, seg.prompt)).length;
        if (laterMatchingSegments > laterRuns) continue;
      }
      const run = allDispatched[cursor + match]!;
      if (run === opening) seg.continues = true;
      const matchedIndex = cursor + match;
      cursor = matchedIndex + 1;
      if (matchedIndex < targetDispatched.length) {
        lastTargetSegment = index;
        lastTargetRun = run;
      } else if (firstExcludedSegment === segmented.length) {
        firstExcludedSegment = index;
      }
    }
    const cutoff = source.upToRunId
      ? (lastTargetSegment >= 0
        ? lastTargetSegment + 1
        : Math.min(firstExcludedSegment, segmented.filter(seg => firstRunTime === undefined || Date.parse(seg.at) < firstRunTime).length))
      : segmented.length;
    const turns: Turn[] = segmented.slice(0, cutoff).map(({ at: _at, messageId: _m, turnId: _t, runId: _r, ...turn }) => turn);
    const trailingFrom = lastTargetRun ? runs.indexOf(lastTargetRun) + 1 : 0;
    for (const run of runs.slice(trailingFrom)) {
      if (run.native?.intent === 'steer' || (startedAt(run) === undefined && run.native?.delivery !== 'failed' && run.state !== 'failed')) continue;
      turns.push({ prompt: run.prompt.trim(), ...(run === opening ? { continues: true } : {}), replies: [], actions: [] });
    }
    return { ...(opening ? { inherited: opening.prompt.trim() } : {}), turns };
  }
  // createdAt is the queue acceptance time. Actual dispatch boundaries keep an eagerly queued
  // follow-up from taking the current turn's answer, or clipping it out of a fork's brief.
  const messages = source.messages.filter(message => until === undefined || Date.parse(message.at) < until);
  // Discovered native conversations can predate their first Riffet Run, or have no Runs at all.
  // Their indexed user messages are the only record of what the user asked the original agent.
  const historical: Turn[] = [];
  for (const message of messages) {
    if (firstRunTime !== undefined && !(Date.parse(message.at) < firstRunTime)) continue;
    if (message.kind === 'user') historical.push({ prompt: message.text, replies: [], actions: [] });
    else if (historical.length) (message.kind === 'assistant' ? historical.at(-1)!.replies : historical.at(-1)!.actions).push(message.text);
  }
  const turns = runs.filter(run => run.native?.intent !== 'steer').map((run): Turn => {
    const start = startedAt(run), next = nextStart(run);
    const within = start === undefined ? [] : messages.filter(message => Date.parse(message.at) >= start && (next === undefined || Date.parse(message.at) < next));
    return {
      prompt: run.prompt.trim(),
      ...(run === opening ? { continues: true } : {}),
      replies: within.filter(message => message.kind === 'assistant').map(message => message.text),
      actions: [...new Set(within.filter(message => message.kind === 'tool').map(message => message.text))],
    };
  });
  return { ...(opening ? { inherited: opening.prompt.trim() } : {}), turns: [...historical, ...turns] };
}

const agentOf = (session: IdentifiedSession) => `${session.backendId}${session.model ? ` · ${session.model}` : ''}`;

/** The line a model-written handoff note opens with, naming where it came from. */
export function summaryHeading(session: IdentifiedSession, language: BriefLanguage = 'zh'): string {
  return language === 'en'
    ? `Below is the handoff note from "${session.title}" (${agentOf(session)}), which you will now continue. Trust the actual files in the repository.`
    : `以下是对话「${session.title}」（${agentOf(session)}）的交接摘要，你将接着它继续工作。以仓库里的实际文件为准。`;
}

/** Language-matched closing section appended to a fork or handoff brief. */
export function continuationSection(language: BriefLanguage, kind: 'fork' | 'handoff', note?: string): string {
  const heading = language === 'en' ? '## Next step' : '## 接下来';
  const body = note?.trim() || (kind === 'fork'
    ? (language === 'en'
      ? 'Briefly confirm your understanding of the current state, then wait for my next instruction without modifying files yet.'
      : '先用几句话确认你理解的现状，然后等我的下一步指示，暂时不要修改文件。')
    : (language === 'en'
      ? 'Briefly confirm your understanding of the current state and what remains, then continue completing it.'
      : '先用几句话确认你理解的现状和尚未完成的部分，然后继续完成它。'));
  return `\n\n${heading}\n${body}`;
}

/** Every changed file with its line counts, as the tree stands now. */
function changedFiles(status: GitStatus | undefined, limit: number): string[] {
  if (!status?.entries.length) return [];
  const lines = status.entries.slice(0, limit).map(entry => {
    const counts = entry.added !== undefined || entry.removed !== undefined ? ` (+${entry.added ?? 0} -${entry.removed ?? 0})` : '';
    return `- ${entry.index}${entry.worktree} ${entry.path}${counts}`;
  });
  if (status.entries.length > limit) lines.push(`- …另有 ${status.entries.length - limit} 个文件`);
  return lines;
}

/** Keeps the latest items whose total fits `budget`, and how many were dropped from the front. */
function keepLatest(items: string[], budget: number, size: (item: string) => number = item => item.length): { kept: string[]; omitted: number } {
  const kept: string[] = [];
  for (const item of [...items].reverse()) {
    if (size(item) > budget && kept.length) break;
    kept.unshift(item);
    budget -= size(item);
  }
  return { kept, omitted: items.length - kept.length };
}

/**
 * The context a new conversation starts from when it continues another one — a fork, or a handoff
 * when no model is set to write one. No backend can read another's transcript, so continuity is
 * carried as text: the prompts, the end of each answer, the tools each turn used, and the files left
 * changed. When the whole thread does not fit, the oldest turns go first, since the latest state is
 * what the next agent acts on.
 */
export function writeBrief(source: BriefSource): string {
  const { inherited, turns } = collect(source);
  const language = briefLanguage([source.session.title, inherited ?? '', ...turns.map(turn => turn.prompt)]);
  const part = (name: BriefPart, vars?: Record<string, string | number>) => briefPart(language, name, vars);
  const rendered = turns.map((turn, index) => {
    const parts = [part('turn', { n: index + 1, prompt: turn.continues ? part('continues') : clip(turn.prompt, PROMPT_LIMIT) })];
    if (turn.actions.length) parts.push(part('actions', { actions: clip(turn.actions.join(language === 'zh' ? '；' : '; '), ACTIONS_LIMIT) }));
    if (turn.replies.length) parts.push(part('replies', { replies: clipEnd(turn.replies.join('\n\n'), ANSWER_LIMIT) }));
    return parts.join('\n\n');
  });
  const head = part('head', { title: source.session.title, agent: agentOf(source.session) });
  const earlier = inherited ? part('earlier', { text: clipMiddle(inherited, INHERITED_LIMIT) }) : '';
  const files = changedFiles(source.status, 80);
  const changed = files.length ? clip(part('changed', { branch: source.status!.branch, files: files.join('\n') }), 6_000) : '';
  const { kept, omitted } = keepLatest(rendered, BRIEF_BUDGET - head.length - earlier.length - changed.length);
  return [head, earlier, omitted ? part('transcriptOmitted', { count: omitted }) : part('transcript'), ...(kept.length ? kept : [part('empty')]), changed].filter(Boolean).join('\n\n');
}

/**
 * The server keeps no interface language, so the brief follows the conversation: Chinese when any
 * of its text (title, earlier handoff, prompts) holds CJK characters, English otherwise.
 */
export function briefLanguage(texts: string[]): BriefLanguage {
  return texts.some(text => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)) ? 'zh' : 'en';
}

export function sourceLanguage(source: BriefSource): BriefLanguage {
  const { inherited, turns } = collect(source);
  return briefLanguage([source.session.title, inherited ?? '', ...turns.map(turn => turn.prompt), ...turns.flatMap(turn => turn.replies)]);
}

/**
 * What a handoff model reads: the same turns in far more detail than a brief, as tagged text. When
 * the whole does not fit, every turn first loses its intermediate replies, oldest first; then turns
 * are condensed to a brief's detail, oldest first; and only then are the oldest dropped.
 */
export function writeMaterial(source: BriefSource): string {
  const { inherited, turns } = collect(source);
  /** 0: everything, 1: only the final reply, 2: a brief's detail. */
  const render = (turn: Turn, index: number, level: 0 | 1 | 2) => {
    const prompt = turn.continues ? '(the earlier handoff above)' : clip(turn.prompt, level === 2 ? PROMPT_LIMIT : 20_000);
    const parts = [`<turn n="${index + 1}">`, `<user>\n${prompt}\n</user>`];
    if (turn.actions.length) parts.push(`<actions>\n${clipMiddle(turn.actions.join('\n'), level === 2 ? ACTIONS_LIMIT : 6_000)}\n</actions>`);
    if (turn.replies.length) {
      const last = turn.replies.length - 1;
      const replies = level === 0 ? turn.replies.map((reply, at) => at === last ? clipMiddle(reply, 12_000) : clip(reply, 3_000))
        : [clipEnd(turn.replies[last], level === 1 ? 12_000 : ANSWER_LIMIT)];
      parts.push(`<assistant>\n${replies.join('\n\n')}\n</assistant>`);
    }
    parts.push('</turn>');
    return parts.join('\n');
  };
  const earlier = inherited ? `<earlier_handoff>\n${clipMiddle(inherited, 24_000)}\n</earlier_handoff>` : '';
  const files = changedFiles(source.status, 400);
  const tree = files.length ? `<working_tree branch="${source.status!.branch}">\n${files.join('\n')}\n</working_tree>` : '<working_tree>no uncommitted changes</working_tree>';
  const budget = MATERIAL_BUDGET - tokens(earlier) - tokens(tree);
  const rendered = turns.map((turn, index) => render(turn, index, 0));
  let total = rendered.reduce((sum, item) => sum + tokens(item), 0);
  for (const level of [1, 2] as const) {
    for (let index = 0; index < rendered.length && total > budget; index++) {
      const smaller = render(turns[index], index, level);
      total -= tokens(rendered[index]) - tokens(smaller);
      rendered[index] = smaller;
    }
  }
  const { kept, omitted } = keepLatest(rendered, budget, tokens);
  return [
    `<conversation title="${source.session.title.replace(/"/g, "'")}" agent="${agentOf(source.session)}">`,
    earlier,
    omitted ? `<omitted turns="${omitted}"/>` : '',
    ...kept,
    '</conversation>',
    tree,
  ].filter(Boolean).join('\n');
}
