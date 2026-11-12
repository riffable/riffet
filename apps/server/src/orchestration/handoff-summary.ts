import { complete, type CompletionRequest, type GatewayEndpoint } from '../auxiliary/gateway.js';
import { handoffSummaryPrompt } from '../prompts/index.js';

/**
 * Sections follow what continuing agents tend to lose (Claude Code's compaction summary, Cline's
 * `new_task` context): the user's corrections and the reasons behind decisions do not survive a
 * transcript clipped for length. Written as the state of the work rather than as a report about
 * another model, which would make the next agent distrust edits that are now its own.
 */
const MAX_OUTPUT_TOKENS = 8_192;
const TIMEOUT_MS = 120_000;

/** Asks the handoff model for a note on `material`; throws with the gateway's reason, or when it wrote nothing. */
export async function requestHandoffSummary(endpoint: GatewayEndpoint, material: string, options: { goal?: string; signal?: AbortSignal; complete?: (request: CompletionRequest) => Promise<string> } = {}): Promise<string> {
  const content = [material, ...(options.goal ? [`<handoff_goal>\n${options.goal}\n</handoff_goal>`] : []), 'Write the handoff note.'].join('\n\n');
  const note = (await (options.complete ?? complete)({
    ...endpoint, system: handoffSummaryPrompt(), content, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}),
  })).trim();
  if (!note) throw new Error('model returned no summary');
  return note;
}
