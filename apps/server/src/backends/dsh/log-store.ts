import { createRequire } from 'node:module';
import { watch as watchFiles } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '../../errors.js';
import { resolveExecutable, type DshRuntimeSettings } from './settings.js';
import { asRecord } from './util.js';

/** One stored DSH session: its header facts and every committed record, `seq` equal to the index. */
export interface DshLog {
  createdAt?: number;
  cwd?: string;
  events: readonly unknown[];
}

/** DSH's stored session logs, read only. */
export interface DshLogReader {
  /** A token that changes whenever the stored log does; undefined when DSH stores no such session. */
  revision(id: string): Promise<string | undefined>;
  /** The whole stored log, or undefined when DSH stores no such session. */
  read(id: string): Promise<DshLog | undefined>;
  /**
   * Calls `listener` with the id of each stored session whose files change, whoever writes them; with
   * undefined, now and then, where the store cannot tell. Returns how to stop.
   */
  watch?(listener: (id: string | undefined) => void): () => void;
}

/** How often a store whose directory cannot be watched says that anything may have changed. */
const UNWATCHED_POLL_MS = 5_000;

interface StoredHeader { id?: unknown; cwd?: unknown; createdAt?: unknown }
interface SessionHandle { readonly header: StoredHeader; read(): Promise<{ events: readonly unknown[] }>; close(): Promise<void> }
interface SessionPersistence {
  stat(id: string): Promise<{ revision: string; header: StoredHeader } | undefined>;
  open(id: string, access: 'read'): Promise<SessionHandle>;
}
interface ReadContext { fiber: { dispose(): Promise<void> }; sessionPersistence: SessionPersistence }

/** A `require` that resolves DSH's own packages from the install the profile launches; undefined when there is none. */
export async function dshInstallRequire(settings: DshRuntimeSettings): Promise<NodeJS.Require | undefined> {
  const command = resolveExecutable(settings);
  if (!command) return undefined;
  const entry = command.args[0]?.endsWith('.js') ? command.args[0] : command.executable;
  try { return createRequire(await realpath(entry)); } catch { return undefined; }
}

