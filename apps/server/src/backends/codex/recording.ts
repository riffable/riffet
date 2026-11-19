/**
 * Recording and replay of the Codex App Server protocol at the `CodexAppServerClient` seam
 * (docs/guide/aif.md §5.4). `scripts/record.ts` drives a scenario against the real CLI through
 * `recordingFactory` and writes what crossed the seam; `recordings.test.ts` feeds a recording back
 * through `replayFactory` and compares the journal rows the driver wrote.
 *
 * Inbound messages are replayed after the outbound message that preceded them in the recording, so
 * the runtime sees them in the order the CLI sent them relative to its own requests; each is
 * delivered once. When the runtime goes quiet with messages still undelivered — it did not repeat the
 * request (often a timer-driven poll) they followed — the next batch is released in recorded order.
 * A request the recording does not hold is answered with the method's last recorded response, or
 * fails as an unknown method. Either way a changed request pattern shows up as changed rows, not a
 * hang. Approvals are answered by the harness with the card's primary action, as a person would;
 * the runtime's answer then releases what the CLI sent after it. An interrupt is sent where the
 * recording sent it: the replay holds its stall release until that point (`reached`).
 *
 * The hook channel (`observation.ts`) is recorded in the same stream, as `hook` messages in the
 * order they reached Riffet's hook endpoint. The replay delivers them to nothing: what a command
 * changed needs a real working tree. `hookProblems` checks the contract observation depends on
 * instead, on every recording and on each drift run.
 */
import { DatabaseSync } from 'node:sqlite';
import { Journal, type JournalRow } from '../../journal/journal.js';
import { JournalLaneWriter, pullLane } from '../../journal/ingest.js';
import { rowsOf } from '../../journal/ingest-contract.js';
import type { NativeBackendId, Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient, CodexAppServerFactory, CodexAppServerOptions, JsonRpcId, JsonRpcServerRequest } from '../shared/codex-app-server.js';
import { NO_SERVER_RESPONSE } from '../shared/codex-app-server.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeBackendSendRequest } from '../types.js';
import { CodexBackendAdapter } from './index.js';
import { codexFlavor, traexFlavor, type AppServerProbe } from './flavors.js';
import type { CodexObservation } from './observation.js';

export interface RecordingMeta {
  cli: 'codex' | 'traex';
  /** `<cli> --version`, e.g. `codex-cli 0.167.2`. */
  version: string;
  serverUserAgent?: string;
  /** What `probeAppServer` found, so the replay takes the same launch path as the recording. */
  probe: AppServerProbe;
  scenario: string;
  prompts: string[];
  approval: string;
}

