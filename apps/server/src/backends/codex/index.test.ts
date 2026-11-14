import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Journal } from '../../journal/journal.js';
import { JournalLaneWriter, pullLane } from '../../journal/ingest.js';
import { rowsOf } from '../../journal/ingest-contract.js';
import { activityOfEvent } from '../../journal/activity.js';
import type {
  NativeBackendId, NativeInteractionResponse, Project, Run, RunMetrics, Session,
} from '../../../../../packages/contracts/src/index.js';
import type { UsageRecord } from '../../stats/types.js';
import type {
  CodexAppServerClient, CodexAppServerFactory, CodexAppServerOptions, JsonRpcId, JsonRpcServerRequest,
} from '../shared/codex-app-server.js';
import { CodexAppServer, NO_SERVER_RESPONSE } from '../shared/codex-app-server.js';
import { nativeModelEffort, nativeModelFast, parseNativeModelSelection } from '../shared/model-selection.js';
import { resolveCliExecutable } from '../shared/cli-resolve.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeBackendSendRequest, NativeControlMessage, NativeDispatchBinding } from '../types.js';
import type { NativeRuntimeHook, RuntimeContext } from '@riffet/plugin-api';
import { CodexBackendAdapter } from './index.js';
import type { CodexSessionRuntime } from './runtime.js';
import { CodexSubagents } from './subagents.js';
import type { RpcTurn } from './types.js';
import * as codexConfig from './config.js';
import { codexFlavor, traexFlavor, type CodexFlavor } from './flavors.js';

// The injected app-server does not expose a real TUI, but speaks the verified steer protocol.

/** Opens the conversation's runtime and reads its thread once, as the service's watch does when a reader attaches. */
async function prime(h: { adapter: CodexBackendAdapter; host: NativeBackendHost; session: Session; profile: NativeBackendProfileConfig }): Promise<{ status: ReturnType<CodexBackendAdapter['status']> }> {
  const project = h.host.getProject(h.session.projectId);
  const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<{ prime(): Promise<void> }> }).ensureRuntime(h.host, h.session, project, h.profile);
  await runtime.prime();
  return { status: h.adapter.status(h.host, h.session) };
}

const fakeProbe = { version: 'codex-cli 0.160.0', appServer: false, unixSocket: false, wsAuth: false, remoteUnix: false, remoteWs: false, noAltScreen: false };
beforeEach(() => { vi.spyOn(codexConfig, 'probeAppServer').mockResolvedValue(fakeProbe); });
afterEach(() => { vi.restoreAllMocks(); });

interface FakeAppServerState {
  nativeSettingsProtocol?: boolean;
  ignoreNativeSettings?: boolean;
  turnSequence: number;
  turns: Array<Record<string, unknown>>;
  turnsListError: string;
  turnsListAvailable: boolean;
  threadStatus: 'idle' | 'active' | 'systemError';
  legacyTurnsError?: string;
  subagentThreads: Map<string, { turns: Array<Record<string, unknown>>; model?: string | null; name?: string | null; agentNickname?: string; agentRole?: string }>;
  requestParams: Array<{ method: string; params: Record<string, unknown> }>;
  models: Array<Record<string, unknown>>;
  mcpServers?: string[];
  loadedThreads: Set<string>;
  requestGates: Map<string, { entered: () => void; wait: Promise<void> }>;
  resumeInFlight: number;
  resumeError?: string;
  startError?: string;
  resumeThreadId?: string;
  startThreadId?: string;
  threadSettings?: Record<string, unknown>;
  /** null represents a legacy empty settings-update reply, rather than a current reply with settings. */
  settingsUpdateResponse?: Record<string, unknown> | null;
  modeChangeError?: Error;
  /** TRAE CLI acknowledges a steer with `{ turnId }`, Codex with `{ turn: { id } }`. */
  steerAck?: 'turn' | 'turnId';
  steerError?: string;
  rateLimits?: Record<string, unknown>;
  internalUsage?: Record<string, unknown>;
  contextUsage?: unknown;
  skills?: Array<Record<string, unknown>>;
  reviewTurnId?: string;
  /** Serve `thread/turns/list` with real paging (limit, cursor, direction, itemsView), as the app-server does. */
  pagedTurns?: boolean;
  /** Fail the nth ascending page read once, to interrupt a background import. */
  failAscPage?: number;
  ascPages?: number;
  /** Background terminals the app-server lists; undefined means the method does not exist. */
  terminals?: Array<{ processId: string; itemId: string; command: string; cwd: string }>;
  /** What a stop answers: Codex says `terminated`, TRAE CLI an `outcome`; `survives` leaves the process listed. */
  terminalStop?: { terminated?: boolean; outcome?: string; survives?: boolean };
}

function makeFakeAppServerState(): FakeAppServerState {
  return {
    turnSequence: 0, turns: [], turnsListError: 'list_turns is not supported yet', turnsListAvailable: false, threadStatus: 'idle',
    subagentThreads: new Map(), requestParams: [], models: [], loadedThreads: new Set(), requestGates: new Map(), resumeInFlight: 0,
  };
}

class FakeAppServer implements CodexAppServerClient {
  readonly responses = new Map<string, unknown>();
  serverUserAgent: string | undefined = 'riffet/0.210.1 (isolated protocol fixture)';
  isOnline = true;
  disposed = false;
  detached = false;
  private requestToRaise: JsonRpcServerRequest | undefined;
  private deferResolvedNotification = false;
  constructor(
    private readonly options: CodexAppServerOptions,
    readonly threadId = 'native-thread',
    readonly remoteAddress = 'unix:///fake-codex.sock',
    private readonly state: FakeAppServerState = makeFakeAppServerState(),
  ) {}
  legacyThreadReads = 0;
  /** Recorded protocol requests, in call order. */
  get requestParams(): Array<{ method: string; params: Record<string, unknown> }> { return this.state.requestParams; }

  queueServerRequest(request: JsonRpcServerRequest): void {
    this.requestToRaise = request;
  }

  setModels(models: Array<Record<string, unknown>>): void { this.state.models = models; }
  setMcpServers(names: string[]): void { this.state.mcpServers = names; }
  setThreadSettings(settings: Record<string, unknown>): void { this.state.threadSettings = settings; }
  enableNativeSettings(ignore = false): void {
    this.state.nativeSettingsProtocol = true;
    this.state.ignoreNativeSettings = ignore;
    this.state.threadSettings = { model: 'gpt-5-codex', cwd: this.options.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      reasoningEffort: 'medium', serviceTier: null, activePermissionProfile: null };
  }
  setSettingsUpdateResponse(settings: Record<string, unknown> | null): void { this.state.settingsUpdateResponse = settings; }
  setModeChangeError(error: Error | undefined): void { this.state.modeChangeError = error; }
  setSkills(skills: Array<Record<string, unknown>> | undefined): void { this.state.skills = skills; }
  setReviewTurnId(turnId: string): void { this.state.reviewTurnId = turnId; }
  setResumeError(message: string | undefined): void { this.state.resumeError = message; }
  setLoadedThreads(threads: string[]): void { this.state.loadedThreads = new Set(threads); }
  lastParams(method: string): Record<string, unknown> | undefined {
    return [...this.requestParams].reverse().find(entry => entry.method === method)?.params;
  }

  deferResolved(): void { this.deferResolvedNotification = true; }
  setTurns(turns: Array<Record<string, unknown>>): void { this.state.turns = turns; }
  setTurnsListAvailable(available: boolean): void { this.state.turnsListAvailable = available; }
  setPagedTurns(failAscPage?: number): void { this.state.turnsListAvailable = true; this.state.pagedTurns = true; this.state.failAscPage = failAscPage; this.state.ascPages = 0; }
  setThreadStatus(status: 'idle' | 'active' | 'systemError'): void { this.state.threadStatus = status; }
  setTurnsListError(message: string): void { this.state.turnsListError = message; }
  setSteerAck(shape: 'turn' | 'turnId'): void { this.state.steerAck = shape; }
  setSteerError(message: string | undefined): void { this.state.steerError = message; }
  setContextUsage(usage: unknown): void { this.state.contextUsage = usage; }
  setRateLimits(limits: Record<string, unknown> | undefined): void { this.state.rateLimits = limits; }
  setInternalUsage(usage: Record<string, unknown> | undefined): void { this.state.internalUsage = usage; }
  setLegacyTurnsError(message: string | undefined): void { this.state.legacyTurnsError = message; }
  setTerminals(terminals: FakeAppServerState['terminals'], stop?: FakeAppServerState['terminalStop']): void { this.state.terminals = terminals; this.state.terminalStop = stop; }
  setSubagentThread(threadId: string, thread: { turns: Array<Record<string, unknown>>; model?: string | null; name?: string | null; agentNickname?: string; agentRole?: string }): void { this.state.subagentThreads.set(threadId, thread); }
  emitNativeNotification(method: string, params: Record<string, unknown>): void { this.options.onNotification(method, params); }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const args = params as Record<string, unknown> | undefined;
    let result: unknown;
    let ownsResumeSlot = false;
    try {
      if (method === 'thread/resume') {
        this.requestParams.push({ method, params: args ?? {} });
        if (this.state.resumeInFlight > 0) throw new Error('thread already has an active writer');
        this.state.resumeInFlight += 1;
        ownsResumeSlot = true;
        const gate = this.state.requestGates.get(method);
        if (gate) {
          this.state.requestGates.delete(method);
          gate.entered();
          await gate.wait;
        }
      }
      if (method === 'thread/start' || method === 'thread/resume') {
        if (method === 'thread/start') this.requestParams.push({ method, params: args ?? {} });
        if (method === 'thread/start' && this.state.startError) throw new Error(this.state.startError);
        if (method === 'thread/resume' && this.state.resumeError) throw new Error(this.state.resumeError);
        const threadId = method === 'thread/resume'
          ? this.state.resumeThreadId ?? String(args?.threadId ?? this.threadId)
          : this.state.startThreadId ?? this.threadId;
        this.state.loadedThreads.add(threadId);
        result = { ...this.state.threadSettings, thread: { id: threadId, status: { type: this.state.threadStatus }, name: 'Protocol smoke' } };
      } else if (method === 'model/list') {
        result = { data: this.state.models, nextCursor: null };
      } else if (method === 'config/read') {
        result = { config: { mcp_servers: Object.fromEntries((this.state.mcpServers ?? []).map(name => [name, { command: 'x' }])) } };
      } else if (method === 'skills/list') {
        if (!this.state.skills) throw new Error('Unexpected fake app-server method: skills/list');
        result = { data: [{ cwd: (args?.cwds as string[] | undefined)?.[0] ?? '', skills: this.state.skills, errors: [] }] };
      } else if (method === 'thread/loaded/list') {
        this.requestParams.push({ method, params: args ?? {} });
        result = { data: [...this.state.loadedThreads], nextCursor: null };
      } else if (method === 'thread/turns/list') {
        this.requestParams.push({ method, params: args ?? {} });
        const turns = this.state.subagentThreads.get(String(args?.threadId))?.turns ?? this.state.turns;
        if (this.state.pagedTurns) {
          const ordered = args?.sortDirection === 'asc' ? [...turns] : [...turns].reverse();
          if (args?.sortDirection === 'asc' && args.itemsView === 'full') {
            this.state.ascPages = (this.state.ascPages ?? 0) + 1;
            if (this.state.ascPages === this.state.failAscPage) { this.state.failAscPage = undefined; throw new Error('app-server interrupted'); }
          }
          const start = args?.cursor ? Number(args.cursor) : 0;
          const limit = Number(args?.limit ?? 100);
          const data = ordered.slice(start, start + limit).map(turn => args?.itemsView === 'notLoaded' ? { ...turn, items: [] } : turn);
          result = { data, nextCursor: start + limit < ordered.length ? String(start + limit) : null };
        } else if (this.state.turnsListAvailable) result = { data: [...turns].reverse(), nextCursor: null };
        else throw new Error(this.state.turnsListError);
      } else if (method === 'thread/read') {
        const subagent = this.state.subagentThreads.get(String(args?.threadId));
        if (args?.includeTurns === true) {
          this.legacyThreadReads += 1;
          if (this.state.legacyTurnsError) throw new Error(this.state.legacyTurnsError);
          result = { thread: { id: String(args.threadId), status: { type: this.state.threadStatus },
            model: subagent ? subagent.model : this.state.threadSettings?.model, turns: subagent?.turns ?? this.state.turns } };
        } else {
          result = { thread: {
            id: String(args?.threadId), status: { type: this.state.threadStatus }, model: this.state.threadSettings?.model,
            ...(subagent ? {
              model: subagent.model, name: subagent.name, agentNickname: subagent.agentNickname, agentRole: subagent.agentRole,
            } : {}),
          } };
        }
      } else if (method === 'thread/compact/start' || method === 'review/start') {
        this.requestParams.push({ method, params: args ?? {} });
        result = method === 'review/start'
          ? { turn: { id: this.state.reviewTurnId ?? 'review-turn' }, reviewThreadId: String(args?.threadId ?? this.threadId) }
          : {};
      } else if (method === 'turn/start') {
        this.requestParams.push({ method, params: args ?? {} });
        this.state.turnSequence += 1;
        const turnId = `turn-${this.state.turnSequence}`;
        this.options.onNotification('turn/started', { threadId: String(args?.threadId ?? this.threadId), turn: { id: turnId } });
        const request = this.requestToRaise;
        this.requestToRaise = undefined;
        if (request) queueMicrotask(() => this.resolveNativeRequest(request));
        result = { turn: { id: turnId } };
      } else if (method === 'turn/steer') {
        this.requestParams.push({ method, params: args ?? {} });
        if (this.state.steerError) throw Object.assign(new Error(this.state.steerError), { rpcError: true, rpcCode: -32600 });
        const turnId = String(args?.expectedTurnId ?? `turn-${this.state.turnSequence}`);
        result = this.state.steerAck === 'turnId' ? { turnId } : { turn: { id: turnId } };
      } else if (method === 'account/rateLimits/read') {
        if (!this.state.rateLimits) throw new Error('browser account authentication required to read rate limits');
        result = this.state.rateLimits;
      } else if (method === 'model/internalUsage/read') {
        if (!this.state.internalUsage) throw new Error('failed to fetch Trae internal usage');
        result = this.state.internalUsage;
      } else if (method === 'thread/contextUsage') {
        if (this.state.contextUsage === undefined) throw new Error('Unexpected fake app-server method: thread/contextUsage');
        result = { contextWindowUsage: this.state.contextUsage };
      } else if (method === 'thread/backgroundTerminals/list') {
        this.requestParams.push({ method, params: args ?? {} });
        if (!this.state.terminals) throw new Error('method not found');
        // TRAE CLI lists bare ids, Codex whole entries.
        result = this.options.executable.includes('trae') || this.state.terminalStop?.outcome
          ? { processIds: this.state.terminals.map(item => item.processId) } : { data: this.state.terminals, nextCursor: null };
      } else if (method === 'thread/backgroundTerminals/terminate' || method === 'thread/backgroundTerminals/stop') {
        this.requestParams.push({ method, params: args ?? {} });
        const stop = this.state.terminalStop ?? {};
        if (!stop.survives) this.state.terminals = (this.state.terminals ?? []).filter(item => item.processId !== args?.processId);
        result = stop.outcome ? { outcome: stop.outcome } : { terminated: stop.terminated ?? true };
      } else if (method === 'turn/interrupt' || method === 'thread/name/set' || method === 'thread/settings/update' || method === 'mode/change/respond') {
        this.requestParams.push({ method, params: args ?? {} });
        if (method === 'thread/settings/update' && this.state.nativeSettingsProtocol) {
          if (!this.state.ignoreNativeSettings) {
            const current = this.state.threadSettings ?? {};
            this.state.threadSettings = { ...current, ...Object.fromEntries(['model', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'serviceTier'].filter(key => args && key in args).map(key => [key, args![key]])),
              ...(args?.sandboxPolicy ? { sandbox: args.sandboxPolicy, activePermissionProfile: null } : {}),
              ...(args?.effort ? { reasoningEffort: args.effort } : {}),
            };
            this.options.onNotification('thread/settings/updated', { threadId: this.threadId, threadSettings: { ...this.state.threadSettings, sandboxPolicy: this.state.threadSettings.sandbox, effort: this.state.threadSettings.reasoningEffort } });
          }
          result = {}; // Real Codex acknowledges before dependent callers verify the effective settings.
        } else result = method === 'thread/settings/update' && this.state.settingsUpdateResponse !== null
          ? { threadSettings: this.state.settingsUpdateResponse ?? null } : {};
      } else if (method === 'initialize') {
        result = {};
      } else {
        throw new Error(`Unexpected fake app-server method: ${method}`);
      }
      if (method !== 'thread/resume') {
        const key = this.state.requestGates.has(`${method}:${args?.threadId}`) ? `${method}:${args?.threadId}` : method;
        const gate = this.state.requestGates.get(key);
        if (gate) {
          this.state.requestGates.delete(key);
          gate.entered();
          await gate.wait;
        }
      }
      if (method === 'mode/change/respond' && this.state.modeChangeError) throw this.state.modeChangeError;
      // A request the socket died under is never answered on it, even when it reached the server.
      if (!this.isOnline) throw Object.assign(new Error('Codex app-server connection closed'), { code: 'EPIPE' });
      return result as T;
    } finally {
      if (ownsResumeSlot) this.state.resumeInFlight -= 1;
    }
  }

  notify(): void {}
  respond(id: JsonRpcId, result: unknown): void { this.responses.set(String(id), result); }
  async dispose(): Promise<void> { this.isOnline = false; this.disposed = true; }
  async detach(): Promise<void> { this.isOnline = false; this.detached = true; }
  disconnect(): void { this.isOnline = false; this.options.onExit(new Error('Native transport disconnected')); }

  resolveNativeRequest(request: JsonRpcServerRequest): Promise<void> {
    return this.options.onServerRequest(request).then(result => {
      if (result !== NO_SERVER_RESPONSE) this.responses.set(String(request.id), result);
      if (!this.deferResolvedNotification) this.notifyResolved(request.id, typeof request.params.threadId === 'string' ? request.params.threadId : 'native-thread');
    });
  }

  notifyResolved(requestId: JsonRpcId, threadId = 'native-thread'): void {
    this.options.onNotification('serverRequest/resolved', { threadId, requestId });
    this.deferResolvedNotification = false;
  }

  finishTurn(turnId: string, status: 'completed' | 'failed' | 'interrupted' = 'interrupted', extra: Record<string, unknown> = {}): void {
    this.options.onNotification('turn/completed', { threadId: 'native-thread', turn: { id: turnId, status, ...extra } });
  }
}

function makeHarness(harnessOptions: { threadId?: string; configDir?: string; terminalEndpoint?: string; resumeError?: string; startError?: string; resumeThreadId?: string; startThreadId?: string; flavor?: CodexFlavor; runtimeHooks?: ConstructorParameters<typeof CodexBackendAdapter>[2]; models?: Array<Record<string, unknown>>; internalUsage?: Record<string, unknown>; onTransport?: (transport: FakeAppServer, options: CodexAppServerOptions) => void } = {}) {
  const harnessThreadId = harnessOptions.threadId ?? 'native-thread';
  const harnessConfigDir = harnessOptions.configDir;
  const id = `smoke-${Math.random().toString(36).slice(2)}`;
  const project: Project = { id: `project-${id}`, name: 'Project', cwd: `/tmp/codex-protocol-${id}`, createdAt: '', updatedAt: '' };
  const session: Session = {
    id, projectId: project.id, kind: 'native', title: 'Protocol smoke', tags: [], state: 'idle',
    mode: 'code', approval: 'on-request', backendId: (harnessOptions.flavor?.id ?? 'codex') satisfies NativeBackendId, createdAt: '', updatedAt: '',
  };
  const threadId = harnessThreadId;
  const profile: NativeBackendProfileConfig = { id: 'local', backendId: harnessOptions.flavor?.id ?? 'codex', name: 'Codex', config: { executable: '/codex-protocol-smoke-missing-cli', ...(harnessConfigDir ? { configDir: harnessConfigDir } : {}) } };
  let transport: FakeAppServer | undefined;
  let terminalEndpoint = harnessOptions.terminalEndpoint;
  /** What the pane of a TUI attached to `address` shows the lookup. */
  const paneFor = (address: string) => [{ pid: 1, argv: ['codex', '--remote', address, '--cd', project.cwd, 'resume', threadId] }];
  let terminalState: 'missing' | 'running' | 'starting' | 'exited' = terminalEndpoint ? 'running' : 'missing';
  if (terminalEndpoint) session.terminalId = 'terminal-associated';
  const factoryCalls: CodexAppServerOptions[] = [];
  const factoryErrors: Error[] = [];
  const factoryGates: Array<{ entered: (options: CodexAppServerOptions) => void; wait: Promise<void> }> = [];
  const endpointStates = new Map<string, FakeAppServerState>();
  let localEndpointSequence = 0;
  const interactionReceipts = new Map<string, import('../types.js').NativeInteractionReceipt>();
  const factory: CodexAppServerFactory = async serverOptions => {
    factoryCalls.push(serverOptions);
    const gate = factoryGates.shift();
    if (gate) {
      gate.entered(serverOptions);
      await gate.wait;
    }
    const error = factoryErrors.shift();
    if (error) throw error;
    const address = serverOptions.remoteAddress ?? (serverOptions.listen === 'ws'
      ? `ws://127.0.0.1:${40000 + ++localEndpointSequence}`
      : `unix:///fake-codex-${++localEndpointSequence}.sock`);
    let state = endpointStates.get(address);
    if (!state) {
      state = makeFakeAppServerState();
      state.models = harnessOptions.models ?? [];
      state.internalUsage = harnessOptions.internalUsage;
      state.resumeError = harnessOptions.resumeError;
      state.startError = harnessOptions.startError;
      state.resumeThreadId = harnessOptions.resumeThreadId;
      state.startThreadId = harnessOptions.startThreadId;
      endpointStates.set(address, state);
    }
    transport = new FakeAppServer(serverOptions, threadId, address, state);
    if (serverOptions.listen === 'ws') Object.defineProperty(transport, 'authToken', { value: 'fake-test-token' });
    harnessOptions.onTransport?.(transport, serverOptions);
    return transport;
  };
  const adapter = new CodexBackendAdapter(factory, harnessOptions.flavor, harnessOptions.runtimeHooks);
  const dispatchFences: Array<{ baselineSequence?: number }> = [];
  const savedMetrics: Array<{ runId: string; metrics: RunMetrics }> = [];
  const usage: Array<{ sessionId: string; runId: string | undefined; usage: UsageRecord }> = [];
  const host = {
    getSession: () => session,
    getProject: () => project,
    updateSession: (_id: string, patch: Partial<Session>) => Object.assign(session, patch),
    bumpConfig: vi.fn((_id: string, patch: Partial<Session>) => Object.assign(session, patch, { configRevision: (session.configRevision ?? 0) + 1 })),
    setNativeSessionId: (_id: string, id: string | undefined) => {
      session.nativeSessionId = id;
      session.cursorSessionId = id;
      return session;
    },
    emit: () => undefined,
    emitEvent: () => undefined,
    saveRunMetrics: (runId: string, metrics: RunMetrics) => { savedMetrics.push({ runId, metrics }); },
    findRunIdByCommand: () => undefined,
    findRunIdByNativeMessage: () => undefined,
    journal: new Journal(new DatabaseSync(':memory:')),
    stats: {
      recordUsage: (sessionId: string, runId: string | undefined, record: UsageRecord) => { usage.push({ sessionId, runId, usage: record }); },
      observeEvents: () => undefined,
    },
    getInteractionReceipt: (_sessionId: string, requestId: string) => interactionReceipts.get(requestId),
    saveInteractionReceipt: (_sessionId: string, requestId: string, receipt: import('../types.js').NativeInteractionReceipt) => {
      interactionReceipts.set(requestId, receipt);
      return receipt;
    },
    readAttachment: async () => { throw new Error('No attachments in this test'); },
    commitDispatchFence: (_runId: string, binding?: NativeDispatchBinding) => { if (binding) dispatchFences.push({ baselineSequence: binding.baselineSequence }); return {}; },
    isRunCancelled: () => false,
    launchPty: async () => { throw new Error('The fake CLI should not launch a TUI'); },
    terminal: {
      get: async (terminalId: string) => {
        if (terminalId !== session.terminalId || terminalState === 'missing') throw new Error('Terminal not found');
        return { id: terminalId, state: terminalState };
      }, screen: async () => undefined,
      paste: async () => undefined, sendKeys: async () => undefined, stop: async () => undefined,
      observe: () => () => undefined, subscribe: () => () => undefined,
      inspectPane: async (terminalId: string, _sessionId: string, options: { select: (argv: string[], marker: string | undefined) => boolean }) => {
        if (terminalState !== 'running' || terminalId !== session.terminalId) return undefined;
        return (terminalEndpoint ? paneFor(terminalEndpoint) : []).filter(item => options.select(item.argv, undefined));
      },
      withInteraction: async (_id: string, task: (control: never) => Promise<unknown>) => task({} as never),
    },
    withSessionLock: async <T>(_id: string, operation: () => Promise<T> | T) => await operation(),
  } as unknown as NativeBackendHost;
  const send = async (commandId: string, model = 'gpt-5-codex', approval = 'on-request', text = 'Inspect this project', mode = 'code') => {
    const request = {
      session, project, profile, commandId, runId: `run-${commandId}`,
      input: { text, attachmentIds: [], context: [] },
      config: { model, mode, approval },
      commitDispatchFence: (binding?: NativeDispatchBinding) => { dispatchFences.push({ baselineSequence: binding?.baselineSequence }); return {}; },
    } as unknown as NativeBackendSendRequest;
    await adapter.send(host, request);
  };
  const registerEndpoint = (address: string) => {
    let state = endpointStates.get(address);
    if (!state) {
      state = makeFakeAppServerState();
      state.resumeError = harnessOptions.resumeError;
      state.startError = harnessOptions.startError;
      state.resumeThreadId = harnessOptions.resumeThreadId;
      state.startThreadId = harnessOptions.startThreadId;
      endpointStates.set(address, state);
    }
    const noopOptions: CodexAppServerOptions = {
      executable: 'codex', cwd: project.cwd,
      onNotification: () => undefined, onServerRequest: async () => NO_SERVER_RESPONSE, onExit: () => undefined,
    };
    return new FakeAppServer(noopOptions, threadId, address, state);
  };
  const setTerminalEndpoint = (address: string | undefined) => {
    terminalEndpoint = address;
    terminalState = 'running';
    session.terminalId = 'terminal-associated';
  };
  const deferNextFactory = () => {
    let announce: (options: CodexAppServerOptions) => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<CodexAppServerOptions>(resolve => { announce = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    factoryGates.push({ entered: announce, wait });
    return { entered, release };
  };
  const deferEndpointRequest = (address: string, method: string) => {
    const state = endpointStates.get(address);
    if (!state) throw new Error(`No fake Codex endpoint registered at ${address}`);
    let announce: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    state.requestGates.set(method, { entered: announce, wait });
    return { entered, release };
  };
  return { adapter, host, project, session, profile, send, paneFor, dispatchFences, savedMetrics, usage, factory, factoryCalls, factoryErrors, registerEndpoint, setTerminalEndpoint, deferNextFactory, deferEndpointRequest, getReceipt: (id: string) => interactionReceipts.get(id), get transport() { return transport; } };
}

function makeBinding(h: ReturnType<typeof makeHarness>, address: string, profile = h.profile): NonNullable<Session['nativeRuntime']> {
  const configuredExecutable = typeof profile.config.executable === 'string' ? profile.config.executable : 'codex';
  const executable = resolveCliExecutable({ command: configuredExecutable }).executable;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([h.project.cwd, profile.id, executable, JSON.stringify(profile.config)]))
    .digest('hex');
  return { address, fingerprint };
}


async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for fake Codex protocol event');
}

/** Hooks as the registry serves them, each under the id of the plugin that provides it. */
function hooksOf(owner: string, ...hooks: NativeRuntimeHook[]): ConstructorParameters<typeof CodexBackendAdapter>[2] {
  return { runtimeHooks: backendId => hooks.filter(hook => hook.backendId === backendId).map(hook => ({ owner: owner as `${string}.${string}`, hook })) };
}

describe('native runtime attachments', () => {
  it('keeps one native writer across sidecar actions and recovers its attachment, saved under either field, after a restart', async () => {
    let onChange: (() => void) | undefined;
    let route = 'direct';
    const route_ = {
      id: 'isolated-route', launchEnv: { TRAE_API_BASE_URL: 'http://127.0.0.1:12345/private-capability' },
      control: vi.fn(({ model }: { model?: string }) => ({
        revision: route, notice: { tone: 'neutral' as const, label: { en: route } },
        actions: model === 'gpt-5.6-luna' ? [{ id: 'switch', label: { en: 'Switch' } }] : [],
      })),
      act: vi.fn(async (_input: { action: string; revision: string; model?: string }) => { route = 'relayed'; onChange?.(); }),
      bindNative: vi.fn(async () => undefined), detach: vi.fn(), stop: vi.fn(async () => undefined),
    };
    const hook = {
      backendId: 'traex' as const,
      prepare: vi.fn(async (context: RuntimeContext) => { onChange = context.onChange; return route_; }),
      recover: vi.fn(async (context: RuntimeContext) => { onChange = context.onChange; return route_; }),
    };
    const hooks = hooksOf('acme.route', hook);
    const h = makeHarness({ flavor: traexFlavor, runtimeHooks: hooks, configDir: '/tmp/riffet-runtime-hook-protocol-smoke' });
    h.session.model = 'gpt-5.6-luna';
    let restarted: CodexBackendAdapter | undefined;
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      expect(hook.prepare).toHaveBeenCalledWith(expect.objectContaining({ sessionId: h.session.id, profileConfig: h.profile.config }));
      expect(h.factoryCalls[0]!.env?.TRAE_API_BASE_URL).toBe(route_.launchEnv.TRAE_API_BASE_URL);
      expect(h.session.nativeRuntime).toMatchObject({ attachment: { hook: 'acme.route', id: route_.id } });
      expect(h.adapter.status(h.host, h.session).runtimeControl).toMatchObject({ owner: 'acme.route', revision: 'direct', actions: [{ id: 'switch' }] });
      const requestsBefore = h.transport!.requestParams.length;
      await h.adapter.runtimeAction(h.host, h.session, h.profile, { action: 'switch', revision: 'direct' });
      expect(route_.act).toHaveBeenCalledWith({ action: 'switch', revision: 'direct', model: 'gpt-5.6-luna' });
      expect(h.transport!.requestParams.slice(requestsBefore).some(item => item.method === 'turn/start' || item.method === 'turn/interrupt')).toBe(false);
      expect(h.adapter.status(h.host, h.session).runtimeControl?.revision).toBe('relayed');
      const owner = h.transport;
      const address = h.session.nativeRuntime!.address;
      await h.adapter.close(h.host);
      expect(route_.detach).toHaveBeenCalledOnce();
      expect(route_.stop).not.toHaveBeenCalled();
      expect(owner!.disposed).toBe(false);
      restarted = new CodexBackendAdapter(h.factory, traexFlavor, hooks);
      // A read-only subscription can adopt the loaded owner before any explicit open.
      const unsubscribe = restarted.subscribe(h.host, h.session, h.profile, () => undefined);
      await waitFor(() => restarted!.status(h.host, h.session).connection?.state === 'connected' ? true : undefined);
      unsubscribe();
      expect(hook.prepare).toHaveBeenCalledOnce();
      expect(hook.recover).toHaveBeenCalledWith(expect.objectContaining({ id: route_.id, address }));
      expect(h.session.nativeRuntime).toMatchObject({ attachment: { hook: 'acme.route', id: route_.id } });
      expect(restarted.status(h.host, h.session).runtimeControl?.revision).toBe('relayed');
      await restarted.dispose(h.host, h.session.id);
      expect(route_.stop).toHaveBeenCalledOnce();
    } finally { await h.adapter.close(h.host); await restarted?.close(h.host); }
  });

  it('starts TRAE CLI as launched and never reports a runtime control without a hook', async () => {
    const h = makeHarness({ flavor: traexFlavor });
    const messages: NativeControlMessage[] = [];
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, message => messages.push(message));
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      expect(h.factoryCalls[0]!.env?.TRAE_API_BASE_URL).toBeUndefined();
      expect(h.session.nativeRuntime).toEqual({ address: h.transport!.remoteAddress, fingerprint: expect.any(String), scopeFingerprint: expect.any(String), profileId: h.profile.id });
      expect(h.adapter.status(h.host, h.session).runtimeControl).toBeUndefined();
      expect(messages.some(message => message.type === 'status' && message.status.runtimeControl)).toBe(false);
      await expect(h.adapter.runtimeAction(h.host, h.session, h.profile, { action: 'switch', revision: '' })).rejects.toMatchObject({ code: 'RUNTIME_CONTROL_UNAVAILABLE' });
    } finally { unsubscribe(); await h.adapter.close(h.host); }
  });

  it('does not claim or create an attachment for a previously running direct native endpoint', async () => {
    const hook = { backendId: 'traex' as const, prepare: vi.fn(), recover: vi.fn() };
    const h = makeHarness({ flavor: traexFlavor, runtimeHooks: hooksOf('acme.route', hook) });
    h.session.nativeSessionId = 'native-thread';
    const owner = h.registerEndpoint('unix:///existing-direct-native');
    owner.setThreadStatus('active');
    h.session.nativeRuntime = { address: owner.remoteAddress, fingerprint: codexConfig.runtimeFingerprintFor(h.project, h.profile, traexFlavor) };
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      expect(hook.prepare).not.toHaveBeenCalled();
      expect(hook.recover).not.toHaveBeenCalled();
      expect(h.adapter.status(h.host, h.session).runtimeControl).toBeUndefined();
      await expect(h.adapter.runtimeAction(h.host, h.session, h.profile, { action: 'switch', revision: '' })).rejects.toMatchObject({ code: 'RUNTIME_CONTROL_UNAVAILABLE' });
      expect(owner.disposed).toBe(false);
    } finally { await h.adapter.close(h.host); }
  });
});

describe('generic attachments', () => {
  it.each([['Codex', undefined], ['TRAE', traexFlavor]] as const)('%s receives an archive with its original filename and exact bytes', async (_name, flavor) => {
    const h = makeHarness({ flavor });
    const id = randomUUID();
    const data = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');
    const storage = await mkdtemp(join(tmpdir(), 'riffet-archive-'));
    const original = join(storage, `${id}.bin`);
    await writeFile(original, data);
    h.host.readAttachment = async () => ({ attachment: { id, name: '项目 资料.zip', mimeType: 'application/zip', size: data.length, path: original }, data });
    let target: string | undefined;
    try {
      await h.adapter.send(h.host, {
        session: h.session, project: h.project, profile: h.profile, commandId: 'archive', runId: 'run-archive',
        input: { text: 'Inspect the archive', attachmentIds: [id], context: [] }, config: { mode: 'code' },
        commitDispatchFence: binding => h.host.commitDispatchFence('run-archive', binding),
      });
      const parts = h.transport!.requestParams.find(entry => entry.method === 'turn/start')!.params.input as Array<{ type: string; text?: string }>;
      expect(parts.some(part => part.type === 'localImage')).toBe(false);
      target = parts.find(part => part.type === 'text')!.text!.split('\n').find(line => line.startsWith('@'))!.slice(1);
      expect(basename(target)).toBe('项目 资料.zip');
      expect(target).toBe(join(storage, 'materialized', id, '项目 资料.zip'));
      expect(await readFile(target)).toEqual(data);
      expect(await readFile(original)).toEqual(data);
    } finally {
      await h.adapter.close(h.host);
      await rm(storage, { recursive: true, force: true });
    }
  });
});

describe('Codex thread goals', () => {
  it('keeps the session goal equal to the thread goal the app-server reports', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const goal = { threadId: 'native-thread', objective: 'Make the parser tests pass', status: 'budgetLimited', tokensUsed: 120_000, timeUsedSeconds: 900, tokenBudget: 100_000, createdAt: 1_793_000_000, updatedAt: 1_793_000_900 };
    h.transport!.emitNativeNotification('thread/goal/updated', { threadId: 'native-thread', turnId: null, goal });
    expect(h.session.goal).toEqual({ objective: 'Make the parser tests pass', status: 'budget_limited', tokensUsed: 120_000, tokenBudget: 100_000, seconds: 900, updatedAt: new Date(1_793_000_900_000).toISOString() });
    h.transport!.emitNativeNotification('thread/goal/updated', { threadId: 'native-thread', goal: { ...goal, status: 'complete' } });
    expect(h.session.goal?.status).toBe('complete');
    // A finished goal steps aside at the next message the user sends.
    h.transport!.emitNativeNotification('item/started', { threadId: 'native-thread', turnId: 'turn-next', item: { type: 'userMessage', id: 'user-next', content: [] } });
    expect(h.session.goal).toBeUndefined();
    h.transport!.emitNativeNotification('thread/goal/updated', { threadId: 'native-thread', goal: { ...goal, status: 'active' } });
    h.transport!.emitNativeNotification('thread/goal/cleared', { threadId: 'native-thread' });
    expect(h.session.goal).toBeUndefined();
    await h.adapter.dispose(h.host, h.session.id);
  });
});