/** The physical encoding of a sessions root, sniffed from the first released log file; decoding stays DSH's. */
export async function storageCompression(root: string, signal?: AbortSignal): Promise<'none' | 'zstd'> {
  signal?.throwIfAborted();
  for (const project of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    signal?.throwIfAborted();
    if (!project.isDirectory()) continue;
    for (const session of await readdir(join(root, project.name), { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (!session.isDirectory()) continue;
      for (const file of await readdir(join(root, project.name, session.name))) {
        signal?.throwIfAborted();
        if (/^session(?:\.v[1-9][0-9]*)?\.jsonl\.zstd$/.test(file)) return 'zstd';
        if (/^session(?:\.v[1-9][0-9]*)?\.jsonl$/.test(file)) return 'none';
      }
    }
  }
  return 'zstd';
}

const IMAGE_REFERENCE = /^sha256:([a-f0-9]{64})$/;

/**
 * `event` with the stored object behind each image block named as `hostPath`, the way the bridge's
 * `withImagePaths` names it through DSH's attachment service: a normalized image lives at
 * `<DSH_HOME>/attachments/v1/objects/<first two digits>/<digest>` (`dsh-attachment-local`).
 */
function withImagePaths(event: unknown, attachments: string): unknown {
  const record = asRecord(event);
  const data = asRecord(record?.data);
  const message = asRecord(data?.message);
  if (!record || !data || !message || !Array.isArray(message.content)) return event;
  let resolved = false;
  const content = message.content.map(value => {
    const block = asRecord(value);
    const attachment = asRecord(block?.attachment);
    if (!block || block.type !== 'image' || typeof block.hostPath === 'string' || typeof attachment?.mediaType !== 'string') return value;
    const digest = IMAGE_REFERENCE.exec(String(attachment.attachmentId))?.[1];
    if (!digest) return value;
    resolved = true;
    return { ...block, hostPath: join(attachments, 'objects', digest.slice(0, 2), digest) };
  });
  return resolved ? { ...record, data: { ...data, message: { ...message, content } } } : event;
}

const isNotFound = (error: unknown): boolean => (error as { name?: unknown } | undefined)?.name === 'SessionPersistenceNotFoundError'
  || (error as { constructor?: { name?: unknown } } | undefined)?.constructor?.name === 'SessionPersistenceNotFoundError';

/**
 * The profile's stored sessions through DSH's own persistence backend (`dsh-session-persistence-jsonl`),
 * mounted once and kept: only read handles are opened, which never take ownership and work while DSH
 * writes. No agent, tool or model service is mounted, and nothing is ever written.
 */
export class DshLogStore implements DshLogReader {
  private mounted?: Promise<ReadContext>;
  private readonly listeners = new Set<(id: string | undefined) => void>();
  private watcher?: { close(): void };

  constructor(private readonly settings: DshRuntimeSettings) {}

  private get root(): string { return join(this.settings.profileHome, 'sessions'); }

  private persistence(): Promise<ReadContext> {
    const mounting = this.mounted ??= this.mount();
    // A failed mount (no DSH installed yet) is retried on the next read.
    mounting.catch(() => { if (this.mounted === mounting) this.mounted = undefined; });
    return mounting;
  }

  private async mount(): Promise<ReadContext> {
    const require = await dshInstallRequire(this.settings);
    let modules: unknown[];
    try {
      if (!require) throw new Error('no DSH install');
      modules = await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/dsh-session-persistence-jsonl'].map(async name => await import(pathToFileURL(require.resolve(name)).href)));
    } catch { throw new AppError('DSH_HISTORY_UNAVAILABLE', 'This DSH installation lacks the official session store reader', 409); }
    const { Context } = modules[0] as { Context: new () => ReadContext };
    const { apply } = modules[1] as { apply(context: ReadContext, config: { root: string; compression: 'none' | 'zstd' }): Promise<void> };
    const context = new Context();
    try {
      await apply(context, { root: this.root, compression: await storageCompression(this.root) });
      return context;
    } catch (error) {
      await context.fiber.dispose().catch(() => undefined);
      throw error;
    }
  }

  async revision(id: string): Promise<string | undefined> {
    const { sessionPersistence } = await this.persistence();
    return (await sessionPersistence.stat(id))?.revision;
  }

  async read(id: string): Promise<DshLog | undefined> {
    const { sessionPersistence } = await this.persistence();
    let handle: SessionHandle;
    try { handle = await sessionPersistence.open(id, 'read'); } catch (error) { if (isNotFound(error)) return undefined; throw error; }
    try {
      const { events } = await handle.read();
      const attachments = join(this.settings.profileHome, 'attachments', 'v1');
      const { createdAt, cwd } = handle.header;
      return {
        ...(typeof createdAt === 'number' ? { createdAt } : {}),
        ...(typeof cwd === 'string' ? { cwd } : {}),
        events: events.map(event => withImagePaths(event, attachments)),
      };
    } finally { await handle.close().catch(() => undefined); }
  }

  watch(listener: (id: string | undefined) => void): () => void {
    this.listeners.add(listener);
    this.watcher ??= this.watchRoot();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.watcher?.close();
      this.watcher = undefined;
    };
  }

  /** One watch of the whole sessions root, for every listener; a slow poll where it cannot be watched. */
  private watchRoot(): { close(): void } {
    const emit = (id: string | undefined) => {
      for (const listener of this.listeners) { try { listener(id); } catch { /* a listener's failure is its own */ } }
    };
    const poll = () => {
      const timer = setInterval(() => emit(undefined), UNWATCHED_POLL_MS);
      timer.unref();
      return { close: () => clearInterval(timer) };
    };
    try {
      // `<project>/<session>/<file>`: a session's directory is DSH's path encoding of its id, the id itself for every id DSH makes.
      const watcher = watchFiles(this.root, { recursive: true, persistent: false }, (_event, name) => {
        const session = typeof name === 'string' ? name.split(sep)[1] : undefined;
        if (session) emit(session);
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === handle) this.watcher = poll();
      });
      const handle = { close: () => watcher.close() };
      return handle;
    } catch {
      return poll();
    }
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    this.listeners.clear();
    const mounting = this.mounted;
    this.mounted = undefined;
    const context = await mounting?.catch(() => undefined);
    await context?.fiber.dispose();
  }
}