export type RecordedMessage =
  | { dir: 'out'; kind: 'request'; id: number; method: string; params?: unknown }
  | { dir: 'in'; kind: 'response'; id: number; result?: unknown; error?: { message: string; code?: number } }
  | { dir: 'out'; kind: 'notification'; method: string; params?: unknown }
  | { dir: 'in'; kind: 'notification'; method: string; params: Record<string, unknown> }
  | { dir: 'in'; kind: 'serverRequest'; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { dir: 'out'; kind: 'serverResponse'; id: JsonRpcId; result: unknown }
  /** A payload the CLI's hook command delivered to Riffet's hook endpoint. */
  | { dir: 'in'; kind: 'hook'; payload: Record<string, unknown> };

export interface Recording { meta: RecordingMeta; messages: RecordedMessage[] }

/**
 * What `scripts/record.ts` drives; the replay test runs whatever recordings exist. Prompts are short
 * and deterministic so a re-recording differs only where the CLI did.
 */
export interface Scenario {
  prompts: string[];
  approval: string;
  /** A tool call must appear. */
  tool?: boolean;
  /** Approval cards are answered with their primary action. */
  approve?: boolean;
  /** The turn is interrupted once the answer streams; it ends `interrupted`. */
  interrupt?: boolean;
}

export const CODEX_SCENARIOS: Record<string, Scenario> = {
  answer: { prompts: ['Reply with exactly the word: ready'], approval: 'on-request' },
  command: { prompts: ['Run `ls` in the current directory, then reply with the number of entries only.'], approval: 'on-request', tool: true },
  'two-turns': { prompts: ['Remember the word maple. Reply with exactly: ok', 'Which word did I ask you to remember? Reply with the word only.'], approval: 'on-request' },
  approval: { prompts: ['Create a file named hello.txt containing the single word hi, then reply with: done'], approval: 'read-only', tool: true, approve: true },
  interrupt: { prompts: ['Count from 1 to 300, one number per line, with no other text.'], approval: 'on-request', interrupt: true },
};

/** The CLIs that run through this driver, with the scenarios recorded for each (TRAE's fork has no observation and no approval scenario). */
export const RECORDED_CLIS = {
  codex: { flavor: codexFlavor, scenarios: Object.keys(CODEX_SCENARIOS) },
  traex: { flavor: traexFlavor, scenarios: ['answer', 'command'] },
} as const;
export type RecordedCli = keyof typeof RECORDED_CLIS;

/**
 * What every run of a scenario must produce whatever the model says: a start and a completed end
 * per prompt, the prompt itself, an answer, and a tool call where the scenario asks for one. Used by
 * the drift check (`pnpm record codex all --check`); the replay test compares exact rows instead.
 */
export function scenarioProblems(scenario: Scenario, rows: JournalRow[]): string[] {
  const count = (kind: string) => rows.filter(row => row.kind === kind).length;
  const problems: string[] = [];
  const turns = scenario.prompts.length;
  if (count('meta.turn_started') !== turns) problems.push(`${count('meta.turn_started')} turn starts, expected ${turns}`);
  const ended = rows.filter(row => row.kind === 'meta.turn_ended');
  const status = scenario.interrupt ? 'interrupted' : 'completed';
  if (ended.length !== turns || ended.some(row => (row.payload as { status?: string })?.status !== status)) {
    problems.push(`turn ends ${JSON.stringify(ended.map(row => (row.payload as { status?: string })?.status))}, expected ${turns} × ${status}`);
  }
  if (count('user_message_chunk') < turns) problems.push(`${count('user_message_chunk')} prompts, expected ${turns}`);
  if (!scenario.interrupt && count('agent_message_chunk') < turns) problems.push(`${count('agent_message_chunk')} answers, expected at least ${turns}`);
  if (scenario.tool && !count('tool_call')) problems.push('no tool call');
  return problems;
}

/** Appends every hook payload `observation` receives to `sink`, before it is handled. */
export function recordHooks(observation: CodexObservation, sink: RecordedMessage[]): void {
  const handle = observation['onHook'].bind(observation);
  Object.assign(observation, {
    onHook: (payload: Record<string, unknown>) => { sink.push({ dir: 'in', kind: 'hook', payload: structuredClone(payload) }); return handle(payload); },
  });
}

/**
 * What `observation.ts` relies on, checked against a recording: each command item has a PreToolUse
 * and a PostToolUse for `Bash` whose `tool_use_id` is the item's id and whose `session_id` is the
 * thread, and the PreToolUse arrives before the item completes (it blocks the command).
 */
export function hookProblems(recording: Recording): string[] {
  const problems: string[] = [];
  const messages = recording.messages;
  const thread = messages.map(message => message.kind === 'response' ? (message.result as { thread?: { id?: unknown } } | undefined)?.thread?.id : undefined).find(id => typeof id === 'string');
  const completedAt = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.kind !== 'notification' || message.dir !== 'in') return;
    const item = (message.params as { item?: { type?: unknown; id?: unknown } }).item;
    if (item?.type !== 'commandExecution' || typeof item.id !== 'string') return;
    if (message.method === 'item/started' && !completedAt.has(item.id)) completedAt.set(item.id, Infinity);
    if (message.method === 'item/completed') completedAt.set(item.id, index);
  });
  const hooks = messages.flatMap((message, index) => message.kind === 'hook' ? [{ index, payload: message.payload }] : []);
  for (const [id, completed] of completedAt) {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const hook = hooks.find(entry => entry.payload.hook_event_name === event && entry.payload.tool_use_id === id);
      if (!hook) { problems.push(`command ${id}: no ${event} hook`); continue; }
      if (hook.payload.tool_name !== 'Bash') problems.push(`command ${id}: ${event} tool_name is ${JSON.stringify(hook.payload.tool_name)}, expected "Bash"`);
      if (hook.payload.session_id !== thread) problems.push(`command ${id}: ${event} session_id is not the thread id`);
      if (typeof hook.payload.cwd !== 'string') problems.push(`command ${id}: ${event} has no cwd`);
      if (event === 'PreToolUse' && hook.index > completed) problems.push(`command ${id}: PreToolUse arrived after the item completed`);
    }
  }
  return problems;
}

