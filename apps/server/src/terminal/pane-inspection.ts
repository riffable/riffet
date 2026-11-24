import { readFile, readlink, realpath } from 'node:fs/promises';
import type { Session, TerminalGridDiagnostics } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { exec, ExecError } from '../exec.js';
import type { Store } from '../store.js';
import { stopProcessGroup } from '../backends/shared/codex-app-server.js';
import { parsePsCommandLine } from './ps-argv.js';
import { OuterTerminalState } from './protocol-state.js';
import {
  HISTORY_CAPTURE_BYTES, HISTORY_TAIL_SLACK, isWarmupTerminal, LAUNCH_MARKER, LAUNCH_MARKER_OPTION,
  LAUNCH_PID_OPTION, LAUNCH_RECORDS_FRESH_MS, LOOKUP_STEP_MS, lookupStepTimeout, MAX_PANE_PROCESSES,
  MIB, PANE_HANGUP_GRACE_MS, run, terminalName, tmuxTargetMissing, trimTrailingBlankLines,
  type PaneLaunchRecord, type PaneProcess, type TerminalRuntime,
} from './shared.js';

export interface PaneInspectorDeps {
  store: Store;
  runtime: Map<string, TerminalRuntime>;
  ready: Promise<void>;
  ensureRestored(id: string): Promise<void>;
  paneFeatures(): Promise<boolean>;
  tmux(args: string[]): Promise<string>;
  runTmux(args: string[], timeout?: number, extraEnv?: NodeJS.ProcessEnv, maxBuffer?: number): Promise<string>;
}

export class PaneInspector {
  private launchRecordRead?: { at: number; read: Promise<Map<string, PaneLaunchRecord> | undefined> };

  constructor(private readonly deps: PaneInspectorDeps) {}

  invalidateLaunchRecords(): void {
    this.launchRecordRead = undefined;
  }

  /** Sample geometry and physical screen rows together without attaching a viewer or changing the pane. */
  async gridDiagnostics(id: string): Promise<TerminalGridDiagnostics> {
    const info = this.deps.store.getTerminal(id);
    if (isWarmupTerminal(info)) throw new AppError('TERMINAL_NOT_FOUND', 'Terminal not found', 404);
    if (info.state === 'exited') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
    const name = terminalName(id);
    const output = await this.deps.runTmux([
      'display-message', '-p', '-t', name, '#{pane_width} #{pane_height} #{cursor_y}',
      ';', 'capture-pane', '-p', '-t', name,
    ], 5000, undefined, HISTORY_CAPTURE_BYTES);
    const [geometry = '', ...screenRows] = output.replace(/\n$/, '').split('\n');
    const [cols, rows, cursorY] = geometry.trim().split(' ').map(Number);
    if (cols === undefined || !Number.isInteger(cols) || cols < 1 || !rows || screenRows.length !== rows
      || cursorY === undefined || !Number.isInteger(cursorY) || cursorY < 0 || cursorY >= rows) {
      throw new AppError('TMUX_COMMAND_FAILED', 'tmux could not complete the terminal operation', 503);
    }
    const lastContentRow = screenRows.findLastIndex(line => line.trim()) + 1;
    return { cols, rows, cursorRow: cursorY + 1, lastContentRow: lastContentRow || null };
  }

