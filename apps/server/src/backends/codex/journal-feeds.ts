import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { TranscriptSource } from '../../journal/ingest.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { safeTurnError } from './errors.js';
import type { CodexFlavor } from './flavors.js';
import { rolloutItemSpans } from './item-spans.js';
import { commandIdOfMessageId } from './message-tag.js';
import type { CodexObservation } from './observation.js';
import type { CodexSessionRuntime } from './runtime.js';
import { CodexTranscriptSource, newTopicAfter, type CodexLiveFeed } from './transcript-source.js';
import type { RpcItem } from './types.js';
import { str } from './util.js';

interface JournalFeedsContext {
  readonly flavor: CodexFlavor;
  readonly observation?: CodexObservation;
  runtime(sessionId: string): CodexSessionRuntime | undefined;
  /** Whether the session's runtime is being replaced, so a reader must not start one. */
  restarting(sessionId: string): boolean;
  profileSwitchPending(session: Session): boolean;
  activeProfile(host: NativeBackendHost, session: Session, desired: NativeBackendProfileConfig): NativeBackendProfileConfig;
  externalHolder(host: NativeBackendHost, profile: NativeBackendProfileConfig, threadId: string): Promise<unknown>;
  ensureRuntime(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<CodexSessionRuntime>;
}

/**
 * How the session journal follows the adapter's threads: the transcript source it reads through, and
 * the live feeds those sources register so that every runtime of a session reports to all of them.
 * It owns the registered feeds; it does not own runtimes or decide when one is created.
 */
export class CodexJournalFeeds {
  /** The journal's transcript sources following each session's runtime. */
  private readonly feeds = new Map<string, Set<CodexLiveFeed>>();

  constructor(private readonly ctx: JournalFeedsContext) {}

  /**
   * The thread as the session journal reads it (`transcript-source.ts`), through the session's
   * runtime: a pull connects it as a snapshot does, and its notifications are the live feed.
   */
  source(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): TranscriptSource {
    const sessionId = session.id;
    const threadOf = () => host.getSession(sessionId).nativeSessionId;
    return new CodexTranscriptSource({
      sessionId,
      backend: this.ctx.flavor.id,
      ...(this.ctx.observation ? {
        observedChanges: (toolCallId: string) => this.ctx.observation?.changes(sessionId, toolCallId),
        fileSnapshots: (toolCallId: string) => this.ctx.observation?.snapshots(sessionId, toolCallId),
      } : {}),
      threadId: threadOf,
      earlierThreads: () => host.getSession(sessionId).previousNativeSessionIds ?? [],
      topicAfter: threadId => {
        const run = host.listRuns?.(sessionId).find(candidate => candidate.native?.backendId === this.ctx.flavor.id && newTopicAfter(candidate.native.nativeInputBoundary) === threadId);
        return run?.native ? { commandId: run.commandId, runId: run.id, text: run.native.input.text, at: run.createdAt } : undefined;
      },
      reader: async () => {
        if (!threadOf()) return undefined;
        // The restart drains the old journal before stopping its writer. Do not have that drain
        // wait on the very restart it belongs to or spawn a reader during the handover.
        if (this.ctx.restarting(sessionId)) {
          const current = this.ctx.runtime(sessionId);
          return current?.transport?.isOnline ? current : undefined;
        }
        const current = host.getSession(sessionId);
        const resolved = this.ctx.profileSwitchPending(current)
          ? this.ctx.activeProfile(host, current, profile) : host.getProfile?.(current) ?? profile;
        // A terminal's own CLI holds the thread without Riffet's app-server (a hold, or a reader's own `codex resume`
        // after "resume in terminal"); a second app-server loading it here would be a second holder.
        if (!this.ctx.runtime(sessionId)?.transport?.isOnline) {
          const threadId = current.nativeSessionId;
          if (current.terminalHold || threadId && await this.ctx.externalHolder(host, resolved, threadId)) return undefined;
        }
        const runtime = await this.ctx.ensureRuntime(host, current, host.getProject(current.projectId), resolved);
        return runtime.transport?.isOnline ? runtime : undefined;
      },
      commandOf: (item, turnId) => this.ctx.runtime(sessionId)?.commandOf(item, turnId) ?? taggedCommand(item, this.ctx.flavor),
      itemSpans: threadId => rolloutItemSpans(this.ctx.flavor.stateHome(profile.config), threadId),
      runOf: commandId => host.findRunIdByCommand(sessionId, commandId),
      turnError: turn => {
        const actual = this.ctx.runtime(sessionId)?.launchProfile.config;
        return safeTurnError(turn.error, profile.config, actual ?? {});
      },
      observe: feed => {
        let feeds = this.feeds.get(sessionId);
        if (!feeds) this.feeds.set(sessionId, feeds = new Set());
        feeds.add(feed);
        return () => { feeds.delete(feed); if (!feeds.size && this.feeds.get(sessionId) === feeds) this.feeds.delete(sessionId); };
      },
    });
  }

  /** What every runtime of a session tells the transcript sources that follow it. */
  feedOf(sessionId: string): CodexLiveFeed {
    const each = (fn: (feed: CodexLiveFeed) => void) => { for (const feed of this.feeds.get(sessionId) ?? []) fn(feed); };
    return {
      notification: (method, params) => each(feed => feed.notification(method, params)), activity: activity => each(feed => feed.activity(activity)),
      active: () => (this.feeds.get(sessionId)?.size ?? 0) > 0,
      lost: () => each(feed => feed.lost?.()),
    };
  }
}

/** The workbench command a user item names by the tag the flavor echoes, read without a runtime. */
function taggedCommand(item: RpcItem, flavor: CodexFlavor): string | undefined {
  if (item.type !== 'userMessage') return undefined;
  if (flavor.messageTag.echo === 'clientId') return str(item.clientId);
  const id = str(item.id);
  return commandIdOfMessageId(id);
}