export function parseRecording(text: string): Recording {
  const [head, ...rest] = text.split('\n').filter(line => line.trim());
  return { meta: JSON.parse(head!) as RecordingMeta, messages: rest.map(line => JSON.parse(line) as RecordedMessage) };
}

export function formatRecording(recording: Recording): string {
  return [recording.meta, ...recording.messages].map(entry => JSON.stringify(entry)).join('\n') + '\n';
}

/** Wraps a real factory; every message crossing the seam is appended to `sink`. */
export function recordingFactory(inner: CodexAppServerFactory, sink: RecordedMessage[], onClient?: (client: CodexAppServerClient) => void): CodexAppServerFactory {
  return async options => {
    const wrapped: CodexAppServerOptions = {
      ...options,
      onNotification: (method, params) => {
        sink.push({ dir: 'in', kind: 'notification', method, params: structuredClone(params) });
        options.onNotification(method, params);
      },
      onServerRequest: async request => {
        sink.push({ dir: 'in', kind: 'serverRequest', id: request.id, method: request.method, params: structuredClone(request.params) });
        const result = await options.onServerRequest(request);
        if (result !== NO_SERVER_RESPONSE) sink.push({ dir: 'out', kind: 'serverResponse', id: request.id, result: structuredClone(result) });
        return result;
      },
    };
    const client = await inner(wrapped);
    onClient?.(client);
    let nextId = 1;
    const recorded: CodexAppServerClient = {
      get remoteAddress() { return client.remoteAddress; },
      get processId() { return client.processId; },
      get serverUserAgent() { return client.serverUserAgent; },
      get authToken() { return client.authToken; },
      get isOnline() { return client.isOnline; },
      async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
        const id = nextId++;
        sink.push({ dir: 'out', kind: 'request', id, method, ...(params === undefined ? {} : { params: structuredClone(params) }) });
        try {
          const result = await client.request<T>(method, params, timeoutMs);
          sink.push({ dir: 'in', kind: 'response', id, result: structuredClone(result) });
          return result;
        } catch (error) {
          const rpc = error as { message?: string; rpcCode?: number };
          sink.push({ dir: 'in', kind: 'response', id, error: { message: String(rpc.message ?? error), ...(rpc.rpcCode === undefined ? {} : { code: rpc.rpcCode }) } });
          throw error;
        }
      },
      notify(method: string, params?: unknown) {
        sink.push({ dir: 'out', kind: 'notification', method, ...(params === undefined ? {} : { params: structuredClone(params) }) });
        client.notify(method, params);
      },
      respond: (id, result) => client.respond(id, result),
      ...(client.detach ? { detach: () => client.detach!() } : {}),
      dispose: () => client.dispose(),
    };
    return recorded;
  };
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
/** How long the runtime may stay quiet before undelivered messages are released anyway. */
const STALL_MS = 150;

/** Answers the runtime from a recording; see the file comment for the ordering rule. */
class ReplayClient implements CodexAppServerClient {
  readonly remoteAddress = 'unix:///replay-codex.sock';
  readonly serverUserAgent?: string;
  isOnline = true;
  private readonly requests = new Map<string, number[]>();
  private readonly lastResponse = new Map<string, Extract<RecordedMessage, { kind: 'response' }>>();
  private readonly notifications = new Map<string, number[]>();
  private readonly responseAt = new Map<number, number>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly delivered = new Set<number>();
  private lastActivity = Date.now();