  /**
   * The physical rows that scrolled off the pane, including their trailing background cells. The browser
   * terminal shows a tmux client, which keeps history to itself, so the browser renders this
   * above the live screen and scrolls it natively instead of driving tmux.
   */
  async history(id: string, known?: string, tail = false): Promise<{ version: string; cols: number; text?: string; append?: boolean }> {
    await this.deps.ensureRestored(id);
    if (this.deps.store.getTerminal(id).state === 'exited') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
    const name = terminalName(id);
    const preservesCells = await this.deps.paneFeatures();
    // Line count alone stops changing once history is at its limit; the byte count still moves.
    const [stamp, limitText] = (await this.deps.tmux(['display-message', '-p', '-t', name, '#{history_size}:#{history_bytes}:#{pane_width} #{history_limit}'])).trim().split(' ');
    const version = `${stamp}:${preservesCells ? 'cells-v1' : 'text-v1'}`;
    const cols = Number(stamp.split(':')[2]);
    if (version === known) return { version, cols };
    // With no history, `-E -1` would still return the first screen line.
    if (version.startsWith('0:')) return { version, cols, text: '' };
    const size = Number(version.split(':')[0]);
    const knownSize = Number(known?.split(':')[0]);
    const sameGrid = known?.split(':').slice(2).join(':') === version.split(':').slice(2).join(':');
    let append = Boolean(tail && sameGrid && Number.isInteger(knownSize) && knownSize > 0 && size > knownSize && size < Number(limitText));
    const marker = '\u0001';
    const metadata = `${marker}#{history_size}:#{history_bytes}:#{pane_width}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const slack = append && preservesCells ? HISTORY_TAIL_SLACK : 0;
      const output = await this.deps.runTmux([
        'display-message', '-p', '-t', name, metadata,
        ';', 'capture-pane', '-p', '-e', preservesCells ? '-N' : '-J', '-S', append ? `-${size - knownSize + slack}` : '-', '-E', '-1', '-t', name,
        ';', 'display-message', '-p', '-t', name, metadata,
      ], 5000, undefined, HISTORY_CAPTURE_BYTES);
      const firstLine = output.indexOf('\n');
      const lastMarker = output.lastIndexOf(marker);
      const before = output.slice(1, firstLine).trim();
      const after = output.slice(lastMarker + 1).trim();
      const consistent = output.startsWith(marker) && lastMarker > firstLine && before === after;
      const text = output.slice(firstLine + 1, lastMarker);
      const result = (body: string, appended: boolean) => ({
        version: `${before}:${preservesCells ? 'cells-v1' : 'text-v1'}`,
        cols: Number(before.split(':')[2]),
        ...(appended ? { append: true } : {}),
        text: before.startsWith('0:') ? '' : body,
      });
      if (consistent && !append) return result(text, false);
      if (consistent && slack) {
        const [moved, , width] = before.split(':');
        const wanted = Number(moved) - knownSize;
        const rows = text.split('\n');
        if (rows.at(-1) === '') rows.pop();
        if (width === stamp.split(':')[2] && wanted > 0 && Number(moved) < Number(limitText) && rows.length >= wanted) {
          // tmux writes a style once and lets it run across rows, so the cut-off rows still decide
          // how the first kept row is drawn.
          const lead = new OuterTerminalState();
          lead.accept(rows.slice(0, rows.length - wanted).join('\n'));
          return result(lead.style() + rows.slice(rows.length - wanted).join('\n') + '\n', true);
        }
      } else if (consistent && before === stamp) return result(text, true);
      append = false;
    }
    throw new AppError('TERMINAL_HISTORY_CHANGED', 'Terminal history changed during capture; retry', 409);
  }

  /** The pane's own process, so callers can look at what the CLI inside it is doing. */
  async panePid(id: string): Promise<number | undefined> {
    await this.deps.ensureRestored(id);
    return await this.livePanePid(id);
  }

  async livePanePid(id: string, timeoutMs = 3000): Promise<number | undefined> {
    try {
      const pid = Number((await this.deps.runTmux(['list-panes', '-t', terminalName(id), '-F', '#{pane_pid}'], timeoutMs)).trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch { return undefined; }
  }

  /**
   * When each terminal last drew anything, from tmux's own record. It is kept whether or not this service
   * is attached, so after a restart it still tells a CLI working on its own (its spinner redraws) from one
   * resting at its prompt (which draws nothing). Read-only; no tmux server reads as no activity.
   */
  async paneActivity(timeoutMs = 2000): Promise<Map<string, number>> {
    const activity = new Map<string, number>();
    let output: string;
    try { output = await this.deps.runTmux(['list-windows', '-a', '-F', '#{session_name} #{window_activity}'], timeoutMs); }
    catch { return activity; }
    const ids = new Map(this.deps.store.listTerminals().map(terminal => [terminalName(terminal.id), terminal.id]));
    for (const line of output.split('\n')) {
      const [name, seconds] = line.trim().split(' ');
      const terminalId = ids.get(name ?? ''), at = Number(seconds) * 1000;
      if (terminalId && Number.isSafeInteger(at) && at > 0) activity.set(terminalId, Math.max(activity.get(terminalId) ?? 0, at));
    }
    return activity;
  }

  /**
   * The pane's last `rows` rows, scrollback included, as plain text, and the width they were drawn at. Read-only, for a
   * reader that follows what a TUI draws (Claude's answer in flight); a pane that is gone reads as undefined.
   */
  async tail(id: string, rows: number): Promise<{ text: string; cols: number } | undefined> {
    const read = async (): Promise<[string, string]> => {
      const runtime = this.deps.runtime.get(id);
      if (runtime) {
        const blocks = await runtime.control.request(`display-message -p -t ${runtime.pane} '#{pane_width}' ; capture-pane -p -S -${rows} -t ${runtime.pane}`, 2);
        const [width = '', screen = ''] = blocks.map(block => block.map(line => line.toString('utf8')).join('\n'));
        return [width, screen];
      }
      const name = terminalName(id);
      const output = await this.deps.runTmux(['display-message', '-p', '-t', name, '#{pane_width}', ';', 'capture-pane', '-p', '-S', `-${rows}`, '-t', name], 5000, undefined, HISTORY_CAPTURE_BYTES);
      const newline = output.indexOf('\n');
      return [output.slice(0, newline), output.slice(newline + 1)];
    };
    try {
      const [width, screen] = await read();
      const cols = Number(width);
      return Number.isInteger(cols) && cols > 0 ? { text: trimTrailingBlankLines(screen), cols } : undefined;
    } catch { return undefined; }
  }

  /** The pane's visible text, read-only: unlike `screen` it never attaches a terminal that is not. */
  async paneText(id: string, timeoutMs = 2000): Promise<string | undefined> {
    try { return trimTrailingBlankLines(await this.deps.runTmux(['capture-pane', '-p', '-t', terminalName(id)], timeoutMs)); }
    catch { return undefined; }
  }

  /**
   * Ends tmux sessions no terminal record can reach: one whose record is gone or says it exited (a
   * stop that failed half way, a create that died before saving it). Younger than [minAgeMs] is left
   * alone, since a session is created before its record is saved. Returns the session names ended.
   */
  async reapStraySessions(minAgeMs: number, now = Date.now(), timeoutMs = 2000): Promise<string[]> {
    let output: string;
    try { output = await this.deps.runTmux(['list-panes', '-a', '-F', '#{session_name} #{session_created} #{pane_pid}'], timeoutMs); }
    catch { return []; }
    const records = new Map(this.deps.store.listTerminals().map(terminal => [terminalName(terminal.id), terminal]));
    const reaped: string[] = [];
    for (const line of output.split('\n')) {
      const [name, created, pane] = line.trim().split(' ');
      if (!name?.startsWith('cw-') || reaped.includes(name)) continue;
      const record = records.get(name), createdAt = Number(created) * 1000;
      if ((record && record.state !== 'exited') || !(createdAt > 0) || now - createdAt < minAgeMs) continue;
      try { await this.deps.runTmux(['kill-session', '-t', name], timeoutMs); }
      catch (error) { if (!tmuxTargetMissing(error)) continue; }
      const pid = Number(pane);
      if (Number.isSafeInteger(pid) && pid > 0) await stopProcessGroup(pid, PANE_HANGUP_GRACE_MS).catch(() => undefined);
      reaped.push(name);
    }
    return reaped;
  }

  /**
   * The private tmux server and each pane's own process, for the service monitor. One read-only
   * round trip that never starts a server; none running reads as no panes.
   */
  async paneProcesses(timeoutMs = 2000): Promise<{ serverPid?: number; panes: Array<{ terminalId: string; pid: number }> }> {
    let output: string;
    try { output = await this.deps.runTmux(['list-panes', '-a', '-F', '#{pid} #{session_name} #{pane_pid}'], timeoutMs); }
    catch { return { panes: [] }; }
    const ids = new Map(this.deps.store.listTerminals().map(terminal => [terminalName(terminal.id), terminal.id]));
    let serverPid: number | undefined;
    const panes: Array<{ terminalId: string; pid: number }> = [];
    for (const line of output.split('\n')) {
      const [server, name, pane] = line.trim().split(' ');
      if (Number(server) > 0) serverPid = Number(server);
      const terminalId = ids.get(name ?? ''), pid = Number(pane);
      if (terminalId && Number.isSafeInteger(pid) && pid > 0) panes.push({ terminalId, pid });
    }
    return { ...(serverPid ? { serverPid } : {}), panes };
  }

  /**
   * The processes running in a live native terminal's pane, for a driver that has to recognise its
   * own CLI there. Only the session's own linked terminal is read, and only processes whose working
   * directory is its project. `select` sees each argv with the launch marker the driver left
   * (`launchMarker`) and picks those worth a directory lookup. Read-only: it never attaches a client,
   * starts or signals anything. Answers undefined when the link does not hold or the complete
   * tree, argv and working directories could not be verified before `deadline`.
   */
  async inspectPane(terminalId: string, sessionId: string, options: { deadline: number; select: (argv: string[], launchMarker: string | undefined) => boolean }): Promise<PaneProcess[] | undefined> {
    const { deadline, select } = options;
    await this.deps.ready;
    if (Date.now() >= deadline) return undefined;
    const linked = () => this.linkedNativeSession(terminalId, sessionId);
    const session = linked();
    if (!session) return undefined;
    const expectedCwd = await realpath(this.deps.store.getProject(session.projectId).cwd);
    if (!linked() || Date.now() >= deadline) return undefined;

    await this.deps.runTmux(['has-session', '-t', terminalName(terminalId)], lookupStepTimeout(deadline));
    if (Date.now() >= deadline) return undefined;
    const panePid = await this.livePanePid(terminalId, lookupStepTimeout(deadline));
    if (!panePid || Date.now() >= deadline) return undefined;
    const pids = await this.paneProcessTree(panePid, deadline);
    if (!pids.length || Date.now() >= deadline) return undefined;

    const marker = await this.readLaunchMarker(terminalId, lookupStepTimeout(deadline));
    const found: PaneProcess[] = [];
    for (const pid of pids) {
      if (Date.now() >= deadline) return undefined;
      const argv = await processArgv(pid, lookupStepTimeout(deadline));
      if (!argv || !select(argv, marker)) continue;
      if (Date.now() >= deadline) return undefined;
      const processCwd = await processWorkingDirectory(pid, lookupStepTimeout(deadline));
      if (!processCwd) continue;
      const canonicalProcessCwd = await realpath(processCwd).catch(() => undefined);
      if (canonicalProcessCwd !== expectedCwd) continue;
      found.push({ pid, argv, ...(pid === panePid ? { root: true } : {}) });
    }
    return Date.now() < deadline && linked() ? found : undefined;
  }

  /**
   * The launch marker of a session's linked native terminal, while the pane still runs the very
   * process the marker was written for.
   */
  async paneLaunchMarker(terminalId: string, sessionId: string): Promise<string | undefined> {
    await this.deps.ready;
    if (!this.linkedNativeSession(terminalId, sessionId)) return undefined;
    const record = (await this.launchRecords())?.get(terminalName(terminalId));
    if (!record || record.dead || !record.marker || record.launchPid !== record.panePid) return undefined;
    return this.linkedNativeSession(terminalId, sessionId) ? record.marker : undefined;
  }

  /**
   * Records [marker] for a pane whose own process [pid] a full `inspectPane` lookup just matched to
   * it, so later checks of a terminal launched without a record can use `paneLaunchMarker`.
   */
  async adoptPaneLaunch(terminalId: string, sessionId: string, marker: string, pid: number): Promise<void> {
    await this.deps.ready;
    if (!LAUNCH_MARKER.test(marker) || !this.linkedNativeSession(terminalId, sessionId)) return;
    if (await this.livePanePid(terminalId, LOOKUP_STEP_MS) !== pid || !this.linkedNativeSession(terminalId, sessionId)) return;
    const name = terminalName(terminalId);
    await this.deps.runTmux(['set-option', '-t', name, LAUNCH_MARKER_OPTION, marker, ';', 'set-option', '-t', name, LAUNCH_PID_OPTION, String(pid)], LOOKUP_STEP_MS)
      .catch(() => undefined);
    this.launchRecordRead = undefined;
  }

  private linkedNativeSession(terminalId: string, sessionId: string): Session | undefined {
    const terminal = this.deps.store.getTerminal(terminalId);
    const session = this.deps.store.getSession(sessionId);
    return terminal.kind === 'native' && terminal.state !== 'exited' && terminal.sessionId === sessionId
      && session.kind === 'native' && session.terminalId === terminalId ? session : undefined;
  }

  /** Every pane's launch record from one tmux read, shared by the callers that ask while it is fresh. */
  private async launchRecords(): Promise<Map<string, PaneLaunchRecord> | undefined> {
    const current = this.launchRecordRead;
    if (current && Date.now() - current.at < LAUNCH_RECORDS_FRESH_MS) return await current.read;
    const read = this.deps.runTmux(['list-panes', '-a', '-F', `#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{${LAUNCH_MARKER_OPTION}}\t#{${LAUNCH_PID_OPTION}}`], 3000)
      .then(output => {
        const records = new Map<string, PaneLaunchRecord>();
        for (const line of output.split('\n')) {
          const [name, pane, dead, marker, launch] = line.trim().split('\t');
          const panePid = Number(pane), launchPid = Number(launch);
          if (!name || !Number.isSafeInteger(panePid) || panePid < 1) continue;
          if (records.has(name)) { records.set(name, { panePid, dead: true }); continue; }
          records.set(name, {
            panePid,
            dead: dead === '1',
            ...(marker && LAUNCH_MARKER.test(marker) ? { marker } : {}),
            ...(Number.isSafeInteger(launchPid) && launchPid > 0 ? { launchPid } : {}),
          });
        }
        return records;
      })
      .catch(() => undefined);
    const entry = { at: Date.now(), read };
    this.launchRecordRead = entry;
    const records = await read;
    if (!records && this.launchRecordRead === entry) this.launchRecordRead = undefined;
    return records;
  }

