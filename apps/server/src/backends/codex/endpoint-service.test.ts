import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecFileException } from 'node:child_process';
import { Store } from '../../store.js';
import { TerminalService } from '../../terminal/service.js';
import { codexTerminalEndpoint } from './endpoint.js';

const state = vi.hoisted(() => ({
  execFile: vi.fn(),
  processChildren: {} as Record<string, number[]>,
  processErrors: {} as Record<string, string | number>,
  processArgv: {} as Record<string, string[]>,
  processCwd: {} as Record<string, string>,
  marker: undefined as string | undefined,
  panePid: 101,
  calls: [] as Array<{ command: string; args: string[] }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: state.execFile as unknown as typeof actual.execFile };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (path: string | Buffer | URL, ...args: unknown[]) => {
      const match = /\/proc\/(\d+)\/cmdline$/.exec(String(path));
      if (match) {
        const argv = state.processArgv[match[1]!];
        if (!argv) throw Object.assign(new Error('No such process'), { code: 'ENOENT' });
        return Buffer.from(`${argv.join('\0')}\0`);
      }
      return await actual.readFile(path as never, ...(args as [never]));
    },
    readlink: async (path: string | Buffer | URL, ...args: unknown[]) => {
      const match = /\/proc\/(\d+)\/cwd$/.exec(String(path));
      if (match) {
        const cwd = state.processCwd[match[1]!];
        if (!cwd) throw Object.assign(new Error('No such process'), { code: 'ENOENT' });
        return cwd;
      }
      return await actual.readlink(path as never, ...(args as [never]));
    },
  };
});

const threadId = 'a9d865e1-b3a4-4910-8487-222c985f0040';
const terminalId = 'terminal-codex-endpoint';
const panePid = 101;
const candidatePid = 102;
const secondCandidatePid = 103;

function failure(): NodeJS.ErrnoException {
  return Object.assign(new Error('mock command failed'), { code: 'ENOENT' });
}

function psQuote(arg: string): string {
  return /\s/.test(arg) ? `'${arg.replaceAll("'", "'\\''")}'` : arg;
}

function fakeExecFile(): void {
  state.execFile.mockImplementation(((command: string, args: string[], _options: unknown, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
    state.calls.push({ command, args: [...args] });
    let error: ExecFileException | null = null;
    let stdout = '';
    if (command === 'tmux') {
      const tmuxCommand = args.find((arg) => ['has-session', 'list-panes', 'show-option'].includes(arg));
      if (tmuxCommand === 'has-session') stdout = '';
      else if (tmuxCommand === 'list-panes') stdout = `${state.panePid}\n`;
      else if (tmuxCommand === 'show-option') {
        if (state.marker) stdout = `${state.marker}\n`;
        else error = failure();
      } else error = failure();
    } else if (command === 'pgrep') {
      const parent = args[args.indexOf('-P') + 1]!;
      const children = state.processChildren[parent] ?? [];
      if (state.processErrors[parent] !== undefined) error = Object.assign(new Error('pgrep failed'), { code: state.processErrors[parent] });
      else if (children.length) stdout = `${children.join('\n')}\n`;
      else error = Object.assign(new Error('No child processes'), { code: 1 });
    } else if (command === 'ps') {
      const pid = args[args.indexOf('-p') + 1]!;
      const argv = state.processArgv[pid];
      if (argv) stdout = `${argv.map(psQuote).join(' ')}\n`;
      else error = failure();
    } else if (command === 'lsof') {
      const pid = args[args.indexOf('-p') + 1]!;
      const cwd = state.processCwd[pid];
      if (cwd) stdout = `p${pid}\nfcwd\nn${cwd}\n`;
      else error = failure();
    } else error = failure();
    queueMicrotask(() => callback(error, stdout, ''));
    return undefined;
  }) as never);
}

function commandFor(endpoint: string, cwd: string): string[] {
  return ['/opt/homebrew/bin/codex', '--remote', endpoint, '--cd', cwd, 'resume', threadId];
}

function addCandidate(pid: number, endpoint: string, cwd: string): void {
  state.processArgv[String(pid)] = commandFor(endpoint, cwd);
  state.processCwd[String(pid)] = cwd;
}