  constructor(private readonly options: CodexAppServerOptions, private readonly recording: Recording) {
    this.serverUserAgent = recording.meta.serverUserAgent;
    recording.messages.forEach((message, index) => {
      if (message.dir === 'out' && message.kind === 'request') this.requests.set(message.method, [...this.requests.get(message.method) ?? [], index]);
      if (message.dir === 'out' && message.kind === 'notification') this.notifications.set(message.method, [...this.notifications.get(message.method) ?? [], index]);
      if (message.dir === 'in' && message.kind === 'response') this.responseAt.set(message.id, index);
    });
  }

  /**
   * Resolves once every scheduled inbound message has been delivered and handled. Called while
   * waiting for a turn to settle: after `STALL_MS` without activity it releases the next undelivered
   * batch (see the file comment).
   */
  async drained(release = true): Promise<void> {
    while (this.pending > 0) { await this.queue; await tick(); }
    if (!release || Date.now() - this.lastActivity < STALL_MS) return;
    const first = this.recording.messages.findIndex((message, index) => message.dir === 'in' && message.kind !== 'response' && !this.delivered.has(index));
    if (first >= 0) await this.deliver(this.follow(first - 1));
  }

  /** Every inbound message recorded before the next `method` request has been delivered and handled. */
  reached(method: string): boolean {
    const index = this.requests.get(method)?.[0];
    if (index === undefined) return true;
    for (let at = 0; at < index; at++) {
      const message = this.recording.messages[at]!;
      if (message.dir === 'in' && message.kind !== 'response' && !this.delivered.has(at)) return false;
    }
    return this.pending === 0;
  }

  /** Undelivered inbound messages after `from` up to the next outbound one (or `until`), minus responses. */
  private follow(from: number, until = Infinity): number[] {
    const out: number[] = [];
    for (let index = from + 1; index < this.recording.messages.length && index < until; index++) {
      const message = this.recording.messages[index]!;
      if (message.dir === 'out') break;
      if (message.kind !== 'response' && !this.delivered.has(index)) out.push(index);
    }
    return out;
  }

