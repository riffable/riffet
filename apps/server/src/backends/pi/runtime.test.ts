import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { PiRuntime } from './runtime.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof import('node:child_process').spawn>) =>
      (globalThis as unknown as { __piSpawn: (...values: unknown[]) => unknown }).__piSpawn(...args),
  };
});

type RecordValue = Record<string, unknown>;

class ProbeChild extends EventEmitter {
  readonly pid = 9_001;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(output: string) {
    super();
    setImmediate(() => {
      this.stdout.write(output);
      this.stdout.end();
      this.stderr.end();
      this.exitCode = 0;
      this.emit('exit', 0, null);
      this.emit('close', 0, null);
    });
  }

  kill(): boolean { return true; }
}

class FakePiChild extends EventEmitter {
  readonly pid = 9_002;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: RecordValue[] = [];
  getEntriesRefusals = 0;
  entries: Array<Record<string, unknown>> = [];
  appendCount = 1;
  failGetEntriesAfterAck = false;
  promptDisposition = 'started';
  holdPromptAck = false;
  failClearQueue = false;
  failAbort = false;
  onAbort?: () => void;
  onPrompt?: () => void;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private ackStarted = false;
  private refusedGetEntries = false;
  private readonly nativeSessionId: string;

  constructor(args: readonly string[]) {
    super();
    const index = args.indexOf('--session-id');
    this.nativeSessionId = index >= 0 ? String(args[index + 1]) : 'native-test';
    this.stdin.on('data', chunk => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let command: RecordValue;
        try { command = JSON.parse(line) as RecordValue; } catch { continue; }
        this.commands.push(command);
        this.respond(command);
      }
    });
    // pi leaves when its stdin closes; that keeps stop() fast in tests.
    this.stdin.on('finish', () => this.exit('SIGTERM'));
  }

  private respond(command: RecordValue): void {
    const id = command.id;
    if (typeof id !== 'string') return;
    switch (command.type) {
      case 'get_state':
        this.reply(id, 'get_state', {
          sessionId: this.nativeSessionId,
          model: { provider: 'anthropic', id: 'claude-fable-5' },
          thinkingLevel: 'off',
        });
        return;
      case 'get_entries':
        if (this.ackStarted && this.failGetEntriesAfterAck && !this.refusedGetEntries) {
          this.refusedGetEntries = true;
          this.getEntriesRefusals += 1;
          this.refuse(id, 'get_entries', 'the session is still being written');
          return;
        }
        this.reply(id, 'get_entries', { entries: this.entries, leafId: this.entries.at(-1)?.id ?? null });
        return;
      case 'prompt':
        for (let index = 0; index < this.appendCount; index++) {
          // Siblings model a pi rewrite: neither descends from the other, so both stay candidates.
          this.entries.push(userEntry(`u${this.entries.length + 1}`, typeof command.message === 'string' ? command.message : '', null));
        }
        this.ackStarted = true;
        this.onPrompt?.();
        if (!this.holdPromptAck) this.reply(id, 'prompt', { disposition: this.promptDisposition });
        return;
      case 'clear_queue':
        if (this.failClearQueue) this.refuse(id, 'clear_queue', 'the queue is still busy');
        else this.reply(id, 'clear_queue', {});
        return;
      case 'abort':
        this.onAbort?.();
        if (this.failAbort) this.refuse(id, 'abort', 'abort response lost');
        else this.reply(id, 'abort', {});
        return;
      case 'get_session_stats':
        this.reply(id, 'get_session_stats', { contextUsage: { contextWindow: 1_000, tokens: 10 } });
        return;
      case 'get_available_models':
        this.reply(id, 'get_available_models', { models: [] });
        return;
      case 'get_available_thinking_levels':
        this.reply(id, 'get_available_thinking_levels', { levels: ['off', 'low', 'high'] });
        return;
      case 'set_model':
        this.reply(id, 'set_model', { provider: 'anthropic', id: 'claude-fable-5' });
        return;
      case 'extension_ui_response':
        return;
      default:
        this.reply(id, String(command.type), {});
    }
  }

  private reply(id: string, command: string, data: RecordValue): void {
    this.stdout.write(`${JSON.stringify({ id, type: 'response', command, success: true, data })}\n`);
  }

  private refuse(id: string, command: string, error: string): void {
    this.stdout.write(`${JSON.stringify({ id, type: 'response', command, success: false, error })}\n`);
  }

  frame(frame: RecordValue): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  exit(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.exitCode = 0;
    this.emit('exit', 0, signal);
    this.emit('close', 0, signal);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.exit(signal);
    return true;
  }
}

const cleanups: Array<() => unknown | Promise<unknown>> = [];
const children: FakePiChild[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  children.length = 0;
});

let configDir = '';

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'riffet-pi-runtime-'));
  cleanups.push(() => rm(configDir, { recursive: true, force: true }));
});

interface HarnessOptions {
  holdFirstPromptAck?: boolean;
  history?: Array<Record<string, unknown>>;
  appended?: number;
  failGetEntriesAfterAck?: boolean;
}

