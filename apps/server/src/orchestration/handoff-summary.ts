import { complete, type CompletionRequest, type GatewayEndpoint } from '../auxiliary/gateway.js';

/**
 * Sections follow what continuing agents tend to lose (Claude Code's compaction summary, Cline's
 * `new_task` context): the user's corrections and the reasons behind decisions do not survive a
 * transcript clipped for length. Written as the state of the work rather than as a report about
 * another model, which would make the next agent distrust edits that are now its own.
 */
const INSTRUCTIONS = [
  'You write the handoff note that lets a coding agent continue a conversation in the same repository.',
  'You get the conversation transcript, either plain text or `<turn>` blocks with `<user>`, `<actions>` and `<assistant>`. An optional `<working_tree>` lists uncommitted files in the checkout; when absent, do not infer the working-tree state.',
  'Output only the note in Markdown, in the language the user writes in. Start directly with the first `##` section heading — no `#` title, no section numbers, no preamble, no closing remarks, no tool calls. The caller adds the opening line and the final "Next step" section.',
  'Write as the current state of the work the reader now owns; do not refer to "the previous agent" or "another model".',
  'Ground every claim in the transcript:',
  '- `<working_tree>` may contain uncommitted changes from other conversations in the same checkout. Only include working-tree files that `<actions>`, `<assistant>` or `<handoff_goal>` show belong to this conversation; never infer completed work from unmentioned dirty files or list unrelated working-tree files.',
  '- Never claim a file was edited, a command ran, or a check passed unless the transcript shows it.',
  '- Be concrete: preserve exact file paths, line numbers, symbol names, commands, config keys, error messages and values so the reader does not have to re-investigate.',
  '- Do not repeat the same fact across multiple sections. Leave out superseded attempts and resolved hiccups unless they explain a lasting constraint.',
  'Use these `##` sections in order, translated into the user\'s language, skipping any section that has nothing:',
  '- Goal and constraints — what the user wants overall, plus every requirement, preference, scope choice and correction the user made across turns, close to their wording.',
  '- Done and findings — what this conversation completed or established: code changes and commits made, checks actually run, and verified findings, root causes or agreed designs/plans.',
  '- Decisions — non-obvious choices made and why, including approaches ruled out.',
  '- Remaining — what is still unfinished, unverified or open. If the conversation ends with an unanswered user request or stopped mid-task, say so plainly and quote that user request verbatim.',
  '- Key files — concise list of files central to this task and why each matters.',
  'If `<handoff_goal>` is given, weight the note toward what the reader needs for it.',
  'Keep it concise and under about 1,000 words.',
].join('\n');
const MAX_OUTPUT_TOKENS = 8_192;
const TIMEOUT_MS = 120_000;

/** Asks the handoff model for a note on `material`; throws with the gateway's reason, or when it wrote nothing. */
export async function requestHandoffSummary(endpoint: GatewayEndpoint, material: string, options: { goal?: string; signal?: AbortSignal; complete?: (request: CompletionRequest) => Promise<string> } = {}): Promise<string> {
  const content = [material, ...(options.goal ? [`<handoff_goal>\n${options.goal}\n</handoff_goal>`] : []), 'Write the handoff note.'].join('\n\n');
  const note = (await (options.complete ?? complete)({
    ...endpoint, system: INSTRUCTIONS, content, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}),
  })).trim();
  if (!note) throw new Error('model returned no summary');
  return note;
}
