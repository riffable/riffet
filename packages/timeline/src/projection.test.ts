import { describe, expect, it } from 'vitest';
import { PENDING_ROW_POS, type NativeJob, type NativeRunDetails, type NativeWorkbenchEvent, type Run, type WorkbenchEvent } from '../../contracts/src/index.js';
import { buildTimeline, IncrementalTimeline } from './buildTimeline.js';
import { appendProjectedEvents, projectEvents, projectionIndexes } from './projectEvents.js';
import { timelineRows, type RowContent } from './rows.js';
import { activeTurnState, analyzeTimelineTurns, timelineTurnKeys } from './timelineTurns.js';
import type { TimelineItem } from './model.js';

/*
 * The projection contract (docs/SYNC-V3.md, 时间线由服务端折叠): each scenario is a rule the fold could
 * get wrong, run through `projectEvents` → `buildTimeline` → `timelineRows`, and held to the rows a
 * client receives. The scenarios are the logic-parity ones of `scripts/gen-timeline-fixtures.ts`, which
 * still emits them for the Kotlin port until that port is replaced by these rows.
 */

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const ms = (second: number) => Date.parse(at(second));

type FixtureEvent = WorkbenchEvent & Partial<Pick<NativeWorkbenchEvent, 'nativeId' | 'nativeAliases' | 'nativeTurnId'>>;

function ev(sequence: number, type: string, data: Record<string, unknown>, extra: Partial<FixtureEvent> = {}): FixtureEvent {
  return { sequence, sessionId: 'session-1', type, data, createdAt: at(sequence), ...extra };
}

const text = (value: string, extra: Record<string, unknown> = {}) => ({ content: { type: 'text', text: value }, ...extra });

function appRun(id: string, state: Run['state'], prompt: string, second = 0): Run {
  return { id, sessionId: 'session-1', commandId: `cmd-${id}`, prompt, state, createdAt: at(second), updatedAt: at(second) };
}

function nativeRun(id: string, state: Run['state'], prompt: string, second: number, native: Partial<NativeRunDetails>): Run {
  return {
    ...appRun(id, state, prompt, second),
    native: {
      input: { text: prompt, attachmentIds: [], context: [] }, config: { mode: 'default' },
      fingerprint: `fp-${id}`, delivery: 'observed', attempt: 1, configRevision: 1, ...native,
    },
  };
}

const activity = (sequence: number, status: string, extra: Record<string, unknown> = {}) => ev(sequence, 'session/update', {
  sessionUpdate: 'activity', activity: { id: 'claude:c1', kind: 'compaction', status, title: '上下文压缩', ...extra },
}, { nativeId: 'claude:c1' });

interface Scenario {
  name: string;
  events: FixtureEvent[];
  runs: Run[];
  jobs?: Record<string, NativeJob>;
  nativeChatId?: string;
  sessionRunning?: boolean;
  activeTurnId?: string;
}

