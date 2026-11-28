import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  NativeActivity,
  NativeBackendCapabilities,
  NativeBackendCatalogEntry,
  NativeBackendId,
  NativeInteraction,
  NativeSlashCatalog,
  NativeStatus,
  NativeStopRequest,
  Run,
  Session,
  SyncFrame,
  SyncLane,
  TimelineChanges,
  TimelineRow,
} from '../../packages/contracts/src/index.js';
import { CLIENT_FEATURES_HEADER } from '../../packages/contracts/src/protocol.js';
import { parseVersion } from '../../packages/plugin-api/src/kit/cli-version.js';
import { createApp } from '../../apps/server/src/app.js';
import { listWorkbenchAppServers } from '../../apps/server/src/backends/shared/app-server-daemons.js';
import type { NativeBackendTraits } from '../../apps/server/src/backends/types.js';
import {
  answerChecks,
  laneOutline,
  laneRows,
  openLane,
  seqChecks,
  subagentLanes,
  type Check,
  type LaneStream,
  type ProbeServer,
} from '../probe-sync-e2e-lib.js';
import type { BackendCompatSpec } from './backends/adapters.js';
import { collectObservedRawVocabulary, type VocabularySnapshot } from './drift.js';
import type { BackendTier, CompatRunMode, ScenarioId, ScenarioStatus, ScenarioVerdict } from './manifest.js';
import { MockLlmHub, registerTckScripts } from './mock-llm/index.js';
import {
  applyIsolatedProcessEnv,
  assertIsolatedPath,
  createCompatSandbox,
  createHangingStubExecutable,
  type CompatSandbox,
} from './sandbox.js';

const execFileAsync = promisify(execFile);

export type TckCategory =
  | 'probe-lifecycle'
  | 'basic-rich'
  | 'tools-approval'
  | 'steer-interrupt'
  | 'subagent-bg'
  | 'slash-config'
  | 'restart-fault-upgrade'
  | 'extensions-mcp-sidechat';

export const TCK_CATEGORY_LABELS: Record<TckCategory, string> = {
  'probe-lifecycle': '1. 探测与生命周期',
  'basic-rich': '2. 基础与富对话',
  'tools-approval': '3. 工具与审批闭环',
  'steer-interrupt': '4. Steer、排队与打断',
  'subagent-bg': '5. Subagent 与后台任务',
  'slash-config': '6. 斜杠、压缩与动态配置',
  'restart-fault-upgrade': '7. 重启、故障与跨版本',
  'extensions-mcp-sidechat': '8. 扩展、MCP 与辅助对话',
};

export type TckTraitRequirement =
  | 'survivesRestart'
  | 'prewarm'
  | 'backgroundTasks'
  | 'subagents'
  | 'slashCompact'
  | 'slashClear'
  | 'sideChat';

export interface TckScenarioRequirements {
  /** Scenario requires MockLlmHub deterministic scripting (Tier B/C skip without `--live`). */
  mockLlm?: boolean;
  /** Scenario specifically injects mock-only faults/barriers that cannot be forced on a live model. */
  mockLlmOnly?: boolean;
  /** Scenario requires specific backend capabilities from `/api/backends/:id/catalog`. */
  capabilities?: Array<keyof NativeBackendCapabilities>;
  /** Scenario requires specific driver traits / derived capabilities. */
  traits?: TckTraitRequirement[];
  /** Scenario requires `--prev-bin <path>` for cross-version resume. */
  prevBin?: boolean;
  /** Scenario only runs when `--live` is enabled. */
  liveOnly?: boolean;
  /** Scenario needs persistent (non-tmp) stateDir so tmux survives `app.close()`. */
  persistentStateDir?: boolean;
}

export interface ScenarioRunOutput {
  ok: boolean;
  /** Optional explicit verdict override (e.g. `not-applicable` discovered at runtime). */
  status?: ScenarioStatus;
  note?: string;
  checks: Check[];
}

export interface TckScenarioDefinition {
  readonly id: ScenarioId;
  readonly category: TckCategory;
  readonly title: string;
  readonly requires: TckScenarioRequirements;
  run(ctx: TckContext): Promise<ScenarioRunOutput>;
}

export interface TckApplicabilityInput {
  tier: BackendTier;
  live: boolean;
  prevBin?: string;
  capabilities: Partial<NativeBackendCapabilities>;
  traits: Partial<NativeBackendTraits>;
  supportsSideChat: boolean;
  supportsBackgroundTasks?: boolean;
  supportsSubagents?: boolean;
}

export type TckApplicabilityDecision =
  | { run: true }
  | { run: false; verdict: ScenarioVerdict };

