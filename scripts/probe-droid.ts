/**
 * Records real `droid exec` stream JSON-RPC frames for the Droid backend.
 *
 * The protocol is Factory's own: the SDK publishes the method names, but the shapes of a permission
 * request, an AskUser question, a tool result or a turn outcome are only known by watching a real
 * process. Run this after a Droid update to see whether the frames the backend parses still look
 * the same:
 *
 *   pnpm tsx scripts/probe-droid.ts [scenario...] [--model <id>] [--out <file>]
 *
 * Scenarios run in a throwaway directory, use a cheap model by default and spend real credits.
 * Every frame (stdout, server requests and the client's answers) is written to the output file,
 * which defaults to `tmp/droid-probe-<time>.json`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

type Frame = Record<string, unknown>;
interface Scenario {
  name: string;
  init?: Record<string, unknown>;
  run(client: Client): Promise<void>;
}

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
const model = option('--model') ?? 'claude-haiku-4-5-20251001';
const out = resolve(option('--out') ?? join('tmp', `droid-probe-${Date.now()}.json`));

class Client {
  readonly frames: Array<{ at: number; direction: 'in' | 'out' | 'stderr'; frame: unknown }> = [];
  private readonly pending = new Map<string, (frame: Frame) => void>();
  private readonly waiters: Array<{ match(frame: Frame): boolean; resolve(frame: Frame): void }> = [];
  private seq = 0;
  readonly child;
  answer: (frame: Frame) => unknown = () => ({ selectedOption: 'cancel' });

  constructor(readonly cwd: string) {
    this.child = spawn(process.env.DROID_CLI ?? 'droid', ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--cwd', cwd], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (chunk: Buffer) => this.frames.push({ at: Date.now(), direction: 'stderr', frame: chunk.toString() }));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let frame: Frame;
      try { frame = JSON.parse(line) as Frame; } catch { this.frames.push({ at: Date.now(), direction: 'in', frame: line }); return; }
      this.frames.push({ at: Date.now(), direction: 'in', frame });
      if (frame.type === 'response' && typeof frame.id === 'string') { this.pending.get(frame.id)?.(frame); this.pending.delete(frame.id); }
      if (frame.type === 'request') this.write({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', type: 'response', id: frame.id, result: this.answer(frame) });
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(frame)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    });
  }

  private write(frame: Frame): void {
    this.frames.push({ at: Date.now(), direction: 'out', frame });
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<Frame> {
    const id = `probe-${++this.seq}`;
    this.write({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', type: 'request', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      timer.unref();
      this.pending.set(id, frame => { clearTimeout(timer); resolve(frame); });
    });
  }

  next(match: (frame: Frame) => boolean, timeoutMs = 120_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
      timer.unref();
      this.waiters.push({ match, resolve: frame => { clearTimeout(timer); resolve(frame); } });
    });
  }

  turnEnd(): Promise<Frame> {
    return this.next(frame => notification(frame)?.type === 'agent_turn_completed');
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise(resolve => setTimeout(resolve, 1500));
    this.child.kill('SIGTERM');
  }
}

function notification(frame: Frame): Record<string, unknown> | undefined {
  const params = frame.params as Record<string, unknown> | undefined;
  return frame.method === 'droid.session_notification' ? params?.notification as Record<string, unknown> | undefined : undefined;
}

function firstOption(frame: Frame, preferred: string): { selectedOption: string } {
  const options = ((frame.params as Record<string, unknown>)?.options as Array<{ value: string }> | undefined) ?? [];
  return { selectedOption: options.find(item => item.value === preferred)?.value ?? options[0]?.value ?? 'cancel' };
}

const scenarios: Scenario[] = [
  {
    name: 'permissions',
    init: { autonomyLevel: 'off' },
    async run(client) {
      client.answer = frame => frame.method === 'droid.request_permission' ? firstOption(frame, 'proceed_once') : {};
      await client.call('droid.add_user_message', { text: 'Create a file named hello.txt containing the word hi, then run the shell command `ls -la` and tell me what you see. Use your tools.' });
      await client.turnEnd();
    },
  },
  {
    name: 'denied',
    init: { autonomyLevel: 'off' },
    async run(client) {
      client.answer = frame => frame.method === 'droid.request_permission' ? { selectedOption: 'cancel' } : {};
      await client.call('droid.add_user_message', { text: 'Run the shell command `touch denied.txt`.' });
      await client.turnEnd();
    },
  },
  {
    name: 'ask-user',
    init: { autonomyLevel: 'low' },
    async run(client) {
      client.answer = frame => {
        if (frame.method !== 'droid.ask_user') return firstOption(frame, 'proceed_once');
        const questions = ((frame.params as Record<string, unknown>).questions as Array<{ index: number; question: string; options?: string[] }>) ?? [];
        return { cancelled: false, answers: questions.map(item => ({ index: item.index, question: item.question, answer: item.options?.[0] ?? 'red' })) };
      };
      await client.call('droid.add_user_message', { text: 'Use the AskUser tool to ask me one multiple-choice question: which colour do I prefer, red or blue. Then reply with my answer in one sentence.' });
      await client.turnEnd();
    },
  },
  {
    name: 'todo-and-read',
    init: { autonomyLevel: 'low' },
    async run(client) {
      writeFileSync(join(client.cwd, 'notes.md'), '# Notes\n\nalpha\nbeta\n');
      await client.call('droid.add_user_message', { text: 'Use TodoWrite to plan two steps (read notes.md, summarise it), mark them done as you go, read notes.md with your Read tool, then answer in one line.' });
      await client.turnEnd();
    },
  },
  {
    name: 'interrupt',
    init: { autonomyLevel: 'low' },
    async run(client) {
      await client.call('droid.add_user_message', { text: 'Write a 2000-word essay about the history of compilers.' });
      await client.next(frame => notification(frame)?.type === 'assistant_text_delta' || notification(frame)?.type === 'thinking_text_delta');
      await client.call('droid.interrupt_session');
      await client.turnEnd();
    },
  },
  {
    name: 'settings',
    init: { autonomyLevel: 'off' },
    async run(client) {
      await client.call('droid.update_session_settings', { autonomyLevel: 'medium', reasoningEffort: 'low', interactionMode: 'spec' });
      await client.call('droid.update_session_settings', { interactionMode: 'auto' });
      await client.call('droid.rename_session', { title: 'Riffet probe' });
    },
  },
  {
    name: 'spec',
    init: { autonomyLevel: 'low', interactionMode: 'spec' },
    async run(client) {
      client.answer = frame => frame.method === 'droid.request_permission' ? firstOption(frame, 'proceed_once') : {};
      await client.call('droid.add_user_message', { text: 'Plan how to add a README.md that says hello. Keep the plan to two bullet points and propose it.' });
      await client.turnEnd();
    },
  },
];

const selected = args.length ? scenarios.filter(item => args.includes(item.name)) : scenarios;
const root = mkdtempSync(join(tmpdir(), 'riffet-droid-probe-'));
const results: Record<string, unknown> = {};
for (const scenario of selected) {
  const cwd = join(root, scenario.name);
  mkdirSync(cwd, { recursive: true });
  const client = new Client(cwd);
  const started = Date.now();
  try {
    const init = await client.call('droid.initialize_session', { machineId: 'riffet-probe', cwd, modelId: model, ...scenario.init });
    await scenario.run(client);
    const sessionId = (init.result as Record<string, unknown> | undefined)?.sessionId;
    const loaded = typeof sessionId === 'string' ? await client.call('droid.load_session', { sessionId }) : undefined;
    results[scenario.name] = { ok: true, ms: Date.now() - started, sessionId, loaded: loaded?.result, frames: client.frames };
    console.log(`ok   ${scenario.name} (${Date.now() - started} ms, ${client.frames.length} frames)`);
  } catch (error) {
    results[scenario.name] = { ok: false, error: String(error), frames: client.frames };
    console.log(`fail ${scenario.name}: ${String(error)}`);
  } finally {
    await client.close();
  }
}
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify({ model, root, results }, null, 2));
console.log(`\nframes written to ${out}`);
