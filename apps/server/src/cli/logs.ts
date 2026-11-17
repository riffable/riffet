import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { stateDir } from './context.js';
import { MARK, UsageError, note, out, printLines, tilde } from './ui.js';

/*
 * `riffet logs`: the server log, readable. A line is `<ISO time> [scope] message {details}`; in a terminal
 * the time shrinks to the local clock, each scope keeps one color, details are dimmed and problems are
 * colored by what they say. Piped, lines pass through unchanged (minus login tokens) for grep and jq.
 */

interface Entry { at?: Date; scope?: string; message: string; raw: string; /** The rest of a multi-line object or stack the line above began. */ continued?: boolean }

const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s(?:\[([^\]]+)\]:?\s)?(.*)$/;
const redact = (line: string) => line.replace(/([?&]token=)[^&#\s]+/g, '$1[REDACTED]');

export function parseLine(raw: string): Entry {
  const line = redact(raw);
  const match = LINE.exec(line);
  if (!match) return { message: line, raw: line };
  return { at: new Date(match[1]!), ...(match[2] ? { scope: match[2] } : {}), message: match[3]!, raw: line };
}

const FAIL = /\b(?:error|errors|failed|fatal|unhandled|crash(?:ed)?|EADDRINUSE|ENOENT|EACCES)\b/i;
const WARN = /\b(?:warn(?:ing)?|blocked|timed? ?out|retry(?:ing)?|unreachable|stale|late)\b/i;

/** A message that is only a JSON object reads better as `key=value` pairs. */
function flatten(message: string): string | undefined {
  if (!message.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(message) as Record<string, unknown>;
    return Object.entries(value).map(([key, item]) => `${key}=${typeof item === 'string' ? item : JSON.stringify(item)}`).join(' ');
  } catch { return undefined; }
}

const SCOPE_CELLS = 14;
const GUTTER = ' '.repeat(8 + 3 + SCOPE_CELLS + 1);

function pretty(entry: Entry): string {
  if (entry.continued || !entry.at) return out.dim(GUTTER.slice(2) + entry.message);
  const clock = entry.at.toLocaleTimeString('en-GB', { hour12: false });
  const level = FAIL.test(entry.message) ? 'fail' : WARN.test(entry.message) ? 'warn' : undefined;
  const marker = level === 'fail' ? out.fail(MARK.fail) : level === 'warn' ? out.warn(MARK.warn) : ' ';
  const scope = entry.scope ? out.tag(entry.scope.length > SCOPE_CELLS ? entry.scope.slice(0, SCOPE_CELLS - 1) + '…' : entry.scope.padEnd(SCOPE_CELLS)) : ' '.repeat(SCOPE_CELLS);
  const flat = flatten(entry.message);
  if (flat !== undefined) return `${out.dim(clock)} ${marker} ${scope} ${out.dim(flat)}`;
  // Trailing details — `{ … }`, `[ … ]` or JSON — recede behind the message.
  const split = /^(.*?)(\s[{[].*)$/.exec(entry.message);
  const [text, details] = split ? [split[1]!, split[2]!] : [entry.message, ''];
  const tone = level === 'fail' ? out.fail : level === 'warn' ? out.warn : (value: string) => value;
  return `${out.dim(clock)} ${marker} ${scope} ${tone(text)}${out.dim(details)}`;
}

/** `10m`, `2h`, `1d` or an ISO time. */
function since(value: string): number {
  const relative = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
  if (relative) return Date.now() - Number(relative[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[relative[2] as 's' | 'm' | 'h' | 'd'];
  const at = Date.parse(value);
  if (Number.isFinite(at)) return at;
  throw new UsageError(`--since takes 10m, 2h, 1d or a date, not ${value}`);
}

export interface LogsOptions { stateDir: string; follow?: boolean; lines?: string; since?: string; scope?: string; json?: boolean }

export async function logs(options: LogsOptions): Promise<void> {
  const count = options.lines === undefined ? 100 : Number(options.lines);
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new UsageError('--lines takes 1–10000');
  const file = join(stateDir(options.stateDir), 'server.log');
  if (!existsSync(file)) { note(`No server log yet at ${tilde(file)}`); return; }
  const scopes = options.scope?.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const after = options.since ? since(options.since) : undefined;
  const styled = Boolean(process.stdout.isTTY) && !options.json;
  // Continuation lines (a logged object, a stack trace) belong to the entry above them and share its fate in a filter.
  let keep = true, previous: Entry | undefined;
  const accept = (entry: Entry) => {
    entry.continued = !entry.at || (previous?.at?.getTime() === entry.at.getTime() && !entry.scope && /^(?:\s|[}\])]|at )/.test(entry.message));
    previous = entry;
    if (!entry.continued) keep = (!scopes || (entry.scope !== undefined && scopes.includes(entry.scope.toLowerCase()))) && (after === undefined || entry.at!.getTime() >= after);
    return keep;
  };
  const render = (entry: Entry) => options.json
    ? JSON.stringify({ at: entry.at?.toISOString() ?? null, scope: entry.scope ?? null, message: entry.message })
    : styled ? pretty(entry) : entry.raw;

  // The log is bounded (rotated at 10 MB), so the backlog is read whole and filtered here.
  const backlog = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(parseLine).filter(accept).slice(-count);
  // The cut can fall inside a multi-line entry; start at the next whole one.
  while (backlog.length > 1 && backlog[0]!.continued) backlog.shift();
  printLines(backlog.map(render));
  if (!options.follow) return;
  if (styled) note(`Following ${tilde(file)} · Ctrl+C stops reading, not the server`);
  // `tail -F` reopens the file after rotation.
  const child = spawn('tail', ['-F', '-n', '0', file], { stdio: ['ignore', 'pipe', 'ignore'] });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => { const entry = parseLine(line); if (accept(entry)) process.stdout.write(render(entry) + '\n'); });
  const interrupt = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  try {
    await new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', () => done()); });
  } finally { process.off('SIGINT', interrupt); reader.close(); }
}
