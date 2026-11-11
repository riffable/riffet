import { open, stat } from 'node:fs/promises';

/**
 * Background jobs write their own log next to the workspace the CLI keeps for a project:
 *
 *     ---
 *     pid: 43746
 *     cwd: "/home/you/code/project"
 *     command: "node -e …"
 *     title: "Start a 10s background task generating random number"
 *     status: succeeded
 *     started_at: 2026-10-01T02:43:04.119Z
 *     running_for_ms: 10331
 *     ---
 *     RESULT:530982
 *
 *     ---
 *     exit_code: 0
 *     elapsed_ms: 10331
 *     ended_at: …
 *
 * Reading it is what makes a job's row truthful while it runs (the transcript only learns about a
 * job when the agent happens to await it), and it is the CLI's own bookkeeping rather than a guess.
 */

export interface JobLog {
  title?: string;
  command?: string;
  status?: 'running' | 'succeeded' | 'failed';
  runningMs?: number;
  exitCode?: number;
  output?: string;
  /** Whether the output shown is the end of a log too large to read whole. */
  truncated: boolean;
}

/** Only the CLI's own per-shell logs are read, and only from inside a `projects/` tree. */
const JOB_LOG_PATH = /\/projects\/[^/]+\/terminals\/\d+\.txt$/;
export const isJobLogPath = (path: string): boolean => path.startsWith('/') && !path.includes('\0') && JOB_LOG_PATH.test(path);

const HEAD_BYTES = 4 * 1024;
const TAIL_BYTES = 64 * 1024;

/** The log's head (its metadata) plus the tail of its output, so a large log stays cheap to read. */
export async function readJobLog(path: string): Promise<JobLog | undefined> {
  if (!isJobLogPath(path)) return undefined;
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, info.size));
    await handle.read(head, 0, head.length, 0);
    const truncated = info.size > HEAD_BYTES + TAIL_BYTES;
    const tailLength = truncated ? TAIL_BYTES : Math.max(0, info.size - head.length);
    const tail = Buffer.alloc(tailLength);
    if (tailLength) await handle.read(tail, 0, tailLength, info.size - tailLength);
    return parseJobLog(head.toString('utf8') + (tailLength ? tail.toString('utf8') : ''), truncated);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const field = (text: string, name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim();
/** The CLI writes `title` and `command` as JSON strings; decode them rather than show escapes. */
const unquote = (text: string) => {
  const value = text.trim();
  if (!/^".*"$/s.test(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value.slice(1, -1);
  } catch { return value.slice(1, -1); }
};

/**
 * The log is `---`-delimited: a metadata block, the command's output, and a trailing block with the
 * exit code. Sections are identified by the fields they carry rather than by position, so a job
 * that is still running (no trailing block yet) and output that itself contains `---` both parse.
 */
export function parseJobLog(text: string, truncated = false): JobLog {
  const sections = text.split(/^---+\s*$/m).map((section) => section.trim());
  const meta = sections.find((section) => /^(?:pid|command|status|title|started_at|running_for_ms):/m.test(section));
  const footer = sections.find((section) => /^(?:exit_code|elapsed_ms|ended_at):/m.test(section));
  // Sections are joined back with the delimiter they were split on, so output that contains a
  // `---` line survives the round trip.
  const output = sections.filter((section) => section && section !== meta && section !== footer).join('\n---\n').trim();
  const title = meta ? field(meta, 'title') : undefined;
  const status = meta ? field(meta, 'status') : undefined;
  const runningMs = Number((footer ? field(footer, 'elapsed_ms') : undefined) ?? (meta ? field(meta, 'running_for_ms') : undefined));
  const exitCode = footer ? Number(field(footer, 'exit_code')) : Number.NaN;
  const command = meta ? field(meta, 'command') : undefined;
  return {
    ...(title ? { title: unquote(title) } : {}),
    ...(command ? { command: unquote(command) } : {}),
    ...(status === 'running' || status === 'succeeded' || status === 'failed' ? { status } : {}),
    ...(Number.isFinite(runningMs) && runningMs > 0 ? { runningMs } : {}),
    ...(Number.isFinite(exitCode) ? { exitCode } : {}),
    ...(output ? { output } : {}),
    truncated,
  };
}