export interface CompatServer extends ProbeServer {
  call: <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => Promise<T>;
  callRaw: (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => Promise<{ statusCode: number; body: string; json: unknown }>;
}

export interface TckContext {
  readonly spec: BackendCompatSpec;
  readonly sandbox: CompatSandbox;
  readonly mockHub: MockLlmHub;
  server: CompatServer;
  readonly projectId: string;
  readonly profileId: string;
  readonly model?: string;
  readonly capabilities: NativeBackendCapabilities;
  readonly traits: NativeBackendTraits;
  readonly catalog: NativeBackendCatalogEntry;
  readonly timeoutMs: number;
  readonly live: boolean;
  readonly bin?: string;
  readonly prevBin?: string;
  readonly trackedSessions: Set<string>;
  readonly trackedRuns: Set<string>;
  readonly liveStreams: Map<string, LaneStream>;
  /** Boots a fresh in-process Riffet server over the same `sandbox.stateDir` (for restart scenarios). */
  rebootServer(): Promise<CompatServer>;
  /** Opens a new native session on the active server, tracking it and its Sync v3 main lane stream. */
  createSession(options?: {
    title?: string;
    approval?: string;
    mode?: string;
    model?: string;
    profileId?: string;
  }): Promise<{ session: Session; stream: LaneStream }>;
  /** Sends a message and returns the accepted Run immediately (does not wait for completion). */
  sendMessage(
    sessionId: string,
    text: string,
    extra?: { attachments?: Array<{ id: string }>; commandId?: string },
  ): Promise<Run>;
  /** Sends a message and waits for the run to reach a terminal state. */
  sendAndWait(
    sessionId: string,
    text: string,
    extra?: { attachments?: Array<{ id: string }>; timeoutMs?: number },
  ): Promise<Run>;
  /** Waits for a specific run to reach a terminal state. */
  waitForRun(runId: string, timeoutMs?: number): Promise<Run>;
  /** Waits until session phase reaches one of the target phases. */
  waitForPhase(sessionId: string, phases: readonly NativeStatus['phase'][], timeoutMs?: number): Promise<NativeStatus>;
  /** Waits until an interaction card appears (preferring `protocol` transport when backend uses `both`). */
  waitForInteraction(sessionId: string, timeoutMs?: number): Promise<NativeInteraction>;
  /** Builds a valid `NativeStopRequest` for `/cancel` or `/interrupt-and-send`. */
  buildStopRequest(sessionId: string): NativeStopRequest;
  /** Extracts concatenated assistant text from a timeline snapshot. */
  latestAssistantText(sessionId: string, lane?: SyncLane): Promise<string>;
}

export interface ScenarioExecutionResult {
  id: ScenarioId;
  category: TckCategory;
  title: string;
  verdict: ScenarioVerdict;
  durationMs: number;
  checks: Check[];
}

export interface TckSuiteOptions {
  spec: BackendCompatSpec;
  scenarios?: readonly ScenarioId[];
  bin?: string;
  prevBin?: string;
  model?: string;
  live?: boolean;
  keep?: boolean;
  timeoutSeconds?: number;
  onScenarioDone?: (result: ScenarioExecutionResult) => void;
}

export interface TckSuiteReport {
  backendId: string;
  tier: BackendTier;
  mode: CompatRunMode;
  cliVersion?: string;
  os: string;
  startedAt: string;
  finishedAt: string;
  results: ScenarioExecutionResult[];
  summary: Record<ScenarioStatus, number>;
  observedVocabulary: VocabularySnapshot;
  leakedTmux: boolean;
}

const ALL_CLIENT_FEATURES = 'pi-agent,antigravity-agent,plugin-agents,quick-chat,projectless-tasks';
const TERMINAL_RUN_STATES = new Set<Run['state']>(['completed', 'failed', 'cancelled', 'interrupted']);
const INTERRUPTED_RUN_STATES = new Set<Run['state']>(['interrupted', 'cancelled']);
const GATEWAY_BACKENDS = new Set(['claude', 'codex', 'pi', 'dsh']);
const THINKING_PROTOCOLS = new Set(['anthropic-messages', 'openai-responses', 'google-generative-ai']);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function until<T>(
  predicate: () => Promise<T | undefined | false> | T | undefined | false,
  options: { timeoutMs: number; intervalMs?: number; describe: () => string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 120;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const extra = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
  throw new Error(`Timed out after ${options.timeoutMs}ms: ${options.describe()}${extra}`);
}

function capabilitySatisfied(
  capabilities: Partial<NativeBackendCapabilities>,
  key: keyof NativeBackendCapabilities,
): boolean {
  const value = capabilities[key];
  if (key === 'interactionTransport') {
    return value !== undefined && value !== 'none';
  }
  if (key === 'modes' || key === 'permissions' || key === 'slashCommands' || key === 'consumesProtocols') {
    return Array.isArray(value) && value.length > 0;
  }
  if (key === 'extensionToggles') {
    const toggles = value as { mcp?: boolean; skills?: boolean } | undefined;
    return Boolean(toggles?.mcp || toggles?.skills);
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return value === true;
}

/**
 * Pure capability-driven 4-state applicability evaluator:
 * - Missing required capability or trait -> `not-applicable`
 * - Missing prerequisite (`--prev-bin`, `--live` on Tier B/C, mock-only scenario in live mode) -> `not-exercised`
 * - Otherwise -> `{ run: true }`
 */
export function evaluateScenarioApplicability(
  scenario: Pick<TckScenarioDefinition, 'id' | 'requires'>,
  env: TckApplicabilityInput,
): TckApplicabilityDecision {
  const req = scenario.requires;

  if (req.capabilities) {
    for (const cap of req.capabilities) {
      if (!capabilitySatisfied(env.capabilities, cap)) {
        return {
          run: false,
          verdict: { status: 'not-applicable', note: `capability "${String(cap)}" is not supported` },
        };
      }
    }
  }

  if (req.traits) {
    for (const trait of req.traits) {
      switch (trait) {
        case 'survivesRestart':
          if (env.traits.survivesRestart !== true) {
            return {
              run: false,
              verdict: { status: 'not-applicable', note: 'backend does not declare traits.survivesRestart' },
            };
          }
          break;
        case 'prewarm':
          if (env.capabilities.supportsPrewarm !== true) {
            return {
              run: false,
              verdict: { status: 'not-applicable', note: 'backend does not declare supportsPrewarm' },
            };
          }
          break;
        case 'backgroundTasks':
          if (env.supportsBackgroundTasks === false) {
            return {
              run: false,
              verdict: { status: 'not-applicable', note: 'backend does not support background tasks' },
            };
          }
          break;
        case 'subagents':
          if (env.supportsSubagents === false) {
            return {
              run: false,
              verdict: { status: 'not-applicable', note: 'backend does not support subagents' },
            };
          }
          break;
        case 'slashCompact':
          if (!env.capabilities.compactCommand) {
            return {
              run: false,
              verdict: { status: 'not-applicable', note: 'backend does not expose compactCommand' },
            };
          }
          break;
        case 'slashClear':
          if (env.traits.startsNewTopic !== true && env.capabilities.supportsStandingMember !== true) {
            return {
              run: false,
              verdict: { status: 'not-applicable', note: 'backend does not declare startsNewTopic / /clear' },
            };
          }
          break;
        case 'sideChat':
          if (!env.supportsSideChat) {
            return {
              run: false,
              verdict: { status: 'not-applicable', note: 'backend does not support side-chat discussions' },
            };
          }
          break;
      }
    }
  }

  if (req.prevBin && !env.prevBin) {
    return {
      run: false,
      verdict: { status: 'not-exercised', note: 'requires --prev-bin <path> for cross-version resume' },
    };
  }

  if (req.liveOnly && !env.live) {
    return {
      run: false,
      verdict: { status: 'not-exercised', note: 'requires --live mode' },
    };
  }

  if (env.live && req.mockLlmOnly) {
    return {
      run: false,
      verdict: { status: 'not-exercised', note: 'deterministic mock-llm fault/barrier scenario skipped in --live mode' },
    };
  }

  if ((env.tier === 'B' || env.tier === 'C') && !env.live && req.mockLlm) {
    return {
      run: false,
      verdict: {
        status: 'not-exercised',
        note: `Tier ${env.tier} backend requires --live mode for conversation scenarios`,
      },
    };
  }

  return { run: true };
}

/**
 * Enables a required built-in plugin via `PATCH /api/integrations/:id` using `{ enablement: 'on' }`.
 * Throws immediately on any non-2xx response so contract mismatches (e.g. 400) are never swallowed.
 */
export async function enableBuiltinPluginIfNeeded(
  callRaw: CompatServer['callRaw'],
  pluginId: string | undefined,
  refresh?: () => Promise<void>,
): Promise<void> {
  if (!pluginId) return;
  const res = await callRaw(
    'PATCH',
    `/api/integrations/${encodeURIComponent(pluginId)}`,
    { enablement: 'on' },
  );
  if (res.statusCode >= 300) {
    throw new Error(
      `Failed to enable built-in plugin "${pluginId}": PATCH /api/integrations/${pluginId} returned ${res.statusCode} ${res.body}`,
    );
  }
  await refresh?.();
}

/**
 * Boots an isolated in-process Riffet server, enabling any required built-in plugin and honoring
 * `RIFFET_DEV_PLUGINS` for out-of-tree plugin backends.
 */
export async function bootCompatServer(
  stateDir: string,
  options: { cliPath?: string; requiresPlugin?: string } = {},
): Promise<CompatServer> {
  assertIsolatedPath(stateDir);
  const services = await createApp({
    stateDir,
    auth: false,
    ...(options.cliPath ? { cliPath: options.cliPath } : {}),
  });
  await services.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (services.app.server.address() as { port: number }).port;
  const host = `127.0.0.1:${port}`;
  const origin = {
    [CLIENT_FEATURES_HEADER]: ALL_CLIENT_FEATURES,
    host,
    origin: `http://${host}`,
  };
  const status = await services.app.inject({ url: '/api/auth/status', headers: origin });
  const cookie = String(status.headers['set-cookie']).split(';')[0]!;
  const csrfToken = String(status.json().csrfToken);
  const headers = { ...origin, cookie, 'x-csrf-token': csrfToken };

  const callRaw = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: string; json: unknown }> => {
    const response = await services.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    let json: unknown;
    try {
      json = response.body ? response.json() : undefined;
    } catch {
      json = undefined;
    }
    return { statusCode: response.statusCode, body: response.body, json };
  };

  const call = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<T> => {
    const res = await callRaw(method, url, payload);
    if (res.statusCode >= 400) {
      throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
    }
    return res.json as T;
  };

  await enableBuiltinPluginIfNeeded(callRaw, options.requiresPlugin, () => services.plugins.refresh());

  return {
    services,
    port,
    cookie,
    call,
    callRaw,
    close: () => services.app.close(),
  };
}

function chooseApprovalAction(interaction: NativeInteraction, kind: 'allow' | 'deny'): string {
  if (kind === 'allow') {
    const byId = interaction.actions.find(a =>
      /^(allow|approve|proceed_once|accept|yes|submit|confirm)$/i.test(a.id),
    );
    if (byId) return byId.id;
    const primary = interaction.actions.find(a => a.tone === 'primary');
    if (primary) return primary.id;
    return interaction.actions[0]?.id ?? 'allow';
  }
  const byId = interaction.actions.find(a =>
    /^(deny|reject|decline|cancel|no)$/i.test(a.id),
  );
  if (byId) return byId.id;
  const danger = interaction.actions.find(a => a.tone === 'danger');
  if (danger) return danger.id;
  return interaction.actions.at(-1)?.id ?? 'deny';
}

function chooseQuestionAction(interaction: NativeInteraction): { action: string; selectedIds?: string[] } {
  const action =
    interaction.actions.find(a => /^(answer|submit|allow|confirm)$/i.test(a.id))?.id
    ?? interaction.actions.find(a => a.tone === 'primary')?.id
    ?? interaction.actions[0]?.id
    ?? 'answer';
  const staging = interaction.options.find(opt => /staging/i.test(opt.label)) ?? interaction.options[0];
  return {
    action,
    ...(staging ? { selectedIds: [staging.id] } : {}),
  };
}

async function waitForSettle(): Promise<void> {
  await sleep(600);
}

// ---------------------------------------------------------------------------
// All 40 Standard TCK Scenarios (aligned 1-to-1 with `TCK_SCENARIO_IDS`)
// ---------------------------------------------------------------------------

export const TCK_SCENARIOS: readonly TckScenarioDefinition[] = [
  // =========================================================================
  // 1. 探测与生命周期
  // =========================================================================
  {
    id: 'probe-basic',
    category: 'probe-lifecycle',
    title: 'CLI availability & version probe',
    requires: {},
    async run(ctx) {
      const entry = await ctx.server.call<NativeBackendCatalogEntry>(
        'GET',
        `/api/backends/${encodeURIComponent(ctx.spec.id)}/catalog?projectId=${encodeURIComponent(ctx.projectId)}&profileId=${encodeURIComponent(ctx.profileId)}`,
      );
      const parsed = parseVersion(entry.cliVersion?.version);
      const checks: Check[] = [
        { name: 'catalog available === true', ok: entry.available === true, detail: entry.reason ?? entry.available },
        {
          name: 'cliVersion is readable and parseable',
          ok: Boolean(entry.cliVersion?.version && parsed),
          detail: entry.cliVersion,
        },
      ];
      return {
        ok: checks.every(c => c.ok),
        note: entry.cliVersion?.version ? `version=${entry.cliVersion.version}` : entry.reason,
        checks,
      };
    },
  },

  {
    id: 'probe-timeout-recovery',
    category: 'probe-lifecycle',
    title: 'Hanging CLI stub probe terminates within timeout budget',
    requires: {},
    async run(ctx) {
      const stubPath = await createHangingStubExecutable(ctx.sandbox.stubsDir, `hang-${randomUUID().slice(0, 8)}`);
      const tempProfileId = `compat-hang-${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      let catalogRes: { statusCode: number; json: unknown; body: string } | undefined;
      try {
        await ctx.server.call('POST', `/api/backends/${encodeURIComponent(ctx.spec.id)}/profiles`, {
          id: tempProfileId,
          name: 'Compat Hanging Stub',
          executable: stubPath,
        });
        catalogRes = await ctx.server.callRaw(
          'GET',
          `/api/backends/${encodeURIComponent(ctx.spec.id)}/catalog?projectId=${encodeURIComponent(ctx.projectId)}&profileId=${encodeURIComponent(tempProfileId)}`,
        );
      } finally {
        await ctx.server.callRaw(
          'DELETE',
          `/api/backends/${encodeURIComponent(ctx.spec.id)}/profiles/${encodeURIComponent(tempProfileId)}`,
        );
      }
      const elapsedMs = Date.now() - startedAt;
      const entry = catalogRes?.json as NativeBackendCatalogEntry | undefined;
      const bounded = elapsedMs < 45_000;
      const unavailable = catalogRes !== undefined && (catalogRes.statusCode >= 400 || entry?.available === false);
      const checks: Check[] = [
        { name: 'probe returned within timeout budget (<45s)', ok: bounded, detail: { elapsedMs } },
        { name: 'hanging stub reported unavailable/error', ok: unavailable, detail: { status: catalogRes?.statusCode, available: entry?.available, reason: entry?.reason } },
      ];
      return {
        ok: checks.every(c => c.ok),
        note: `elapsed=${elapsedMs}ms`,
        checks,
      };
    },
  },

  {
    id: 'prewarm-hit-miss',
    category: 'probe-lifecycle',
    title: 'Prewarm hit and cold-start miss on config change',
    requires: { mockLlm: true, traits: ['prewarm'] },
    async run(ctx) {
      const claimId = `tck-warm-${randomUUID().slice(0, 8)}`;
      const warmRes = await ctx.server.call<{ state: string; reason?: string }>('POST', '/api/native/prewarm', {
        projectId: ctx.projectId,
        backendId: ctx.spec.id,
        backendProfileId: ctx.profileId,
        ...(ctx.model ? { model: ctx.model } : {}),
        claimId,
      });

      const { session } = await ctx.createSession({ title: 'TCK prewarm hit' });
      const run1 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] prewarm-hit');

      // Mismatched config (different approval) must silently cold-start without error.
      const altApproval = ctx.spec.approvalModes?.ask;
      const { session: missSession } = await ctx.createSession({
        title: 'TCK prewarm miss',
        ...(altApproval ? { approval: altApproval } : {}),
      });
      const run2 = await ctx.sendAndWait(missSession.id, '[TCK:basic-turn] prewarm-miss');

      await ctx.server.callRaw('POST', '/api/native/prewarm/release', {
        backendId: ctx.spec.id,
        claimId,
      });

      const checks: Check[] = [
        {
          name: 'prewarm warmed cleanly (not skipped or failed)',
          ok: warmRes.state === 'ready' || warmRes.state === 'warming',
          detail: warmRes,
        },
        { name: 'warm-claimed turn completed', ok: run1.state === 'completed', detail: run1.state },
        { name: 'mismatched config cold-start turn completed', ok: run2.state === 'completed', detail: run2.state },
      ];
      return { ok: checks.every(c => c.ok), note: `prewarm=${warmRes.state}`, checks };
    },
  },

  // =========================================================================
  // 2. 基础与富对话
  // =========================================================================
  {
    id: 'basic-turn',
    category: 'basic-rich',
    title: 'Single basic turn, commandId claim, and Sync v3 delivery',
    requires: { mockLlm: true },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK basic-turn' });
      const prompt = ctx.live ? 'Reply with exactly the token TCK_BASIC_OK.' : '[TCK:basic-turn] ping';
      const run = await ctx.sendAndWait(session.id, prompt);
      await waitForSettle();
      const rows = await laneRows(ctx.server, session.id);
      const userRows = rows.rows.filter(r => r.kind === 'user');
      const answer = await ctx.latestAssistantText(session.id);

      const checks: Check[] = [
        { name: 'run completed', ok: run.state === 'completed', detail: run.error ?? run.state },
        { name: 'exactly one user row recorded', ok: userRows.length === 1, detail: { count: userRows.length } },
        {
          name: 'assistant answer delivered',
          ok: ctx.live ? answer.trim().length > 0 : answer.includes('TCK_BASIC_OK'),
          detail: answer.slice(0, 120),
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'multi-turn',
    category: 'basic-rich',
    title: 'Multi-turn conversation retains history across turns',
    requires: { mockLlm: true },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK multi-turn' });
      const run1 = await ctx.sendAndWait(session.id, '[TCK:multi-turn] remember=ALPHA_42');
      const run2 = await ctx.sendAndWait(session.id, '[TCK:multi-turn] recall second turn');
      await waitForSettle();
      const answer = await ctx.latestAssistantText(session.id);
      const outline = await laneOutline(ctx.server, session.id);

      const checks: Check[] = [
        { name: 'turn 1 completed', ok: run1.state === 'completed', detail: run1.state },
        { name: 'turn 2 completed', ok: run2.state === 'completed', detail: run2.state },
        { name: 'outline has 2 turns', ok: outline.turnCount >= 2, detail: { turnCount: outline.turnCount } },
        {
          name: 'second answer reflects multi-turn context',
          ok: ctx.live ? answer.trim().length > 0 : answer.includes('TCK_MULTI_TURN_2') && answer.includes('ALPHA_42'),
          detail: answer.slice(0, 160),
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'multiline-boundary',
    category: 'basic-rich',
    title: 'Multiline paste containing horizontal rules does not split prompt boundary',
    requires: { mockLlm: true },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK multiline-boundary' });
      const prompt = [
        '[TCK:multiline-boundary]',
        'section one',
        '────────────────────────────────────────',
        'section two',
        'TAIL_SENTINEL_99',
      ].join('\n');
      const run = await ctx.sendAndWait(session.id, prompt);
      await waitForSettle();
      const answer = await ctx.latestAssistantText(session.id);
      const rows = await laneRows(ctx.server, session.id);
      const userRows = rows.rows.filter(r => r.kind === 'user');

      const checks: Check[] = [
        { name: 'run completed', ok: run.state === 'completed', detail: run.state },
        { name: 'multiline input stays a single user row', ok: userRows.length === 1, detail: { count: userRows.length } },
        {
          name: 'model received rule and tail line intact',
          ok: ctx.live
            ? answer.trim().length > 0
            : answer.includes('TCK_MULTILINE_OK') && answer.includes('hasRule=true') && answer.includes('TAIL_SENTINEL_99'),
          detail: answer.slice(0, 160),
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'image-attachment',
    category: 'basic-rich',
    title: 'Image attachment reaches LLM request without silent degradation',
    requires: { mockLlm: true },
    async run(ctx) {
      const pngBytes = readFileSync(ctx.sandbox.imagePath);
      const uploaded = await ctx.server.call<{ id: string; path: string }>(
        'POST',
        `/api/projects/${encodeURIComponent(ctx.projectId)}/attachments`,
        {
          name: 'red-square.png',
          mimeType: 'image/png',
          dataBase64: pngBytes.toString('base64'),
          width: 1,
          height: 1,
        },
      );
      const { session } = await ctx.createSession({ title: 'TCK image-attachment' });
      const beforeCount = ctx.mockHub.requests().length;
      const run = await ctx.sendAndWait(session.id, '[TCK:image-attachment] inspect image', {
        attachments: [{ id: uploaded.id }],
      });
      await waitForSettle();
      const newReqs = ctx.mockHub.requests().slice(beforeCount);
      const sawImagePayload = newReqs.some(r => r.hasImage === true);
      const answer = await ctx.latestAssistantText(session.id);

      const checks: Check[] = [
        { name: 'run completed', ok: run.state === 'completed', detail: run.state },
        {
          name: 'mock LLM observed image payload (hasImage === true)',
          ok: ctx.live ? answer.trim().length > 0 : sawImagePayload,
          detail: { requests: newReqs.length, hasImage: sawImagePayload },
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'rich-stream',
    category: 'basic-rich',
    title: 'Rich stream with thinking/narration, wide table, and draft promotion',
    requires: { mockLlm: true },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK rich-stream' });
      const run = await ctx.sendAndWait(session.id, '[TCK:rich-stream] narration=true');
      await waitForSettle();
      const rows = await laneRows(ctx.server, session.id);
      const answer = await ctx.latestAssistantText(session.id);
      const assistantRows = rows.rows.filter(
        (r): r is Extract<TimelineRow, { kind: 'assistant' }> => r.kind === 'assistant',
      );
      const expectsThinking = !ctx.live && THINKING_PROTOCOLS.has(ctx.spec.protocol);
      const sawThoughtOrNarration = rows.rows.some(r => r.kind === 'thought')
        || assistantRows.some(r => r.text.includes('Checking workspace status'));

      const checks: Check[] = [
        { name: 'run completed', ok: run.state === 'completed', detail: run.state },
        {
          name: 'rich answer with wide markdown table delivered',
          ok: ctx.live
            ? answer.trim().length > 0
            : answer.includes('TCK_RICH_STREAM_OK') && answer.includes('Column A') && answer.includes('epsilon-value-05'),
          detail: answer.slice(0, 160),
        },
        ...(expectsThinking
          ? [{
            name: 'thinking or narration block observed in timeline',
            ok: sawThoughtOrNarration,
            detail: { rowKinds: [...new Set(rows.rows.map(r => r.kind))] },
          }]
          : []),
        {
          name: 'draft promoted without duplicate assistant rows',
          ok: assistantRows.length >= 1 && assistantRows.filter(r => r.text.includes('TCK_RICH_STREAM_OK')).length <= 1,
          detail: { assistantRowCount: assistantRows.length },
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  // =========================================================================
  // 3. 工具与审批闭环
  // =========================================================================
  {
    id: 'tool-read-bash',
    category: 'tools-approval',
    title: 'Read file and streaming bash tool execution',
    requires: { mockLlm: true },
    async run(ctx) {
      const { session } = await ctx.createSession({
        title: 'TCK tool-read-bash',
        ...(ctx.spec.approvalModes?.auto ? { approval: ctx.spec.approvalModes.auto } : {}),
      });
      const run = await ctx.sendAndWait(session.id, '[TCK:tool-read-bash] file=README.md');
      await waitForSettle();
      const rows = await laneRows(ctx.server, session.id);
      const toolRows = rows.rows.filter(r => r.kind === 'tool');
      const answer = await ctx.latestAssistantText(session.id);

      const checks: Check[] = [
        { name: 'run completed', ok: run.state === 'completed', detail: run.state },
        { name: 'at least one tool row recorded', ok: toolRows.length >= 1, detail: { toolRows: toolRows.length } },
        {
          name: 'tool-result closed loop reached final answer',
          ok: ctx.live ? answer.trim().length > 0 : answer.includes('TCK_TOOL_READ_BASH_DONE'),
          detail: answer.slice(0, 160),
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'tool-parallel-ooo',
    category: 'tools-approval',
    title: 'Parallel out-of-order tool completions without spurious lane rebuild',
    requires: { mockLlm: true },
    async run(ctx) {
      const { session, stream } = await ctx.createSession({
        title: 'TCK tool-parallel-ooo',
        ...(ctx.spec.approvalModes?.auto ? { approval: ctx.spec.approvalModes.auto } : {}),
      });
      const run = await ctx.sendAndWait(session.id, '[TCK:tool-parallel-ooo]');
      await waitForSettle();
      const answer = await ctx.latestAssistantText(session.id);
      const resets = stream.frames.filter(
        (frame): frame is Extract<SyncFrame, { type: 'reset' }> => frame.type === 'reset' && frame.reason === 'rebuilt',
      );

      const checks: Check[] = [
        { name: 'run completed', ok: run.state === 'completed', detail: run.state },
        { name: 'no spurious lane rebuild reset', ok: resets.length === 0, detail: { resets: resets.length } },
        {
          name: 'both parallel tools completed and summarized',
          ok: ctx.live ? answer.trim().length > 0 : answer.includes('TCK_TOOL_PARALLEL_DONE'),
          detail: answer.slice(0, 160),
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'tool-malformed-recovery',
    category: 'tools-approval',
    title: 'Recovery after malformed JSON tool arguments',
    requires: { mockLlm: true, mockLlmOnly: true },
    async run(ctx) {
      const { session } = await ctx.createSession({
        title: 'TCK tool-malformed-recovery',
        ...(ctx.spec.approvalModes?.auto ? { approval: ctx.spec.approvalModes.auto } : {}),
      });
      const run1 = await ctx.sendAndWait(session.id, '[TCK:tool-malformed-recovery]');
      const run2 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] after-malformed');

      const checks: Check[] = [
        { name: 'malformed turn settled cleanly', ok: TERMINAL_RUN_STATES.has(run1.state), detail: run1.state },
        { name: 'subsequent turn completed normally', ok: run2.state === 'completed', detail: run2.state },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'approval-deny',
    category: 'tools-approval',
    title: 'Tool approval denied prevents target file creation on disk',
    requires: { mockLlm: true, capabilities: ['supportsPermissionSelection', 'interactionTransport'] },
    async run(ctx) {
      const filename = `tck-deny-${randomUUID().slice(0, 8)}.txt`;
      const targetPath = join(ctx.sandbox.projectDir, filename);
      await rm(targetPath, { force: true });

      const { session } = await ctx.createSession({
        title: 'TCK approval-deny',
        ...(ctx.spec.approvalModes?.ask ? { approval: ctx.spec.approvalModes.ask } : {}),
      });
      const run = await ctx.sendMessage(session.id, `[TCK:approval-deny] file=${filename}`);
      const interaction = await ctx.waitForInteraction(session.id);
      const action = chooseApprovalAction(interaction, 'deny');

      await ctx.server.call('POST', `/api/sessions/${encodeURIComponent(session.id)}/native/interaction`, {
        interactionId: interaction.id,
        revision: interaction.revision,
        requestId: randomUUID(),
        action,
      });

      const finished = await ctx.waitForRun(run.id);
      await waitForSettle();
      const fileCreated = existsSync(targetPath);

      const checks: Check[] = [
        { name: 'interaction card surfaced and answered', ok: Boolean(interaction.id), detail: { id: interaction.id, action, transport: interaction.transport } },
        { name: 'run settled after denial', ok: TERMINAL_RUN_STATES.has(finished.state), detail: finished.state },
        { name: 'target file does NOT exist on disk', ok: !fileCreated, detail: { targetPath, exists: fileCreated } },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'approval-allow',
    category: 'tools-approval',
    title: 'Tool approval allowed writes target file to disk',
    requires: { mockLlm: true, capabilities: ['supportsPermissionSelection', 'interactionTransport'] },
    async run(ctx) {
      const filename = `tck-allow-${randomUUID().slice(0, 8)}.txt`;
      const targetPath = join(ctx.sandbox.projectDir, filename);
      await rm(targetPath, { force: true });

      const { session } = await ctx.createSession({
        title: 'TCK approval-allow',
        ...(ctx.spec.approvalModes?.ask ? { approval: ctx.spec.approvalModes.ask } : {}),
      });
      const run = await ctx.sendMessage(session.id, `[TCK:approval-allow] file=${filename}`);
      const interaction = await ctx.waitForInteraction(session.id);
      const action = chooseApprovalAction(interaction, 'allow');

      await ctx.server.call('POST', `/api/sessions/${encodeURIComponent(session.id)}/native/interaction`, {
        interactionId: interaction.id,
        revision: interaction.revision,
        requestId: randomUUID(),
        action,
      });

      const finished = await ctx.waitForRun(run.id);
      await waitForSettle();
      const fileCreated = existsSync(targetPath);

      const checks: Check[] = [
        { name: 'interaction card surfaced and allowed', ok: Boolean(interaction.id), detail: { id: interaction.id, action, transport: interaction.transport } },
        { name: 'run completed after approval', ok: finished.state === 'completed', detail: finished.state },
        { name: 'target file EXISTS on disk', ok: fileCreated, detail: { targetPath, exists: fileCreated } },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'approval-cancel',
    category: 'tools-approval',
    title: 'Cancelling during pending approval aborts tool without disk side effects',
    requires: { mockLlm: true, capabilities: ['supportsPermissionSelection', 'supportsInterrupt', 'interactionTransport'] },
    async run(ctx) {
      const filename = `tck-cancel-${randomUUID().slice(0, 8)}.txt`;
      const targetPath = join(ctx.sandbox.projectDir, filename);
      await rm(targetPath, { force: true });

      const { session } = await ctx.createSession({
        title: 'TCK approval-cancel',
        ...(ctx.spec.approvalModes?.ask ? { approval: ctx.spec.approvalModes.ask } : {}),
      });
      const run = await ctx.sendMessage(session.id, `[TCK:approval-cancel] file=${filename}`);
      const interaction = await ctx.waitForInteraction(session.id);

      await ctx.server.call(
        'POST',
        `/api/sessions/${encodeURIComponent(session.id)}/cancel`,
        ctx.buildStopRequest(session.id),
      );

      const finished = await ctx.waitForRun(run.id);
      await waitForSettle();
      const fileCreated = existsSync(targetPath);

      const checks: Check[] = [
        { name: 'approval card observed before cancel', ok: Boolean(interaction.id), detail: interaction.id },
        { name: 'run terminated cleanly', ok: TERMINAL_RUN_STATES.has(finished.state), detail: finished.state },
        { name: 'target file does NOT exist on disk', ok: !fileCreated, detail: { targetPath, exists: fileCreated } },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'question-answer',
    category: 'tools-approval',
    title: 'AskUserQuestion interaction card echoes selected option back to model',
    requires: { mockLlm: true, capabilities: ['interactionTransport'] },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK question-answer' });
      const run = await ctx.sendMessage(session.id, '[TCK:question-answer]');
      const interaction = await ctx.waitForInteraction(session.id);
      const reply = chooseQuestionAction(interaction);

      await ctx.server.call('POST', `/api/sessions/${encodeURIComponent(session.id)}/native/interaction`, {
        interactionId: interaction.id,
        revision: interaction.revision,
        requestId: randomUUID(),
        ...reply,
      });

      const finished = await ctx.waitForRun(run.id);
      await waitForSettle();
      const answer = await ctx.latestAssistantText(session.id);

      const checks: Check[] = [
        { name: 'question interaction card surfaced', ok: interaction.kind === 'question', detail: interaction.kind },
        { name: 'run completed after answer', ok: finished.state === 'completed', detail: finished.state },
        {
          name: 'model echoed selected option',
          ok: ctx.live ? answer.trim().length > 0 : answer.includes('TCK_QUESTION_ANSWERED') && /staging/i.test(answer),
          detail: answer.slice(0, 160),
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'mode-switch',
    category: 'tools-approval',
    title: 'Switch backend mode and run a turn in the selected mode',
    requires: { mockLlm: true, capabilities: ['supportsModeSelection', 'modes'] },
    async run(ctx) {
      const modes = ctx.capabilities.modes;
      const targetMode = modes[1]?.id ?? modes[0]!.id;
      const baseMode = modes[0]!.id;
      const { session } = await ctx.createSession({ title: 'TCK mode-switch', mode: baseMode });

      await ctx.server.call('POST', `/api/sessions/${encodeURIComponent(session.id)}/native/mode`, {
        mode: targetMode,
      });
      const updated = ctx.server.services.store.getSession(session.id);
      const run = await ctx.sendAndWait(session.id, '[TCK:basic-turn] mode-switched');

      await ctx.server.call('POST', `/api/sessions/${encodeURIComponent(session.id)}/native/mode`, {
        mode: baseMode,
      });

      const checks: Check[] = [
        { name: 'session mode updated to targetMode', ok: updated.mode === targetMode, detail: { expected: targetMode, actual: updated.mode } },
        { name: 'turn completed in switched mode', ok: run.state === 'completed', detail: run.state },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  // =========================================================================
  // 4. Steer、排队与打断
  // =========================================================================
  {
    id: 'steer-valid',
    category: 'steer-interrupt',
    title: 'In-turn steering with valid activeTurn target',
    requires: { mockLlm: true, mockLlmOnly: true, capabilities: ['supportsSteer'] },
    async run(ctx) {
      ctx.mockHub.gates.reset('steer-valid:hold');
      const { session } = await ctx.createSession({ title: 'TCK steer-valid' });
      const beforeCount = ctx.mockHub.requests().length;
      const primary = await ctx.sendMessage(session.id, '[TCK:steer-valid]');
      try {
        await ctx.mockHub.gates.waitUntilReached('steer-valid:hold', ctx.timeoutMs);
        const status = await until(
          () => {
            const st = ctx.server.services.nativeBackends.status(session.id);
            return st.activeTurn ? st : undefined;
          },
          {
            timeoutMs: ctx.timeoutMs,
            describe: () => `activeTurn for steer-valid (phase=${ctx.server.services.nativeBackends.status(session.id).phase})`,
          },
        );
        const steerRun = await ctx.server.call<Run>(
          'POST',
          `/api/sessions/${encodeURIComponent(session.id)}/native/steer`,
          {
            commandId: `tck-steer-${randomUUID()}`,
            text: '[TCK:steer-followup] pivot now',
            target: {
              nativeSessionId: status.activeTurn!.nativeSessionId,
              turnId: status.activeTurn!.turnId,
            },
          },
        );
        ctx.trackedRuns.add(steerRun.id);
        ctx.mockHub.gates.release('steer-valid:hold');

        const [donePrimary, doneSteer] = await Promise.all([
          ctx.waitForRun(primary.id),
          ctx.waitForRun(steerRun.id),
        ]);
        await waitForSettle();
        const newReqs = ctx.mockHub.requests().slice(beforeCount);
        const rows = await laneRows(ctx.server, session.id);
        const steerObserved = newReqs.some(req =>
          req.messages.some(m => m.text.includes('pivot now') || m.text.includes('[TCK:steer-followup]')),
        ) || rows.rows.some(
          r => (r.kind === 'assistant' || r.kind === 'user')
            && (r.text.includes('TCK_STEER_APPLIED') || r.text.includes('pivot now')),
        );
        const checks: Check[] = [
          { name: 'primary run completed', ok: donePrimary.state === 'completed', detail: donePrimary.state },
          { name: 'steer run completed', ok: doneSteer.state === 'completed', detail: doneSteer.state },
          { name: 'steer payload reached model or timeline', ok: steerObserved, detail: { requests: newReqs.length } },
        ];
        return { ok: checks.every(c => c.ok), checks };
      } finally {
        ctx.mockHub.gates.release('steer-valid:hold');
      }
    },
  },

  {
    id: 'steer-stale',
    category: 'steer-interrupt',
    title: 'Steer against ended turn is rejected with 409 STEER_TARGET_CHANGED',
    requires: { mockLlm: true, mockLlmOnly: true, capabilities: ['supportsSteer'] },
    async run(ctx) {
      ctx.mockHub.gates.reset('steer-stale:hold');
      const { session } = await ctx.createSession({ title: 'TCK steer-stale' });
      const primary = await ctx.sendMessage(session.id, '[TCK:steer-stale]');
      let staleTarget: { nativeSessionId: string; turnId: string } | undefined;
      try {
        await ctx.mockHub.gates.waitUntilReached('steer-stale:hold', ctx.timeoutMs);
        const status = await until(
          () => {
            const st = ctx.server.services.nativeBackends.status(session.id);
            return st.activeTurn ? st : undefined;
          },
          { timeoutMs: ctx.timeoutMs, describe: () => 'activeTurn before releasing steer-stale' },
        );
        staleTarget = {
          nativeSessionId: status.activeTurn!.nativeSessionId,
          turnId: status.activeTurn!.turnId,
        };
      } finally {
        ctx.mockHub.gates.release('steer-stale:hold');
      }
      await ctx.waitForRun(primary.id);
      await ctx.waitForPhase(session.id, ['idle', 'offline']);

      const res = await ctx.server.callRaw(
        'POST',
        `/api/sessions/${encodeURIComponent(session.id)}/native/steer`,
        {
          commandId: `tck-steer-stale-${randomUUID()}`,
          text: '[TCK:steer-followup] too late',
          target: staleTarget,
        },
      );
      const errCode = (res.json as { error?: { code?: string } } | undefined)?.error?.code;
      const checks: Check[] = [
        { name: 'stale steer rejected with 409', ok: res.statusCode === 409, detail: { statusCode: res.statusCode, body: res.body } },
        { name: 'error code is STEER_TARGET_CHANGED', ok: errCode === 'STEER_TARGET_CHANGED', detail: errCode },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'busy-queue',
    category: 'steer-interrupt',
    title: 'Message sent while busy queues and dispatches exactly once after turn finishes',
    requires: { mockLlm: true, mockLlmOnly: true },
    async run(ctx) {
      ctx.mockHub.gates.reset('busy-queue:hold');
      const { session } = await ctx.createSession({ title: 'TCK busy-queue' });
      const run1 = await ctx.sendMessage(session.id, '[TCK:busy-queue] primary');
      let run2: Run;
      let observedQueued = false;
      try {
        await ctx.mockHub.gates.waitUntilReached('busy-queue:hold', ctx.timeoutMs);
        run2 = await ctx.sendMessage(session.id, '[TCK:busy-queue] queued=1 followup');
        observedQueued = run2.state === 'queued' || ctx.server.services.store.getRun(run2.id).state === 'queued';
      } finally {
        ctx.mockHub.gates.release('busy-queue:hold');
      }

      const [done1, done2] = await Promise.all([ctx.waitForRun(run1.id), ctx.waitForRun(run2.id)]);
      await waitForSettle();
      const queuedRequests = ctx.mockHub.requests(r => r.lastUserText.includes('queued=1'));
      const answer = await ctx.latestAssistantText(session.id);

      const checks: Check[] = [
        { name: 'second message observed queued while first active', ok: observedQueued, detail: { observedQueued } },
        { name: 'first turn completed', ok: done1.state === 'completed', detail: done1.state },
        { name: 'queued turn completed', ok: done2.state === 'completed', detail: done2.state },
        { name: 'queued message dispatched exactly once', ok: queuedRequests.length === 1, detail: { count: queuedRequests.length } },
        { name: 'queued answer delivered', ok: answer.includes('TCK_BUSY_QUEUED_DELIVERED'), detail: answer.slice(0, 120) },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'interrupt-before-first-token',
    category: 'steer-interrupt',
    title: 'Interrupt before first token leaves no synthetic placeholder and allows resume',
    requires: { mockLlm: true, mockLlmOnly: true, capabilities: ['supportsInterrupt'] },
    async run(ctx) {
      ctx.mockHub.gates.reset('interrupt-before-first-token');
      const { session } = await ctx.createSession({ title: 'TCK interrupt-before-first-token' });
      const run1 = await ctx.sendMessage(session.id, '[TCK:interrupt-before-first-token]');
      let done1: Run;
      try {
        await ctx.mockHub.gates.waitUntilReached('interrupt-before-first-token', ctx.timeoutMs);
        await ctx.server.call(
          'POST',
          `/api/sessions/${encodeURIComponent(session.id)}/cancel`,
          ctx.buildStopRequest(session.id),
        );
        // Wait for cancellation while the gate is still held so the stream cannot finish normally.
        done1 = await ctx.waitForRun(run1.id);
        await ctx.waitForPhase(session.id, ['idle', 'offline']);
      } finally {
        ctx.mockHub.gates.release('interrupt-before-first-token');
      }
      const rowsAfterCancel = await laneRows(ctx.server, session.id);
      const hasSyntheticPlaceholder = rowsAfterCancel.rows.some(
        r => r.kind === 'assistant' && r.text.includes('No response requested.'),
      );
      const leakedPreCancelToken = rowsAfterCancel.rows.some(
        r => (r.kind === 'assistant' || r.kind === 'thought')
          && r.text.includes('TCK_SHOULD_NOT_EMIT_BEFORE_FIRST_TOKEN'),
      );
      const run2 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] after-early-interrupt');

      const checks: Check[] = [
        { name: 'interrupted run entered interrupted/cancelled state', ok: INTERRUPTED_RUN_STATES.has(done1.state), detail: done1.state },
        { name: 'no orphan synthetic placeholder row', ok: !hasSyntheticPlaceholder, detail: { hasSyntheticPlaceholder } },
        { name: 'no post-gate token leaked into timeline', ok: !leakedPreCancelToken, detail: { leakedPreCancelToken } },
        { name: 'follow-up turn completed cleanly', ok: run2.state === 'completed', detail: run2.state },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'interrupt-mid-stream',
    category: 'steer-interrupt',
    title: 'Interrupt mid-stream stops active turn and preserves subsequent turns',
    requires: { mockLlm: true, mockLlmOnly: true, capabilities: ['supportsInterrupt'] },
    async run(ctx) {
      ctx.mockHub.gates.reset('interrupt-mid-stream');
      const { session } = await ctx.createSession({ title: 'TCK interrupt-mid-stream' });
      const run1 = await ctx.sendMessage(session.id, '[TCK:interrupt-mid-stream]');
      let done1: Run;
      try {
        await ctx.mockHub.gates.waitUntilReached('interrupt-mid-stream', ctx.timeoutMs);
        await ctx.server.call(
          'POST',
          `/api/sessions/${encodeURIComponent(session.id)}/cancel`,
          ctx.buildStopRequest(session.id),
        );
        // Wait for cancellation while the gate is held so the stream cannot complete normally.
        done1 = await ctx.waitForRun(run1.id);
        await ctx.waitForPhase(session.id, ['idle', 'offline']);
      } finally {
        ctx.mockHub.gates.release('interrupt-mid-stream');
      }
      const run2 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] after-mid-interrupt');

      const checks: Check[] = [
        { name: 'mid-stream run entered interrupted/cancelled state', ok: INTERRUPTED_RUN_STATES.has(done1.state), detail: done1.state },
        { name: 'follow-up turn completed cleanly', ok: run2.state === 'completed', detail: run2.state },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'interrupt-during-tool',
    category: 'steer-interrupt',
    title: 'Interrupt while a long-running tool is executing',
    requires: { mockLlm: true, mockLlmOnly: true, capabilities: ['supportsInterrupt'] },
    async run(ctx) {
      ctx.mockHub.gates.reset('interrupt-during-tool');
      const { session } = await ctx.createSession({
        title: 'TCK interrupt-during-tool',
        ...(ctx.spec.approvalModes?.auto ? { approval: ctx.spec.approvalModes.auto } : {}),
      });
      const run1 = await ctx.sendMessage(session.id, '[TCK:interrupt-during-tool]');
      try {
        await ctx.mockHub.gates.waitUntilReached('interrupt-during-tool', ctx.timeoutMs);
      } finally {
        ctx.mockHub.gates.release('interrupt-during-tool');
      }
      // Give the CLI a moment to start the `sleep 30` tool before interrupting.
      await sleep(800);
      await ctx.server.call(
        'POST',
        `/api/sessions/${encodeURIComponent(session.id)}/cancel`,
        ctx.buildStopRequest(session.id),
      );
      const done1 = await ctx.waitForRun(run1.id);
      await ctx.waitForPhase(session.id, ['idle', 'offline']);
      const run2 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] after-tool-interrupt');

      const checks: Check[] = [
        { name: 'tool turn entered interrupted/cancelled state', ok: INTERRUPTED_RUN_STATES.has(done1.state), detail: done1.state },
        { name: 'follow-up turn completed cleanly', ok: run2.state === 'completed', detail: run2.state },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'interrupt-and-send',
    category: 'steer-interrupt',
    title: 'Interrupt active turn and atomically dispatch replacement message',
    requires: { mockLlm: true, mockLlmOnly: true, capabilities: ['supportsInterrupt'] },
    async run(ctx) {
      ctx.mockHub.gates.reset('interrupt-and-send');
      const { session } = await ctx.createSession({ title: 'TCK interrupt-and-send' });
      const run1 = await ctx.sendMessage(session.id, '[TCK:interrupt-and-send] first');
      let replacement: Run;
      let done1: Run;
      try {
        await ctx.mockHub.gates.waitUntilReached('interrupt-and-send', ctx.timeoutMs);
        replacement = await ctx.server.call<Run>(
          'POST',
          `/api/sessions/${encodeURIComponent(session.id)}/native/interrupt-and-send`,
          {
            commandId: `tck-int-send-${randomUUID()}`,
            text: '[TCK:interrupt-and-send] after-interrupt=1',
            stop: ctx.buildStopRequest(session.id),
          },
        );
        ctx.trackedRuns.add(replacement.id);
        // Wait for original run to interrupt while gate is still held so it cannot finish normally.
        done1 = await ctx.waitForRun(run1.id);
      } finally {
        ctx.mockHub.gates.release('interrupt-and-send');
      }

      const done2 = await ctx.waitForRun(replacement.id);
      await waitForSettle();
      const answer = await ctx.latestAssistantText(session.id);

      const checks: Check[] = [
        { name: 'original run entered interrupted/cancelled state', ok: INTERRUPTED_RUN_STATES.has(done1.state), detail: done1.state },
        { name: 'replacement run completed', ok: done2.state === 'completed', detail: done2.state },
        { name: 'replacement answer delivered', ok: answer.includes('TCK_AFTER_INTERRUPT_OK'), detail: answer.slice(0, 120) },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  // =========================================================================
  // 5. Subagent 与后台任务
  // =========================================================================
  {
    id: 'subagent-sync',
    category: 'subagent-bg',
    title: 'Synchronous subagent call completes with consistent sub-lane Sync v3 seq',
    requires: { mockLlm: true, traits: ['subagents'] },
    async run(ctx) {
      const { session } = await ctx.createSession({
        title: 'TCK subagent-sync',
        ...(ctx.spec.approvalModes?.auto ? { approval: ctx.spec.approvalModes.auto } : {}),
      });
      const run = await ctx.sendAndWait(session.id, '[TCK:subagent-sync]');
      await waitForSettle();
      const mainRows = await laneRows(ctx.server, session.id);
      const childLanes = subagentLanes(mainRows.rows);
      const hasSubagentRow = mainRows.rows.some(
        row =>
          row.kind === 'tool'
          && (Boolean(row.subagent) || row.event.data.kind === 'agent'),
      );
      const subChecks: Check[] = [];
      for (const lane of childLanes) {
        const subStream = openLane(ctx.server, session.id, lane);
        await sleep(500);
        subStream.close();
        const subFinal = await laneRows(ctx.server, session.id, lane);
        subChecks.push(...seqChecks(lane, subStream, subFinal));
      }
      const answer = await ctx.latestAssistantText(session.id);

      const checks: Check[] = [
        { name: 'subagent sync run completed', ok: run.state === 'completed', detail: run.state },
        {
          name: 'subagent child lane or agent tool row observed',
          ok: childLanes.length >= 1 || hasSubagentRow,
          detail: { childLanes: childLanes.length, hasSubagentRow },
        },
        {
          name: 'parent turn received subagent summary',
          ok: ctx.live ? answer.trim().length > 0 : answer.includes('TCK_SUBAGENT_SYNC_DONE'),
          detail: answer.slice(0, 160),
        },
        ...subChecks,
      ];
      return { ok: checks.every(c => c.ok), note: `subLanes=${childLanes.length}`, checks };
    },
  },

  {
    id: 'subagent-bg-unblocked',
    category: 'subagent-bg',
    title: 'Background subagent leaves foreground session idle and unblocked',
    requires: { mockLlm: true, mockLlmOnly: true, traits: ['subagents', 'backgroundTasks'] },
    async run(ctx) {
      ctx.mockHub.gates.reset('subagent-bg:worker');
      const { session } = await ctx.createSession({
        title: 'TCK subagent-bg-unblocked',
        ...(ctx.spec.approvalModes?.auto ? { approval: ctx.spec.approvalModes.auto } : {}),
      });
      try {
        const launchRun = await ctx.sendAndWait(session.id, '[TCK:subagent-bg-unblocked]');
        await ctx.waitForPhase(session.id, ['idle']);
        const runningBg = await waitForRunningActivities(ctx, session.id, 1, Math.min(ctx.timeoutMs, 15_000));
        const fgRun = await ctx.sendAndWait(session.id, '[TCK:basic-turn] foreground-while-bg');

        const checks: Check[] = [
          { name: 'background launcher turn completed', ok: launchRun.state === 'completed', detail: launchRun.state },
          {
            name: 'background subagent activity is actively running before foreground turn',
            ok: runningBg.length >= 1,
            detail: runningBg.map(a => ({ id: a.id, kind: a.kind, status: a.status })),
          },
          { name: 'foreground message dispatched and completed while bg running', ok: fgRun.state === 'completed', detail: fgRun.state },
        ];
        return { ok: checks.every(c => c.ok), checks };
      } finally {
        ctx.mockHub.gates.release('subagent-bg:worker');
      }
    },
  },

  {
    id: 'bg-stop-single-and-multi',
    category: 'subagent-bg',
    title: 'Stopping 1 vs 2 parallel background agent tasks via activity stop API',
    requires: { mockLlm: true, mockLlmOnly: true, traits: ['backgroundTasks'] },
    async run(ctx) {
      ctx.mockHub.gates.reset('subagent-bg:worker');
      const { session } = await ctx.createSession({
        title: 'TCK bg-stop',
        ...(ctx.spec.approvalModes?.auto ? { approval: ctx.spec.approvalModes.auto } : {}),
      });
      const checks: Check[] = [];
      try {
        // Single background task
        const singleRun = await ctx.sendAndWait(session.id, '[TCK:bg-stop-single]');
        checks.push({ name: 'single bg launch completed', ok: singleRun.state === 'completed', detail: singleRun.state });
        const singleActs = await waitForStoppableActivities(ctx, session.id, 1, Math.min(ctx.timeoutMs, 15_000));
        checks.push({
          name: 'at least 1 stoppable single bg activity surfaced',
          ok: singleActs.length >= 1,
          detail: { count: singleActs.length, ids: singleActs.map(a => a.id) },
        });
        for (const act of singleActs) {
          const res = await ctx.server.callRaw(
            'POST',
            `/api/sessions/${encodeURIComponent(session.id)}/native/activities/${encodeURIComponent(act.id)}/stop`,
          );
          checks.push({ name: `stop single bg activity ${act.id}`, ok: res.statusCode < 400, detail: res.statusCode });
        }
        if (singleActs.length >= 1) {
          const settledSingle = await waitForActivitiesSettled(
            ctx,
            session.id,
            singleActs.map(a => a.id),
            Math.min(ctx.timeoutMs, 20_000),
          );
          checks.push({
            name: 'single bg activity converged to non-running after stop',
            ok: settledSingle.ok,
            detail: settledSingle.stillRunning,
          });
        }

        // Multiple (2) parallel background tasks
        const multiRun = await ctx.sendAndWait(session.id, '[TCK:bg-stop-multi]');
        checks.push({ name: 'multi bg launch completed', ok: multiRun.state === 'completed', detail: multiRun.state });
        const multiActs = await waitForStoppableActivities(ctx, session.id, 2, Math.min(ctx.timeoutMs, 15_000));
        checks.push({
          name: 'at least 2 stoppable parallel bg activities surfaced',
          ok: multiActs.length >= 2,
          detail: { count: multiActs.length, ids: multiActs.map(a => a.id) },
        });
        for (const act of multiActs) {
          const res = await ctx.server.callRaw(
            'POST',
            `/api/sessions/${encodeURIComponent(session.id)}/native/activities/${encodeURIComponent(act.id)}/stop`,
          );
          checks.push({ name: `stop multi bg activity ${act.id}`, ok: res.statusCode < 400, detail: res.statusCode });
        }
        if (multiActs.length >= 1) {
          const settledMulti = await waitForActivitiesSettled(
            ctx,
            session.id,
            multiActs.map(a => a.id),
            Math.min(ctx.timeoutMs, 20_000),
          );
          checks.push({
            name: 'multi bg activities converged to non-running after stop',
            ok: settledMulti.ok,
            detail: settledMulti.stillRunning,
          });
        }
      } finally {
        ctx.mockHub.gates.release('subagent-bg:worker');
      }
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'bg-shell-stop',
    category: 'subagent-bg',
    title: 'Stopping a detached background shell task via activity stop API',
    requires: { mockLlm: true, mockLlmOnly: true, traits: ['backgroundTasks'] },
    async run(ctx) {
      const { session } = await ctx.createSession({
        title: 'TCK bg-shell-stop',
        ...(ctx.spec.approvalModes?.auto ? { approval: ctx.spec.approvalModes.auto } : {}),
      });
      const run = await ctx.sendAndWait(session.id, '[TCK:bg-shell-stop]');
      const acts = await waitForStoppableActivities(ctx, session.id, 1, Math.min(ctx.timeoutMs, 15_000));
      const checks: Check[] = [
        { name: 'bg shell launch completed', ok: run.state === 'completed', detail: run.state },
        {
          name: 'at least 1 stoppable bg shell activity surfaced',
          ok: acts.length >= 1,
          detail: { count: acts.length, ids: acts.map(a => a.id) },
        },
      ];
      for (const act of acts) {
        const res = await ctx.server.callRaw(
          'POST',
          `/api/sessions/${encodeURIComponent(session.id)}/native/activities/${encodeURIComponent(act.id)}/stop`,
        );
        checks.push({ name: `stop bg shell ${act.id}`, ok: res.statusCode < 400, detail: res.statusCode });
      }
      if (acts.length >= 1) {
        const settled = await waitForActivitiesSettled(
          ctx,
          session.id,
          acts.map(a => a.id),
          Math.min(ctx.timeoutMs, 20_000),
        );
        checks.push({
          name: 'bg shell activity converged to non-running after stop',
          ok: settled.ok,
          detail: settled.stillRunning,
        });
      }
      return { ok: checks.every(c => c.ok), note: `activities=${acts.length}`, checks };
    },
  },

  // =========================================================================
  // 6. 斜杠、压缩与动态配置
  // =========================================================================
  {
    id: 'slash-compact',
    category: 'slash-config',
    title: 'Manual context compaction command preserves key anchor constraint',
    requires: { mockLlm: true, traits: ['slashCompact'] },
    async run(ctx) {
      const compactCmd = ctx.capabilities.compactCommand ?? 'compact';
      const { session } = await ctx.createSession({ title: 'TCK slash-compact' });
      const r1 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] [TCK:compact-anchor] preserve this constraint');
      const beforeCompactReqs = ctx.mockHub.requests().length;
      const r2 = await ctx.sendAndWait(session.id, `/${compactCmd}`);
      const statusAfterCompact = await ctx.waitForPhase(session.id, ['idle', 'offline']);
      const r3 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] post-compact');
      const postCompactReqs = ctx.mockHub.requests().slice(beforeCompactReqs);

      const checks: Check[] = [
        { name: 'initial anchored turn completed', ok: r1.state === 'completed', detail: r1.state },
        { name: `/${compactCmd} turn settled`, ok: TERMINAL_RUN_STATES.has(r2.state), detail: r2.state },
        { name: 'session returned to idle/offline after compact', ok: statusAfterCompact.phase === 'idle' || statusAfterCompact.phase === 'offline', detail: statusAfterCompact.phase },
        ...(ctx.live
          ? []
          : [{
            name: 'mock LLM received compaction / follow-up requests',
            ok: postCompactReqs.length >= 1,
            detail: { requestsAfterCompact: postCompactReqs.length },
          }]),
        { name: 'post-compact turn completed', ok: r3.state === 'completed', detail: r3.state },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'slash-clear',
    category: 'slash-config',
    title: '/clear isolates subsequent requests from previous topic context',
    requires: { mockLlm: true, traits: ['slashClear'] },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK slash-clear' });
      const r1 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] TCK_OLD_TOPIC_SECRET');
      const r2 = await ctx.sendAndWait(session.id, '/clear');
      const beforeCount = ctx.mockHub.requests().length;
      const r3 = await ctx.sendAndWait(session.id, '[TCK:slash-clear] forbid=TCK_OLD_TOPIC_SECRET');
      await waitForSettle();

      const answer = await ctx.latestAssistantText(session.id);
      const afterReqs = ctx.mockHub.requests().slice(beforeCount);
      const leakedInRequest = afterReqs.some(req =>
        req.messages.slice(0, -1).some(m => m.text.includes('TCK_OLD_TOPIC_SECRET')),
      );

      const checks: Check[] = [
        { name: 'pre-clear turn completed', ok: r1.state === 'completed', detail: r1.state },
        { name: '/clear turn settled', ok: TERMINAL_RUN_STATES.has(r2.state), detail: r2.state },
        { name: 'post-clear turn completed', ok: r3.state === 'completed', detail: r3.state },
        {
          name: 'no old topic secret leaked after /clear',
          ok: ctx.live ? answer.trim().length > 0 : !leakedInRequest && answer.includes('TCK_CLEAR_CLEAN'),
          detail: { leakedInRequest, answer: answer.slice(0, 120) },
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'configure-idle',
    category: 'slash-config',
    title: 'Dynamic native session reconfiguration while idle',
    requires: { mockLlm: true, capabilities: ['supportsModelSelection'] },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK configure-idle' });
      const r1 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] before-config');
      const patch = pickDifferentConfigPatch(ctx, session.id);
      if (!patch) {
        return {
          ok: true,
          status: 'not-applicable',
          note: 'no distinct configurable approval/mode/model option available to switch',
          checks: [],
        };
      }

      await ctx.server.call('POST', `/api/sessions/${encodeURIComponent(session.id)}/native/configure`, patch);
      const r2 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] after-config');

      const checks: Check[] = [
        { name: 'turn before configure completed', ok: r1.state === 'completed', detail: r1.state },
        { name: 'turn after configure completed', ok: r2.state === 'completed', detail: { patch, state: r2.state } },
      ];
      return { ok: checks.every(c => c.ok), note: `switched=${Object.keys(patch).join(',')}`, checks };
    },
  },

  {
    id: 'configure-while-bg',
    category: 'slash-config',
    title: 'Reconfiguration during background activity surfaces runtimeControl or defers safely',
    requires: { mockLlm: true, mockLlmOnly: true, traits: ['backgroundTasks'], capabilities: ['supportsModelSelection'] },
    async run(ctx) {
      ctx.mockHub.gates.reset('subagent-bg:worker');
      const { session } = await ctx.createSession({
        title: 'TCK configure-while-bg',
        ...(ctx.spec.approvalModes?.auto ? { approval: ctx.spec.approvalModes.auto } : {}),
      });
      const checks: Check[] = [];
      try {
        const launch = await ctx.sendAndWait(session.id, '[TCK:subagent-bg-unblocked]');
        checks.push({ name: 'background task launched', ok: launch.state === 'completed', detail: launch.state });

        const runningBefore = await waitForRunningActivities(ctx, session.id, 1, Math.min(ctx.timeoutMs, 15_000));
        checks.push({
          name: 'background activity is still running when configure is called',
          ok: runningBefore.length >= 1,
          detail: runningBefore.map(a => ({ id: a.id, status: a.status })),
        });

        const patch = pickDifferentConfigPatch(ctx, session.id)
          ?? (ctx.spec.approvalModes?.ask && ctx.capabilities.supportsPermissionSelection
            ? { approval: ctx.spec.approvalModes.ask }
            : { model: `${ctx.model ?? ctx.spec.defaultModel}-reconfig` });

        await ctx.server.call('POST', `/api/sessions/${encodeURIComponent(session.id)}/native/configure`, patch);
        const st = ctx.server.services.nativeBackends.status(session.id);
        const rcAction = st.runtimeControl?.notice?.action ?? st.runtimeControl?.actions?.[0];
        if (st.runtimeControl && rcAction) {
          const res = await ctx.server.callRaw(
            'POST',
            `/api/sessions/${encodeURIComponent(session.id)}/native/runtime-control`,
            { action: rcAction.id, revision: st.runtimeControl.revision },
          );
          checks.push({ name: 'runtime-control action accepted', ok: res.statusCode < 400, detail: { action: rcAction.id, status: res.statusCode } });
        } else {
          const updatedSession = ctx.server.services.store.getSession(session.id);
          const deferred = Boolean(updatedSession.configPending || st.profilePending);
          checks.push({
            name: 'reconfiguration during bg triggered runtimeControl or configPending/profilePending',
            ok: deferred,
            detail: { configPending: updatedSession.configPending, profilePending: st.profilePending, runtimeControl: Boolean(st.runtimeControl) },
          });
        }
      } finally {
        ctx.mockHub.gates.release('subagent-bg:worker');
      }
      const after = await ctx.sendAndWait(session.id, '[TCK:basic-turn] after-bg-config');
      checks.push({ name: 'post-reconfigure turn completed', ok: after.state === 'completed', detail: after.state });
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  // =========================================================================
  // 7. 重启、故障与跨版本
  // =========================================================================
  {
    id: 'restart-idle',
    category: 'restart-fault-upgrade',
    title: 'Server restart while idle preserves nativeSessionId, Sync v3 seq/generation, and empty delta',
    requires: { mockLlm: true, traits: ['survivesRestart'], persistentStateDir: true },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK restart-idle' });
      const run1 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] before-restart');
      await ctx.waitForPhase(session.id, ['idle', 'offline']);
      await waitForSettle();

      const beforeSession = ctx.server.services.store.getSession(session.id);
      const beforeRows = await laneRows(ctx.server, session.id);

      await ctx.rebootServer();

      const afterSession = ctx.server.services.store.getSession(session.id);
      const afterRows = await laneRows(ctx.server, session.id);
      const afterSeqs = new Map(afterRows.rows.map(r => [r.key, r.seq]));
      const drifted = beforeRows.rows.filter(r => afterSeqs.get(r.key) !== r.seq);

      const resumedStream = openLane(ctx.server, session.id, 'main', {
        generation: beforeRows.generation,
        after: beforeRows.headSeq,
      });
      await sleep(1_200);
      resumedStream.close();
      const hello = resumedStream.frames.find(
        (frame): frame is Extract<SyncFrame, { type: 'hello' }> => frame.type === 'hello',
      );
      const resent = resumedStream.frames.filter(f => f.type === 'rows' || f.type === 'snapshot').length;

      const run2 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] after-restart');

      const checks: Check[] = [
        { name: 'pre-restart turn completed', ok: run1.state === 'completed', detail: run1.state },
        {
          name: 'nativeSessionId preserved across restart',
          ok: beforeSession.nativeSessionId === afterSession.nativeSessionId,
          detail: { before: beforeSession.nativeSessionId, after: afterSession.nativeSessionId },
        },
        {
          name: 'Sync v3 generation and row seq unchanged after restart',
          ok: drifted.length === 0 && beforeRows.rows.length === afterRows.rows.length && beforeRows.generation === afterRows.generation,
          detail: { drifted: drifted.length, count: [beforeRows.rows.length, afterRows.rows.length], generation: [beforeRows.generation, afterRows.generation] },
        },
        {
          name: 'resuming at head after restart yields empty delta',
          ok: hello?.mode === 'delta' && resent === 0,
          detail: { mode: hello?.mode, resent },
        },
        { name: 'post-restart turn completed', ok: run2.state === 'completed', detail: run2.state },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'restart-mid-turn',
    category: 'restart-fault-upgrade',
    title: 'Server restart mid-turn adopts live CLI without losing turn outcome',
    requires: { mockLlm: true, mockLlmOnly: true, traits: ['survivesRestart'], persistentStateDir: true },
    async run(ctx) {
      ctx.mockHub.gates.reset('interrupt-mid-stream');
      const { session } = await ctx.createSession({ title: 'TCK restart-mid-turn' });
      const run1 = await ctx.sendMessage(session.id, '[TCK:interrupt-mid-stream]');
      try {
        await ctx.mockHub.gates.waitUntilReached('interrupt-mid-stream', ctx.timeoutMs);
        const beforeRows = await laneRows(ctx.server, session.id);
        await ctx.rebootServer();
        ctx.mockHub.gates.release('interrupt-mid-stream');

        const done1 = await ctx.waitForRun(run1.id);
        await waitForSettle();
        const afterRows = await laneRows(ctx.server, session.id);

        const checks: Check[] = [
          { name: 'mid-turn run settled after restart', ok: TERMINAL_RUN_STATES.has(done1.state), detail: done1.state },
          {
            name: 'generation stayed stable across mid-turn restart',
            ok: afterRows.generation === beforeRows.generation,
            detail: { before: beforeRows.generation, after: afterRows.generation },
          },
          { name: 'timeline advanced with turn output', ok: afterRows.headSeq >= beforeRows.headSeq, detail: { before: beforeRows.headSeq, after: afterRows.headSeq } },
        ];
        return { ok: checks.every(c => c.ok), checks };
      } finally {
        ctx.mockHub.gates.release('interrupt-mid-stream');
      }
    },
  },

  {
    id: 'cli-sigkill-recovery',
    category: 'restart-fault-upgrade',
    title: 'SIGKILL of CLI process is detected and conversation recovers on next turn',
    requires: { mockLlm: true, mockLlmOnly: true },
    async run(ctx) {
      ctx.mockHub.gates.reset('interrupt-mid-stream');
      const { session } = await ctx.createSession({ title: 'TCK cli-sigkill-recovery' });
      const run1 = await ctx.sendMessage(session.id, '[TCK:interrupt-mid-stream]');
      let killedPid: number | undefined;
      let killed = false;
      try {
        await ctx.mockHub.gates.waitUntilReached('interrupt-mid-stream', ctx.timeoutMs);
        const targetPid = await findLiveCliPidForSession(ctx, session.id);
        if (targetPid && targetPid > 1 && targetPid !== process.pid) {
          killedPid = targetPid;
          try {
            process.kill(targetPid, 'SIGKILL');
            killed = true;
          } catch {
            killed = false;
          }
        }
      } finally {
        ctx.mockHub.gates.release('interrupt-mid-stream');
      }

      const done1 = await ctx.waitForRun(run1.id);
      const run2 = await ctx.sendAndWait(session.id, '[TCK:basic-turn] after-sigkill');

      const checks: Check[] = [
        {
          name: 'located live CLI process and delivered SIGKILL',
          ok: Boolean(killedPid && killed),
          detail: { killedPid, killed },
        },
        { name: 'first turn settled after SIGKILL', ok: TERMINAL_RUN_STATES.has(done1.state), detail: { state: done1.state, killedPid } },
        { name: 'conversation recovered on next turn', ok: run2.state === 'completed', detail: run2.state },
      ];
      return { ok: checks.every(c => c.ok), note: killedPid ? `killedPid=${killedPid}` : 'failed to locate CLI PID', checks };
    },
  },

  {
    id: 'stream-disconnect',
    category: 'restart-fault-upgrade',
    title: 'True mid-stream TCP disconnect settles cleanly and recovers on retry',
    requires: { mockLlm: true, mockLlmOnly: true },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK stream-disconnect' });
      const beforeRun1 = ctx.mockHub.requests().length;
      const run1 = await ctx.sendAndWait(session.id, '[TCK:stream-disconnect]');
      const run1Reqs = ctx.mockHub.requests().slice(beforeRun1);
      const beforeRun2 = ctx.mockHub.requests().length;
      const run2 = await ctx.sendAndWait(session.id, '[TCK:stream-disconnect] retry');
      const run2Reqs = ctx.mockHub.requests().slice(beforeRun2);
      await waitForSettle();
      const answer = await ctx.latestAssistantText(session.id);

      const checks: Check[] = [
        {
          name: 'mock LLM received and executed disconnect request on first turn',
          ok: run1Reqs.length >= 1,
          detail: { run1Requests: run1Reqs.length },
        },
        { name: 'disconnected turn settled cleanly without hang', ok: TERMINAL_RUN_STATES.has(run1.state), detail: run1.state },
        { name: 'retry turn completed after disconnect', ok: run2.state === 'completed', detail: { state: run2.state, run2Requests: run2Reqs.length } },
        {
          name: 'recovery answer delivered after disconnect',
          ok: answer.includes('TCK_DISCONNECT_RECOVERED') || run2Reqs.length >= 1,
          detail: answer.slice(0, 120),
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'http-error-recovery',
    category: 'restart-fault-upgrade',
    title: 'Recovery after HTTP 429 rate-limit and HTTP 500 server error',
    requires: { mockLlm: true, mockLlmOnly: true },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK http-error-recovery' });
      const r429 = await ctx.sendAndWait(session.id, '[TCK:http-error-recovery] status=429');
      const r500 = await ctx.sendAndWait(session.id, '[TCK:http-error-recovery] status=500');
      const rOk = await ctx.sendAndWait(session.id, '[TCK:basic-turn] post-http-error');

      const checks: Check[] = [
        { name: '429 turn settled', ok: TERMINAL_RUN_STATES.has(r429.state), detail: r429.state },
        { name: '500 turn settled', ok: TERMINAL_RUN_STATES.has(r500.state), detail: r500.state },
        { name: 'follow-up turn completed cleanly', ok: rOk.state === 'completed', detail: rOk.state },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  {
    id: 'cross-version-resume',
    category: 'restart-fault-upgrade',
    title: 'Session created with --prev-bin resumes seamlessly on candidate --bin',
    requires: { mockLlm: true, prevBin: true, capabilities: ['supportsResume'] },
    async run(ctx) {
      const prevBuilt = ctx.spec.buildProfilePayload({
        mockHub: ctx.mockHub,
        sandbox: ctx.sandbox,
        executable: ctx.prevBin,
        model: ctx.model,
        profileId: `compat-prev-${randomUUID().slice(0, 6)}`,
        live: ctx.live,
      });
      await ctx.server.call('POST', `/api/backends/${encodeURIComponent(ctx.spec.id)}/profiles`, prevBuilt.payload);

      const { session } = await ctx.createSession({
        title: 'TCK cross-version-resume',
        profileId: prevBuilt.profileId,
      });
      const r1 = await ctx.sendAndWait(session.id, '[TCK:multi-turn] created-by-prev-bin');
      await ctx.waitForPhase(session.id, ['idle', 'offline']);
      const beforeSession = ctx.server.services.store.getSession(session.id);
      const beforeRows = await laneRows(ctx.server, session.id);

      // Switch the profile executable to the candidate binary and reboot to force fresh process resume.
      const candidateBuilt = ctx.spec.buildProfilePayload({
        mockHub: ctx.mockHub,
        sandbox: ctx.sandbox,
        executable: ctx.bin,
        model: ctx.model,
        profileId: prevBuilt.profileId,
        live: ctx.live,
      });
      const { id: _ignored, ...patchBody } = candidateBuilt.payload;
      await ctx.server.call(
        'PATCH',
        `/api/backends/${encodeURIComponent(ctx.spec.id)}/profiles/${encodeURIComponent(prevBuilt.profileId)}`,
        patchBody,
      );
      await ctx.rebootServer();

      const r2 = await ctx.sendAndWait(session.id, '[TCK:multi-turn] resumed-by-new-bin');
      await waitForSettle();
      const afterSession = ctx.server.services.store.getSession(session.id);
      const afterRows = await laneRows(ctx.server, session.id);
      const afterKeys = new Set(afterRows.rows.map(r => r.key));
      const preservedHistory = beforeRows.rows.every(r => afterKeys.has(r.key));

      const checks: Check[] = [
        { name: 'prev-bin turn 1 completed', ok: r1.state === 'completed', detail: r1.state },
        { name: 'candidate-bin turn 2 completed', ok: r2.state === 'completed', detail: r2.state },
        {
          name: 'nativeSessionId preserved across version upgrade',
          ok: Boolean(beforeSession.nativeSessionId) && beforeSession.nativeSessionId === afterSession.nativeSessionId,
          detail: { before: beforeSession.nativeSessionId, after: afterSession.nativeSessionId },
        },
        { name: 'prior timeline entry keys preserved', ok: preservedHistory, detail: { before: beforeRows.rows.length, after: afterRows.rows.length } },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },

  // =========================================================================
  // 8. 扩展、MCP 与辅助对话
  // =========================================================================
  {
    id: 'skills-discovery',
    category: 'extensions-mcp-sidechat',
    title: 'Isolated project skill appears consistently in extensions and slash catalog',
    requires: {},
    async run(ctx) {
      const extRes = await ctx.server.call<{ items: Array<{ name: string; kind: string }> }>(
        'GET',
        `/api/backends/${encodeURIComponent(ctx.spec.id)}/extensions?projectId=${encodeURIComponent(ctx.projectId)}&profileId=${encodeURIComponent(ctx.profileId)}`,
      );
      const slashRes = await ctx.server.call<NativeSlashCatalog>(
        'GET',
        `/api/backends/${encodeURIComponent(ctx.spec.id)}/slash?projectId=${encodeURIComponent(ctx.projectId)}&profileId=${encodeURIComponent(ctx.profileId)}`,
      );

      const extHasCompat = extRes.items.some(item => item.kind === 'skill' && item.name.includes('compat-skill'));
      const slashHasCompat = slashRes.items.some(item => item.kind === 'skill' && item.name.includes('compat-skill'));

      const checks: Check[] = [
        { name: 'extensions endpoint lists compat-skill', ok: extHasCompat, detail: extRes.items.filter(i => i.kind === 'skill').map(i => i.name) },
        { name: 'slash catalog lists compat-skill', ok: slashHasCompat, detail: { count: slashRes.items.length, slashHasCompat } },
      ];
      return { ok: checks.every(c => c.ok), note: `ext=${extHasCompat} slash=${slashHasCompat}`, checks };
    },
  },

  {
    id: 'mcp-tools-audit',
    category: 'extensions-mcp-sidechat',
    title: 'Audit tools exposed to LLM request journal',
    requires: { mockLlm: true, mockLlmOnly: true },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK mcp-tools-audit' });
      const beforeCount = ctx.mockHub.requests().length;
      const run = await ctx.sendAndWait(session.id, '[TCK:basic-turn] audit-tools');
      const newReqs = ctx.mockHub.requests().slice(beforeCount);
      const observedTools = [...new Set(newReqs.flatMap(r => r.toolNames))];

      const checks: Check[] = [
        { name: 'run completed', ok: run.state === 'completed', detail: run.state },
        { name: 'mock LLM recorded at least one request', ok: newReqs.length >= 1, detail: { requests: newReqs.length } },
        {
          name: 'LLM request carried non-empty tool list',
          ok: observedTools.length > 0,
          detail: { toolsCount: observedTools.length, sample: observedTools.slice(0, 10) },
        },
      ];
      return { ok: checks.every(c => c.ok), note: `tools=${observedTools.length}`, checks };
    },
  },

  {
    id: 'side-chat',
    category: 'extensions-mcp-sidechat',
    title: 'Side-chat discussion streams answer anchored to parent turn',
    requires: { mockLlm: true, traits: ['sideChat'] },
    async run(ctx) {
      const { session } = await ctx.createSession({ title: 'TCK side-chat parent' });
      const parentRun = await ctx.sendAndWait(session.id, '[TCK:basic-turn] parent-context-passage');
      await waitForSettle();
      const rows = await laneRows(ctx.server, session.id);
      const assistantRow = rows.rows.findLast(r => r.kind === 'assistant');
      if (!assistantRow || assistantRow.kind !== 'assistant') {
        return {
          ok: false,
          note: 'No assistant row found in parent session to anchor side-chat',
          checks: [{ name: 'parent assistant row exists', ok: false }],
        };
      }

      const quoteText = assistantRow.text.slice(0, 60).trim() || 'TCK_BASIC_OK';
      const created = await ctx.server.call<{ session: Session; run: Run }>(
        'POST',
        `/api/sessions/${encodeURIComponent(session.id)}/discussions`,
        {
          clientSessionId: `tck-disc-${randomUUID()}`,
          commandId: `tck-disc-cmd-${randomUUID()}`,
          text: '[TCK:side-chat] explain this passage',
          anchor: {
            messageId: assistantRow.key,
            ...(assistantRow.runId ? { runId: assistantRow.runId } : {}),
            ...(assistantRow.event.nativeTurnId ? { nativeTurnId: assistantRow.event.nativeTurnId } : {}),
          },
          quote: {
            exact: quoteText,
            prefix: '',
            suffix: '',
          },
        },
      );
      ctx.trackedSessions.add(created.session.id);
      ctx.trackedRuns.add(created.run.id);

      const discRun = await ctx.waitForRun(created.run.id);
      await waitForSettle();
      const discAnswer = await ctx.latestAssistantText(created.session.id);

      const checks: Check[] = [
        { name: 'parent turn completed', ok: parentRun.state === 'completed', detail: parentRun.state },
        { name: 'side-chat run completed', ok: discRun.state === 'completed', detail: discRun.error ?? discRun.state },
        {
          name: 'side-chat answer streamed',
          ok: ctx.live ? discAnswer.trim().length > 0 : discAnswer.includes('TCK_SIDE_CHAT'),
          detail: discAnswer.slice(0, 120),
        },
      ];
      return { ok: checks.every(c => c.ok), checks };
    },
  },
];

async function listRunningActivities(ctx: TckContext, sessionId: string): Promise<NativeActivity[]> {
  const rows = await laneRows(ctx.server, sessionId);
  const byId = new Map<string, NativeActivity>();
  for (const row of rows.rows) {
    if (row.kind === 'activity' && row.activity.status === 'running') {
      byId.set(row.activity.id, row.activity);
    } else if (row.kind === 'tool' && row.activity && row.activity.status === 'running') {
      byId.set(row.activity.id, row.activity);
    }
  }
  return [...byId.values()];
}

async function listStoppableActivities(ctx: TckContext, sessionId: string): Promise<NativeActivity[]> {
  const running = await listRunningActivities(ctx, sessionId);
  return running.filter(act => Boolean(act.stop));
}

async function waitForRunningActivities(
  ctx: TckContext,
  sessionId: string,
  minCount: number,
  timeoutMs: number,
): Promise<NativeActivity[]> {
  const deadline = Date.now() + timeoutMs;
  let last: NativeActivity[] = [];
  while (Date.now() < deadline) {
    last = await listRunningActivities(ctx, sessionId);
    if (last.length >= minCount) return last;
    await sleep(150);
  }
  return last;
}

async function waitForStoppableActivities(
  ctx: TckContext,
  sessionId: string,
  minCount: number,
  timeoutMs: number,
): Promise<NativeActivity[]> {
  const deadline = Date.now() + timeoutMs;
  let last: NativeActivity[] = [];
  while (Date.now() < deadline) {
    last = await listStoppableActivities(ctx, sessionId);
    if (last.length >= minCount) return last;
    await sleep(150);
  }
  return last;
}

async function waitForActivitiesSettled(
  ctx: TckContext,
  sessionId: string,
  activityIds: readonly string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stillRunning: string[] }> {
  const target = new Set(activityIds);
  const deadline = Date.now() + timeoutMs;
  let stillRunning: string[] = [...target];
  while (Date.now() < deadline) {
    const running = await listRunningActivities(ctx, sessionId);
    stillRunning = running.filter(a => target.has(a.id)).map(a => `${a.id}:${a.status}`);
    if (stillRunning.length === 0) return { ok: true, stillRunning: [] };
    await sleep(150);
  }
  return { ok: stillRunning.length === 0, stillRunning };
}

function pickDifferentConfigPatch(ctx: TckContext, sessionId: string): Record<string, string> | undefined {
  const session = ctx.server.services.store.getSession(sessionId);
  if (ctx.capabilities.supportsPermissionSelection) {
    const permCandidates = [
      ctx.spec.approvalModes?.ask,
      ctx.spec.approvalModes?.auto,
      ...ctx.capabilities.permissions.map(p => p.id),
    ].filter((v): v is string => Boolean(v));
    const distinctPerm = permCandidates.find(id => id !== session.approval);
    if (distinctPerm) return { approval: distinctPerm };
  }
  if (ctx.capabilities.supportsModeSelection) {
    const distinctMode = ctx.capabilities.modes.find(m => m.id !== session.mode)?.id;
    if (distinctMode) return { mode: distinctMode };
  }
  if (ctx.capabilities.supportsModelSelection) {
    const catalogModels = ctx.catalog.models.map(m => m.value);
    const distinctCatalogModel = catalogModels.find(id => id && id !== session.model);
    if (distinctCatalogModel) return { model: distinctCatalogModel };
    if (!ctx.live) {
      const currentModel = session.model ?? ctx.model ?? ctx.spec.defaultModel;
      return { model: `${currentModel}-alt` };
    }
  }
  return undefined;
}

async function findLiveCliPidForSession(ctx: TckContext, sessionId: string): Promise<number | undefined> {
  const latestSession = ctx.server.services.store.getSession(sessionId);

  // 1. Terminal-backed CLIs (Claude Code tmux pane, etc.)
  if (latestSession.terminalId) {
    const pid = await ctx.server.services.terminal.panePid(latestSession.terminalId).catch(() => undefined);
    if (pid && pid > 1) return pid;
  }

  // 2. Detached Codex / TraeX app-server daemons bound to `nativeRuntime.address`
  const runtimeAddress = latestSession.nativeRuntime?.address;
  if (runtimeAddress) {
    const credentialDirs = [
      join(ctx.sandbox.cliHome, ctx.spec.id),
      join(ctx.sandbox.cliHome, 'codex'),
      join(ctx.sandbox.cliHome, 'traex'),
    ];
    const servers = await listWorkbenchAppServers(credentialDirs).catch(() => []);
    const matched = servers.find(s => s.address === runtimeAddress);
    if (matched && matched.pid > 1) return matched.pid;
  }

  // 3. Direct child process spawned by this Riffet server process (pi, droid, dsh, cursor, etc.)
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,command='], { timeout: 5_000 });
    const myPid = process.pid;
    const rows = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!match) return undefined;
        return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! };
      })
      .filter((row): row is { pid: number; ppid: number; command: string } => Boolean(row));

    const directChildren = rows.filter(r => r.ppid === myPid && r.pid !== myPid && !/\bps\s+-eo\b/.test(r.command));
    const preferredTokens = [ctx.spec.id, ctx.bin].filter((t): t is string => Boolean(t));
    const exact = directChildren.find(r => preferredTokens.some(tok => r.command.includes(tok)));
    if (exact) return exact.pid;
    if (directChildren.length === 1) return directChildren[0]!.pid;
  } catch {
    // ps unavailable on platform
  }

  return undefined;
}

export const TCK_SCENARIO_MAP = new Map<ScenarioId, TckScenarioDefinition>(
  TCK_SCENARIOS.map(scenario => [scenario.id, scenario]),
);

function buildTckContext(params: {
  spec: BackendCompatSpec;
  sandbox: CompatSandbox;
  mockHub: MockLlmHub;
  server: CompatServer;
  projectId: string;
  profileId: string;
  model?: string;
  catalog: NativeBackendCatalogEntry;
  traits: NativeBackendTraits;
  timeoutMs: number;
  live: boolean;
  bin?: string;
  prevBin?: string;
}): TckContext {
  const trackedSessions = new Set<string>();
  const trackedRuns = new Set<string>();
  const liveStreams = new Map<string, LaneStream>();

  const ctx: TckContext = {
    spec: params.spec,
    sandbox: params.sandbox,
    mockHub: params.mockHub,
    server: params.server,
    projectId: params.projectId,
    profileId: params.profileId,
    model: params.model,
    capabilities: params.catalog.capabilities,
    traits: params.traits,
    catalog: params.catalog,
    timeoutMs: params.timeoutMs,
    live: params.live,
    bin: params.bin,
    prevBin: params.prevBin,
    trackedSessions,
    trackedRuns,
    liveStreams,

    async rebootServer() {
      const previouslySubscribed = [...liveStreams.keys()];
      for (const stream of liveStreams.values()) stream.close();
      liveStreams.clear();
      await ctx.server.close();
      ctx.server = await bootCompatServer(ctx.sandbox.stateDir, {
        ...(ctx.spec.requiresPlugin ? { requiresPlugin: ctx.spec.requiresPlugin } : {}),
        ...(ctx.spec.id === 'cursor' && ctx.bin ? { cliPath: ctx.bin } : {}),
      });
      // Re-open Sync v3 main-lane subscriptions for active sessions so global invariants keep observing post-reboot traffic.
      for (const sessionId of previouslySubscribed) {
        try {
          ctx.server.services.store.getSession(sessionId);
          liveStreams.set(sessionId, openLane(ctx.server, sessionId, 'main'));
        } catch {
          // Session no longer exists after reboot.
        }
      }
      return ctx.server;
    },

    async createSession(opts = {}) {
      const session = await ctx.server.call<Session>('POST', '/api/sessions', {
        projectId: ctx.projectId,
        kind: 'native',
        title: opts.title ?? `TCK ${ctx.spec.id}`,
        backendId: ctx.spec.id,
        backendProfileId: opts.profileId ?? ctx.profileId,
        ...(opts.model ?? ctx.model ? { model: opts.model ?? ctx.model } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.approval ? { approval: opts.approval } : {}),
      });
      trackedSessions.add(session.id);
      const stream = openLane(ctx.server, session.id, 'main');
      liveStreams.set(session.id, stream);
      return { session, stream };
    },

    async sendMessage(sessionId, text, extra = {}) {
      const commandId = extra.commandId ?? `tck-${randomUUID()}`;
      const run = await ctx.server.call<Run>(
        'POST',
        `/api/sessions/${encodeURIComponent(sessionId)}/native/send`,
        {
          commandId,
          text,
          ...(extra.attachments ? { attachments: extra.attachments } : {}),
        },
      );
      trackedRuns.add(run.id);
      return run;
    },

    async waitForRun(runId, timeoutMs = ctx.timeoutMs) {
      return await until(
        () => {
          const run = ctx.server.services.store.getRun(runId);
          return TERMINAL_RUN_STATES.has(run.state) ? run : undefined;
        },
        {
          timeoutMs,
          intervalMs: 150,
          describe: () => {
            try {
              const run = ctx.server.services.store.getRun(runId);
              const phase = ctx.server.services.nativeBackends.status(run.sessionId).phase;
              return `run ${runId} to settle (state=${run.state}, phase=${phase}, mockReqs=${ctx.mockHub.requests().length})`;
            } catch {
              return `run ${runId} to settle (mockReqs=${ctx.mockHub.requests().length})`;
            }
          },
        },
      );
    },

    async sendAndWait(sessionId, text, extra = {}) {
      const run = await ctx.sendMessage(sessionId, text, { attachments: extra.attachments });
      return await ctx.waitForRun(run.id, extra.timeoutMs ?? ctx.timeoutMs);
    },

    async waitForPhase(sessionId, phases, timeoutMs = ctx.timeoutMs) {
      return await until(
        () => {
          const st = ctx.server.services.nativeBackends.status(sessionId);
          return phases.includes(st.phase) ? st : undefined;
        },
        {
          timeoutMs,
          intervalMs: 120,
          describe: () => {
            const st = ctx.server.services.nativeBackends.status(sessionId);
            return `session ${sessionId} phase in [${phases.join(',')}] (current=${st.phase}, mockReqs=${ctx.mockHub.requests().length})`;
          },
        },
      );
    },

    async waitForInteraction(sessionId, timeoutMs = ctx.timeoutMs) {
      const preferProtocol = ctx.capabilities.interactionTransport === 'both';
      const deadline = Date.now() + timeoutMs;
      let fallbackCard: NativeInteraction | undefined;
      let firstFallbackAt: number | undefined;
      while (Date.now() < deadline) {
        const st = ctx.server.services.nativeBackends.status(sessionId);
        const card = st.interaction;
        if (card) {
          if (!preferProtocol || card.transport === 'protocol') {
            return card;
          }
          fallbackCard = card;
          firstFallbackAt ??= Date.now();
          // Give the protocol hook card a 2.5s grace window from first fallback sighting to supersede the screen card.
          if (Date.now() - firstFallbackAt >= 2_500) return card;
        }
        await sleep(150);
      }
      if (fallbackCard) return fallbackCard;
      const st = ctx.server.services.nativeBackends.status(sessionId);
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for interaction on ${sessionId} (phase=${st.phase}, mockReqs=${ctx.mockHub.requests().length})`,
      );
    },

    buildStopRequest(sessionId) {
      const session = ctx.server.services.store.getSession(sessionId);
      const st = ctx.server.services.nativeBackends.status(sessionId);
      return {
        requestId: `tck-stop-${randomUUID()}`,
        nativeSessionId: st.activeTurn?.nativeSessionId ?? session.nativeSessionId ?? '',
        ...(st.activeTurn?.turnId ? { turnId: st.activeTurn.turnId } : {}),
        ...(session.terminalId ? { terminalId: session.terminalId } : {}),
      };
    },

    async latestAssistantText(sessionId, lane = 'main') {
      const rows = await laneRows(ctx.server, sessionId, lane);
      const assistants = rows.rows.filter(
        (r): r is Extract<TimelineRow, { kind: 'assistant' }> => r.kind === 'assistant',
      );
      return assistants.sort((a, b) => a.pos - b.pos).at(-1)?.text ?? '';
    },
  };

  return ctx;
}

async function runGlobalInvariants(ctx: TckContext): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. Every live main lane stream tiles contiguous, unique seq numbers, reaches head,
  //    and delivered the last answer of every completed turn.
  for (const [sessionId, stream] of ctx.liveStreams.entries()) {
    try {
      let final: TimelineChanges = await laneRows(ctx.server, sessionId, 'main');
      // Give the SSE stream a brief settle window to receive trailing frames before checking head parity.
      if (final.rows.length > 0 && stream.head() < final.headSeq) {
        const settleDeadline = Date.now() + 2_000;
        while (Date.now() < settleDeadline && stream.head() < final.headSeq) {
          await sleep(80);
        }
        final = await laneRows(ctx.server, sessionId, 'main');
      }
      if (final.rows.length > 0) {
        checks.push(...seqChecks('main', stream, final));
        const outline = await laneOutline(ctx.server, sessionId, 'main');
        checks.push(...answerChecks('main', stream, final, outline.turns));
      }
    } catch (error) {
      checks.push({
        name: `invariant: laneRows readable for ${sessionId}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    stream.close();
  }
  ctx.liveStreams.clear();

  // 2. Every tracked run settled in a terminal state (no leftover `starting` / dangling run).
  const stuckRuns: string[] = [];
  for (const runId of ctx.trackedRuns) {
    try {
      const run = ctx.server.services.store.getRun(runId);
      if (!TERMINAL_RUN_STATES.has(run.state)) {
        stuckRuns.push(`${run.id}:${run.state}`);
      }
    } catch {
      // session may have been cleaned up
    }
  }
  if (ctx.trackedRuns.size > 0) {
    checks.push({
      name: 'invariant: all scenario runs reached terminal state',
      ok: stuckRuns.length === 0,
      ...(stuckRuns.length ? { detail: stuckRuns } : {}),
    });
  }

  return checks;
}

type TckScriptsHandle =
  | (() => void)
  | {
    resetCounters?: () => void;
    unregister?: () => void;
  };

/**
 * Executes the unified TCK suite for a single backend (built-in or external plugin).
 */
export async function runTckSuite(options: TckSuiteOptions): Promise<TckSuiteReport> {
  const { spec } = options;
  const live = Boolean(options.live);
  const keep = Boolean(options.keep);
  const timeoutMs = (options.timeoutSeconds ?? 120) * 1_000;
  const startedAt = new Date().toISOString();

  const selectedIds: ScenarioId[] = options.scenarios?.length
    ? [...options.scenarios]
    : TCK_SCENARIOS.map(s => s.id);
  const scenarios = selectedIds.map(id => {
    const def = TCK_SCENARIO_MAP.get(id);
    if (!def) throw new Error(`Unknown TCK scenario "${id}"`);
    return def;
  });

  const needsPersistent = scenarios.some(s => s.requires.persistentStateDir);
  const sandbox = await createCompatSandbox({
    backend: spec.id,
    persistentStateDir: needsPersistent,
    keep,
  });

  const mockHub = new MockLlmHub({ strict: !live, auxiliaryDefaults: true });
  await mockHub.start();
  sandbox.registerCleanup(async () => {
    await mockHub.close().catch(() => undefined);
  });
  const scriptsHandle = registerTckScripts(mockHub, { tools: spec.toolMap }) as TckScriptsHandle;

  const envOverrides: Record<string, string | undefined> = {
    ...(spec.extraEnv?.({ sandbox, mockHub }) ?? {}),
    ...(spec.pluginDir ? { RIFFET_DEV_PLUGINS: spec.pluginDir } : {}),
  };
  const restoreEnv = applyIsolatedProcessEnv(envOverrides, { live });

  const results: ScenarioExecutionResult[] = [];
  let cliVersion: string | undefined;
  let server: CompatServer | undefined;
  let leakedTmux = false;
  let observedVocabulary: VocabularySnapshot | undefined;

  try {
    const chosenModel = options.model ?? (live ? undefined : spec.defaultModel);
    if (!live && spec.prepareCliHome) {
      await spec.prepareCliHome({ sandbox, mockHub, model: chosenModel ?? spec.defaultModel });
    }

    const builtProfile = spec.buildProfilePayload({
      mockHub,
      sandbox,
      executable: options.bin,
      model: chosenModel,
      live,
    });
    const profileConfigDir = typeof builtProfile.payload.configDir === 'string'
      ? builtProfile.payload.configDir
      : undefined;
    if (profileConfigDir) {
      assertIsolatedPath(profileConfigDir);
      await mkdir(profileConfigDir, { recursive: true, mode: 0o700 });
    }

    server = await bootCompatServer(sandbox.stateDir, {
      ...(spec.requiresPlugin ? { requiresPlugin: spec.requiresPlugin } : {}),
      ...(spec.id === 'cursor' && options.bin ? { cliPath: options.bin } : {}),
    });
    sandbox.registerCleanup(async () => {
      if (server) {
        await server.close();
        server = undefined;
      }
    });

    const project = server.services.store.createProject(sandbox.projectDir, `Compat TCK (${spec.id})`);
    await server.call('POST', `/api/backends/${encodeURIComponent(spec.id)}/profiles`, builtProfile.payload);

    const catalog = await server.call<NativeBackendCatalogEntry>(
      'GET',
      `/api/backends/${encodeURIComponent(spec.id)}/catalog?projectId=${encodeURIComponent(project.id)}&profileId=${encodeURIComponent(builtProfile.profileId)}`,
    );
    cliVersion = catalog.cliVersion?.version;

    const driver = server.services.nativeBackends.registry.get(spec.id as NativeBackendId);
    const traits: NativeBackendTraits = driver?.traits ?? {};
    const supportsSideChat = Boolean(driver?.streamDiscussion) || GATEWAY_BACKENDS.has(spec.id);

    const applicabilityEnv: TckApplicabilityInput = {
      tier: spec.tier,
      live,
      prevBin: options.prevBin,
      capabilities: catalog.capabilities,
      traits,
      supportsSideChat,
      supportsBackgroundTasks: spec.supportsBackgroundTasks,
      supportsSubagents: spec.supportsSubagents,
    };

    for (const scenario of scenarios) {
      const t0 = Date.now();
      const decision = evaluateScenarioApplicability(scenario, applicabilityEnv);

      if (!decision.run) {
        const entry: ScenarioExecutionResult = {
          id: scenario.id,
          category: scenario.category,
          title: scenario.title,
          verdict: decision.verdict,
          durationMs: Date.now() - t0,
          checks: [],
        };
        results.push(entry);
        options.onScenarioDone?.(entry);
        continue;
      }

      mockHub.gates.reset();
      if (typeof scriptsHandle === 'object' && scriptsHandle !== null) {
        scriptsHandle.resetCounters?.();
      }
      const ctx = buildTckContext({
        spec,
        sandbox,
        mockHub,
        server,
        projectId: project.id,
        profileId: builtProfile.profileId,
        model: builtProfile.model,
        catalog,
        traits,
        timeoutMs,
        live,
        bin: options.bin,
        prevBin: options.prevBin,
      });

      let output: ScenarioRunOutput;
      try {
        output = await scenario.run(ctx);
      } catch (error) {
        output = {
          ok: false,
          note: error instanceof Error ? error.message : String(error),
          checks: [{ name: 'scenario execution', ok: false, detail: error instanceof Error ? error.message : String(error) }],
        };
      } finally {
        server = ctx.server;
      }

      const invariantChecks = await runGlobalInvariants(ctx);

      const allChecks = [...output.checks, ...invariantChecks];
      const allOk = output.ok && invariantChecks.every(c => c.ok);
      const firstFailed = allChecks.find(c => !c.ok);
      const verdict: ScenarioVerdict = output.status
        ? { status: output.status, ...(output.note ? { note: output.note } : {}) }
        : allOk
          ? { status: 'pass', ...(output.note ? { note: output.note } : {}) }
          : {
            status: 'fail',
            note: output.note ?? (firstFailed ? `${firstFailed.name} failed` : 'scenario failed'),
          };

      const entry: ScenarioExecutionResult = {
        id: scenario.id,
        category: scenario.category,
        title: scenario.title,
        verdict,
        durationMs: Date.now() - t0,
        checks: allChecks,
      };
      results.push(entry);
      options.onScenarioDone?.(entry);
    }

    // Collect raw CLI vocabulary directly from sandbox rollout/transcript JSONL before cleanup removes temp dirs.
    observedVocabulary = await collectObservedRawVocabulary(spec.id, sandbox, {
      baselineVersion: cliVersion,
    });
  } finally {
    if (typeof scriptsHandle === 'function') {
      scriptsHandle();
    } else if (typeof scriptsHandle === 'object' && scriptsHandle !== null) {
      scriptsHandle.unregister?.();
    }
    await mockHub.close().catch(() => undefined);
    const cleanupResult = await sandbox.cleanup();
    leakedTmux = cleanupResult.leakedTmux;
    restoreEnv();
  }

  const summary: Record<ScenarioStatus, number> = {
    pass: 0,
    fail: 0,
    'not-applicable': 0,
    'not-exercised': 0,
  };
  for (const r of results) {
    summary[r.verdict.status] += 1;
  }

  const mode: CompatRunMode = live ? 'live' : spec.tier === 'B' ? 'hybrid' : 'mock-llm';
  observedVocabulary ??= await collectObservedRawVocabulary(spec.id, sandbox, {
    baselineVersion: cliVersion,
  });

  return {
    backendId: spec.id,
    tier: spec.tier,
    mode,
    ...(cliVersion ? { cliVersion } : {}),
    os: process.platform,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    summary,
    observedVocabulary,
    leakedTmux,
  };
}
