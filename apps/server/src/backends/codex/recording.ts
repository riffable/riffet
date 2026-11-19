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
 * hang. Server requests (approvals) reach the runtime, but nothing answers them yet: scenarios that
 * need one are not recordable until the harness can respond to interactions.
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
import type { AppServerProbe } from './flavors.js';

export interface RecordingMeta {
  cli: 'codex';
  /** `codex --version`, e.g. `codex-cli 0.167.2`. */
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
  | { dir: 'out'; kind: 'serverResponse'; id: JsonRpcId; result: unknown };

export interface Recording { meta: RecordingMeta; messages: RecordedMessage[] }

/**
 * What `scripts/record.ts` drives; the replay test runs whatever recordings exist. Prompts are short
 * and deterministic so a re-recording differs only where the CLI did.
 */
export const CODEX_SCENARIOS: Record<string, { prompts: string[]; approval: string }> = {
  answer: { prompts: ['Reply with exactly the word: ready'], approval: 'on-request' },
  command: { prompts: ['Run `ls` in the current directory, then reply with the number of entries only.'], approval: 'on-request' },
  'two-turns': { prompts: ['Remember the word maple. Reply with exactly: ok', 'Which word did I ask you to remember? Reply with the word only.'], approval: 'on-request' },
};

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
  async drained(): Promise<void> {
    while (this.pending > 0) { await this.queue; await tick(); }
    if (Date.now() - this.lastActivity < STALL_MS) return;
    const first = this.recording.messages.findIndex((message, index) => message.dir === 'in' && message.kind !== 'response' && !this.delivered.has(index));
    if (first >= 0) await this.deliver(this.follow(first - 1));
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

export function replayFactory(recording: Recording): { factory: CodexAppServerFactory; drained(): Promise<void> } {
  const clients: ReplayClient[] = [];
  return {
    factory: async options => { const client = new ReplayClient(options, recording); clients.push(client); return client; },
    drained: async () => { for (const client of clients) await client.drained(); },
  };
}

/** A driver with an in-memory host, enough to run turns over the App Server without a terminal. */
export function recordingHarness(options: { factory: CodexAppServerFactory; cwd: string; executable: string; approval: string }) {
  const id = 'recording-session';
  const project: Project = { id: 'recording-project', name: 'Project', cwd: options.cwd, createdAt: '', updatedAt: '' };
  const session: Session = {
    id, projectId: project.id, kind: 'native', title: 'Recording', tags: [], state: 'idle',
    mode: 'code', approval: options.approval, backendId: 'codex' satisfies NativeBackendId, createdAt: '', updatedAt: '',
  };
  const profile: NativeBackendProfileConfig = { id: 'local', backendId: 'codex', name: 'Codex', config: { executable: options.executable } };
  const adapter = new CodexBackendAdapter(options.factory);
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
  const idle = async (timeoutMs: number, settle?: () => Promise<void>) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await settle?.();
      if (adapter.status(host, session).phase === 'idle') return;
      if (Date.now() > deadline) throw new Error(`The turn did not finish within ${timeoutMs} ms`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  /** The rows the service's ingest would write, read into a journal of their own. */
  const rows = async (): Promise<JournalRow[]> => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, session.id);
    const source = adapter.transcript(host, session, profile);
    for (let pulls = 0; pulls < 20; pulls++) if ((await pullLane(source, writer, new AbortController().signal)).caughtUp) break;
    return rowsOf(journal, session.id);
  };
  return { adapter, host, session, project, profile, send, idle, rows, dispose: () => adapter.dispose(host, session.id) };
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
const VOLATILE_KEY = /^(at|ts|time|timestamp|duration|elapsed)$|(At|Ms|Time|Duration)$/;

/** Rows without what changes from run to run: sequence, digests, clocks and generated ids. */
export function stableRows(rows: JournalRow[]): unknown[] {
  return stable(rows.map(row => ({ kind: row.kind, nativeId: row.nativeId, rev: row.rev, ...(row.turnId ? { turnId: row.turnId } : {}), payload: row.payload }))) as unknown[];
}

/** Any value without clocks and generated ids: uuids become `<id-n>` in order of appearance. */
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