describe('Codex thread names', () => {
  it('upgrades the first-message title to the thread name once, then keeps it', async () => {
    const h = makeHarness();
    Object.assign(h.session, { title: '这个仓库最近在做什么', titleSource: 'prompt' });
    h.host.firstUserMessage = () => '这个仓库最近在做什么';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.emitNativeNotification('thread/name/updated', { threadId: 'native-thread', name: '查看仓库近期动态' });
    expect(h.session).toMatchObject({ title: '查看仓库近期动态', titleSource: 'generated' });
    h.transport!.emitNativeNotification('thread/name/updated', { threadId: 'native-thread', name: '仓库动态' });
    expect(h.session.title).toBe('查看仓库近期动态');
    expect(h.transport!.lastParams('thread/name/set')).toEqual({ threadId: 'native-thread', name: '查看仓库近期动态' });
  });

  it.each([codexFlavor, traexFlavor])('$label waits for a summary after a first-message fallback without echoing it back', async flavor => {
    const h = makeHarness({ flavor });
    const prompt = '话说，riffet 对 cursor 的支持是不是存在比较大的问题，比如这个subagent没能识别出来';
    h.host.firstUserMessage = () => prompt;
    Object.assign(h.session, { title: `${prompt.slice(0, 48)}…`, titleSource: 'prompt' });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);

    h.transport!.emitNativeNotification('thread/name/updated', { threadId: 'native-thread', name: prompt.slice(0, 36) });
    expect(h.session.titleSource).toBe('prompt');
    expect(h.transport!.lastParams('thread/name/set')).toBeUndefined();

    h.transport!.emitNativeNotification('thread/name/updated', { threadId: 'native-thread', name: '排查 riffet Cursor subagent 识别问题' });
    expect(h.session).toMatchObject({ title: '排查 riffet Cursor subagent 识别问题', titleSource: 'generated' });
    expect(h.transport!.lastParams('thread/name/set')).toBeUndefined();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it.each([
    { prompt: '排查客户端会话标题异常'.repeat(7), prefix: false },
    { prompt: `# ${'排查客户端会话标题异常'.repeat(7)}`, prefix: true },
  ])('does not finalize or echo a raw CLI fallback before normalizing and truncating it ($prefix)', async ({ prompt, prefix }) => {
    const h = makeHarness({ flavor: traexFlavor });
    h.host.firstUserMessage = () => prompt;
    Object.assign(h.session, { title: `${prompt.slice(0, 48)}…`, titleSource: 'prompt' });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);

    h.transport!.emitNativeNotification('thread/name/updated', { threadId: 'native-thread', name: prefix ? prompt.slice(0, 36) : prompt });
    expect(h.session.titleSource).toBe('prompt');
    expect(h.transport!.lastParams('thread/name/set')).toBeUndefined();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it.each([
    {
      prompt: '话说，riffet 对 cursor 的支持是不是存在比较大的问题，比如这个subagent没能识别出来',
      title: '话说，riffet 对 cursor 的支持是不是存在比较大的问题，比如',
    },
    { prompt: `${'文'.repeat(35)}，继续排查`, title: '文'.repeat(35) },
  ])('does not push a stale generated fallback while a resumed TRAE thread awaits its first-message evidence ($title)', async ({ prompt, title }) => {
    const h = makeHarness({ flavor: traexFlavor });
    Object.assign(h.session, { title, titleSource: 'generated', nativeSessionId: 'native-thread' });
    let firstMessage: string | undefined;
    h.host.firstUserMessage = () => firstMessage;
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    expect(h.transport!.lastParams('thread/name/set')).toBeUndefined();

    firstMessage = prompt;
    h.transport!.emitNativeNotification('thread/name/updated', { threadId: 'native-thread', name: '排查 riffet Cursor subagent 识别问题' });
    expect(h.session).toMatchObject({ title: '排查 riffet Cursor subagent 识别问题', titleSource: 'generated' });
    expect(h.transport!.lastParams('thread/name/set')).toBeUndefined();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('checks a provider title against the complete first prompt after the title stand-in is clipped', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const prompt = `${'A'.repeat(48)} 请总结这个中文项目`;
    h.transport!.emitNativeNotification('item/started', {
      threadId: 'native-thread', turnId: 'turn-title', startedAtMs: 1,
      item: { type: 'userMessage', id: 'user-title', clientId: 'cmd-title', content: [{ type: 'text', text: prompt }] },
    });
    expect(h.session.title).toBe(`${'A'.repeat(48)}…`);
    expect(h.session.titleSource).toBe('prompt');

    h.transport!.emitNativeNotification('thread/name/updated', { threadId: 'native-thread', name: 'Summarize Chinese project' });

    expect(h.session.title).toBe(`${'A'.repeat(48)}…`);
    expect(h.session.titleSource).toBe('prompt');
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('hands a rename to the running thread, and only when the thread does not have it', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    expect(h.transport!.lastParams('thread/name/set')).toBeUndefined();
    Object.assign(h.session, { title: '我的会话', titleSource: 'user' });
    await h.adapter.rename(h.host, h.session);
    expect(h.transport!.lastParams('thread/name/set')).toEqual({ threadId: 'native-thread', name: '我的会话' });
    const sets = () => h.transport!.requestParams.filter(entry => entry.method === 'thread/name/set').length;
    h.transport!.emitNativeNotification('thread/name/updated', { threadId: 'native-thread', name: '我的会话' });
    await h.adapter.rename(h.host, h.session);
    expect(sets()).toBe(1);
  });
});

describe('Codex native protocol controls', () => {
  const unmaterializedHistory = 'thread native-thread is not materialized yet; thread/turns/list is unavailable before first user message';
  const emptyHistory = 'failed to read thread: thread-store internal error: rollout at /tmp/rollout-native-thread.jsonl is empty';
  const emptyMetadata = 'failed to load thread history for thread native-thread: thread-store internal error: failed to read session metadata /tmp/rollout-native-thread.jsonl: rollout at /tmp/rollout-native-thread.jsonl is empty';

  it('keeps a newly created empty thread ready without hiding genuine or foreign history failures', async () => {
    const h = makeHarness();
    const endpoint = h.registerEndpoint('unix:///fake-codex-1.sock');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    endpoint.setTurnsListError(unmaterializedHistory);
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
      expect(h.adapter.status(h.host, h.session).history?.state).toBe('ready');
      now += 120_000;
      for (const error of [unmaterializedHistory, emptyHistory, emptyMetadata]) {
        endpoint.setTurnsListError(error);
        endpoint.setLegacyTurnsError(error);
        expect((await prime(h)).status.history?.state).toBe('ready');
        expect((await runtime.turnsPage({ threadId: 'native-thread', limit: 3, sortDirection: 'desc' }))?.data).toEqual([]);
      }
      await expect(runtime.turnsPage({ threadId: 'foreign-thread', limit: 3, sortDirection: 'desc' })).rejects.toThrow('failed to load thread history');
      for (const error of ['permission denied', 'failed to read thread: thread-store internal error: failed to read session metadata for rollout /tmp/pending.jsonl']) {
        endpoint.setTurnsListError(error);
        endpoint.setLegacyTurnsError(error);
        expect((await prime(h)).status.history).toMatchObject({ state: 'error', message: error });
        await expect(runtime.turnsPage({ threadId: 'native-thread', limit: 3, sortDirection: 'desc' })).rejects.toThrow(error);
      }
      // codex-cli 0.166 answers every read of a new thread after the first under this name.
      endpoint.setTurnsListError('list_turns is not supported yet');
      endpoint.setLegacyTurnsError('list_turns is not supported yet');
      expect((await prime(h)).status.history?.state).toBe('ready');
      expect((await runtime.turnsPage({ threadId: 'native-thread', limit: 3, sortDirection: 'desc' }))?.data).toEqual([]);
    } finally { await h.adapter.close(h.host); }
  });

  it.each(['workbench', 'TUI'] as const)('bounds first-message history preparation from %s and automatically recovers', async (source) => {
    const h = makeHarness();
    const endpoint = h.registerEndpoint('unix:///fake-codex-1.sock');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    endpoint.setTurnsListError(emptyMetadata);
    endpoint.setLegacyTurnsError(emptyMetadata);
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
      const request = { threadId: 'native-thread', limit: 3, sortDirection: 'desc' as const };
      now += 600_000;
      if (source === 'workbench') await h.send('first-message');
      else h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'turn-1' } });
      expect((await prime(h)).status.history?.state).toBe('loading');
      expect(await runtime.turnsPage(request)).toBeUndefined();
      now += 30_000;
      h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'turn-1' } });
      expect((await prime(h)).status.history?.state).toBe('loading');
      now += 30_001;
      expect((await prime(h)).status.history?.state).toBe('error');
      await expect(runtime.turnsPage(request)).rejects.toThrow('is empty');

      endpoint.setTurnsListAvailable(true);
      endpoint.setTurns([{ id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', id: 'user-first', content: [{ type: 'text', text: 'First message' }] }] }]);
      const recovered = (await prime(h)).status;
      expect(recovered.history?.state).toBe('ready');
      expect(recovered.notice).toBeUndefined();
      expect(recovered.noticeLevel).toBeUndefined();
      // A read of actual turns permanently ends new-thread grace, even within a later turn.
      endpoint.setTurnsListAvailable(false);
      h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'turn-2' } });
      expect((await prime(h)).status.history?.state).toBe('error');
      await expect(runtime.turnsPage(request)).rejects.toThrow('is empty');
    } finally { await h.adapter.close(h.host); }
  });

  it('reads a first turn still starting as pending, though codex-cli 0.166 names it an unsupported reader', async () => {
    const h = makeHarness();
    const endpoint = h.registerEndpoint('unix:///fake-codex-1.sock');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      endpoint.setTurnsListError('paginated_threads is not supported yet');
      endpoint.setLegacyTurnsError('list_turns is not supported yet');
      await h.send('first-message');
      expect((await prime(h)).status.history?.state).toBe('loading');
      now += 60_001;
      expect((await prime(h)).status.history?.state).toBe('error');
    } finally { await h.adapter.close(h.host); }
  });

  it('does not infer empty history after recreating a runtime for an existing thread', async () => {
    const h = makeHarness();
    const endpoint = h.registerEndpoint('unix:///fake-codex-1.sock');
    endpoint.setTurnsListError(unmaterializedHistory);
    let restarted: CodexBackendAdapter | undefined;
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      await h.adapter.close(h.host);
      restarted = new CodexBackendAdapter(h.factory);
      await restarted.openOrResume(h.host, h.session, h.project, h.profile);
      expect(restarted.status(h.host, h.session).history?.state).toBe('error');
      const runtime = await (restarted as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
      const request = { threadId: 'native-thread', limit: 3, sortDirection: 'desc' as const };
      await expect(runtime.turnsPage(request)).rejects.toThrow('not materialized');
      endpoint.setTurnsListError(emptyMetadata);
      endpoint.setLegacyTurnsError(emptyMetadata);
      expect((await prime({ ...h, adapter: restarted })).status.history?.state).toBe('error');
      await expect(runtime.turnsPage(request)).rejects.toThrow('is empty');
      endpoint.setTurnsListError('list_turns is not supported yet');
      endpoint.setLegacyTurnsError('list_turns is not supported yet');
      expect((await prime({ ...h, adapter: restarted })).status.history?.state).toBe('error');
      endpoint.setTurnsListAvailable(true);
      const recovered = (await prime({ ...h, adapter: restarted })).status;
      expect(recovered.history?.state).toBe('ready');
      expect(recovered.notice).toBeUndefined();
      expect(recovered.noticeLevel).toBeUndefined();
    } finally { await restarted?.close(h.host); await h.adapter.close(h.host); }
  });

  it.each([
    { rpcError: true, nativeStarted: false },
    { rpcError: false, nativeStarted: false },
    { rpcError: true, nativeStarted: true },
  ])('keeps rejected first input empty only without execution evidence ($rpcError, $nativeStarted)', async ({ rpcError, nativeStarted }) => {
    const h = makeHarness();
    const endpoint = h.registerEndpoint('unix:///fake-codex-1.sock');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    endpoint.setTurnsListError(emptyMetadata);
    endpoint.setLegacyTurnsError(emptyMetadata);
    let release = () => {};
    let sending: Promise<unknown> | undefined;
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
      const transport = h.transport!;
      const original = transport.request.bind(transport);
      let announce = () => {};
      const entered = new Promise<void>(resolve => { announce = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(transport, 'request').mockImplementation(async (method, input) => {
        if (method !== 'turn/start') return original(method, input);
        announce();
        await wait;
        throw Object.assign(new Error('First input was not acknowledged'), rpcError ? { rpcError: true, rpcCode: -32600 } : {});
      });
      sending = h.send('rejected-first').catch(error => error);
      await entered;
      const request = { threadId: 'native-thread', limit: 3, sortDirection: 'desc' as const };
      expect((await prime(h)).status.history?.state).toBe('loading');
      expect(await runtime.turnsPage(request)).toBeUndefined();
      if (nativeStarted) transport.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'native-first' } });
      release();
      expect(await sending).toBeInstanceOf(Error);
      now += 60_001;
      if (rpcError && !nativeStarted) {
        expect((await prime(h)).status.history?.state).toBe('ready');
        expect((await runtime.turnsPage(request))?.data).toEqual([]);
      } else {
        expect((await prime(h)).status.history?.state).toBe('error');
        await expect(runtime.turnsPage(request)).rejects.toThrow('is empty');
      }
    } finally { release(); await sending; await h.adapter.close(h.host); }
  });

  it('does not let an older initialization read overwrite concurrently materialized history', async () => {
    const h = makeHarness();
    const endpoint = h.registerEndpoint('unix:///fake-codex-1.sock');
    endpoint.setTurnsListError(emptyMetadata);
    endpoint.setLegacyTurnsError(emptyMetadata);
    let release = () => {};
    let oldRead: ReturnType<typeof prime> | undefined;
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
      const transport = h.transport!;
      transport.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'turn-1' } });
      const original = transport.request.bind(transport);
      let hold = true;
      let announce = () => {};
      const entered = new Promise<void>(resolve => { announce = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(transport, 'request').mockImplementation(async (method, input) => {
        if (method === 'thread/turns/list' && hold) {
          hold = false;
          announce();
          await wait;
          throw new Error(emptyMetadata);
        }
        return original(method, input);
      });
      oldRead = prime(h);
      await entered;
      const request = { threadId: 'native-thread', limit: 3, sortDirection: 'desc' as const };
      const turns = [{ id: 'turn-1', status: 'inProgress', items: [{ type: 'userMessage', id: 'user-first', content: [{ type: 'text', text: 'First message' }] }] }];
      endpoint.setTurnsListAvailable(true);
      endpoint.setTurns(turns);
      expect((await runtime.turnsPage(request))?.data).toEqual(turns);
      release();
      expect((await oldRead).status.history?.state).not.toBe('error');
      // Only the request that started during initialization can tolerate its stale response.
      endpoint.setTurnsListAvailable(false);
      expect((await prime(h)).status.history?.state).toBe('error');
      await expect(runtime.turnsPage(request)).rejects.toThrow('is empty');
      endpoint.setTurnsListAvailable(true);
      expect((await prime(h)).status.history?.state).toBe('ready');
    } finally { release(); await oldRead; await h.adapter.close(h.host); }
  });

  it.each([
    { metadataError: emptyMetadata, initializing: true },
    { metadataError: unmaterializedHistory, initializing: true },
    { metadataError: emptyMetadata.replace('thread native-thread:', 'thread foreign-thread:'), initializing: false },
    { metadataError: 'permission denied', initializing: false },
  ])('classifies first-turn metadata lag without masking unrelated errors ($initializing: $metadataError)', async ({ metadataError, initializing }) => {
    const h = makeHarness();
    const endpoint = h.registerEndpoint('unix:///fake-codex-1.sock');
    endpoint.setTurnsListError(emptyMetadata);
    endpoint.setLegacyTurnsError(emptyMetadata);
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      endpoint.setTurnsListAvailable(true);
      endpoint.setTurns([{ id: 'turn-1', status: 'inProgress', items: [{ type: 'userMessage', id: 'user-first', content: [{ type: 'text', text: 'First message' }] }] }]);
      const transport = h.transport!;
      const original = transport.request.bind(transport);
      vi.spyOn(transport, 'request').mockImplementation(async (method, input) => {
        if (method === 'thread/read' && (input as { includeTurns?: boolean })?.includeTurns === false) throw new Error(metadataError);
        return original(method, input);
      });
      // The turn page and its subsequent metadata request belong to one initialization read.
      expect((await prime(h)).status.history?.state).toBe(initializing ? 'ready' : 'error');
      // A later read starts after real history was observed, so it cannot reuse initialization grace.
      expect((await prime(h)).status.history).toMatchObject({ state: 'error', message: metadataError });
    } finally { await h.adapter.close(h.host); }
  });

  it.each(['list_turns', 'paginated_threads'])('reads legacy history when %s is unavailable and preserves legacy read failures', async capability => {
    const h = makeHarness();
    const endpoint = h.registerEndpoint('unix:///fake-codex-1.sock');
    endpoint.setTurnsListError(`${capability} is not supported yet`);
    const turns = [{ id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', id: 'user-first', content: [{ type: 'text', text: 'First message' }] }] }];
    endpoint.setTurns(turns);
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      expect(h.adapter.status(h.host, h.session).history?.state).toBe('ready');
      const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
      expect((await runtime.turnsPage({ threadId: 'native-thread', limit: 3, sortDirection: 'desc' }))?.data).toEqual(turns);
      endpoint.setLegacyTurnsError('permission denied');
      expect((await prime(h)).status.history).toMatchObject({ state: 'error', message: 'permission denied' });
    } finally { await h.adapter.close(h.host); }
  });

  it('logs a history failure once per transition without leaking provider credentials', async () => {
    const h = makeHarness();
    const endpoint = h.registerEndpoint('unix:///fake-codex-1.sock');
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      endpoint.setTurnsListError('permission denied: Bearer very-secret-bearer-token-987');
      await prime(h);
      await prime(h);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenLastCalledWith('[codex-history]', JSON.stringify({
        sessionId: h.session.id, nativeThreadId: 'native-thread', backendId: 'codex', message: 'permission denied: Bearer [redacted]',
      }));
      endpoint.setTurnsListAvailable(true);
      expect((await prime(h)).status.history?.state).toBe('ready');
      endpoint.setTurnsListAvailable(false);
      await prime(h);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { await h.adapter.close(h.host); }
  });

  it('keeps thread errors separate from history and clears only the recovered diagnostic', async () => {
    const h = makeHarness();
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      h.transport!.setThreadStatus('systemError');
      h.transport!.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: 'systemError' } });
      const threadError = h.adapter.status(h.host, h.session).notice;
      expect(threadError).toContain('thread-level system error');
      h.transport!.setTurnsListError('permission denied');
      expect((await prime(h)).status).toMatchObject({ notice: threadError, history: { state: 'error', message: 'permission denied' } });
      h.transport!.setTurnsListAvailable(true);
      expect((await prime(h)).status).toMatchObject({ notice: threadError, history: { state: 'ready' } });
      h.transport!.setSubagentThread('error-child', { turns: [{ id: 'child-turn', status: 'inProgress', items: [] }] });
      h.transport!.emitNativeNotification('item/started', { threadId: 'native-thread', turnId: 'parent-turn', item: { type: 'collabAgentToolCall', id: 'spawn-error-child', tool: 'spawnAgent', receiverThreadIds: ['error-child'], agentsStates: { 'error-child': { status: 'running' } } } });
      h.transport!.emitNativeNotification('turn/completed', { threadId: 'error-child', turn: { id: 'child-turn', status: 'completed', items: [] } });
      expect(h.adapter.status(h.host, h.session).notice).toBe(threadError);
      h.transport!.emitNativeNotification('model/loopDetectedRecovering', { threadId: 'native-thread' });
      expect(h.adapter.status(h.host, h.session).notice).toBe(threadError);
      h.transport!.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: 'idle' } });
      expect(h.adapter.status(h.host, h.session).notice).toBeUndefined();
      h.transport!.emitNativeNotification('model/loopDetectedRecovering', { threadId: 'native-thread' });
      const recovery = h.adapter.status(h.host, h.session).notice;
      expect(recovery).toContain('retrying');
      h.transport!.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: 'active' } });
      expect(h.adapter.status(h.host, h.session).notice).toBe(recovery);
      h.transport!.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: 'systemError' } });
      h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'recovered-turn', status: 'inProgress', items: [] } });
      expect(h.adapter.status(h.host, h.session).notice).toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it.each([codexFlavor, traexFlavor])('keeps $label’s unfinished turn through thread errors and idle reports until its own end arrives', async flavor => {
    const h = makeHarness({ flavor });
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      await h.send('thread-recovery');
      h.transport!.setTurns([{ id: 'turn-1', status: 'inProgress', items: [] }]);
      for (const type of ['systemError', 'idle'] as const) {
        h.transport!.setThreadStatus(type);
        h.transport!.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type } });
        expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'turn-1' } });
        h.transport!.emitNativeNotification('item/agentMessage/delta', { threadId: 'native-thread', turnId: 'turn-1', itemId: 'answer', delta: 'Continuing.' });
        expect((await prime(h)).status).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'turn-1' } });
      }
      const completed = { id: 'turn-1', status: 'completed', items: [] };
      h.transport!.setTurns([completed]);
      h.transport!.finishTurn('turn-1', 'completed', completed);
      expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
      expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
      h.transport!.emitNativeNotification('item/agentMessage/delta', { threadId: 'native-thread', turnId: 'turn-1', itemId: 'answer', delta: 'Late output.' });
      expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
      expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it.each(['turn-first', 'thread-first'])('lets the current root failure own its error in %s notification order', async order => {
    const h = makeHarness();
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      await h.send('cmd-failed');
      const failed = {
        id: 'turn-1', status: 'failed', error: { message: 'Task runtime is unavailable' },
        items: [{ type: 'userMessage', id: 'failed-user', clientId: 'cmd-failed', content: [{ type: 'text', text: 'Inspect this project' }] }],
      };
      h.transport!.setTurns([failed]);
      h.transport!.setThreadStatus('systemError');
      const threadError = () => h.transport!.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: 'systemError' } });
      if (order === 'thread-first') {
        threadError();
        expect(h.adapter.status(h.host, h.session).notice).toContain('thread-level system error');
      }
      h.transport!.finishTurn(failed.id, 'failed', failed);
      if (order === 'turn-first') threadError();
      expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'idle' });
      expect(h.adapter.status(h.host, h.session).notice).toBeUndefined();
      expect(h.adapter.status(h.host, h.session).noticeLevel).toBeUndefined();
      // Recovered history can repeat both facts without projecting a second error channel.
      expect((await prime(h)).status.notice).toBeUndefined();
      h.transport!.emitNativeNotification('model/loopDetectedRecovering', { threadId: 'native-thread' });
      expect(h.adapter.status(h.host, h.session).notice).toContain('retrying');
    } finally { await h.adapter.close(h.host); }
  });

  it('does not assign a new thread error to a failed root turn from before recovery', async () => {
    const h = makeHarness();
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      await h.send('cmd-old-failure');
      const failed = {
        id: 'turn-1', status: 'failed', error: { message: 'Old failure' },
        items: [{ type: 'userMessage', id: 'old-user', clientId: 'cmd-old-failure', content: [{ type: 'text', text: 'Inspect this project' }] }],
      };
      h.transport!.setTurns([failed]);
      h.transport!.setThreadStatus('systemError');
      h.transport!.finishTurn(failed.id, 'failed', failed);
      expect((await prime(h)).status.notice).toBeUndefined();
      for (const recovery of ['idle', 'active'] as const) {
        h.transport!.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: recovery } });
        h.transport!.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: 'systemError' } });
        expect(h.adapter.status(h.host, h.session).notice).toContain('thread-level system error');
        // Re-reading a mapped historical failure must not claim this independent thread error.
        expect((await prime(h)).status.notice).toContain('thread-level system error');
      }
    } finally { await h.adapter.close(h.host); }
  });

  it.each([codexFlavor, traexFlavor])('keeps a live $label writer through preference-only profile edits', async flavor => {
    const h = makeHarness({ flavor });
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const owner = h.transport!;
      const binding = h.session.nativeRuntime;
      Object.assign(h.profile.config, { name: 'New display name', defaultModel: 'new-default', isDefault: true, enabledModels: ['new-default'] });
      await h.send('after-preference-edit');
      expect(h.transport).toBe(owner);
      expect(h.factoryCalls).toHaveLength(1);
      expect(owner.disposed).toBe(false);
      expect(owner.lastParams('turn/start')).toBeDefined();
      expect(h.session.nativeRuntime).toEqual(binding);
    } finally { await h.adapter.close(h.host); }
  });

  it.each([codexFlavor, traexFlavor])('migrates a legacy builtin $label binding after saving profile defaults', async flavor => {
    const h = makeHarness({ flavor });
    let restarted: CodexBackendAdapter | undefined;
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const owner = h.transport!;
      const nativeSessionId = h.session.nativeSessionId;
      h.session.nativeRuntime = makeBinding(h, owner.remoteAddress);
      const legacy = h.session.nativeRuntime.fingerprint;
      await h.adapter.close(h.host);
      Object.assign(h.profile.config, { id: 'local', backendId: flavor.id, name: flavor.profileName, defaultModel: 'new-default', isDefault: true });
      restarted = new CodexBackendAdapter(h.factory, flavor);
      const opened = await restarted.openOrResume(h.host, h.session, h.project, h.profile);
      expect(opened.status?.connection?.state).toBe('connected');
      expect(opened.nativeSessionId).toBe(nativeSessionId);
      expect(h.factoryCalls.at(-1)?.remoteAddress).toBe(owner.remoteAddress);
      expect(h.session.nativeRuntime?.address).toBe(owner.remoteAddress);
      expect(h.session.nativeRuntime?.fingerprint).toBe(codexConfig.runtimeFingerprintFor(h.project, h.profile, flavor));
      expect(h.session.nativeRuntime?.fingerprint).not.toBe(legacy);
      expect(owner.detached).toBe(true);
      expect(owner.disposed).toBe(false);
    } finally { await restarted?.close(h.host); await h.adapter.close(h.host); }
  });

  it('reconnects to the same persisted native writer after the web service closes', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const nativeSessionId = h.session.nativeSessionId;
    const binding = h.session.nativeRuntime!;
    const before = h.transport!;
    expect(binding.address).toBe(before.remoteAddress);
    expect(binding.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await h.adapter.close(h.host);
    expect(before.detached).toBe(true);
    expect(before.disposed).toBe(false);

    const restarted = new CodexBackendAdapter(h.factory);
    const opened = await restarted.openOrResume(h.host, h.session, h.project, h.profile);
    expect(h.factoryCalls.at(-1)?.remoteAddress).toBe(binding.address);
    expect(opened.nativeSessionId).toBe(nativeSessionId);
    await restarted.close(h.host);
  });

  it.each(['ENOENT', 'ECONNREFUSED'])('starts a replacement only when the saved socket is unreachable with %s', async code => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.adapter.close(h.host);
    const savedBinding = h.session.nativeRuntime!;
    h.factoryErrors.push(Object.assign(new Error('Native socket is gone'), { code }));
    const restarted = new CodexBackendAdapter(h.factory);
    await restarted.openOrResume(h.host, h.session, h.project, h.profile);
    const reconnectCalls = h.factoryCalls.slice(1);
    expect(reconnectCalls.some(options => options.remoteAddress === savedBinding.address)).toBe(true);
    expect(reconnectCalls.some(options => options.remoteAddress === undefined)).toBe(true);
    expect(h.transport?.remoteAddress).toBe(h.session.nativeRuntime?.address);
    expect(h.transport?.remoteAddress).not.toBe(savedBinding.address);
    expect(h.transport?.lastParams('thread/resume')?.threadId).toBe('native-thread');
    await restarted.close(h.host);
  });

  it('keeps one cold history reader while the saved socket stays unreachable', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.adapter.close(h.host);
    const savedBinding = h.session.nativeRuntime!;
    let spawned = 0;
    const restarted = new CodexBackendAdapter(async options => {
      if (options.remoteAddress === savedBinding.address) throw Object.assign(new Error('Native socket is gone'), { code: 'ENOENT' });
      if (options.remoteAddress === undefined) spawned += 1;
      return await h.factory(options);
    });
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, h.session.id);
    const source = restarted.transcript(h.host, h.session, h.profile);
    // Each backstop read asks for a reader again; the dead binding must not look like a new owner.
    for (let pulls = 0; pulls < 3; pulls += 1) await pullLane(source, writer, new AbortController().signal);
    expect(spawned).toBe(1);
    expect(h.transport?.disposed).toBe(false);
    expect(h.session.nativeRuntime?.address).toBe(savedBinding.address);
    await restarted.close(h.host);
  });

  it('does not create another writer when an existing server rejects the protocol', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.adapter.close(h.host);
    const calls = h.factoryCalls.length;
    h.factoryErrors.push(new Error('Server is draining; retry after reconnecting'));
    const restarted = new CodexBackendAdapter(h.factory);
    await expect(restarted.openOrResume(h.host, h.session, h.project, h.profile)).rejects.toThrow('Server is draining');
    expect(h.factoryCalls).toHaveLength(calls + 1);
    expect(h.factoryCalls.at(-1)?.remoteAddress).toBe(h.session.nativeRuntime?.address);
    await restarted.close(h.host);
  });

  it('keeps a verified writer usable through profile edits and service restarts without relabelling its launch', async () => {
    const h = makeHarness();
    h.profile.config.apiEndpoint = 'https://old.example';
    h.profile.config.apiKey = 'old-test-key';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const binding = h.session.nativeRuntime;
    const owner = h.transport!;
    const previousProfile = structuredClone(h.profile);
    h.profile.config.apiEndpoint = 'https://new.example/v1';
    h.profile.config.apiKey = 'new-test-key';
    await h.send('after-api-edit');
    expect(h.transport).toBe(owner);
    expect(owner.disposed).toBe(false);
    expect(h.adapter.status(h.host, h.session)).toMatchObject({ profilePending: true, connection: { state: 'connected' } });
    expect(h.session.nativeRuntime).toEqual(binding);
    expect(h.adapter.status(h.host, h.session).activeTurn).toMatchObject({ nativeSessionId: 'native-thread', turnId: 'turn-1' });
    owner.finishTurn('turn-1', 'completed');
    await h.adapter.close(h.host);
    const restarted = new CodexBackendAdapter(h.factory);
    try {
      const opened = await restarted.openOrResume(h.host, h.session, h.project, h.profile);
      expect(opened.status).toMatchObject({ profilePending: true, connection: { state: 'connected' } });
      expect(h.transport?.remoteAddress).toBe(binding?.address);
      expect(h.transport?.lastParams('thread/resume')?.threadId).toBe('native-thread');
      expect(h.session.nativeRuntime).toEqual(binding);
      const restored = await restarted.openOrResume(h.host, h.session, h.project, previousProfile);
      expect(restored.status?.profilePending).toBeUndefined();
      expect(restored.status?.connection?.state).toBe('connected');
    } finally { await restarted.close(h.host); }
  });

  it('recovers an old binding after an API edit only with evidence of its original thread and workspace', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const binding = h.session.nativeRuntime!;
    delete binding.scopeFingerprint;
    await h.adapter.close(h.host);
    h.profile.config.apiEndpoint = 'https://changed.example/v1';
    const restarted = new CodexBackendAdapter(h.factory);
    try {
      // The fixture supplies no cwd; a live socket alone proves no workspace ownership.
      const unverified = await restarted.openOrResume(h.host, h.session, h.project, h.profile);
      expect(unverified.status?.connection?.state).toBe('conflict');
      expect(h.session.nativeRuntime).toBe(binding);
      const restoredProfile = { ...h.profile, config: { executable: h.profile.config.executable } };
      const restored = await restarted.openOrResume(h.host, h.session, h.project, restoredProfile);
      expect(restored.status?.connection?.state).toBe('connected');
      expect(restored.status?.notice).toBeUndefined();
    } finally { await restarted.close(h.host); }
    h.session.nativeRuntime = binding;
    h.setTerminalEndpoint(binding.address);
    const verified = new CodexBackendAdapter(h.factory);
    try {
      const opened = await verified.openOrResume(h.host, h.session, h.project, h.profile);
      expect(opened.status).toMatchObject({ profilePending: true, connection: { state: 'connected' } });
      expect(h.session.nativeRuntime?.fingerprint).toBe(binding.fingerprint);
      expect(h.session.nativeRuntime?.scopeFingerprint).toBeDefined();
    } finally { await verified.close(h.host); }
  });

  it('reuses a verified terminal after restart without probing or launching the edited CLI', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.setTerminalEndpoint(h.transport!.remoteAddress);
    await h.adapter.close(h.host);
    h.profile.config.executable = '/missing-new-cli';
    vi.mocked(codexConfig.probeAppServer).mockRejectedValue(new Error('new CLI unavailable'));
    const restarted = new CodexBackendAdapter(h.factory);
    try {
      const opened = await restarted.openOrResume(h.host, h.session, h.project, h.profile);
      expect(opened.status).toMatchObject({ profilePending: true, connection: { state: 'connected' } });
      expect(opened.terminalId).toBe(h.session.terminalId);
    } finally { await restarted.close(h.host); }
  });

  it('applies changed launch settings only on explicit restart and does not repeat a completed restart', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const owner = h.transport!;
    const fingerprint = h.session.nativeRuntime!.fingerprint;
    await h.send('before-restart');
    h.profile.config.apiEndpoint = 'https://new.example/v1';
    // The original process owns the socket. Once disposed, probing that durable binding fails.
    const dispose = owner.dispose.bind(owner);
    owner.dispose = async () => { await dispose(); h.factoryErrors.push(Object.assign(new Error('gone'), { code: 'ENOENT' })); };
    try {
      const gate = h.deferEndpointRequest(owner.remoteAddress, 'thread/loaded/list');
      const opening = h.adapter.openOrResume(h.host, h.session, h.project, h.profile, { restartFingerprint: fingerprint, restartAddress: owner.remoteAddress });
      await gate.entered;
      const concurrent = h.adapter.openOrResume(h.host, h.session, h.project, h.profile, { restartFingerprint: fingerprint, restartAddress: owner.remoteAddress });
      gate.release();
      await waitFor(() => owner.lastParams('turn/interrupt') ? true : undefined);
      expect(owner.disposed).toBe(false);
      owner.finishTurn('turn-1', 'interrupted');
      const [opened, alsoOpened] = await Promise.all([opening, concurrent]);
      expect(alsoOpened.nativeSessionId).toBe(opened.nativeSessionId);
      expect(owner.disposed).toBe(true);
      expect(opened.nativeSessionId).toBe('native-thread');
      expect(opened.status?.profilePending).toBeUndefined();
      expect(h.session.nativeRuntime?.fingerprint).toBe(codexConfig.runtimeFingerprintFor(h.project, h.profile, codexFlavor));
      expect(h.factoryCalls.at(-1)?.args).toContain('openai_base_url="https://new.example/v1"');
      const replacement = h.transport!;
      const calls = h.factoryCalls.length;
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile, { restartFingerprint: fingerprint, restartAddress: owner.remoteAddress });
      expect(h.factoryCalls).toHaveLength(calls);
      expect(replacement.disposed).toBe(false);
      // The same configuration can belong to a later process. A delayed request for the old
      // address must not stop it even when its launch fingerprint matches again.
      h.session.nativeRuntime!.fingerprint = fingerprint;
      await h.adapter.close(h.host);
      const sameConfigOwner = new CodexBackendAdapter(h.factory);
      try {
        const continued = await sameConfigOwner.openOrResume(h.host, h.session, h.project, h.profile, { restartFingerprint: fingerprint, restartAddress: owner.remoteAddress });
        expect(continued.status?.profilePending).toBe(true);
        expect(h.transport?.remoteAddress).toBe(replacement.remoteAddress);
        expect(h.transport?.disposed).toBe(false);
      } finally { await sameConfigOwner.close(h.host); }
    } finally { await h.adapter.close(h.host); }
  });

  it('does not interrupt or stop a backend if its binding changes while restart verifies ownership', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const owner = h.transport!;
    const binding = h.session.nativeRuntime!;
    await h.send('before-stale-restart');
    h.profile.config.apiEndpoint = 'https://changed.example';
    const gate = h.deferEndpointRequest(owner.remoteAddress, 'thread/loaded/list');
    try {
      const opening = h.adapter.openOrResume(h.host, h.session, h.project, h.profile, { restartFingerprint: binding.fingerprint, restartAddress: binding.address });
      const rejected = expect(opening).rejects.toMatchObject({ code: 'NATIVE_LAUNCH_ABORTED' });
      await gate.entered;
      const replacementBinding = { ...binding, address: 'unix:///replacement-owner.sock' };
      h.session.nativeRuntime = replacementBinding;
      gate.release();
      await rejected;
      expect(owner.lastParams('turn/interrupt')).toBeUndefined();
      expect(owner.disposed).toBe(false);
      expect(h.session.nativeRuntime).toEqual(replacementBinding);
      expect(h.factoryCalls).toHaveLength(1);
    } finally { gate.release(); await h.adapter.close(h.host); }
  });

  it('keeps the original binding when an explicitly restarted replacement cannot resume', async () => {
    const h = makeHarness({ resumeError: 'cannot resume' });
    // Start has no resume; only the replacement will fail.
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const owner = h.transport!;
    const binding = h.session.nativeRuntime!;
    h.profile.config.apiEndpoint = 'https://changed.example';
    const dispose = owner.dispose.bind(owner);
    owner.dispose = async () => { await dispose(); h.factoryErrors.push(Object.assign(new Error('gone'), { code: 'ECONNREFUSED' })); };
    try {
      await expect(h.adapter.openOrResume(h.host, h.session, h.project, h.profile, { restartFingerprint: binding.fingerprint, restartAddress: binding.address })).rejects.toThrow('cannot resume');
      expect(h.session.nativeRuntime).toEqual(binding);
      expect(h.session.nativeSessionId).toBe('native-thread');
      expect(h.transport?.lastParams('turn/start')).toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it('does not reuse a binding from a different workspace even when its socket is reachable', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.adapter.close(h.host);
    h.project.cwd = '/different/workspace';
    const restarted = new CodexBackendAdapter(h.factory);
    try {
      const opened = await restarted.openOrResume(h.host, h.session, h.project, h.profile);
      expect(opened.status?.connection?.state).toBe('conflict');
    } finally { await restarted.close(h.host); }
  });

  it('detaches a borrowed endpoint after an active-writer resume failure without disposing it', async () => {
    const h = makeHarness();
    const binding = makeBinding(h, 'unix:///borrowed-active-writer.sock');
    h.session.nativeSessionId = 'native-thread';
    h.session.cursorSessionId = 'native-thread';
    h.session.nativeRuntime = binding;
    h.registerEndpoint(binding.address).setResumeError('thread already has an active writer');

    const adapter = new CodexBackendAdapter(h.factory);
    await expect(adapter.openOrResume(h.host, h.session, h.project, h.profile)).rejects.toThrow(/active writer/i);
    expect(h.transport?.remoteAddress).toBe(binding.address);
    expect(h.transport?.detached).toBe(true);
    expect(h.transport?.disposed).toBe(false);
    expect(h.session.nativeRuntime).toBe(binding);
    await adapter.close(h.host);
  });

  it('disposes an owned fallback after resume fails and keeps the previous endpoint binding', async () => {
    const h = makeHarness({ resumeError: 'thread already has an active writer' });
    const binding = makeBinding(h, 'unix:///stale-saved-endpoint.sock');
    h.session.nativeSessionId = 'native-thread';
    h.session.cursorSessionId = 'native-thread';
    h.session.nativeRuntime = binding;
    h.factoryErrors.push(Object.assign(new Error('saved socket is gone'), { code: 'ECONNREFUSED' }));

    await expect(h.adapter.openOrResume(h.host, h.session, h.project, h.profile)).rejects.toThrow(/active writer/i);
    expect(h.factoryCalls.some(options => options.remoteAddress === binding.address)).toBe(true);
    expect(h.factoryCalls.some(options => options.remoteAddress === undefined)).toBe(true);
    expect(h.transport?.remoteAddress).not.toBe(binding.address);
    expect(h.transport?.disposed).toBe(true);
    expect(h.transport?.detached).toBe(false);
    expect(h.session.nativeRuntime).toBe(binding);
    await h.adapter.close(h.host);
  });

  it('does not commit a fallback endpoint when resume confirms a different thread id', async () => {
    const h = makeHarness({ resumeThreadId: 'different-native-thread' });
    const binding = makeBinding(h, 'unix:///old-thread-owner.sock');
    h.session.nativeSessionId = 'native-thread';
    h.session.cursorSessionId = 'native-thread';
    h.session.nativeRuntime = binding;
    h.factoryErrors.push(Object.assign(new Error('saved socket is gone'), { code: 'ENOENT' }));

    await expect(h.adapter.openOrResume(h.host, h.session, h.project, h.profile)).rejects.toThrow(/different thread/i);
    expect(h.transport?.lastParams('thread/resume')?.threadId).toBe('native-thread');
    expect(h.transport?.disposed).toBe(true);
    expect(h.session.nativeRuntime).toBe(binding);
    expect(h.session.nativeSessionId).toBe('native-thread');
    await h.adapter.close(h.host);
  });

  it('prefers a verified terminal endpoint over the saved binding', async () => {
    const terminalEndpoint = 'unix:///terminal-owner.sock';
    const h = makeHarness({ terminalEndpoint });
    const binding = makeBinding(h, 'unix:///older-binding.sock');
    h.session.nativeSessionId = 'native-thread';
    h.session.cursorSessionId = 'native-thread';
    h.session.nativeRuntime = binding;
    const oldServer = h.registerEndpoint(binding.address);
    h.registerEndpoint(terminalEndpoint);

    const opened = await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    expect(opened.status?.connection?.state).toBe('connected');
    expect(h.factoryCalls[0]?.remoteAddress).toBe(terminalEndpoint);
    expect(h.transport?.remoteAddress).toBe(terminalEndpoint);
    expect(h.transport?.lastParams('thread/resume')?.threadId).toBe('native-thread');
    expect(oldServer.requestParams.some(request => request.method === 'thread/resume')).toBe(false);
    expect(h.session.nativeRuntime?.address).toBe(terminalEndpoint);
    await h.adapter.close(h.host);
  });

  it('reselects a changed verified terminal endpoint and writes only through the new owner', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const oldTransport = h.transport!;
    const newEndpoint = 'unix:///terminal-replaced-owner.sock';
    h.registerEndpoint(newEndpoint);
    h.setTerminalEndpoint(newEndpoint);

    await h.send('cmd-after-terminal-restart');
    expect(h.transport).not.toBe(oldTransport);
    expect(h.transport?.remoteAddress).toBe(newEndpoint);
    expect(h.transport?.lastParams('thread/resume')?.threadId).toBe('native-thread');
    expect(h.transport?.lastParams('turn/start')?.threadId).toBe('native-thread');
    expect(oldTransport.detached).toBe(true);
    expect(oldTransport.requestParams.some(request => request.method === 'thread/resume' || request.method === 'turn/start')).toBe(false);
    expect(h.session.nativeRuntime?.address).toBe(newEndpoint);
    expect(h.adapter.status(h.host, h.session).connection?.state).toBe('connected');
    await h.adapter.close(h.host);
  });

  it('does not resume the old binding when a changed terminal endpoint is unreachable', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const oldTransport = h.transport!;
    const binding = h.session.nativeRuntime!;
    h.setTerminalEndpoint('unix:///unreachable-terminal-owner.sock');
    const oldWriterCalls = oldTransport.requestParams.filter(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method)).length;
    h.factoryErrors.push(Object.assign(new Error('terminal socket is gone'), { code: 'ECONNREFUSED' }));

    const opened = await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    expect(opened.status?.connection?.state).toBe('conflict');
    expect(h.session.nativeRuntime).toBe(binding);
    expect(h.transport?.remoteAddress).toBe(binding.address);
    expect(h.transport?.requestParams.filter(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method))).toHaveLength(oldWriterCalls);
    await h.adapter.close(h.host);
  });

  it.each([codexFlavor, traexFlavor])('retries a transient $label endpoint lookup and reuses its proof when ensuring the TUI', async flavor => {
    const address = flavor.id === 'traex' ? 'ws://127.0.0.1:51688' : 'unix:///terminal-lookup-retry.sock';
    const h = makeHarness({ flavor, terminalEndpoint: address });
    h.session.nativeSessionId = 'native-thread';
    h.session.nativeRuntime = makeBinding(h, address);
    h.registerEndpoint(address);
    vi.mocked(codexConfig.probeAppServer).mockResolvedValue({ ...fakeProbe, unixSocket: true, remoteUnix: true, wsAuth: true, remoteWs: true });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const factoryCalls = h.factoryCalls.length;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 3_000);
    const lookup = vi.fn<NonNullable<NativeBackendHost['terminal']['inspectPane']>>().mockResolvedValueOnce(undefined).mockResolvedValue(h.paneFor(address));
    h.host.terminal.inspectPane = lookup;

    await h.send('cmd-lookup-retry');

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(h.factoryCalls).toHaveLength(factoryCalls);
    expect(h.transport?.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(h.adapter.status(h.host, h.session).connection?.state).toBe('connected');
    await h.adapter.close(h.host);
  });

  it('blocks writes while a running terminal endpoint is unknown and recovers immediately when verified', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const current = h.transport!;
    const factoryCallCount = h.factoryCalls.length;
    const writerCallCount = current.requestParams.filter(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method)).length;
    h.setTerminalEndpoint(undefined);

    await expect(h.send('cmd-terminal-unknown')).rejects.toMatchObject({ code: 'NATIVE_ENDPOINT_CONFLICT' });
    expect(h.factoryCalls).toHaveLength(factoryCallCount);
    expect(current.requestParams.filter(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method))).toHaveLength(writerCallCount);
    // Not verified is not a different owner: writes wait, and the session reads as reconnecting.
    expect(h.adapter.status(h.host, h.session).connection?.state).toBe('reconnecting');

    h.setTerminalEndpoint(current.remoteAddress);
    await h.send('cmd-terminal-verified');
    expect(h.factoryCalls).toHaveLength(factoryCallCount);
    expect(current.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(h.adapter.status(h.host, h.session).connection?.state).toBe('connected');
    await h.adapter.close(h.host);
  });

  it.each([codexFlavor, traexFlavor])('waits for a $label terminal verification within the shared lookup deadline before writing', async flavor => {
    const h = makeHarness({ flavor });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const current = h.transport!;
    const factoryCalls = h.factoryCalls.length;
    h.setTerminalEndpoint(current.remoteAddress);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const lookup = vi.fn<NonNullable<NativeBackendHost['terminal']['inspectPane']>>().mockImplementation(() =>
      new Promise(resolve => { setTimeout(() => resolve(h.paneFor(current.remoteAddress)), 4_750); }));
    h.host.terminal.inspectPane = lookup;
    const sending = h.send('cmd-slow-verification').catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(4_500);
      expect(current.requestParams.some(request => request.method === 'turn/start')).toBe(false);
      await vi.advanceTimersByTimeAsync(5_500);
      expect(await sending).toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(h.factoryCalls).toHaveLength(factoryCalls);
      expect(h.transport).toBe(current);
      expect(current.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(1);
      expect(h.adapter.status(h.host, h.session).connection?.state).toBe('connected');
    } finally { vi.useRealTimers(); await h.adapter.close(h.host); }
  });

  it('rechecks an unverified read-only lookup when a send joins its in-flight runtime check', async () => {
    const h = makeHarness({ flavor: traexFlavor });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const current = h.transport!;
    h.setTerminalEndpoint(current.remoteAddress);
    let release!: (processes: undefined) => void;
    let entered!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<undefined>(resolve => { release = resolve; });
    const lookup = vi.fn<NonNullable<NativeBackendHost['terminal']['inspectPane']>>().mockImplementationOnce(() => { entered(); return pending; }).mockResolvedValue(h.paneFor(current.remoteAddress));
    h.host.terminal.inspectPane = lookup;
    const snapshot = prime(h);
    await checking;
    const send = h.send('cmd-joined-read');
    release(undefined);
    await Promise.all([snapshot, send]);

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(current.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(h.transport).toBe(current);
    await h.adapter.close(h.host);
  });

  it('does not interrupt an old endpoint when joining a read that reused its cached verification', async () => {
    const address = 'ws://127.0.0.1:51688';
    const h = makeHarness({ flavor: traexFlavor, terminalEndpoint: address });
    h.session.nativeSessionId = 'native-thread';
    h.session.nativeRuntime = makeBinding(h, address);
    h.registerEndpoint(address);
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const current = h.transport!;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 1_000);
    h.setTerminalEndpoint('ws://127.0.0.1:51689');

    const snapshot = prime(h);
    const interrupt = expect(h.adapter.interrupt(h.host, h.session, h.profile)).rejects.toMatchObject({ code: 'NATIVE_ENDPOINT_CONFLICT' });
    await Promise.all([snapshot, interrupt]);

    expect(current.requestParams.some(request => request.method === 'turn/interrupt')).toBe(false);
    expect(h.transport).toBe(current);
    await h.adapter.close(h.host);
  });

  it('serializes observer attachment and explicit open through the same resume gate', async () => {
    const h = makeHarness();
    h.session.nativeSessionId = 'native-thread';
    h.session.cursorSessionId = 'native-thread';
    const endpoint = 'unix:///observer-explicit-open-race.sock';
    const owner = h.registerEndpoint(endpoint);
    owner.setLoadedThreads(['native-thread']);
    h.session.nativeRuntime = makeBinding(h, endpoint);
    await prime(h);
    const gate = h.deferEndpointRequest(endpoint, 'thread/resume');

    const messages: NativeControlMessage[] = [];
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, message => messages.push(message));
    await gate.entered;
    const explicitOpen = h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(owner.requestParams.filter(request => request.method === 'thread/resume')).toHaveLength(1);

    gate.release();
    const opened = await explicitOpen;
    expect(opened.status?.connection?.state).toBe('connected');
    expect(owner.requestParams.filter(request => request.method === 'thread/resume')).toHaveLength(1);
    expect(h.transport?.isOnline).toBe(true);
    expect(h.transport?.detached).toBe(false);
    expect(h.adapter.status(h.host, h.session).connection?.state).toBe('connected');
    unsubscribe();
    await h.adapter.close(h.host);
  });

  it('disposes its owned read-only server when closed before attachment', async () => {
    const h = makeHarness();
    h.session.nativeSessionId = 'native-thread';
    h.session.cursorSessionId = 'native-thread';

    await prime(h);
    const reader = h.transport!;
    expect(reader.requestParams.some(request => request.method === 'thread/resume' || request.method === 'thread/start')).toBe(false);
    await h.adapter.close(h.host);
    expect(reader.disposed).toBe(true);
    expect(reader.detached).toBe(false);
  });

  it('rejects a missing app-server executable without an unhandled child-process error', async () => {
    await expect(CodexAppServer.start({
      executable: '/riffet-test-missing-codex-executable', cwd: process.cwd(),
      onNotification: () => undefined,
      onServerRequest: async () => NO_SERVER_RESPONSE,
      onExit: () => undefined,
    })).rejects.toThrow('ENOENT');
  });

  it('preserves native model suffixes while peeling only the final workbench parameter block', () => {
    expect(parseNativeModelSelection('opus[1m]')).toEqual({ model: 'opus[1m]', params: {} });
    const mixed = parseNativeModelSelection('opus[1m][effort=high]');
    expect(mixed).toEqual({ model: 'opus[1m]', params: { effort: 'high' } });
    expect(nativeModelEffort(mixed)).toBe('high');
    expect(parseNativeModelSelection('gpt-6[reasoningEffort=high,fast=true]'))
      .toEqual({ model: 'gpt-6', params: { reasoningEffort: 'high', fast: 'true' } });
    // Fast is tri-state: absent means the catalog published no switch, so the tier must be inherited.
    expect(nativeModelFast(parseNativeModelSelection('gpt-6[reasoningEffort=high,fast=true]'))).toBe(true);
    expect(nativeModelFast(parseNativeModelSelection('gpt-6[fast=false]'))).toBe(false);
    expect(nativeModelFast(parseNativeModelSelection('gpt-6[reasoningEffort=high]'))).toBeUndefined();
  });

  it('answers a multi-question server request without confusing the web id with the native RPC id', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.queueServerRequest({
      id: 1,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'native-thread', turnId: 'turn-1', itemId: 'questions', isBlocking: true,
        questions: [
          { id: 'choice', header: 'Choice', question: 'Which options?', isOther: false, isSecret: false, multiSelect: true,
            options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] },
          { id: 'single', header: 'Single', question: 'Choose one or another answer', isOther: true, isSecret: false, multiSelect: false,
            options: [{ label: 'Yes' }, { label: 'No' }] },
          { id: 'name', header: 'Name', question: 'Anything else?', isOther: true, isSecret: false, multiSelect: false, options: null },
        ],
      },
    });
    await h.send('cmd-question');

    const first = await waitFor(() => h.adapter.interaction(h.host, h.session));
    expect(first?.requestId).toBe('1');
    expect(first?.questionIndex).toBe(1);
    expect(first?.multiple).toBe(true);
    const firstResponse: NativeInteractionResponse = {
      interactionId: first!.id, revision: first!.revision, requestId: 'web-request-1',
      action: 'answer', selectedIds: ['option:1', 'option:0'],
    };
    const invalidAnswers = [
      { selectedIds: ['option:9'] }, { selectedIds: ['option:0', 'option:0'] },
      { selectedIds: ['option:0'], otherText: 'Not permitted' }, { selectedIds: [] },
    ];
    for (const [index, invalid] of invalidAnswers.entries()) {
      const requestId = `invalid-multi-${index}`;
      await expect(h.adapter.respond(h.host, h.session, h.profile, { ...firstResponse, ...invalid, requestId }))
        .rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
      expect(h.getReceipt(requestId)).toBeUndefined();
      expect(h.adapter.interaction(h.host, h.session)?.revision).toBe(first?.revision);
      expect(h.transport!.responses.has('1')).toBe(false);
    }
    const advanced = await h.adapter.respond(h.host, h.session, h.profile, firstResponse);
    expect(advanced.status).toBe('advanced');
    expect(first?.revision).toBe('1:0');
    expect(advanced.interaction?.revision).toBe('1:1');
    // RPC id 1 used to collide with its first advance, so a late old card under a fresh key
    // answered the second question. A retry key may replay its receipt, never advance twice.
    const stale = await h.adapter.respond(h.host, h.session, h.profile, { ...firstResponse, requestId: 'late-first-card' });
    expect(stale.status).toBe('uncertain');
    expect(h.adapter.interaction(h.host, h.session)?.revision).toBe('1:1');
    expect(h.transport!.responses.has('1')).toBe(false);
    expect(await h.adapter.respond(h.host, h.session, h.profile, firstResponse)).toEqual(advanced);
    await expect(h.adapter.respond(h.host, h.session, h.profile, { ...firstResponse, selectedIds: [] }))
      .rejects.toMatchObject({ code: 'NATIVE_INTERACTION_REQUEST_CONFLICT' });

    const second = advanced.interaction!;
    expect(second.questionIndex).toBe(2);
    for (const [index, invalid] of [
      { selectedIds: ['option:0', 'option:1'] }, { selectedIds: ['option:0'], otherText: 'Alternative' },
    ].entries()) {
      const requestId = `invalid-single-${index}`;
      await expect(h.adapter.respond(h.host, h.session, h.profile, {
        interactionId: second.id, revision: second.revision, requestId, action: 'answer', ...invalid,
      })).rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
      expect(h.getReceipt(requestId)).toBeUndefined();
      expect(h.adapter.interaction(h.host, h.session)?.revision).toBe(second.revision);
    }
    const next = await h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: second.id, revision: second.revision, requestId: 'web-single', action: 'answer', selectedIds: ['option:0'],
    });
    const last = next.interaction!;
    expect(next.status).toBe('advanced');
    expect(last.questionIndex).toBe(3);
    h.transport!.deferResolved();
    await h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: last.id, revision: last.revision, requestId: 'web-request-2', action: 'answer', otherText: 'Free response',
    });
    const resolved = await waitFor(() => h.transport!.responses.get('1'));
    expect(resolved).toEqual({ answers: { choice: { answers: ['A', 'B'] }, single: { answers: ['Yes'] }, name: { answers: ['Free response'] } } });
    expect(h.transport!.legacyThreadReads).toBeGreaterThan(0);
    expect(h.adapter.interaction(h.host, h.session)?.revision).toBe(last.revision);
    await expect(h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: last.id, revision: last.revision, requestId: 'invalid-question-after-candidate', action: 'answer', selectedIds: ['option:99'],
    })).rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
    expect(h.getReceipt('invalid-question-after-candidate')).toBeUndefined();
    expect(h.transport!.responses.get('1')).toEqual(resolved);
    h.transport!.notifyResolved(1);
    expect((await h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: last.id, revision: last.revision, requestId: 'web-request-2', action: 'answer', otherText: 'Free response',
    })).status).toBe('completed');
    await expect(h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: last.id, revision: last.revision, requestId: 'web-request-2', action: 'answer', otherText: 'Changed answer',
    })).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_REQUEST_CONFLICT' });
    await waitFor(() => h.adapter.interaction(h.host, h.session) === undefined ? true : undefined);
    const otherAdapter = new CodexBackendAdapter(async options => new FakeAppServer(options));
    expect(otherAdapter.status(h.host, h.session).phase).toBe('offline');
    await otherAdapter.close(h.host);
    expect(h.transport!.isOnline).toBe(true);
    await h.adapter.close(h.host);
    expect(h.transport!.isOnline).toBe(false);
  });

  it('shows async questions on the running turn and steers the answer in the envelope Codex reads', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('cmd-async');
    h.transport!.emitNativeNotification('item/completed', {
      threadId: 'native-thread', turnId: 'turn-1', startedAtMs: 3,
      item: {
        type: 'agentMessage', id: 'ask-item', text: 'Two quick checks.', delivery: 'async',
        questions: [{ title: 'Quota per day or week?', options: ['Per user', 'Per model'] }, { title: 'Timezone?', options: null }],
      },
    });

    const first = await waitFor(() => h.adapter.interaction(h.host, h.session));
    expect(first).toMatchObject({ message: 'Quota per day or week?', questionIndex: 1, questionCount: 2, allowOther: true });
    expect(first!.options.map(option => option.label)).toEqual(['Per user', 'Per model']);
    // Nothing blocks: the turn is still working while the card is up.
    expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'busy', activeTurnId: 'run-cmd-async', interaction: { id: first!.id } });

    const answer: NativeInteractionResponse = { interactionId: first!.id, revision: first!.revision, requestId: 'async-1', action: 'answer', selectedIds: ['option:1'] };
    const advanced = await h.adapter.respond(h.host, h.session, h.profile, answer);
    expect(h.transport!.lastParams('turn/steer')).toEqual({
      threadId: 'native-thread', expectedTurnId: 'turn-1',
      input: [{
        type: 'text', text_elements: [],
        text: '<send_user_message_question_reply>\n[{"answer":"Per model","question":"Quota per day or week?","questionItemId":"[\\"request_user_input_async\\",\\"ask-item\\",0]"}]\n</send_user_message_question_reply>',
      }],
    });
    expect(advanced).toMatchObject({ status: 'advanced', interaction: { message: 'Timezone?', questionIndex: 2 } });
    expect(await h.adapter.respond(h.host, h.session, h.profile, answer)).toEqual(advanced);
    expect(h.transport!.requestParams.filter(entry => entry.method === 'turn/steer')).toHaveLength(1);

    const second = advanced.interaction!;
    expect(await h.adapter.respond(h.host, h.session, h.profile, { interactionId: second.id, revision: second.revision, requestId: 'async-2', action: 'skip' }))
      .toEqual({ status: 'completed' });
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    expect(h.transport!.requestParams.filter(entry => entry.method === 'turn/steer')).toHaveLength(1);
    await h.adapter.dispose(h.host, h.session.id);
  });

  // Ported from the v2 stream tests: the interaction and the status travel on the control path, the
  // transcript (the answered question, the failed turn) through `transcript()` into the journal.
  it('settles async questions answered elsewhere and drops them when their turn ends', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('cmd-async-elsewhere');
    const ask = (id: string, title: string) => h.transport!.emitNativeNotification('item/completed', {
      threadId: 'native-thread', turnId: 'turn-1', startedAtMs: 3,
      item: { type: 'agentMessage', id, text: '', delivery: 'async', questions: [{ title, options: ['Yes', 'No'] }] },
    });
    ask('first-ask', 'Keep the cache?');
    await waitFor(() => h.adapter.interaction(h.host, h.session)?.message === 'Keep the cache?' ? true : undefined);

    // Answered in the TUI: the reply settles the card without an answer from here.
    const reply = '<send_user_message_question_reply>\n[{"answer":"Yes","question":"Keep the cache?","questionItemId":"[\\"request_user_input_async\\",\\"first-ask\\",0]"}]\n</send_user_message_question_reply>';
    h.transport!.emitNativeNotification('item/completed', {
      threadId: 'native-thread', turnId: 'turn-1', startedAtMs: 4,
      item: { type: 'userMessage', id: 'tui-reply', content: [{ type: 'text', text: reply }] },
    });
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    expect(h.transport!.requestParams.filter(entry => entry.method === 'turn/steer')).toHaveLength(0);

    ask('second-ask', 'Delete the logs?');
    await waitFor(() => h.adapter.interaction(h.host, h.session)?.message === 'Delete the logs?' ? true : undefined);
    h.transport!.finishTurn('turn-1', 'completed');
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    expect(h.adapter.status(h.host, h.session).interaction).toBeUndefined();
    expect(h.adapter.status(h.host, h.session).activeTurnId).toBeUndefined();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('rejects web secret answers and waits for turn/completed after cancellation without inventing an answer', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.queueServerRequest({
      id: 'ask-1', method: 'item/tool/requestUserInput',
      params: { threadId: 'native-thread', turnId: 'turn-1', itemId: 'question', isBlocking: true,
        questions: [{ id: 'q', header: 'Q', question: 'Token?', isOther: true, isSecret: true, multiSelect: false, options: null }] },
    });
    await h.send('cmd-cancel');
    const interaction = await waitFor(() => h.adapter.interaction(h.host, h.session));
    expect(interaction!.actions.map(action => action.id)).toEqual(['cancel']);
    expect(interaction!.allowOther).toBe(false);
    await expect(h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: interaction!.id, revision: interaction!.revision, requestId: 'web-secret', action: 'answer', otherText: 'never-store-this-token',
    })).rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
    expect(h.getReceipt('web-secret')).toBeUndefined();
    expect(h.transport!.responses.has('ask-1')).toBe(false);

    let finished = false;
    const cancel = h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: interaction!.id, revision: interaction!.revision, requestId: 'web-cancel', action: 'cancel',
    }).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(finished).toBe(false);
    expect(h.transport!.requestParams.some(entry => entry.method === 'turn/interrupt')).toBe(true);
    expect(h.transport!.responses.has('ask-1')).toBe(false);

    h.transport!.finishTurn('turn-1');
    expect((await cancel).status).toBe('uncertain');
    expect(h.transport!.responses.has('ask-1')).toBe(false);
    await waitFor(() => h.adapter.interaction(h.host, h.session) === undefined ? true : undefined);
    expect(h.adapter.status(h.host, h.session).activeTurnId).toBeUndefined();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('returns only published command decisions, including native amendment objects, without widening an empty list', async () => {
    const h = makeHarness({ flavor: traexFlavor });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('native-decisions');
    const decisions = [
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['pnpm', 'test'] } },
      'cancel', 'accept',
      { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'registry.example', action: 'allow' } } },
      { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'blocked.example', action: 'deny' } } },
    ];
    for (const index of [0, 1, 3, 4]) {
      const nativeId = `native-decision-${index}`;
      h.transport!.resolveNativeRequest({ id: nativeId, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'native-thread', turnId: 'turn-1', itemId: 'command', command: 'pnpm test --runInBand', availableDecisions: decisions,
      } });
      const interaction = await waitFor(() => h.adapter.interaction(h.host, h.session));
      expect(interaction!.actions.map(action => action.id)).toEqual(['decision:0', 'cancel', 'approve', 'decision:3', 'decision:4']);
      const response = { interactionId: interaction!.id, revision: interaction!.revision, requestId: `web-decision-${index}`,
        action: index === 1 ? 'cancel' : `decision:${index}` };
      if (index === 0) {
        // The persistent rule is the native prefix, not this invocation's full command.
        expect(interaction!.message).toContain('pnpm test --runInBand');
        expect(interaction!.actions[0]).toMatchObject({
          label: 'Allow and remember command prefix: pnpm test', shortLabel: 'Allow and remember',
          detail: 'Matching future commands will run without prompting.\n\nCommand prefix:\npnpm test',
        });
        expect(interaction!.actions[3]?.detail).toContain('registry.example');
        expect(interaction!.actions[4]?.detail).toContain('denied');
        for (const action of ['approveForSession', 'deny', 'decision:9']) {
          await expect(h.adapter.respond(h.host, h.session, h.profile, { ...response, requestId: `invalid-${action}`, action }))
            .rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
          expect(h.getReceipt(`invalid-${action}`)).toBeUndefined();
          expect(h.transport!.responses.has(nativeId)).toBe(false);
        }
      }
      expect((await h.adapter.respond(h.host, h.session, h.profile, response)).status).toBe('completed');
      expect(h.transport!.responses.get(nativeId)).toEqual({ decision: decisions[index] });
    }
    h.transport!.resolveNativeRequest({ id: 'native-empty', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'native-thread', turnId: 'turn-1', itemId: 'empty', availableDecisions: [],
    } });
    const empty = await waitFor(() => h.adapter.interaction(h.host, h.session));
    await expect(h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: empty!.id, revision: empty!.revision, requestId: 'web-empty', action: 'approve',
    })).rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
    expect(h.getReceipt('web-empty')).toBeUndefined();
    expect(h.transport!.responses.has('native-empty')).toBe(false);
    h.transport!.notifyResolved('native-empty');
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('requires a fresh one-time human command decision and rejects session or remembered grants', async () => {
    const h = makeHarness();
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      expect(h.factoryCalls[0]?.requiredHumanApproval).toBe(true);
      await h.send('human-command');
      const remembered = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['pnpm', 'publish'] } };
      for (const [index, availableDecisions] of [undefined, ['acceptForSession', remembered, 'accept', 'decline', 'cancel'], []].entries()) {
        const id = `human-${index}`;
        const pending = h.transport!.resolveNativeRequest({ id, method: 'item/commandExecution/requestApproval', params: {
          threadId: 'native-thread', turnId: 'turn-1', itemId: id, kind: 'humanCommand', command: 'pnpm publish', availableDecisions,
        } });
        const interaction = await waitFor(() => h.adapter.interaction(h.host, h.session));
        const response = { interactionId: interaction!.id, revision: interaction!.revision, requestId: `reply-${id}`, action: 'approve' };
        expect(interaction!.actions.map(action => action.id)).toEqual(index === 2 ? [] : ['approve', 'deny', 'cancel']);
        expect(h.transport!.responses.has(id)).toBe(false);
        for (const action of index === 2 ? ['approve'] : ['approveForSession', 'decision:1']) {
          await expect(h.adapter.respond(h.host, h.session, h.profile, { ...response, requestId: `invalid-${id}-${action}`, action }))
            .rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
          expect(h.getReceipt(`invalid-${id}-${action}`)).toBeUndefined();
          expect(h.transport!.responses.has(id)).toBe(false);
        }
        if (index === 2) h.transport!.notifyResolved(id);
        else {
          expect((await h.adapter.respond(h.host, h.session, h.profile, response)).status).toBe('completed');
          expect(h.transport!.responses.get(id)).toEqual({ decision: 'accept' });
        }
        await pending;
      }
    } finally { await h.adapter.dispose(h.host, h.session.id); }
  });

  it('grants the requested permission scope with absent optional profiles omitted, never null or unrequested rights', async () => {
    const h = makeHarness({ flavor: traexFlavor });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('grant-permissions');
    const fileSystem = { read: null, write: ['/approved-root'] };
    const cases = [
      { action: 'approveForSession', permissions: { network: null, fileSystem }, expected: { permissions: { fileSystem }, scope: 'session' } },
      { action: 'approve', permissions: { network: { enabled: true }, fileSystem: null }, expected: { permissions: { network: { enabled: true } }, scope: 'turn' } },
      { action: 'deny', permissions: { network: { enabled: true }, fileSystem }, expected: { permissions: {}, scope: 'turn' } },
    ];
    for (const [index, entry] of cases.entries()) {
      const nativeId = `grant-${index}`;
      h.transport!.resolveNativeRequest({ id: nativeId, method: 'item/permissions/requestApproval', params: {
        threadId: 'native-thread', turnId: 'turn-1', itemId: 'permissions', permissions: entry.permissions,
      } });
      const interaction = await waitFor(() => h.adapter.interaction(h.host, h.session));
      expect((await h.adapter.respond(h.host, h.session, h.profile, {
        interactionId: interaction!.id, revision: interaction!.revision, requestId: `web-grant-${index}`, action: entry.action,
      })).status).toBe('completed');
      expect(h.transport!.responses.get(nativeId)).toEqual(entry.expected);
    }
    await h.adapter.dispose(h.host, h.session.id);
  });

  it.each([codexFlavor, traexFlavor])('$label routes only associated child requests and resolves equal RPC ids in their exact thread', async flavor => {
    const h = makeHarness({ flavor });
    await h.send('child-owner');
    const transport = h.transport!;
    transport.setSubagentThread('known-child', { turns: [{ id: 'child-turn', status: 'inProgress', items: [] }] });
    transport.emitNativeNotification('item/started', { threadId: 'native-thread', turnId: 'turn-1', item: { type: 'collabAgentToolCall', id: 'spawn-child', tool: 'spawnAgent', receiverThreadIds: ['known-child'], agentsStates: { 'known-child': { status: 'running' } } } });
    transport.finishTurn('turn-1', 'completed');
    expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
    const approval = (threadId: string): JsonRpcServerRequest => ({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: threadId === 'native-thread' ? 'parent-wait' : 'child-turn', itemId: `${threadId}-approval`, command: 'sleep 1', availableDecisions: ['accept', 'cancel'] } });
    await expect(transport.resolveNativeRequest(approval('foreign-thread'))).rejects.toThrow('different');
    transport.emitNativeNotification('mode/changeRequested', { threadId: 'foreign-thread', turnId: 'foreign-turn', requestId: 'foreign-mode', targetMode: 'plan' });
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    transport.deferResolved();
    const parentRequest = transport.resolveNativeRequest(approval('native-thread'));
    const parentCard = h.adapter.interaction(h.host, h.session)!;
    const childRequest = transport.resolveNativeRequest(approval('known-child'));
    const childCard = h.adapter.interaction(h.host, h.session)!;
    expect(childCard.request?.threadId).toBe('known-child');
    expect(childCard.requestId).not.toBe(parentCard.requestId);
    expect(h.adapter.status(h.host, h.session).phase).toBe('attention');
    const response = { interactionId: childCard.id, revision: childCard.revision, requestId: 'web-child-approval', action: 'approve' };
    const answering = h.adapter.respond(h.host, h.session, h.profile, response);
    await waitFor(() => transport.responses.get('0'));
    transport.notifyResolved(0, 'foreign-thread');
    expect(h.adapter.interaction(h.host, h.session)?.id).toBe(childCard.id);
    transport.notifyResolved(0, 'known-child');
    expect((await answering).status).toBe('completed');
    await childRequest;
    expect(h.adapter.interaction(h.host, h.session)?.id).toBe(parentCard.id);
    expect((await h.adapter.respond(h.host, h.session, h.profile, response)).status).toBe('completed');
    expect((await h.adapter.respond(h.host, h.session, h.profile, { interactionId: parentCard.id, revision: parentCard.revision, requestId: 'web-parent-approval', action: 'approve' })).status).toBe('completed');
    await parentRequest;
    transport.emitNativeNotification('turn/completed', { threadId: 'known-child', turn: { id: 'child-turn', status: 'completed' } });
    expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
    expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
    await h.adapter.close(h.host);
  });

  it('bounds owned-child empty-rollout initialization and reads committed history after live-owner unload without hiding other failures', async () => {
    const h = makeHarness({ flavor: traexFlavor });
    await h.send('history-child-owner');
    const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
    const transport = h.transport!;
    transport.setTurnsListAvailable(true);
    transport.setTurns([{ id: 'turn-1', status: 'inProgress', items: [] }]);
    await prime(h);
    const committed = { id: 'child-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'child-answer', text: 'COMMITTED_CHILD' }] };
    transport.setSubagentThread('history-child', { turns: [committed] });
    let failure: 'empty' | 'metadata-empty' | 'flush' | 'other' | undefined = 'empty';
    let failedThread = 'history-child';
    let legacyBroken = false;
    let legacyEmpty = false;
    let flushFailures = 0;
    let requestedPages: unknown[] = [];
    let legacyReads = 0;
    const original = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, input) => {
      const args = input as { threadId?: string; includeTurns?: boolean };
      if (method === 'thread/turns/list' && args?.threadId === failedThread && failure) {
        requestedPages.push(input);
        if (failure === 'flush' && flushFailures-- <= 0) return original(method, input);
        if (failure === 'empty') throw new Error(`failed to read thread: thread-store internal error: rollout at /tmp/rollout-${failedThread}.jsonl is empty`);
        if (failure === 'metadata-empty') throw new Error(`failed to load thread history for thread ${failedThread}: thread-store internal error: failed to read session metadata /tmp/rollout-${failedThread}.jsonl: rollout at /tmp/rollout-${failedThread}.jsonl is empty`);
        if (failure === 'flush') throw new Error(`failed to flush live thread history before paginated read: thread ${failedThread} not found`);
        throw new Error('Corrupt child history');
      }
      if (method === 'thread/read' && args?.threadId === 'history-child' && args.includeTurns) {
        legacyReads += 1;
        if (legacyBroken) throw new Error('Persisted child history is missing');
        if (legacyEmpty) return { thread: { id: 'history-child', turns: [] } };
      }
      return original(method, input);
    });
    transport.emitNativeNotification('item/started', { threadId: 'native-thread', turnId: 'turn-1', item: { type: 'collabAgentToolCall', id: 'spawn-history-child', tool: 'spawnAgent', receiverThreadIds: ['history-child'], agentsStates: { 'history-child': { status: 'running' } } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const request = { threadId: 'history-child', limit: 3, sortDirection: 'desc' as const };
    expect(await runtime.turnsPage(request)).toBeUndefined();
    failure = 'metadata-empty';
    expect(await runtime.turnsPage(request)).toBeUndefined();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    await expect(runtime.turnsPage(request)).rejects.toThrow('is empty');
    now.mockRestore();
    failedThread = 'native-thread';
    await expect(runtime.turnsPage({ ...request, threadId: failedThread })).rejects.toThrow('is empty');
    failedThread = 'foreign-thread';
    await expect(runtime.turnsPage({ ...request, threadId: failedThread })).rejects.toThrow('is empty');
    failedThread = 'history-child';
    failure = 'flush';
    const resetFlush = (failures = 2) => { flushFailures = failures; requestedPages = []; legacyReads = 0; };
    resetFlush(1);
    expect((await runtime.turnsPage({ ...request, cursor: 'native-cursor' }))?.data).toEqual([committed]);
    expect(requestedPages).toHaveLength(2);
    expect(requestedPages[1]).toEqual(requestedPages[0]);
    expect(legacyReads).toBe(0);
    // The complete-read path has exactly the same retry contract, not an earlier legacy shortcut.
    const readAll = () => (runtime as unknown as { history: { readAllTurns(threadId: string): Promise<{ turns: RpcTurn[] } | undefined> } }).history.readAllTurns('history-child');
    resetFlush(1);
    expect((await readAll())?.turns).toEqual([committed]);
    expect(requestedPages).toHaveLength(2);
    expect(requestedPages[1]).toEqual(requestedPages[0]);
    expect(legacyReads).toBe(0);
    resetFlush();
    expect((await runtime.turnsPage(request))?.data).toEqual([committed]);
    expect(legacyReads).toBe(1);
    resetFlush();
    expect((await readAll())?.turns).toEqual([committed]);
    legacyEmpty = true;
    resetFlush();
    await expect(runtime.turnsPage(request)).rejects.toThrow('failed to flush live thread history');
    resetFlush();
    await expect(readAll()).rejects.toThrow('failed to flush live thread history');
    resetFlush();
    await expect(runtime.turnsPage({ ...request, cursor: 'native-cursor' })).rejects.toThrow('failed to flush live thread history');
    expect(requestedPages[1]).toEqual(requestedPages[0]);
    expect(legacyReads).toBe(0);
    legacyEmpty = false;
    // Undefined/pending legacy results also cannot turn this exact flush error into success.
    for (const unavailable of [undefined, 'pending'] as const) {
      const legacy = vi.spyOn((runtime as unknown as { history: { readLegacyTurns(threadId: string): Promise<RpcTurn[] | 'pending' | undefined> } }).history, 'readLegacyTurns').mockResolvedValue(unavailable);
      resetFlush();
      await expect(runtime.turnsPage(request)).rejects.toThrow('failed to flush live thread history');
      resetFlush();
      await expect(readAll()).rejects.toThrow('failed to flush live thread history');
      legacy.mockRestore();
    }
    legacyBroken = true;
    resetFlush();
    await expect(runtime.turnsPage(request)).rejects.toThrow('Persisted child history is missing');
    legacyBroken = false;
    failure = 'other';
    await expect(runtime.turnsPage(request)).rejects.toThrow('Corrupt child history');
    failure = undefined;
    expect((await runtime.turnsPage(request))?.data).toEqual([committed]);
    transport.finishTurn('turn-1', 'completed');
    await h.adapter.close(h.host);
  });

  it('cancels the exact child turn and keeps child mode approval separate from the parent mode', async () => {
    const h = makeHarness({ flavor: traexFlavor });
    h.session.mode = 'plan';
    await h.send('child-mode-owner', 'GPT-5.5', 'on-request', 'Plan', 'plan');
    const transport = h.transport!;
    transport.setSubagentThread('known-child', { turns: [{ id: 'turn-1', status: 'inProgress', items: [] }] });
    transport.emitNativeNotification('item/started', { threadId: 'native-thread', turnId: 'turn-1', item: { type: 'collabAgentToolCall', id: 'spawn-child', tool: 'spawnAgent', receiverThreadIds: ['known-child'], agentsStates: { 'known-child': { status: 'running' } } } });
    transport.emitNativeNotification('turn/started', { threadId: 'known-child', turn: { id: 'turn-1' } });
    transport.deferResolved();
    const question = transport.resolveNativeRequest({ id: 'child-question', method: 'item/tool/requestUserInput', params: { threadId: 'known-child', turnId: 'turn-1', questions: [{ id: 'secret', isSecret: true, question: 'Secret?', options: null }] } });
    const card = h.adapter.interaction(h.host, h.session)!;
    let cancelled = false;
    const cancelling = h.adapter.respond(h.host, h.session, h.profile, { interactionId: card.id, revision: card.revision, requestId: 'web-child-cancel', action: 'cancel' }).then(result => { cancelled = true; return result; });
    await waitFor(() => transport.lastParams('turn/interrupt'));
    expect(transport.lastParams('turn/interrupt')).toEqual({ threadId: 'known-child', turnId: 'turn-1' });
    transport.finishTurn('turn-1', 'completed'); // The equal parent's id cannot complete the child waiter.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled).toBe(false);
    expect(h.adapter.interaction(h.host, h.session)?.id).toBe(card.id);
    transport.emitNativeNotification('turn/completed', { threadId: 'known-child', turn: { id: 'turn-1', status: 'interrupted' } });
    expect((await cancelling).status).toBe('uncertain');
    await question;
    const mode = (threadId: string) => ({ threadId, turnId: 'mode-turn', requestId: 'same-mode-id', targetMode: 'default' });
    transport.emitNativeNotification('mode/changeRequested', mode('native-thread'));
    const parentMode = h.adapter.interaction(h.host, h.session)!;
    transport.emitNativeNotification('mode/changeRequested', mode('known-child'));
    const childMode = h.adapter.interaction(h.host, h.session)!;
    expect(childMode.requestId).not.toBe(parentMode.requestId);
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'mode/change/respond');
    const answering = h.adapter.respond(h.host, h.session, h.profile, { interactionId: childMode.id, revision: childMode.revision, requestId: 'web-child-mode', action: 'approve' });
    await gate.entered;
    expect(transport.lastParams('mode/change/respond')).toEqual({ threadId: 'known-child', requestId: 'same-mode-id', decision: 'approved' });
    transport.emitNativeNotification('thread/settings/updated', { threadId: 'known-child', threadSettings: { model: 'child-model', collaborationMode: { mode: 'default' } } });
    transport.emitNativeNotification('mode/changeResolved', { ...mode('known-child'), decision: 'approved' });
    gate.release();
    expect((await answering).status).toBe('completed');
    expect(h.session.mode).toBe('plan');
    expect(h.adapter.interaction(h.host, h.session)?.id).toBe(parentMode.id);
    transport.emitNativeNotification('mode/changeResolved', { ...mode('native-thread'), decision: 'rejected' });
    expect(h.session.mode).toBe('plan');
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    await h.adapter.close(h.host);
  });

  it('validates MCP form candidates before receipts or RPC replies, preserving enums and decline/cancel', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('mcp-form');
    const schema = { type: 'object', required: ['color', 'targets'], properties: {
      color: { type: 'string', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] },
      targets: { type: 'array', minItems: 1, items: { type: 'string', enum: ['staging', 'production'] } },
    } };
    h.transport!.resolveNativeRequest({ id: 'mcp-valid', method: 'mcpServer/elicitation/request', params: { threadId: 'native-thread', turnId: 'turn-1', mode: 'form', requestedSchema: schema } });
    const card = await waitFor(() => h.adapter.interaction(h.host, h.session));
    const answer = { interactionId: card!.id, revision: card!.revision, requestId: 'web-mcp-valid', action: 'answer' };
    for (const [index, invalid] of [{}, { selectedIds: ['unknown:0'] }, { otherText: '{' }, { otherText: '{"color":"green","targets":["staging"]}' }].entries()) {
      const requestId = `invalid-mcp-${index}`;
      await expect(h.adapter.respond(h.host, h.session, h.profile, { ...answer, ...invalid, requestId })).rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
      expect(h.getReceipt(requestId)).toBeUndefined();
      expect(h.transport!.responses.has('mcp-valid')).toBe(false);
    }
    const valid = { ...answer, selectedIds: ['color:0', 'targets:0', 'targets:1'] };
    h.transport!.deferResolved();
    const answering = h.adapter.respond(h.host, h.session, h.profile, valid);
    await waitFor(() => h.transport!.responses.get('mcp-valid'));
    await expect(h.adapter.respond(h.host, h.session, h.profile, { ...answer, requestId: 'invalid-mcp-after-candidate', selectedIds: ['color:99'] })).rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
    expect(h.getReceipt('invalid-mcp-after-candidate')).toBeUndefined();
    expect((await h.adapter.respond(h.host, h.session, h.profile, { ...valid, requestId: 'valid-mcp-new-key' })).status).toBe('uncertain');
    h.transport!.notifyResolved('mcp-valid');
    expect((await answering).status).toBe('completed');
    expect(h.transport!.responses.get('mcp-valid')).toEqual({ action: 'accept', content: { color: 'red', targets: ['staging', 'production'] }, _meta: null });
    expect((await h.adapter.respond(h.host, h.session, h.profile, valid)).status).toBe('completed');
    for (const action of ['decline', 'cancel']) {
      const id = `mcp-${action}`;
      h.transport!.resolveNativeRequest({ id, method: 'mcpServer/elicitation/request', params: { threadId: 'native-thread', turnId: 'turn-1', mode: 'form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } } });
      const unsupported = await waitFor(() => h.adapter.interaction(h.host, h.session));
      expect(unsupported!.actions.some(entry => entry.id === 'answer')).toBe(false);
      expect((await h.adapter.respond(h.host, h.session, h.profile, { interactionId: unsupported!.id, revision: unsupported!.revision, requestId: `web-${id}`, action })).status).toBe('completed');
      expect(h.transport!.responses.get(id)).toEqual({ action, content: null, _meta: null });
    }
    await h.adapter.close(h.host);
  });

  it('maps approval choices to the Codex response vocabulary and journals a failed turn with its reason redacted', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.queueServerRequest({
      id: 'approval-1', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'native-thread', turnId: 'turn-1', itemId: 'command', command: 'git status', cwd: '/tmp/codex-protocol-smoke', kind: 'command' },
    });
    await h.send('cmd-approval');
    const interaction = await waitFor(() => h.adapter.interaction(h.host, h.session));
    // A TUI scan that cannot verify its endpoint blocks new writes, never the reply to a request this
    // socket holds; the answer reports completed once the provider says the request is resolved.
    h.setTerminalEndpoint(undefined);
    const answered = await h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: interaction!.id, revision: interaction!.revision, requestId: 'web-approval', action: 'approveForSession',
    });
    expect(answered.status).toBe('completed');
    h.setTerminalEndpoint(h.transport!.remoteAddress);
    const response = await waitFor(() => h.transport!.responses.get('approval-1'));
    expect(response).toEqual({ decision: 'acceptForSession' });
    await waitFor(() => h.adapter.interaction(h.host, h.session) === undefined ? true : undefined);

    const secret = `The selected model is unavailable: sk-codex-test-secret-123456789 Bearer very-secret-bearer-token-987 http://127.0.0.1:12345/${'a'.repeat(64)}/api/ide/v2/llm_raw_chat`;
    const failedTurn = {
      id: 'turn-1', status: 'failed', startedAt: 1, completedAt: 2, error: { message: secret },
      items: [{ type: 'userMessage', id: 'native-user-1', clientId: 'cmd-approval', content: [{ type: 'text', text: 'Inspect this project' }] }],
    };
    h.transport!.setThreadStatus('systemError');
    h.transport!.setTurns([failedTurn]);
    h.transport!.setTurnsListAvailable(true);
    h.transport!.finishTurn('turn-1', 'failed', { items: failedTurn.items, error: failedTurn.error });
    const status = h.adapter.status(h.host, h.session);
    expect(status.phase).toBe('idle');
    // Failed turns belong to durable turn metadata, not the current session notice.
    expect(status.notice).toBeUndefined();
    expect(status.noticeLevel).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain('sk-codex-test-secret-123456789');

    // What the dispatcher settles the Run from: the turn's end mark in the journal, after the message.
    // (A journal of its own: without the service's ingest this harness's runtime still logs for itself.)
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, h.session.id);
    const source = h.adapter.transcript(h.host, h.session, h.profile);
    for (let pulls = 0; !(await pullLane(source, writer, new AbortController().signal)).caughtUp; pulls += 1) expect(pulls).toBeLessThan(20);
    const rows = rowsOf(journal, h.session.id);
    const message = rows.findIndex(row => row.kind === 'user_message_chunk' && row.turnId === 'turn-1');
    const ended = rows.findIndex(row => row.kind === 'meta.turn_ended' && row.turnId === 'turn-1');
    expect(message).toBeGreaterThanOrEqual(0);
    expect(ended).toBeGreaterThan(message);
    const error = (rows[ended]!.payload as { status: string; error?: string });
    expect(error.status).toBe('failed');
    expect(error.error).toContain('selected model is unavailable');
    for (const leaked of ['sk-codex-test-secret-123456789', 'very-secret-bearer-token-987', 'a'.repeat(64)]) expect(JSON.stringify(rows)).not.toContain(leaked);
    await h.adapter.dispose(h.host, h.session.id);
  });

  describe('context window', () => {
    async function listening(h: ReturnType<typeof makeHarness>) {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const messages: NativeControlMessage[] = [];
      const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, message => messages.push(message));
      await waitFor(() => messages.some(message => message.type === 'status') ? true : undefined);
      const contexts = () => messages.flatMap(message => message.type === 'context' && message.context ? [message.context] : []);
      return { contexts, unsubscribe };
    }

    it('reports the context window the provider states, in the meter shape', async () => {
      const h = makeHarness();
      const { contexts, unsubscribe } = await listening(h);
      // `ThreadTokenUsage` is `{ total, last, modelContextWindow }`; `last.totalTokens` is the last
      // request's whole prompt plus its output, which is what the next request carries.
      h.transport!.emitNativeNotification('thread/tokenUsage/updated', {
        threadId: 'native-thread', turnId: 'turn-1',
        tokenUsage: {
          last: { cachedInputTokens: 27_648, inputTokens: 29_503, outputTokens: 2_166, totalTokens: 31_669 },
          total: { totalTokens: 99_640 },
          modelContextWindow: 486_400,
        },
      });
      expect(await waitFor(() => contexts()[0])).toEqual({
        used: 31_669,
        size: 486_400,
        breakdown: [
          { id: 'cached_input', label: '缓存输入', tokens: 27_648 },
          { id: 'input', label: '未缓存输入', tokens: 1_855 },
          { id: 'output', label: '输出', tokens: 2_166 },
        ],
      });
      unsubscribe();
      await h.adapter.dispose(h.host, h.session.id);
    });

    it('takes the window from the thread rollout when the provider states none', async () => {
      // A provider profile whose catalog does not say how wide the model's window is leaves
      // `modelContextWindow` null, and a resumed thread reports no usage at all until its next turn.
      // The rollout has the number Codex itself wrote, so the meter is drawn from it.
      const threadId = '01a11b9b-9b5d-7303-8091-b6e4d2afea96';
      const codexHome = await mkdtemp(join(tmpdir(), 'riffet-codex-'));
      try {
        const day = join(codexHome, 'sessions', '2026', '10', '09');
        await mkdir(day, { recursive: true });
        await writeFile(join(day, `rollout-2026-10-09T00-00-00-${threadId}.jsonl`), `${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 29_503, output_tokens: 2_166, total_tokens: 31_669 }, model_context_window: 486_400 } },
        })}\n`);
        const h = makeHarness({ threadId, configDir: codexHome });
        const { contexts, unsubscribe } = await listening(h);
        h.transport!.emitNativeNotification('thread/tokenUsage/updated', {
          threadId, turnId: 'turn-1',
          tokenUsage: { last: { totalTokens: 33_000 }, total: { totalTokens: 120_000 } },
        });
        // The live frame's occupancy, the rollout's window: neither is dropped for the other.
        expect(await waitFor(() => contexts().find(context => context.size === 486_400 && context.used === 33_000)))
          .toEqual({ used: 33_000, size: 486_400, breakdown: [] });
        unsubscribe();
        await h.adapter.dispose(h.host, h.session.id);
      } finally { await rm(codexHome, { recursive: true, force: true }); }
    });

    it('records cache writes and fills the meter breakdown from thread/contextUsage', async () => {
      const h = makeHarness({ flavor: traexFlavor });
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      h.transport!.setContextUsage({ source: 'traeChatGateway', calibrated: false, categories: [{ kind: 'systemPrompt', tokens: 5_000 }, { kind: 'userMessages', tokens: 200 }, { kind: 'otherMessages', tokens: 0 }] });
      const { contexts, unsubscribe } = await listening(h);
      await h.send('cmd-usage', 'GPT-5.5');
      h.transport!.emitNativeNotification('thread/tokenUsage/updated', {
        threadId: 'native-thread', turnId: 'turn-1',
        tokenUsage: { last: { inputTokens: 1_200, cachedInputTokens: 200, cacheCreationInputTokens: 300, outputTokens: 40, totalTokens: 1_240 }, modelContextWindow: 272_000 },
      });
      h.transport!.finishTurn('turn-1', 'completed');
      const recorded = await waitFor(() => h.usage[0]);
      expect(recorded.usage).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 200, cacheWriteTokens: 300 });
      expect(await waitFor(() => contexts().find(context => context.breakdown?.length))).toEqual({ used: 1_240, size: 272_000, breakdown: [
        { id: 'systemPrompt', label: 'System prompt', tokens: 5_000 },
        { id: 'userMessages', label: 'Your messages', tokens: 200 },
      ] });
      unsubscribe();
      await h.adapter.dispose(h.host, h.session.id);
    });
  });

  it('records settled Codex usage with cache subtracted from input, and not before the turn ends', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('cmd-usage');
    h.transport!.emitNativeNotification('thread/tokenUsage/updated', {
      threadId: 'native-thread', turnId: 'turn-1',
      tokenUsage: {
        last: { cachedInputTokens: 200, inputTokens: 1_200, outputTokens: 40, reasoningOutputTokens: 7, totalTokens: 1_240 },
      },
    });
    expect(h.usage).toEqual([]);
    h.transport!.finishTurn('turn-1', 'completed');
    const recorded = await waitFor(() => h.usage[0]);
    expect(recorded.sessionId).toBe(h.session.id);
    expect(recorded.runId).toBe('run-cmd-usage');
    expect(recorded.usage).toMatchObject({
      stepId: 'turn:turn-1',
      model: 'gpt-5-codex',
      inputTokens: 1_000,
      cacheReadTokens: 200,
      outputTokens: 40,
      reasoningTokens: 7,
      tokenSource: 'provider',
    });
    expect(recorded.usage.cacheWriteTokens).toBeUndefined();
    expect(recorded.usage.startedAt).toBeTypeOf('number');
    expect(recorded.usage.endedAt).toBeTypeOf('number');
    await h.adapter.dispose(h.host, h.session.id);
  });

});

