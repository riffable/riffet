import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { AgentTranscriptSource, AgentLaneWriter } from '../../../../packages/plugin-api/src/agent.js';
import type { NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { ClaudeTranscriptSource } from '../backends/claude/transcript-source.js';
import { CodexTranscriptSource, type CodexThreadReader, type CodexTurnsRequest } from '../backends/codex/transcript-source.js';
import type { RpcTurn } from '../backends/codex/types.js';
import { DroidTranscriptSource } from '../backends/droid/transcript.js';
import { PiTranscriptSource } from '../backends/pi/transcript.js';
import { PluginLaneSource } from '../backends/plugin-backend.js';
import { runReadPipelineContract, type ReadPipelineFixture } from './pipeline-contract.js';

const ts = (offsetSec: number) => new Date(Date.UTC(2026, 9, 24, 10, 0, 0) + offsetSec * 1000).toISOString();

const claudeFixture: ReadPipelineFixture = {
  name: 'claude',
  prepare() {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-pipe-claude-'));
    const file = join(dir, 'claude-1.jsonl');
    let seq = 0;
    const write = (...rows: Array<Record<string, unknown>>) => {
      appendFileSync(file, rows.map(row => `${JSON.stringify({ isSidechain: false, sessionId: 'claude-1', timestamp: ts(++seq), ...row })}\n`).join(''));
    };
    writeFileSync(file, '');
    return {
      sessionId: 'pipe-claude',
      source: () => new ClaudeTranscriptSource({ sessionId: 'pipe-claude', nativeSessionId: () => 'claude-1', locate: async () => file }),
      stopLifecycle: {
        async startMidTurn(ctx) {
          write(
            { type: 'user', uuid: 'u-1', promptId: 'p-1', origin: { kind: 'human' }, message: { role: 'user', content: 'investigate pipeline' } },
            { type: 'assistant', uuid: 'a-1', message: { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'checking logs before stop' }], stop_reason: 'tool_use' } },
          );
          await ctx.pull();
          return { turnId: 'u-1', mustPreserveText: 'checking logs before stop', stopAt: ts(++seq) };
        },
        appendNextTurn() {
          write(
            { type: 'user', uuid: 'u-2', promptId: 'p-2', origin: { kind: 'human' }, message: { role: 'user', content: 'follow up' } },
            { type: 'assistant', uuid: 'a-2', message: { id: 'm-2', role: 'assistant', content: [{ type: 'text', text: 'done on turn two' }], stop_reason: 'end_turn' } },
            { type: 'system', subtype: 'turn_duration', uuid: 'd-2', durationMs: 500 },
          );
        },
      },
      cleanup() { rmSync(dir, { recursive: true, force: true }); },
    };
  },
};

const droidFixture: ReadPipelineFixture = {
  name: 'droid',
  prepare() {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-pipe-droid-'));
    const file = join(dir, 'droid-1.jsonl');
    let seq = 0;
    let leaf: string | undefined;
    writeFileSync(file, `${JSON.stringify({ type: 'session_start', id: 'droid-1', title: 'Pipeline', cwd: '/repo' })}\n`);
    const msg = (id: string, role: string, content: unknown[]) => {
      const parentId = leaf;
      leaf = id;
      appendFileSync(file, `${JSON.stringify({ type: 'message', id, ...(parentId ? { parentId } : {}), seq: seq++, timestamp: ts(seq), message: { role, content } })}\n`);
    };
    const outcome = (turnId: string, reason = 'completed') => {
      appendFileSync(file, `${JSON.stringify({ type: 'agent_turn_outcome', turnId, reason })}\n`);
    };
    return {
      sessionId: 'pipe-droid',
      source: () => new DroidTranscriptSource({ sessionId: 'pipe-droid', nativeSessionId: () => 'droid-1', locate: async () => file }),
      stopLifecycle: {
        async startMidTurn(ctx) {
          msg('u1', 'user', [{ type: 'text', text: 'run droid task' }]);
          msg('a1', 'assistant', [{ type: 'text', text: 'droid working step' }]);
          await ctx.pull();
          return { turnId: 'u1', mustPreserveText: 'droid working step', stopAt: ts(++seq) };
        },
        appendNextTurn() {
          msg('u2', 'user', [{ type: 'text', text: 'next droid turn' }]);
          msg('a2', 'assistant', [{ type: 'text', text: 'droid turn two answer' }]);
          outcome('u2', 'completed');
        },
      },
      cleanup() { rmSync(dir, { recursive: true, force: true }); },
    };
  },
};

