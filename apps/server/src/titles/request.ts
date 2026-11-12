import { complete, type GatewayEndpoint } from '../auxiliary/gateway.js';
import { titlePrompt } from '../prompts/index.js';
import { cleanGeneratedTitle } from '../session-title.js';

/**
 * Tuned against the reasoning models these gateways serve: asked loosely, they answer the request
 * instead of naming it, or spend the whole budget thinking. Thinking is switched off where the
 * protocol allows and the budget leaves room for models that think anyway.
 */
const MAX_OUTPUT_TOKENS = 1_024;
const MESSAGE_LIMIT = 2_000;
const REPLY_LIMIT = 1_500;

export interface TitleRequest extends GatewayEndpoint {
  /** The conversation's first human message. */
  message: string;
  /** The agent's first answer, when the transcript has it; it tells "看一下这个" what "这个" was. */
  reply?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function conversation(message: string, reply: string | undefined): string {
  const parts = [`<user_message>\n${message.slice(0, MESSAGE_LIMIT)}\n</user_message>`];
  if (reply?.trim()) parts.push(`<agent_reply>\n${reply.slice(0, REPLY_LIMIT)}\n</agent_reply>`);
  return `${parts.join('\n\n')}\n\nTitle:`;
}

/** Asks the gateway for a title. Resolves to the cleaned title, or throws with the gateway's reason. */
export async function requestTitle(request: TitleRequest): Promise<string> {
  const { message, reply, timeoutMs, signal, fetchImpl, ...endpoint } = request;
  const title = cleanGeneratedTitle(await complete({
    ...endpoint, system: titlePrompt(), content: conversation(message, reply), maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: timeoutMs ?? 30_000, ...(signal ? { signal } : {}), ...(fetchImpl ? { fetchImpl } : {}),
  }));
  if (!title) throw new Error('title model returned no title');
  return title;
}