describe('Codex reconnects', () => {
  const journalOfSession = (h: ReturnType<typeof makeHarness>) => () => rowsOf(h.host.journal!, h.session.id);
  const endMarks = (h: ReturnType<typeof makeHarness>, turnId: string) =>
    journalOfSession(h)().filter(row => row.kind === 'meta.turn_ended' && row.turnId === turnId);
  const terminalRuns = (h: ReturnType<typeof makeHarness>) =>
    journalOfSession(h)().filter(row => row.kind === 'run_completed' || row.kind === 'run_failed');

  it.each([codexFlavor, traexFlavor].flatMap(flavor => ['completed', 'failed', 'interrupted'].map(outcome => ({ flavor, outcome }))))('$flavor.label recovers a lost $outcome completion and starts the next ordinary turn', async ({ flavor, outcome }) => {
    const h = makeHarness({ flavor });
    try {
      await h.send('lost-completion');
      const interrupted = h.adapter.interrupt(h.host, h.session, h.profile);
      await waitFor(() => h.transport!.lastParams('turn/interrupt') ? true : undefined);
      h.transport!.setThreadStatus(outcome === 'interrupted' ? 'idle' : 'active');
      h.transport!.setTurns([{
        id: 'turn-1', status: outcome, startedAt: 1, completedAt: 2,
        items: [{ type: 'userMessage', id: flavor.id === 'traex' ? 'riffet-lost-completion' : 'user-lost', clientId: 'lost-completion', content: [{ type: 'text', text: 'Inspect this project' }] }],
      }]);
      await prime(h);
      await expect(interrupted).resolves.toBeUndefined();
      expect(h.adapter.status(h.host, h.session).phase).toBe(outcome === 'interrupted' || flavor.id === 'traex' ? 'idle' : 'busy');
      expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
      expect(endMarks(h, 'turn-1')).toHaveLength(1);
      await h.send('next-after-lost');
      expect(h.transport!.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(2);
      expect(h.transport!.lastParams('turn/steer')).toBeUndefined();
      expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'turn-2' } });
    } finally { await h.adapter.close(h.host); }
  });

  it.each([codexFlavor, traexFlavor])('$label recovers native work past a foreground end outside the routine tail', async flavor => {
    const h = makeHarness({ flavor });
    h.host.transcript = {} as NonNullable<NativeBackendHost['transcript']>;
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const transport = h.transport!;
      transport.setPagedTurns();
      transport.setThreadStatus('active');
      transport.setTurns([{ id: 'native-end', status: 'completed', items: [] }]);
      transport.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'native-end' } });
      transport.finishTurn('native-end', 'completed');
      await prime(h);
      const source = h.adapter.transcript(h.host, h.session, h.profile);
      const writer = JournalLaneWriter.open(h.host.journal!, h.session.id);
      const signal = new AbortController().signal;
      await pullLane(source, writer, signal);
      transport.setTurns([
        { id: 'native-end', status: 'completed', items: [] },
        { id: 'native-next-1', status: 'completed', items: [] },
        { id: 'native-next-2', status: 'completed', items: [] },
        { id: 'native-next-3', status: 'inProgress', items: [] },
      ]);
      await pullLane(source, writer, signal);
      await prime(h);
      expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'native-next-3' } });
      await h.send('after-tail-gap');
      expect(transport.lastParams('turn/start')).toBeUndefined();
      expect(transport.lastParams('turn/steer')).toMatchObject({ expectedTurnId: 'native-next-3' });
    } finally { await h.adapter.close(h.host); }
  });

  it.each([codexFlavor, traexFlavor])('$label reselects an ordinary send after the final terminal await but rejects an expired explicit steer', async flavor => {
    const h = makeHarness({ flavor });
    try {
      await h.send('before-terminal-await');
      const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
      runtime.terminalId = 'fixture-terminal';
      const deferTerminal = () => {
        let entered!: () => void;
        let release!: () => void;
        const hit = new Promise<void>(resolve => { entered = resolve; });
        const wait = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(h.host.terminal, 'get').mockImplementationOnce(async () => { entered(); await wait; return { id: 'fixture-terminal', state: 'running' } as never; });
        return { hit, release };
      };
      const gate = deferTerminal();
      const sending = runtime.send({ runId: 'ordinary-run', commandId: 'ordinary-next', renderedText: 'Continue', input: [], config: { model: 'gpt-5-codex', mode: 'code' }, nativeSessionId: 'native-thread', commitDispatchFence: () => ({}) });
      await gate.hit;
      h.transport!.finishTurn('turn-1', 'completed');
      gate.release();
      await sending;
      expect(h.transport!.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(2);
      expect(h.transport!.lastParams('turn/steer')).toBeUndefined();
      const target = runtime.steerTarget!;
      const explicitGate = deferTerminal();
      const steering = runtime.steer({ runId: 'explicit-run', commandId: 'explicit-next', renderedText: 'Steer', input: [], target, commitDispatchFence: () => ({}) });
      await explicitGate.hit;
      h.transport!.finishTurn('turn-2', 'completed');
      explicitGate.release();
      await expect(steering).rejects.toMatchObject({ code: 'STEER_TARGET_CHANGED' });
      expect(h.transport!.lastParams('turn/steer')).toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it.each([codexFlavor, traexFlavor])('$label does not revive a fast completed or failed turn when its acknowledgement arrives', async flavor => {
    const h = makeHarness({ flavor });
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      for (const outcome of ['completed', 'failed'] as const) {
        const gate = h.deferEndpointRequest(h.transport!.remoteAddress, 'turn/start');
        const sending = h.send(`fast-${outcome}`);
        await gate.entered;
        const id = outcome === 'completed' ? 'turn-1' : 'turn-2';
        h.transport!.finishTurn(id, outcome, { error: { message: 'Fast provider failure' } });
        gate.release();
        await sending;
        expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
        expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
        expect(h.adapter.status(h.host, h.session).notice).toBeUndefined();
      }
      const gate = h.deferEndpointRequest(h.transport!.remoteAddress, 'turn/start');
      const sending = h.send('older-ack');
      await gate.entered;
      h.transport!.finishTurn('turn-3', 'completed');
      h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'native-after-ack' } });
      gate.release();
      await sending;
      expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'native-after-ack' } });
      h.transport!.finishTurn('native-after-ack', 'completed');
      const endedGate = h.deferEndpointRequest(h.transport!.remoteAddress, 'turn/start');
      const olderSending = h.send('ack-before-newer-end');
      await endedGate.entered;
      h.transport!.finishTurn('turn-4', 'completed');
      h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'newer-ended' } });
      h.transport!.finishTurn('newer-ended', 'completed');
      endedGate.release();
      await olderSending;
      // The old acknowledgement cannot move the newer native end fence backwards either.
      h.transport!.setTurns([{ id: 'newer-ended', status: 'inProgress', items: [] }]);
      await prime(h);
      await h.send('after-newer-end');
      expect(h.transport!.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(5);
      expect(h.transport!.lastParams('turn/steer')).toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it('requires a second list for a completed Codex command without an exit code and honors a real exit', async () => {
    const h = makeHarness();
    let unsubscribe = () => {};
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const transport = h.transport!;
      const terminal = { processId: 'codex-pty', itemId: 'codex-shell', command: 'sleep 120', cwd: h.project.cwd };
      transport.setTerminals([terminal]);
      const item = { type: 'commandExecution', id: terminal.itemId, processId: terminal.processId, command: terminal.command, status: 'completed' };
      transport.emitNativeNotification('item/completed', { threadId: 'native-thread', turnId: 'native-turn', item });
      unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, () => undefined);
      const lists = () => transport.requestParams.filter(request => request.method === 'thread/backgroundTerminals/list').length;
      await waitFor(() => lists() === 1 ? true : undefined);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(h.adapter.status(h.host, h.session).activity?.background).toBeUndefined();
      await waitFor(() => h.adapter.status(h.host, h.session).activity?.background === 1 ? true : undefined);
      expect(lists()).toBe(2);
      transport.emitNativeNotification('item/completed', { threadId: 'native-thread', turnId: 'native-turn', item: { ...item, exitCode: 0 } });
      await waitFor(() => h.adapter.status(h.host, h.session).activity?.background === undefined ? true : undefined);
      // The process is still listed, but its terminal item carries a real exit code.
      const activity = h.host.journal!.activityEntities(h.session.id).map(entity => activityOfEvent(entity.payload)).find(entry => entry?.id === 'codex:terminal:codex-pty');
      expect(activity?.status).toBe('completed');
    } finally { unsubscribe(); await h.adapter.close(h.host); }
  });

  it('keeps a running turn open when its socket drops and settles it over the recovered writer', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const binding = h.session.nativeRuntime!;
    await h.send('cmd-live');
    const first = h.transport!;
    expect(journalOfSession(h)().some(row => row.kind === 'meta.turn_started' && row.turnId === 'turn-1')).toBe(true);
    expect(endMarks(h, 'turn-1')).toHaveLength(0);

    // Losing the socket is not evidence that the provider ended the turn.
    first.disconnect();
    expect(h.adapter.status(h.host, h.session).phase).toBe('offline');
    expect(endMarks(h, 'turn-1')).toHaveLength(0);
    expect(terminalRuns(h)).toHaveLength(0);

    // The recovered connection is the saved writer, and the native process is kept running.
    first.setThreadStatus('active');
    first.setTurns([{
      id: 'turn-1', status: 'inProgress', startedAt: 1,
      items: [{ type: 'userMessage', id: 'user-live', clientId: 'cmd-live', content: [{ type: 'text', text: 'Inspect this project' }] }],
    }]);
    await prime(h);
    const second = h.transport!;
    expect(second).not.toBe(first);
    expect(second.remoteAddress).toBe(binding.address);
    expect(first.detached).toBe(true);
    expect(first.disposed).toBe(false);
    // A read while the turn is still running must not write its end.
    expect(endMarks(h, 'turn-1')).toHaveLength(0);

    // Output and the turn's own end arrive on the recovered connection.
    const completed = {
      id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2,
      items: [
        { type: 'userMessage', id: 'user-live', clientId: 'cmd-live', content: [{ type: 'text', text: 'Inspect this project' }] },
        { type: 'agentMessage', id: 'answer-live', text: 'Recovered answer' },
      ],
    };
    second.setTurns([completed]);
    second.setThreadStatus('idle');
    second.emitNativeNotification('item/completed', {
      threadId: 'native-thread', turnId: 'turn-1', startedAtMs: 2, item: completed.items[1],
    });
    second.finishTurn('turn-1', 'completed', { items: completed.items });
    await waitFor(() => endMarks(h, 'turn-1').length ? true : undefined);

    expect(endMarks(h, 'turn-1')).toHaveLength(1);
    expect(journalOfSession(h)().some(row => row.kind === 'agent_message_chunk' && row.turnId === 'turn-1'
      && JSON.stringify(row.payload).includes('Recovered answer'))).toBe(true);
    expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
    await h.adapter.close(h.host);
  });

  it('does not end a turn whose app-server died while the provider still reports it running', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('cmd-crash');
    const first = h.transport!;
    first.disconnect();
    expect(h.adapter.status(h.host, h.session).phase).toBe('offline');
    expect(endMarks(h, 'turn-1')).toHaveLength(0);
    expect(terminalRuns(h)).toHaveLength(0);

    // The recovered writer still owns the thread, which still says the turn is running.
    first.setThreadStatus('active');
    first.setTurns([{
      id: 'turn-1', status: 'inProgress', startedAt: 1,
      items: [{ type: 'userMessage', id: 'user-crash', clientId: 'cmd-crash', content: [{ type: 'text', text: 'Inspect this project' }] }],
    }]);
    await prime(h);
    await prime(h);
    expect(endMarks(h, 'turn-1')).toHaveLength(0);
    expect(terminalRuns(h)).toHaveLength(0);

    // When the provider finally reports the end, the recovery read settles it exactly once.
    first.setTurns([{
      id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2,
      items: [{ type: 'userMessage', id: 'user-crash', clientId: 'cmd-crash', content: [{ type: 'text', text: 'Inspect this project' }] }],
    }]);
    h.transport!.finishTurn('turn-1', 'completed', { items: [{
      type: 'userMessage', id: 'user-crash', clientId: 'cmd-crash', content: [{ type: 'text', text: 'Inspect this project' }],
    }] });
    await waitFor(() => endMarks(h, 'turn-1').length ? true : undefined);
    expect(endMarks(h, 'turn-1')).toHaveLength(1);
    await h.adapter.close(h.host);
  });

  it('keeps the pre-write fence when the connection dies mid-send and never replays the message', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const first = h.transport!;
    const binding = h.session.nativeRuntime!;
    const baseline = h.host.journal?.peek(h.session.id)?.lastSeq ?? 0;
    const gate = h.deferEndpointRequest(first.remoteAddress, 'turn/start');

    const sending = h.send('cmd-first').catch(error => error as Error);
    await gate.entered;
    // The fence is durable before the write reaches the provider.
    expect(h.dispatchFences).toEqual([{ baselineSequence: baseline }]);
    expect(first.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(1);

    // The provider took the message, but its answer is lost with the socket.
    first.disconnect();
    gate.release();
    expect(await sending).toBeInstanceOf(Error);

    // Rebuilding resumes the saved writer; the message the fence covers is not sent again.
    // Both connections share the endpoint's request log, so count the writes made since the read.
    const startsBeforeRewrite = first.requestParams.filter(request => request.method === 'turn/start').length;
    await prime(h);
    const second = h.transport!;
    expect(second).not.toBe(first);
    expect(second.remoteAddress).toBe(binding.address);
    expect(second.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(startsBeforeRewrite);
    expect(h.dispatchFences).toEqual([{ baselineSequence: baseline }]);

    // A different command still writes exactly once on the recovered connection.
    await h.send('cmd-second');
    const starts = second.requestParams.filter(request => request.method === 'turn/start');
    expect(starts).toHaveLength(startsBeforeRewrite + 1);
    expect(starts.at(-1)!.params.clientUserMessageId).toBe('cmd-second');
    expect(h.dispatchFences).toHaveLength(2);
    await h.adapter.close(h.host);
  });

  it('rebinds an existing subscriber to the recovered connection and ignores the dead socket afterwards', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const binding = h.session.nativeRuntime!;
    const messages: NativeControlMessage[] = [];
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, message => messages.push(message));
    await waitFor(() => messages.some(message => message.type === 'status') ? true : undefined);
    await h.send('cmd-before');
    const first = h.transport!;
    first.disconnect();

    // The service's next read (a watch or a lane pull) reconnects and rebinds the same listeners.
    await prime(h);
    const second = h.transport!;
    expect(second).not.toBe(first);
    expect(second.remoteAddress).toBe(binding.address);
    messages.length = 0;
    second.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'turn-2' } });
    await waitFor(() => messages.some(message => message.type === 'status' && message.status.phase === 'busy') ? true : undefined);

    // A late completion on the dead connection is the old turn's; it cannot settle the new one.
    first.finishTurn('turn-1', 'completed');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(endMarks(h, 'turn-2')).toHaveLength(0);
    expect(h.adapter.status(h.host, h.session).phase).toBe('busy');
    expect(messages.filter(message => message.type === 'status').at(-1)?.status.phase).toBe('busy');

    // Output and the end of the new turn are delivered over the new connection.
    const turnTwo = {
      id: 'turn-2', status: 'completed', startedAt: 1, completedAt: 2,
      items: [{ type: 'agentMessage', id: 'answer-2', text: 'After reconnect' }],
    };
    second.setTurns([
      { id: 'turn-1', status: 'inProgress', startedAt: 1, items: [] },
      turnTwo,
    ]);
    second.emitNativeNotification('item/completed', {
      threadId: 'native-thread', turnId: 'turn-2', startedAtMs: 2, item: turnTwo.items[0],
    });
    second.finishTurn('turn-2', 'completed', { items: turnTwo.items });
    await waitFor(() => messages.some(message => message.type === 'status' && message.status.phase === 'idle') ? true : undefined);
    expect(journalOfSession(h)().some(row => row.kind === 'agent_message_chunk' && row.turnId === 'turn-2'
      && JSON.stringify(row.payload).includes('After reconnect'))).toBe(true);

    // The dead connection no longer reaches the subscriber.
    messages.length = 0;
    first.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'turn-3' } });
    first.finishTurn('turn-3', 'completed');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(messages).toEqual([]);
    expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
    unsubscribe();
    await h.adapter.close(h.host);
  });

  it('does not reuse a pending runtime created for another profile', async () => {
    const h = makeHarness();
    h.session.nativeSessionId = 'native-thread';
    h.session.cursorSessionId = 'native-thread';
    const gate = h.deferNextFactory();
    const messages: NativeControlMessage[] = [];
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, message => messages.push(message));
    const firstOptions = await gate.entered;
    expect(firstOptions.executable).toBe(h.profile.config.executable);

    const changedProfile: NativeBackendProfileConfig = {
      ...h.profile,
      config: { ...h.profile.config, executable: '/different-pending-profile-cli' },
    };
    const openingChangedProfile = h.adapter.openOrResume(h.host, h.session, h.project, changedProfile);
    gate.release();
    await waitFor(() => h.factoryCalls.some(options => options.executable === changedProfile.config.executable) ? true : undefined);
    const opened = await openingChangedProfile;

    // The runtime built for the first profile is not handed to the other one.
    expect(opened.status?.connection?.state).toBe('connected');
    expect(h.factoryCalls.some(options => options.executable === changedProfile.config.executable)).toBe(true);
    expect(h.transport?.lastParams('thread/resume')?.threadId).toBe('native-thread');
    expect(h.session.nativeRuntime?.address).toBe(h.transport?.remoteAddress);
    unsubscribe();
    await h.adapter.close(h.host);
  });

  it('reads cold stored history without taking writer ownership, then attaches when sending', async () => {
    const h = makeHarness();
    h.session.nativeSessionId = 'native-thread';
    h.session.cursorSessionId = 'native-thread';
    const endpoint = 'unix:///cold-thread-reader.sock';
    const reader = h.registerEndpoint(endpoint);
    reader.setTurns([{
      id: 'stored-turn', status: 'completed', startedAt: 1,
      items: [
        { type: 'userMessage', id: 'stored-user', clientId: 'stored-command', content: [{ type: 'text', text: 'Read stored history' }] },
        { type: 'agentMessage', id: 'stored-answer', text: 'This thread was already saved' },
      ],
    }]);
    h.session.nativeRuntime = makeBinding(h, endpoint);

    await prime(h);
    expect(journalOfSession(h)().some(row => row.kind === 'agent_message_chunk'
      && JSON.stringify(row.payload).includes('This thread was already saved'))).toBe(true);
    expect(h.adapter.status(h.host, h.session).connection?.state).toBe('disconnected');
    expect(h.transport?.requestParams.some(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method))).toBe(false);

    // A send is what turns the reader into the writer.
    await h.send('cmd-after-cold-history');
    expect(h.transport?.lastParams('thread/resume')?.threadId).toBe('native-thread');
    expect(h.transport?.lastParams('thread/start')).toBeUndefined();
    expect(h.transport?.lastParams('turn/start')?.threadId).toBe('native-thread');
    expect(h.session.nativeRuntime?.address).toBe(h.transport?.remoteAddress);
    await h.adapter.close(h.host);
  });

  it('requires a fresh loaded-thread proof before an observer resumes a cached loaded owner', async () => {
    const h = makeHarness();
    h.session.nativeSessionId = 'native-thread';
    h.session.cursorSessionId = 'native-thread';
    const endpoint = 'unix:///observer-stale-loaded-proof.sock';
    const owner = h.registerEndpoint(endpoint);
    owner.setLoadedThreads(['native-thread']);
    h.session.nativeRuntime = makeBinding(h, endpoint);

    await prime(h);
    const loadedLists = () => owner.requestParams.filter(request => request.method === 'thread/loaded/list').length;
    expect(loadedLists()).toBeGreaterThanOrEqual(1);
    // The owner no longer says the thread is loaded: the cached yes must not resume it.
    owner.setLoadedThreads([]);

    const messages: NativeControlMessage[] = [];
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, message => messages.push(message));
    await waitFor(() => messages.some(message => message.type === 'status') ? true : undefined);
    expect(loadedLists()).toBeGreaterThan(1);
    expect(owner.requestParams.some(request => request.method === 'thread/resume')).toBe(false);
    expect(h.adapter.status(h.host, h.session).connection?.state).toBe('disconnected');

    // New evidence of a loaded owner is what lets the observer attach.
    owner.setLoadedThreads(['native-thread']);
    const runtime = await (h.adapter as unknown as {
      ensureRuntime(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<{ attachLoadedOwner(): Promise<void> }>;
    }).ensureRuntime(h.host, h.session, h.project, h.profile);
    await runtime.attachLoadedOwner();
    expect(owner.requestParams.filter(request => request.method === 'thread/resume')).toHaveLength(1);
    expect(h.adapter.status(h.host, h.session).connection?.state).toBe('connected');
    unsubscribe();
    await h.adapter.close(h.host);
  });
});