/** Each scenario is a rule the two implementations could disagree about, not a code path. */
const scenarios: Scenario[] = [
  {
    name: '普通回合：思考、旁白与回答分行，工具调用与结果并为一行，隐藏与无名的工具不出现',
    events: [
      ev(1, 'user_message_chunk', text('检查构建'), { runId: 'run-1' }),
      ev(2, 'agent_thought_chunk', text('锁文件', { channel: 'thinking' }), { runId: 'run-1' }),
      ev(3, 'agent_thought_chunk', text('可能过期了'), { runId: 'run-1' }),
      ev(4, 'agent_message_chunk', text('先看看文件。', { phase: 'commentary' }), { runId: 'run-1' }),
      ev(5, 'tool_call', { toolCallId: 'tool-1', title: 'Edit package.json', status: 'in_progress', content: [{ type: 'diff', path: 'package.json', oldText: 'a', newText: 'b' }] }, { runId: 'run-1' }),
      ev(6, 'tool_call_update', { toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] }, { runId: 'run-1' }),
      ev(7, 'tool_call', { toolCallId: 'tool-2', title: 'AwaitShell', hidden: true }, { runId: 'run-1' }),
      ev(8, 'tool_call_update', { toolCallId: 'tool-3', status: 'completed' }, { runId: 'run-1' }),
      ev(9, 'agent_message_chunk', text('锁文件过期了，', { phase: 'final_answer' }), { runId: 'run-1' }),
      ev(10, 'agent_message_chunk', { content: { text: '重新安装即可。' }, phase: 'final_answer' }, { runId: 'run-1' }),
      ev(11, 'agent_message_chunk', { content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } }, { runId: 'run-1' }),
    ],
    runs: [appRun('run-1', 'completed', '检查构建')],
  },
  {
    name: '相邻两轮各有自己的工具行：新一轮复用的 toolCallId 不改写旧卡片',
    events: [
      ev(1, 'user_message_chunk', text('first'), { runId: 'run-1' }),
      ev(2, 'tool_call', { toolCallId: 'tool-1', title: 'ls', status: 'in_progress' }, { runId: 'run-1' }),
      ev(3, 'agent_message_chunk', text('done'), { runId: 'run-1' }),
      ev(4, 'user_message_chunk', text('second'), { runId: 'run-2' }),
      ev(5, 'tool_call', { toolCallId: 'tool-1', title: 'ls -la', status: 'in_progress' }, { runId: 'run-2' }),
      ev(6, 'tool_call_update', { toolCallId: 'tool-1', status: 'completed' }, { runId: 'run-2' }),
    ],
    runs: [appRun('run-1', 'completed', 'first', 1), appRun('run-2', 'running', 'second', 4)],
    sessionRunning: true,
  },
  {
    name: '子 agent：Task 工具行属于发起它的回合，子 agent 的完成通知开启自己的回合',
    events: [
      ev(1, 'user_message_chunk', text('review the diff'), { nativeId: 'msg-u1', nativeTurnId: 'turn-1' }),
      ev(2, 'tool_call', { toolCallId: 'task-1', title: 'Task: review', kind: 'think', status: 'in_progress', rawInput: { subagent_type: 'reviewer' } }, { nativeId: 'msg-a1:0', nativeTurnId: 'turn-1' }),
      ev(3, 'tool_call_update', { toolCallId: 'task-1', status: 'completed' }, { nativeId: 'msg-a1:1', nativeTurnId: 'turn-1' }),
      ev(4, 'agent_message_chunk', text('子 agent 已开始审查。'), { nativeId: 'msg-a2', nativeTurnId: 'turn-1' }),
      ev(5, 'task_notification', { status: 'completed', kind: 'agent', title: 'review', taskId: 'agent-7', subagentToolCallId: 'task-1', tokens: 1200, durationMs: 5000 }, { nativeId: 'msg-n1', nativeTurnId: 'turn-2' }),
      ev(6, 'agent_message_chunk', text('审查结论已汇总。'), { nativeId: 'msg-a3', nativeTurnId: 'turn-2' }),
    ],
    runs: [nativeRun('run-a', 'completed', 'review the diff', 1, { nativeMessageId: 'msg-u1', nativeSessionId: 'chat-1', nativeTurnId: 'turn-1' })],
    nativeChatId: 'chat-1',
    sessionRunning: true,
  },
  {
    name: '计划：平铺与嵌套两种 entries 都读，显式空列表是一次清空，非数组不出行',
    events: [
      ev(1, 'user_message_chunk', text('plan it'), { runId: 'run-1' }),
      ev(2, 'plan', { entries: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'in_progress' }] }, { runId: 'run-1' }),
      ev(3, 'plan', { plan: { entries: [{ content: 'a', status: 'completed' }] } }, { runId: 'run-1' }),
      ev(4, 'plan', { entries: [] }, { runId: 'run-1' }),
      ev(5, 'plan', { entries: 'none' }, { runId: 'run-1' }),
    ],
    runs: [appRun('run-1', 'completed', 'plan it', 1)],
  },
  {
    name: '排队与 steer：引导消息按回执归入正在执行的回合，排队消息留在末尾',
    events: [
      ev(1, 'user_message_chunk', text('重构解析器'), { nativeId: 'chat-1:t1:user', nativeTurnId: 't1' }),
      ev(2, 'agent_message_chunk', text('开始重构。'), { nativeId: 'chat-1:t1:item-1', nativeTurnId: 't1' }),
      ev(3, 'native_input_receipt', { commandId: 'cmd-run-s', content: { type: 'text', text: '顺便补测试' } }, { nativeId: 'chat-1:t1:steer-1', nativeTurnId: 't1' }),
      ev(4, 'tool_call', { toolCallId: 'call-1', title: 'Run tests', status: 'in_progress' }, { nativeId: 'chat-1:t1:item-2', nativeTurnId: 't1' }),
    ],
    runs: [
      nativeRun('run-a', 'running', '重构解析器', 1, { nativeMessageId: 'chat-1:t1:user', nativeSessionId: 'chat-1', nativeTurnId: 't1', expectsTurnOutcome: true }),
      nativeRun('run-s', 'running', '顺便补测试', 3, { intent: 'steer', ownerRunId: 'run-a', nativeTurnId: 't1', nativeMessageId: 'chat-1:t1:steer-1', nativeSessionId: 'chat-1' }),
      nativeRun('run-q', 'queued', '然后更新文档', 5, { delivery: 'queued' }),
    ],
    nativeChatId: 'chat-1',
    sessionRunning: true,
    activeTurnId: 't1',
  },
  {
    name: '压缩：系统活动原位更新，压缩丢掉的提示由最近一次已确认回合补回，更早的回合不再追加',
    events: [
      activity(10, 'running'),
      ev(11, 'agent_message_chunk', text('压缩后继续。'), { nativeId: 'msg-a2' }),
      activity(12, 'completed', { endedAt: at(12), compaction: { trigger: 'auto', preTokens: 150000, postTokens: 30000 } }),
      ev(13, 'tool_call', { toolCallId: 't-9', title: 'Edit', status: 'completed' }, { nativeId: 'msg-a3' }),
    ],
    runs: [
      nativeRun('run-old', 'completed', '更早的问题', 0, { nativeMessageId: 'msg-u0', nativeSessionId: 'chat-1' }),
      nativeRun('run-a', 'completed', '继续实现', 1, { nativeMessageId: 'msg-u1', nativeSessionId: 'chat-1' }),
    ],
    nativeChatId: 'chat-1',
  },
  {
    name: '任务通知：后台任务的工具行带作业状态，通知的状态与结果只认已知取值',
    events: [
      ev(1, 'user_message_chunk', text('run the suite'), { runId: 'run-1' }),
      ev(2, 'tool_call', { toolCallId: 'bash-1', title: 'npm test', status: 'in_progress' }, { runId: 'run-1' }),
      ev(3, 'agent_message_chunk', text('已在后台运行。'), { runId: 'run-1' }),
      ev(4, 'task_notification', { status: 'completed', kind: 'shell', title: 'npm test', taskId: 'bg-1', command: 'npm test', jobResult: { id: 'bg-1', status: 'succeeded', exitCode: 0, runningMs: 4200 } }),
      ev(5, 'task_notification', { status: 'paused', jobResult: { id: 'bg-2', status: 'paused' } }),
    ],
    runs: [appRun('run-1', 'completed', 'run the suite', 1)],
    jobs: { 'bash-1': { toolCallId: 'bash-1', title: 'npm test', command: 'npm test', status: 'running' } },
    sessionRunning: true,
  },
  {
    name: '运行状态行：失败、停止与中断各有文案，原因跟在后面',
    events: [
      ev(1, 'user_message_chunk', text('deploy'), { runId: 'run-1' }),
      ev(2, 'run_failed', { error: 'exit 1' }, { runId: 'run-1' }),
      ev(3, 'user_message_chunk', text('deploy again'), { runId: 'run-2' }),
      ev(4, 'run_cancelled', { reason: '超时' }, { runId: 'run-2' }),
      ev(5, 'user_message_chunk', text('last try'), { runId: 'run-3' }),
      ev(6, 'run_interrupted', {}, { runId: 'run-3' }),
      ev(7, 'run_failed', {}, { runId: 'run-3' }),
    ],
    runs: [appRun('run-1', 'failed', 'deploy', 1), appRun('run-2', 'cancelled', 'deploy again', 3), appRun('run-3', 'interrupted', 'last try', 5)],
  },
  {
    name: '原生回合结局：结果未确认与已停止的消息仍可见，发送前取消的不出现，已完成回合的迟到输出仍算进行中',
    events: [
      ev(1, 'user_message_chunk', text('deploy'), { nativeId: 'msg-u1', nativeTurnId: 'turn-1' }),
      ev(2, 'agent_message_chunk', text('部署中。'), { nativeId: 'msg-a1', nativeTurnId: 'turn-1' }),
      ev(6, 'user_message_chunk', text('retry'), { nativeId: 'msg-u4', nativeTurnId: 'turn-4' }),
      ev(9, 'agent_message_chunk', text('补充一句。'), { nativeId: 'msg-a4', nativeTurnId: 'turn-4' }),
    ],
    runs: [
      nativeRun('run-a', 'interrupted', 'deploy', 1, { delivery: 'cancelled', stage: 'turn_outcome_unknown', nativeMessageId: 'msg-u1', nativeSessionId: 'chat-1', nativeTurnId: 'turn-1' }),
      nativeRun('run-b', 'cancelled', 'never sent', 3, { delivery: 'cancelled' }),
      nativeRun('run-c', 'interrupted', 'stopped in flight', 4, { delivery: 'input_sent' }),
      { ...nativeRun('run-d', 'completed', 'retry', 6, { nativeMessageId: 'msg-u4', nativeSessionId: 'chat-1', nativeTurnId: 'turn-4', timings: { completedAt: ms(8) } }), updatedAt: at(8) },
    ],
    nativeChatId: 'chat-1',
    sessionRunning: true,
  },
  {
    name: '未确认的提交按提示文本认领 CLI 回执而不重复；尚未发送的提示排在末尾',
    events: [
      ev(6, 'user_message_chunk', text('fix the bug'), { nativeId: 'msg-x' }),
      ev(7, 'agent_message_chunk', text('正在修复。'), { nativeId: 'msg-y' }),
    ],
    runs: [
      nativeRun('run-u', 'running', 'fix the bug', 5, { delivery: 'uncertain', timings: { dispatchAt: ms(5) } }),
      nativeRun('run-p', 'queued', 'next step', 8, { delivery: 'queued' }),
    ],
    sessionRunning: true,
  },
  {
    name: '分页窗口只有两轮输出：每条回执按 thread:turn 前缀插回自己回合的输出之前，不走压缩补回',
    events: [
      ev(2, 'agent_message_chunk', text('第一轮的回答。'), { nativeId: 'chat-1:t1:item-1', nativeTurnId: 't1' }),
      ev(3, 'tool_call', { toolCallId: 'call-1', title: 'ls', status: 'completed' }, { nativeId: 'chat-1:t1:item-2', nativeTurnId: 't1' }),
      ev(6, 'agent_message_chunk', text('第二轮的回答。'), { nativeId: 'chat-1:t2:item-1', nativeTurnId: 't2' }),
    ],
    runs: [
      nativeRun('run-1', 'completed', '第一个问题', 1, { nativeMessageId: 'chat-1:t1:user', nativeSessionId: 'chat-1', nativeTurnId: 't1' }),
      nativeRun('run-2', 'completed', '第二个问题', 5, { nativeMessageId: 'chat-1:t2:user', nativeSessionId: 'chat-1', nativeTurnId: 't2' }),
    ],
    nativeChatId: 'chat-1',
  },
  {
    name: 'steer 的输出带 steer 自己的 runId：归入它所引导的回合',
    events: [
      ev(1, 'user_message_chunk', text('重构解析器'), { nativeId: 'msg-u1', nativeTurnId: 'turn-1' }),
      ev(2, 'agent_message_chunk', text('开始重构。'), { nativeId: 'msg-a1', nativeTurnId: 'turn-1' }),
      ev(3, 'native_input_receipt', { commandId: 'cmd-run-s', content: { type: 'text', text: '顺便补测试' } }, { nativeId: 'msg-s1', nativeTurnId: 'turn-1' }),
      ev(4, 'agent_message_chunk', text('好的，也补上测试。'), { nativeId: 'msg-a2', runId: 'run-s' }),
      ev(5, 'tool_call', { toolCallId: 'call-1', title: 'Run tests', status: 'in_progress' }, { nativeId: 'msg-a3', runId: 'run-s' }),
    ],
    runs: [
      nativeRun('run-a', 'running', '重构解析器', 1, { nativeMessageId: 'msg-u1', nativeSessionId: 'chat-1', nativeTurnId: 'turn-1' }),
      nativeRun('run-s', 'completed', '顺便补测试', 3, { intent: 'steer', ownerRunId: 'run-a', nativeTurnId: 'turn-1', nativeMessageId: 'msg-s1', nativeSessionId: 'chat-1' }),
    ],
    nativeChatId: 'chat-1',
    sessionRunning: true,
  },
  {
    name: '回执不在窗口里、只有状态行带着 run id：提示按时间归位，不插到回答与状态行之间',
    events: [
      ev(5, 'agent_message_chunk', text('部分回答。'), { nativeId: 'msg-a1', runId: 'claude-turn:t1' }),
      ev(6, 'run_cancelled', { reason: '已停止' }, { runId: 'run-1' }),
    ],
    runs: [
      nativeRun('run-1', 'interrupted', '问题', 1, { delivery: 'cancelled', nativeMessageId: 'msg-u1', nativeSessionId: 'chat-1', nativeTurnId: 't1' }),
    ],
    nativeChatId: 'chat-1',
  },
  {
    name: '已确认仍在执行的回合，回执不在窗口里：按时间插回原位，不排到末尾',
    events: [
      ev(1, 'user_message_chunk', text('first'), { nativeId: 'msg-u1', nativeTurnId: 'turn-1' }),
      ev(2, 'agent_message_chunk', text('第一轮完成。'), { nativeId: 'msg-a1', nativeTurnId: 'turn-1' }),
      ev(5, 'agent_message_chunk', text('第二轮进行中。'), { nativeId: 'msg-a2', nativeTurnId: 'turn-2' }),
      ev(6, 'tool_call', { toolCallId: 'call-1', title: 'Edit', status: 'in_progress' }, { nativeId: 'msg-a3', nativeTurnId: 'turn-2' }),
    ],
    runs: [
      nativeRun('run-1', 'completed', 'first', 1, { nativeMessageId: 'msg-u1', nativeSessionId: 'chat-1', nativeTurnId: 'turn-1' }),
      nativeRun('run-2', 'running', 'second', 4, { nativeMessageId: 'msg-u2', nativeSessionId: 'chat-1', nativeTurnId: 'turn-2' }),
    ],
    nativeChatId: 'chat-1',
    sessionRunning: true,
  },
  {
    name: '未确认的在途 steer：按提交时间归入它引导的回合，不排到末尾',
    events: [
      ev(1, 'user_message_chunk', text('重构解析器'), { nativeId: 'msg-u1', nativeTurnId: 'turn-1' }),
      ev(2, 'agent_message_chunk', text('开始重构。'), { nativeId: 'msg-a1', nativeTurnId: 'turn-1' }),
      ev(5, 'agent_message_chunk', text('继续改解析器。'), { nativeId: 'msg-a2', nativeTurnId: 'turn-1' }),
      ev(6, 'tool_call', { toolCallId: 'call-1', title: 'Edit', status: 'in_progress' }, { nativeId: 'msg-a3', nativeTurnId: 'turn-1' }),
    ],
    runs: [
      nativeRun('run-a', 'running', '重构解析器', 1, { nativeMessageId: 'msg-u1', nativeSessionId: 'chat-1', nativeTurnId: 'turn-1' }),
      nativeRun('run-s', 'running', '顺便补测试', 3, { intent: 'steer', ownerRunId: 'run-a', nativeTurnId: 'turn-1', nativeSessionId: 'chat-1', delivery: 'input_sent' }),
      nativeRun('run-q', 'queued', '然后更新文档', 4, { delivery: 'queued' }),
    ],
    nativeChatId: 'chat-1',
    sessionRunning: true,
    activeTurnId: 'turn-1',
  },
  {
    name: '本机副本（client-pending）早于分页窗口：失败的引导草稿仍可见，窗口外已确认的回合照常不补',
    events: [
      ev(5, 'user_message_chunk', text('窗口里的问题'), { nativeId: 'msg-u2', nativeTurnId: 'turn-2' }),
      ev(6, 'agent_message_chunk', text('窗口里的回答。'), { nativeId: 'msg-a2', nativeTurnId: 'turn-2' }),
    ],
    runs: [
      nativeRun('run-old', 'completed', '窗口外的问题', 1, { nativeMessageId: 'msg-u0', nativeSessionId: 'chat-1', nativeTurnId: 'turn-0' }),
      nativeRun('run-2', 'completed', '窗口里的问题', 5, { nativeMessageId: 'msg-u2', nativeSessionId: 'chat-1', nativeTurnId: 'turn-2' }),
      { ...nativeRun('run-local', 'failed', '没发出去的引导', 2, { intent: 'steer', fingerprint: 'client-pending', delivery: 'failed', stage: 'outbox_failure', attempt: 0 }), error: '引导记录格式无效' },
    ],
    nativeChatId: 'chat-1',
  },
  {
    name: '压缩活动不算回合输出：只有思考与压缩行时，底部工作行仍让位给思考行',
    events: [
      ev(1, 'user_message_chunk', text('继续'), { runId: 'run-1' }),
      ev(2, 'agent_thought_chunk', text('先整理上下文'), { runId: 'run-1' }),
      activity(3, 'completed', { endedAt: at(3), compaction: { trigger: 'auto', preTokens: 150000, postTokens: 30000 } }),
    ],
    runs: [appRun('run-1', 'running', '继续', 1)],
    sessionRunning: true,
  },
];

