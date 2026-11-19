import { basename } from 'node:path';
import type { ExternalHolder, ExternalSessionEntry, ExternalSessionScan, NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import { EXTERNAL_CACHE_MS, holderOf, listExternalThreads, scanProcesses, type ProcessRow } from './external.js';
import { executableOf } from './config.js';
import type { CodexFlavor } from './flavors.js';
import type { Project } from '../../../../../packages/contracts/src/index.js';

interface ExternalSessionsContext {
  readonly flavor: CodexFlavor;
  withManagementTransport<T>(project: Project | undefined, profile: NativeBackendProfileConfig, action: (transport: CodexAppServerClient) => Promise<T>): Promise<T>;
  /** The addresses of the app-servers this adapter's own runtimes are connected to. */
  ownAddresses(): Iterable<string>;
}

/**
 * Listing the CLI threads that Riffet did not start, and telling who holds one. It owns the cache of
 * thread lists; it does not own sessions, and importing a thread is the core's job.
 */
export class CodexExternalSessions {
  /** Recent `list` results: a scan starts a management app-server. */
  private readonly scans = new Map<string, { at: number; entries: ExternalSessionEntry[] }>();

  constructor(private readonly ctx: ExternalSessionsContext) {}

  async list(host: NativeBackendHost, profile: NativeBackendProfileConfig, options: ExternalSessionScan): Promise<ExternalSessionEntry[]> {
    const key = `${profile.id}:${options.includeNonInteractive}:${options.limit}`;
    let cached = this.scans.get(key);
    if (!cached || Date.now() - cached.at > EXTERNAL_CACHE_MS) {
      const entries = await this.ctx.withManagementTransport(undefined, profile, async transport => {
        // A slow start or page must not outlive the caller.
        const aborted = new Promise<never>((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        aborted.catch(() => undefined);
        return await Promise.race([
          listExternalThreads(params => transport.request<unknown>('thread/list', params, 30_000), options),
          aborted,
        ]);
      });
      cached = { at: Date.now(), entries };
      this.scans.set(key, cached);
    }
    // Who holds a thread changes faster than the list, so it is read on every call, in one `ps` scan.
    const rows = await scanProcesses();
    return cached.entries.map(entry => {
      const live = this.holderIn(rows, profile, entry.nativeSessionId);
      return live ? { ...entry, live } : entry;
    });
  }

  async holder(_host: NativeBackendHost, profile: NativeBackendProfileConfig, threadId: string): Promise<ExternalHolder | undefined> {
    return this.holderIn(await scanProcesses(), profile, threadId);
  }

  private holderIn(rows: readonly ProcessRow[], profile: NativeBackendProfileConfig, threadId: string): ExternalHolder | undefined {
    const executables = new Set([this.ctx.flavor.command, basename(executableOf(profile, this.ctx.flavor))]);
    const own = new Set<string>();
    for (const address of this.ctx.ownAddresses()) own.add(address);
    return holderOf(rows, threadId, executables, own);
  }
}
