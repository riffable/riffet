import { tmpdir } from 'node:os';
import type { ModelInfo } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendProfileConfig } from '../types.js';
import type { CodexAppServerClient, CodexAppServerFactory } from '../shared/codex-app-server.js';
import { assertSupportedProfile, executableOf, providerEnv } from './config.js';
import { listModels } from './catalog.js';
import { readConfiguredMcpNames } from './extensions.js';
import type { CodexFlavor } from './flavors.js';
import { asRecord, str } from './util.js';

interface AuxiliaryContext {
  readonly flavor: CodexFlavor;
  readonly startAppServer: CodexAppServerFactory;
  /** Looked up on each call: the adapter's reader of a live or short-lived app-server. */
  withTransport<T>(project: undefined, profile: NativeBackendProfileConfig, session: undefined, read: (transport: CodexAppServerClient) => Promise<T>): Promise<T>;
}

/**
 * The model requests the workbench makes outside any conversation: listing models for a picker and
 * one-shot completions (titles, summaries, the plan helper). Each completion runs in its own
 * app-server with an ephemeral, read-only, tool-less thread. It owns the cached model list; it does
 * not own sessions or their runtimes.
 */
export class CodexAuxiliary {
  /** Cached model list from `codex app-server` for auxiliary pickers (`5m` TTL). */
  private readonly catalogs = new Map<string, { at: number; models: ModelInfo[] }>();

  constructor(private readonly ctx: AuxiliaryContext) {}

  invalidate(): void {
    this.catalogs.clear();
  }

  async models(profile: NativeBackendProfileConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
    signal?.throwIfAborted();
    const key = JSON.stringify([profile.id, executableOf(profile, this.ctx.flavor), this.ctx.flavor.stateHome(profile.config)]);
    const cached = this.catalogs.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.models;
    const models = await this.ctx.withTransport(undefined, profile, undefined, transport => listModels(transport, this.ctx.flavor));
    signal?.throwIfAborted();
    this.catalogs.set(key, { at: Date.now(), models });
    return models;
  }

  async complete(profile: NativeBackendProfileConfig, request: {
    model: string; system: string; content: string; maxOutputTokens: number; timeoutMs: number; signal?: AbortSignal;
  }): Promise<string> {
    const result = await this.run(profile, {
      model: request.model,
      system: request.system,
      prompt: request.content,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      effort: 'low',
    });
    return result.text;
  }

  async streamChat(profile: NativeBackendProfileConfig, request: {
    model: string; system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxOutputTokens: number; idleTimeoutMs: number; signal?: AbortSignal; effort?: string; fast?: boolean;
    onDelta(kind: 'text' | 'reasoning', text: string): void;
  }): Promise<{ text: string; reasoning: string; cutOff: boolean; model?: string; inputTokens?: number; outputTokens?: number }> {
    const prompt = request.messages.length <= 1
      ? request.messages[0]?.content ?? ''
      : request.messages.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.content}`).join('\n\n');
    return await this.run(profile, {
      model: request.model,
      system: request.system,
      prompt,
      timeoutMs: request.idleTimeoutMs,
      signal: request.signal,
      effort: request.effort,
      fast: request.fast,
      onDelta: request.onDelta,
    });
  }

  private async run(profile: NativeBackendProfileConfig, options: {
    model: string; system?: string; prompt: string; timeoutMs: number; signal?: AbortSignal;
    effort?: string; fast?: boolean; onDelta?: (kind: 'text' | 'reasoning', text: string) => void;
  }): Promise<{ text: string; reasoning: string; cutOff: boolean; model?: string; inputTokens?: number; outputTokens?: number }> {
    options.signal?.throwIfAborted();
    assertSupportedProfile(profile, this.ctx.flavor);
    const cwd = tmpdir();
    let threadId: string | undefined;
    let turnId: string | undefined;
    let text = '';
    let reasoning = '';
    let settled = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectDone(error); else resolveDone();
    };
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(`Codex did not complete within ${Math.round(options.timeoutMs / 1000)} s`)), options.timeoutMs);
      timer.unref?.();
    };
    const transport = await this.ctx.startAppServer({
      executable: executableOf(profile, this.ctx.flavor),
      args: [...this.ctx.flavor.args(profile.config), '-c', 'check_for_update_on_startup=false'],
      cwd,
      env: providerEnv(profile, this.ctx.flavor),
      onNotification: (method, params) => {
        const eventThread = str(params.threadId) ?? str(asRecord(params.turn)?.threadId);
        if (threadId && eventThread && eventThread !== threadId) return;
        if (method === 'item/agentMessage/delta') {
          const delta = typeof params.delta === 'string' ? params.delta : '';
          if (delta) { touch(); text += delta; options.onDelta?.('text', delta); }
        } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
          const delta = typeof params.delta === 'string' ? params.delta : '';
          if (delta) { touch(); reasoning += delta; options.onDelta?.('reasoning', delta); }
        } else if (method === 'turn/completed') {
          const turn = asRecord(params.turn);
          const completedId = str(turn?.id);
          if (turnId && completedId && completedId !== turnId) return;
          const status = str(turn?.status);
          if (status === 'failed') {
            const message = str(asRecord(turn?.error)?.message) ?? 'Codex turn failed';
            finish(new Error(message));
          } else {
            finish();
          }
        }
      },
      onServerRequest: async request => { throw new Error(`Unsupported auxiliary Codex request: ${request.method}`); },
      onExit: error => finish(error),
    });
    const onAbort = () => {
      if (threadId && turnId) void transport.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      finish(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Codex auxiliary request aborted'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    touch();
    try {
      const mcpNames = await readConfiguredMcpNames(transport, cwd).catch(() => new Set<string>());
      const threadConfig: Record<string, unknown> = {
        project_doc_max_bytes: 0,
        'features.plugins': false,
        'features.apps': false,
        'skills.bundled.enabled': false,
        ...Object.fromEntries([...mcpNames].filter(name => /^[\w-]+$/.test(name)).map(name => [`mcp_servers.${name}.enabled`, false])),
      };
      const baseInstructions = [
        options.system?.trim(),
        'Answer directly with text only. Do not run commands, read files, or call tools.',
      ].filter(Boolean).join('\n\n');
      const started = await transport.request<{ thread?: { id?: string } }>('thread/start', {
        cwd,
        model: options.model || null,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        baseInstructions,
        developerInstructions: '',
        config: threadConfig,
      });
      threadId = started.thread?.id;
      if (!threadId) throw new Error('Codex did not return a thread id');
      const turned = await transport.request<{ turn?: { id?: string }; turnId?: string }>('turn/start', {
        threadId,
        input: [{ type: 'text', text: options.prompt }],
        model: options.model || null,
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        effort: options.effort && options.effort !== 'default' ? options.effort : null,
        ...(options.fast ? { serviceTier: 'priority' } : {}),
      });
      turnId = turned.turn?.id ?? str(turned.turnId);
      await done;
      return { text, reasoning, cutOff: false, model: options.model };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      await transport.dispose().catch(() => undefined);
    }
  }
}
