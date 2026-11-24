import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@riffet/plugin-api/kit';
import { type AgentSessionView, type AgentTerminalView } from '@riffet/plugin-api/experimental/agent';
import { cursorPort } from '../host-port.js';
import { FakeHost } from '../testing/fake-host.js';
import type { CursorLive, CursorLiveStep } from './live.js';
import { NativeService, type NativeServiceOptions } from './service.js';

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

function harness(cli: FakeCursorCli, options: Pick<NativeServiceOptions, 'live' | 'pollMs'> = {}) {
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
  const service = new NativeService(cursorPort(host), {
    configDir: '/tmp/riffet-test', cliPath: 'cursor-agent', pollMs: options.pollMs ?? 25, ...(options.live ? { live: options.live } : {}),
  });
  services.push(service);
  return { service, session };
}

async function settlePhase(service: NativeService, phase: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (service.status('session-1').phase === phase) return;
    await pause(10);
  }
  throw new Error(`native status stayed ${service.status('session-1').phase}`);
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

  it('sends to an idle CLI like any prompt without sending Ctrl+U/Ctrl+K on an empty bar', async () => {
    const cli = new FakeCursorCli();
    const { service, session } = harness(cli);
    await service.deliverNow(session, 'new task', () => {});
    expect(cli.sent).toEqual(['new task']);
    expect(cli.keys).toEqual(['Enter']);
  });

  it('skips editing keys on an empty bar and waits for Ctrl+U to take effect when clearing a draft', async () => {
    const emptyCli = new FakeCursorCli();
    const empty = harness(emptyCli);
    await empty.service.deliver(empty.session, '进一步优化，比如这种细节：\n\n/tmp/riffet-attachments/a/image.png', () => {});
    expect(emptyCli.keys).toEqual(['Enter']);
    expect(emptyCli.sent).toEqual(['进一步优化，比如这种细节：\n\n/tmp/riffet-attachments/a/image.png']);

    const stalledCli = new FakeCursorCli();
    stalledCli.bar = 'stale draft';
    const order: string[] = [];
    const stalled = harness(stalledCli);
    const original = stalledCli.press.bind(stalledCli);
    stalledCli.press = (key: string) => {
      order.push(`key:${key}`);
      if (key === 'C-u') {
        stalledCli.keys.push(key);
        setTimeout(() => { stalledCli.bar = ''; order.push('cleared'); }, 150);
        return;
      }
      original(key);
    };
    await stalled.service.deliver(stalled.session, 'fresh prompt', () => { order.push('fence'); });
    expect(order.indexOf('cleared')).toBeGreaterThan(order.indexOf('key:C-u'));
    expect(order.indexOf('fence')).toBeGreaterThan(order.indexOf('cleared'));
    expect(stalledCli.sent).toEqual(['fresh prompt']);
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

  it('checks the stop target before writing and aborts when it changed', async () => {
    const changed = () => { throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'stop target changed', 409); };
    const idle = new FakeCursorCli();
    idle.bar = 'draft';
    const idleHarness = harness(idle);
    let fenced = 0;
    await expect(idleHarness.service.deliverNow(idleHarness.session, 'new task', () => { fenced += 1; }, { checkTarget: changed }))
      .rejects.toMatchObject({ code: 'NATIVE_STOP_TARGET_CHANGED' });
    expect(fenced).toBe(0);
    expect(idle.keys).toEqual([]);
    expect(idle.bar).toBe('draft');
    expect(idle.sent).toEqual([]);

    const busy = new FakeCursorCli();
    busy.submit('old task');
    await pause(5);
    const busyHarness = harness(busy);
    await expect(busyHarness.service.deliverNow(busyHarness.session, 'new task', () => { fenced += 1; }, { checkTarget: changed }))
      .rejects.toMatchObject({ code: 'NATIVE_STOP_TARGET_CHANGED' });
    expect(fenced).toBe(0);
    expect(busy.sent).toEqual(['old task']);
    expect(busy.keys).toEqual([]);
  });
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

  it('does not keep a stopped turn busy from the live step it left unsealed', async () => {
    const cli = new FakeCursorCli();
    cli.submit('old task');
    await pause(5);
    const step: CursorLiveStep = {
      turn: 'generation', at: '2026-01-01T00:00:00.000Z', step: 'step-1', sealed: false,
      parts: [{ type: 'text', text: 'partial answer' }],
    };
    const live = { read: () => step } as unknown as CursorLive;
    const { service, session } = harness(cli, { live, pollMs: 60_000 });
    session.nativeSessionId = 'chat-1';
    const stop = service.subscribe(session.id, () => undefined);
    try {
      await settlePhase(service, 'busy');
      await service.interrupt(session);
      expect(cli.turn).toBe('idle');
      expect(cli.keys).toEqual(['C-c']);
      expect(service.status(session.id).phase).toBe('idle');
    } finally { stop(); }
  });
});