describe('Codex request generation windows', () => {
  async function metering() {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const messages: NativeControlMessage[] = [];
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, message => messages.push(message));
    await waitFor(() => messages.some(message => message.type === 'status') ? true : undefined);
    return { h, messages, unsubscribe };
  }

  it('sums two one-second responses around a two-minute tool, preserving the real 122-second interval', async () => {
    const { h, messages, unsubscribe } = await metering();
    await h.send('cmd-window');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const emit = (method: string, params: Record<string, unknown>) => h.transport!.emitNativeNotification(method, { threadId: 'native-thread', turnId: 'turn-1', ...params });
    try {
      emit('item/agentMessage/delta', { itemId: 'answer-1', delta: 'x'.repeat(400) });
      clock.mockReturnValue(start + 1_000);
      emit('item/agentMessage/delta', { itemId: 'answer-1', delta: 'x'.repeat(400) });
      emit('thread/tokenUsage/updated', { tokenUsage: { last: { outputTokens: 40 }, total: { outputTokens: 1_040 } } });
      emit('item/started', { item: { type: 'commandExecution', id: 'tool', command: 'sleep 120', status: 'inProgress' } });
      clock.mockReturnValue(start + 121_000);
      emit('item/completed', { item: { type: 'commandExecution', id: 'tool', command: 'sleep 120', status: 'completed', aggregatedOutput: '', exitCode: 0 } });
      emit('item/agentMessage/delta', { itemId: 'answer-2', delta: 'x'.repeat(400) });
      clock.mockReturnValue(start + 122_000);
      emit('item/agentMessage/delta', { itemId: 'answer-2', delta: 'x'.repeat(400) });
      const live = messages.flatMap(message => message.type === 'metrics' && message.metrics.live ? [message.metrics] : []).at(-1);
      expect(live).toMatchObject({ startedAt: start, endedAt: start + 122_000, durationMs: 2_000, window: 'stream' });
      emit('thread/tokenUsage/updated', { tokenUsage: { last: { outputTokens: 60 }, total: { outputTokens: 1_100 } } });
      // Repeated accounting and completion frames cannot add time or double the final tokens.
      clock.mockReturnValue(start + 132_000);
      emit('thread/tokenUsage/updated', { tokenUsage: { last: { outputTokens: 60 }, total: { outputTokens: 1_100 } } });
      h.transport!.finishTurn('turn-1', 'completed');
      h.transport!.finishTurn('turn-1', 'completed');
      const settled = messages.flatMap(message => message.type === 'metrics' && !message.metrics.live ? [message] : []).at(-1);
      expect(settled?.metrics).toMatchObject({ outputTokens: 100, tokens: 'provider', durationMs: 2_000, startedAt: start, endedAt: start + 122_000 });
      expect(settled?.run).toMatchObject({ outputTokens: 100, durationMs: 2_000, steps: 1 });
      expect(h.usage).toHaveLength(1);
      expect(h.usage[0]?.usage).toMatchObject({ stepId: 'turn:turn-1', outputTokens: 100, durationMs: 2_000, startedAt: start, endedAt: start + 122_000 });
    } finally {
      clock.mockRestore(); unsubscribe(); await h.adapter.dispose(h.host, h.session.id);
    }
  });

  it('uses an observed interval for an unstreamed tool-call request without counting its tool wait', async () => {
    const { h, messages, unsubscribe } = await metering();
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const emit = (method: string, params: Record<string, unknown>) => h.transport!.emitNativeNotification(method, { threadId: 'native-thread', turnId: 'external', ...params });
    try {
      h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'external' } });
      clock.mockReturnValue(start + 1_000);
      emit('item/started', { item: { type: 'commandExecution', id: 'tool', command: 'sleep 120', status: 'inProgress' } });
      emit('thread/tokenUsage/updated', { tokenUsage: { last: { outputTokens: 40 }, total: { outputTokens: 40 } } });
      clock.mockReturnValue(start + 121_000);
      emit('item/completed', { item: { type: 'commandExecution', id: 'tool', command: 'sleep 120', status: 'completed', exitCode: 0 } });
      emit('item/agentMessage/delta', { itemId: 'answer', delta: 'x'.repeat(100) });
      clock.mockReturnValue(start + 122_000);
      emit('item/agentMessage/delta', { itemId: 'answer', delta: 'x'.repeat(100) });
      emit('thread/tokenUsage/updated', { tokenUsage: { last: { outputTokens: 60 }, total: { outputTokens: 100 } } });
      // A delayed tool item for this already-accounted request must not add another interval.
      clock.mockReturnValue(start + 132_000);
      emit('item/started', { item: { type: 'commandExecution', id: 'next-tool', command: 'pwd', status: 'inProgress' } });
      h.transport!.finishTurn('external', 'completed');
      expect(messages.flatMap(message => message.type === 'metrics' && !message.metrics.live ? [message.metrics] : []).at(-1))
        .toMatchObject({ outputTokens: 100, tokens: 'provider', durationMs: 2_000, window: 'observed', startedAt: start, endedAt: start + 122_000 });
    } finally {
      clock.mockRestore(); unsubscribe(); await h.adapter.dispose(h.host, h.session.id);
    }
  });

  it('excludes an explicit approval wait from the generation denominator', async () => {
    const { h, messages, unsubscribe } = await metering();
    await h.send('cmd-approval-window');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const delta = (itemId: string) => h.transport!.emitNativeNotification('item/agentMessage/delta', { threadId: 'native-thread', turnId: 'turn-1', itemId, delta: 'x'.repeat(100) });
    try {
      delta('first'); clock.mockReturnValue(start + 1_000); delta('first');
      h.transport!.resolveNativeRequest({ id: 'approval-window', method: 'item/commandExecution/requestApproval',
        params: { threadId: 'native-thread', turnId: 'turn-1', itemId: 'command', command: 'git status', cwd: h.project.cwd, kind: 'command' } });
      clock.mockReturnValue(start + 121_000);
      h.transport!.notifyResolved('approval-window');
      delta('second'); clock.mockReturnValue(start + 122_000); delta('second');
      h.transport!.finishTurn('turn-1', 'completed');
      expect(messages.flatMap(message => message.type === 'metrics' && !message.metrics.live ? [message.metrics] : []).at(-1))
        .toMatchObject({ durationMs: 2_000, startedAt: start, endedAt: start + 122_000 });
    } finally {
      clock.mockRestore(); unsubscribe(); await h.adapter.dispose(h.host, h.session.id);
    }
  });

  it('includes an unstreamed answer completion after streamed reasoning, reporting the weaker observed window', async () => {
    const { h, messages, unsubscribe } = await metering();
    await h.send('cmd-mixed-delivery');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const thinking = () => h.transport!.emitNativeNotification('item/reasoning/summaryTextDelta', { threadId: 'native-thread', turnId: 'turn-1', itemId: 'reasoning', summaryIndex: 0, delta: 'x'.repeat(200) });
    try {
      thinking(); clock.mockReturnValue(start + 1_000); thinking();
      clock.mockReturnValue(start + 5_000);
      h.transport!.emitNativeNotification('item/completed', { threadId: 'native-thread', turnId: 'turn-1', item: { type: 'agentMessage', id: 'answer', text: 'x'.repeat(200) } });
      h.transport!.finishTurn('turn-1', 'completed');
      expect(messages.flatMap(message => message.type === 'metrics' && !message.metrics.live ? [message.metrics] : []).at(-1))
        .toMatchObject({ outputTokens: 187, durationMs: 5_000, window: 'observed', startedAt: start, endedAt: start + 5_000 });
    } finally {
      clock.mockRestore(); unsubscribe(); await h.adapter.dispose(h.host, h.session.id);
    }
  });

  it('closes request spans at usage notifications even without a tool item', async () => {
    const { h, messages, unsubscribe } = await metering();
    await h.send('cmd-usage-boundary');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const delta = (itemId: string) => h.transport!.emitNativeNotification('item/agentMessage/delta', { threadId: 'native-thread', turnId: 'turn-1', itemId, delta: 'x'.repeat(100) });
    try {
      delta('first'); clock.mockReturnValue(start + 1_000); delta('first');
      h.transport!.emitNativeNotification('thread/tokenUsage/updated', { threadId: 'native-thread', turnId: 'turn-1', tokenUsage: { last: { outputTokens: 40 }, total: { outputTokens: 40 } } });
      clock.mockReturnValue(start + 121_000); delta('second');
      clock.mockReturnValue(start + 122_000); delta('second');
      h.transport!.finishTurn('turn-1', 'completed');
      expect(messages.flatMap(message => message.type === 'metrics' && !message.metrics.live ? [message.metrics] : []).at(-1))
        .toMatchObject({ durationMs: 2_000, startedAt: start, endedAt: start + 122_000 });
    } finally {
      clock.mockRestore(); unsubscribe(); await h.adapter.dispose(h.host, h.session.id);
    }
  });

  it('measures an external TUI single chunk from turn/started and attaches its native user message', async () => {
    const { h, messages, unsubscribe } = await metering();
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'external' } });
      h.transport!.emitNativeNotification('item/completed', { threadId: 'native-thread', turnId: 'external', item: { type: 'userMessage', id: 'native-user', content: [{ type: 'text', text: 'from TUI' }] } });
      clock.mockReturnValue(start + 5_000);
      h.transport!.emitNativeNotification('item/agentMessage/delta', { threadId: 'native-thread', turnId: 'external', itemId: 'answer', delta: 'x'.repeat(400) });
      h.transport!.finishTurn('external', 'completed');
      const settled = messages.flatMap(message => message.type === 'metrics' && !message.metrics.live ? [message] : []).at(-1);
      expect(settled).toMatchObject({ nativeMessageId: 'native-thread:external:native-user:user', metrics: { window: 'observed', durationMs: 5_000, startedAt: start, endedAt: start + 5_000 } });
      expect(settled?.runId).toBeUndefined();
      expect(h.usage[0]).toMatchObject({ runId: undefined, usage: { nativeMessageId: 'native-thread:external:native-user:user', durationMs: 5_000, tokenSource: 'estimated' } });
    } finally {
      clock.mockRestore(); unsubscribe(); await h.adapter.dispose(h.host, h.session.id);
    }
  });

  it('fills unstreamed completed text once, then lets the provider correct its count without changing duration', async () => {
    const { h, messages, unsubscribe } = await metering();
    await h.send('cmd-completed-text');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      // This native turn began before any text arrived; the completed item is one observed response.
      h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'turn-1', startedAt: start / 1_000 } });
      clock.mockReturnValue(start + 5_000);
      const item = { type: 'agentMessage', id: 'complete-only', text: 'x'.repeat(4_000) };
      h.transport!.emitNativeNotification('item/completed', { threadId: 'native-thread', turnId: 'turn-1', item });
      clock.mockReturnValue(start + 6_000);
      h.transport!.emitNativeNotification('item/completed', { threadId: 'native-thread', turnId: 'turn-1', item });
      const provisional = messages.flatMap(message => message.type === 'metrics' ? [message.metrics] : []).at(-1);
      expect(provisional).toMatchObject({ tokens: 'estimated', outputTokens: 1_244, durationMs: 5_000, window: 'observed' });
      clock.mockReturnValue(start + 10_000);
      h.transport!.emitNativeNotification('thread/tokenUsage/updated', { threadId: 'native-thread', turnId: 'turn-1', tokenUsage: { last: { outputTokens: 40 }, total: { outputTokens: 40 } } });
      h.transport!.finishTurn('turn-1', 'completed', { items: [item] });
      h.transport!.finishTurn('turn-1', 'completed', { items: [item] });
      expect(messages.flatMap(message => message.type === 'metrics' && !message.metrics.live ? [message.metrics] : []).at(-1))
        .toMatchObject({ outputTokens: 40, tokens: 'provider', durationMs: 5_000, window: 'observed', endedAt: start + 5_000 });
      expect(h.usage).toHaveLength(1);
    } finally {
      clock.mockRestore(); unsubscribe(); await h.adapter.dispose(h.host, h.session.id);
    }
  });

  it('measures reasoning and answer in one request without double-counting reasoning channels or completed text', async () => {
    const { h, messages, unsubscribe } = await metering();
    await h.send('cmd-thinking-window');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const emit = (method: string, params: Record<string, unknown>) => h.transport!.emitNativeNotification(method, { threadId: 'native-thread', turnId: 'turn-1', ...params });
    try {
      emit('item/reasoning/summaryTextDelta', { itemId: 'reasoning', summaryIndex: 0, delta: 'x'.repeat(200) });
      clock.mockReturnValue(start + 500);
      emit('item/reasoning/textDelta', { itemId: 'reasoning', contentIndex: 0, delta: 'x'.repeat(4_000) });
      emit('item/completed', { item: { type: 'reasoning', id: 'reasoning', summary: ['x'.repeat(200)], content: ['x'.repeat(4_000)] } });
      clock.mockReturnValue(start + 1_000);
      emit('item/agentMessage/delta', { itemId: 'answer', delta: 'x'.repeat(200) });
      emit('item/completed', { item: { type: 'agentMessage', id: 'answer', text: 'x'.repeat(200) } });
      h.transport!.finishTurn('turn-1', 'completed');
      expect(messages.flatMap(message => message.type === 'metrics' && !message.metrics.live ? [message.metrics] : []).at(-1))
        .toMatchObject({ outputTokens: 124, durationMs: 1_000, window: 'stream' });
    } finally {
      clock.mockRestore(); unsubscribe(); await h.adapter.dispose(h.host, h.session.id);
    }
  });

  it('includes encrypted reasoning time before a short streamed message and across unannounced exec tool completions', async () => {
    const { h, messages, unsubscribe } = await metering();
    await h.send('cmd-encrypted-reasoning');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const emit = (method: string, params: Record<string, unknown>) => h.transport!.emitNativeNotification(method, { threadId: 'native-thread', turnId: 'turn-1', ...params });
    try {
      emit('turn/started', { turn: { id: 'turn-1', startedAt: start / 1_000 } });
      // Encrypted reasoning items have no summary/raw text deltas.
      clock.mockReturnValue(start + 20_000);
      emit('item/completed', { item: { type: 'reasoning', id: 'rs-1', summary: [] } });
      clock.mockReturnValue(start + 48_000);
      emit('item/completed', { item: { type: 'reasoning', id: 'rs-2', summary: [] } });
      // A short 2-second progress message streams at the end of the 50-second thinking block.
      emit('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Checking files.' });
      clock.mockReturnValue(start + 50_000);
      emit('item/agentMessage/delta', { itemId: 'msg-1', delta: ' Now running exec.' });
      emit('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text: 'Checking files. Now running exec.' } });
      // Code-mode exec emits item/completed for sub-commands without item/started, then reports usage.
      clock.mockReturnValue(start + 55_000);
      emit('item/completed', { item: { type: 'commandExecution', id: 'exec-1', command: 'ls', status: 'completed', durationMs: 5_000, exitCode: 0 } });
      clock.mockReturnValue(start + 58_000);
      emit('item/completed', { item: { type: 'commandExecution', id: 'exec-2', command: 'pwd', status: 'completed', durationMs: 3_000, exitCode: 0 } });
      clock.mockReturnValue(start + 60_000);
      emit('thread/tokenUsage/updated', { tokenUsage: { last: { outputTokens: 2_500, reasoningOutputTokens: 2_400 }, total: { outputTokens: 2_500, reasoningOutputTokens: 2_400 } } });
      // Duplicate usage notice with unchanged totals must not close the next thinking block early.
      clock.mockReturnValue(start + 70_000);
      emit('item/completed', { item: { type: 'reasoning', id: 'rs-3', summary: [] } });
      emit('thread/tokenUsage/updated', { tokenUsage: { last: { outputTokens: 2_500, reasoningOutputTokens: 2_400 }, total: { outputTokens: 2_500, reasoningOutputTokens: 2_400 } } });
      clock.mockReturnValue(start + 90_000);
      emit('item/completed', { item: { type: 'reasoning', id: 'rs-4', summary: [] } });
      emit('thread/tokenUsage/updated', { tokenUsage: { last: { outputTokens: 1_500, reasoningOutputTokens: 1_500 }, total: { outputTokens: 4_000, reasoningOutputTokens: 3_900 } } });
      h.transport!.finishTurn('turn-1', 'completed');
      const settled = messages.flatMap(message => message.type === 'metrics' && !message.metrics.live ? [message.metrics] : []).at(-1);
      // 50s for the first request + 30s (60s..90s) for the second request = 80s (~50 tok/s, not ~1000 tok/s).
      expect(settled).toMatchObject({ outputTokens: 4_000, durationMs: 80_000, window: 'observed' });
    } finally {
      clock.mockRestore(); unsubscribe(); await h.adapter.dispose(h.host, h.session.id);
    }
  });
});

