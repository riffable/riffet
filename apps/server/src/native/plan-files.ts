import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';

/**
 * Mirrors a conversation's latest plan to a Markdown file on disk.
 *
 * The plan already lives in the transcript, which is the authority; this is a second, lossy copy
 * that exists so a plan is readable — and greppable — without the workbench running. That makes the
 * file a cache, never a source: nothing reads it back, and losing it costs nothing.
 *
 * It lands in Claude Code's own `~/.claude/plans/`, alongside the plans that CLI writes, so one
 * directory holds every plan on the machine. The cost of sharing a directory we do not own is
 * real and is paid for deliberately: every file carries a `riffet-` prefix so it can never be
 * mistaken for Claude's own, and so this writer can find its files again without ever touching a
 * neighbour's. If that CLI prunes the directory, the transcript still has the plan.
 */
export const PLAN_DIR = join(homedir(), '.claude', 'plans');

/** Longest plan written. A plan is prose for a person; past this it is a document, not a plan. */
const PLAN_LIMIT = 64 * 1024;

/** How many plan files one conversation keeps. The current plan, plus a little history to compare. */
const PLANS_PER_SESSION = 5;

export interface PlanFileWriterOptions {
  /** Overridden in tests; production uses the shared directory above. */
  directory?: string;
  /** The conversation's name, which is what makes a file recognizable in a directory listing. */
  title(sessionId: string): string | undefined;
  /** A deleted conversation: a mirror finishing after its cleanup removes itself. */
  deleted?(sessionId: string): boolean;
}

/** The Markdown body of the newest plan in a batch of events, if it carries one. */
export function latestPlanBody(events: readonly NativeWorkbenchEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'tool_call' || event.data.kind !== 'plan') continue;
    const blocks = Array.isArray(event.data.content) ? event.data.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const { type, text } = block as { type?: unknown; text?: unknown };
      if (type === 'markdown' && typeof text === 'string' && text.trim()) return text;
    }
  }
  return undefined;
}

/**
 * A file name that is readable in a shared directory and can never collide with a neighbour's:
 * the `riffet-` prefix claims it, the conversation id makes it unique, and the title is there so
 * the listing means something to a person. Anything that is not plainly a filename character is
 * dropped rather than escaped — this is a label, not a round trip.
 */
export function planFileName(sessionId: string, title: string | undefined, at: Date, nonce?: string): string {
  const slug = (title ?? '')
    .normalize('NFKD')
    .replace(/[\p{C}\p{Z}\p{P}\p{S}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // The timestamp precedes the title so a plain lexical sort is chronological: pruning picks the
  // oldest files by name, and a conversation renamed between two plans must not reorder them.
  //
  // Millisecond resolution is not enough on its own — two plans in one turn can share a
  // millisecond, and without the suffix the second would overwrite the first and the history this
  // keeps would quietly lose an entry. The suffix is appended, not inserted, so it breaks ties
  // without reordering two plans written in different milliseconds.
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return ['riffet', sessionId.slice(0, 8), `${stamp}-${nonce ?? nextTie()}`, slug].filter(Boolean).join('-') + '.md';
}

/**
 * The tiebreaker for two plans written in the same millisecond. It counts rather than randomizes,
 * because the whole scheme rests on a lexical sort being chronological: a random suffix gives two
 * same-millisecond plans distinct names but an arbitrary order between them, which is enough for
 * pruning to delete the newer of the pair and for "the newest plan" to be the older one. Fixed
 * width so the digits sort as numbers, and base 36 so four of them cover 1.6M writes before the
 * wrap — a point no process reaches, and which a later millisecond would carry past anyway.
 */
let ties = 0;
function nextTie(): string {
  ties = (ties + 1) % 36 ** 4;
  return ties.toString(36).padStart(4, '0');
}

export class PlanFileWriter {
  /** The last body written per conversation, so an unchanged plan is not rewritten on every reset. */
  private readonly written = new Map<string, string>();

  constructor(private readonly options: PlanFileWriterOptions) {}

  private get directory(): string { return this.options.directory ?? PLAN_DIR; }

  /**
   * Writes the newest plan in `events`, if it is new. Resolves to the path written, or `undefined`
   * when there was nothing to write — including every failure, because a mirror that cannot be
   * written must not disturb the conversation it mirrors.
   */
  async record(sessionId: string, events: readonly NativeWorkbenchEvent[]): Promise<string | undefined> {
    const body = latestPlanBody(events);
    if (!body || this.written.get(sessionId) === body) return undefined;
    const title = (() => { try { return this.options.title(sessionId); } catch { return undefined; } })();
    const at = new Date();
    const path = join(this.directory, planFileName(sessionId, title, at));
    const heading = [
      `<!-- riffet plan mirror · conversation ${sessionId} -->`,
      `# ${title?.trim() || 'Plan'}`,
      `*${at.toISOString()}*`,
    ].join('\n\n');
    try {
      await mkdir(this.directory, { recursive: true });
      // Written beside the target and moved into place, so a reader never sees a half-written plan
      // and a crash leaves a stray temp file rather than a truncated one under the real name.
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${heading}\n\n${body.slice(0, PLAN_LIMIT)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
      if (this.options.deleted?.(sessionId)) { await unlink(path).catch(() => undefined); return undefined; }
      this.written.set(sessionId, body);
      await this.prune(sessionId);
      return path;
    } catch {
      return undefined;
    }
  }

  /** Drops this conversation's oldest mirrors. Only ever deletes files this writer named. */
  private async prune(sessionId: string): Promise<void> {
    const prefix = `riffet-${sessionId.slice(0, 8)}-`;
    try {
      const mine = (await readdir(this.directory)).filter(name => name.startsWith(prefix) && name.endsWith('.md')).sort();
      for (const name of mine.slice(0, Math.max(0, mine.length - PLANS_PER_SESSION))) {
        await unlink(join(this.directory, name)).catch(() => undefined);
      }
    } catch { /* pruning is housekeeping; failing it must not fail the write */ }
  }

  /** Forgets a conversation's cached body, so its next plan is written again. */
  forget(sessionId: string): void { this.written.delete(sessionId); }

  /** A deleted conversation's mirrors: only files whose header names the whole conversation id, never Claude Code's own plans. */
  async remove(sessionId: string): Promise<void> {
    this.written.delete(sessionId);
    const prefix = `riffet-${sessionId.slice(0, 8)}-`;
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
    for (const name of names) {
      if (!name.endsWith('.md') || !name.startsWith(prefix)) continue;
      const path = join(this.directory, name);
      const head = await readFile(path, 'utf8').then(text => text.slice(0, 512)).catch(() => '');
      if (head.includes(`conversation ${sessionId} -->`)) await unlink(path).catch(() => undefined);
    }
  }
}