function useSpawn(options: HarnessOptions = {}): void {
  (globalThis as unknown as { __piSpawn: (...values: unknown[]) => unknown }).__piSpawn = (command: unknown, args: unknown) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    if (argv.includes('--version')) return new ProbeChild('1.4.0\n');
    if (argv.includes('--help')) return new ProbeChild('Usage: pi [options]\n  --mode <mode>  rpc\n');
    const child = new FakePiChild(argv);
    child.entries = options.history ?? [];
    child.appendCount = options.appended ?? 1;
    child.holdPromptAck = options.holdFirstPromptAck === true && children.length === 0;
    child.failGetEntriesAfterAck = options.failGetEntriesAfterAck ?? false;
    children.push(child);
    return child;
  };
}

interface Harness {
  runtime: PiRuntime;
  host: NativeBackendHost;
  session: Record<string, unknown>;
  profile: NativeBackendProfileConfig;
  emitted: RecordValue[];
  order: string[];
  receipts: Map<string, RecordValue>;
  child(): FakePiChild;
}

function harness(options: HarnessOptions = {}): Harness {
  useSpawn(options);
  const emitted: RecordValue[] = [];
  const order: string[] = [];
  const receipts = new Map<string, RecordValue>();
  const session: Record<string, unknown> = {
    id: 'session-1', projectId: 'project-1', title: 'Test', model: 'anthropic/claude-fable-5',
    configRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const project = { id: 'project-1', cwd: configDir };
  const host = {
    getSession: () => session,
    getProject: () => project,
    updateSession: (_id: string, patch: RecordValue) => Object.assign(session, patch),
    bumpConfig: (_id: string, patch: RecordValue) => Object.assign(session, patch),
    setNativeSessionId: (_id: string, nativeSessionId: string | undefined) => {
      if (nativeSessionId) session.nativeSessionId = nativeSessionId;
      return session;
    },
    emit: vi.fn(),
    emitEvent: (_id: string, event: RecordValue) => { emitted.push(event); },
    saveRunMetrics: vi.fn(),
    findRunIdByNativeMessage: () => undefined,
    listRuns: () => [],
    stats: { recordUsage: vi.fn(), observeEvents: vi.fn() },
    getInteractionReceipt: (_sessionId: string, id: string) => receipts.get(id),
    saveInteractionReceipt: (_sessionId: string, id: string, receipt: RecordValue) => {
      receipts.set(id, receipt);
      return receipt;
    },
    readAttachment: async () => { throw new Error('no attachments in this test'); },
    commitDispatchFence: () => ({ id: 'run-1' }),
    isRunCancelled: () => false,
    withSessionLock: async (_id: string, operation: () => unknown) => await operation(),
    transcript: {
      drain: async () => { order.push('drain'); },
      endTurn: async (_id: string, turnId: string, status: string) => { order.push(`endTurn:${turnId}:${status}`); },
      withSource: async () => undefined,
      wake: () => undefined,
    },
  } as unknown as NativeBackendHost;
  const profile: NativeBackendProfileConfig = {
    id: 'local', backendId: 'pi', name: 'pi', isDefault: true,
    config: { executable: process.execPath, configDir },
  };
  return {
    runtime: new PiRuntime(host, undefined),
    host,
    session,
    profile,
    emitted,
    order,
    receipts,
    child: () => children.at(-1)!,
  };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function userEntry(id: string, text: string, parentId: string | null = null): Record<string, unknown> {
  return {
    id, parentId, type: 'message', timestamp: new Date(Date.now() + 1_000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

async function send(h: Harness, text = 'hello', runId = 'run-1', commandId = 'command-1'): Promise<void> {
  await h.runtime.send({
    session: h.session as never,
    project: { id: 'project-1', cwd: configDir } as never,
    profile: h.profile,
    commandId,
    runId,
    input: { text, context: [], attachmentIds: [] } as never,
    config: { mode: 'agent' },
    isCancelled: () => false,
    commitDispatchFence: () => ({ id: runId }),
  });
}

describe('pi runtime turn settlement', () => {
  it('does not finish on turn_end or agent_end; only agent_settled completes the confirmed turn', async () => {
    const h = harness();
    cleanups.push(() => h.runtime.close());
    await send(h);
    const child = h.child();

    child.frame({ type: 'turn_end' });
    child.frame({ type: 'agent_end' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.order).toEqual([]);

    child.frame({ type: 'agent_settled', aborted: false });
    await until(() => h.order.includes('endTurn:u1:completed'));
    expect(h.order).toEqual(['drain', 'endTurn:u1:completed']);
  });

  it('leaves two identical user entries ambiguous instead of completing a guessed run', async () => {
    const h = harness({ appended: 2 });
    cleanups.push(() => h.runtime.close());
    await send(h);
    const child = h.child();
    child.frame({ type: 'agent_settled', aborted: false });
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(h.order.filter(step => step.startsWith('endTurn:'))).toEqual([]);
    expect(h.emitted.some(event => event.type === 'run_completed')).toBe(false);
    expect(h.emitted.some(event => event.type === 'native_input_receipt')).toBe(false);
  });

  it('does not report a stop when clear_queue is refused', async () => {
    const h = harness();
    cleanups.push(() => h.runtime.close());
    await send(h);
    const child = h.child();
    child.failClearQueue = true;

    await expect(h.runtime.interrupt(h.session as never)).rejects.toMatchObject({ code: 'NATIVE_INTERRUPT_UNCONFIRMED' });
    expect(child.commands.some(command => command.type === 'abort')).toBe(true);
  });

  it('does not abort or kill a successor when the stop guard changes during clear_queue', async () => {
    const h = harness();
    cleanups.push(() => h.runtime.close());
    await send(h);
    const child = h.child();
    let guards = 0;
    await expect(h.runtime.interrupt(h.session as never, () => {
      if (++guards === 2) throw new Error('stop target changed');
    })).rejects.toThrow('stop target changed');
    expect(child.commands.filter(command => command.type === 'clear_queue')).toHaveLength(1);
    expect(child.commands.some(command => command.type === 'abort')).toBe(false);
    expect(child.stdin.writableEnded).toBe(false);
    expect(child.signalCode).toBeNull();
    child.frame({ type: 'agent_settled', aborted: false });
    await until(() => h.order.includes('endTurn:u1:completed'));
  });

  it('keeps a guard failure outside the process-kill fallback after an abort error', async () => {
    const h = harness();
    cleanups.push(() => h.runtime.close());
    await send(h);
    const child = h.child();
    let changed = false;
    child.failAbort = true;
    child.onAbort = () => { changed = true; };
    await expect(h.runtime.interrupt(h.session as never, () => {
      if (changed) throw new Error('stop target changed');
    })).rejects.toThrow('stop target changed');
    expect(child.commands.filter(command => command.type === 'abort')).toHaveLength(1);
    expect(child.stdin.writableEnded).toBe(false);
    expect(child.signalCode).toBeNull();
    child.frame({ type: 'agent_settled', aborted: false });
    await until(() => h.order.includes('endTurn:u1:completed'));
  });

  it('drains the transcript before ending an interrupted turn on process exit', async () => {
    const h = harness();
    cleanups.push(() => h.runtime.close());
    await send(h);
    const child = h.child();
    child.exit('SIGTERM');
    await until(() => h.order.includes('endTurn:u1:interrupted'));
    expect(h.order).toEqual(['drain', 'endTurn:u1:interrupted']);
  });

  it('keeps a pre-ACK settled frame on its old process when a conversation starts another process', async () => {
    const h = harness({ holdFirstPromptAck: true });
    cleanups.push(() => h.runtime.close());
    await send(h);
    const old = h.child();
    old.frame({ type: 'agent_settled', aborted: false });
    await until(() => old.commands.filter(command => command.type === 'get_entries').length >= 3);
    await new Promise(resolve => setTimeout(resolve, 10));
    old.exit();
    await until(() => h.order.includes('drain'));

    await send(h, 'next process', 'run-2', 'command-2');
    const next = h.child();
    expect(next).not.toBe(old);
    await until(() => h.emitted.some(event => event.type === 'native_input_receipt' && (event.data as RecordValue).commandId === 'command-2'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.order.some(step => step.endsWith(':completed'))).toBe(false);
    expect(h.runtime.status(h.session as never).phase).toBe('busy');
    next.frame({ type: 'agent_settled', aborted: false });
    await until(() => h.order.includes('endTurn:u1:completed'));
  });

  it('keeps a running pi process when the background reconcile read fails once', async () => {
    const h = harness({ failGetEntriesAfterAck: true });
    cleanups.push(() => h.runtime.close());
    await send(h);
    const child = h.child();
    await until(() => child.getEntriesRefusals === 1);
    expect(child.exitCode).toBeNull();
    expect(child.commands.some(command => command.type === 'abort' || command.type === 'clear_queue')).toBe(false);

    await send(h, 'again', 'run-2', 'command-2');
    expect(child.commands.filter(command => command.type === 'prompt')).toHaveLength(2);
    expect(child.exitCode).toBeNull();
  });

  it('maps a selected pi option to its label and reuses the interaction receipt', async () => {
    const h = harness();
    cleanups.push(() => h.runtime.close());
    await send(h);
    const child = h.child();
    child.frame({ type: 'extension_ui_request', id: 'request-1', method: 'select', title: 'Choose', options: ['Alpha', 'Beta'] });

    const response = {
      interactionId: 'pi:request-1', revision: 'request-1:0', requestId: 'retry-1',
      action: 'answer', selectedIds: ['option:1'],
    };
    const first = await h.runtime.respond(h.session as never, response);
    expect(first).toEqual({ status: 'completed' });
    const sent = child.commands.filter(command => command.type === 'extension_ui_response');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 'request-1', value: 'Beta' });
    expect(h.receipts.get('retry-1')).toMatchObject({ interactionId: 'pi:request-1', revision: 'request-1:0' });

    const second = await h.runtime.respond(h.session as never, response);
    expect(second).toEqual({ status: 'completed' });
    expect(child.commands.filter(command => command.type === 'extension_ui_response')).toHaveLength(1);
  });
});
