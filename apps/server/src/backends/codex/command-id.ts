import type { Run } from '../../../../../packages/contracts/src/index.js';
import type { CodexFlavor } from './flavors.js';
import { commandIdOfMessageId, commandIdOfSteerPlaceholder, isTaggedMessageId } from './message-tag.js';
import { userMessageText } from './project-item.js';
import type { RpcItem } from './types.js';
import { asArray, asRecord, str } from './util.js';

/** What the lookup reads from the runtime: the conversation's identity and the records of its runs. */
export interface CommandIdSource {
  readonly flavor: CodexFlavor;
  readonly sessionId: string;
  threadId(): string | undefined;
  /** The runs the workbench recorded for a turn of the thread. */
  runsOfTurn(threadId: string, turnId: string): readonly Run[];
  /** A user item that carries no tag may still be a steer this runtime sent (`turns.ts#claimSteeredItem`). */
  claimSteeredItem(id: string, turnId: string | undefined, item: RpcItem): string | undefined;
}

/** The workbench command a user item answers, or undefined for a message typed in the TUI. */
export function commandIdOfItem(source: CommandIdSource, item: RpcItem, turnId: string | undefined): string | undefined {
  if (item.type !== 'userMessage') return undefined;
  if (source.flavor.messageTag.echo === 'clientId') return str(item.clientId);
  const id = str(item.id);
  if (!id) return undefined;
  if (isTaggedMessageId(id)) return commandIdOfMessageId(id);
  const parts = asArray<Record<string, unknown>>(item.content);
  const markers = parts.filter(part => part.type === 'text').flatMap(part =>
    asArray<Record<string, unknown>>(part.text_elements).filter(element => commandIdOfSteerPlaceholder(str(element.placeholder)) !== undefined)
      .map(element => ({ element, text: str(part.text) ?? '' })));
  const threadId = source.threadId();
  if (markers.length) {
    // A tag alone is not a receipt. Require the original persisted write fence, exact text and
    // metadata in this same provider turn; this also works after a Riffet restart.
    if (markers.length !== 1 || !turnId || !threadId) return undefined;
    const { element, text } = markers[0]!;
    const range = asRecord(element.byteRange);
    const commandId = commandIdOfSteerPlaceholder(element.placeholder as string);
    if (!commandId || range?.start !== 0 || range.end !== 0 || userMessageText(item) !== text) return undefined;
    const run = source.runsOfTurn(threadId, turnId).find(candidate =>
      candidate.commandId === commandId && candidate.sessionId === source.sessionId
      && candidate.native?.intent === 'steer' && candidate.native.backendId === source.flavor.id
      && candidate.native.nativeSessionId === threadId && candidate.native.nativeTurnId === turnId
      && candidate.native.baselineSequence !== undefined && candidate.native.renderedText === text
      && !['queued', 'preparing'].includes(candidate.native.delivery)
      && !['steer_missed', 'steer_rejected', 'acknowledged', 'cancelled'].includes(candidate.native.stage ?? ''));
    return run?.commandId;
  }
  return source.claimSteeredItem(id, turnId, item);
}
