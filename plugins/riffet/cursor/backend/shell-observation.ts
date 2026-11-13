import { ChatReader, type ChatMessage } from '../native/chat-store.js';

/** How far back from the end of the chat a call is looked for: the one a hook reports is the newest the CLI is running. */
const LOOKBACK = 64;
const ATTEMPTS = 3;
const RETRY_MS = 100;

const parts = (message: ChatMessage) => (Array.isArray(message.content) ? message.content : []);

/**
 * The hooks name a call by an id of their own, which is not the `toolCallId` its chat store files it under, and the
 * transcript can only be merged by the latter. At the time `postToolUse` runs the store holds the call but not yet
 * its result (the CLI writes the result after the hook returns), so the call of the same command that has no result
 * is the one the hook is about. More than one such call (the same command run in parallel) cannot be told apart:
 * `undefined`, so that nothing is attached rather than something to the wrong call.
 */
export function unresolvedShellCall(reader: ChatReader, command: string): string | undefined {
  const snapshot = reader.snapshot();
  if (!snapshot) return undefined;
  const messages: ChatMessage[] = [];
  for (const id of snapshot.messageIds.slice(-LOOKBACK)) {
    const message = reader.message(id);
    if (message) messages.push(message);
  }
  if (snapshot.pending) messages.push(snapshot.pending);
  // Only the current turn: an earlier call of the same command that was cut off has no result either.
  const turn = messages.slice(messages.findLastIndex(message => message.role === 'user') + 1);
  const answered = new Set<string>();
  for (const message of turn) for (const part of parts(message)) if (part.type === 'tool-result' && typeof part.toolCallId === 'string') answered.add(part.toolCallId);
  const open: string[] = [];
  for (const message of turn) {
    for (const part of parts(message)) {
      if (part.type !== 'tool-call' || part.toolName !== 'Shell' || typeof part.toolCallId !== 'string' || answered.has(part.toolCallId)) continue;
      const args = part.args as { command?: unknown } | undefined;
      if (args?.command === command && !open.includes(part.toolCallId)) open.push(part.toolCallId);
    }
  }
  return open.length === 1 ? open[0] : undefined;
}

/** `unresolvedShellCall` over the chat store at `path`, retried briefly in case the store is a step behind the hook. */
export async function resolveShellCall(path: string, command: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const reader = new ChatReader(path);
    try {
      if (reader.available()) {
        const found = unresolvedShellCall(reader, command);
        if (found) return found;
      }
    } finally { reader.close(); }
    if (attempt + 1 < ATTEMPTS) await new Promise(resolve => setTimeout(resolve, RETRY_MS));
  }
  return undefined;
}