const codexFixture: ReadPipelineFixture = {
  name: 'codex',
  prepare() {
    const turns: RpcTurn[] = [];
    const reader: CodexThreadReader = {
      async turnsPage(request: CodexTurnsRequest) {
        const start = request.cursor ? Number(request.cursor) : 0;
        const slice = request.sortDirection === 'asc'
          ? turns.slice(start, start + request.limit)
          : turns.slice(Math.max(0, turns.length - request.limit), turns.length).reverse();
        return { data: structuredClone(slice), nextCursor: null };
      },
    };
    return {
      sessionId: 'pipe-codex',
      source: () => new CodexTranscriptSource({
        sessionId: 'pipe-codex', backend: 'codex', threadId: () => 'thread-1', reader: async () => reader,
        commandOf: () => undefined, runOf: () => undefined,
      }),
      stopLifecycle: {
        async startMidTurn(ctx) {
          turns.push({
            id: 't1', status: 'inProgress', startedAt: 1000,
            items: [
              { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'codex turn one' }] },
              { type: 'agentMessage', id: 'a1', text: 'codex partial work', phase: 'commentary' },
            ],
          });
          await ctx.pull();
          return { turnId: 't1', mustPreserveText: 'codex partial work', stopAt: ts(10) };
        },
        flushAfterStop() {
          turns[0]!.status = 'interrupted';
          turns[0]!.completedAt = 1005;
        },
        appendNextTurn() {
          turns.push({
            id: 't2', status: 'completed', startedAt: 2000, completedAt: 2005,
            items: [
              { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'codex turn two' }] },
              { type: 'agentMessage', id: 'a2', text: 'codex final answer', phase: 'final_answer' },
            ],
          });
        },
      },
    };
  },
};