type Brief = Record<string, string | number>;

/** What a row shows, without the event it was folded from. */
function brief(row: RowContent): Brief {
  const out: Brief = { kind: row.kind, key: row.key, turn: row.turn, pos: row.pos };
  if (row.runId) out.runId = row.runId;
  switch (row.kind) {
    case 'user':
      out.text = row.text;
      if (row.pending) out.pending = row.pending;
      break;
    case 'assistant':
      out.text = row.text;
      if (row.phase) out.phase = row.phase;
      break;
    case 'thought':
      out.text = row.text;
      out.channel = row.channel;
      break;
    case 'tool': {
      const { status, content } = row.event.data;
      if (typeof status === 'string') out.status = status;
      if (Array.isArray(content)) out.diffs = content.filter((part) => (part as { type?: unknown })?.type === 'diff').length;
      if (row.job) out.job = row.job.status;
      break;
    }
    case 'plan':
      out.entries = row.entries.length;
      break;
    case 'image':
      out.src = row.src;
      break;
    case 'status':
      out.text = row.text;
      out.tone = row.tone;
      break;
    case 'task_notification':
      out.title = row.title;
      out.status = row.status;
      out.taskKind = row.taskKind;
      if (row.jobResult) out.jobResult = row.jobResult.status;
      break;
    case 'activity':
      out.status = row.activity.status;
      break;
  }
  return out;
}