  private async paneProcessTree(rootPid: number, deadline: number): Promise<number[]> {
    const pending = [rootPid];
    const seen = new Set<number>();
    while (pending.length && seen.size < MAX_PANE_PROCESSES && Date.now() < deadline) {
      const pid = pending.shift()!;
      if (!Number.isSafeInteger(pid) || pid < 1 || seen.has(pid)) continue;
      seen.add(pid);
      let output: string;
      try {
        output = (await exec('pgrep', ['-P', String(pid)], { timeout: lookupStepTimeout(deadline), maxBuffer: MIB })
          .catch(error => { if (error instanceof ExecError && error.code === 1) return { stdout: '' }; throw error; })).stdout;
      } catch { return []; }
      for (const line of output.split(/\r?\n/)) {
        const child = Number(line.trim());
        if (Number.isSafeInteger(child) && child > 0 && !seen.has(child)) pending.push(child);
      }
    }
    return pending.some(pid => !seen.has(pid)) ? [] : [...seen];
  }

  private async readLaunchMarker(id: string, timeoutMs: number): Promise<string | undefined> {
    try {
      const value = (await this.deps.runTmux(['show-option', '-qv', '-t', terminalName(id), LAUNCH_MARKER_OPTION], timeoutMs)).trim();
      return LAUNCH_MARKER.test(value) ? value : undefined;
    } catch { return undefined; }
  }
}

/** argv is read directly on Linux so whitespace and quoting are never ambiguous. */
async function processArgv(pid: number, timeoutMs = 1500): Promise<string[] | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const bytes = await readFile(`/proc/${pid}/cmdline`);
      const argv = bytes.toString('utf8').split('\0').filter(Boolean);
      return argv.length ? argv : undefined;
    } catch { return undefined; }
  }
  try {
    const commandLine = await run('ps', ['-ww', '-p', String(pid), '-o', 'command='], timeoutMs);
    return parsePsCommandLine(commandLine);
  } catch { return undefined; }
}

async function processWorkingDirectory(pid: number, timeoutMs = 1500): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === 'linux') {
    try { return await readlink(`/proc/${pid}/cwd`); }
    catch { return undefined; }
  }
  try {
    const output = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], timeoutMs);
    return output.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1) || undefined;
  } catch { return undefined; }
}