describe('codexTerminalEndpoint', () => {
  let directory: string;
  let cwd: string;
  let store: Store;
  let service: TerminalService;
  let sessionId: string;

  beforeEach(() => {
    state.processChildren = { [String(panePid)]: [] };
    state.processErrors = {};
    state.processArgv = {};
    state.processCwd = {};
    state.marker = undefined;
    state.panePid = panePid;
    state.calls = [];
    fakeExecFile();

    directory = mkdtempSync(join(tmpdir(), 'riffet-codex-endpoint-'));
    cwd = directory;
    store = new Store(join(directory, 'store.sqlite'));
    const project = store.createProject(cwd, 'codex-endpoint-test');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', nativeSessionId: threadId });
    sessionId = session.id;
    store.updateSession(session.id, { terminalId, state: 'running' });
    store.saveTerminal({
      id: terminalId,
      projectId: project.id,
      sessionId: session.id,
      title: 'Codex',
      kind: 'native',
      state: 'running',
      persistent: true,
      epoch: 0,
      cols: 100,
      rows: 40,
      createdAt: new Date().toISOString(),
    });
    service = new TerminalService(store, { stateDir: join(directory, 'state') });
  });

  const lookup = (thread: string, directory: string) => codexTerminalEndpoint({
    getSession: id => store.getSession(id), getProject: id => store.getProject(id), terminal: service,
  }, sessionId, terminalId, thread, directory);

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects an unlinked terminal or wrong provider thread before inspecting processes', async () => {
    expect(await lookup(`${threadId}-wrong`, cwd)).toBeUndefined();
    expect(state.calls).toHaveLength(0);

    store.updateSession(sessionId, { terminalId: 'another-terminal' });
    expect(await lookup(threadId, cwd)).toBeUndefined();
    expect(state.calls).toHaveLength(0);

    store.updateSession(sessionId, { terminalId });
    const otherSession = store.createSession({ projectId: store.getSession(sessionId).projectId, kind: 'native', backendId: 'codex', nativeSessionId: 'other-thread' });
    store.updateSession(otherSession.id, { terminalId });
    store.updateTerminal(terminalId, { sessionId: otherSession.id });
    expect(await lookup(threadId, cwd)).toBeUndefined();
    expect(state.calls).toHaveLength(0);
  });

  it('returns the endpoint from the matching process in the associated pane and does not attach', async () => {
    const endpoint = 'unix:///tmp/codex-app-server.sock';
    state.processChildren[String(panePid)] = [candidatePid];
    state.processArgv[String(panePid)] = ['/bin/zsh', '-i'];
    addCandidate(candidatePid, endpoint, cwd);

    expect(await lookup(threadId, cwd)).toBe(endpoint);
    expect(state.calls.some(({ command, args }) => command === 'tmux' && args.includes('attach-session'))).toBe(false);
    expect(state.calls.some(({ command, args }) => command === 'tmux' && args.includes('new-session'))).toBe(false);
  });

  it('rejects multiple matching processes that point at different app-server sockets', async () => {
    state.processChildren[String(panePid)] = [candidatePid, secondCandidatePid];
    addCandidate(candidatePid, 'unix:///tmp/codex-one.sock', cwd);
    addCandidate(secondCandidatePid, 'unix:///tmp/codex-two.sock', cwd);

    expect(await lookup(threadId, cwd)).toBeUndefined();
  });

  it('rejects an actual process cwd that differs from the project cwd', async () => {
    state.processChildren[String(panePid)] = [candidatePid];
    addCandidate(candidatePid, 'unix:///tmp/codex.sock', cwd);
    state.processCwd[String(candidatePid)] = join(directory, 'different-cwd');

    expect(await lookup(threadId, cwd)).toBeUndefined();
  });

  it('rejects a partial process tree even when its inspected prefix has one matching endpoint', async () => {
    state.processChildren[String(panePid)] = Array.from({ length: 32 }, (_, index) => candidatePid + index);
    addCandidate(candidatePid, 'unix:///first-owner.sock', cwd);
    addCandidate(candidatePid + 31, 'unix:///unvisited-owner.sock', cwd);

    expect(await lookup(threadId, cwd)).toBeUndefined();
  });

  it.each(['ENOENT', 2])('rejects an incomplete process tree when pgrep fails with %s', async code => {
    state.processChildren[String(panePid)] = [candidatePid, secondCandidatePid];
    addCandidate(candidatePid, 'unix:///first-owner.sock', cwd);
    state.processErrors[String(secondCandidatePid)] = code;

    expect(await lookup(threadId, cwd)).toBeUndefined();
  });

  it('rejects a stale launch marker even when process arguments look like Codex', async () => {
    state.processChildren[String(panePid)] = [candidatePid];
    addCandidate(candidatePid, 'unix:///tmp/codex.sock', cwd);
    state.marker = 'f'.repeat(64);

    expect(await lookup(threadId, cwd)).toBeUndefined();
  });

  it('stops the pane scan when its lookup budget expires', async () => {
    state.processChildren[String(panePid)] = [candidatePid];
    addCandidate(candidatePid, 'unix:///tmp/codex.sock', cwd);
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(6000);

    expect(await lookup(threadId, cwd)).toBeUndefined();
    expect(state.calls.some(({ command }) => command === 'pgrep' || command === 'ps' || command === 'lsof')).toBe(false);
  });

  it('ends a hung lookup at its deadline and allows the next lookup to recover', async () => {
    const endpoint = 'unix:///tmp/recovered-codex.sock';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(service, 'inspectPane').mockImplementationOnce(async () => await new Promise(() => undefined))
      .mockResolvedValue([{ pid: candidatePid, argv: commandFor(endpoint, cwd) }]);

    const result = lookup(threadId, cwd);
    await vi.advanceTimersByTimeAsync(5000);

    expect(await result).toBeUndefined();
    expect(await lookup(threadId, cwd)).toBe(endpoint);
    expect(vi.getTimerCount()).toBe(0);
  });
});
