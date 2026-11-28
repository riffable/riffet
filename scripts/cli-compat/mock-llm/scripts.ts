import {
  replyDisconnect,
  replyError,
  replyText,
  replyToolCall,
  routeByTag,
  type MockLlmHub,
} from './hub.js';
import type {
  MockReplySpec,
  MockRoute,
  MockToolCallSpec,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedToolResult,
} from './types.js';

export type ToolArgProfile = 'claude' | 'codex' | 'pi' | 'droid' | 'generic';

export interface TckToolMap {
  read: string;
  write: string;
  bash: string;
  subagent: string;
  askUser: string;
  argProfile?: ToolArgProfile;
}

export const DEFAULT_CLAUDE_TOOLS: TckToolMap = {
  read: 'Read',
  write: 'Write',
  bash: 'Bash',
  subagent: 'Agent',
  askUser: 'AskUserQuestion',
  argProfile: 'claude',
};

export const DEFAULT_CODEX_TOOLS: TckToolMap = {
  read: 'read_file',
  write: 'write_file',
  bash: 'exec_command',
  subagent: 'spawn_agent',
  askUser: 'request_user_input',
  argProfile: 'codex',
};

export const DEFAULT_GENERIC_TOOLS: TckToolMap = {
  read: 'read_file',
  write: 'write_file',
  bash: 'run_shell',
  subagent: 'subagent',
  askUser: 'ask_user',
  argProfile: 'generic',
};

export interface TckScriptOptions {
  tools?: Partial<TckToolMap>;
  /** Target file path used by read/write/approval scenarios. */
  workspaceFile?: string;
  /** Approval file path written on approval scenarios. */
  approvalFile?: string;
  /** Optional prefix for gate names to isolate concurrent suites. */
  gatePrefix?: string;
}

export type TckScriptsHandle = (() => void) & {
  unregister: () => void;
  resetCounters: () => void;
};

function findLastPlainUserMessageIndex(messages: NormalizedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === 'user'
      && msg.text.trim().length > 0
      && (!msg.toolResults || msg.toolResults.length === 0)
    ) {
      return i;
    }
  }
  return -1;
}

export function currentTurnToolResults(req: NormalizedRequest): NormalizedToolResult[] {
  const lastUserIdx = findLastPlainUserMessageIndex(req.messages);
  const results: NormalizedToolResult[] = [];
  for (let i = lastUserIdx + 1; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (msg.toolResults && msg.toolResults.length > 0) {
      results.push(...msg.toolResults);
    } else if (msg.role === 'tool') {
      results.push({
        toolCallId: `tool_${i}`,
        content: msg.text,
      });
    }
  }
  return results;
}

function summarizeToolResults(req: NormalizedRequest): string {
  return currentTurnToolResults(req)
    .map((tr) => `${tr.toolName ?? tr.toolCallId}(${tr.isError ? 'error' : 'ok'}):${tr.content}`)
    .join(' | ');
}

function extractArg(text: string, key: string, fallback: string): string {
  const re = new RegExp(`${key}=([^\\s\\]]+)`);
  const m = re.exec(text);
  return m ? m[1] : fallback;
}

export function hasToolResultForCurrentTurn(req: NormalizedRequest): boolean {
  const lastUserIdx = findLastPlainUserMessageIndex(req.messages);
  for (let i = lastUserIdx + 1; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (msg.role === 'tool' || (msg.toolResults && msg.toolResults.length > 0)) {
      return true;
    }
  }
  return false;
}

function resolveToolName(req: NormalizedRequest, preferred: string): string {
  if (req.toolNames.includes(preferred)) return preferred;
  const lower = preferred.toLowerCase();
  const matched = req.toolNames.find((n) => n.toLowerCase() === lower);
  return matched ?? preferred;
}

function resolveArgProfile(tools: TckToolMap, explicitTools?: Partial<TckToolMap>): ToolArgProfile {
  if (explicitTools?.argProfile) return explicitTools.argProfile;
  if (!explicitTools) return 'claude';
  if (tools.bash === 'exec_command') return 'codex';
  if (tools.read === 'read' && tools.write === 'write' && tools.bash === 'bash') return 'pi';
  if (tools.write === 'Create' || tools.bash === 'Execute') return 'droid';
  if (tools.read === 'Read' && tools.write === 'Write') return 'claude';
  return 'generic';
}

