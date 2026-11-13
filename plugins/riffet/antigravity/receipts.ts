import { sameInput } from './composer.js';
import type { AgyRecord } from './protocol.js';
import { userBoundary, type Runtime } from './runtime.js';
import { agyStepIdentity, mapLiveSnapshot } from './transcript.js';

/** Matches pending runs against native USER_INPUT records and emits the receipt that settles their delivery. */
export async function receipts(runtime: Runtime): Promise<void> {
  const snapshot = runtime.snapshot;
  if (!snapshot) return;
  const sessionId = runtime.context.session.id;
  const pending = await runtime.host.runs.find(sessionId, { unfinished: true });
  const mapped = mapLiveSnapshot(snapshot, sessionId).events.filter(event => event.type === 'user_message_chunk');
  for (const run of pending) {
    if (!run.nativeInputBoundary || run.nativeMessageId) continue;
    let boundary: AgyRecord;
    try {
      boundary = JSON.parse(run.nativeInputBoundary);
    } catch {
      continue;
    }
    if (
      boundary.version !== 1 ||
      boundary.root !== runtime.launch.geminiDir ||
      !Array.isArray(boundary.users) ||
      (boundary.id && boundary.id !== snapshot.conversationId)
    ) {
      continue;
    }
    const current = userBoundary(snapshot);
    if (
      (boundary.trajectoryId && boundary.trajectoryId !== snapshot.trajectoryId) ||
      boundary.users.length > current.length ||
      boundary.users.some((user: string, index: number) => user !== current[index])
    ) {
      continue;
    }
    const matches = snapshot.steps.flatMap((step, index) => {
      const identity = step.userInput ? agyStepIdentity(snapshot, step, index) : undefined;
      const body = step.userInput?.userResponse;
      if (
        !identity ||
        boundary.users.includes(identity) ||
        !sameInput(body, run.renderedText) ||
        typeof step.metadata?.executionId !== 'string'
      ) {
        return [];
      }
      const event = mapped.find(item => item.nativeTurnId === step.metadata.executionId && item.nativeId === `agy:${identity}:user`);
      return event ? [{ step, index, event }] : [];
    });
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    runtime.host.emitEvent(sessionId, {
      type: 'native_input_receipt',
      // The receipt carries the native user message's own id: the run's `nativeMessageId` is taken from it, and the
      // timeline pairs that message with the run's row by it. Any other id shows the prompt twice.
      nativeId: match.event.nativeId,
      nativeTurnId: match.event.nativeTurnId,
      runId: run.id,
      createdAt: match.event.createdAt,
      data: { commandId: run.commandId, content: { type: 'text', text: run.renderedText ?? '' } },
    });
  }
}