describe('Codex skills', () => {
  const skills = [
    { name: 'dataviz', description: 'Charts', path: '/skills/dataviz/SKILL.md', scope: 'user', enabled: true },
    { name: 'arc:dev', description: 'Long description', interface: { shortDescription: 'Arc dev' }, path: '/plugins/arc/dev/SKILL.md', scope: 'user', enabled: true },
    { name: 'dataviz', description: 'Shadowed copy', path: '/other/dataviz/SKILL.md', scope: 'user', enabled: true },
    { name: 'off', description: 'Disabled', path: '/skills/off/SKILL.md', scope: 'user', enabled: false },
  ];

  it('hands every skill the text names to turn/start as a structured input item, wherever it sits', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setSkills(skills);

    await h.send('cmd-skill', 'gpt-5-codex', 'on-request', 'chart this with /dataviz then ship it via /arc:dev, not /off or /usr/bin');
    const input = h.transport!.lastParams('turn/start')?.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: 'text', text: 'chart this with /dataviz then ship it via /arc:dev, not /off or /usr/bin' });
    // `/arc:dev,` is followed by punctuation, so only `/dataviz` is a token; the first path wins a shared name.
    expect(input.slice(1)).toEqual([{ type: 'skill', name: 'dataviz', path: '/skills/dataviz/SKILL.md' }]);
  });

  it('rejects an invoked skill before fencing or writing when the skill listing fails', async () => {
    const h = makeHarness();
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      await expect(h.send('cmd-no-skills', 'gpt-5-codex', 'on-request', '/dataviz chart this'))
        .rejects.toMatchObject({ code: 'NATIVE_SKILL_CATALOG_UNAVAILABLE' });
      expect(h.dispatchFences).toHaveLength(0);
      expect(h.transport!.lastParams('turn/start')).toBeUndefined();
      expect(h.transport!.lastParams('turn/steer')).toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it('lists enabled skills once per name with their short description', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setSkills(skills);
    const transport = h.transport!;
    const adapter = h.adapter as unknown as { withTransport: (project: unknown, profile: unknown, session: unknown, read: (client: unknown) => Promise<unknown>) => Promise<unknown> };
    adapter.withTransport = async (_project: unknown, _profile: unknown, _session: unknown, read: (client: unknown) => Promise<unknown>) => await read(transport);

    expect(await h.adapter.slashItems!(h.host, h.project, h.profile)).toEqual([
      { name: 'dataviz', kind: 'skill', path: '/skills/dataviz/SKILL.md', description: 'Charts' },
      { name: 'arc:dev', kind: 'skill', path: '/plugins/arc/dev/SKILL.md', description: 'Arc dev' },
    ]);
  });

  it('keeps unknown inline endpoint prose usable during catalog failures while refusing known skill invocations', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setSkills(skills);
    try {
      await h.send('known-skill', undefined, undefined, 'Use /dataviz here');
      h.transport!.finishTurn('turn-1', 'completed');
      h.transport!.setSkills(undefined);
      await h.send('endpoint-prose', undefined, undefined, 'Fix GET /health now');
      h.transport!.finishTurn('turn-2', 'completed');
      expect(h.transport!.lastParams('turn/start')?.input).toEqual([expect.objectContaining({ text: 'Fix GET /health now' })]);
      const fences = h.dispatchFences.length;
      await expect(h.send('missing-known-skill', undefined, undefined, 'Use /dataviz here')).rejects.toMatchObject({ code: 'NATIVE_SKILL_CATALOG_UNAVAILABLE' });
      expect(h.dispatchFences).toHaveLength(fences);
    } finally { await h.adapter.close(h.host); }
  });
});

describe('Codex native commands', () => {
  async function start(flavor = codexFlavor) {
    const h = makeHarness({ flavor });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const transport = h.transport!;
    transport.enableNativeSettings();
    const emitted = vi.spyOn(h.host, 'emitEvent');
    const receipts = () => emitted.mock.calls.map(([, event]) => event).filter(event => event.type === 'native_input_receipt');
    const startTurn = (turnId: string) => transport.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: turnId } });
    const compaction = (turnId: string) => transport.emitNativeNotification('item/started', {
      threadId: 'native-thread', turnId, item: { type: 'contextCompaction', id: `compact-${turnId}` },
    });
    const writes = () => [...new Set([...transport.requestParams, ...(h.transport?.requestParams ?? [])])]
      .filter(({ method }) => ['thread/compact/start', 'review/start', 'turn/start', 'turn/steer'].includes(method));
    return { h, transport, receipts, startTurn, compaction, writes };
  }

  it('uses the native completion timestamp when a delayed compaction completion corrects interruption', async () => {
    const { h, transport, startTurn } = await start();
    const item = { type: 'contextCompaction', id: 'wire-timing' };
    try {
      startTurn('timing-turn');
      transport.emitNativeNotification('item/started', { threadId: 'native-thread', turnId: 'timing-turn', startedAtMs: 10_000, item });
      transport.finishTurn('timing-turn', 'interrupted');
      transport.emitNativeNotification('item/completed', { threadId: 'native-thread', turnId: 'timing-turn', completedAtMs: 30_000, item });
      const activity = h.host.journal!.activityEntities(h.session.id).map(entity => activityOfEvent(entity.payload)).find(value => value?.id === 'codex:compaction:wire-timing');
      expect(activity).toMatchObject({ status: 'completed', startedAt: new Date(10_000).toISOString(), endedAt: new Date(30_000).toISOString(), durationMs: 20_000 });
    } finally { await h.adapter.close(h.host); }
  });

  it.each(['before', 'after'] as const)('requires compact item proof %s the empty ACK and never sends a prompt', async order => {
    const { h, transport, receipts, startTurn, compaction, writes } = await start();
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'thread/compact/start');
    let sending: Promise<unknown> | undefined;
    try {
      let settled = false;
      sending = h.send('compact', undefined, undefined, '/compact').then(() => { settled = true; }).catch(error => error);
      await gate.entered;
      expect(h.dispatchFences).toHaveLength(1);
      expect(transport.lastParams('thread/compact/start')).toEqual({ threadId: 'native-thread' });
      startTurn('compact-turn');
      expect(receipts()).toHaveLength(0);
      if (order === 'before') {
        compaction('compact-turn');
        expect(receipts()).toHaveLength(0);
      }
      gate.release();
      await new Promise<void>(resolve => setImmediate(resolve));
      if (order === 'after') {
        expect(settled).toBe(false);
        expect(receipts()).toHaveLength(0);
        compaction('compact-turn');
      }
      expect(await sending).toBeUndefined();
      expect(receipts()).toEqual([expect.objectContaining({
        runId: 'run-compact', nativeTurnId: 'compact-turn',
        data: expect.objectContaining({ commandId: 'compact', receiptKind: 'native_command', nativeSessionId: 'native-thread' }),
      })]);
      expect(writes().map(({ method }) => method)).toEqual(['thread/compact/start']);
      expect(h.adapter.status(h.host, h.session).activeTurn).toMatchObject({ turnId: 'compact-turn', ownerRunId: 'run-compact' });
    } finally { gate.release(); await h.adapter.close(h.host); await sending; }
  });

  it.each([
    { text: '/review', target: { type: 'uncommittedChanges' } },
    { text: '/review Check error handling and data isolation', target: { type: 'custom', instructions: 'Check error handling and data isolation' } },
  ])('reviews inline with the native target for $text and receipts the returned turn', async ({ text, target }) => {
    const { h, transport, receipts, startTurn, writes } = await start();
    transport.setReviewTurnId('returned-review');
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'review/start');
    let sending: Promise<unknown> | undefined;
    try {
      sending = h.send('review', undefined, undefined, text).catch(error => error);
      await gate.entered;
      startTurn('unrelated-tui');
      expect(receipts()).toHaveLength(0);
      expect(h.adapter.status(h.host, h.session).activeTurn?.ownerRunId).toBeUndefined();
      gate.release();
      expect(await sending).toBeUndefined();
      expect(transport.lastParams('review/start')).toEqual({ threadId: 'native-thread', delivery: 'inline', target });
      expect(receipts()).toEqual([expect.objectContaining({
        runId: 'run-review', nativeTurnId: 'returned-review', data: expect.objectContaining({ commandId: 'review', receiptKind: 'native_command' }),
      })]);
      expect(writes().map(({ method }) => method)).toEqual(['review/start']);
      expect(h.adapter.status(h.host, h.session).activeTurn).toMatchObject({ turnId: 'unrelated-tui' });
      expect(h.adapter.status(h.host, h.session).activeTurn?.ownerRunId).toBeUndefined();
    } finally { gate.release(); await h.adapter.close(h.host); await sending; }
  });

  it.each([
    { name: 'attachment', extra: { attachmentIds: ['attachment'] } },
    { name: 'file context', extra: { context: [{ path: '/tmp/context.ts' }] } },
    { name: 'session reference', extra: { references: [{ kind: 'session' as const, sessionId: 'other-session' }] } },
  ])('rejects $name before a native command fence or write', async ({ extra }) => {
    const { h, transport, receipts, writes } = await start();
    const readAttachment = vi.spyOn(h.host, 'readAttachment');
    const commitDispatchFence = vi.fn(() => ({} as Run));
    try {
      await expect(h.adapter.send(h.host, {
        session: h.session, project: h.project, profile: h.profile, commandId: 'invalid', runId: 'run-invalid',
        input: { text: '/review', attachmentIds: [], context: [], ...extra }, config: { mode: 'code' },
        commitDispatchFence,
      })).rejects.toMatchObject({ code: 'NATIVE_COMMAND_ARGUMENTS' });
      expect(commitDispatchFence).not.toHaveBeenCalled();
      expect(readAttachment).not.toHaveBeenCalled();
      expect(receipts()).toHaveLength(0);
      expect(writes()).toHaveLength(0);
      expect(transport.lastParams('thread/settings/update')).toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it('applies deferred thread permissions before a review that has no per-turn settings', async () => {
    const { h, transport, startTurn } = await start();
    try {
      startTurn('previous-turn');
      await h.adapter.configure(h.host, h.session, h.profile, { approval: 'read-only' });
      transport.finishTurn('previous-turn', 'completed');
      await h.send('review-restricted', 'gpt-5-codex', 'read-only', '/review');
      expect(transport.lastParams('thread/settings/update')).toMatchObject({ threadId: 'native-thread', model: 'gpt-5-codex', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
      expect(transport.lastParams('thread/resume')).toEqual({ threadId: 'native-thread', excludeTurns: true });
      const writes = transport.requestParams.map(item => item.method);
      expect(writes.lastIndexOf('thread/resume')).toBeLessThan(writes.indexOf('review/start'));
      expect(transport.lastParams('review/start')).toMatchObject({ delivery: 'inline', target: { type: 'uncommittedChanges' } });
    } finally { await h.adapter.close(h.host); }
  });

  it('refuses a command when the native setter ACK leaves the previous broader permissions effective', async () => {
    const { h, transport, receipts, writes } = await start();
    transport.enableNativeSettings(true);
    transport.setThreadSettings({ model: 'gpt-5-codex', cwd: h.project.cwd, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const sending = h.send('unverified', 'gpt-5-codex', 'read-only', '/review').catch(error => error);
    try {
      await vi.waitFor(() => expect(transport.lastParams('thread/settings/update')).toBeDefined());
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await sending).toMatchObject({ code: 'NATIVE_COMMAND_CONFIG_UNVERIFIED' });
      expect(h.dispatchFences).toHaveLength(0);
      expect(receipts()).toHaveLength(0);
      expect(writes()).toHaveLength(0);
    } finally { vi.useRealTimers(); await h.adapter.close(h.host); }
  });

  it('waits for delayed settings application without resending the setter', async () => {
    const { h, transport } = await start();
    transport.enableNativeSettings(true);
    const request = transport.request.bind(transport);
    let reads = 0;
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => {
      if (method === 'thread/resume' && (params as Record<string, unknown>)?.excludeTurns && !('cwd' in (params as Record<string, unknown>)) && ++reads === 2) {
        transport.setThreadSettings({ model: 'gpt-5-codex', cwd: h.project.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } });
      }
      return request(method, params);
    });
    try {
      await h.send('delayed-settings', 'gpt-5-codex', 'read-only', '/review');
      expect(reads).toBe(2);
      expect(transport.requestParams.filter(item => item.method === 'thread/settings/update')).toHaveLength(1);
      expect(h.dispatchFences).toHaveLength(1);
    } finally { await h.adapter.close(h.host); }
  });

  it('rejects an observed permission tightening even when later readback reports the requested broad policy', async () => {
    const { h, transport, receipts, writes } = await start();
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'thread/settings/update');
    const sending = h.send('conflicting-settings', 'gpt-5-codex', 'danger-full-access', '/review').catch(error => error);
    try {
      await gate.entered;
      transport.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: {
        model: 'gpt-5-codex', cwd: h.project.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false }, activePermissionProfile: null,
      } });
      gate.release();
      expect(await sending).toMatchObject({ code: 'NATIVE_COMMAND_CONFIG_UNVERIFIED' });
      expect(h.dispatchFences).toHaveLength(0);
      expect(receipts()).toHaveLength(0);
      expect(writes()).toHaveLength(0);
    } finally { gate.release(); await h.adapter.close(h.host); }
  });

  it('verifies the profile model, effort and tier when the session has no model override', async () => {
    const { h, transport } = await start();
    h.profile.config.defaultModel = 'profile-model[effort=high,fast=true]';
    const fence = vi.fn(() => ({} as Run));
    try {
      await h.adapter.send(h.host, { session: h.session, project: h.project, profile: h.profile, runId: 'profile-run', commandId: 'profile-command',
        input: { text: '/review', attachmentIds: [], context: [] }, config: { mode: 'code', approval: 'read-only' }, commitDispatchFence: fence });
      expect(transport.lastParams('thread/settings/update')).toMatchObject({ model: 'profile-model', effort: 'high', serviceTier: 'priority' });
      expect(fence).toHaveBeenCalledWith(expect.objectContaining({ resolvedConfig: expect.objectContaining({ model: 'profile-model[effort=high,fast=true]', approval: 'read-only' }) }));
    } finally { await h.adapter.close(h.host); }
  });

  it.each([
    { flavor: codexFlavor, text: '/not-a-command' },
    { flavor: traexFlavor, text: '/compact' },
    { flavor: traexFlavor, text: '/review' },
    { flavor: traexFlavor, text: '/model' },
  ])('rejects $flavor.label $text explicitly without passing it as text', async ({ flavor, text }) => {
    const { h, transport, receipts, writes } = await start(flavor);
    transport.setSkills([]);
    try {
      await expect(h.send('unsupported', undefined, undefined, text)).rejects.toMatchObject({ code: 'NATIVE_COMMAND_UNSUPPORTED' });
      expect(h.dispatchFences).toHaveLength(0);
      expect(receipts()).toHaveLength(0);
      expect(writes()).toHaveLength(0);
    } finally { await h.adapter.close(h.host); }
  });

  it.each(['timeout', 'disconnect'] as const)('does not replay or bind a later TUI turn after a compact %s following the write', async failure => {
    const { h, transport, receipts, writes } = await start();
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'thread/compact/start');
    let sending: Promise<unknown> | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      sending = h.send('uncertain-compact', undefined, undefined, '/compact').catch(error => error);
      await gate.entered;
      expect(h.dispatchFences).toHaveLength(1);
      if (failure === 'disconnect') transport.disconnect();
      gate.release();
      await new Promise<void>(resolve => setImmediate(resolve));
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
      expect(await sending).toBeInstanceOf(Error);
      expect(receipts()).toHaveLength(0);
      if (failure === 'disconnect') await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const latest = h.transport!;
      latest.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'later-tui' } });
      latest.emitNativeNotification('item/started', { threadId: 'native-thread', turnId: 'later-tui', item: { type: 'contextCompaction', id: 'later-compact' } });
      expect(receipts()).toHaveLength(0);
      expect(h.adapter.status(h.host, h.session).activeTurn).toMatchObject({ turnId: 'later-tui' });
      expect(h.adapter.status(h.host, h.session).activeTurn?.ownerRunId).toBeUndefined();
      expect(writes().map(({ method }) => method)).toEqual(['thread/compact/start']);
      expect(h.dispatchFences).toHaveLength(1);
    } finally { gate.release(); await h.adapter.close(h.host); await sending; vi.useRealTimers(); }
  });

  it('releases a command wait for Stop without claiming the unbound provider operation was cancelled', async () => {
    const { h, transport, receipts, startTurn, compaction, writes } = await start();
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'thread/compact/start');
    let sending: Promise<unknown> | undefined;
    try {
      sending = h.send('pending-stop', undefined, undefined, '/compact').catch(error => error);
      await gate.entered;
      h.adapter.requestInterrupt(h.host, h.session);
      expect(await sending).toBeInstanceOf(Error);
      await expect(h.adapter.interrupt(h.host, h.session, h.profile)).rejects.toMatchObject({ code: 'NATIVE_INTERRUPT_UNCONFIRMED' });
      gate.release();
      startTurn('late-command');
      compaction('late-command');
      expect(receipts()).toHaveLength(0);
      expect(transport.lastParams('turn/interrupt')).toBeUndefined();
      expect(writes().map(item => item.method)).toEqual(['thread/compact/start']);
    } finally { gate.release(); await h.adapter.close(h.host); await sending; }
  });

  it('retains the unconfirmed Stop boundary from persisted command runs after reconnect', async () => {
    const { h, transport } = await start();
    h.host.listRuns = () => [{ id: 'uncertain-command', state: 'interrupted', commandId: 'uncertain', native: {
      delivery: 'uncertain', stage: 'confirmation', nativeSessionId: 'native-thread', input: { text: '/compact', attachmentIds: [], context: [] },
    } } as unknown as Run];
    try {
      await expect(h.adapter.interrupt(h.host, h.session, h.profile)).rejects.toMatchObject({ code: 'NATIVE_INTERRUPT_UNCONFIRMED' });
      expect(transport.lastParams('turn/interrupt')).toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it('stops an explicitly targeted active turn while another command remains unbound', async () => {
    const { h, transport, startTurn } = await start();
    h.host.listRuns = () => [{ id: 'unbound', commandId: 'unbound', state: 'interrupted', native: { delivery: 'uncertain',
      nativeSessionId: 'native-thread', input: { text: '/review', attachmentIds: [], context: [] } } } as unknown as Run];
    startTurn('visible-turn');
    const request = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/interrupt') queueMicrotask(() => transport.finishTurn('visible-turn', 'interrupted'));
      return request(method, params);
    });
    try {
      await h.adapter.interrupt(h.host, h.session, h.profile, { expectedStop: { requestId: 'stop-visible', nativeSessionId: 'native-thread', turnId: 'visible-turn' } });
      expect(transport.lastParams('turn/interrupt')).toEqual({ threadId: 'native-thread', turnId: 'visible-turn' });
      expect(h.host.listRuns(h.session.id)[0]!.native!.delivery).toBe('uncertain');
    } finally { await h.adapter.close(h.host); }
  });

  it('reports a definitive command RPC rejection without leaving an unbound operation', async () => {
    const { h, transport, receipts } = await start();
    const request = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => {
      if (method === 'review/start') throw Object.assign(new Error('method not found'), { rpcError: true, rpcCode: -32601 });
      return request(method, params);
    });
    const emitted = vi.mocked(h.host.emitEvent);
    try {
      await expect(h.send('rejected-review', undefined, undefined, '/review')).rejects.toMatchObject({ rpcError: true });
      expect(receipts()).toHaveLength(0);
      expect(emitted.mock.calls.map(([, event]) => event)).toContainEqual(expect.objectContaining({
        type: 'native_input_rejected', runId: 'run-rejected-review', data: expect.objectContaining({ commandId: 'rejected-review', receiptKind: 'native_command' }),
      }));
      await expect(h.adapter.interrupt(h.host, h.session, h.profile)).resolves.toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it('does not claim compaction within an unrelated user turn', async () => {
    const { h, transport, receipts, startTurn, compaction, writes } = await start();
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'thread/compact/start');
    let sending: Promise<unknown> | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      sending = h.send('compact', undefined, undefined, '/compact').catch(error => error);
      await gate.entered;
      startTurn('user-turn');
      transport.emitNativeNotification('item/started', { threadId: 'native-thread', turnId: 'user-turn', item: {
        type: 'userMessage', id: 'tui-user', content: [{ type: 'text', text: 'A separate TUI message' }],
      } });
      compaction('user-turn');
      transport.finishTurn('user-turn', 'completed');
      gate.release();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(receipts()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await sending).toBeInstanceOf(Error);
      expect(receipts()).toHaveLength(0);
      expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
      expect(writes().map(({ method }) => method)).toEqual(['thread/compact/start']);
    } finally { gate.release(); await h.adapter.close(h.host); await sending; vi.useRealTimers(); }
  });

  it('does not bind a delayed compaction from an already ended unmapped turn', async () => {
    const { h, transport, receipts, startTurn, compaction } = await start();
    startTurn('old-native');
    transport.finishTurn('old-native', 'completed');
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'thread/compact/start');
    let sending: Promise<unknown> | undefined;
    try {
      sending = h.send('new-command', undefined, undefined, '/compact').catch(error => error);
      await gate.entered;
      compaction('old-native');
      gate.release();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(receipts()).toHaveLength(0);
      startTurn('new-native');
      compaction('new-native');
      await sending;
      expect(receipts()).toEqual([expect.objectContaining({ nativeTurnId: 'new-native' })]);
    } finally { gate.release(); await h.adapter.close(h.host); await sending; }
  });

  it('continues processing a definitive RPC rejection after Stop releases the local wait', async () => {
    const { h, transport } = await start();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let refuse!: (error: Error) => void;
    const request = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => {
      if (method === 'review/start') { entered(); return new Promise((_resolve, reject) => { refuse = reject; }); }
      return request(method, params);
    });
    const sending = h.send('late-rejection', undefined, undefined, '/review').catch(error => error);
    try {
      await started;
      h.adapter.requestInterrupt(h.host, h.session);
      expect(await sending).toBeInstanceOf(Error);
      refuse(Object.assign(new Error('method not found'), { rpcError: true, rpcCode: -32601 }));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(vi.mocked(h.host.emitEvent).mock.calls.map(([, event]) => event)).toContainEqual(expect.objectContaining({
        type: 'native_input_rejected', data: expect.objectContaining({ commandId: 'late-rejection', receiptKind: 'native_command' }),
      }));
      await expect(h.adapter.interrupt(h.host, h.session, h.profile)).resolves.toBeUndefined();
    } finally { await h.adapter.close(h.host); }
  });

  it('keeps a compact unconfirmed when a second turn makes its item proof ambiguous before ACK', async () => {
    const { h, transport, receipts, startTurn, compaction, writes } = await start();
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'thread/compact/start');
    let sending: Promise<unknown> | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      sending = h.send('ambiguous-compact', undefined, undefined, '/compact').catch(error => error);
      await gate.entered;
      startTurn('candidate-one');
      compaction('candidate-one');
      transport.finishTurn('candidate-one', 'completed');
      startTurn('candidate-two');
      compaction('candidate-two');
      gate.release();
      await new Promise<void>(resolve => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await sending).toBeInstanceOf(Error);
      expect(receipts()).toHaveLength(0);
      expect(h.adapter.status(h.host, h.session).activeTurn?.ownerRunId).toBeUndefined();
      expect(writes().map(({ method }) => method)).toEqual(['thread/compact/start']);
    } finally { gate.release(); await h.adapter.close(h.host); await sending; vi.useRealTimers(); }
  });

  it('binds a compact completed before ACK without claiming or reviving another turn', async () => {
    const { h, transport, receipts, startTurn, writes } = await start();
    const gate = h.deferEndpointRequest(transport.remoteAddress, 'thread/compact/start');
    let sending: Promise<unknown> | undefined;
    try {
      sending = h.send('fast-compact', undefined, undefined, '/compact').catch(error => error);
      await gate.entered;
      startTurn('fast-command');
      transport.finishTurn('fast-command', 'completed', { items: [{ type: 'contextCompaction', id: 'fast-item' }] });
      gate.release();
      expect(await sending).toBeUndefined();
      expect(receipts()).toEqual([expect.objectContaining({ runId: 'run-fast-compact', nativeTurnId: 'fast-command' })]);
      expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
      expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
      startTurn('next-tui');
      expect(h.adapter.status(h.host, h.session).activeTurn).toMatchObject({ turnId: 'next-tui' });
      expect(h.adapter.status(h.host, h.session).activeTurn?.ownerRunId).toBeUndefined();
      transport.finishTurn('next-tui', 'completed');
      expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
      expect(receipts()).toHaveLength(1);
      expect(writes().map(({ method }) => method)).toEqual(['thread/compact/start']);
    } finally { gate.release(); await h.adapter.close(h.host); await sending; }
  });
});

