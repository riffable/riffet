import { createRequire } from 'node:module';
import type { TerminalAppearance, TerminalServerMessage } from '../../../../packages/contracts/src/index.js';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../store.js';
import { TerminalService, type TerminalBehaviour } from './service.js';

/**
 * tmux must not only exist but be able to start a session: a restricted host can answer `-V` and
 * still fail every `new-session` with "fork failed: Operation not permitted". Probing the real work
 * keeps this suite honest — it skips where terminals cannot run at all, rather than reporting a
 * failure the change under test did not cause. A skip is still not a pass; CI needs a host where
 * this test actually runs.
 */
const tmuxCapability = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    const directory = mkdtempSync(join(tmpdir(), 'riffet-tmux-probe-'));
    const socket = join(directory, 'probe.sock');
    try {
      execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'probe', '/bin/true'], { stdio: 'ignore' });
      return true;
    } finally {
      try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* The probe server may already be gone. */ }
      rmSync(directory, { recursive: true, force: true });
    }
  } catch { return false; }
})();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const API_KEY = 'opaque-private-test-key';
/** What a backend declares for its panes (`AgentBackend.terminal`): a prompt means it started; before that, its own error line is the failure, key removed. */
const agentPanes: TerminalBehaviour = {
  title: 'Cursor Agent',
  ready: text => /→\s+Plan, search, build anything/.test(text),
  startupError: text => {
    const line = text.split('\n').map(item => item.trim()).find(item => /^(?:Cannot\b|Error:)/.test(item));
    return line && `启动失败：${line.split(/\s+Available models:/)[0]!.replaceAll(API_KEY, '[REDACTED]')}`;
  },
};

