import { homedir } from 'node:os';
import { stripVTControlCharacters, styleText } from 'node:util';

/*
 * How every `riffet` command prints. Results go to stdout, everything addressed to the person at the
 * terminal (progress, hints, errors) to stderr, so `riffet token | pbcopy` or `riffet ls --json | jq`
 * stay clean. Color follows the stream it is written to: `styleText` drops it when that stream is not a
 * terminal, when NO_COLOR is set (`--no-color` sets it) and honors FORCE_COLOR.
 *
 * The palette is small on purpose. One accent (the brand blue) marks the product and addresses; green,
 * yellow and red only ever mean ok, attention and failure; labels and secondary facts are dimmed;
 * commands the reader can run are bold.
 */

type Stream = NodeJS.WriteStream;
type Format = Parameters<typeof styleText>[0];

const supportsHex = (() => {
  try {
    styleText('#5B8CFF' as Format, 'x', { validateStream: false });
    return true;
  } catch {
    return false;
  }
})();

/** Brand blue where the terminal renders 24-bit color and Node supports hex styles; the nearest of the 16 colors elsewhere (Terminal.app). */
const accentFormat = (): Format => (supportsHex && /^(?:truecolor|24bit)$/i.test(process.env.COLORTERM ?? '') ? '#5B8CFF' as Format : 'blueBright');

export interface Paint {
  accent(text: string): string;
  /** An address: accent, so it reads as something to open. */
  url(text: string): string;
  /** A command to type. */
  cmd(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
  fail(text: string): string;
  /** One of a few calm colors chosen by `key`, so the same scope keeps its color across lines and runs. */
  tag(text: string, key?: string): string;
  /** Inline `code` spans in prose (doctor fixes, plugin messages) become commands. */
  prose(text: string): string;
  readonly enabled: boolean;
}

const TAG_COLORS: Format[] = ['cyan', 'magenta', 'blue', 'green', 'cyanBright', 'magentaBright', 'blueBright', 'greenBright'];

export function paint(stream: Stream = process.stdout): Paint {
  const style = (format: Format) => (text: string) => styleText(format, text, { stream });
  const enabled = style('bold')('x') !== 'x';
  const cmd = style('bold');
  return {
    accent: text => styleText(accentFormat(), text, { stream }),
    url: text => styleText(accentFormat(), text, { stream }),
    cmd,
    bold: style('bold'),
    dim: style('dim'),
    ok: style('green'),
    warn: style('yellow'),
    fail: style('red'),
    tag: (text, key = text) => {
      let hash = 0;
      for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      return styleText(TAG_COLORS[hash % TAG_COLORS.length]!, text, { stream });
    },
    prose: text => text.replace(/`([^`]+)`/g, (_match, code: string) => cmd(code)),
    enabled,
  };
}

export const out = paint(process.stdout);
export const err = paint(process.stderr);

/** Marks: one cell wide in every terminal, unlike emoji. */
export const MARK = { ok: '✓', warn: '!', fail: '✗', running: '●', stopped: '○', arrow: '→', dot: '·' } as const;

export type Status = 'ok' | 'warn' | 'fail';
export const mark = (status: Status, p: Paint = out): string =>
  status === 'ok' ? p.ok(MARK.ok) : status === 'warn' ? p.warn(MARK.warn) : p.fail(MARK.fail);

/** Both ends of a conversation are people at a terminal: prompts and pickers only then. */
export const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

// ---------------------------------------------------------------------------------------------------
// Layout

/** Wide (two-cell) code points: CJK, Hangul, fullwidth forms and emoji, enough for titles and paths. */
function wide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd);
}

/** Terminal cells `text` takes, ignoring color codes. */
export function width(text: string): number {
  let cells = 0;
  for (const char of stripVTControlCharacters(text)) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue;
    cells += wide(code) ? 2 : 1;
  }
  return cells;
}

/** Pads plain or colored text to `cells`. */
export const pad = (text: string, cells: number): string => text + ' '.repeat(Math.max(0, cells - width(text)));

/** Cuts plain text to `cells`, ending in an ellipsis when it had to cut. */
export function truncate(text: string, cells: number): string {
  if (width(text) <= cells) return text;
  let result = '', used = 0;
  for (const char of text) {
    const next = width(char);
    if (used + next > cells - 1) break;
    result += char; used += next;
  }
  return result + '…';
}

/** Columns separated by two spaces; the last column is never padded. Cells may carry color. */
export function columns(rows: string[][], options: { indent?: number; gap?: number } = {}): string[] {
  const gap = ' '.repeat(options.gap ?? 2), indent = ' '.repeat(options.indent ?? 0);
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, index) => { widths[index] = Math.max(widths[index] ?? 0, width(cell)); });
  return rows.map(row => indent + row.map((cell, index) => (index === row.length - 1 ? cell : pad(cell, widths[index]!))).join(gap).trimEnd());
}

/** `Label   value` rows with dimmed labels, as `status` and `start` print them. */
export function fields(rows: Array<[label: string, value: string | undefined]>, options: { indent?: number; p?: Paint } = {}): string[] {
  const p = options.p ?? out;
  return columns(rows.filter((row): row is [string, string] => row[1] !== undefined).map(([label, value]) => [p.dim(label), value]), { indent: options.indent ?? 2, gap: 3 });
}

/** A path under the home directory, as people write it. */
export function tilde(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

/** `3h 12m`, `45s`, `2d 4h`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** `just now`, `5m ago`, `3h ago`, `yesterday`, `4d ago`, `Nov 3`. */
export function ago(iso: string | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(days > 300 ? { year: 'numeric' } : {}) });
}

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------
// Messages

/** A failure the reader can act on: printed as `✗ message`, then `→ hint` lines. */
export class CliError extends Error {
  constructor(message: string, readonly hints: string[] = [], readonly exitCode = 1) { super(message); }
}

/** Something the user typed wrong; exit code 2. */
export class UsageError extends CliError {
  constructor(message: string, hints: string[] = []) { super(message, hints, 2); }
}

/** `→ riffet start` lines; text inside backticks is a command. A bare string that starts with `riffet ` is a command too. */
export function hint(text: string, p: Paint = err): string {
  const body = /^riffet\b/.test(text) && !text.includes('`') ? p.cmd(text) : p.prose(text);
  return `  ${p.dim(MARK.arrow)} ${body}`;
}

/** The reader backed out of a prompt; nothing more to say. */
export class Cancelled extends CliError {
  constructor() { super('Cancelled', [], 130); }
}

export function printError(error: unknown): number {
  if (error instanceof Cancelled) return error.exitCode;
  const message = error instanceof Error ? error.message : String(error);
  const [first = '', ...rest] = message.split('\n');
  process.stderr.write(`${err.fail(MARK.fail)} ${err.prose(first)}\n`);
  for (const line of rest) process.stderr.write(`  ${line}\n`);
  if (error instanceof CliError) for (const line of error.hints) process.stderr.write(hint(line) + '\n');
  return error instanceof CliError ? error.exitCode : 1;
}

/** A note to the reader, on stderr. */
export const note = (text: string): void => { process.stderr.write(`${err.dim(MARK.dot)} ${err.prose(text)}\n`); };
export const warning = (text: string): void => { process.stderr.write(`${err.warn(MARK.warn)} ${err.prose(text)}\n`); };
export const success = (text: string): void => { process.stdout.write(`${out.ok(MARK.ok)} ${out.prose(text)}\n`); };

export const printLines = (lines: string[]): void => { for (const line of lines) process.stdout.write(line + '\n'); };
export const printJson = (value: unknown): void => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); };

