import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { TMUX_MIN_VERSION, tmuxTooOld } from '../../../../packages/plugin-api/src/kit/machine.js';

export { TMUX_MIN_VERSION, tmuxTooOld };

/** tmux writes control characters and `\` as `\ooo` (in `%output` and in `capture-pane -C`); bytes >= 0x80 stay raw. */
export function unescapeOctal(input: Buffer): Buffer {
  if (!input.includes(0x5c)) return input;
  const out = Buffer.allocUnsafe(input.length);
  let length = 0;
  for (let at = 0; at < input.length; at++) {
    const byte = input[at]!;
    if (byte === 0x5c) {
      const next = input[at + 1];
      if (next === 0x5c) { out[length++] = 0x5c; at += 1; continue; }
      if (next !== undefined && next >= 0x30 && next <= 0x37) {
        let value = 0, digits = 0;
        while (digits < 3 && at + 1 + digits < input.length) {
          const digit = input[at + 1 + digits]!;
          if (digit < 0x30 || digit > 0x37) break;
          value = value * 8 + digit - 0x30;
          digits += 1;
        }
        out[length++] = value & 0xff;
        at += digits;
        continue;
      }
    }
    out[length++] = byte;
  }
  return out.subarray(0, length);
}

/**
 * `send-keys -H` command lines for raw bytes, at most `chunk` bytes each, in order.
 * Splits never cut across a multi-byte UTF-8 character so TUIs that decode each read
 * chunk independently do not see stray replacement characters.
 */
export function sendKeysLines(pane: string, data: Buffer, chunk = 512): string[] {
  const lines: string[] = [];
  for (let at = 0; at < data.length; ) {
    let end = Math.min(at + chunk, data.length);
    if (end < data.length) {
      let back = 0;
      while (end > at && back < 3 && (data[end]! & 0xc0) === 0x80) {
        end -= 1;
        back += 1;
      }
      if (end === at) end = Math.min(at + chunk, data.length);
    }
    lines.push(`send-keys -H -t ${pane} ${Array.from(data.subarray(at, end), byte => `0x${byte.toString(16).padStart(2, '0')}`).join(' ')}`);
    at = end;
  }
  return lines;
}

interface Pending {
  /** Blocks this command line yields: one per `;`-separated command. */
  count: number;
  blocks: Buffer[][];
  resolve: (blocks: Buffer[][]) => void;
  reject: (error: Error) => void;
  /** Runs synchronously from inside the parser when the last block ends, before any later line is read. */
  sync?: (blocks: Buffer[][]) => void;
}

export interface ControlHandlers {
  /** Decoded output of a pane, in order. A UTF-8 character split between `%output` lines is joined. */
  output: (pane: string, data: string) => void;
  /** tmux stopped sending a pane's output (`pause-after`); its stream has a gap until it is re-seeded. */
  pause: (pane: string) => void;
  /** The control client ended (`%exit`, the process exiting, or a spawn failure). Called once. */
  exit: () => void;
}

/**
 * One tmux control-mode client (`tmux -C`) on a private socket. It reads the raw bytes of every pane
 * of one session and runs commands whose replies are ordered with that output. stdout is drained
 * whatever the consumers do: a control client that stops reading makes tmux stop reading the pane,
 * which blocks the CLI in its own write.
 */
export class ControlClient {
  private readonly child: ChildProcess;
  private readonly queue: Pending[] = [];
  private readonly decoders = new Map<string, TextDecoder>();
  private rest: Buffer = Buffer.alloc(0);
  private block: { number: string; lines: Buffer[]; ours: boolean } | undefined;
  private ended = false;
  private killed = false;
  /** Set once the first command's reply has been seen: from then on blocks match commands one to one. */
  private aligned = false;
  private readonly sentinel = `riffet-sync-${randomBytes(8).toString('hex')}`;

