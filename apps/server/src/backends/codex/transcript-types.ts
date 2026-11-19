import type { NativeActivity } from '../../../../../packages/contracts/src/index.js';
import type { ItemSpans } from './item-spans.js';
import type { ObservedChanges } from './transcript.js';
import type { RpcItem, RpcTurn } from './types.js';

/*
 * What `CodexTranscriptSource` is given by the runtime that owns it: the reader of `thread/turns/list`,
 * the live feed and the options. They hold no state of their own.
 */

export interface CodexTurnPage { data?: RpcTurn[]; nextCursor?: string | null }

export interface CodexTurnsRequest {
  threadId: string;
  cursor?: string;
  limit: number;
  sortDirection: 'asc' | 'desc';
  /** `notLoaded` / `summary` leave the items out: a header scan. */
  itemsView?: 'full' | 'notLoaded' | 'summary';
}

/** `thread/turns/list` of the app-server the runtime is connected to. */
export interface CodexThreadReader {
  /** One page; undefined while the thread cannot be read yet (not materialized). */
  turnsPage(request: CodexTurnsRequest): Promise<CodexTurnPage | undefined>;
  /** This reader created the thread empty, before any nonempty history was read. */
  hasEmptyHistoryBaseline?(threadId: string): boolean;
  /** Metadata-only native question requests, including requests made before this reader attached. */
  questionRequests?(threadId: string): RpcItem[];
  /** Current execution evidence; a history read can temporarily call this turn interrupted. */
  isTurnRunning?(threadId: string, turn: RpcTurn): boolean;
}

/** What the connected runtime passes on between reads. */
export interface CodexLiveFeed {
  /** A notification of the conversation's own thread. */
  notification(method: string, params: Record<string, unknown>): void;
  /** A state of a compaction or background terminal, as the runtime's activity tracker settles it. */
  activity(activity: NativeActivity): void;
  /** Whether a reader follows the conversation now; absent means one does. */
  active?(): boolean;
  /** The app-server connection that reported turns went away: what it said was running is unproven. */
  lost?(): void;
}

export interface CodexTranscriptOptions {
  /** The workbench session the lanes belong to. */
  sessionId: string;
  /** The flavor's id, which prefixes its activity ids. */
  backend: string;
  /** What a shell command changed in the working tree, by its tool call id (`observation.ts`). */
  observedChanges?: ObservedChanges;
  /** The thread the conversation follows now. */
  threadId(): string | undefined;
  /** The threads it followed before, oldest first: each new topic (`/new`) went on in a new thread (`Session.previousNativeSessionIds`). */
  earlierThreads?(): readonly string[];
  /** The message that ended `threadId` and started the next thread: the `/new` the owner sent. */
  topicAfter?(threadId: string): { commandId: string; runId: string; text: string; at: string } | undefined;
  /** A reader of the thread when one is connected; undefined while offline. */
  reader(): Promise<CodexThreadReader | undefined>;
  /** The workbench command a user item answers, by the tag the flavor echoes. */
  commandOf(item: RpcItem, turnId: string): string | undefined;
  /** The run of a workbench command. */
  runOf(commandId: string): string | undefined;
  /** The runtime's live feed while it is connected; returns how to stop. */
  observe?(feed: CodexLiveFeed): () => void;
  /** When the thread's items happened (`item-spans.ts`); a thread's own rollout, the conversation's or a subagent's. Rows keep their turn's start without it. */
  itemSpans?(threadId: string): Promise<ItemSpans | undefined>;
  /** What the provider said of a failed turn, fit to show; its end mark carries it to whoever settles the run. */
  turnError?(turn: RpcTurn): string | undefined;
}