  private deliver(indices: number[]): Promise<void> {
    this.lastActivity = Date.now();
    if (!indices.length) return Promise.resolve();
    for (const index of indices) this.delivered.add(index);
    this.pending++;
    const run = this.queue.then(async () => {
      for (const message of indices.map(index => this.recording.messages[index]!)) {
        await tick();
        if (message.kind === 'notification' && message.dir === 'in') this.options.onNotification(message.method, structuredClone(message.params));
        if (message.kind === 'serverRequest') {
          const index = this.recording.messages.findIndex(entry => entry.dir === 'out' && entry.kind === 'serverResponse' && entry.id === message.id);
          void this.options.onServerRequest({ id: message.id, method: message.method, params: structuredClone(message.params) } satisfies JsonRpcServerRequest)
            .then(() => { if (index >= 0) void this.deliver(this.follow(index)); });
        }
      }
    }).finally(() => { this.pending--; this.lastActivity = Date.now(); });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async request<T = unknown>(method: string, _params?: unknown): Promise<T> {
    this.lastActivity = Date.now();
    const index = this.requests.get(method)?.shift();
    if (index === undefined) {
      const last = this.lastResponse.get(method);
      if (!last) throw Object.assign(new Error(`Method not found: ${method} (not in the recording)`), { rpcError: true, rpcCode: -32601 });
      if (last.error) throw Object.assign(new Error(last.error.message), { rpcError: true, rpcCode: last.error.code });
      return structuredClone(last.result) as T;
    }
    const request = this.recording.messages[index] as Extract<RecordedMessage, { kind: 'request' }>;
    const at = this.responseAt.get(request.id);
    const response = at === undefined ? undefined : this.recording.messages[at] as Extract<RecordedMessage, { kind: 'response' }>;
    // What the CLI sent before answering arrives first, the rest after the answer.
    await this.deliver(this.follow(index, at));
    if (at !== undefined) void this.deliver(this.follow(at));
    if (!response) return await new Promise<T>(() => undefined);
    this.lastResponse.set(method, response);
    if (response.error) throw Object.assign(new Error(response.error.message), { rpcError: true, rpcCode: response.error.code });
    return structuredClone(response.result) as T;
  }

  notify(method: string): void {
    const index = this.notifications.get(method)?.shift();
    if (index !== undefined) void this.deliver(this.follow(index));
  }

  respond(): void {}
  async detach(): Promise<void> { this.isOnline = false; }
  async dispose(): Promise<void> { this.isOnline = false; }
}

export interface Replay { factory: CodexAppServerFactory; drained(release?: boolean): Promise<void>; reached(method: string): boolean }

export function replayFactory(recording: Recording): Replay {
  const clients: ReplayClient[] = [];
  return {
    factory: async options => { const client = new ReplayClient(options, recording); clients.push(client); return client; },
    drained: async (release = true) => { for (const client of clients) await client.drained(release); },
    reached: method => clients.every(client => client.reached(method)),
  };
}

/** A driver with an in-memory host, enough to run turns over the App Server without a terminal. */
export function recordingHarness(options: { factory: CodexAppServerFactory; cwd: string; executable: string; approval: string; stateDir?: string; cli?: RecordedCli }) {
  const cli = options.cli ?? 'codex';
  const id = 'recording-session';
  const project: Project = { id: 'recording-project', name: 'Project', cwd: options.cwd, createdAt: '', updatedAt: '' };
  const session: Session = {
    id, projectId: project.id, kind: 'native', title: 'Recording', tags: [], state: 'idle',
    mode: 'code', approval: options.approval, backendId: cli satisfies NativeBackendId, createdAt: '', updatedAt: '',
  };
  const profile: NativeBackendProfileConfig = { id: 'local', backendId: cli, name: cli === 'codex' ? 'Codex' : 'TRAE', config: { executable: options.executable } };
  // With a state directory the hooks run (`observation.ts`); a replay has none.
  const adapter = new CodexBackendAdapter(options.factory, RECORDED_CLIS[cli].flavor, undefined, options.stateDir ? { stateDir: options.stateDir } : {});
  const host = {
    getSession: () => session,
    getProject: () => project,
    updateSession: (_id: string, patch: Partial<Session>) => Object.assign(session, patch),
    bumpConfig: (_id: string, patch: Partial<Session>) => Object.assign(session, patch, { configRevision: (session.configRevision ?? 0) + 1 }),
    setNativeSessionId: (_id: string, nativeId: string | undefined) => { session.nativeSessionId = nativeId; return session; },
    emit: () => undefined,
    emitEvent: () => undefined,
    saveRunMetrics: () => undefined,
    findRunIdByCommand: () => undefined,
    findRunIdByNativeMessage: () => undefined,
    journal: new Journal(new DatabaseSync(':memory:')),
    stats: { recordUsage: () => undefined, observeEvents: () => undefined },
    getInteractionReceipt: () => undefined,
    saveInteractionReceipt: (_sessionId: string, _requestId: string, receipt: unknown) => receipt,
    readAttachment: async () => { throw new Error('No attachments in recordings'); },
    commitDispatchFence: () => ({}),
    isRunCancelled: () => false,
    // The TUI is not part of the App Server protocol: report it started, then gone, so each turn takes
    // the same launch path without a terminal.
    launchPty: async () => ({ id: 'recording-terminal', state: 'running' }),
    terminal: {
      get: async () => { throw new Error('Terminal not found'); }, screen: async () => undefined,
      paste: async () => undefined, sendKeys: async () => undefined, stop: async () => undefined,
      observe: () => () => undefined, subscribe: () => () => undefined, inspectPane: async () => undefined,
      withInteraction: async (_id: string, task: (control: never) => Promise<unknown>) => task({} as never),
    },
    withSessionLock: async <T>(_id: string, operation: () => Promise<T> | T) => await operation(),
  } as unknown as NativeBackendHost;

  let turn = 0;
  const send = async (text: string) => {
    turn++;
    const request = {
      session, project, profile, commandId: `command-${turn}`, runId: `run-${turn}`,
      input: { text, attachmentIds: [], context: [] },
      config: { mode: 'code', approval: options.approval },
      commitDispatchFence: () => ({}),
    } as unknown as NativeBackendSendRequest;
    await adapter.send(host, request);
  };
  let answers = 0;
  /** Answers a pending approval card with its primary action, as a person accepting it would. */
  const answer = async () => {
    const card = adapter.interaction(host, session);
    if (!card) return;
    const action = card.actions.find(item => item.tone === 'primary') ?? card.actions[0];
    if (!action) return;
    await adapter.respond(host, session, profile, { interactionId: card.id, revision: card.revision, requestId: `recording-answer-${++answers}`, action: action.id });
  };
  const until = async (done: () => boolean, timeoutMs: number, settle?: () => Promise<void>) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await settle?.();
      if (done()) return;
      if (Date.now() > deadline) throw new Error(`Gave up waiting after ${timeoutMs} ms`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const idle = async (timeoutMs: number, settle?: () => Promise<void>, options: { approve?: boolean } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await settle?.();
      if (options.approve) await answer();
      if (adapter.status(host, session).phase === 'idle') return;
      if (Date.now() > deadline) throw new Error(`The turn did not finish within ${timeoutMs} ms`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const interrupt = () => adapter.interrupt(host, session, profile);
  /** The rows the service's ingest would write, read into a journal of their own. */
  const rows = async (): Promise<JournalRow[]> => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, session.id);
    const source = adapter.transcript(host, session, profile);
    for (let pulls = 0; pulls < 20; pulls++) if ((await pullLane(source, writer, new AbortController().signal)).caughtUp) break;
    return rowsOf(journal, session.id);
  };
  return { adapter, host, session, project, profile, send, idle, until, interrupt, rows, dispose: () => adapter.dispose(host, session.id) };
}

export type RecordingHarness = ReturnType<typeof recordingHarness>;

/**
 * Runs a scenario's steps, the same way when recording (against the CLI, watching `sink`) and when
 * replaying (driven by `replay`), so the two runs take the same path.
 */
export async function runScenario(h: RecordingHarness, scenario: Scenario, mode: { replay: Replay } | { sink: RecordedMessage[] }): Promise<void> {
  const replay = 'replay' in mode ? mode.replay : undefined;
  const timeoutMs = replay ? 10_000 : 180_000;
  for (const prompt of scenario.prompts) {
    await h.send(prompt);
    if (scenario.interrupt) {
      if (replay) await h.until(() => replay.reached('turn/interrupt'), timeoutMs, () => replay.drained(false));
      else {
        const sink = (mode as { sink: RecordedMessage[] }).sink;
        await h.until(() => sink.some(message => message.dir === 'in' && message.kind === 'notification' && message.method === 'item/agentMessage/delta'), timeoutMs);
      }
      await h.interrupt();
    }
    await h.idle(timeoutMs, replay ? () => replay.drained() : undefined, { approve: scenario.approve });
  }
}

/** Generated ids: uuids, and the provider's message ids (`msg_` and hex), which change on every re-record. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bmsg_[0-9a-f]{20,}\b/gi;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
const VOLATILE_KEY = /^(at|ts|time|timestamp|duration|elapsed)$|(At|Ms|Time|Duration)$/;

/** Rows without what changes from run to run: sequence, digests, clocks and generated ids. */
export function stableRows(rows: JournalRow[]): unknown[] {
  return stable(rows.map(row => ({ kind: row.kind, nativeId: row.nativeId, rev: row.rev, ...(row.turnId ? { turnId: row.turnId } : {}), payload: row.payload }))) as unknown[];
}

/** Any value without clocks and generated ids: ids become `<id-n>` in order of appearance. */
export function stable(value: unknown): unknown {
  const ids = new Map<string, string>();
  const id = (value: string) => value.replace(UUID, match => {
    if (!ids.has(match)) ids.set(match, `<id-${ids.size + 1}>`);
    return ids.get(match)!;
  });
  const clean = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return VOLATILE_KEY.test(key) ? '<time>' : id(value).replace(ISO_TIME, '<time>');
    if (typeof value === 'number') return VOLATILE_KEY.test(key) ? '<n>' : value;
    if (Array.isArray(value)) return value.map(item => clean(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, name)]));
    return value;
  };
  return clean(value);
}
