import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { NativeWorkbenchEvent, Session } from '../../../../../packages/contracts/src/index.js';
import { readContextFile } from '../../context-references/read-file.js';
import { AppError } from '../../errors.js';
import type { UsageTranscript } from '../../stats/types.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeShareReadOptions } from '../types.js';
import type { CodexFlavor } from './flavors.js';
import { findCodexRollout, RolloutUsageReader } from './rollout-usage.js';
import { projectShareRollout, readCodexShare } from './share-read.js';

/** How long a rollout must sit unwritten before its last turn is taken as finished. */
const ROLLOUT_QUIET_MS = 60_000;

/** Reads the thread's rollout file directly; the app-server is not involved. */
export async function usageTranscript(flavor: CodexFlavor, session: Session, profile: NativeBackendProfileConfig, known?: string): Promise<UsageTranscript | undefined> {
  const threadId = session.nativeSessionId;
  const file = threadId ? await findCodexRollout(flavor.stateHome(profile.config), threadId) : undefined;
  if (!threadId || !file) return known === 'none' ? undefined : { generation: 'none', entries: [] };
  const info = await stat(file);
  const quiet = Date.now() - info.mtimeMs >= ROLLOUT_QUIET_MS;
  const generation = `${info.size}:${Math.round(info.mtimeMs)}:${quiet ? 'quiet' : 'busy'}`;
  if (generation === known) return undefined;
  // Streamed: a rollout runs to tens of megabytes, and only its usage rows are parsed (docs/guide/performance.md §3.8).
  const reader = new RolloutUsageReader(threadId);
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) reader.line(line);
  const entries = reader.records(quiet).map(usage => ({ usage }));
  return { generation, entries };
}

export async function readContextTranscript(flavor: CodexFlavor, session: Session, profile: NativeBackendProfileConfig, options: { maxBytes: number; signal: AbortSignal }): Promise<NativeWorkbenchEvent[]> {
  if (!session.nativeSessionId) return [];
  // Earlier topics are other threads' rollouts; the journal holds them all in order.
  if (session.previousNativeSessionIds?.length) throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'Use the saved journal for a conversation over several threads', 409);
  const file = await findCodexRollout(flavor.stateHome(profile.config), session.nativeSessionId);
  if (!file) throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'The native history file is unavailable', 409);
  const content = await readContextFile(file, options.maxBytes, options.signal);
  const metadata = content.split('\n', 1).map(line => { try { return JSON.parse(line); } catch { return undefined; } })[0]?.payload;
  if (metadata?.history_base || metadata?.id && metadata.id !== session.nativeSessionId) throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'Use the saved journal for inherited native history', 409);
  return projectShareRollout(content, session.id, session.nativeSessionId, true).events;
}

export function readShareTranscript(flavor: CodexFlavor, host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: NativeShareReadOptions) {
  return readCodexShare(host, session, flavor.stateHome(profile.config), options);
}
