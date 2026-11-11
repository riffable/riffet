/** The largest image served. */
export const MEDIA_MAX_BYTES = 15 * 1024 * 1024;
const SERVED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_SESSIONS = 32;

export interface ServedImage { bytes: Buffer; type: string }

/**
 * The images of a conversation's own tool calls, for a client that holds only the path the call named
 * (a screenshot an agent read or viewed). A file is served when the conversation named exactly that path,
 * and then only through the workspace's own read policy (project scope, secrets denied) as a small
 * png, jpeg, webp or gif; everything else is simply not there.
 */
export class SessionMedia {
  private readonly sets = new Map<string, { revision: string; paths: Set<string> }>();
  private readonly building = new Map<string, Promise<Set<string>>>();

  /**
   * `namedPaths` reads the paths a session's tool rows name; `revision` changes whenever those rows may have;
   * `fresh` first brings the timeline up to date; `load` reads an image the way the workspace allows.
   */
  constructor(
    private readonly namedPaths: (sessionId: string) => Set<string>,
    private readonly revision: (sessionId: string) => string,
    private readonly fresh: (sessionId: string) => Promise<unknown>,
    private readonly load: (sessionId: string, path: string, allowOutside: boolean) => Promise<{ mimeType: string; data: Buffer }>,
  ) {}

  async read(sessionId: string, path: string, allowOutside: boolean): Promise<ServedImage | undefined> {
    if (!await this.named(sessionId, path)) return undefined;
    try {
      const { mimeType, data } = await this.load(sessionId, path, allowOutside);
      return SERVED.has(mimeType) && data.length <= MEDIA_MAX_BYTES ? { bytes: data, type: mimeType } : undefined;
    } catch { return undefined; }
  }

  private async named(sessionId: string, path: string): Promise<boolean> {
    const known = this.sets.get(sessionId);
    if (known?.revision === this.revision(sessionId) && known.paths.has(path)) return true;
    return (await this.rebuilt(sessionId)).has(path);
  }

  /** The session's named paths after the timeline caught up; simultaneous callers share one scan. */
  private rebuilt(sessionId: string): Promise<Set<string>> {
    const running = this.building.get(sessionId);
    if (running) return running;
    const job = (async () => {
      await this.fresh(sessionId);
      const revision = this.revision(sessionId);
      const known = this.sets.get(sessionId);
      if (known?.revision === revision) return known.paths;
      const paths = this.namedPaths(sessionId);
      this.sets.delete(sessionId);
      this.sets.set(sessionId, { revision, paths });
      for (const id of this.sets.keys()) { if (this.sets.size <= MAX_SESSIONS) break; this.sets.delete(id); }
      return paths;
    })().finally(() => { this.building.delete(sessionId); });
    this.building.set(sessionId, job);
    return job;
  }
}