function buildReadToolCall(
  req: NormalizedRequest,
  tools: TckToolMap,
  profile: ToolArgProfile,
  id: string,
  targetFile: string,
): MockToolCallSpec {
  if (profile === 'codex') {
    return {
      id,
      name: resolveToolName(req, tools.bash),
      arguments: { cmd: `cat ${targetFile}` },
    };
  }
  if (profile === 'claude' || profile === 'droid') {
    return {
      id,
      name: resolveToolName(req, tools.read),
      arguments: { file_path: targetFile },
    };
  }
  return {
    id,
    name: resolveToolName(req, tools.read),
    arguments: { path: targetFile },
  };
}

function buildWriteToolCall(
  req: NormalizedRequest,
  tools: TckToolMap,
  profile: ToolArgProfile,
  id: string,
  targetFile: string,
): MockToolCallSpec {
  if (profile === 'codex') {
    return {
      id,
      name: resolveToolName(req, tools.bash),
      arguments: {
        cmd: `printf 'hi\\n' > ${targetFile}`,
        sandbox_permissions: 'require_escalated',
        justification: `May I create ${targetFile} in this isolated test workspace?`,
      },
    };
  }
  if (profile === 'claude' || profile === 'droid') {
    return {
      id,
      name: resolveToolName(req, tools.write),
      arguments: { file_path: targetFile, content: 'hi\n' },
    };
  }
  return {
    id,
    name: resolveToolName(req, tools.write),
    arguments: { path: targetFile, content: 'hi\n' },
  };
}

function buildBashToolCall(
  req: NormalizedRequest,
  tools: TckToolMap,
  profile: ToolArgProfile,
  id: string,
  cmd: string,
  extra?: { description?: string; runInBackground?: boolean },
): MockToolCallSpec {
  const name = resolveToolName(req, tools.bash);
  if (profile === 'codex') {
    return {
      id,
      name,
      arguments: { cmd },
    };
  }
  if (profile === 'claude') {
    return {
      id,
      name,
      arguments: {
        command: cmd,
        ...(extra?.description ? { description: extra.description } : {}),
        ...(extra?.runInBackground ? { run_in_background: true } : {}),
      },
    };
  }
  return {
    id,
    name,
    arguments: { command: cmd },
  };
}

/**
 * Registers the standard deterministic TCK scenario routes on a `MockLlmHub`.
 * Returns a callable unregister handle with `resetCounters()` and `unregister()`.
 */
