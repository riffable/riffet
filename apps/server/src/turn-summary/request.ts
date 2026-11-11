import { complete, type GatewayEndpoint } from '../auxiliary/gateway.js';

/**
 * Asked loosely, a model recounts the answer ("I read…", "先说明…") or titles it. The sentence is
 * the turn's outcome, so the instruction names what counts and what does not, and gives the length in
 * the unit each script is read in. Thinking is off where the protocol allows, as for titles.
 */
const INSTRUCTIONS = [
  'You summarize one finished turn between a user and a coding agent, for a card on a canvas.',
  'Reply with exactly one sentence saying what the turn came to: its outcome, decision, finding or deliverable.',
  'Never describe the process (no "I read…", "I checked…", "先说明…", "首先…"), and never write a section title or a label.',
  "Write in the same language as the user's question. Keep code identifiers and file names exactly as written.",
  'At most 40 Chinese characters or 80 Latin characters. No trailing period, no Markdown, no quotes, no emoji.',
  'If the answer is only a status update, summarize that, such as what it is waiting on. If the turn committed, include the short hash.',
].join(' ');
const MAX_OUTPUT_TOKENS = 512;
const QUESTION_LIMIT = 1_500;
const ANSWER_LIMIT = 4_000;
const ANSWER_HEAD = 1_500;
/** Width units kept: a CJK character counts two, anything else one. */
const WIDTH_LIMIT = 80;

export interface TurnSummaryRequest extends GatewayEndpoint {
  /** The turn's user message. */
  question: string;
  /** The turn's final answer. */
  answer: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const TRAILING = /[。．.!！?？,，;；:：、]+$/u;

/** A model's answer reduced to one plain sentence within the width limit; undefined when nothing is left. */
export function cleanTurnSummary(text: string | undefined): string | undefined {
  const line = (text ?? '').split('\n').map(part => part.trim()).find(Boolean);
  if (!line) return undefined;
  const value = line
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')
    .replace(/^[#>\-\s]+/u, '')
    .replace(/^(?:summary|摘要|总结)\s*[:：]\s*/iu, '')
    .replace(TRAILING, '')
    .replace(/^["'“”‘’「『《]+|["'“”‘’」』》]+$/gu, '')
    .replace(TRAILING, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!value) return undefined;
  let width = 0, end = 0;
  for (const char of value) {
    width += WIDE.test(char) ? 2 : 1;
    if (width > WIDTH_LIMIT) return `${value.slice(0, end).trimEnd()}…`;
    end += char.length;
  }
  return value;
}

/** A long answer keeps its start and its end, where the conclusion usually is. */
function clipAnswer(answer: string): string {
  return answer.length <= ANSWER_LIMIT ? answer : `${answer.slice(0, ANSWER_HEAD)}\n…\n${answer.slice(answer.length - (ANSWER_LIMIT - ANSWER_HEAD))}`;
}

/** Asks the gateway for the summary. Resolves to the cleaned sentence, or throws with the gateway's reason. */
export async function requestTurnSummary(request: TurnSummaryRequest): Promise<string> {
  const { question, answer, timeoutMs, signal, fetchImpl, ...endpoint } = request;
  const content = `<user_question>\n${question.slice(0, QUESTION_LIMIT)}\n</user_question>\n\n<agent_answer>\n${clipAnswer(answer)}\n</agent_answer>\n\nSummary:`;
  const summary = cleanTurnSummary(await complete({
    ...endpoint, system: INSTRUCTIONS, content, maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: timeoutMs ?? 30_000, ...(signal ? { signal } : {}), ...(fetchImpl ? { fetchImpl } : {}),
  }));
  if (!summary) throw new Error('summary model returned no summary');
  return summary;
}
