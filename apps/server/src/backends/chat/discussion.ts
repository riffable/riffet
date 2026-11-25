import type { AgentDiscussionRequest } from '@riffet/plugin-api/experimental/agent';
import type { ChatMessage, ChatStreamResult } from '../../auxiliary/gateway.js';
import { estimateTokens } from '../../metrics/tokens.js';

/** Apply the chat budgets to native streams too. A CLI need not support a token-limit switch. */
export async function runAgentDiscussion(run: (request: AgentDiscussionRequest) => Promise<void>,
  request: AgentDiscussionRequest & { messages: ChatMessage[] }): Promise<ChatStreamResult> {
  const stop = new AbortController();
  const signal = AbortSignal.any([request.signal, stop.signal]);
  signal.throwIfAborted();
  const messages = request.messages.map(({ role, content, parts }: ChatMessage) => ({
    role, content: [content, ...(parts ?? []).map(part => {
      if (part.type !== 'text') throw new Error('This side chat accepts text attachments');
      return part.text;
    })].join('\n\n'),
  }));
  let text = '', cutOff = false, remaining = request.maxOutputTokens;
  const timer = setTimeout(() => stop.abort(new Error('The side chat timed out waiting for an answer')), request.idleTimeoutMs);
  timer.unref();
  try {
    await run({ ...request, messages, signal, onDelta(piece) {
      signal.throwIfAborted();
      if (!piece) return;
      timer.refresh();
      const cost = estimateTokens(piece);
      if (cost > remaining) {
        // A CLI may deliver its entire answer in one event. Keep the prefix that fits.
        let length = 0;
        for (const char of piece) {
          remaining -= estimateTokens(char);
          if (remaining < 0) break;
          length += char.length;
        }
        piece = piece.slice(0, length);
        cutOff = true;
      } else remaining -= cost;
      text += piece;
      if (piece) request.onDelta(piece);
      if (cutOff) stop.abort();
    } });
    if (!cutOff) signal.throwIfAborted();
  } catch (error) {
    request.signal.throwIfAborted();
    if (!cutOff) throw signal.reason ?? error;
  } finally { clearTimeout(timer); }
  if (!text.trim() && !cutOff) throw new Error('The agent returned no text');
  return { text, cutOff, reasoning: '' };
}