const expected: Record<string, Brief[]> = {
  '普通回合：思考、旁白与回答分行，工具调用与结果并为一行，隐藏与无名的工具不出现': [
    { kind: 'user', key: 'user:cmd-run-1', turn: 'run:run-1', pos: 1536, runId: 'run-1', text: '检查构建' },
    { kind: 'thought', key: 'event:2', turn: 'run:run-1', pos: 2560, runId: 'run-1', text: '锁文件可能过期了', channel: 'thinking' },
    { kind: 'assistant', key: 'event:4', turn: 'run:run-1', pos: 4608, runId: 'run-1', text: '先看看文件。', phase: 'commentary' },
    { kind: 'tool', key: 'tool:run-1:tool-1', turn: 'run:run-1', pos: 5632, runId: 'run-1', status: 'completed', diffs: 1 },
    { kind: 'assistant', key: 'event:9', turn: 'run:run-1', pos: 9728, runId: 'run-1', text: '锁文件过期了，重新安装即可。', phase: 'final_answer' },
    { kind: 'image', key: 'event:11', turn: 'run:run-1', pos: 11776, runId: 'run-1', src: 'data:image/png;base64,iVBORw0KGgo=' },
  ],
  '相邻两轮各有自己的工具行：新一轮复用的 toolCallId 不改写旧卡片': [
    { kind: 'user', key: 'user:cmd-run-1', turn: 'run:run-1', pos: 1536, runId: 'run-1', text: 'first' },
    { kind: 'tool', key: 'tool:run-1:tool-1', turn: 'run:run-1', pos: 2560, runId: 'run-1', status: 'in_progress' },
    { kind: 'assistant', key: 'event:3', turn: 'run:run-1', pos: 3584, runId: 'run-1', text: 'done' },
    { kind: 'user', key: 'user:cmd-run-2', turn: 'run:run-2', pos: 4608, runId: 'run-2', text: 'second' },
    { kind: 'tool', key: 'tool:run-2:tool-1', turn: 'run:run-2', pos: 5632, runId: 'run-2', status: 'completed' },
  ],
  '子 agent：Task 工具行属于发起它的回合，子 agent 的完成通知开启自己的回合': [
    { kind: 'user', key: 'user:cmd-run-a', turn: 'run:run-a', pos: 1536, runId: 'run-a', text: 'review the diff' },
    { kind: 'tool', key: 'tool:task-1', turn: 'run:run-a', pos: 2560, status: 'completed' },
    { kind: 'assistant', key: 'event:msg-a2', turn: 'run:run-a', pos: 4608, text: '子 agent 已开始审查。' },
    { kind: 'task_notification', key: 'event:msg-n1', turn: 'native:session-1:turn-2', pos: 5632, title: 'review', status: 'completed', taskKind: 'agent' },
    { kind: 'assistant', key: 'event:msg-a3', turn: 'native:session-1:turn-2', pos: 6656, text: '审查结论已汇总。' },
  ],
  '计划：平铺与嵌套两种 entries 都读，显式空列表是一次清空，非数组不出行': [
    { kind: 'user', key: 'user:cmd-run-1', turn: 'run:run-1', pos: 1536, runId: 'run-1', text: 'plan it' },
    { kind: 'plan', key: 'event:2', turn: 'run:run-1', pos: 2560, runId: 'run-1', entries: 2 },
    { kind: 'plan', key: 'event:3', turn: 'run:run-1', pos: 3584, runId: 'run-1', entries: 1 },
    { kind: 'plan', key: 'event:4', turn: 'run:run-1', pos: 4608, runId: 'run-1', entries: 0 },
  ],
  '排队与 steer：引导消息按回执归入正在执行的回合，排队消息留在末尾': [
    { kind: 'user', key: 'user:cmd-run-a', turn: 'run:run-a', pos: 1536, runId: 'run-a', text: '重构解析器' },
    { kind: 'assistant', key: 'event:chat-1:t1:item-1', turn: 'run:run-a', pos: 2560, text: '开始重构。' },
    { kind: 'user', key: 'user:cmd-run-s', turn: 'run:run-a', pos: 3584, runId: 'run-s', text: '顺便补测试' },
    { kind: 'tool', key: 'tool:call-1', turn: 'run:run-a', pos: 4608, status: 'in_progress' },
    { kind: 'user', key: 'user:cmd-run-q', turn: 'run:run-q', pos: PENDING_ROW_POS, runId: 'run-q', text: '然后更新文档', pending: 'queued' },
  ],
  '压缩：系统活动原位更新，压缩丢掉的提示由最近一次已确认回合补回，更早的回合不再追加': [
    { kind: 'user', key: 'user:cmd-run-a', turn: 'run:run-a', pos: 1025, runId: 'run-a', text: '继续实现' },
    { kind: 'activity', key: 'activity:claude:c1', turn: 'run:run-a', pos: 10752, status: 'completed' },
    { kind: 'assistant', key: 'event:msg-a2', turn: 'run:run-a', pos: 11776, text: '压缩后继续。' },
    { kind: 'tool', key: 'tool:t-9', turn: 'run:run-a', pos: 13824, status: 'completed' },
  ],
  '任务通知：后台任务的工具行带作业状态，通知的状态与结果只认已知取值': [
    { kind: 'user', key: 'user:cmd-run-1', turn: 'run:run-1', pos: 1536, runId: 'run-1', text: 'run the suite' },
    { kind: 'tool', key: 'tool:run-1:bash-1', turn: 'run:run-1', pos: 2560, runId: 'run-1', status: 'in_progress', job: 'running' },
    { kind: 'assistant', key: 'event:3', turn: 'run:run-1', pos: 3584, runId: 'run-1', text: '已在后台运行。' },
    { kind: 'task_notification', key: 'event:4', turn: 'run:run-1', pos: 4608, title: 'npm test', status: 'completed', taskKind: 'shell', jobResult: 'succeeded' },
    { kind: 'task_notification', key: 'event:5', turn: 'run:run-1', pos: 5632, title: '后台任务', status: 'unknown', taskKind: 'task' },
  ],
  '运行状态行：失败、停止与中断各有文案，原因跟在后面': [
    { kind: 'user', key: 'user:cmd-run-1', turn: 'run:run-1', pos: 1536, runId: 'run-1', text: 'deploy' },
    { kind: 'status', key: 'event:2', turn: 'run:run-1', pos: 2560, runId: 'run-1', text: 'exit 1', tone: 'danger' },
    { kind: 'user', key: 'user:cmd-run-2', turn: 'run:run-2', pos: 3584, runId: 'run-2', text: 'deploy again' },
    { kind: 'status', key: 'event:4', turn: 'run:run-2', pos: 4608, runId: 'run-2', text: '已停止 · 超时', tone: 'muted' },
    { kind: 'user', key: 'user:cmd-run-3', turn: 'run:run-3', pos: 5632, runId: 'run-3', text: 'last try' },
    { kind: 'status', key: 'event:6', turn: 'run:run-3', pos: 6656, runId: 'run-3', text: '已中断', tone: 'muted' },
    { kind: 'status', key: 'event:7', turn: 'run:run-3', pos: 7680, runId: 'run-3', text: '任务失败', tone: 'danger' },
  ],
  '原生回合结局：结果未确认与已停止的消息仍可见，发送前取消的不出现，已完成回合的迟到输出仍算进行中': [
    { kind: 'user', key: 'user:cmd-run-a', turn: 'run:run-a', pos: 1536, runId: 'run-a', text: 'deploy' },
    { kind: 'assistant', key: 'event:msg-a1', turn: 'run:run-a', pos: 2560, text: '部署中。' },
    { kind: 'user', key: 'user:cmd-run-c', turn: 'run:run-c', pos: 2561, runId: 'run-c', text: 'stopped in flight', pending: 'unconfirmed' },
    { kind: 'user', key: 'user:cmd-run-d', turn: 'run:run-d', pos: 6656, runId: 'run-d', text: 'retry' },
    { kind: 'assistant', key: 'event:msg-a4', turn: 'run:run-d', pos: 9728, text: '补充一句。' },
  ],
  '未确认的提交按提示文本认领 CLI 回执而不重复；尚未发送的提示排在末尾': [
    { kind: 'user', key: 'user:cmd-run-u', turn: 'run:run-u', pos: 6656, runId: 'run-u', text: 'fix the bug' },
    { kind: 'assistant', key: 'event:msg-y', turn: 'run:run-u', pos: 7680, text: '正在修复。' },
    { kind: 'user', key: 'user:cmd-run-p', turn: 'run:run-p', pos: PENDING_ROW_POS, runId: 'run-p', text: 'next step', pending: 'queued' },
  ],
  '分页窗口只有两轮输出：每条回执按 thread:turn 前缀插回自己回合的输出之前，不走压缩补回': [
    { kind: 'user', key: 'user:cmd-run-1', turn: 'run:run-1', pos: 1025, runId: 'run-1', text: '第一个问题' },
    { kind: 'assistant', key: 'event:chat-1:t1:item-1', turn: 'run:run-1', pos: 2560, text: '第一轮的回答。' },
    { kind: 'tool', key: 'tool:call-1', turn: 'run:run-1', pos: 3584, status: 'completed' },
    { kind: 'user', key: 'user:cmd-run-2', turn: 'run:run-2', pos: 3585, runId: 'run-2', text: '第二个问题' },
    { kind: 'assistant', key: 'event:chat-1:t2:item-1', turn: 'run:run-2', pos: 6656, text: '第二轮的回答。' },
  ],
  'steer 的输出带 steer 自己的 runId：归入它所引导的回合': [
    { kind: 'user', key: 'user:cmd-run-a', turn: 'run:run-a', pos: 1536, runId: 'run-a', text: '重构解析器' },
    { kind: 'assistant', key: 'event:msg-a1', turn: 'run:run-a', pos: 2560, text: '开始重构。' },
    { kind: 'user', key: 'user:cmd-run-s', turn: 'run:run-a', pos: 3584, runId: 'run-s', text: '顺便补测试' },
    { kind: 'assistant', key: 'event:msg-a2', turn: 'run:run-a', pos: 4608, runId: 'run-s', text: '好的，也补上测试。' },
    { kind: 'tool', key: 'tool:run-s:call-1', turn: 'run:run-a', pos: 5632, runId: 'run-s', status: 'in_progress' },
  ],
  '回执不在窗口里、只有状态行带着 run id：提示按时间归位，不插到回答与状态行之间': [
    { kind: 'assistant', key: 'event:msg-a1', turn: 'run:claude-turn:t1', pos: 5632, runId: 'claude-turn:t1', text: '部分回答。' },
    { kind: 'status', key: 'event:6', turn: 'run:run-1', pos: 6656, runId: 'run-1', text: '已停止', tone: 'muted' },
  ],
  '已确认仍在执行的回合，回执不在窗口里：按时间插回原位，不排到末尾': [
    { kind: 'user', key: 'user:cmd-run-1', turn: 'run:run-1', pos: 1536, runId: 'run-1', text: 'first' },
    { kind: 'assistant', key: 'event:msg-a1', turn: 'run:run-1', pos: 2560, text: '第一轮完成。' },
    { kind: 'user', key: 'user:cmd-run-2', turn: 'run:run-2', pos: 2561, runId: 'run-2', text: 'second' },
    { kind: 'assistant', key: 'event:msg-a2', turn: 'run:run-2', pos: 5632, text: '第二轮进行中。' },
    { kind: 'tool', key: 'tool:call-1', turn: 'run:run-2', pos: 6656, status: 'in_progress' },
  ],
  '未确认的在途 steer：按提交时间归入它引导的回合，不排到末尾': [
    { kind: 'user', key: 'user:cmd-run-a', turn: 'run:run-a', pos: 1536, runId: 'run-a', text: '重构解析器' },
    { kind: 'assistant', key: 'event:msg-a1', turn: 'run:run-a', pos: 2560, text: '开始重构。' },
    { kind: 'user', key: 'user:cmd-run-s', turn: 'run:run-a', pos: 2561, runId: 'run-s', text: '顺便补测试', pending: 'unconfirmed' },
    { kind: 'assistant', key: 'event:msg-a2', turn: 'run:run-a', pos: 5632, text: '继续改解析器。' },
    { kind: 'tool', key: 'tool:call-1', turn: 'run:run-a', pos: 6656, status: 'in_progress' },
    { kind: 'user', key: 'user:cmd-run-q', turn: 'run:run-q', pos: PENDING_ROW_POS, runId: 'run-q', text: '然后更新文档', pending: 'queued' },
  ],
  '本机副本（client-pending）早于分页窗口：失败的引导草稿仍可见，窗口外已确认的回合照常不补': [
    { kind: 'user', key: 'user:cmd-run-local', turn: 'run:run-local', pos: 1025, runId: 'run-local', text: '没发出去的引导', pending: 'failed' },
    { kind: 'user', key: 'user:cmd-run-2', turn: 'run:run-2', pos: 5632, runId: 'run-2', text: '窗口里的问题' },
    { kind: 'assistant', key: 'event:msg-a2', turn: 'run:run-2', pos: 6656, text: '窗口里的回答。' },
  ],
  '压缩活动不算回合输出：只有思考与压缩行时，底部工作行仍让位给思考行': [
    { kind: 'user', key: 'user:cmd-run-1', turn: 'run:run-1', pos: 1536, runId: 'run-1', text: '继续' },
    { kind: 'thought', key: 'event:2', turn: 'run:run-1', pos: 2560, runId: 'run-1', text: '先整理上下文', channel: 'narration' },
    { kind: 'activity', key: 'activity:claude:c1', turn: 'run:run-1', pos: 3584, status: 'completed' },
  ],
};