export function registerTckScripts(
  hub: MockLlmHub,
  options?: TckScriptOptions,
): TckScriptsHandle {
  const tools: TckToolMap = {
    ...DEFAULT_CLAUDE_TOOLS,
    ...options?.tools,
  };
  const argProfile = resolveArgProfile(tools, options?.tools);
  const workspaceFile = options?.workspaceFile ?? 'README.md';
  const approvalFile = options?.approvalFile ?? 'tck-approval-output.txt';
  const gate = (name: string) => (options?.gatePrefix ? `${options.gatePrefix}:${name}` : name);

  const attemptCounters = new Map<string, number>();
  const nextAttempt = (key: string): number => {
    const n = (attemptCounters.get(key) ?? 0) + 1;
    attemptCounters.set(key, n);
    return n;
  };

  const routes: MockRoute[] = [
    // 1. Basic turn
    routeByTag('[TCK:basic-turn]', (req) => {
      return replyText(`TCK_BASIC_OK: ${req.lastUserText.trim()}`, {
        usage: { inputTokens: 120, outputTokens: 24, cacheReadTokens: 10 },
      });
    }),

    // 2. Multi-turn context verification
    routeByTag('[TCK:multi-turn]', (req) => {
      // CLIs like Claude Code and Codex prepend synthetic user messages (environment/context reminders),
      // so count only actual tagged user prompts to keep turn numbering deterministic across CLIs.
      const userMsgs = req.messages.filter(
        (m) =>
          m.role === 'user' &&
          m.text.includes('[TCK:multi-turn]') &&
          (!m.toolResults || m.toolResults.length === 0),
      );
      const turn = Math.max(1, userMsgs.length);
      const historySummary = userMsgs
        .map((m, i) => {
          const idx = m.text.indexOf('[TCK:multi-turn]');
          const snippet = (idx >= 0 ? m.text.slice(idx) : m.text).trim().slice(0, 60);
          return `u${i + 1}=${snippet}`;
        })
        .join('; ');
      return replyText(`TCK_MULTI_TURN_${turn}: ${historySummary}`);
    }),

    // 3. Multiline boundary (with box-drawing horizontal rules `───`)
    routeByTag('[TCK:multiline-boundary]', (req) => {
      const lines = req.lastUserText.split(/\r?\n/);
      const hasRule = lines.some((l) => l.includes('───'));
      const lastLine = lines[lines.length - 1] ?? '';
      return replyText(`TCK_MULTILINE_OK lines=${lines.length} hasRule=${hasRule} tail=${lastLine}`);
    }),

    // 4. Image attachment audit
    routeByTag('[TCK:image-attachment]', (req) => {
      if (!req.hasImage) {
        return replyText('TCK_IMAGE_MISSING: no image block observed in request');
      }
      return replyText('TCK_IMAGE_VERIFIED: real image payload received');
    }),

    // 5. Rich stream (thinking + narration + wide markdown table + exact usage)
    routeByTag('[TCK:rich-stream]', (req) => {
      const narration = req.lastUserText.includes('narration=true');
      const wideTable = [
        '| Column A | Column B | Column C | Column D | Column E |',
        '| --- | --- | --- | --- | --- |',
        '| alpha-value-01 | beta-value-02 | gamma-value-03 | delta-value-04 | epsilon-value-05 |',
        '| row2-alpha | row2-beta | row2-gamma | row2-delta | row2-epsilon |',
      ].join('\n');
      return replyText(`TCK_RICH_STREAM_OK\n\n${wideTable}`, {
        thinking: {
          text: narration
            ? '**Progress**\nChecking workspace status and formatting summary.'
            : 'Step 1: analyze input. Step 2: construct wide table.',
          narration,
        },
        chunkSize: 20,
        usage: {
          inputTokens: 256,
          outputTokens: 128,
          cacheReadTokens: 64,
          cacheCreationTokens: 32,
          reasoningTokens: 48,
        },
      });
    }),

    // 6. Read + streaming bash tool
    routeByTag('[TCK:tool-read-bash]', (req) => {
      if (hasToolResultForCurrentTurn(req)) {
        return replyText(`TCK_TOOL_READ_BASH_DONE: ${summarizeToolResults(req)}`);
      }
      const target = extractArg(req.lastUserText, 'file', workspaceFile);
      return replyToolCall([
        buildReadToolCall(req, tools, argProfile, `tck_read_${req.id}`, target),
        buildBashToolCall(
          req,
          tools,
          argProfile,
          `tck_bash_${req.id}`,
          'printf "tick-1\\n"; sleep 0.05; printf "tick-2\\n"',
          { description: 'TCK streaming bash check' },
        ),
      ]);
    }),

    // 7. Parallel out-of-order tools
    routeByTag('[TCK:tool-parallel-ooo]', (req) => {
      if (hasToolResultForCurrentTurn(req)) {
        const turnResults = currentTurnToolResults(req);
        return replyText(`TCK_TOOL_PARALLEL_DONE count=${turnResults.length} ${summarizeToolResults(req)}`);
      }
      return replyToolCall([
        buildBashToolCall(
          req,
          tools,
          argProfile,
          `tck_ooo_slow_${req.id}`,
          'sleep 0.15 && echo SLOW_DONE',
          { description: 'slow parallel tool' },
        ),
        buildBashToolCall(
          req,
          tools,
          argProfile,
          `tck_ooo_fast_${req.id}`,
          'echo FAST_DONE',
          { description: 'fast parallel tool' },
        ),
      ]);
    }),

    // 8. Malformed tool arguments recovery
    routeByTag('[TCK:tool-malformed-recovery]', (req) => {
      if (hasToolResultForCurrentTurn(req)) {
        return replyText(`TCK_MALFORMED_RECOVERED: ${summarizeToolResults(req)}`);
      }
      const attempt = nextAttempt('tool-malformed-recovery');
      if (attempt > 1) {
        return replyText(`TCK_MALFORMED_RECOVERED: retried attempt=${attempt}`);
      }
      const toolName = argProfile === 'codex'
        ? resolveToolName(req, tools.bash)
        : resolveToolName(req, tools.read);
      const rawArguments = argProfile === 'codex'
        ? '{"cmd": "unterminated-json'
        : argProfile === 'pi' || argProfile === 'generic'
          ? '{"path": "unterminated-json'
          : '{"file_path": "unterminated-json';
      return replyToolCall({
        id: `tck_malformed_${req.id}`,
        name: toolName,
        rawArguments,
      });
    }),

    // 9. Approval scenarios (deny / allow / cancel) — auto-aware of tool_result
    {
      id: 'tck:approval',
      priority: 12,
      match: (req) =>
        req.lastUserText.includes('[TCK:approval-deny]')
        || req.lastUserText.includes('[TCK:approval-allow]')
        || req.lastUserText.includes('[TCK:approval-cancel]'),
      handle: (req): MockReplySpec => {
        if (hasToolResultForCurrentTurn(req)) {
          const turnResults = currentTurnToolResults(req);
          const denied = turnResults.some((tr) => tr.isError || /denied|rejected|cancel/i.test(tr.content));
          return replyText(
            `TCK_APPROVAL_RESULT status=${denied ? 'denied' : 'allowed'} details=${summarizeToolResults(req)}`,
          );
        }
        const target = extractArg(req.lastUserText, 'file', approvalFile);
        const waitGate = req.lastUserText.includes('gate=1') ? gate('approval:before-tool') : undefined;
        return replyToolCall(
          buildWriteToolCall(req, tools, argProfile, `tck_approve_write_${req.id}`, target),
          waitGate ? { gates: { beforeToolUse: waitGate } } : undefined,
        );
      },
    },

    // 10. AskUserQuestion interaction
    routeByTag('[TCK:question-answer]', (req) => {
      if (hasToolResultForCurrentTurn(req)) {
        return replyText(`TCK_QUESTION_ANSWERED: ${summarizeToolResults(req)}`);
      }
      return replyToolCall({
        id: `tck_ask_${req.id}`,
        name: resolveToolName(req, tools.askUser),
        arguments: {
          questions: [
            {
              header: 'Environment',
              question: 'Which target environment should TCK deploy to?',
              multiSelect: false,
              options: [
                { label: 'staging', description: 'Staging environment' },
                { label: 'canary', description: 'Canary rollout' },
              ],
            },
          ],
        },
      });
    }),

    // 11. Steer (valid / stale)
    {
      id: 'tck:steer',
      priority: 12,
      match: (req) =>
        req.lastUserText.includes('[TCK:steer-valid]') ||
        req.lastUserText.includes('[TCK:steer-stale]') ||
        req.lastUserText.includes('[TCK:steer-followup]'),
      handle: (req): MockReplySpec => {
        const isStale = req.lastUserText.includes('[TCK:steer-stale]');
        const gateName = gate(isStale ? 'steer-stale:hold' : 'steer-valid:hold');
        if (
          req.lastUserText.includes('[TCK:steer-followup]') ||
          req.messages.some((m) => m.role === 'user' && m.text.includes('[TCK:steer-followup]'))
        ) {
          return replyText(`TCK_STEER_APPLIED: ${req.lastUserText.trim()}`);
        }
        return replyText('TCK_STEER_PRIMARY_PART1 TCK_STEER_PRIMARY_PART2', {
          chunkSize: 12,
          gates: {
            afterChunk: { index: 1, gate: gateName },
          },
        });
      },
    },

    // 12. Busy queue
    routeByTag('[TCK:busy-queue]', (req) => {
      if (req.lastUserText.includes('queued=1')) {
        return replyText(`TCK_BUSY_QUEUED_DELIVERED: ${req.lastUserText.trim()}`);
      }
      return replyText('TCK_BUSY_PRIMARY_FIRST_HALF TCK_BUSY_PRIMARY_SECOND_HALF', {
        chunkSize: 14,
        gates: {
          afterChunk: { index: 1, gate: gate('busy-queue:hold') },
        },
      });
    }),

    // 13a. Interrupt before first token
    routeByTag('[TCK:interrupt-before-first-token]', () => {
      return replyText('TCK_SHOULD_NOT_EMIT_BEFORE_FIRST_TOKEN', {
        gates: { beforeFirstToken: gate('interrupt-before-first-token') },
      });
    }),

    // 13b. Interrupt mid-stream
    routeByTag('[TCK:interrupt-mid-stream]', () => {
      return replyText('TCK_MID_CHUNK_ONE TCK_MID_CHUNK_TWO TCK_MID_CHUNK_THREE', {
        chunkSize: 18,
        gates: {
          afterChunk: { index: 1, gate: gate('interrupt-mid-stream') },
        },
      });
    }),

    // 13c. Interrupt during tool
    routeByTag('[TCK:interrupt-during-tool]', (req) => {
      if (hasToolResultForCurrentTurn(req)) {
        return replyText(`TCK_INTERRUPT_TOOL_AFTER: ${summarizeToolResults(req)}`);
      }
      return replyToolCall(
        buildBashToolCall(
          req,
          tools,
          argProfile,
          `tck_int_tool_${req.id}`,
          'sleep 30',
          { description: 'TCK interruptible long command' },
        ),
        {
          gates: { beforeToolUse: gate('interrupt-during-tool') },
        },
      );
    }),

    // 13d. Interrupt and send
    routeByTag('[TCK:interrupt-and-send]', (req) => {
      if (req.lastUserText.includes('after-interrupt=1')) {
        return replyText('TCK_AFTER_INTERRUPT_OK');
      }
      return replyText('TCK_INTERRUPT_AND_SEND_HOLD_1 TCK_INTERRUPT_AND_SEND_HOLD_2', {
        chunkSize: 16,
        gates: {
          afterChunk: { index: 1, gate: gate('interrupt-and-send') },
        },
      });
    }),

    // 14a. Subagent child worker route (higher priority so child prompts never collide with parent turn)
    {
      id: 'tck:subagent-child',
      priority: 25,
      match: (req) => req.lastUserText.includes('[TCK:subagent-worker]'),
      handle: (req): MockReplySpec => {
        const bgGate = req.lastUserText.includes('bg=1') ? gate('subagent-bg:worker') : undefined;
        return replyText(`TCK_SUBAGENT_WORKER_RESULT: ${req.lastUserText.trim()}`, {
          chunkSize: 16,
          ...(bgGate ? { gates: { afterChunk: { index: 1, gate: bgGate } } } : {}),
        });
      },
    },

    // 14b. Subagent sync & background unblocked parent routes
    routeByTag('[TCK:subagent-sync]', (req) => {
      if (hasToolResultForCurrentTurn(req)) {
        return replyText(`TCK_SUBAGENT_SYNC_DONE: ${summarizeToolResults(req)}`);
      }
      return replyToolCall({
        id: `tck_sub_sync_${req.id}`,
        name: resolveToolName(req, tools.subagent),
        arguments: {
          description: 'TCK sync worker',
          prompt: '[TCK:subagent-worker] compute sync result',
          run_in_background: false,
        },
      });
    }),

    routeByTag('[TCK:subagent-bg-unblocked]', (req) => {
      if (hasToolResultForCurrentTurn(req)) {
        return replyText(`TCK_SUBAGENT_BG_LAUNCHED: ${summarizeToolResults(req)}`);
      }
      return replyToolCall({
        id: `tck_sub_bg_${req.id}`,
        name: resolveToolName(req, tools.subagent),
        arguments: {
          description: 'TCK background worker',
          prompt: '[TCK:subagent-worker] bg=1 run background task',
          run_in_background: true,
        },
      });
    }),

    // 15. Background stop (1 vs 2 parallel background tasks & bg shell stop)
    {
      id: 'tck:bg-stop',
      priority: 12,
      match: (req) =>
        req.lastUserText.includes('[TCK:bg-stop-single]')
        || req.lastUserText.includes('[TCK:bg-stop-multi]')
        || req.lastUserText.includes('[TCK:bg-shell-stop]'),
      handle: (req): MockReplySpec => {
        if (hasToolResultForCurrentTurn(req)) {
          return replyText(`TCK_BG_STOP_DONE: ${summarizeToolResults(req)}`);
        }
        if (req.lastUserText.includes('[TCK:bg-shell-stop]')) {
          return replyToolCall(
            buildBashToolCall(
              req,
              tools,
              argProfile,
              `tck_bg_shell_${req.id}`,
              'sleep 60',
              { description: 'TCK background shell server', runInBackground: true },
            ),
          );
        }
        const count = req.lastUserText.includes('[TCK:bg-stop-multi]') ? 2 : 1;
        const calls = Array.from({ length: count }, (_, idx) => ({
          id: `tck_bg_agent_${req.id}_${idx + 1}`,
          name: resolveToolName(req, tools.subagent),
          arguments: {
            description: `TCK bg worker ${idx + 1}`,
            prompt: `[TCK:subagent-worker] bg=1 worker=${idx + 1}`,
            run_in_background: true,
          },
        }));
        return replyToolCall(calls);
      },
    },

    // 16. /compact summary preservation
    {
      id: 'tck:slash-compact',
      priority: 18,
      match: (req) =>
        req.lastUserText.includes('[TCK:slash-compact]')
        || (/compact|summarize the conversation/i.test(req.system) && req.messages.some((m) => m.text.includes('[TCK:compact-anchor]'))),
      handle: (req): MockReplySpec => {
        const hasAnchor = req.messages.some((m) => m.text.includes('[TCK:compact-anchor]'))
          || req.system.includes('[TCK:compact-anchor]');
        return replyText(
          hasAnchor
            ? 'TCK_COMPACT_SUMMARY: preserved [TCK:compact-anchor] constraint'
            : 'TCK_COMPACT_SUMMARY: no anchor found',
        );
      },
    },

    // 17. /clear context isolation audit
    routeByTag('[TCK:slash-clear]', (req) => {
      const secretToken = extractArg(req.lastUserText, 'forbid', 'TCK_OLD_TOPIC_SECRET');
      const leaked = req.messages.some((m, idx) => idx < req.messages.length - 1 && m.text.includes(secretToken));
      return replyText(leaked ? `TCK_CLEAR_LEAKED:${secretToken}` : 'TCK_CLEAR_CLEAN');
    }),

    // 18. True TCP stream disconnect (disconnects first attempt, succeeds on retry)
    routeByTag('[TCK:stream-disconnect]', (req) => {
      const alwaysFail = req.lastUserText.includes('always=1');
      const attempt = nextAttempt('stream-disconnect');
      if (alwaysFail || attempt === 1) {
        return replyDisconnect('TCK_PARTIAL_CHUNK_1 TCK_PARTIAL_CHUNK_2 TCK_PARTIAL_CHUNK_3', 2, {
          chunkSize: 12,
        });
      }
      return replyText(`TCK_DISCONNECT_RECOVERED attempt=${attempt}`);
    }),

    // 19. HTTP 429 / 500 error recovery
    routeByTag('[TCK:http-error-recovery]', (req) => {
      const status = req.lastUserText.includes('status=500') ? 500 : 429;
      const key = `http-error-${status}`;
      const attempt = nextAttempt(key);
      if (attempt === 1) {
        return replyError(
          status,
          status === 429 ? 'TCK simulated rate limit' : 'TCK simulated internal server error',
          status === 429 ? { retryAfterMs: 100 } : undefined,
        );
      }
      return replyText(`TCK_HTTP_RECOVERED status=${status} attempt=${attempt}`);
    }),

    // 20. Side chat (tool-free discussion stream with optional cancellation gate)
    routeByTag('[TCK:side-chat]', (req) => {
      const useGate = req.lastUserText.includes('gate=1');
      return replyText('TCK_SIDE_CHAT_CHUNK_1 TCK_SIDE_CHAT_CHUNK_2', {
        chunkSize: 12,
        ...(useGate ? { gates: { afterChunk: { index: 1, gate: gate('side-chat:mid') } } } : {}),
      });
    }),
  ];

  const unregisters = routes.map((r) => hub.addRoute(r));
  const unregister = () => {
    for (const fn of unregisters) fn();
  };
  const resetCounters = () => {
    attemptCounters.clear();
  };
  return Object.assign(unregister, { unregister, resetCounters });
}