describe.skipIf(!tmuxCapability)('TerminalService history and CLI lifecycle', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function shell() {
    const directory = mkdtempSync(join(tmpdir(), 'riffet-history-'));
    const store = new Store(join(directory, 'db.sqlite'));
    const service = new TerminalService(store, { stateDir: join(directory, 'state') });
    const project = store.createProject(directory, 'history');
    const previousShell = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
    const terminal = await service.create(project, { kind: 'shell', cols: 80, rows: 10 });
    process.env.SHELL = previousShell;
    cleanups.push(async () => { await service.stop(terminal.id).catch(() => undefined); await service.closeAll(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const print = async (from: number, to: number, prefix = '') => {
      await service.paste(terminal.id, `${prefix}seq ${from} ${to}`, true);
      for (let attempt = 0; attempt < 50; attempt++) {
        // The echoed command already contains `to`; wait for the actual final output line.
        if ((await service.screen(terminal.id))?.split(/\r?\n/).some(line => line.trim() === String(to))) return;
        await sleep(100);
      }
      throw new Error(`seq ${from} ${to} never reached the screen`);
    };
    return { service, store, directory, terminal, print };
  }

  async function cursor(script: string) {
    const directory = mkdtempSync(join(tmpdir(), 'riffet-cursor-exit-'));
    const database = join(directory, 'db.sqlite');
    const executable = join(directory, 'cursor');
    // Wait until create/attach has returned, then exercise real tmux output and process exit.
    writeFileSync(executable, `#!/bin/sh\nwhile [ ! -f start ]; do sleep 0.02; done\n${script}\n`, { mode: 0o700 });
    const store = new Store(database);
    const service = new TerminalService(store, { stateDir: join(directory, 'state'), behaviour: { resolve: () => agentPanes, launchEnv: () => ({ managed: ['CURSOR_API_KEY'], secrets: ['CURSOR_API_KEY'] }) } });
    let terminalId: string | undefined;
    cleanups.push(async () => { if (terminalId) await service.stop(terminalId).catch(() => undefined); await service.closeAll(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const project = store.createProject(directory, 'cursor exit');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor' });
    const terminal = await service.create(project, { kind: 'cursor', sessionId: session.id, reuseLive: true, launchSpec: { command: executable, args: [], cwd: directory, secretEnv: { CURSOR_API_KEY: API_KEY } } });
    terminalId = terminal.id;
    writeFileSync(join(directory, 'start'), '');
    return { service, store, session, terminal, database };
  }

  it('answers startup OSC colors per process without a viewer and preserves them across restore', async () => {
    const { service, store, directory, terminal } = await shell();
    const project = store.getProject(terminal.projectId);
    const light = { foreground: '#283040', background: '#f4f5f6' };
    const dark = { foreground: '#d2d4d7', background: '#141416' };
    const launch = async (appearance: TerminalAppearance, name: string) => {
      const output = join(directory, `${name}.txt`);
      const script = `const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.resume();let data='';process.stdin.on('data',chunk=>{data+=chunk;if(data.includes(']10;rgb:')&&data.includes(']11;rgb:'))fs.writeFileSync(${JSON.stringify(output)},data)});process.stdout.write('\\x1b]10;?\\x07\\x1b]11;?\\x07');setInterval(()=>{},1000);`;
      const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', terminalAppearance: appearance });
      const created = await service.create(project, { kind: 'native', sessionId: session.id, launchSpec: { command: process.execPath, args: ['-e', script], cwd: directory } });
      cleanups.push(async () => { await service.stop(created.id).catch(() => undefined); });
      await vi.waitFor(() => expect(existsSync(output)).toBe(true), { timeout: 5000 });
      const replies = readFileSync(output, 'utf8');
      const rgb = (color: string) => color.slice(1).match(/../g)!.map(value => value + value).join('/');
      expect(replies).toContain(`]10;rgb:${rgb(appearance.foreground)}`);
      expect(replies).toContain(`]11;rgb:${rgb(appearance.background)}`);
      expect(created.appearance).toEqual(appearance);
      return { session, created };
    };
    const [first, second] = await Promise.all([launch(light, 'light'), launch(dark, 'dark')]);
    store.updateSession(first.session.id, { terminalAppearance: dark });
    store.updateSession(second.session.id, { terminalAppearance: light });
    expect((await service.get(first.created.id)).appearance).toEqual(light);
    // Records from older versions did not store a process appearance; never infer it from today's UI.
    const { appearance: _appearance, ...legacy } = store.getTerminal(second.created.id);
    store.saveTerminal(legacy);
    await service.closeAll();
    const restored = new TerminalService(store, { stateDir: join(directory, 'state') });
    cleanups.push(async () => { await restored.stop(first.created.id); await restored.stop(second.created.id); await restored.closeAll(); });
    expect((await restored.get(first.created.id)).appearance).toEqual(light);
    expect((await restored.get(second.created.id)).appearance).toBeUndefined();
  });

  it('refuses a warm process with another appearance and permits an exact match', async () => {
    const { service, store, terminal } = await shell();
    // Written as an earlier version did: the chat id under its old name.
    const warmup = { ownerToken: 'appearance-owner', resourceKey: 'appearance-resource', cursorSessionId: 'appearance-chat', expiresAt: Date.now() + 60_000 };
    store.saveTerminal({ ...terminal, kind: 'cursor', warmup } as typeof terminal);
    const different = store.createSession({ projectId: terminal.projectId, kind: 'native', terminalAppearance: { foreground: '#222222', background: '#ffffff' } });
    await expect(service.claimWarmup(terminal.id, { ...warmup, sessionId: different.id })).rejects.toMatchObject({ code: 'WARMUP_APPEARANCE_MISMATCH' });
    expect(store.getTerminal(terminal.id).sessionId).toBeUndefined();
    const matching = store.createSession({ projectId: terminal.projectId, kind: 'native' });
    expect((await service.claimWarmup(terminal.id, { ...warmup, sessionId: matching.id })).sessionId).toBe(matching.id);
  });

  it('keeps a CLI model rejection after the terminal exits and the database reopens', async () => {
    const { store, session, terminal, database } = await cursor([
      "printf '\u001b[31mCannot use this '",
      'sleep 0.1',
      "printf 'model: retired-model. Available models: auto, other-models\u001b[0m\\n'",
      'sleep 0.2',
      'exit 1',
    ].join('\n'));
    await vi.waitFor(() => expect(store.getSession(session.id).state).toBe('failed'), { timeout: 5_000 });
    expect(store.getTerminal(terminal.id).state).toBe('exited');
    const saved = store.getSession(session.id);
    expect(saved.error).toContain('Cannot use this model: retired-model.');
    expect(saved.error).not.toContain('Available models');
    expect(saved.error).not.toContain('\u001b');
    const reopened = new Store(database);
    try { expect(reopened.getSession(session.id).error).toBe(saved.error); }
    finally { reopened.close(); }
  });

  it('redacts the private launch credential before persisting a CLI startup failure', async () => {
    const { store, session } = await cursor("printf 'Error: gateway rejected opaque-private-test-key\\n'\nsleep 0.2\nexit 1");
    await vi.waitFor(() => expect(store.getSession(session.id).state).toBe('failed'), { timeout: 5_000 });
    expect(store.getSession(session.id).error).toContain('gateway rejected [REDACTED]');
    expect(store.getSession(session.id).error).not.toContain('opaque-private-test-key');
  });

  it('reads the startup error from the dead pane when the CLI failed while no stream was attached', async () => {
    const { service, store, session, terminal, database } = await cursor("while [ ! -f go ]; do sleep 0.02; done\nprintf 'Error: gateway rejected opaque-private-test-key\\n'\nexit 1");
    await service.closeAll();
    const directory = dirname(database);
    writeFileSync(join(directory, 'go'), '');
    // The pane is dead before anything attaches: the error is only on the retained screen.
    const pane = `cw-${terminal.id.replaceAll('-', '').slice(0, 20)}`;
    await vi.waitFor(() => expect(execFileSync('tmux', ['-S', service.socket, 'display-message', '-p', '-t', pane, '#{pane_dead}'], { encoding: 'utf8' }).trim()).toBe('1'), { timeout: 5_000 });
    const restored = new TerminalService(store, { stateDir: join(directory, 'state'), behaviour: { resolve: () => agentPanes, launchEnv: () => ({ managed: ['CURSOR_API_KEY'], secrets: ['CURSOR_API_KEY'] }) } });
    cleanups.push(async () => { await restored.closeAll(); });
    await vi.waitFor(async () => {
      await restored.get(terminal.id);
      expect(store.getSession(session.id).state).toBe('failed');
    }, { timeout: 5_000 });
    expect(store.getSession(session.id).error).toContain('gateway rejected [REDACTED]');
  });

  it('does not reinterpret output from an already ready CLI as a startup failure', async () => {
    const { store, session, terminal } = await cursor([
      "printf '  → Plan, search, build anything\\n'",
      'sleep 0.1',
      "printf 'Error: an example quoted in the conversation\\n'",
      'sleep 0.2',
      'exit 0',
    ].join('\n'));
    await vi.waitFor(() => expect(store.getTerminal(terminal.id).state).toBe('exited'), { timeout: 5_000 });
    expect(store.getSession(session.id).state).toBe('idle');
    expect(store.getSession(session.id).error).toBeUndefined();
  });

  it('seeds a fresh grid and the pane\'s own paste mode before deltas without losing background cells or continued SGR', async () => {
    const { service, terminal } = await shell();
    const red = 'A'.repeat(160);
    await service.paste(terminal.id, `printf '\\033[?2004h\\033[2J\\033[H\\033[48;2;60;60;60m\\033[2KINPUT\\033[0m\\033[3;1H\\033[31m${red}\\033[0m'`, true);
    await vi.waitFor(async () => expect(await service.screen(terminal.id)).toContain('INPUT'));
    await sleep(200);
    const messages: TerminalServerMessage[] = [];
    const unsubscribe = service.subscribe(terminal.id, message => messages.push(message));
    cleanups.push(unsubscribe);
    await vi.waitFor(() => expect(messages.some(message => message.type === 'snapshot')).toBe(true));
    const snapshot = messages.find(message => message.type === 'snapshot')!;
    if (snapshot.type !== 'snapshot') throw new Error('snapshot missing');
    expect(messages.filter(message => message.type === 'output')).toHaveLength(0);
    expect(snapshot).toMatchObject({ cols: 80, rows: 10 });
    expect(snapshot.streamId).toBeTruthy();
    const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm');
    const emulator = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true });
    try {
      await new Promise<void>(done => emulator.write(snapshot.data, done));
      expect(emulator.buffer.active.getLine(0)!.getCell(29)!.getBgColor()).toBe(0x3c3c3c);
      expect(emulator.buffer.active.getLine(2)!.getCell(79)!.getFgColor()).toBe(1);
      expect(emulator.buffer.active.getLine(3)!.getCell(0)!.getFgColor()).toBe(1);
      expect(emulator.modes.bracketedPasteMode).toBe(true);
      await service.paste(terminal.id, 'echo NEXT_OUTPUT', true);
      await vi.waitFor(() => expect(messages.some(message => message.type === 'output')).toBe(true));
      for (const message of messages) if (message.type === 'output') {
        expect(message.streamId).toBe(snapshot.streamId);
        expect(message.sequence).toBeGreaterThan(snapshot.sequence);
      }
    } finally { emulator.dispose(); }
  });

  it('reestablishes a new stream after daemon restart and admits viewers while a pane keeps printing', async () => {
    const { service, store, directory, terminal } = await shell();
    const messages: TerminalServerMessage[] = [];
    const unsubscribe = service.subscribe(terminal.id, message => messages.push(message));
    cleanups.push(unsubscribe);
    await vi.waitFor(() => expect(messages.some(message => message.type === 'snapshot')).toBe(true));
    const oldStream = messages.find(message => message.type === 'snapshot');
    await service.closeAll();
    const restored = new TerminalService(store, { stateDir: join(directory, 'state') });
    cleanups.push(async () => { await restored.stop(terminal.id).catch(() => undefined); await restored.closeAll(); });
    const restoredMessages: TerminalServerMessage[] = [];
    await restored.get(terminal.id);
    // A viewer is admitted while the pane keeps printing.
    await restored.paste(terminal.id, "while :; do printf 'CONTINUOUS_OUTPUT\\n'; sleep 0.005; done", true);
    const stopWatching = restored.subscribe(terminal.id, message => restoredMessages.push(message));
    cleanups.push(stopWatching);
    await vi.waitFor(() => expect(restoredMessages.some(message => message.type === 'snapshot')).toBe(true), { timeout: 3000 });
    await vi.waitFor(() => expect(restoredMessages.some(message => message.type === 'output')).toBe(true), { timeout: 3000 });
    const snapshot = restoredMessages.find(message => message.type === 'snapshot');
    expect(snapshot?.type === 'snapshot' && snapshot.streamId).not.toBe(oldStream?.type === 'snapshot' && oldStream.streamId);
    expect((await restored.get(terminal.id)).state).toBe('running');
  });

  it('delivers final error output before exit to a viewer that has not been seeded yet', async () => {
    const { service, terminal } = await shell();
    const messages: TerminalServerMessage[] = [];
    const unsubscribe = service.subscribe(terminal.id, message => messages.push(message), { protocol: 3 });
    cleanups.push(unsubscribe);
    await service.paste(terminal.id, "printf 'FATAL_ERROR_DETAILS\\n'; exit 7", true);
    await vi.waitFor(() => expect(messages.some(message => message.type === 'exit')).toBe(true), { timeout: 5000 });
    const exitIndex = messages.findIndex(message => message.type === 'exit');
    const finalIndex = messages.findLastIndex(message => message.type === 'snapshot' && message.data.includes('FATAL_ERROR_DETAILS'));
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex).toBeLessThan(exitIndex);
    expect(messages[exitIndex]).toMatchObject({ exitCode: 7 });
    expect((await service.get(terminal.id)).exitCode).toBe(7);
  });

  it('persists the pane exit status and rejects an attachment paste after its input lease changes', async () => {
    const { service, terminal } = await shell();
    const first = await service.claim(terminal.id, 'first', true);
    await service.claim(terminal.id, 'second', true);
    await expect(service.pasteAttachmentsWithLease(terminal.id, 'first', first.epoch, '/tmp/image.png')).rejects.toMatchObject({ code: 'TERMINAL_CONTROL_STALE' });
    const owner = await service.claim(terminal.id, 'second', true);
    let revoked = false;
    let scheduled = false;
    const beforeWrite = vi.fn();
    const authorize = () => {
      if (revoked) throw new Error('AUTH_REVOKED');
      if (!scheduled) { scheduled = true; setTimeout(() => { revoked = true; }, 0); }
    };
    await expect(service.pasteAttachmentsWithLease(terminal.id, 'second', owner.epoch, '/tmp/revoked-image.png', authorize, beforeWrite)).rejects.toThrow('AUTH_REVOKED');
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(await service.screen(terminal.id)).not.toContain('/tmp/revoked-image.png');
    const messages: TerminalServerMessage[] = [];
    const unsubscribe = service.subscribe(terminal.id, message => messages.push(message));
    cleanups.push(unsubscribe);
    await service.paste(terminal.id, 'exit 7', true);
    await vi.waitFor(async () => expect((await service.get(terminal.id)).exitCode).toBe(7));
    expect(messages.find(message => message.type === 'exit')).toMatchObject({ exitCode: 7 });
    const signaled = await shell();
    await signaled.service.paste(signaled.terminal.id, 'kill -KILL $$', true);
    await vi.waitFor(async () => expect((await signaled.service.get(signaled.terminal.id)).exitCode).toBe(137));
  });

  it('sends only the lines added since the known version, and the whole history otherwise', async () => {
    const { service, terminal, print } = await shell();
    await print(1, 300);
    const full = await service.history(terminal.id);
    expect(full.append).toBeUndefined();
    expect(full.text!.split('\n').map(line => line.trimEnd())).toContain('150');

    await print(301, 350);
    const tail = await service.history(terminal.id, full.version, true);
    expect(tail.append).toBe(true);
    const added = tail.text!.trimEnd().split('\n').map(line => line.trimEnd());
    expect(added).toContain('320');
    expect(added).not.toContain('150');
    // The tail continues the history exactly where the known version ended.
    const plain = (text: string) => text.trimEnd().split('\n').map(line => line.replace(/\x1b\[[\d;:]*m/g, '').trimEnd());
    const joined = plain(full.text! + tail.text!);
    const again = plain((await service.history(terminal.id)).text!);
    expect(joined).toEqual(again);

    // Unchanged: nothing is sent. Without `tail`, or with a version from elsewhere: the whole history.
    expect(await service.history(terminal.id, tail.version, true)).toEqual({ version: tail.version, cols: 80 });
    expect((await service.history(terminal.id, full.version)).append).toBeUndefined();
    expect((await service.history(terminal.id, '999999:1', true)).append).toBeUndefined();
    // Old joined-text caches and rows from a different width must be replaced, not appended.
    expect((await service.history(terminal.id, full.version.split(':').slice(0, 2).join(':'), true)).append).toBeUndefined();
    expect((await service.history(terminal.id, full.version.replace(':80:cells-v1', ':40:cells-v1'), true)).append).toBeUndefined();
    // Output arriving between the version query and the capture moves the tail's origin. A busy
    // pane must still get a tail, cut at the size the capture itself reports, with nothing skipped
    // or repeated.
    await print(351, 355);
    const runner = service as unknown as { runTmux: (...args: [string[], ...unknown[]]) => Promise<string> };
    const runTmux = runner.runTmux.bind(runner);
    let advanced = false;
    const capture = vi.spyOn(runner, 'runTmux').mockImplementation(async (...args) => {
      if (!advanced && args[0].includes('capture-pane')) { advanced = true; await print(356, 380); }
      return runTmux(...args);
    });
    try {
      const moved = await service.history(terminal.id, tail.version, true);
      expect(advanced).toBe(true);
      expect(moved.append).toBe(true);
      const rows = plain(full.text! + tail.text! + moved.text!);
      const whole = plain((await service.history(terminal.id)).text!);
      expect(rows).toEqual(whole.slice(0, rows.length));
      expect(rows).toContain('365');
    } finally { capture.mockRestore(); }

    // tmux states a full-row background once and carries it across rows (a diff block); a tail cut
    // inside that run must restate it.
    await service.paste(terminal.id, "printf '\\033[41m'; for i in $(seq 361 400); do printf '%s\\033[K\\n' $i; done; printf '\\033[0m'", true);
    await vi.waitFor(async () => expect((await service.screen(terminal.id))?.split(/\r?\n/).some(line => line.trim() === '400')).toBe(true));
    const block = await service.history(terminal.id);
    await print(401, 440);
    const carried = await service.history(terminal.id, block.version, true);
    expect(carried.append).toBe(true);
    const lead = /^(?:\x1b\[[\d;:]*m)*/.exec(carried.text!)![0];
    expect(lead.match(/\x1b\[([\d;:]*)m/g)!.some(code => code.slice(2, -1).split(';').includes('41'))).toBe(true);
  }, 30_000);

  it('preserves erased background cells and physical wrap boundaries in history without extending inline highlights', async () => {
    const { service, terminal, directory } = await shell();
    const script = join(directory, 'history-background.sh');
    writeFileSync(script, [
      "printf '\\033[2J\\033[H'",
      "printf '\\033[48;2;33;58;43m\\033[2K+ short\\033[0m\\r\\n'",
      "printf '\\033[48;2;33;58;43m\\033[2K+ a longer added line\\033[0m\\r\\n'",
      "printf '\\033[48;2;74;33;26m\\033[2K- removed\\033[0m\\r\\n'",
      "printf 'inline \\033[48;2;33;58;43mTAG\\033[0m tail\\r\\n'",
      `printf '\\033[31m${'A'.repeat(160)}\\033[0m\\r\\n'`,
      'seq 1 20',
      "printf 'HISTORY_RECT_READY\\n'",
    ].join('\n'));
    await service.paste(terminal.id, `sh '${script}'`, true);
    await vi.waitFor(async () => expect(await service.screen(terminal.id)).toContain('HISTORY_RECT_READY'));
    const captured = await service.history(terminal.id);
    const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm');
    const emulator = new Terminal({ cols: 80, rows: 1, scrollback: 100, convertEol: true, allowProposedApi: true });
    try {
      await new Promise<void>(done => emulator.write(captured.text!, done));
      const lines = Array.from({ length: emulator.buffer.active.length }, (_, index) => emulator.buffer.active.getLine(index)!);
      for (const [prefix, background] of [['+ short', 0x213a2b], ['+ a longer', 0x213a2b], ['- removed', 0x4a211a]] as const) {
        const row = lines.find(line => line.translateToString(true).startsWith(prefix))!;
        expect(row).toBeDefined();
        expect(row.getCell(79)!.getBgColor()).toBe(background);
        expect(row.getCell(79)!.getChars()).toBe(' ');
      }
      const inline = lines.find(line => line.translateToString(true).startsWith('inline '))!;
      expect(inline.getCell(7)!.getBgColor()).toBe(0x213a2b);
      expect(inline.getCell(11)!.isBgDefault()).toBe(true);
      // Unwritten padding belongs to the parser, not the capture. Web ignores null cells;
      // actual spaces with backgrounds must survive so they can paint the full diff row.
      expect(inline.getCell(79)!.getChars() === '' || inline.getCell(79)!.isBgDefault()).toBe(true);
      const wrapped = lines.filter(line => line.translateToString(true) === 'A'.repeat(80));
      expect(wrapped).toHaveLength(2);
      expect(wrapped.every(line => line.getCell(0)!.getFgColor() === 1 && line.getCell(79)!.getFgColor() === 1)).toBe(true);
    } finally { emulator.dispose(); }
  });

  it('captures a full scrollback larger than one MiB', async () => {
    const { service, terminal } = await shell();
    // Sixteen truecolor words per row: each row costs several hundred bytes with its SGR.
    await service.paste(terminal.id, "awk 'BEGIN { for (i=0; i<12000; i++) { line=\"\"; for (k=0; k<16; k++) line = line sprintf(\"\\033[38;2;%d;%d;%dm%04d\", k*16, k*7, 255-k, i % 10000); printf \"%s\\033[0m\\n\", line }; print \"HISTORY_READY\" }'", true);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await service.screen(terminal.id))?.split(/\r?\n/).some(line => line.trim() === 'HISTORY_READY')) { ready = true; break; }
      await sleep(100);
    }
    expect(ready).toBe(true);
    const captured = await service.history(terminal.id);
    expect(Buffer.byteLength(captured.text!)).toBeGreaterThan(1024 * 1024);
    expect(captured.text).toContain('1999');
    expect(await service.history(terminal.id, captured.version, true)).toEqual({ version: captured.version, cols: 80 });
    // A seed over the 2M-char limit is not itself a reason to reseed: the output after it flows on.
    const seen: TerminalServerMessage[] = [];
    const subscription = service.subscribe(terminal.id, message => { seen.push(message); if (message.type === 'snapshot' || message.type === 'output') subscription.ack(message.data.length); }, { protocol: 3 });
    cleanups.push(subscription);
    await vi.waitFor(() => expect(seen.some(message => message.type === 'snapshot')).toBe(true), { timeout: 10_000 });
    expect(seen.find(message => message.type === 'snapshot')).toMatchObject({ data: expect.stringMatching(/^[^]{2000001,}$/) });
    await service.paste(terminal.id, 'echo AFTER_SEED', true);
    await vi.waitFor(() => expect(seen.some(message => message.type === 'output' && message.data.includes('AFTER_SEED'))).toBe(true));
    expect(seen.filter(message => message.type === 'snapshot')).toHaveLength(1);
  }, 30_000);

  /** A client emulator fed the way a protocol 3 client feeds its own: every snapshot replaces it, every output continues it. */
  function viewer(service: TerminalService, terminalId: string) {
    const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');
    const emulator = new Terminal({ cols: 80, rows: 10, scrollback: 10_000, allowProposedApi: true });
    const messages: TerminalServerMessage[] = [];
    let chain = Promise.resolve();
    const write = (data: string) => new Promise<void>(done => emulator.write(data, done));
    const subscription = service.subscribe(terminalId, message => {
      messages.push(message);
      if (message.type === 'snapshot') chain = chain.then(async () => { emulator.reset(); emulator.resize(message.cols, message.rows); await write(message.data); subscription.ack(message.data.length); });
      else if (message.type === 'output') chain = chain.then(async () => { await write(message.data); subscription.ack(message.data.length); });
    }, { protocol: 3 });
    cleanups.push(subscription);
    return { emulator, messages, settled: async () => { await chain; await write(''); } };
  }

  it('keeps a mid-stream viewer identical to tmux across alternate screens, scroll regions and wide text', async () => {
    const { service, terminal, directory } = await shell();
    const socket = (service as unknown as { socketPath: string }).socketPath;
    const target = `cw-${terminal.id.replaceAll('-', '').slice(0, 20)}`;
    const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const script = join(directory, 'parity.sh');
    writeFileSync(script, [
      'for i in $(seq 1 450); do printf "\\033[3%dm\u884c%d \u4e2d\u6587 line %d\\033[0m\\n" $((i % 7 + 1)) $i $i; if [ $((i % 25)) = 0 ]; then sleep 0.05; fi; done',
      'printf "%s\\n" "$(seq -s "" 1 70 | cut -c1-170)"',
      // A full-width coloured row, then a shorter one that switches the colour off: the carried style must not leak into it.
      'printf "\\033[42m%80s\\n\\033[49mshort\\n\\033[41;1mpartial\\033[K\\n\\033[0mnext\\n\\033[48;2;10;20;30m%80s\\n\\033[0mend\\n" "" ""',
      'printf "\\033[?1049h\\033[2J\\033[H\\033[3;8r\\033[3;1H"',
      'for i in $(seq 1 30); do printf "region %d \u65e5\u672c\u8a9e\\r\\n" $i; done',
      'printf "\\033[1;1HALT_TOP\\033[10;1HALT_BOTTOM\\033[5;10HALT_READY"',
      'sleep 2',
      'for i in 31 32 33; do printf "\\033[8;1H\\nregion %d" $i; done',
      'sleep 1',
      'printf "\\033[r\\033[?1049l"',
      'for i in $(seq 1 50); do printf "\\033[1;3%dmpost %d \u4e2d\\033[0m\\n" $((i % 7 + 1)) $i; done',
      'printf "DONE\\n"',
    ].join('\n'));
    // The same program on a plain stream is the reference for every cell the viewers hold.
    const reference = promisify(execFile)('sh', [script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const rowsOf = (buffer: { length: number; getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined }) =>
      Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)!.translateToString(true).trimEnd());
    const trimBlank = (rows: string[]) => { while (rows.length && rows.at(-1) === '') rows.pop(); return rows; };
    const screenHas = async (text: string) => (await service.screen(terminal.id))?.includes(text) ?? false;

    await service.paste(terminal.id, `sh '${script}'; sleep 30`, true);
    await vi.waitFor(async () => expect(await screenHas('line 200')).toBe(true), { timeout: 10_000, interval: 20 });
    const early = viewer(service, terminal.id);
    await vi.waitFor(async () => expect(await screenHas('ALT_READY')).toBe(true), { timeout: 10_000, interval: 20 });
    const inAlternate = viewer(service, terminal.id);
    await vi.waitFor(() => expect(inAlternate.messages.some(message => message.type === 'snapshot')).toBe(true));
    await inAlternate.settled();
    // The alternate screen, its saved cursor and the scroll region, seen mid-way.
    expect(inAlternate.emulator.buffer.active.type).toBe('alternate');
    expect(tmux('display-message', '-p', '-t', target, '#{alternate_on}').trim()).toBe('1');
    expect(trimBlank(rowsOf(inAlternate.emulator.buffer.active))).toEqual(trimBlank(tmux('capture-pane', '-p', '-N', '-t', target).split('\n').slice(0, -1).map(row => row.trimEnd())));

    await vi.waitFor(async () => expect(await screenHas('DONE')).toBe(true), { timeout: 15_000, interval: 50 });
    await sleep(400);
    const expected = tmux('capture-pane', '-p', '-N', '-S', '-', '-E', '-', '-t', target).split('\n').slice(0, -1).map(row => row.trimEnd());
    const [cursorX, cursorY, alternate] = tmux('display-message', '-p', '-t', target, '#{cursor_x} #{cursor_y} #{alternate_on}').trim().split(' ');
    for (const client of [early, inAlternate]) {
      await client.settled();
      expect(client.emulator.buffer.active.type).toBe('normal');
      expect(alternate).toBe('0');
      expect(rowsOf(client.emulator.buffer.normal)).toEqual(expected);
      expect([client.emulator.buffer.active.cursorX, client.emulator.buffer.active.cursorY]).toEqual([Number(cursorX), Number(cursorY)]);
    }
    expect(expected.length).toBeGreaterThan(450);
    // Colour modes and values of every cell, not only the text: a row's style must not spill into the next.
    const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');
    const { stdout } = await reference;
    const plain = new Terminal({ cols: 80, rows: 10, scrollback: 10_000, convertEol: true, allowProposedApi: true });
    await new Promise<void>(done => plain.write(stdout, done));
    const cellsOf = (buffer: typeof plain.buffer.normal, from: number) => Array.from({ length: buffer.length - from }, (_, row) => {
      const line = buffer.getLine(from + row)!;
      return Array.from({ length: 80 }, (_, x) => {
        const cell = line.getCell(x)!, ch = cell.getChars() || ' ', bg = `${cell.getBgColorMode()}:${cell.getBgColor()}`;
        // A space's foreground is invisible, and tmux and a raw stream differ on it.
        return ch === ' ' ? ` ${bg}` : `${ch}|${cell.getFgColorMode()}:${cell.getFgColor()}|${bg}|${cell.isBold()}${cell.isInverse()}${cell.isUnderline()}`;
      });
    });
    const wanted = cellsOf(plain.buffer.normal, 0);
    for (const client of [early, inAlternate]) {
      const held = client.emulator.buffer.normal;
      const got = cellsOf(held, held.length - wanted.length);
      const wrong = got.findIndex((row, index) => row.join(',') !== wanted[index]!.join(','));
      expect(wrong, `row ${wrong}: ${wrong < 0 ? '' : got[wrong]!.join(',')}\nwanted ${wrong < 0 ? '' : wanted[wrong]!.join(',')}`).toBe(-1);
      client.emulator.dispose();
    }
    plain.dispose();
  }, 40_000);

  it('hands a launch argument with line breaks or a trailing semicolon to the CLI unchanged', async () => {
    const { service, store, directory, terminal } = await shell();
    const output = join(directory, 'argv.json');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(1)))`;
    const args = ['first line\nsecond line', 'ends with;', 'ends with\\;'];
    const session = store.createSession({ projectId: terminal.projectId, kind: 'native', backendId: 'codex' });
    const raw = await service.create(store.getProject(terminal.projectId), { kind: 'native', sessionId: session.id, launchSpec: { command: process.execPath, args: ['-e', script, ...args], cwd: directory } });
    cleanups.push(async () => { await service.stop(raw.id).catch(() => undefined); });
    await vi.waitFor(() => expect(existsSync(output)).toBe(true), { timeout: 5000 });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(args);
  });

  it('delivers input bytes to the CLI exactly, in order and across the 512-byte command chunks', async () => {
    const { service, store, directory, terminal } = await shell();
    const output = join(directory, 'input-bytes.txt');
    const script = `const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',chunk=>fs.appendFileSync(${JSON.stringify(output)},chunk.toString('hex')));fs.writeFileSync(${JSON.stringify(join(directory, 'input-ready'))},'');setInterval(()=>{},1000);`;
    const session = store.createSession({ projectId: terminal.projectId, kind: 'native', backendId: 'codex' });
    const raw = await service.create(store.getProject(terminal.projectId), { kind: 'native', sessionId: session.id, launchSpec: { command: process.execPath, args: ['-e', script], cwd: directory } });
    cleanups.push(async () => { await service.stop(raw.id).catch(() => undefined); });
    await vi.waitFor(() => expect(existsSync(join(directory, 'input-ready'))).toBe(true), { timeout: 5000 });
    const owner = await service.claim(raw.id, 'typist', true);
    const data = 'a\u4e2d\u001b[A\u001b[200~p\u001b[201~\u001b[<0;10;5M\r' + '\u65e5\u672c\u8a9e'.repeat(400) + '\u0003';
    await service.input(raw.id, 'typist', owner.epoch, data);
    await vi.waitFor(() => expect(readFileSync(output, 'utf8')).toBe(Buffer.from(data).toString('hex')), { timeout: 5000 });
  });

  it('starts a viewer that stops acking over from a fresh snapshot while the CLI and other viewers keep going', async () => {
    const { service, terminal } = await shell();
    const stalled: TerminalServerMessage[] = [];
    const stalledSubscription = service.subscribe(terminal.id, message => stalled.push(message), { protocol: 3 });
    cleanups.push(stalledSubscription);
    const kept: TerminalServerMessage[] = [];
    const keptSubscription = service.subscribe(terminal.id, message => { kept.push(message); if (message.type !== 'state' && message.type !== 'error' && message.type !== 'exit') keptSubscription.ack(message.data.length); }, { protocol: 3 });
    cleanups.push(keptSubscription);
    await vi.waitFor(() => expect(stalled.some(message => message.type === 'snapshot')).toBe(true));
    await service.paste(terminal.id, "awk 'BEGIN { for (i=0; i<60000; i++) printf \"line %d %070d\\n\", i, i; print \"FLOW_DONE\" }'", true);
    // The CLI is never blocked by a viewer that does not read.
    await vi.waitFor(async () => expect(await service.screen(terminal.id)).toContain('FLOW_DONE'), { timeout: 20_000, interval: 50 });
    await vi.waitFor(() => {
      const last = stalled.findLastIndex(message => message.type === 'snapshot');
      expect(stalled.filter(message => message.type === 'snapshot').length).toBeGreaterThanOrEqual(2);
      expect(stalled.slice(last).map(message => 'data' in message ? message.data : '').join('')).toContain('FLOW_DONE');
    }, { timeout: 10_000 });
    expect(stalled.some(message => message.type === 'error' || message.type === 'exit')).toBe(false);
    await vi.waitFor(() => expect(kept.map(message => 'data' in message ? message.data : '').join('')).toContain('FLOW_DONE'));
    expect(kept.filter(message => message.type === 'snapshot')).toHaveLength(1);
  }, 40_000);
});