const jobsOf = (scenario: Scenario) => scenario.jobs ? new Map(Object.entries(scenario.jobs)) : undefined;

describe('timeline projection contract', () => {
  it('joins an exact native queue receipt before its message id is persisted without adding another prompt', () => {
    const sending = nativeRun('queued-input', 'running', 'follow-up', 1, { delivery: 'input_sent', stage: 'input_sent' });
    const receipt = ev(2, 'native_input_receipt', { commandId: sending.commandId, ...text('follow-up') }, {
      runId: sending.id, nativeId: 'queue-receipt',
    });
    const before = buildTimeline(projectEvents([receipt]), [sending]);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ kind: 'user', key: 'user:cmd-queued-input', run: sending });
    const observed = { ...sending, native: { ...sending.native!, nativeMessageId: 'queue-receipt', delivery: 'observed' as const } };
    const after = buildTimeline(projectEvents([receipt]), [observed]);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'user', key: 'user:cmd-queued-input', run: observed });
    const wrong = buildTimeline(projectEvents([{ ...receipt, data: { ...receipt.data, commandId: 'another-command' } }]), [sending]);
    expect(wrong.find(item => item.kind === 'user' && item.run?.id === sending.id)?.key).toBe('user:cmd-queued-input');
    expect(wrong.find(item => (item.event as Partial<NativeWorkbenchEvent>).nativeId === 'queue-receipt')).not.toHaveProperty('run');
  });

  it('files a message queued behind a turn after that turn\'s answer once it is sent, before the store echoes it', () => {
    const events = [
      ev(1, 'user_message_chunk', text('first'), { runId: 'turn:1', nativeId: '1:0' }),
      ev(3, 'agent_message_chunk', text('answer'), { runId: 'turn:1', nativeId: '2:0' }),
    ];
    const queued = nativeRun('queued', 'running', 'second', 2, {
      nativeMessageId: 'request:turn-2', nativeTurnId: 'turn-2', delivery: 'observed', timings: { dispatchAt: ms(4) },
    });
    const items = buildTimeline(projectEvents(events), [queued]);
    expect(items.map(item => item.kind === 'user' || item.kind === 'assistant' ? item.text : item.kind)).toEqual(['first', 'answer', 'second']);
  });

  it('replaces an exact queue receipt with its later human record while keeping native sources and the input key', () => {
    const run = nativeRun('queued-input', 'running', 'follow-up', 1, {
      nativeMessageId: 'queue-receipt', nativeTurnId: 'turn-next', delivery: 'observed',
    });
    const another = nativeRun('another-input', 'running', 'follow-up', 2, { delivery: 'input_sent' });
    const receipt = ev(1, 'native_input_receipt', { commandId: run.commandId, ...text('follow-up') }, { runId: run.id, nativeId: 'queue-receipt' });
    const otherReceipt = ev(2, 'native_input_receipt', { commandId: another.commandId, ...text('follow-up') }, { runId: another.id, nativeId: 'another-receipt' });
    const user = ev(4, 'user_message_chunk', {
      commandId: run.commandId, ...text('follow-up'), attachments: [{ id: 'file-1', name: 'image.png', path: '/tmp/image.png' }],
    }, { runId: 'claude-turn:next', nativeId: 'human-next:0', nativeTurnId: 'turn-next' });
    const events = [receipt, otherReceipt, ev(3, 'agent_message_chunk', text('previous turn finished')), user];
    const timeline = new IncrementalTimeline();
    const runs = [run, another];
    const projected = projectEvents([]);
    const indexes = projectionIndexes(projected);
    for (let count = 1; count <= events.length; count += 1) {
      appendProjectedEvents(projected, [events[count - 1]!], indexes);
      expect(timeline.build(projected, runs)).toEqual(buildTimeline(projectEvents(events.slice(0, count)), runs));
    }
    const users = timeline.items.filter(item => item.kind === 'user');
    expect(users).toHaveLength(2);
    expect(users.map(item => item.key)).toEqual(['user:cmd-another-input', 'user:cmd-queued-input']);
    const joined = users.find(item => item.run?.id === run.id)!;
    expect(joined).toMatchObject({
      key: 'user:cmd-queued-input', attachments: [{ id: 'file-1', name: 'image.png', path: '/tmp/image.png' }],
      event: { type: 'user_message_chunk', sequence: 4, nativeId: 'human-next:0', nativeTurnId: 'turn-next' },
    });
    expect(joined.event.sourceEvents.map(source => (source as Partial<NativeWorkbenchEvent>).nativeId)).toEqual(['queue-receipt', 'human-next:0']);
    expect(buildTimeline(projectEvents([receipt, user]), []).filter(item => item.kind === 'user')).toHaveLength(2);
    const wrong = { ...user, data: { ...user.data, commandId: 'unmatched-command' } };
    expect(buildTimeline(projectEvents([receipt, wrong]), [run]).filter(item => item.kind === 'user')).toHaveLength(2);
  });

  it('retains folded turn authority across a stopped Run and an unprompted native continuation', () => {
    const stopped = nativeRun('stopped', 'cancelled', 'check ssh', 1, { nativeMessageId: 'prompt-1', nativeTurnId: 'old' });
    const projected = projectEvents([
      ev(1, 'user_message_chunk', text('check ssh'), { runId: 'claude-turn:old', nativeId: 'prompt-1' }),
      ev(2, 'tool_call', { toolCallId: 'old-tool', status: 'completed' }, { runId: 'claude-turn:old' }),
      // Provider output can keep the old source Run id even after it starts its own turn.
      ev(3, 'tool_call', { toolCallId: 'next-tool', status: 'in_progress' }, { runId: 'claude-turn:old' }),
    ]);
    const nextTurn = 'native:session-1:claude-turn:continuation';
    const items: TimelineItem[] = [
      { kind: 'user', key: 'prompt', text: 'check ssh', attachments: [], run: stopped, event: projected[0]!, turn: 'run:stopped' },
      { kind: 'tool', key: 'old-tool', event: projected[1]!, turn: 'run:stopped' },
      { kind: 'tool', key: 'next-tool', event: projected[2]!, turn: nextTurn },
    ];
    expect(timelineTurnKeys(items)).toEqual(['run:stopped', 'run:stopped', nextTurn]);
    expect([...analyzeTimelineTurns(items, true, 'claude-turn:continuation').activeTurns]).toEqual([nextTurn]);
    expect([...analyzeTimelineTurns(items, true).activeTurns]).toEqual([nextTurn]);
    expect([...analyzeTimelineTurns(items, true, 'stopped').activeTurns]).toEqual(['run:stopped']);
    expect([...analyzeTimelineTurns(items, false).activeTurns]).toEqual([]);
    expect([...analyzeTimelineTurns(items.slice(0, 2), true).activeTurns]).toEqual([]);
    const stale = items.map(item => item.kind === 'user' ? { ...item, run: { ...stopped, state: 'running' as const } } : item);
    expect([...analyzeTimelineTurns(stale, false).activeTurns]).toEqual([]);
    // A paged tail cannot change ownership by omitting its original human prompt.
    expect(timelineTurnKeys(items.slice(1))).toEqual(['run:stopped', nextTurn]);
    expect([...analyzeTimelineTurns(items.slice(1), true, 'claude-turn:continuation').activeTurns]).toEqual([nextTurn]);
  });

  it('projects a shared native turn failure once while preserving each command outcome and distinct failures', () => {
    const message = '任务运行环境暂不可用，请稍后再试';
    const reason = `unexpected status 502 Bad Gateway: relay 409 Conflict: ${JSON.stringify({
      code: 'TaskRuntimeUnavailable', message,
      details: { retry_info: { retryable: true, retry_after_seconds: 5 } },
    })}, url: http://127.0.0.1:18319/v1/responses`;
    const failure = (sequence: number, runId: string, nativeTurnId: string | undefined, error = reason) => ev(sequence, 'run_failed', {
      commandId: `cmd-${runId}`, error,
    }, { runId, ...(nativeTurnId ? { nativeTurnId } : {}) });
    const events = [
      ev(0, 'extension_update', {}),
      failure(1, 'owner', 't1'),
      failure(2, 'steer', 't1'),
      failure(3, 'other-reason', 't1', 'Connection closed'),
      failure(4, 'next-turn', 't2'),
      failure(5, 'unknown-turn-1', undefined),
      failure(6, 'unknown-turn-2', undefined),
    ];
    const projected = projectEvents(events.slice(0, 1));
    const indexes = projectionIndexes(projected, events[0]);
    const timeline = new IncrementalTimeline();
    const runs: Run[] = [];
    for (let count = 1; count <= events.length; count += 1) {
      if (count > 1) appendProjectedEvents(projected, [events[count - 1]!], indexes);
      expect(timeline.build(projected, runs)).toEqual(buildTimeline(projectEvents(events.slice(0, count)), runs));
    }
    expect(projected.flatMap(event => event.sourceEvents)).toEqual(events);
    expect(timeline.items.map(item => item.event.runId)).toEqual(['owner', 'other-reason', 'next-turn', 'unknown-turn-1', 'unknown-turn-2']);
    // The wire row carries one readable reason plus its full diagnostic, including retry metadata.
    // Its original event survives so replay and mixed-version clients do not lose evidence.
    const rows = timelineRows(timeline.items);
    expect(rows[0]).toMatchObject({ kind: 'status', text: message, detail: reason, event: { data: { error: reason } } });
    expect(rows[1]).toMatchObject({ kind: 'status', text: 'Connection closed' });
    expect(rows[1]).not.toHaveProperty('detail');

    // A revised first outcome rewinds the incremental pass: its steer's original reason is now distinct.
    const revised = projected.slice();
    revised[1] = { ...revised[1]!, data: { ...revised[1]!.data, error: 'Connection closed' } };
    expect(timeline.build(revised, runs)).toEqual(buildTimeline(revised, runs));
    expect(timeline.items.map(item => item.event.runId)).toEqual(['owner', 'steer', 'next-turn', 'unknown-turn-1', 'unknown-turn-2']);
  });

  it('keeps an undelivered preparing steer after its target turn work even when seenAt timestamps are newer', () => {
    const events = [
      ev(1, 'user_message_chunk', text('draw diagram'), { nativeId: 'msg-u1', nativeTurnId: 'turn-1', createdAt: at(1) }),
      ev(2, 'agent_message_chunk', text('working on draft'), { nativeId: 'msg-a1', nativeTurnId: 'turn-1', createdAt: at(10) }),
      ev(3, 'tool_call', { toolCallId: 'call-1', title: 'Write', status: 'completed' }, { nativeId: 'msg-a2', nativeTurnId: 'turn-1', createdAt: at(10) }),
    ];
    const runs = [
      nativeRun('run-a', 'running', 'draw diagram', 1, { nativeMessageId: 'msg-u1', nativeSessionId: 'chat-1', nativeTurnId: 'turn-1' }),
      nativeRun('run-s', 'running', 'keep subtle colors', 5, { intent: 'steer', ownerRunId: 'run-a', nativeTurnId: 'turn-1', nativeSessionId: 'chat-1', delivery: 'preparing' }),
      nativeRun('run-q', 'queued', 'next task', 6, { delivery: 'queued' }),
    ];
    const projected = projectEvents(events);
    const full = buildTimeline(projected, runs, undefined, undefined, 'chat-1');
    const incremental = new IncrementalTimeline().build(projected, runs, undefined, 'chat-1');
    expect(incremental).toEqual(full);
    expect(timelineRows(full).map(row => [row.key, row.turn])).toEqual([
      ['user:cmd-run-a', 'run:run-a'],
      ['event:msg-a1', 'run:run-a'],
      ['tool:call-1', 'run:run-a'],
      ['user:cmd-run-s', 'run:run-a'],
      ['user:cmd-run-q', 'run:run-q'],
    ]);
  });

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const rows = timelineRows(buildTimeline(projectEvents(scenario.events), scenario.runs, jobsOf(scenario), undefined, scenario.nativeChatId));
      expect(rows.map(brief)).toEqual(expected[scenario.name]);
      // Rows are ordered by `pos` and keyed uniquely within a lane.
      expect(rows.map(row => row.pos)).toEqual([...rows.map(row => row.pos)].sort((a, b) => a - b));
      expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
    });
  }

  it('folds incrementally to the same rows as a full build after every event', () => {
    for (const scenario of scenarios) {
      const jobs = jobsOf(scenario);
      const timeline = new IncrementalTimeline();
      for (let count = 1; count <= scenario.events.length; count += 1) {
        const projected = projectEvents(scenario.events.slice(0, count));
        expect(timelineRows(timeline.build(projected, scenario.runs, jobs, scenario.nativeChatId)), `${scenario.name} @${count}`)
          .toEqual(timelineRows(buildTimeline(projected, scenario.runs, jobs, undefined, scenario.nativeChatId)));
      }
    }
  });

  it('sends a row its folded event without the text the row already carries', () => {
    const [user, thought] = timelineRows(buildTimeline(projectEvents(scenarios[0]!.events), scenarios[0]!.runs));
    expect(user).toEqual({
      key: 'user:cmd-run-1', pos: 1536, turn: 'run:run-1', runId: 'run-1', kind: 'user', text: '检查构建', attachments: [],
      event: { type: 'user_message_chunk', data: { content: { type: 'text' } }, createdAt: at(1), lastAt: at(1), runId: 'run-1', sourceIds: [] },
    });
    expect(thought).toMatchObject({ kind: 'thought', text: '锁文件可能过期了', event: { data: { content: { type: 'text' }, channel: 'thinking' }, createdAt: at(2), lastAt: at(3) } });
  });

  it('numbers a tail fold under its base, so its anonymous turns and leading run rows stay clear of the rows before it', () => {
    const events = [ev(41, 'agent_message_chunk', text('reply'), { runId: 'run-l' }), ev(43, 'user_message_chunk', text('anonymous')), ev(44, 'agent_message_chunk', text('more'))];
    const runs = [
      nativeRun('run-l', 'completed', 'slash', 40, { nativeMessageId: 'msg-x', nativeSessionId: 'chat-1' }),
      nativeRun('run-q', 'queued', 'next', 50, { delivery: 'queued' }),
    ];
    const rows = timelineRows(buildTimeline(projectEvents(events), runs, undefined, undefined, 'chat-1'), { base: 40 });
    expect(rows.map(brief)).toEqual([
      { kind: 'user', key: 'user:cmd-run-l', turn: 'run:run-l', pos: 40 * 1024 + 1, runId: 'run-l', text: 'slash' },
      { kind: 'assistant', key: 'event:41', turn: 'run:run-l', pos: 41 * 1024 + 512, runId: 'run-l', text: 'reply' },
      { kind: 'user', key: 'event:43', turn: 'turn:40:1', pos: 43 * 1024 + 512, text: 'anonymous' },
      { kind: 'assistant', key: 'event:44', turn: 'turn:40:1', pos: 44 * 1024 + 512, text: 'more' },
      { kind: 'user', key: 'user:cmd-run-q', turn: 'run:run-q', pos: PENDING_ROW_POS, runId: 'run-q', text: 'next', pending: 'queued' },
    ]);
  });

  it('keeps every Run upload id when native metadata only names materialised paths', () => {
    const events = [ev(1, 'user_message_chunk', text('看图', {
      attachments: [{ type: 'image', name: 'shot.png', path: '/tmp/cursor/shot.png', mimeType: 'image/png' }],
    }), { runId: 'run-1' })];
    const runs = [nativeRun('run-1', 'completed', '看图', 1, {
      input: { text: '看图', attachmentIds: ['img-id', 'pdf-id'], context: [] }, nativeMessageId: 'msg-u1', nativeSessionId: 'chat-1', nativeTurnId: 'turn-1',
    })];
    const row = timelineRows(buildTimeline(projectEvents(events), runs, undefined, undefined, 'chat-1'))[0]!;
    if (row.kind !== 'user') throw new Error('expected a user row');
    expect(row.attachments).toEqual([{ id: 'img-id', name: 'img-id' }, { id: 'pdf-id', name: 'pdf-id' }]);
  });

  it.each([
    { echo: 'a label without an id', extra: [{ name: 'Attachment 1', type: 'image', mimeType: 'image/png' }] },
    { echo: 'only the PDF', extra: [] },
  ])('keeps all uploads in order when the CLI echoes $echo', ({ extra }) => {
    const pdf = { id: 'pdf-id', name: 'report.pdf', mimeType: 'application/pdf' };
    const events = [ev(1, 'user_message_chunk', text('See attachments', {
      attachments: [pdf, ...extra],
    }), { nativeId: 'msg-u1' })];
    const runs = [nativeRun('run-1', 'completed', 'See attachments', 1, {
      input: { text: 'See attachments', attachmentIds: ['img-id', 'pdf-id', 'text-id'], context: [] }, nativeMessageId: 'msg-u1',
    })];
    const [row] = timelineRows(buildTimeline(projectEvents(events), runs));
    if (row?.kind !== 'user') throw new Error('expected a user row');
    expect(row.attachments).toEqual([{ id: 'img-id', name: 'img-id' }, pdf, { id: 'text-id', name: 'text-id' }]);
  });

  it('places an upload-only message at its native record even when the CLI echoes no attachment details', () => {
    const events = [ev(1, 'user_message_chunk', text(''), { nativeId: 'msg-u1' })];
    const runs = [nativeRun('run-1', 'completed', '', 1, {
      input: { text: '', attachmentIds: ['img-id'], context: [] }, nativeMessageId: 'msg-u1',
    })];
    const rows = timelineRows(buildTimeline(projectEvents(events), runs));
    expect(rows).toMatchObject([{ kind: 'user', text: '', attachments: [{ id: 'img-id', name: 'img-id' }], event: { nativeId: 'msg-u1' } }]);
  });

  it('matches an unconfirmed prompt only within its native chat and with compatible upload ids', () => {
    const image = 'a1000000-0000-4000-8000-000000000001';
    const pdf = 'b1000000-0000-4000-8000-000000000002';
    const otherImage = 'c1000000-0000-4000-8000-000000000003';
    const send = (id: string, second: number, attachmentIds: string[], chat: Partial<NativeRunDetails>) =>
      nativeRun(id, 'interrupted', 'See attachment', second, { ...chat, delivery: 'input_sent', input: { text: 'See attachment', attachmentIds, context: [] } });
    const sends = [
      send('correct', 1, [image, pdf], { nativeSessionId: 'chat' }),
      send('different-upload', 2, [otherImage], { nativeSessionId: 'chat' }),
      send('different-chat', 3, [image], { cursorSessionId: 'previous-chat' }),
    ];
    const receipt = (attachment: Record<string, string>, runs: Run[]) => {
      const events = [ev(4, 'user_message_chunk', text('See attachment', { attachments: [attachment] }), { nativeId: 'receipt' })];
      return timelineRows(buildTimeline(projectEvents(events), runs, undefined, undefined, 'chat')).find(row => row.event.nativeId === 'receipt');
    };
    const photo = { id: image, name: 'photo.png' };
    expect(receipt(photo, sends)).toMatchObject({ runId: 'correct', attachments: [photo, { id: pdf, name: pdf }] });
    const unmatched = receipt(photo, sends.slice(1));
    expect(unmatched).toMatchObject({ attachments: [photo] });
    expect(unmatched?.runId).toBeUndefined();
    expect(receipt({ name: 'Attachment 1' }, [sends[0]!])).toMatchObject({ runId: 'correct' });
  });

  it('keeps native attachments when the Run has no upload ids', () => {
    const events = [ev(1, 'user_message_chunk', text('看图', {
      attachments: [
        { type: 'image', path: '/tmp/cursor/shot.png', mimeType: 'image/png' },
        { id: 'saved-id' },
        { name: 'Attachment 1', type: 'image', mimeType: 'image/png' },
      ],
    }), { runId: 'run-1' })];
    const runs = [appRun('run-1', 'completed', '看图', 1)];
    const row = timelineRows(buildTimeline(projectEvents(events), runs))[0]!;
    if (row.kind !== 'user') throw new Error('expected a user row');
    expect(row.attachments).toEqual([
      { name: 'shot.png', path: '/tmp/cursor/shot.png', type: 'image', mimeType: 'image/png' },
      { id: 'saved-id', name: 'saved-id' },
      { name: 'Attachment 1', type: 'image', mimeType: 'image/png' },
    ]);
  });

  it('reuses a user row only while its attachments stay identical', () => {
    const timeline = new IncrementalTimeline();
    const runs = [appRun('run-1', 'completed', '看图', 1)];
    const before = timeline.build(projectEvents([ev(1, 'user_message_chunk', text('看图'), { runId: 'run-1' })]), runs)[0]!;
    const after = timeline.build(projectEvents([ev(1, 'user_message_chunk', text('看图', {
      attachments: [{ type: 'image', name: 'shot.png', path: '/tmp/cursor/shot.png', mimeType: 'image/png' }],
    }), { runId: 'run-1' })]), runs)[0]!;
    if (before.kind !== 'user' || after.kind !== 'user') throw new Error('expected user rows');
    expect(after.attachments).toEqual([{ name: 'shot.png', path: '/tmp/cursor/shot.png', type: 'image', mimeType: 'image/png' }]);
    expect(after).not.toBe(before);
  });

  it('derives active turn presence and start time without borrowing a settled turn', () => {
    const completed = nativeRun('turn-1', 'completed', 'first', 1, {
      nativeMessageId: 'u1', nativeTurnId: 't1', timings: { completedAt: ms(10) },
    });
    const settledProjected = projectEvents([
      ev(1, 'user_message_chunk', text('first'), { runId: 'turn-1', nativeId: 'u1', nativeTurnId: 't1' }),
      ev(8, 'agent_message_chunk', text('done'), { runId: 'turn-1', nativeId: 'a1', nativeTurnId: 't1' }),
    ]);
    const settledItems: TimelineItem[] = [
      { kind: 'user', key: 'u1', text: 'first', attachments: [], run: completed, event: settledProjected[0]!, turn: 'run:turn-1' },
      { kind: 'assistant', key: 'a1', text: 'done', event: settledProjected[1]!, turn: 'run:turn-1' },
    ];
    // New turn woke up while its first row has not landed yet: never borrow the settled turn's clock.
    expect(activeTurnState(settledItems, analyzeTimelineTurns(settledItems, true), at(12))).toEqual({ inTimeline: false, startedAt: ms(12) });
    expect(activeTurnState(settledItems, analyzeTimelineTurns(settledItems, true, 't2'), at(12))).toEqual({ inTimeline: false, startedAt: ms(12) });
    // Stale activeSince from the previous turn is rejected, even when it falls after the last
    // message's coarse event timestamp (before the Run's own completion time).
    expect(activeTurnState(settledItems, analyzeTimelineTurns(settledItems, true), at(2))).toEqual({ inTimeline: false, startedAt: undefined });
    expect(activeTurnState(settledItems, analyzeTimelineTurns(settledItems, true), at(9))).toEqual({ inTimeline: false, startedAt: undefined });
    expect(activeTurnState(settledItems, analyzeTimelineTurns(settledItems, true))).toEqual({ inTimeline: false, startedAt: undefined });

    // Once the wake-up notice lands, the active turn is in the timeline and counts from that notice.
    const wokenProjected = projectEvents([
      ev(15, 'task_notification', { sessionUpdate: 'task_notification', taskId: 'bg-1', kind: 'shell', status: 'failed', title: 'bg' }, { runId: 'turn:bg', nativeTurnId: 'turn:bg' }),
    ]);
    const withWake: TimelineItem[] = [
      ...settledItems,
      { kind: 'task_notification', key: 'n1', taskId: 'bg-1', taskKind: 'shell', status: 'failed', title: 'bg', event: wokenProjected[0]!, turn: 'native:session-1:turn:bg' },
    ];
    expect(activeTurnState(withWake, analyzeTimelineTurns(withWake, true), at(12))).toEqual({ inTimeline: true, startedAt: ms(15) });

    // A live steered turn keeps counting from its opening prompt rather than resetting on the steer.
    const running = nativeRun('turn-2', 'running', 'go', 20, { nativeMessageId: 'u2', nativeTurnId: 't2' });
    const steer = nativeRun('steer-2', 'running', 'also check', 25, { nativeMessageId: 'u2s', nativeTurnId: 't2', intent: 'steer', ownerRunId: 'turn-2' });
    const steeredProjected = projectEvents([
      ev(20, 'user_message_chunk', text('go'), { runId: 'turn-2', nativeId: 'u2', nativeTurnId: 't2' }),
      ev(25, 'user_message_chunk', text('also check'), { runId: 'steer-2', nativeId: 'u2s', nativeTurnId: 't2' }),
    ]);
    const steeredItems: TimelineItem[] = [
      { kind: 'user', key: 'u2', text: 'go', attachments: [], run: running, event: steeredProjected[0]!, turn: 'run:turn-2' },
      { kind: 'user', key: 'u2s', text: 'also check', attachments: [], run: steer, event: steeredProjected[1]!, turn: 'run:turn-2' },
    ];
    expect(activeTurnState(steeredItems, analyzeTimelineTurns(steeredItems, true), at(20))).toEqual({ inTimeline: true, startedAt: ms(20) });
  });
});