const piFixture: ReadPipelineFixture = {
  name: 'pi',
  prepare() {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-pipe-pi-'));
    const file = join(dir, 'pi-1.jsonl');
    let seq = 0;
    let leaf: string | null = null;
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: 'pi-1', timestamp: ts(0), cwd: '/repo' })}\n`);
    const add = (id: string, message: Record<string, unknown>) => {
      const parentId = leaf;
      leaf = id;
      appendFileSync(file, `${JSON.stringify({ type: 'message', id, parentId, timestamp: ts(++seq), message })}\n`);
    };
    return {
      sessionId: 'pipe-pi',
      source: () => new PiTranscriptSource({ sessionId: 'pipe-pi', nativeSessionId: () => 'pi-1', locate: async () => file }),
      stopLifecycle: {
        async startMidTurn(ctx) {
          add('u1', { role: 'user', content: [{ type: 'text', text: 'pi turn one' }] });
          add('a1', { role: 'assistant', content: [{ type: 'text', text: 'pi working before stop' }], stopReason: 'toolUse', timestamp: Date.parse(ts(seq)), provider: 'test', model: 'm' });
          await ctx.pull();
          return { turnId: 'u1', mustPreserveText: 'pi working before stop', stopAt: ts(++seq) };
        },
        appendNextTurn() {
          add('u2', { role: 'user', content: [{ type: 'text', text: 'pi turn two' }] });
          add('a2', { role: 'assistant', content: [{ type: 'text', text: 'pi completed answer' }], stopReason: 'stop', timestamp: Date.parse(ts(seq)), provider: 'test', model: 'm' });
        },
      },
      cleanup() { rmSync(dir, { recursive: true, force: true }); },
    };
  },
};

/**
 * Plugin-API / Cursor-protocol delayed-flush source through real `PluginLaneSource`:
 * exercises D1 (in-place draft promotion inside `transaction()`), D2 (`settleTurnEnd`),
 * D3 (`ended: true` late flush with zero `turnReopened` + preserved failure error), and P3 (`rebase`).
 */
const pluginDelayedFlushFixture = (mode: 'interrupted' | 'failed'): ReadPipelineFixture => ({
  name: mode === 'interrupted' ? 'plugin-delayed-flush-interrupted' : 'plugin-delayed-flush-failed',
  prepare() {
    type StoredStep = { at: number; turnId: string; events: NativeWorkbenchEvent[]; ended?: 'completed' | 'failed' };
    const persisted: StoredStep[] = [];
    let pendingDraft: { at: number; turnId: string; events: NativeWorkbenchEvent[] } | undefined;

    const event = (nativeId: string, turnId: string, type: string, data: Record<string, unknown>, at: string): NativeWorkbenchEvent => ({
      sequence: 0, sessionId: `pipe-plugin-${mode}`, type, nativeId, nativeTurnId: turnId, createdAt: at, data,
    });

    const createAgentSource = (): AgentTranscriptSource => ({
      identity: () => `plugin-chat-${mode}`,
      async pull(w: AgentLaneWriter) {
        const cursor = w.cursor ? JSON.parse(w.cursor) as { count: number; kept?: { turnId: string; at: number } } : { count: 0 };
        // Absorb persisted steps (Outcome A: late flush of kept step at cursor.kept.at with `ended: true` and NO turnReopened).
        if (cursor.kept && persisted[cursor.kept.at]?.turnId === cursor.kept.turnId) {
          const step = persisted[cursor.kept.at]!;
          const next = { count: cursor.kept.at + 1 };
          w.commit({ events: step.events, cursor: JSON.stringify(next), ended: true });
          cursor.count = next.count;
          cursor.kept = undefined;
        }
        while (cursor.count < persisted.length) {
          const step = persisted[cursor.count]!;
          w.turnStarted(step.turnId, step.events[0]!.createdAt);
          const next = { count: cursor.count + 1, ...(cursor.kept ? { kept: cursor.kept } : {}) };
          w.commit({ events: step.events, cursor: JSON.stringify(next) });
          if (step.ended) w.turnEnded(step.turnId, step.ended, step.events.at(-1)!.createdAt);
          cursor.count = next.count;
        }
        if (pendingDraft && !cursor.kept) {
          w.commit({
            events: [],
            drafts: pendingDraft.events.map(ev => ({ finalId: ev.nativeId!, event: ev })),
            cursor: JSON.stringify(cursor),
          });
        }
        return { caughtUp: true };
      },
      async drain(w) { await this.pull(w, new AbortController().signal); },
      async settleTurnEnd(w, end) {
        await this.pull(w, new AbortController().signal);
        if (!pendingDraft || pendingDraft.turnId !== end.turnId) return false;
        const draft = pendingDraft;
        pendingDraft = undefined;
        const cursor = w.cursor ? JSON.parse(w.cursor) as { count: number } : { count: 0 };
        const nextCursor = JSON.stringify({ count: cursor.count, kept: { turnId: end.turnId, at: draft.at } });
        // D1 + D2: promote draft in-place under exact positional nativeId before turnEnded in ONE transaction.
        w.transaction!(() => {
          w.commit({ events: draft.events, cursor: nextCursor });
          w.turnEnded(end.turnId, end.status, end.at, end.error);
        });
        return true;
      },
    });

    return {
      sessionId: `pipe-plugin-${mode}`,
      source: () => new PluginLaneSource(createAgentSource(), () => true),
      stopLifecycle: {
        async startMidTurn(ctx) {
          persisted.push({
            at: 0, turnId: 't1',
            events: [event('0:0', 't1', 'user_message_chunk', { content: { type: 'text', text: 'inspect workspace' } }, ts(1))],
          });
          pendingDraft = {
            at: 1, turnId: 't1',
            events: [
              event('1:0', 't1', 'agent_thought_chunk', { content: { type: 'text', text: 'analyzing repo layout' } }, ts(2)),
              event('1:1', 't1', 'tool_call', { toolCallId: 'call-1', title: 'Read package.json', status: 'in_progress' }, ts(3)),
            ],
          };
          await ctx.pull();
          return {
            turnId: 't1', mustPreserveText: 'analyzing repo layout',
            stopStatus: mode,
            ...(mode === 'failed' ? { stopError: 'initial failure' } : {}),
            stopAt: ts(4),
          };
        },
        ...(mode === 'failed' ? { refineError: { at: ts(5), error: 'provider error: HTTP 429 rate limited' } } : {}),
        flushAfterStop() {
          persisted.push({
            at: 1, turnId: 't1',
            events: [
              event('1:0', 't1', 'agent_thought_chunk', { content: { type: 'text', text: 'analyzing repo layout' } }, ts(2)),
              event('1:1', 't1', 'tool_call', { toolCallId: 'call-1', title: 'Read package.json', status: 'in_progress' }, ts(3)),
              event('1:2', 't1', 'tool_call_update', { toolCallId: 'call-1', title: 'Read package.json', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'aborted' } }] }, ts(6)),
            ],
          });
        },
        appendNextTurn() {
          persisted.push({
            at: 2, turnId: 't2', ended: 'completed',
            events: [
              event('2:0', 't2', 'user_message_chunk', { content: { type: 'text', text: 'second turn' } }, ts(10)),
              event('2:1', 't2', 'agent_message_chunk', { content: { type: 'text', text: 'turn two completed cleanly' } }, ts(11)),
            ],
          });
        },
        // Interrupted stop converges identically to a cold fresh import; failed stop carries an external diagnostic row.
        checkColdEquivalence: mode === 'interrupted',
      },
    };
  },
});

describe('session read-pipeline contract (P1–P6)', () => {
  for (const fixture of [claudeFixture, droidFixture, codexFixture, piFixture, pluginDelayedFlushFixture('interrupted'), pluginDelayedFlushFixture('failed')]) {
    it(`${fixture.name} holds P1–P6 across Journal, TranscriptIngest, JournalFeed, and TimelineService`, async () => {
      await runReadPipelineContract(fixture);
    });
  }
});