// ---------------------------------------------------------------------------------------------------
// Progress

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  update(text: string): void;
  /** Replaces the spinner line with a final one; `undefined` only clears it. */
  stop(final?: string): void;
  /** Ends with `✓ text` and how long the step took: the line a finished step leaves behind. */
  done(text: string): void;
  /** Ends with `✗ text` and how long the step ran. */
  fail(text: string): void;
}

/** A step's length: tenths below ten seconds, where a restart's steps usually fall. */
const stepTime = (ms: number) => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : duration(ms));
/** A spinner shows how long it has run once that is long enough to wonder whether it is stuck. */
const ELAPSED_AFTER_MS = 2_000;

/** A one-line spinner on stderr; where stderr is not a terminal it prints nothing and `stop`, `done` and `fail` print the final line. */
export function spinner(text: string): Spinner {
  const stream = process.stderr;
  const startedAt = Date.now();
  const result = (marker: string, label: string) => `${marker} ${label}  ${err.dim(stepTime(Date.now() - startedAt))}`;
  if (!stream.isTTY) {
    const stop = (final?: string) => { if (final) stream.write(final + '\n'); };
    return { update() {}, stop, done: label => stop(result(err.ok(MARK.ok), label)), fail: label => stop(result(err.fail(MARK.fail), label)) };
  }
  // A pseudo-terminal without a size reports 0 columns.
  const fit = (value: string, reserve: number) => { const room = (stream.columns || 80) - 4 - reserve; return value.length > room ? value.slice(0, room - 1) + '…' : value; };
  let frame = 0, current = text;
  const draw = () => {
    const elapsed = Date.now() - startedAt;
    const suffix = elapsed >= ELAPSED_AFTER_MS ? duration(elapsed) : '';
    stream.write(`\r\x1b[2K${err.accent(FRAMES[frame++ % FRAMES.length]!)} ${fit(current, suffix ? suffix.length + 2 : 0)}${suffix ? '  ' + err.dim(suffix) : ''}`);
  };
  stream.write('\x1b[?25l');
  draw();
  // Never what keeps the process alive: an error that skips `stop` must still let it exit.
  const timer = setInterval(draw, 80);
  timer.unref();
  const restore = () => stream.write('\x1b[?25h');
  // Ctrl+C does not run 'exit' handlers; the cursor must come back either way.
  const interrupt = (signal: NodeJS.Signals) => { clearInterval(timer); stream.write('\r\x1b[2K'); restore(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('exit', restore);
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const stop = (final?: string) => {
    clearInterval(timer);
    stream.write('\r\x1b[2K');
    restore();
    process.off('exit', restore); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (final) stream.write(final + '\n');
  };
  return {
    update(next) { current = next; },
    stop,
    done: label => stop(result(err.ok(MARK.ok), label)),
    fail: label => stop(result(err.fail(MARK.fail), label)),
  };
}

/** Runs `work` under a spinner that leaves no line behind: for a wait whose result the caller prints. */
export async function spinning<T>(text: string, work: () => Promise<T>): Promise<T> {
  const progress = spinner(text);
  try { return await work(); } finally { progress.stop(); }
}

/** Closest known word to `input` by edit distance, for "Did you mean …?". */
export function suggest(input: string, candidates: string[]): string | undefined {
  // Optimal string alignment: a swapped pair of letters (`stauts`) counts as one edit.
  const distance = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
    return d[a.length]![b.length]!;
  };
  let best: string | undefined, score = Infinity;
  for (const candidate of candidates) {
    const value = candidate.startsWith(input) ? 0.5 : distance(input, candidate);
    if (value < score) { best = candidate; score = value; }
  }
  return score <= Math.max(1, Math.floor(input.length / 3)) + 0.5 ? best : undefined;
}
