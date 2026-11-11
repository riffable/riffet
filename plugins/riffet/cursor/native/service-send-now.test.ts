import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type AgentSessionView, type AgentTerminalView } from '@riffet/plugin-api';
import { cursorPort } from '../host-port.js';
import { FakeHost } from '../testing/fake-host.js';
import { NativeService } from './service.js';

const project = { id: 'project-1', name: 'Project', cwd: '/srv/home/alice/project' };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * cursor-agent 2026.10.01 as measured in tmux: a submitted prompt shows the spinner at once but
 * `ctrl+c to stop` only once the request is in flight; Ctrl+C before that only arms the exit; a
 * prompt submitted mid-turn waits in the follow-up box, and Enter on the empty bar steers it, then
 * interrupts the turn and sends it.
 */
class FakeCursorCli {
  turn: 'idle' | 'pending' | 'processing' = 'idle';
  bar = '';
  queue: string[] = [];
  steering = false;
  /** How long a submitted turn stays in the moment before Ctrl+C can act. */
  pendingMs = 0;
  /** How long a queued prompt takes to show in the box. */
  boxDelayMs = 30;
  boxVisibleAt = 0;
  exitArmedUntil = 0;
  exited = false;
  readonly keys: string[] = [];
  readonly sent: string[] = [];

  submit(text: string): void {
    this.sent.push(text);
    this.turn = 'pending';
    setTimeout(() => { if (this.turn === 'pending') this.turn = 'processing'; }, this.pendingMs);
  }

  press(key: string): void {
    this.keys.push(key);
    if (key === 'C-u' || key === 'C-k') { this.bar = ''; return; }
    if (key === 'C-c') {
      if (Date.now() < this.exitArmedUntil) { this.exited = true; return; }
      this.exitArmedUntil = Date.now() + 2000;
      if (this.turn === 'processing') { this.turn = 'idle'; this.queue = []; this.steering = false; }
      return;
    }
    if (key !== 'Enter') return;
    if (this.bar) {
      if (this.turn === 'idle') { const text = this.bar; this.bar = ''; this.submit(text); }
      else if (this.turn === 'processing') { this.queue.push(this.bar); this.bar = ''; this.boxVisibleAt = Date.now() + this.boxDelayMs; }
      return;
    }
    if (!this.queue.length || this.turn !== 'processing') return;
    if (!this.steering) { this.steering = true; return; }
    this.steering = false;
    this.submit(this.queue.shift()!);
  }

  screen(): string {
    const lines = ['  earlier transcript'];
    if (this.queue.length && Date.now() >= this.boxVisibleAt) {
      lines.push(' ┌─ follow-ups ───────────────────────────────┐');
      lines.push(` │○ ${this.queue[0]}${this.steering ? ' · steering' : ''} │`);
      lines.push(` │ enter ${this.steering ? 'interrupt and send' : 'steer'} · ↑ select/edit · esc cancel │`);
      lines.push(' └────────────────────────────────────────────┘');
    }
    if (this.turn !== 'idle') lines.push(' ⠘⠆ Working');
    const hint = this.turn === 'processing' && !this.bar ? '                    ctrl+c to stop' : '';
    lines.push(`  → ${this.bar || 'Add a follow-up'}${hint}`);
    if (Date.now() < this.exitArmedUntil) lines.push('  Press Ctrl+C again to exit');
    else lines.push('  Claude Opus 5.5 300K High · 7.4%       Run Everything', '  /srv/home/alice/project · main');
    return lines.join('\n');
  }
}

const services: NativeService[] = [];
afterEach(() => { while (services.length) services.pop()!.closeAll(); });