/**
 * Codex's Fast mode is a service tier (`priority`), not a model variant, so these pin the two
 * halves of the contract: the catalog has to publish the switch, and a selection has to reach
 * `thread/start` / `turn/start` as `serviceTier`, with explicit `default` to turn it back off.
 */
describe('Codex Fast mode', () => {
  const fastModel = (overrides: Record<string, unknown> = {}) => ({
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' }],
    defaultReasoningEffort: 'low',
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
    defaultServiceTier: 'priority',
    ...overrides,
  });

  it('publishes a Fast switch only for models that advertise a fast service tier', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setModels([
      fastModel(),
      { model: 'gpt-5.2', displayName: 'GPT-5.2', supportedReasoningEfforts: [], serviceTiers: [] },
      { model: 'flex-only', displayName: 'Flex only', supportedReasoningEfforts: [], serviceTiers: [{ id: 'flex', name: 'Flex', description: 'Cheaper' }] },
    ]);

    const models = await h.adapter.listModels(h.host, h.project, h.profile, h.session);
    const fast = models.find(model => model.value === 'gpt-5.6-sol')!.configOptions.find(option => option.id === 'fast')!;
    // The web picker renders `id: 'fast'` with two boolean options as the Fast switch, so this
    // shape is the whole UI contract — no client change is needed to surface Codex Fast.
    expect(fast).toMatchObject({ name: 'Fast', category: 'model_config', type: 'select', currentValue: 'true' });
    expect(fast.options.map(option => option.value)).toEqual(['false', 'true']);
    // No tier at all, and a cheap-only tier, must not grow a switch labelled Fast.
    expect(models.find(model => model.value === 'gpt-5.2')!.configOptions.some(option => option.id === 'fast')).toBe(false);
    expect(models.find(model => model.value === 'flex-only')!.configOptions.some(option => option.id === 'fast')).toBe(false);
  });

  it('opens Fast off when the catalog default is not the fast tier', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setModels([fastModel({ defaultServiceTier: null })]);

    const models = await h.adapter.listModels(h.host, h.project, h.profile, h.session);
    expect(models[0]!.configOptions.find(option => option.id === 'fast')!.currentValue).toBe('false');
  });

  it('sends the fast tier with a turn and explicit standard routing when Fast is off', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setModels([fastModel()]);
    await h.adapter.listModels(h.host, h.project, h.profile, h.session);

    await h.send('cmd-fast', 'gpt-5.6-sol[effort=low,fast=true]');
    expect(h.transport!.lastParams('turn/start')?.serviceTier).toBe('priority');
    // A second submission while the first is still active is a steer, not a new turn.
    h.transport!.finishTurn('turn-1', 'completed');
    // `default` is Codex's "the reader chose no tier" sentinel. It has to be explicit: a profile
    // whose config.toml already sets `service_tier = "priority"` would otherwise stay fast while
    // the switch reads off.
    await h.send('cmd-standard', 'gpt-5.6-sol[effort=low,fast=false]');
    expect(h.transport!.lastParams('turn/start')?.serviceTier).toBe('default');
  });

  it('carries Fast through a model switch on an open thread', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setModels([fastModel()]);
    await h.adapter.listModels(h.host, h.project, h.profile, h.session);

    await h.adapter.configure(h.host, h.session, h.profile, { model: 'gpt-5.6-sol[effort=low,fast=true]' });
    expect(h.transport!.lastParams('thread/resume')?.serviceTier).toBe('priority');
  });

  it('switches off the conversation\'s MCP servers on the thread and leaves skills to the CLI', async () => {
    const h = makeHarness();
    h.host.updateSession(h.session.id, { extensionsOff: ['mcp:docs', 'skill:review', 'mcp:a.b', 'mcp:ghost'] });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    // The CLI refuses a thread that names a server it does not have, so only reported names are switched off.
    expect(h.transport!.lastParams('thread/start')?.config ?? {}).not.toHaveProperty('mcp_servers.docs.enabled');
    h.transport!.setMcpServers(['docs']);
    h.transport!.disconnect();
    await h.send('cmd-off', 'gpt-5-codex');
    const config = h.transport!.lastParams('thread/resume')?.config;
    expect(config).toMatchObject({ 'mcp_servers.docs.enabled': false });
    expect(Object.keys(config as object).filter(key => key.startsWith('mcp_servers.'))).toEqual(['mcp_servers.docs.enabled']);
  });

  it('leaves the thread tier alone when the picker never offered Fast', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    expect(h.transport!.lastParams('thread/start')?.serviceTier).toBeUndefined();

    await h.send('cmd-plain', 'gpt-5-codex[effort=high]');
    const params = h.transport!.lastParams('turn/start');
    expect(params).toBeDefined();
    // Absent means "inherit": a session that predates the Fast switch keeps whatever tier its
    // own Codex config asks for, which is the whole point of not defaulting the param.
    expect(params!.serviceTier).toBeUndefined();
  });
});

describe('Codex streamed text', () => {
  const delta = (h: ReturnType<typeof makeHarness>, itemId: string, text: string) =>
    h.transport!.emitNativeNotification('item/agentMessage/delta', { threadId: 'native-thread', turnId: 'turn-1', itemId, delta: text });

  async function streaming() {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const messages: NativeControlMessage[] = [];
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, message => messages.push(message));
    await waitFor(() => messages.some(message => message.type === 'status') ? true : undefined);
    await h.send('cmd-stream');
    return { h, messages, unsubscribe };
  }

  it('settles a turn of several model requests on the whole turn, not its last request', async () => {
    const { h, messages, unsubscribe } = await streaming();
    delta(h, 'answer-1', 'Looking at ');
    await new Promise(resolve => setTimeout(resolve, 15));
    // An earlier turn already spent 1000 output tokens on this thread.
    h.transport!.emitNativeNotification('thread/tokenUsage/updated', {
      threadId: 'native-thread', turnId: 'turn-1',
      tokenUsage: { last: { outputTokens: 135 }, total: { outputTokens: 1_135 } },
    });
    delta(h, 'answer-1', 'the project.');
    h.transport!.emitNativeNotification('thread/tokenUsage/updated', {
      threadId: 'native-thread', turnId: 'turn-1',
      tokenUsage: { last: { outputTokens: 2_166 }, total: { outputTokens: 3_301 } },
    });
    const live = messages.flatMap(message => message.type === 'metrics' && message.metrics.live ? [message.metrics] : []);
    // The provider count lags the stream until the turn ends, so a live rate never reads it.
    expect(live.every(metrics => metrics.tokens === 'estimated')).toBe(true);

    h.transport!.finishTurn('turn-1', 'completed');
    const settled = await waitFor(() => messages
      .flatMap(message => message.type === 'metrics' ? [message] : [])
      .find(message => !message.metrics.live));
    expect(settled.metrics).toMatchObject({ outputTokens: 2_301, tokens: 'provider' });

    unsubscribe();
    await h.adapter.dispose(h.host, h.session.id);
  });
});

describe('Codex provider continuation', () => {
  function providerSettings(transport: FakeAppServer, options: CodexAppServerOptions) {
    const source = options.args?.includes('model_providers.riffet.base_url="https://source.example/v1"');
    transport.setThreadSettings({ model: source ? 'gpt-5-codex' : 'gpt-5.6-sol' });
  }

  function continuationProfiles(h: ReturnType<typeof makeHarness>) {
    Object.assign(h.profile.config, { apiEndpoint: 'https://source.example/v1', apiKey: 'source-probe-key' });
    h.session.backendProfileId = h.profile.id;
    h.session.model = 'gpt-5-codex';
    const target: NativeBackendProfileConfig = {
      ...h.profile, id: 'gateway-b', name: 'Gateway B',
      config: { ...h.profile.config, apiEndpoint: 'https://target.example/v1', apiKey: 'target-probe-key' },
    };
    h.host.getProfile = session => session.backendProfileId === target.id ? target : h.profile;
    return target;
  }

  async function selectProvider(h: ReturnType<typeof makeHarness>, target: NativeBackendProfileConfig) {
    const result = await h.adapter.configure(h.host, h.session, target, { model: 'gpt-5.6-sol[effort=high]' });
    // NativeBackendService persists the desired selection before notifying the driver.
    h.host.bumpConfig(h.session.id, { backendProfileId: target.id, model: result.model });
    h.adapter.afterConfigure(h.host, h.session);
  }

  it('moves the verified idle writer to the selected gateway without changing its thread or journal generation', async () => {
    const h = makeHarness({ onTransport: providerSettings });
    const target = continuationProfiles(h);
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const owner = h.transport!;
      const threadId = h.session.nativeSessionId;
      const head = h.host.journal!.head(h.session.id);
      const updates = vi.spyOn(h.host, 'updateSession');
      const transcript = h.adapter.transcript(h.host, h.session, h.profile);
      await selectProvider(h, target);

      expect(h.session.nativeRuntime?.profileId).toBe(h.profile.id);
      expect(h.session.configPending).toBe(true);
      const desiredModel = h.session.model;
      h.host.updateSession(h.session.id, { model: 'deepseek-v4.1-flash' });
      const factories = h.factoryCalls.length;
      await expect(h.adapter.openOrResume(h.host, h.session, h.project, target))
        .rejects.toMatchObject({ code: 'NATIVE_PROFILE_SWITCH_MODEL' });
      expect(h.factoryCalls).toHaveLength(factories);
      expect(owner.disposed).toBe(false);
      expect(h.session.nativeRuntime?.profileId).toBe(h.profile.id);
      h.host.updateSession(h.session.id, { model: desiredModel });
      await h.adapter.openOrResume(h.host, h.session, h.project, target);

      expect(owner.disposed).toBe(true);
      expect(h.transport).not.toBe(owner);
      expect(h.session.nativeSessionId).toBe(threadId);
      expect(h.session.nativeRuntime).toMatchObject({ address: h.transport!.remoteAddress, profileId: target.id });
      expect(h.session.configPending).toBe(false);
      expect(updates.mock.calls.find(([, patch]) => patch.nativeRuntime?.profileId === target.id)?.[1])
        .toMatchObject({ configPending: false });
      expect(h.transport!.lastParams('thread/resume')).toMatchObject({ threadId, model: 'gpt-5.6-sol' });
      expect(h.transport!.requestParams.some(request => ['thread/start', 'thread/fork'].includes(request.method))).toBe(false);
      expect(h.factoryCalls.at(-1)?.args).toContain('model_providers.riffet.base_url="https://target.example/v1"');
      expect(h.host.journal!.head(h.session.id).generation).toBe(head.generation);

      // The source object predates the switch; ordinary target failures must use its actual key.
      h.transport!.setTurns([{ id: 'target-failed', status: 'failed', startedAt: 1, completedAt: 2,
        error: { message: `Gateway request rejected ${String(target.config.apiKey)}` },
        items: [{ type: 'userMessage', id: 'target-user', content: [{ type: 'text', text: 'Continue the conversation.' }] }],
      }]);
      h.transport!.setTurnsListAvailable(true);
      const journal = new Journal(new DatabaseSync(':memory:'));
      const writer = JournalLaneWriter.open(journal, h.session.id);
      for (let pulls = 0; !(await pullLane(transcript, writer, new AbortController().signal)).caughtUp; pulls += 1) expect(pulls).toBeLessThan(20);
      const rows = rowsOf(journal, h.session.id);
      const failed = rows.find(row => row.kind === 'meta.turn_ended' && row.turnId === 'target-failed');
      expect(failed?.payload).toMatchObject({ status: 'failed', error: 'Gateway request rejected [redacted]' });
      expect(JSON.stringify(rows)).not.toContain(target.config.apiKey);
    } finally { await h.adapter.close(h.host); }
  });

  it('keeps the old turn controllable while the gateway switch waits, then applies it after that turn settles', async () => {
    const h = makeHarness({ onTransport: providerSettings });
    const target = continuationProfiles(h);
    try {
      await h.send('before-provider-switch');
      const owner = h.transport!;
      await selectProvider(h, target);
      const factories = h.factoryCalls.length;
      await expect(h.adapter.configure(h.host, h.session, target, { model: 'deepseek-v4.1-flash' }))
        .rejects.toMatchObject({ code: 'NATIVE_PROFILE_SWITCH_MODEL' });
      expect(h.session.model).toBe('gpt-5.6-sol[effort=high]');
      expect(h.session.nativeRuntime?.profileId).toBe(h.profile.id);
      const waiting = await h.adapter.openOrResume(h.host, h.session, h.project, target);
      expect(waiting.status).toMatchObject({ phase: 'busy', connection: { state: 'connected' } });
      expect(h.factoryCalls).toHaveLength(factories);
      expect(owner.disposed).toBe(false);
      expect(h.session.nativeRuntime?.profileId).toBe(h.profile.id);

      const nextTarget = { ...target, id: 'gateway-c', name: 'Gateway C', config: { ...target.config, apiEndpoint: 'https://next-target.example/v1' } };
      h.host.getProfile = session => session.backendProfileId === nextTarget.id ? nextTarget
        : session.backendProfileId === target.id ? target : h.profile;
      await selectProvider(h, nextTarget);
      expect(h.session.backendProfileId).toBe(nextTarget.id);
      expect(h.session.nativeRuntime?.profileId).toBe(h.profile.id);
      const cancelled = await h.adapter.configure(h.host, h.session, h.profile, { model: 'gpt-5-codex' });
      h.host.bumpConfig(h.session.id, { backendProfileId: h.profile.id, model: cancelled.model });
      h.adapter.afterConfigure(h.host, h.session);
      expect(h.session.configPending).toBe(false);
      expect(h.session.nativeRuntime?.profileId).toBe(h.profile.id);
      expect(h.factoryCalls).toHaveLength(factories);
      expect(owner.disposed).toBe(false);
      await selectProvider(h, target);

      const interrupting = h.adapter.interrupt(h.host, h.session, target);
      await waitFor(() => owner.lastParams('turn/interrupt'));
      owner.finishTurn('turn-1', 'interrupted');
      await interrupting;
      await h.adapter.openOrResume(h.host, h.session, h.project, target);
      expect(owner.disposed).toBe(true);
      expect(h.session.nativeRuntime?.profileId).toBe(target.id);
      expect(h.session.nativeSessionId).toBe('native-thread');
      expect(h.session.configPending).toBe(false);
    } finally { await h.adapter.close(h.host); }
  });

  it('restores the original writer and retains pending intent when the target cannot resume the original thread', async () => {
    const sourceModel = 'gpt-5.6-luna';
    const h = makeHarness({ onTransport: (transport, options) => {
      if (options.args?.includes('model_providers.riffet.base_url="https://target.example/v1"')) transport.setResumeError('Target cannot resume this thread: target-probe-key');
      else transport.setThreadSettings({ model: sourceModel });
    } });
    const target = continuationProfiles(h);
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const owner = h.transport!;
      const threadId = h.session.nativeSessionId;
      const head = h.host.journal!.head(h.session.id);
      expect(h.adapter.status(h.host, h.session).model).toBeUndefined();
      // The terminal observer may still report the stopped pane during rollback.
      h.setTerminalEndpoint(owner.remoteAddress);
      await selectProvider(h, target);

      const switching = h.adapter.openOrResume(h.host, h.session, h.project, target);
      await expect(switching).rejects.toThrow('Target cannot resume this thread');
      await expect(switching).rejects.toMatchObject({ code: 'NATIVE_PROFILE_SWITCH_FAILED' });
      await expect(switching).rejects.not.toThrow(String(target.config.apiKey));
      expect(owner.disposed).toBe(true);
      expect(h.session).toMatchObject({ backendProfileId: target.id, nativeSessionId: threadId, configPending: true });
      expect(h.session.nativeRuntime).toMatchObject({ address: h.transport!.remoteAddress, profileId: h.profile.id });
      expect(h.session.terminalId).toBeUndefined();
      expect(h.transport!.lastParams('thread/resume')).toMatchObject({ threadId, model: sourceModel });
      expect(h.transport!.requestParams.some(request => ['thread/start', 'thread/fork', 'turn/start'].includes(request.method))).toBe(false);
      expect(h.adapter.status(h.host, h.session)).toMatchObject({ connection: { state: 'connected' }, noticeLevel: 'error' });
      expect(h.adapter.status(h.host, h.session).notice).not.toContain(target.config.apiKey);
      expect(h.host.journal!.head(h.session.id).generation).toBe(head.generation);
    } finally { await h.adapter.close(h.host); }
  });

  it('recovers the actual running provider after service restart while retaining the newer target selection', async () => {
    const h = makeHarness({ onTransport: providerSettings });
    const target = continuationProfiles(h);
    let restarted: CodexBackendAdapter | undefined;
    try {
      await h.send('before-pending-restart');
      const owner = h.transport!;
      owner.setThreadStatus('active');
      await selectProvider(h, target);
      const sourceBinding = h.session.nativeRuntime!;
      await h.adapter.close(h.host);
      restarted = new CodexBackendAdapter(h.factory);

      const reopened = await restarted.openOrResume(h.host, h.session, h.project, target);
      expect(reopened.nativeSessionId).toBe('native-thread');
      expect(reopened.status).toMatchObject({ phase: 'busy', connection: { state: 'connected' } });
      expect(h.session).toMatchObject({ backendProfileId: target.id, configPending: true });
      expect(h.session.nativeRuntime?.address).toBe(sourceBinding.address);
      expect(h.session.nativeRuntime?.profileId).toBe(h.profile.id);
      const recovery = h.factoryCalls.find(options => options.remoteAddress === sourceBinding.address);
      expect(recovery?.args).toContain('model_providers.riffet.base_url="https://source.example/v1"');
      expect(owner.disposed).toBe(false);
    } finally { await restarted?.close(h.host); await h.adapter.close(h.host); }
  });

  it.each([false, true])('recovers a persisted switch after the previous daemon is gone (target resume fails: %s)', async targetFails => {
    const connections: Array<{ transport: FakeAppServer; options: CodexAppServerOptions }> = [];
    const h = makeHarness({ onTransport: (transport, options) => {
      providerSettings(transport, options);
      connections.push({ transport, options });
      if (targetFails && options.args?.includes('model_providers.riffet.base_url="https://target.example/v1"')) {
        transport.setResumeError('The target cannot restore this thread');
      }
    } });
    const target = continuationProfiles(h);
    let restarted: CodexBackendAdapter | undefined;
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const sourceAddress = h.transport!.remoteAddress;
      await selectProvider(h, target);
      await h.adapter.close(h.host);
      h.factoryErrors.push(Object.assign(new Error('The saved daemon is gone'), { code: 'ENOENT' }));
      const firstRecovery = h.factoryCalls.length;
      restarted = new CodexBackendAdapter(h.factory);

      const reopening = restarted.openOrResume(h.host, h.session, h.project, target);
      if (targetFails) await expect(reopening).rejects.toMatchObject({ code: 'NATIVE_PROFILE_SWITCH_FAILED' });
      else expect((await reopening).nativeSessionId).toBe('native-thread');
      const recovery = h.factoryCalls.slice(firstRecovery);
      expect(recovery[0]?.remoteAddress).toBe(sourceAddress);
      expect(recovery.filter(options => options.remoteAddress === undefined)).toHaveLength(targetFails ? 3 : 2);
      const sourceConnections = connections.filter(({ options }) => options.remoteAddress === undefined
        && options.args?.includes('model_providers.riffet.base_url="https://source.example/v1"'));
      expect(sourceConnections[1]!.transport.requestParams.some(request => request.method === 'thread/resume')).toBe(false);
      if (targetFails) expect(sourceConnections[2]!.transport.lastParams('thread/resume'))
        .toMatchObject({ threadId: 'native-thread', model: 'gpt-5-codex' });
      expect(h.session.nativeRuntime).toMatchObject({ profileId: targetFails ? h.profile.id : target.id, address: h.transport!.remoteAddress });
      expect(h.session.configPending).toBe(targetFails);
      expect(h.transport!.lastParams('thread/resume')).toMatchObject({ threadId: 'native-thread', model: targetFails ? 'gpt-5-codex' : 'gpt-5.6-sol' });
      expect(sourceConnections.every(({ transport }) => transport.requestParams.filter(request => request.method === 'thread/resume')
        .every(request => request.params.model === 'gpt-5-codex'))).toBe(true);
      expect(h.transport!.requestParams.some(request => ['thread/start', 'thread/fork'].includes(request.method))).toBe(false);
    } finally { await restarted?.close(h.host); await h.adapter.close(h.host); }
  });

  it('does not recreate a writer when a queued provider switch acquires its lock after disposal and archival', async () => {
    const h = makeHarness({ onTransport: providerSettings });
    const target = continuationProfiles(h);
    let enter: () => void = () => undefined;
    let release: () => void = () => undefined;
    let finish: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    h.host.withDetachedSessionLock = async <T>(_id: string, operation: () => Promise<T> | T): Promise<T> => {
      enter();
      await gate;
      try { return await operation(); }
      finally { finish(); }
    };
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const owner = h.transport!;
      await selectProvider(h, target);
      await entered;
      const factories = h.factoryCalls.length;
      await h.adapter.dispose(h.host, h.session.id);
      h.session.archivedAt = new Date().toISOString();
      release();
      await finished;

      expect(owner.disposed).toBe(true);
      expect(h.factoryCalls).toHaveLength(factories);
      expect(h.session.nativeSessionId).toBe('native-thread');
      expect(h.session.nativeRuntime?.profileId).toBe(h.profile.id);
    } finally { release(); await h.adapter.close(h.host); }
  });
});

/**
 * The session record is the client's intent: a settings change must reach a live backend, and it
 * must survive as intent — never as a failed request — while the backend is not running. Codex keeps
 * the handle of a dead transport in its map on purpose (so a later reopen can dispose it), which is
 * why "a runtime object exists" cannot be read as "something can take the patch".
 */
describe('Codex configuration changes', () => {
  const MODEL = 'gpt-5.6-sol[effort=high]';

  it('echoes a model change instead of failing when the app-server handle is a zombie', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const zombie = h.transport!;
    zombie.disconnect();
    expect(h.adapter.status(h.host, h.session).phase).toBe('offline');
    const sent = zombie.requestParams.length;
    const factories = h.factoryCalls.length;

    // Switching the model to get out of a provider failure is the one action a reader must never be
    // refused: the driver answers with what it accepted so the caller can record it.
    await expect(h.adapter.configure(h.host, h.session, h.profile, { model: MODEL, approval: 'danger-full-access' }))
      .resolves.toEqual({ model: MODEL, approval: 'danger-full-access' });
    expect(zombie.requestParams).toHaveLength(sent);
    // Degrading to intent must not spawn a replacement behind the caller's back either: the rebuild
    // belongs to the next open/send, which reads the intent the caller just recorded.
    expect(h.factoryCalls).toHaveLength(factories);
  });

  it('applies the recorded model and approval when a send rebuilds the runtime', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const zombie = h.transport!;
    zombie.disconnect();
    const echoed = await h.adapter.configure(h.host, h.session, h.profile, { model: MODEL, approval: 'danger-full-access' });
    // What `NativeBackendService.configure` writes once the driver returns the echo.
    const record = h.host.updateSession(h.session.id, { model: echoed.model, approval: echoed.approval });

    await h.send('cmd-after-zombie', record.model!, record.approval!);
    expect(h.transport).not.toBe(zombie);
    // The rebuilt runtime resumes the existing thread on the recorded settings…
    expect(h.transport!.lastParams('thread/resume')).toMatchObject({
      model: 'gpt-5.6-sol', approvalPolicy: 'never', sandbox: 'danger-full-access', config: { model_reasoning_effort: 'high' },
    });
    // …and the turn carries them too, so a resumed thread is not the only thing that agrees.
    expect(h.transport!.lastParams('turn/start')).toMatchObject({ model: 'gpt-5.6-sol', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  });

  it('opens an existing thread on the configuration being applied, not on the runtime\'s stale snapshot', async () => {
    const h = makeHarness();
    // A subscription is how a session whose thread is already known gets an online runtime that has
    // not attached the thread yet — the state in which the applied settings still decide the open.
    h.session.nativeSessionId = 'native-thread';
    h.session.model = 'gpt-5-codex';
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, () => undefined);
    await waitFor(() => h.adapter.status(h.host, h.session).phase === 'offline' && h.transport !== undefined ? true : undefined);
    expect(h.transport!.requestParams.some(request => ['thread/resume', 'thread/start', 'turn/start'].includes(request.method))).toBe(false);

    await h.adapter.configure(h.host, h.session, h.profile, { model: MODEL, approval: 'danger-full-access' });
    const opened = h.transport!.requestParams.find(request => request.method === 'thread/resume');
    expect(opened?.method).toBe('thread/resume');
    // The first request on the wire already carries the new settings; the explicit resume that
    // follows is what a reader adopting the open's response would otherwise have had to correct.
    expect(opened?.params).toMatchObject({ model: 'gpt-5.6-sol', approvalPolicy: 'never', sandbox: 'danger-full-access', config: { model_reasoning_effort: 'high' } });
    unsubscribe();
  });

  // An approval policy alone is not a permission: `never` inside the read-only sandbox Codex picks
  // for an untrusted project can neither write nor ask to, so every permission names its sandbox too.
  it.each([
    ['on-request', 'on-request', 'workspace-write', { type: 'workspaceWrite', writableRoots: [], networkAccess: false }],
    ['read-only', 'on-request', 'read-only', { type: 'readOnly', networkAccess: false }],
    ['danger-full-access', 'never', 'danger-full-access', { type: 'dangerFullAccess' }],
    ['unrestricted', 'never', 'danger-full-access', { type: 'dangerFullAccess' }],
    ['never', 'on-request', 'workspace-write', { type: 'workspaceWrite' }],
  ])('sends permission %s as approval %s with the %s sandbox', async (approval, approvalPolicy, sandbox, sandboxPolicy) => {
    const h = makeHarness();
    h.session.approval = approval;
    await h.send('cmd-permission', 'gpt-5-codex', approval);
    expect(h.transport!.lastParams('thread/start')).toMatchObject({ approvalPolicy, sandbox });
    expect(h.transport!.lastParams('turn/start')).toMatchObject({ approvalPolicy, sandboxPolicy });
  });

  it.each([codexFlavor, traexFlavor])('$label sends a plain turn without extra context', async flavor => {
    const h = makeHarness({ flavor });
    // The first turn establishes the native permission; the next one must not repeat it.
    await h.send('cmd-first');
    h.transport!.finishTurn('turn-1', 'completed');
    await h.send('cmd-plain');
    const plain = h.transport!.lastParams('turn/start')!;
    expect(plain.additionalContext).toBeUndefined();
    if (flavor.id === 'codex') expect(plain.sandboxPolicy).toMatchObject({ networkAccess: false });
    else {
      expect(plain).not.toHaveProperty('permissions'); // TRAE inherits its unchanged native profile.
      expect(plain).not.toHaveProperty('sandboxPolicy');
    }
  });

  it('records a legacy permission id as the preset it now runs as', async () => {
    const h = makeHarness();
    await expect(h.adapter.configure(h.host, h.session, h.profile, { approval: 'never' })).resolves.toEqual({ approval: 'on-request' });
    await expect(h.adapter.configure(h.host, h.session, h.profile, { approval: 'unrestricted' })).resolves.toEqual({ approval: 'danger-full-access' });
  });

  it('advertises only the presets', async () => {
    const h = makeHarness();
    expect((await h.adapter.capabilities(h.host, h.profile)).permissions.map(item => item.id)).toEqual(['on-request', 'read-only', 'danger-full-access']);
  });
});

describe('Codex transcript identity across runtime rebuilds', () => {
  it.each([
    { flavor: codexFlavor, noAltScreen: true },
    { flavor: traexFlavor, noAltScreen: false },
  ])('$flavor.label launches the app-server and TUI without bypassing hook review before the first send', async ({ flavor, noAltScreen }) => {
    const shared = flavor.id === 'codex' ? { unixSocket: true, remoteUnix: true } : { wsAuth: true, remoteWs: true };
    const probe = vi.spyOn(codexConfig, 'probeAppServer').mockResolvedValue({
      ...fakeProbe, ...shared, appServer: true, noAltScreen,
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const h = makeHarness({ flavor });
    const launch = vi.fn(async () => {
      h.setTerminalEndpoint(h.transport!.remoteAddress);
      return { id: h.session.terminalId!, state: 'running' };
    });
    h.host.launchPty = launch as unknown as NativeBackendHost['launchPty'];
    const lookup = vi.spyOn(h.host.terminal, 'inspectPane');
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      await h.send('cmd-first-send');
      expect(launch).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith(h.session.terminalId, h.session.id, expect.objectContaining({ deadline: expect.any(Number) }));
      expect(h.factoryCalls).toHaveLength(1);
      expect(h.transport!.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(1);
      const spec = (launch.mock.calls[0] as unknown as [Session, Project, { args: string[] }])[2];
      expect(h.factoryCalls[0]!.args).not.toContain('--dangerously-bypass-hook-trust');
      expect(spec.args).not.toContain('--dangerously-bypass-hook-trust');
      expect(spec.args).toContain('-c');
      expect(spec.args.includes('--no-alt-screen')).toBe(noAltScreen);
      expect(spec.args).toContain('native-thread');
    } finally {
      await h.adapter.close(h.host);
      probe.mockRestore();
    }
  });

  it.each([codexFlavor, traexFlavor])('$label does not let an older thread read undo a turn started while that read was pending', async flavor => {
    const h = makeHarness({ flavor });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setTurns([{ id: 'old-ended', status: 'completed', items: [] }]);
    const gate = h.deferEndpointRequest(h.transport!.remoteAddress, 'thread/read');
    const reading = prime(h);
    await gate.entered;
    h.transport!.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'active-new' } });
    expect(h.adapter.status(h.host, h.session).phase).toBe('busy');
    gate.release();
    await reading;
    expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'active-new' } });
    // A later, bounded read still omitting the new target must not clear it either.
    h.transport!.setThreadStatus('active');
    await prime(h);
    expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'active-new' } });
    await h.adapter.dispose(h.host, h.session.id);
  });

});