  constructor(socket: string, session: string, private readonly handlers: ControlHandlers, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.child = spawn('tmux', ['-S', socket, '-C', 'attach-session', '-t', session], {
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...(options.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    this.child.stdout!.on('data', (chunk: Buffer) => this.read(chunk));
    this.child.stdin!.on('error', () => undefined);
    this.child.stdout!.on('error', () => undefined);
    this.child.on('error', () => this.finish());
    this.child.on('close', () => this.finish());
    // tmux answers the attach itself (and may answer hooks) with blocks of its own, flagged differently
    // across versions. Nothing is matched to a command until this one's echo has gone by.
    void this.request(`display-message -p ${this.sentinel}`).catch(() => undefined);
    void this.request('refresh-client -f pause-after=10').catch(() => undefined);
  }

  get pid(): number | undefined { return this.child.pid; }

  /** Runs one command line and resolves with the lines of its block. Rejects on `%error`. */
  async command(line: string): Promise<string[]> {
    const [block] = await this.request(line);
    return block!.map(item => item.toString('utf8'));
  }

  /**
   * Runs one command line of `count` `;`-separated commands. `sync` runs inside the parser the
   * moment the last block ends, so a caller can switch a viewer from "gated" to "live" before the
   * next `%output` line is handled.
   */
  request(line: string, count = 1, sync?: (blocks: Buffer[][]) => void): Promise<Buffer[][]> {
    return new Promise((resolve, reject) => {
      if (this.ended) { reject(new Error('control client closed')); return; }
      this.queue.push({ count, blocks: [], resolve, reject, ...(sync ? { sync } : {}) });
      this.child.stdin!.write(`${line}\n`);
    });
  }

  /** Detaches without reporting an exit: the caller already knows. */
  kill(): void {
    this.killed = true;
    this.child.kill();
    this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.queue.splice(0)) pending.reject(new Error('control client closed'));
    if (!this.killed) this.handlers.exit();
  }

  private read(chunk: Buffer): void {
    let data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let start = 0;
    for (let end = data.indexOf(0x0a, start); end >= 0; end = data.indexOf(0x0a, start)) {
      // A consumer's exception must not escape the stream handler: the rest of the chunk still has to be parsed.
      try { this.line(data.subarray(start, end)); } catch { /* handled per callback; this is the last resort */ }
      start = end + 1;
    }
    // Copy the remainder: it must not pin the whole chunk.
    this.rest = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
  }

  private line(line: Buffer): void {
    const block = this.block;
    if (block) {
      if (line[0] === 0x25 && (startsWith(line, '%end ') || startsWith(line, '%error ')) && line.toString('latin1').split(' ')[2] === block.number) {
        this.block = undefined;
        if (block.ours) this.complete(block.lines, startsWith(line, '%error '));
      } else block.lines.push(line);
      return;
    }
    if (line[0] !== 0x25) return;
    if (startsWith(line, '%output ')) {
      const space = line.indexOf(0x20, 8);
      if (space > 0) this.output(line.toString('latin1', 8, space), line.subarray(space + 1));
    } else if (startsWith(line, '%extended-output ')) {
      // %extended-output %<pane> <age> ... : <data> — tmux may add arguments before the colon.
      const paneEnd = line.indexOf(0x20, 17), colon = paneEnd < 0 ? -1 : line.indexOf(' : ', paneEnd);
      if (colon > 0) this.output(line.toString('latin1', 17, paneEnd), line.subarray(colon + 3));
    } else if (startsWith(line, '%begin ')) {
      const [, , number, flags] = line.toString('latin1').split(' ');
      // The attach command's own block (and any hook's) carries flags 0; only this client's commands are ours.
      this.block = { number: number ?? '', lines: [], ours: !this.aligned || (Number(flags) & 1) === 1 };
    } else if (startsWith(line, '%pause ')) this.handlers.pause(line.toString('latin1', 7));
    else if (startsWith(line, '%exit')) this.finish();
    // Everything else (%continue, %config-error, %session-changed, %window-renamed, ...) is not needed.
  }

  private output(pane: string, escaped: Buffer): void {
    let decoder = this.decoders.get(pane);
    if (!decoder) this.decoders.set(pane, decoder = new TextDecoder('utf-8'));
    const text = decoder.decode(unescapeOctal(escaped), { stream: true });
    if (text) this.handlers.output(pane, text);
  }

  private complete(lines: Buffer[], failed: boolean): void {
    if (!this.aligned) {
      if (!failed && lines.length === 1 && lines[0]!.toString('latin1') === this.sentinel) { this.aligned = true; this.queue.shift()?.resolve([lines]); }
      return;
    }
    const pending = this.queue[0];
    if (!pending) return;
    if (failed) {
      // A failing command stops the rest of its list: no further blocks will arrive.
      this.queue.shift();
      pending.reject(new Error(lines.map(item => item.toString('utf8')).join('\n') || 'tmux command failed'));
      return;
    }
    pending.blocks.push(lines);
    if (pending.blocks.length < pending.count) return;
    this.queue.shift();
    try { pending.sync?.(pending.blocks); } catch { /* The caller's callback failed; the reply is still matched. */ }
    pending.resolve(pending.blocks);
  }
}

function startsWith(line: Buffer, prefix: string): boolean {
  return line.length >= prefix.length && line.toString('latin1', 0, prefix.length) === prefix;
}