function harness(cli: FakeCursorCli) {
  const session: AgentSessionView = {
    id: 'session-1', projectId: project.id, title: 'Conversation', state: 'running',
    model: 'gpt-5', mode: 'agent', approval: 'unrestricted', terminalId: 'terminal-1',
  };
  const info: AgentTerminalView = {
    id: 'terminal-1', projectId: project.id, title: 't', kind: 'cursor', epoch: 1, state: 'running', persistent: true, cols: 80, rows: 24, createdAt: '2026-01-01T00:00:00.000Z',
  };
  const host = new FakeHost({ sessions: [session], projects: [project], terminals: [info] });
  host.screen = () => cli.screen();
  host.stateOf = () => (cli.exited ? 'exited' : 'running');
  host.control = {
    screen: async () => cli.screen(),
    keys: async (keys: string[]) => { for (const key of keys) cli.press(key); },
    paste: async (text: string) => { cli.bar += text; },
  };
  const service = new NativeService(cursorPort(host), { configDir: '/tmp/riffet-test', cliPath: 'cursor-agent', pollMs: 25 });
  services.push(service);
  return { service, session };
}

describe('NativeService.deliverNow', () => {
  it('replaces a running turn through the CLI follow-up queue, without a Ctrl+C', async () => {
    const cli = new FakeCursorCli();
    cli.submit('old task');
    await pause(5);
    const { service, session } = harness(cli);
    let fenced = 0;
    await service.deliverNow(session, 'new task', () => { fenced += 1; });
    expect(fenced).toBe(1);
    expect(cli.sent).toEqual(['old task', 'new task']);
    expect(cli.keys).not.toContain('C-c');
    // Enter submits into the queue, then steers, then interrupts and sends.
    expect(cli.keys.filter(key => key === 'Enter')).toHaveLength(3);
    expect(cli.queue).toEqual([]);
  });

  it('waits out the moment after a submit, when the CLI takes no prompt', async () => {
    const cli = new FakeCursorCli();
    cli.pendingMs = 300;
    cli.submit('old task');
    const { service, session } = harness(cli);
    const started = Date.now();
    await service.deliverNow(session, 'new task', () => {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(cli.sent).toEqual(['old task', 'new task']);
    expect(cli.keys).not.toContain('C-c');
  });

  it('sends to an idle CLI like any prompt', async () => {
    const cli = new FakeCursorCli();
    const { service, session } = harness(cli);
    await service.deliverNow(session, 'new task', () => {});
    expect(cli.sent).toEqual(['new task']);
    expect(cli.keys.filter(key => key === 'Enter')).toHaveLength(1);
  });

  it('writes nothing until an asynchronous fence has committed', async () => {
    const cli = new FakeCursorCli();
    const { service, session } = harness(cli);
    let committed = false;
    await service.deliverNow(session, 'new task', async () => {
      await pause(20);
      expect(cli.sent).toEqual([]);
      expect(cli.bar).toBe('');
      committed = true;
    });
    expect(committed).toBe(true);
    expect(cli.sent).toEqual(['new task']);
  });

  it('commits nothing when the CLI never takes a prompt in time', async () => {
    const cli = new FakeCursorCli();
    cli.pendingMs = 60_000;
    cli.submit('old task');
    const { service, session } = harness(cli);
    let fenced = 0;
    const sent = service.deliverNow(session, 'new task', () => { fenced += 1; });
    await expect(sent).rejects.toMatchObject({ code: 'CLI_BUSY' });
    expect(fenced).toBe(0);
    expect(cli.keys).toEqual([]);
  }, 15_000);
});

describe('NativeService.interrupt', () => {
  it('does not erase a successor draft when the target changes between cleanup keys', async () => {
    const cli = new FakeCursorCli();
    cli.bar = 'old pending input';
    const { service, session } = harness(cli);
    await expect(service.interrupt(session, { clearPrompt: true, beforeWrite: () => {
      if (cli.keys.includes('C-u')) {
        cli.bar = 'successor draft';
        cli.exited = true;
        throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'stop target changed', 409);
      }
    } })).rejects.toThrow('stop target changed');
    expect(cli.keys).toEqual(['C-u']);
    expect(cli.bar).toBe('successor draft');
  });

  it('holds the Ctrl+C until the CLI says it will stop, and never quits it', async () => {
    const cli = new FakeCursorCli();
    cli.pendingMs = 400;
    cli.submit('old task');
    const { service, session } = harness(cli);
    await service.interrupt(session);
    expect(cli.keys).toEqual(['C-c']);
    expect(cli.exited).toBe(false);
    expect(cli.turn).toBe('idle');
  });
});