describe('TRAE CLI flavor', () => {
  const traex = () => makeHarness({ flavor: traexFlavor });

  it.each(['list first', 'backgrounded first'])('keeps a detached preview active after the native foreground ends (%s)', async order => {
    const h = traex();
    let unsubscribe = () => {};
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const transport = h.transport!;
      const terminal = { processId: '52007', itemId: 'preview-shell', command: 'npm run preview', cwd: h.project.cwd };
      transport.setTerminals([terminal], { outcome: 'terminationRequested' });
      transport.setThreadStatus('active');
      const item = { type: 'commandExecution', id: terminal.itemId, processId: terminal.processId, command: terminal.command, status: 'backgrounded', exitCode: 0 };
      transport.setTurns([{ id: 'native-tui', status: 'inProgress', items: [] }]);
      transport.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'native-tui' } });
      transport.emitNativeNotification('item/started', { threadId: 'native-thread', turnId: 'native-tui', item: { ...item, status: 'inProgress', exitCode: null } });
      const lists = () => transport.requestParams.filter(request => request.method === 'thread/backgroundTerminals/list').length;
      if (order === 'list first') {
        unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, () => undefined);
        await waitFor(() => lists() === 1 ? true : undefined);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(h.adapter.status(h.host, h.session).activity?.background).toBeUndefined();
      }
      transport.emitNativeNotification('item/completed', { threadId: 'native-thread', turnId: 'native-tui', item });
      if (order !== 'list first') unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, () => undefined);
      await waitFor(() => h.adapter.status(h.host, h.session).activity?.background === 1 ? true : undefined);
      // Explicit detachment needs one list, not two post-completion observations.
      expect(lists()).toBe(order === 'list first' ? 2 : 1);
      transport.setTurns([
        { id: 'old-turn', status: 'inProgress', items: [] },
        { id: 'native-tui', status: 'completed', items: [item, { type: 'agentMessage', id: 'native-answer', text: 'Preview is ready' }] },
      ]);
      transport.finishTurn('native-tui', 'completed');
      transport.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: 'active', activeFlags: [] } });
      await prime(h);
      expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'idle', activity: { background: 1 } });
      expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
      // No command mapping exists for the TUI turn. A read ending before its live end must not
      // regress the foreground fence, then revive it from a late same-turn inProgress copy.
      transport.setTurns([{ id: 'old-turn', status: 'completed', items: [] }]);
      await prime(h);
      transport.setTurns([{ id: 'native-tui', status: 'inProgress', items: [item] }]);
      await prime(h);
      expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'idle', activity: { background: 1 } });
      await h.send('next-ordinary');
      expect(transport.requestParams.filter(request => request.method === 'turn/start')).toHaveLength(1);
      expect(transport.lastParams('turn/steer')).toBeUndefined();
      // The old history window cannot clear this new run, and its completion does not end the preview.
      await prime(h);
      expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'turn-1' }, activity: { background: 1 } });
      transport.finishTurn('turn-1', 'completed');
      expect(h.adapter.status(h.host, h.session).activity?.background).toBe(1);
      const activityId = 'traex:terminal:52007';
      const gate = h.deferEndpointRequest(transport.remoteAddress, 'thread/backgroundTerminals/stop');
      const first = h.adapter.stopActivity(h.host, h.session, h.profile, activityId);
      await gate.entered;
      const second = h.adapter.stopActivity(h.host, h.session, h.profile, activityId);
      gate.release();
      await expect(Promise.all([first, second])).resolves.toEqual([expect.objectContaining({ status: 'stopped' }), expect.objectContaining({ status: 'stopped' })]);
      expect(transport.requestParams.filter(request => request.method === 'thread/backgroundTerminals/stop')).toHaveLength(1);
      const persisted = () => h.host.journal!.activityEntities(h.session.id).map(entity => activityOfEvent(entity.payload)).find(activity => activity?.id === activityId);
      expect(persisted()?.status).toBe('stopped');
      const before = lists();
      transport.setTerminals([terminal]);
      transport.emitNativeNotification('item/completed', { threadId: 'native-thread', turnId: 'native-tui', item });
      await waitFor(() => lists() > before ? true : undefined);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(h.adapter.status(h.host, h.session).activity?.background).toBeUndefined();
      expect(persisted()?.status).toBe('stopped');
    } finally { unsubscribe(); await h.adapter.close(h.host); }
  });

  it('keeps provisional or unknown foreground work busy and a rejected send cannot erase a native end', async () => {
    const h = traex();
    try {
      await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
      const transport = h.transport!;
      transport.setThreadStatus('active');
      await prime(h);
      expect(h.adapter.status(h.host, h.session).phase).toBe('busy');
      transport.setTurns([{ id: 'native-new', status: 'interrupted', items: [] }]);
      await prime(h);
      expect(h.adapter.status(h.host, h.session).phase).toBe('busy');
      transport.emitNativeNotification('turn/started', { threadId: 'native-thread', turn: { id: 'native-new' } });
      await prime(h);
      expect(h.adapter.status(h.host, h.session)).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'native-new' } });
      transport.finishTurn('native-new', 'completed');
      await prime(h);
      expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
      const request = transport.request.bind(transport);
      transport.request = async (method, params) => {
        if (method === 'turn/start') throw new Error('rejected before starting');
        return await request(method, params);
      };
      await expect(h.send('rejected')).rejects.toThrow('rejected before starting');
      transport.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: 'active', activeFlags: [] } });
      expect(h.adapter.status(h.host, h.session).phase).toBe('idle');
    } finally { await h.adapter.close(h.host); }
  });

  it.each([
    ['on-request', 'on-request', 'user', ':workspace'],
    ['auto-review', 'on-request', 'auto_review', ':workspace'],
    ['danger-full-access', 'never', 'user', ':danger-full-access'],
    ['read-only', 'on-request', 'user', ':read-only'],
  ])('uses native TRAE permission profile and reviewer for %s', async (approval, approvalPolicy, approvalsReviewer, id) => {
    const h = traex();
    h.session.approval = approval;
    await h.send('permission-turn', 'probe-model', approval);
    const expected = { approvalPolicy, approvalsReviewer, permissions: { type: 'profile', id } };
    expect(h.transport!.lastParams('thread/start')).toMatchObject(expected);
    expect(h.transport!.lastParams('turn/start')).toMatchObject(expected);
    expect(h.transport!.lastParams('thread/start')).not.toHaveProperty('sandbox');
    expect(h.transport!.lastParams('turn/start')).not.toHaveProperty('sandboxPolicy');
    h.transport!.finishTurn('turn-1', 'completed');
    await h.adapter.configure(h.host, h.session, h.profile, { approval });
    expect(h.transport!.lastParams('thread/settings/update')).toMatchObject(expected);
    expect(h.transport!.lastParams('thread/settings/update')).not.toHaveProperty('sandboxPolicy');
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('adopts native permission changes once and keeps partial configuration in the same mode', async () => {
    const h = traex();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const settings = { approvalPolicy: 'on-request', approvalsReviewer: 'guardian_subagent', activePermissionProfile: { id: ':workspace', modifications: [] } };
    h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'another-thread', threadSettings: settings });
    expect(h.session.approval).toBe('on-request');
    h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: settings });
    h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: settings });
    expect(h.session.approval).toBe('auto-review');
    expect(h.host.bumpConfig).toHaveBeenCalledOnce();
    expect(h.session.configRevision).toBe(1);
    // A previously prepared dispatch must not restore the old Full Access snapshot.
    await h.send('native-auto', 'probe-model', 'danger-full-access');
    expect(h.adapter.status(h.host, h.session).approval).toBe('auto-review');
    expect(h.transport!.lastParams('turn/start')).not.toHaveProperty('permissions');
    // A settings update can target the next turn without resuming or interrupting the running one.
    const narrowed = { approvalPolicy: 'on-request', approvalsReviewer: 'user', activePermissionProfile: { id: ':read-only', modifications: [] } };
    h.transport!.setSettingsUpdateResponse(narrowed);
    await h.adapter.configure(h.host, h.session, h.profile, { model: 'next-model' });
    expect(h.session.approval).toBe('read-only');
    expect(h.host.bumpConfig).toHaveBeenCalledTimes(2);
    // A later notification outranks an older response, even when it repeats the recorded mode.
    h.transport!.setSettingsUpdateResponse({ approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', modifications: [] } });
    const gate = h.deferEndpointRequest(h.transport!.remoteAddress, 'thread/settings/update');
    const configuring = h.adapter.configure(h.host, h.session, h.profile, { model: 'next-model' });
    await gate.entered;
    h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: narrowed });
    gate.release();
    await configuring;
    expect(h.session.approval).toBe('read-only');
    expect(h.host.bumpConfig).toHaveBeenCalledTimes(2);
    expect(h.transport!.lastParams('thread/settings/update')).toMatchObject({ model: 'next-model' });
    expect(h.transport!.lastParams('thread/settings/update')).not.toHaveProperty('permissions');
    expect(h.transport!.lastParams('thread/settings/update')).not.toHaveProperty('approvalsReviewer');
    expect(h.transport!.lastParams('thread/resume')).toBeUndefined();
    expect(h.transport!.lastParams('turn/interrupt')).toBeUndefined();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it.each(['read-only', 'danger-full-access'])('keeps newer native permissions when an explicit %s update reply arrives later', async reported => {
    const h = traex();
    const endpoint = h.registerEndpoint('unix:///trae-permission-resume.sock');
    endpoint.setLoadedThreads(['native-thread']);
    endpoint.setThreadSettings({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: {
      type: 'workspaceWrite', networkAccess: true, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    }, activePermissionProfile: null });
    h.session.nativeSessionId = 'native-thread';
    h.session.nativeRuntime = makeBinding(h, endpoint.remoteAddress);
    await prime(h);
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, () => undefined);
    await waitFor(() => h.session.approval === 'auto-review' ? true : undefined);
    expect(h.session.approval).toBe('auto-review');
    const requested = reported === 'read-only' ? 'danger-full-access' : 'read-only';
    const nativeSettings = (mode: string) => ({ approvalPolicy: mode === 'read-only' ? 'on-request' : 'never', approvalsReviewer: 'user',
      activePermissionProfile: { id: mode === 'read-only' ? ':read-only' : ':danger-full-access', modifications: [] },
    });
    h.transport!.setSettingsUpdateResponse(nativeSettings(requested));
    const gate = h.deferEndpointRequest(endpoint.remoteAddress, 'thread/settings/update');
    const change = h.adapter.configure(h.host, h.session, h.profile, { approval: requested });
    await gate.entered;
    h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: nativeSettings(reported) });
    expect(h.session.approval).toBe('auto-review');
    expect(h.host.bumpConfig).toHaveBeenCalledOnce();
    gate.release();
    const configured = await change;
    expect(configured.approval).toBe(reported);
    // The service persists the driver's effective configuration before releasing the outer lock.
    h.host.bumpConfig(h.session.id, { approval: configured.approval });
    expect(h.adapter.status(h.host, h.session).approval).toBe(reported);
    expect(h.transport!.lastParams('thread/settings/update')).toMatchObject({ approvalsReviewer: 'user', permissions: { id: nativeSettings(requested).activePermissionProfile.id } });
    await h.send('after-permission-update', 'probe-model', requested);
    expect(h.transport!.lastParams('turn/start')).not.toHaveProperty('permissions');
    expect(h.adapter.status(h.host, h.session).approval).toBe(reported);
    unsubscribe();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it.each(['open', 'observer'])('does not restore stale permissions from a delayed %s resume response', async action => {
    const h = traex();
    const endpoint = h.registerEndpoint(`unix:///trae-${action}-permission-race.sock`);
    endpoint.setLoadedThreads(['native-thread']);
    endpoint.setThreadSettings({ approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', modifications: [] } });
    h.session.nativeSessionId = 'native-thread';
    h.session.nativeRuntime = makeBinding(h, endpoint.remoteAddress);
    h.session.approval = 'danger-full-access';
    const gate = h.deferEndpointRequest(endpoint.remoteAddress, 'thread/resume');
    const unsubscribe = action === 'observer' ? h.adapter.subscribe(h.host, h.session, h.profile, () => undefined) : undefined;
    const opening = action === 'open' ? h.adapter.openOrResume(h.host, h.session, h.project, h.profile) : undefined;
    await gate.entered;
    h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: {
      approvalPolicy: 'on-request', approvalsReviewer: 'user', activePermissionProfile: { id: ':read-only', modifications: [] },
    } });
    gate.release();
    await opening;
    await waitFor(() => h.adapter.status(h.host, h.session).connection?.state === 'connected' ? true : undefined);
    expect(h.session.approval).toBe('read-only');
    expect(h.host.bumpConfig).toHaveBeenCalledOnce();
    await h.send('after-resume-permission', 'probe-model', 'danger-full-access');
    expect(h.transport!.lastParams('turn/start')).not.toHaveProperty('permissions');
    expect(h.adapter.status(h.host, h.session).approval).toBe('read-only');
    unsubscribe?.();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('adopts a later native change when a pending permission turn is acknowledged', async () => {
    const h = traex();
    h.session.approval = 'read-only';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.session.configPending = true;
    const gate = h.deferEndpointRequest(h.transport!.remoteAddress, 'turn/start');
    const sending = h.send('pending-permission-race', 'probe-model', 'read-only');
    await gate.entered;
    h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: {
      approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', modifications: [] },
    } });
    gate.release();
    await sending;
    expect(h.session.configPending).toBe(false);
    expect(h.session.approval).toBe('danger-full-access');
    expect(h.adapter.status(h.host, h.session).approval).toBe('danger-full-access');
    h.transport!.finishTurn('turn-1', 'completed');
    await h.send('after-pending-permission-race', 'probe-model', 'read-only');
    expect(h.transport!.lastParams('turn/start')).not.toHaveProperty('permissions');
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('fences and sends native settings observed during asynchronous model and terminal preparation', async () => {
    const h = traex();
    h.session.approval = 'danger-full-access';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
    runtime.terminalId = 'permission-terminal';
    let release: () => void = () => undefined;
    const terminal = new Promise<void>(resolve => { release = resolve; });
    Object.assign(h.host.terminal, { get: async () => { await terminal; return { id: runtime.terminalId, state: 'running', epoch: 1 }; } });
    const fences: NativeDispatchBinding[] = [];
    const sending = runtime.send({ runId: 'permission-run', commandId: 'permission-command', renderedText: 'Inspect', input: [{ type: 'text', text: 'Inspect' }],
      config: { model: 'probe-model', mode: 'default', approval: 'danger-full-access' }, nativeSessionId: 'native-thread',
      commitDispatchFence: binding => { if (binding) fences.push(binding); },
    });
    h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: {
      approvalPolicy: 'on-request', approvalsReviewer: 'user', activePermissionProfile: { id: ':read-only', modifications: [] },
      collaborationMode: { mode: 'plan' },
    } });
    release();
    await sending;
    expect(fences[0]?.resolvedConfig?.approval).toBe('read-only');
    expect(fences[0]?.resolvedConfig?.mode).toBe('plan');
    expect(h.transport!.lastParams('turn/start')?.collaborationMode).toMatchObject({ mode: 'plan' });
    expect(h.transport!.lastParams('turn/start')).not.toHaveProperty('permissions');
    expect(h.session.approval).toBe('read-only');
    await h.adapter.dispose(h.host, h.session.id);
  });

  it.each([
    { activePermissionProfile: { id: ':workspace', modifications: [{ type: 'additionalWritableRoot', path: '/extra' }] } },
    { activePermissionProfile: null, sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  ])('preserves customized native permissions through model changes and ordinary turns: %j', async customization => {
    const h = traex();
    h.session.approval = 'danger-full-access';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: {
      approvalPolicy: 'on-request', approvalsReviewer: 'user', ...customization,
    } });
    expect(h.session.approval).toBe('danger-full-access');
    expect(h.adapter.status(h.host, h.session).approval).toBe('custom');
    expect(h.host.bumpConfig).not.toHaveBeenCalled();
    await h.adapter.configure(h.host, h.session, h.profile, { model: 'next-model' });
    const settings = h.transport!.lastParams('thread/settings/update')!;
    for (const field of ['permissions', 'permissionProfile', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy']) expect(settings).not.toHaveProperty(field);
    await h.send('preserve-custom', 'next-model', h.session.approval!);
    const params = h.transport!.lastParams('turn/start')!;
    for (const field of ['permissions', 'permissionProfile', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy']) expect(params).not.toHaveProperty(field);
    h.transport!.finishTurn('turn-1', 'completed');
    await h.adapter.configure(h.host, h.session, h.profile, { approval: 'read-only' });
    expect(h.transport!.lastParams('thread/settings/update')).toMatchObject({ permissions: { id: ':read-only' }, approvalsReviewer: 'user' });
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('keeps an offline permission switch pending until a turn applies it after native attachment', async () => {
    const h = traex();
    const endpoint = h.registerEndpoint('unix:///trae-pending-permission.sock');
    endpoint.setLoadedThreads(['native-thread']);
    endpoint.setThreadSettings({ approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', modifications: [] } });
    h.session.nativeSessionId = 'native-thread';
    h.session.nativeRuntime = makeBinding(h, endpoint.remoteAddress);
    const configured = await h.adapter.configure(h.host, h.session, h.profile, { approval: 'read-only' });
    Object.assign(h.session, configured);
    expect(h.session.configPending).toBe(true);
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, () => undefined);
    await waitFor(() => h.adapter.status(h.host, h.session).connection?.state === 'connected' ? true : undefined);
    expect(h.session.approval).toBe('read-only');
    await h.send('pending-permission', 'probe-model', h.session.approval!);
    expect(h.transport!.lastParams('turn/start')).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: { id: ':read-only' } });
    expect(h.session.configPending).toBe(false);
    expect(h.session.approval).toBe('read-only');
    unsubscribe();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it.each([codexFlavor, traexFlavor])('publishes advertised Standard/Max contexts only for TRAE models ($id)', async flavor => {
    const h = makeHarness({ flavor });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setModels([
      { model: 'openrouter-4o', supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Max reasoning' }], businessMetadata: { variants: {
        standard_key: 'openrouter-4o__dev', standard_context_window: 200_000,
        max_key: 'openrouter-4o__max', max_context_window: 1_000_000,
      } } },
      { model: 'standard-only', businessMetadata: { variants: { standard_key: 'standard-only__dev', max_key: null } } },
      { model: 'no-metadata' },
    ]);
    const models = await h.adapter.listModels(h.host, h.project, h.profile, h.session);
    const context = models[0]!.configOptions.find(option => option.id === 'context');
    if (flavor.id === 'traex') {
      expect(context).toMatchObject({ category: 'model_config', currentValue: 'standard', options: [
        { value: 'standard', name: 'Standard · 200K' }, { value: 'max', name: 'Max · 1M' },
      ] });
    } else expect(context).toBeUndefined();
    expect(models[0]!.configOptions.find(option => option.id === 'effort')?.options[0]?.value).toBe('max');
    expect(models.slice(1).every(model => model.configOptions.every(option => option.id !== 'context'))).toBe(true);
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('carries Max through native creation, resume and turns, and clears it atomically when changing models', async () => {
    const h = traex();
    h.session.model = 'openrouter-4o[context=max,effort=high]';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    expect(h.transport!.lastParams('thread/start')).toMatchObject({ model: 'openrouter-4o', config: {
      model_backend_variant: 'max', model_reasoning_effort: 'high',
    } });

    await h.adapter.configure(h.host, h.session, h.profile, { model: 'openrouter-4o[context=standard,effort=high]', mode: 'plan', approval: 'read-only' });
    expect(h.transport!.lastParams('thread/resume')).toBeUndefined();
    expect(h.transport!.lastParams('thread/settings/update')).toMatchObject({ model: 'openrouter-4o', modelBackendVariant: 'standard', effort: 'high',
      approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: { type: 'profile', id: ':read-only' },
      collaborationMode: { mode: 'plan', settings: { model: 'openrouter-4o', reasoning_effort: 'high' } },
    });
    await h.send('max-turn', 'openrouter-4o[context=max,effort=max]', 'read-only', 'Plan it', 'plan');
    expect(h.transport!.lastParams('turn/start')).toMatchObject({ model: 'openrouter-4o', modelBackendVariant: 'max', effort: 'max',
      collaborationMode: { mode: 'plan', settings: { model: 'openrouter-4o', reasoning_effort: 'max' } },
    });
    h.transport!.finishTurn('turn-1', 'completed');
    await h.adapter.configure(h.host, h.session, h.profile, { model: 'gpt-5.2' });
    expect(h.transport!.lastParams('thread/settings/update')).toMatchObject({ model: 'gpt-5.2', modelBackendVariant: 'standard', effort: null });
    await h.send('plain-turn', 'gpt-5.2');
    expect(h.transport!.lastParams('turn/start')).toMatchObject({ model: 'gpt-5.2', modelBackendVariant: 'standard' });
    await h.adapter.dispose(h.host, h.session.id);

    const resumed = traex();
    resumed.session.nativeSessionId = 'saved-trae-thread';
    resumed.session.model = 'openrouter-4o[context=max]';
    await resumed.adapter.openOrResume(resumed.host, resumed.session, resumed.project, resumed.profile);
    expect(resumed.transport!.lastParams('thread/resume')).toMatchObject({ threadId: 'saved-trae-thread', model: 'openrouter-4o', config: { model_backend_variant: 'max' } });
    await resumed.adapter.dispose(resumed.host, resumed.session.id);
  });

  it('rejects an invalid TRAE context before fencing a native submission', async () => {
    const h = traex();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await expect(h.send('invalid-context', 'openrouter-4o[context=1m]')).rejects.toMatchObject({ code: 'INVALID_NATIVE_MODEL' });
    expect(h.dispatchFences).toHaveLength(0);
    expect(h.transport!.lastParams('turn/start')).toBeUndefined();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('states a chosen collaboration mode with each turn, and leaves an unchosen one alone', async () => {
    const h = traex();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('cmd-plan', 'GPT-5.5', 'on-request', 'Plan it', 'plan');
    expect(h.transport!.lastParams('turn/start')!.collaborationMode).toEqual({ mode: 'plan', settings: { model: 'GPT-5.5', reasoning_effort: null } });
    h.transport!.finishTurn('turn-1', 'completed');
    await h.send('cmd-code', 'GPT-5.5');
    expect(h.transport!.lastParams('turn/start')).not.toHaveProperty('collaborationMode');
    expect(await h.adapter.capabilities(h.host, h.profile)).toMatchObject({ supportsModeSelection: true, modes: [{ id: 'default' }, { id: 'plan' }] });
    await h.adapter.dispose(h.host, h.session.id);
    // With the CLI default selected, start returns the real model at top level. A mode-only
    // configuration must use it, not silently drop collaborationMode or invent a model.
    const defaultModel = traex();
    defaultModel.registerEndpoint('unix:///fake-codex-1.sock').setThreadSettings({ model: 'cli-default-model' });
    await defaultModel.adapter.openOrResume(defaultModel.host, defaultModel.session, defaultModel.project, defaultModel.profile);
    await defaultModel.adapter.configure(defaultModel.host, defaultModel.session, defaultModel.profile, { mode: 'plan' });
    expect(defaultModel.transport!.lastParams('thread/start')).toMatchObject({ model: null });
    expect(defaultModel.transport!.lastParams('thread/settings/update')).toMatchObject({ collaborationMode: { mode: 'plan', settings: { model: 'cli-default-model' } } });
    expect(defaultModel.transport!.lastParams('thread/settings/update')).not.toHaveProperty('model');
    await defaultModel.adapter.close(defaultModel.host);
  });

  it.each(['before the RPC returns', 'after the confirmation timeout'])('confirms a mode change resolved %s', async resolution => {
    const h = traex();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('cmd-plan', 'GPT-5.5', 'on-request', 'Plan it', 'plan');
    h.transport!.emitNativeNotification('item/completed', {
      threadId: 'native-thread', turnId: 'turn-1', startedAtMs: 2,
      item: { type: 'plan', id: 'turn-1-plan', text: '# Add hello.txt\n\n1. Create it.' },
    });
    h.transport!.emitNativeNotification('mode/changeRequested', {
      threadId: 'native-thread', turnId: 'turn-1', requestId: 'req-7', targetMode: 'default', reason: 'Plan is ready',
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
    });
    const card = await waitFor(() => h.adapter.interaction(h.host, h.session));
    expect(card).toMatchObject({ kind: 'plan', requestId: 'mode:req-7' });
    expect(card!.message).toContain('# Add hello.txt');
    expect(card!.message).toContain('- Bash: run tests');
    const response = { interactionId: card!.id, revision: card!.revision, requestId: 'web-mode', action: 'approve' } as const;
    const resolved = { threadId: 'native-thread', turnId: 'turn-1', requestId: 'req-7', targetMode: 'default', decision: 'approved' };
    const gate = resolution === 'before the RPC returns' ? h.deferEndpointRequest(h.transport!.remoteAddress, 'mode/change/respond') : undefined;
    const answering = h.adapter.respond(h.host, h.session, h.profile, response);
    if (gate) {
      await gate.entered;
      h.transport!.emitNativeNotification('mode/changeResolved', resolved);
      h.transport!.finishTurn('turn-1', 'completed');
      gate.release();
    }
    const result = await answering;
    expect(result.status).toBe(gate ? 'completed' : 'uncertain');
    expect(h.transport!.lastParams('mode/change/respond')).toEqual({ threadId: 'native-thread', requestId: 'req-7', decision: 'approved' });
    if (!gate) {
      expect((await h.adapter.respond(h.host, h.session, h.profile, { ...response, requestId: 'web-mode-retry', action: 'deny' })).status).toBe('uncertain');
      expect(h.transport!.requestParams.filter(entry => entry.method === 'mode/change/respond')).toHaveLength(1);
      h.transport!.emitNativeNotification('mode/changeResolved', resolved);
    }
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    expect(h.getReceipt('web-mode')?.result.status).toBe('completed');
    expect(h.session.mode).toBe('default');
    expect((await h.adapter.respond(h.host, h.session, h.profile, response)).status).toBe('completed');
    expect(h.transport!.requestParams.filter(entry => entry.method === 'mode/change/respond')).toHaveLength(1);
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('requires complete mode resolution identity and handles native rejection and cancellation without a web reply', async () => {
    const h = traex();
    h.session.mode = 'plan';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('mode-identity', 'GPT-5.5', 'on-request', 'Plan it', 'plan');
    for (const decision of ['rejected', 'cancelled']) {
      const params = { threadId: 'native-thread', turnId: 'turn-1', requestId: `native-${decision}`, targetMode: 'default' };
      h.transport!.emitNativeNotification('mode/changeRequested', params);
      const card = await waitFor(() => h.adapter.interaction(h.host, h.session));
      if (decision === 'rejected') {
        const resolved = { ...params, decision };
        const invalid = [
          { ...resolved, threadId: undefined }, { ...resolved, threadId: 'other-thread' },
          { ...resolved, turnId: undefined }, { ...resolved, turnId: 'other-turn' },
          { ...resolved, requestId: 'other-request' }, { ...resolved, targetMode: undefined },
          { ...resolved, targetMode: 'plan' }, { ...resolved, decision: undefined }, { ...resolved, decision: 'accepted' },
        ];
        for (const notification of invalid) {
          h.transport!.emitNativeNotification('mode/changeResolved', notification);
          expect(h.adapter.interaction(h.host, h.session)?.id).toBe(card!.id);
          expect(h.session.mode).toBe('plan');
        }
      }
      h.transport!.emitNativeNotification('mode/changeResolved', { ...params, decision });
      expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
      expect(h.session.mode).toBe('plan');
    }
    expect(h.transport!.requestParams.filter(entry => entry.method === 'mode/change/respond')).toHaveLength(0);
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('expires NoPending mode requests as uncertain, removes the card, and never retries the obsolete native request', async () => {
    const h = traex();
    h.session.mode = 'default';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('mode-expired', 'GPT-5.5');
    h.transport!.setModeChangeError(Object.assign(new Error('No pending mode change found for request_id: expired-request'), { rpcCode: -32600, rpcError: true }));
    h.transport!.emitNativeNotification('mode/changeRequested', { threadId: 'native-thread', turnId: 'turn-1', requestId: 'expired-request', targetMode: 'plan' });
    const card = await waitFor(() => h.adapter.interaction(h.host, h.session));
    const response = { interactionId: card!.id, revision: card!.revision, requestId: 'web-expired', action: 'approve' };
    const result = await h.adapter.respond(h.host, h.session, h.profile, response);
    expect(result.status).toBe('uncertain');
    expect(h.getReceipt('web-expired')?.result).toEqual(result);
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    expect(h.session.mode).toBe('default');
    expect(await h.adapter.respond(h.host, h.session, h.profile, response)).toEqual(result);
    expect((await h.adapter.respond(h.host, h.session, h.profile, { ...response, requestId: 'another-expired-retry' })).status).toBe('uncertain');
    expect(h.transport!.requestParams.filter(entry => entry.method === 'mode/change/respond')).toHaveLength(1);
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('does not resend a timed-out mode response under a new request id and confirms only the original choice on late resolution', async () => {
    const h = traex();
    h.session.mode = 'plan';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const params = { threadId: 'native-thread', turnId: 'turn-1', requestId: 'transport-timeout', targetMode: 'default' };
    h.transport!.emitNativeNotification('mode/changeRequested', params);
    const card = await waitFor(() => h.adapter.interaction(h.host, h.session));
    h.transport!.setModeChangeError(Object.assign(new Error('mode/change/respond timed out'), { code: 'ETIMEDOUT' }));
    const response = { interactionId: card!.id, revision: card!.revision, requestId: 'web-timeout', action: 'approve' };
    expect((await h.adapter.respond(h.host, h.session, h.profile, response)).status).toBe('uncertain');
    expect(h.adapter.interaction(h.host, h.session)?.id).toBe(card!.id);
    const retry = { ...response, requestId: 'web-timeout-retry', action: 'deny' };
    expect((await h.adapter.respond(h.host, h.session, h.profile, retry)).status).toBe('uncertain');
    expect(h.transport!.requestParams.filter(entry => entry.method === 'mode/change/respond')).toHaveLength(1);
    expect(h.getReceipt(response.requestId)?.result.status).toBe('uncertain');
    expect(h.getReceipt(retry.requestId)?.result.status).toBe('uncertain');
    h.transport!.emitNativeNotification('mode/changeResolved', { ...params, decision: 'approved' });
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    expect((await h.adapter.respond(h.host, h.session, h.profile, response)).status).toBe('completed');
    expect((await h.adapter.respond(h.host, h.session, h.profile, retry)).status).toBe('uncertain');
    expect(h.transport!.requestParams.filter(entry => entry.method === 'mode/change/respond')).toHaveLength(1);
    await h.adapter.dispose(h.host, h.session.id);
  });

  it.each([
    ['approve', 'approved', 'completed'], ['deny', 'rejected', 'completed'], ['cancel', 'cancelled', 'completed'],
    ['approve', 'rejected', 'uncertain'],
  ])('keeps the actual native %s/%s receipt when resolution races an RPC error (%s)', async (action, decision, expected) => {
    const h = traex();
    h.session.mode = 'plan';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('mode-error-race', 'GPT-5.5', 'on-request', 'Plan it', 'plan');
    const params = { threadId: 'native-thread', turnId: 'turn-1', requestId: 'race-request', targetMode: 'default' };
    h.transport!.emitNativeNotification('mode/changeRequested', params);
    const card = await waitFor(() => h.adapter.interaction(h.host, h.session));
    h.transport!.setModeChangeError(Object.assign(new Error('mode/change/respond failed after native resolution'), { rpcCode: -32600, rpcError: true }));
    const gate = h.deferEndpointRequest(h.transport!.remoteAddress, 'mode/change/respond');
    const response = { interactionId: card!.id, revision: card!.revision, requestId: 'web-race', action };
    const answering = h.adapter.respond(h.host, h.session, h.profile, response);
    await gate.entered;
    h.transport!.emitNativeNotification('mode/changeResolved', { ...params, decision });
    // ExitPlanMode can resolve and complete its turn before the RPC returns.
    h.transport!.finishTurn('turn-1', 'completed');
    gate.release();
    const result = await answering;
    expect(result.status).toBe(expected);
    expect(h.getReceipt('web-race')?.result).toEqual(result);
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    expect(h.session.mode).toBe(decision === 'approved' ? 'default' : 'plan');
    expect(await h.adapter.respond(h.host, h.session, h.profile, response)).toEqual(result);
    expect(h.transport!.requestParams.filter(entry => entry.method === 'mode/change/respond')).toHaveLength(1);
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('does not confirm a mode candidate from turn completion alone before the RPC succeeds', async () => {
    const h = traex();
    h.session.mode = 'plan';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('mode-turn-only', 'GPT-5.5', 'on-request', 'Plan it', 'plan');
    h.transport!.emitNativeNotification('mode/changeRequested', { threadId: 'native-thread', turnId: 'turn-1', requestId: 'turn-only', targetMode: 'default' });
    const card = await waitFor(() => h.adapter.interaction(h.host, h.session));
    const gate = h.deferEndpointRequest(h.transport!.remoteAddress, 'mode/change/respond');
    const answering = h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: card!.id, revision: card!.revision, requestId: 'web-turn-only', action: 'approve',
    });
    await gate.entered;
    h.transport!.finishTurn('turn-1', 'completed');
    expect(h.getReceipt('web-turn-only')?.result.status).toBe('uncertain');
    expect(h.session.mode).toBe('plan');
    gate.release();
    expect((await answering).status).toBe('uncertain');
    expect(h.getReceipt('web-turn-only')?.result.status).toBe('uncertain');
    await h.adapter.dispose(h.host, h.session.id);
  }, 10_000);

  it.each(['before candidate', 'before native application', 'after native application'])('orders approved mode resolution against settings %s by candidate baseline or actual readback', async timing => {
    const h = traex();
    h.session.mode = 'plan';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const settings = { threadId: 'native-thread', threadSettings: { model: 'new-native-model', collaborationMode: { mode: 'plan' } } };
    h.transport!.emitNativeNotification('thread/settings/updated', settings);
    const params = { threadId: 'native-thread', turnId: 'turn-1', requestId: 'ordered-mode', targetMode: 'default' };
    h.transport!.emitNativeNotification('mode/changeRequested', params);
    expect(h.session.mode).toBe('plan'); // Requested is not applied.
    const card = h.adapter.interaction(h.host, h.session)!;
    if (timing === 'before candidate') h.transport!.emitNativeNotification('thread/settings/updated', settings);
    const candidateGate = h.deferEndpointRequest(h.transport!.remoteAddress, 'mode/change/respond');
    const answering = h.adapter.respond(h.host, h.session, h.profile, { interactionId: card.id, revision: card.revision, requestId: 'web-ordered-mode', action: 'approve' });
    await candidateGate.entered;
    if (timing !== 'before candidate') h.transport!.emitNativeNotification('thread/settings/updated', settings);
    const expected = timing === 'after native application' ? 'plan' : 'default';
    h.transport!.setSettingsUpdateResponse({ model: 'new-native-model', collaborationMode: { mode: expected } });
    const readbackGate = timing === 'before native application' ? h.deferEndpointRequest(h.transport!.remoteAddress, 'thread/settings/update') : undefined;
    h.transport!.emitNativeNotification('mode/changeResolved', { ...params, decision: 'approved' });
    candidateGate.release();
    expect((await answering).status).toBe('completed');
    let nextTurn: Promise<void> | undefined;
    if (readbackGate) {
      await readbackGate.entered;
      nextTurn = h.send('mode-next-turn', 'new-native-model', 'on-request', 'Continue', h.session.mode);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(h.transport!.lastParams('turn/start')).toBeUndefined();
      readbackGate.release();
    }
    await waitFor(() => h.session.mode === expected ? true : undefined);
    expect(h.getReceipt('web-ordered-mode')?.result.status).toBe('completed');
    const readbacks = h.transport!.requestParams.filter(request => request.method === 'thread/settings/update');
    expect(readbacks).toEqual(timing === 'before candidate' ? [] : [{ method: 'thread/settings/update', params: { threadId: 'native-thread' } }]);
    await (nextTurn ?? h.send('mode-next-turn', 'new-native-model', 'on-request', 'Continue', h.session.mode));
    expect(h.transport!.lastParams('turn/start')?.collaborationMode).toMatchObject({ mode: expected, settings: { model: 'new-native-model' } });
    await h.adapter.close(h.host);
  });

  it('does not let an older mode resolution overwrite a newer identical native settings observation', async () => {
    const h = traex();
    h.session.mode = 'plan';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const settings = { threadId: 'native-thread', threadSettings: { collaborationMode: { mode: 'plan' } } };
    h.transport!.emitNativeNotification('thread/settings/updated', settings);
    const params = { threadId: 'native-thread', turnId: 'turn-1', requestId: 'stale-mode', targetMode: 'default' };
    h.transport!.emitNativeNotification('mode/changeRequested', params);
    h.transport!.emitNativeNotification('thread/settings/updated', settings);
    h.transport!.emitNativeNotification('mode/changeResolved', { ...params, decision: 'approved' });
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    expect(h.session.mode).toBe('plan');
    await h.adapter.dispose(h.host, h.session.id);
  });

  it.each([false, true])('adopts an observer resume top-level mode/model without overwriting a raced settings observation (%s)', async raced => {
    const h = traex();
    h.session.mode = 'default';
    h.session.nativeSessionId = 'native-thread';
    const endpoint = 'unix:///mode-observer-resume.sock';
    const owner = h.registerEndpoint(endpoint);
    owner.setLoadedThreads(['native-thread']);
    owner.setThreadSettings({ model: 'native-default-model', collaborationMode: { mode: 'plan' } });
    h.session.nativeRuntime = makeBinding(h, endpoint);
    await prime(h);
    const runtime = await (h.adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<CodexSessionRuntime> }).ensureRuntime(h.host, h.session, h.project, h.profile);
    const gate = h.deferEndpointRequest(endpoint, 'thread/resume');
    const attaching = runtime.attachLoadedOwner();
    await gate.entered;
    if (raced) h.transport!.emitNativeNotification('thread/settings/updated', { threadId: 'native-thread', threadSettings: { model: 'newer-native-model', collaborationMode: { mode: 'default' } } });
    gate.release();
    await attaching;
    expect(h.session.mode).toBe(raced ? 'default' : 'plan');
    const model = raced ? 'newer-native-model' : 'native-default-model';
    const configured = await h.adapter.configure(h.host, h.session, h.profile, { mode: 'plan' });
    expect(h.transport!.lastParams('thread/settings/update')).toMatchObject({ collaborationMode: { mode: 'plan', settings: { model } } });
    expect(h.transport!.lastParams('thread/settings/update')).not.toHaveProperty('model');
    expect(configured.mode).toBe('plan');
    await h.adapter.close(h.host);
  });

  it('returns newer mode observations from configure and preserves explicit selection through legacy empty replies', async () => {
    const h = traex();
    h.session.mode = 'plan';
    h.session.model = 'GPT-5.5';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const notification = { threadId: 'native-thread', threadSettings: { collaborationMode: { mode: 'plan' } } };
    h.transport!.emitNativeNotification('thread/settings/updated', notification);
    h.transport!.setSettingsUpdateResponse({ collaborationMode: { mode: 'default' } });
    const gate = h.deferEndpointRequest(h.transport!.remoteAddress, 'thread/settings/update');
    const configuring = h.adapter.configure(h.host, h.session, h.profile, { mode: 'default' });
    await gate.entered;
    h.transport!.emitNativeNotification('thread/settings/updated', notification);
    gate.release();
    const result = await configuring;
    expect(result.mode).toBe('plan');
    expect(h.session.mode).toBe('plan');
    // The service persists configure's return, so it too must retain the observed mode.
    h.host.bumpConfig(h.session.id, { mode: result.mode });
    await h.send('after-mode-race', 'GPT-5.5', 'on-request', 'Continue', h.session.mode);
    expect(h.transport!.lastParams('turn/start')?.collaborationMode).toMatchObject({ mode: 'plan' });
    // The published rolling-upgrade contract tolerates an empty settings reply. Without a
    // newer observation, the old remembered Plan mode must not overwrite this explicit choice.
    h.transport!.setSettingsUpdateResponse(null);
    const legacy = await h.adapter.configure(h.host, h.session, h.profile, { mode: 'default' });
    expect(h.transport!.lastParams('thread/settings/update')?.collaborationMode).toMatchObject({ mode: 'default' });
    expect(legacy.mode).toBe('default');
    h.host.bumpConfig(h.session.id, { mode: legacy.mode });
    expect(h.session.mode).toBe('default');
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('leaves unknown mode targets to the native terminal without sending a web decision or adopting an invalid mode', async () => {
    const h = traex();
    h.session.mode = 'plan';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const params = { threadId: 'native-thread', turnId: 'turn-1', requestId: 'unknown-mode', targetMode: 'future-mode' };
    h.transport!.emitNativeNotification('mode/changeRequested', params);
    const card = await waitFor(() => h.adapter.interaction(h.host, h.session));
    expect(card!.actions).toEqual([]);
    await expect(h.adapter.respond(h.host, h.session, h.profile, {
      interactionId: card!.id, revision: card!.revision, requestId: 'web-unknown-mode', action: 'approve',
    })).rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
    expect(h.getReceipt('web-unknown-mode')).toBeUndefined();
    expect(h.transport!.requestParams.filter(entry => entry.method === 'mode/change/respond')).toHaveLength(0);
    h.transport!.emitNativeNotification('mode/changeResolved', { ...params, decision: 'approved' });
    expect(h.adapter.interaction(h.host, h.session)).toBeUndefined();
    expect(h.session.mode).toBe('plan');
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('shows a provider queue position while the turn waits and clears it when the queue lets go', async () => {
    const h = traex();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    await h.send('cmd-queued', 'GPT-5.5');
    h.transport!.emitNativeNotification('queue/status', { threadId: 'native-thread', turnId: 'turn-1', state: 'queued', position: 335, message: null });
    expect(h.adapter.status(h.host, h.session).notice).toBe('Waiting in the TRAE CLI queue (position 335).');
    expect(h.adapter.status(h.host, h.session).noticeLevel).toBe('info');
    // An exhausted daily quota keeps the turn alive at lower priority; the notice must name that
    // reason instead of reporting ordinary queue contention.
    h.transport!.emitNativeNotification('queue/status', { threadId: 'native-thread', turnId: 'turn-1', state: 'queued', position: null, message: null, modelQuotaLowPriority: true });
    expect(h.adapter.status(h.host, h.session).notice).toBe('Daily quota is used up; this request is running at low priority.');
    expect(h.adapter.status(h.host, h.session).noticeLevel).toBe('info');
    h.transport!.emitNativeNotification('queue/status', { threadId: 'native-thread', turnId: 'turn-1', state: 'ready', position: null });
    expect(h.adapter.status(h.host, h.session).notice).toBeUndefined();
    expect(h.adapter.status(h.host, h.session).noticeLevel).toBeUndefined();
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('refuses an endpoint or API key, which this CLI has no use for', async () => {
    const h = traex();
    const profile = { ...h.profile, config: { ...h.profile.config, apiEndpoint: 'https://example.com' } };
    expect(await h.adapter.available(h.host, profile)).toMatchObject({ available: false, reason: expect.stringContaining('TRAE account') });
  });

});

describe('backend usage', () => {
  it('reads per-model load, the weekly quota and the daily quota TRAE CLI attaches to its catalog', async () => {
    // TRAE usage spawns its own read-only CLI, so the catalog is on every fresh endpoint.
    const h = makeHarness({ flavor: traexFlavor, models: [
      { id: 'openrouter-4o', model: 'Orange-O55', configName: 'openrouter-4o', displayName: 'Orange-O55', businessMetadata: {
        load: { load_percent: 246 }, is_internal_usage_limit: true,
        internal_usage: { usage_percent: 10, quota_remaining: 270, quota_limit: 300, is_depleted: false, reset_time: 1792339199 },
        internal_daily_quota_key: 'orange',
        internal_daily_usage: { quotaKey: 'orange', quotaLimit: '58', quotaUsed: '32.83379', quotaRemaining: '25.16621', usagePercent: 56.6, isDepleted: false, periodStart: '0', resetTime: '1792339199' },
      } },
      { id: 'Doubao-Seed-2.1-Turbo', model: 'Seed-2.1-Turbo', configName: 'Doubao-Seed-2.1-Turbo', businessMetadata: { load: { load_percent: 35 }, is_internal_usage_limit: false, internal_usage: null } },
      { id: 'gpt-5.2', model: 'GPT-5.2', businessMetadata: { load: null, internal_usage: null } },
    ] });
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const usage = await h.adapter.usage(h.host, h.project, h.profile, h.session);
    expect(usage.account).toBeUndefined();
    const orange = {
      loadPercent: 246,
      quota: { usedPercent: 10, windowMinutes: 10080, resetsAt: new Date(1792339199 * 1000).toISOString(), remaining: 270, limit: 300 },
      quotaLimited: true,
      dailyQuotaKey: 'orange',
      dailyQuota: { usedPercent: 57, windowMinutes: 1440, resetsAt: new Date(1792339199 * 1000).toISOString(), remaining: 25.16621, limit: 58 },
    };
    expect(usage.models).toEqual({
      'Orange-O55': orange,
      // Older cached catalogs and saved sessions still spell this model by its gateway id.
      'openrouter-4o': orange,
      'Seed-2.1-Turbo': { loadPercent: 35, quotaLimited: false },
      'Doubao-Seed-2.1-Turbo': { loadPercent: 35, quotaLimited: false },
    });
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('binds daily counters by key and keeps canonical TRAE selectors from being rewritten by aliases', async () => {
    const h = makeHarness({ flavor: traexFlavor, models: [
      // The metadata counter names a different binding, so only the keyed RPC read may fill it.
      { id: 'gpt-6.1-sol', model: 'GPT-6.1-Sol', businessMetadata: {
        is_internal_usage_limit: false, internal_daily_quota_key: 'gpt_6_1',
        // A global/stale weekly counter must not meter a model that explicitly opts out.
        internal_usage: { usage_percent: 100, quota_remaining: 0, quota_limit: 300, is_depleted: true },
        internal_daily_usage: { quotaKey: 'other', quotaLimit: '10', quotaRemaining: '4', usagePercent: 60 },
      } },
      // This entry's alias happens to equal another entry's current selector.
      { id: 'alias-owner', model: 'shared', configName: 'canonical-other', businessMetadata: { load: { load_percent: 10 } } },
      { id: 'canonical-other', model: 'canonical-other', businessMetadata: null },
      // Without a declared key, metadata must not bind a daily counter.
      { id: 'no-key', model: 'no-key', businessMetadata: { internal_daily_usage: { quotaKey: 'gpt_6_1', quotaLimit: '10', quotaRemaining: '4', usagePercent: 60 } } },
      { id: 'weekly', model: 'weekly', businessMetadata: { is_internal_usage_limit: true, internal_usage: {} } },
    ], internalUsage: {
      dailyUsage: [{ quotaKey: 'gpt_6_1', quotaLimit: '58', quotaRemaining: '25.16621', usagePercent: 56.6, isDepleted: false, periodStart: '0', resetTime: '1792339199' }],
      usage: { usage_percent: 56.6, quota_remaining: 25.16621, quota_limit: 58.8 },
    } });
    h.session.model = 'alias-owner[context=max,effort=high]';
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    expect(h.transport!.lastParams('thread/start')?.model).toBe('shared');
    expect(h.transport!.lastParams('thread/start')?.config).toMatchObject({ model_backend_variant: 'max', model_reasoning_effort: 'high' });
    const requested = { model: h.session.model, mode: 'code', approval: 'on-request' };
    let fence: NativeDispatchBinding | undefined;
    await h.adapter.send(h.host, {
      session: h.session, project: h.project, profile: h.profile,
      commandId: 'alias-turn', runId: 'run-alias-turn', config: requested,
      input: { text: 'Inspect this project', attachmentIds: [], context: [] },
      commitDispatchFence: binding => { fence = binding; return {} as Run; },
    });
    expect(h.transport!.lastParams('turn/start')?.model).toBe('shared');
    expect(h.transport!.lastParams('turn/start')?.modelBackendVariant).toBe('max');
    expect(fence?.resolvedConfig?.model).toBe('shared[context=max,effort=high]');
    expect(requested.model).toBe('alias-owner[context=max,effort=high]');
    // This fixture has no installed executable; version gating has its own protocol cases.
    const capabilities = await h.adapter.capabilities(h.host, h.profile);
    vi.spyOn(h.adapter, 'capabilities').mockResolvedValueOnce({ ...capabilities, supportsSteer: true });
    let steerFence: NativeDispatchBinding | undefined;
    await h.adapter.steer(h.host, {
      session: h.session, project: h.project, profile: h.profile,
      commandId: 'alias-steer', runId: 'run-alias-steer', config: requested,
      input: { text: 'Keep the same model', attachmentIds: [], context: [] },
      target: { nativeSessionId: 'native-thread', turnId: 'turn-1' },
      commitDispatchFence: binding => { steerFence = binding; return {} as Run; },
    });
    expect(steerFence?.resolvedConfig?.model).toBe('shared[context=max,effort=high]');
    h.transport!.finishTurn('turn-1', 'completed');
    await h.send('canonical-turn', 'canonical-other');
    expect(h.transport!.lastParams('turn/start')?.model).toBe('canonical-other');

    const usage = await h.adapter.usage(h.host, h.project, h.profile, h.session);
    expect(usage.models['GPT-6.1-Sol']).toEqual({
      quotaLimited: false, dailyQuotaKey: 'gpt_6_1',
      dailyQuota: { usedPercent: 57, windowMinutes: 1440, resetsAt: new Date(1792339199 * 1000).toISOString(), remaining: 25.16621, limit: 58 },
    });
    expect(usage.models).toEqual({
      'GPT-6.1-Sol': usage.models['GPT-6.1-Sol'],
      'gpt-6.1-sol': usage.models['GPT-6.1-Sol'],
      shared: { loadPercent: 10 },
      'alias-owner': { loadPercent: 10 },
      weekly: { quotaLimited: true, quota: { usedPercent: 57, windowMinutes: 10080, remaining: 25, limit: 58 } },
    });
    await h.adapter.dispose(h.host, h.session.id);
  });

  it('reads the Codex account plan, windows and credits', async () => {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    h.transport!.setRateLimits({ rateLimits: {
      planType: 'pro', primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1792297071 }, secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: '62497.7488560000' }, rateLimitReachedType: null, spendControlReached: false,
    } });
    const usage = await h.adapter.usage(h.host, h.project, h.profile, h.session);
    expect(usage.account).toEqual({ plan: 'pro', windows: [{ usedPercent: 2, windowMinutes: 10080, resetsAt: new Date(1792297071 * 1000).toISOString() }], credits: { balance: 62497.748856 } });
    expect(usage.models).toEqual({});
    await h.adapter.dispose(h.host, h.session.id);
  });
});


describe('explicit in-flight steering', () => {
  async function start() {
    const h = makeHarness();
    await h.adapter.openOrResume(h.host, h.session, h.project, h.profile);
    const messages: NativeControlMessage[] = [];
    const unsubscribe = h.adapter.subscribe(h.host, h.session, h.profile, message => messages.push(message));
    await waitFor(() => messages.some(message => message.type === 'status') ? true : undefined);
    await h.send('owner', 'original-model', 'read-only');
    const fences: NativeDispatchBinding[] = [];
    const steer = async (commandId: string, target = { nativeSessionId: 'native-thread', turnId: 'turn-1' }, text = 'Use the same words') => {
      await h.adapter.steer(h.host, {
        session: h.session, project: h.project, profile: h.profile,
        commandId, runId: `run-${commandId}`, config: { model: 'next-model', mode: 'plan', approval: 'danger-full-access' },
        input: { text, attachmentIds: [], context: [] }, target,
        commitDispatchFence: binding => { fences.push(binding!); return {} as Run; },
      });
    };
    const echo = (commandId: string) => h.transport!.emitNativeNotification('item/completed', {
      threadId: 'native-thread', turnId: 'turn-1',
      item: { id: `item-${commandId}`, type: 'userMessage', clientId: commandId, content: [{ type: 'text', text: 'Use the same words' }] },
    });
    const cleanup = async () => { unsubscribe(); await h.adapter.close(h.host); };
    return { ...h, latestTransport: () => h.transport!, messages, fences, steer, echo, cleanup };
  }

  it('rechecks the target after attachments finish loading', async () => {
    const h = await start();
    try {
      h.host.readAttachment = async () => {
        h.transport!.finishTurn('turn-1', 'completed');
        return { attachment: { mimeType: 'image/png', path: '/tmp/image.png' }, data: Buffer.alloc(0) } as Awaited<ReturnType<NativeBackendHost['readAttachment']>>;
      };
      await expect(h.adapter.steer(h.host, {
        session: h.session, project: h.project, profile: h.profile, runId: 'run-late', commandId: 'late',
        config: { mode: 'code' }, input: { text: 'image', attachmentIds: ['image'], context: [] },
        target: { nativeSessionId: 'native-thread', turnId: 'turn-1' },
        commitDispatchFence: binding => { h.fences.push(binding!); return {} as Run; },
      })).rejects.toMatchObject({ code: 'STEER_TARGET_CHANGED' });
      expect(h.fences).toHaveLength(0);
    } finally { await h.cleanup(); }
  });

  it('distinguishes explicit provider rejection from a transport failure', async () => {
    const h = await start();
    try {
      h.transport!.setSteerError('expected turn does not match active turn');
      await expect(h.steer('rejected')).rejects.toMatchObject({ code: 'STEER_TARGET_CHANGED' });
      h.transport!.setSteerError(undefined);
      const request = h.transport!.request.bind(h.transport!);
      h.transport!.request = async (method, params) => {
        if (method === 'turn/steer') throw new Error('socket closed after write');
        return await request(method, params);
      };
      await expect(h.steer('unknown')).rejects.toThrow('socket closed after write');
    } finally { await h.cleanup(); }
  });

  it('does not spawn a provider when a cold steering request has no existing endpoint', async () => {
    const h = makeHarness();
    h.session.nativeSessionId = 'native-thread';
    await expect(h.adapter.steer(h.host, {
      session: h.session, project: h.project, profile: h.profile, commandId: 'cold', runId: 'run-cold',
      config: { mode: 'code' }, input: { text: 'hello', attachmentIds: [], context: [] },
      target: { nativeSessionId: 'native-thread', turnId: 'turn-1' }, commitDispatchFence: () => ({} as Run),
    })).rejects.toMatchObject({ code: 'STEER_TARGET_CHANGED' });
    expect(h.factoryCalls).toHaveLength(0);
    await h.adapter.close(h.host);
  });

  it.each([
    ['codex-cli 0.159.9', false], [undefined, false],
  ])('gates the capability and actual steer before writing for CLI version %s', async (version, supported) => {
    const h = await start();
    try {
      vi.mocked(codexConfig.probeAppServer).mockResolvedValue({ ...fakeProbe, version });
      expect((await h.adapter.capabilities(h.host, h.profile)).supportsSteer).toBe(supported);
      if (supported) {
        await h.steer('version-check');
        expect(h.fences).toHaveLength(1);
      } else {
        await expect(h.steer('version-check')).rejects.toMatchObject({ code: 'STEER_UNSUPPORTED' });
        expect(h.fences).toHaveLength(0);
        expect(h.transport!.requestParams.some(entry => entry.method === 'turn/steer')).toBe(false);
      }
    } finally { await h.cleanup(); }
  });

  it.each(['riffet/0.159.9 (old process)', undefined])('refuses steering to an old or unidentified Codex process despite a new installed CLI (%s)', async serverUserAgent => {
    const h = await start();
    try {
      vi.mocked(codexConfig.probeAppServer).mockResolvedValue({ ...fakeProbe, version: 'codex-cli 0.167.2' });
      h.transport!.serverUserAgent = serverUserAgent;
      h.transport!.emitNativeNotification('thread/status/changed', { threadId: 'native-thread', status: { type: 'active' } });
      expect(h.adapter.status(h.host, h.session).activeTurn).toBeUndefined();
      await expect(h.steer('old-process')).rejects.toMatchObject({ code: 'STEER_UNSUPPORTED' });
      expect(h.fences).toHaveLength(0);
      expect(h.transport!.requestParams.some(entry => entry.method === 'turn/steer')).toBe(false);
      expect(h.transport!.disposed).toBe(false);
    } finally { await h.cleanup(); }
  });

  it('rejects a CLI control command before writing', async () => {
    const text = '/clear';
    const h = await start();
    try {
      await expect(h.steer('command', undefined, text)).rejects.toMatchObject({ code: 'STEER_REJECTED' });
      expect(h.fences).toHaveLength(0);
      expect(h.transport!.requestParams.some(entry => entry.method === 'turn/steer')).toBe(false);
    } finally { await h.cleanup(); }
  });

  it('uses the native enabled-skills directory while preserving prose and file paths', async () => {
    const h = await start();
    try {
      h.transport!.setSkills([{ name: 'inspect', path: '/skills/inspect/SKILL.md', enabled: true }]);
      await h.steer('skill', undefined, '/inspect check this carefully');
      expect(h.transport!.lastParams('turn/steer')!.input).toContainEqual({ type: 'skill', name: 'inspect', path: '/skills/inspect/SKILL.md' });
      h.transport!.setSkills(undefined);
      await h.steer('path', undefined, '/usr/bin/env is the executable to inspect');
      await h.steer('prose', undefined, 'Explain what /model changes');
      await expect(h.steer('known-inline', undefined, 'Use /inspect here')).rejects.toMatchObject({ code: 'STEER_REJECTED' });
      expect(h.fences).toHaveLength(3);
    } finally { await h.cleanup(); }
  });

});

describe('Codex subagent control state', () => {
  const childTurn = (id: string, status = 'completed'): RpcTurn => ({ id, status, items: [{ type: 'agentMessage', id: `${id}-answer`, text: 'done' }] });
  const spawnTurn = (id: string, child: string): RpcTurn => ({
    id: 'parent-1', status: 'completed',
    items: [{
      type: 'collabAgentToolCall', id, tool: 'spawnAgent', receiverThreadIds: [child], prompt: 'Review the runtime',
      status: 'completed', agentsStates: { [child]: { status: 'completed' } },
    }],
  });
  const followUpTurn = (id: string, child: string): RpcTurn => ({
    id: 'parent-2', status: 'completed',
    items: [{
      type: 'collabAgentToolCall', id, tool: 'sendInput', receiverThreadIds: [child], prompt: 'Continue the review',
      status: 'completed', agentsStates: { [child]: { status: 'running' } },
    }],
  });

  function tracker(childTurns: RpcTurn[], threadStatus?: 'idle' | 'active') {
    const frames: Array<{ running?: boolean }> = [];
    const subagents = new CodexSubagents({
      readTurns: async () => childTurns,
      readThread: async () => ({ id: 'child-thread', status: { type: threadStatus } }),
      projectChildItem: () => [],
      emit: frame => frames.push(frame),
    });
    return { subagents, frames };
  }

  it('keeps a live follow-up running over a history read that still stops at the previous turn', async () => {
    const childTurns = [childTurn('child-1')];
    const { subagents, frames } = tracker(childTurns);
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    await subagents.refresh();
    const watch = subagents.get('spawn-1')!;
    expect(watch.running).toBe(false);

    subagents.note([followUpTurn('follow-1', 'child-thread')], true);
    expect(watch.running).toBe(true);
    // The old spawn's history copy must not settle the claim the live follow-up just made.
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    await subagents.refresh();
    expect(watch.running).toBe(true);

    childTurns.push(childTurn('child-2', 'inProgress'));
    await subagents.refresh();
    expect(watch.running).toBe(true);

    childTurns[1] = childTurn('child-2');
    await subagents.refresh();
    expect(watch.running).toBe(false);
    expect(frames.some(frame => frame.running === true)).toBe(true);
    expect(frames.at(-1)?.running).toBe(false);
  });

  it('does not settle a follow-up when the boundary turn it named finishes', async () => {
    const childTurns = [childTurn('child-1', 'inProgress')];
    let threadStatus: 'idle' | 'active' | undefined = 'active';
    const subagents = new CodexSubagents({
      readTurns: async () => childTurns,
      readThread: async () => ({ id: 'child-thread', status: { type: threadStatus } }),
      projectChildItem: () => [],
      emit: () => {},
    });
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    await subagents.refresh();
    const watch = subagents.get('spawn-1')!;
    expect(watch.running).toBe(true);

    // The follow-up names the in-progress turn as its boundary; that turn is not the new work.
    subagents.note([followUpTurn('follow-1', 'child-thread')], true);
    await subagents.refresh();
    expect(watch.running).toBe(true);

    // The boundary turn finishes before the follow-up's own turn is written. Its completion must
    // not settle the claim: only a turn newer than the boundary proves the follow-up started.
    childTurns[0] = childTurn('child-1');
    await subagents.refresh();
    expect(watch.running).toBe(true);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    threadStatus = 'idle';
    await subagents.refresh();
    expect(watch.running).toBe(false);
  });

  it('recovers an unreadable child from ordered parent shutdown history without settling a newer claim', async () => {
    let childTurns: RpcTurn[] | undefined = [childTurn('child-1', 'inProgress')];
    const { subagents, frames } = (() => {
      const frames: Array<{ running?: boolean }> = [];
      const subagents = new CodexSubagents({ readTurns: async () => childTurns, readThread: async () => undefined, projectChildItem: () => [], emit: frame => frames.push(frame) });
      return { subagents, frames };
    })();
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    await subagents.refresh();
    const watch = subagents.get('spawn-1')!;
    expect(watch.running).toBe(true);
    childTurns = undefined;
    const shutdown: RpcTurn = { id: 'parent-stop', items: [{ type: 'collabAgentToolCall', id: 'shutdown-1', tool: 'closeAgent', receiverThreadIds: ['child-thread'], agentsStates: { 'child-thread': { status: 'shutdown' } } }] };
    subagents.note([shutdown]);
    childTurns = [childTurn('child-1', 'inProgress')];
    await subagents.refresh(); // Same execution becoming readable must retain shutdown evidence.
    expect(watch.running).toBe(true);
    childTurns = undefined;
    await subagents.refresh();
    expect(watch.running).toBe(false);
    expect(frames.at(-1)?.running).toBe(false);
    expect(watch.settledTurn?.id).toBe('child-1');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    childTurns = [childTurn('child-1'), childTurn('child-native-new', 'inProgress')];
    await subagents.refresh();
    expect(watch.running).toBe(true);
    childTurns = undefined;
    subagents.note([shutdown]);
    await subagents.refresh();
    expect(watch.running).toBe(true); // The retained end fence protects newer native child work.
    subagents.note([followUpTurn('follow-new', 'child-thread')], true);
    subagents.note([shutdown]); // Older parent read lacks the new follow-up's ordered claim.
    await subagents.refresh();
    expect(watch.running).toBe(true);
    subagents.note([followUpTurn('follow-new', 'child-thread'), shutdown]);
    await subagents.refresh();
    expect(watch.running).toBe(false);
    childTurns = [childTurn('child-1', 'inProgress')];
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    await subagents.refresh();
    expect(watch.running).toBe(false); // The late old child turn cannot reopen its settled claim.

    // A terminal can also become obsolete before it ever settles. Bind its C1 boundary so a
    // successful read of C2 invalidates it; repeated parent snapshots cannot rebind it to C2.
    childTurns = [childTurn('old-1', 'inProgress')];
    const recovering = new CodexSubagents({ readTurns: async () => childTurns, readThread: async () => undefined, projectChildItem: () => [], emit: () => {} });
    recovering.note([spawnTurn('spawn-2', 'child-thread')]);
    await recovering.refresh();
    recovering.note([shutdown]);
    childTurns = [childTurn('old-1'), childTurn('new-2', 'inProgress')];
    await recovering.refresh();
    expect(recovering.get('spawn-2')!.running).toBe(true);
    childTurns = undefined;
    recovering.note([shutdown]);
    await recovering.refresh();
    expect(recovering.get('spawn-2')!.running).toBe(true);
    expect(recovering.get('spawn-2')!.settledTurn).toBeUndefined();
  });

  it('restarts the wait for a different follow-up claim', async () => {
    const childTurns = [childTurn('child-1')];
    const subagents = new CodexSubagents({
      readTurns: async () => childTurns,
      readThread: async () => ({ id: 'child-thread', status: { type: 'idle' } }),
      projectChildItem: () => [],
      emit: () => {},
    });
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    await subagents.refresh();
    const watch = subagents.get('spawn-1')!;
    const base = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(base);
    subagents.note([followUpTurn('follow-1', 'child-thread')], true);
    // The second follow-up is new work: it names its own boundary and starts its own wait.
    now.mockReturnValue(base + 31_000);
    subagents.note([followUpTurn('follow-2', 'child-thread')], true);
    await subagents.refresh();
    expect(watch.running).toBe(true);

    now.mockReturnValue(base + 62_000);
    await subagents.refresh();
    expect(watch.running).toBe(false);
  });

  it.each<[string, () => RpcTurn]>([
    ['spawn', () => ({
      id: 'parent-5', status: 'completed',
      items: [{
        type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', receiverThreadIds: ['child-thread'],
        prompt: 'Review the runtime', status: 'completed', agentsStates: { 'child-thread': { status: 'running' } },
      }],
    })],
    ['activity start', () => ({
      id: 'parent-4', status: 'completed',
      items: [{ type: 'subAgentActivity', id: 'subagent-activity:spawn-1', kind: 'started', agentThreadId: 'child-thread' }],
    })],
    ['follow-up', () => followUpTurn('follow-1', 'child-thread')],
  ])('does not reopen a settled child from a late %s copy', async (_kind, copy) => {
    const subagents = new CodexSubagents({
      readTurns: async () => [],
      readThread: async () => ({ id: 'child-thread', status: { type: 'idle' } }),
      projectChildItem: () => [],
      emit: () => {},
    });
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    await subagents.refresh();
    const watch = subagents.get('spawn-1')!;
    subagents.note([followUpTurn('follow-1', 'child-thread')], true);
    expect(watch.running).toBe(true);
    subagents.note([{
      id: 'parent-3', status: 'completed',
      items: [{ type: 'subAgentActivity', id: 'activity-1', kind: 'interrupted', agentThreadId: 'child-thread' }],
    }], true);
    expect(watch.running).toBe(false);

    // The settled claim's own late `running` copy is history; it must not restart the child, and
    // it must not leave a status that an empty history read revives.
    subagents.note([copy()], true);
    expect(watch.running).toBe(false);
    await subagents.refresh();
    expect(watch.running).toBe(false);
  });

  it('settles a passed follow-up when its call reports a terminal state', async () => {
    const childTurns = [childTurn('child-1')];
    const subagents = new CodexSubagents({
      readTurns: async () => childTurns,
      readThread: async () => ({ id: 'child-thread', status: { type: 'active' } }),
      projectChildItem: () => [],
      emit: () => {},
    });
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    await subagents.refresh();
    const watch = subagents.get('spawn-1')!;
    subagents.note([followUpTurn('follow-1', 'child-thread')], true);
    childTurns.push(childTurn('child-2', 'inProgress'));
    await subagents.refresh();
    expect(watch.running).toBe(true);
    expect(watch.awaiting).toBeUndefined();

    // The same call's terminal copy is real news; a settled claim must still end the child.
    subagents.note([{
      id: 'parent-2', status: 'completed',
      items: [{
        type: 'collabAgentToolCall', id: 'follow-1', tool: 'sendInput', receiverThreadIds: ['child-thread'],
        status: 'completed', agentsStates: { 'child-thread': { status: 'interrupted' } },
      }],
    }], true);
    expect(watch.running).toBe(false);
    await subagents.refresh();
    expect(watch.running).toBe(false); // Same child-2 inProgress history cannot undo the terminal.

    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    childTurns.push(childTurn('child-3', 'inProgress'));
    await subagents.refresh();
    expect(watch.running).toBe(true); // Ordered new native work remains allowed.
    childTurns[2] = childTurn('child-3');
    await subagents.refresh();
    expect(watch.running).toBe(false); // The older child-2 inProgress cannot revive the newest end.
    now.mockReturnValue(Date.now() + 31_000);
    subagents.note([followUpTurn('follow-2', 'child-thread')], true);
    await subagents.refresh();
    expect(watch.running).toBe(true); // A different live claim also opens new work.
  });

  it('keeps a live signal that arrives while the child history is being read', async () => {
    const childTurns = [childTurn('child-1')];
    let release: (() => void) | undefined;
    let reads = 0;
    const subagents = new CodexSubagents({
      readTurns: async () => {
        reads += 1;
        if (reads === 1) await new Promise<void>(resolve => { release = resolve; });
        return childTurns;
      },
      readThread: async () => undefined,
      projectChildItem: () => [],
      emit: () => {},
    });
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    const refresh = subagents.refresh();
    subagents.note([followUpTurn('follow-1', 'child-thread')], true);
    release!();
    await refresh;
    expect(reads).toBe(2);
    expect(subagents.get('spawn-1')!.running).toBe(true);

    let nativeReads = 0;
    let releaseNative!: () => void;
    const nativeFrames: Array<{ reset: boolean; events: unknown[] }> = [];
    const nativeTracker = new CodexSubagents({
      readTurns: async () => {
        nativeReads += 1;
        if (nativeReads === 2) {
          await new Promise<void>(resolve => { releaseNative = resolve; });
          return [childTurn('native-c1')]; // Frozen old terminal read raced by C2 start.
        }
        if (nativeReads === 1) return [childTurn('native-c1', 'inProgress')];
        if (nativeReads === 3) return [childTurn('native-c1')]; // Retry still lags the live C2.
        if (nativeReads === 4 || nativeReads === 7) return [];
        if (nativeReads === 6) return [childTurn('native-c1')];
        return [childTurn('native-c1'), childTurn('native-c2', nativeReads === 5 ? 'inProgress' : 'completed')];
      },
      readThread: async () => undefined,
      projectChildItem: (item, turn, threadId) => [{ sequence: 0, sessionId: 'child-fence-session', type: 'agent_message_chunk',
        nativeId: `${threadId}:${turn.id}:${item.id}`, nativeTurnId: turn.id, data: { content: { type: 'text', text: item.text } }, createdAt: '2026-10-31T00:00:00.000Z' }],
      emit: frame => nativeFrames.push(frame),
    });
    nativeTracker.note([spawnTurn('native-spawn', 'native-child')]);
    await nativeTracker.refresh();
    expect(nativeTracker.get('native-spawn')!.running).toBe(true);
    const pendingRead = nativeTracker.refresh();
    nativeTracker.noteTurn('native-child', 'native-c2', false);
    releaseNative();
    await pendingRead;
    expect(nativeReads).toBe(3);
    expect(nativeTracker.get('native-spawn')!.running).toBe(true);
    expect(nativeTracker.get('native-spawn')!.lastTurnId).toBe('native-c2');
    await nativeTracker.refresh(); // Empty retry window also cannot settle the missing C2 target.
    expect(nativeTracker.get('native-spawn')!.running).toBe(true);
    await nativeTracker.refresh();
    expect(nativeTracker.get('native-spawn')!.running).toBe(true);
    const nativeWatch = nativeTracker.get('native-spawn')!;
    const body = nativeWatch.events;
    const sentTail = nativeWatch.sentTailId;
    const published = nativeFrames.length;
    expect(body.some(event => event.nativeTurnId === 'native-c2')).toBe(true);
    await nativeTracker.refresh(); // Old C1 window after C2 body was read must not roll it back.
    await nativeTracker.refresh(); // Nor may an empty window erase it with a reset snapshot.
    expect(nativeWatch.events).toBe(body);
    expect(nativeWatch.sentTailId).toBe(sentTail);
    expect(nativeFrames).toHaveLength(published);
    const revision = nativeWatch.signalRevision;
    nativeTracker.noteTurn('native-child', 'native-c2', false);
    expect(nativeWatch.signalRevision).toBe(revision);
    await nativeTracker.refresh(); // C2's actual history terminal now proves its end.
    expect(nativeTracker.get('native-spawn')!.running).toBe(false);
    nativeTracker.noteTurn('native-child', 'native-c2', true);
    nativeTracker.noteTurn('native-child', 'native-c2', false);
    expect(nativeTracker.get('native-spawn')!.running).toBe(false);
  });

  it('keeps a live terminal that arrives while the child\'s own descendants are being read', async () => {
    const nested = (id: string, child: string): RpcTurn => ({
      id: 'child-1', status: 'inProgress',
      items: [
        { type: 'agentMessage', id: 'child-1-answer', text: 'working' },
        { type: 'collabAgentToolCall', id, tool: 'spawnAgent', receiverThreadIds: [child], prompt: 'Nested', status: 'completed' },
      ],
    });
    let reads = 0;
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const descendantReading = new Promise<void>(resolve => { started = resolve; });
    const subagents = new CodexSubagents({
      readTurns: async threadId => {
        if (threadId === 'child-b') {
          started!();
          await new Promise<void>(resolve => { release = resolve; });
          return [childTurn('b-1')];
        }
        reads += 1;
        // The copy this sync started from still calls the child's turn running; the live terminal
        // that lands during the descendant read outranks it, and the re-read shows it finished.
        return reads === 1 ? [nested('nested-1', 'child-b')] : [childTurn('child-1')];
      },
      readThread: async () => undefined,
      projectChildItem: () => [],
      emit: () => {},
    });
    subagents.note([{
      id: 'parent-1', status: 'completed',
      items: [{
        type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', receiverThreadIds: ['child-a'], prompt: 'Review',
        status: 'completed', agentsStates: { 'child-a': { status: 'running' } },
      }],
    }], true);
    expect(subagents.get('spawn-1')!.running).toBe(true);
    const refresh = subagents.refresh();
    await descendantReading;
    subagents.note([{
      id: 'parent-3', status: 'completed',
      items: [{ type: 'subAgentActivity', id: 'activity-1', kind: 'completed', agentThreadId: 'child-a' }],
    }], true);
    release!();
    await refresh;
    expect(reads).toBe(2);
    expect(subagents.get('spawn-1')!.running).toBe(false);
  });

  it('does not trust a stale follow-up claim past its grace once the thread is idle', async () => {
    const childTurns = [childTurn('child-1')];
    let threadStatus: 'idle' | 'active' | undefined;
    const subagents = new CodexSubagents({
      readTurns: async () => childTurns,
      readThread: async () => ({ id: 'child-thread', status: { type: threadStatus } }),
      projectChildItem: () => [],
      emit: () => {},
    });
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    await subagents.refresh();
    const watch = subagents.get('spawn-1')!;
    subagents.note([followUpTurn('follow-1', 'child-thread')], true);
    // The item's started and completed copies are one claim and must not extend the wait.
    subagents.note([followUpTurn('follow-1', 'child-thread')], true);
    await subagents.refresh();
    expect(watch.running).toBe(true);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    // A thread read that fails or cannot name a state is not evidence that the work ended.
    await subagents.refresh();
    expect(watch.running).toBe(true);

    threadStatus = 'idle';
    await subagents.refresh();
    expect(watch.running).toBe(false);
  });

  it('keeps a newest interrupted turn running while the thread itself is active', async () => {
    const childTurns = [childTurn('child-1', 'interrupted')];
    const { subagents } = tracker(childTurns, 'active');
    subagents.note([spawnTurn('spawn-1', 'child-thread')]);
    await subagents.refresh();
    expect(subagents.get('spawn-1')!.running).toBe(true);

    // An interrupted turn older than the newest one never reopens the child.
    childTurns.push(childTurn('child-2'));
    await subagents.refresh();
    expect(subagents.get('spawn-1')!.running).toBe(false);
  });
});
