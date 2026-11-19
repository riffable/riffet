/**
 * Recording and replay of the two input channels of the Claude Code driver that have no other
 * record: the transcript JSONL the CLI writes, and the hook and status line payloads it posts to
 * Riffet's hook bridge. `scripts/record-claude.ts` runs a scenario against the real CLI and writes both
 * on one timeline; `recordings.test.ts` feeds the timeline back through the real driver
 * (`ClaudeBackendAdapter`) and compares the journal rows and the phase sequence it produced.
 *
 * One JSONL file per scenario: a meta line, then events in the order they happened. Before a hook
 * is recorded, the transcript bytes written since the last snapshot (and the pane, when it changed)
 * are recorded, so the replay keeps what was on disk when the hook arrived: the CLI writes its
 * transcript in batches and its hooks immediately, which the driver has to cope with.
 *
 * The replay writes no timing: after each event the runtime reads and the journal drains, so a
 * recording replays the same way every time.
 */
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Project, Session, TerminalInfo } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeBackendSendRequest, NativeInteractionReceipt, NativePtyLaunchSpec } from '../types.js';
import { rowsOf } from '../../journal/ingest-contract.js';
import { Journal, laneKey, type JournalRow } from '../../journal/journal.js';
import { TranscriptIngest } from '../../sync/ingest.js';
import { stable, stableRows } from '../codex/recording.js';
import { ClaudeBackendAdapter } from './index.js';

export { stable, stableRows };

/** The identity every recording carries instead of the run's own session id. */
export const RECORDED_SESSION_ID = '00000000-0000-4000-8000-000000000001';
/** Stands for the directory holding the session's transcript; the replay puts its own in. */
export const TRANSCRIPTS_TOKEN = '{{transcripts}}';
export const RECORDED_MODEL = 'synthetic-model-001';

export interface ClaudeRecordingMeta {
  cli: 'claude';
  version: string;
  scenario: string;
  prompts: string[];
  approval: string;
  model: string;
}

export type ClaudeRecordedEvent =
  | { kind: 'send'; text: string }
  /** Bytes appended to a transcript file since the last snapshot; a `.meta.json` carries the whole file. */
  | { kind: 'transcript'; file: string; text: string }
  | { kind: 'hook'; payload: Record<string, unknown> }
  | { kind: 'screen'; text: string }
  | { kind: 'respond'; action: string }
  | { kind: 'stop' };

export interface ClaudeRecording { meta: ClaudeRecordingMeta; events: ClaudeRecordedEvent[] }

export interface ClaudeScenario {
  prompts: string[];
  approval: string;
  /** The turn is stopped once the first assistant text shows. */
  interrupt?: boolean;
  /** A tool call is part of the scenario. */
  tool?: boolean;
  /** A permission card is answered. */
  approve?: boolean;
  /** The scenario starts a subagent. */
  subagent?: boolean;
}

export const CLAUDE_SCENARIOS: Record<string, ClaudeScenario> = {
  answer: { prompts: ['Reply with exactly: ok'], approval: 'bypassPermissions' },
  tool: { prompts: ['Run `ls` with the Bash tool, then reply with only the number of entries it printed.'], approval: 'bypassPermissions', tool: true },
  approval: { prompts: ['Create a file named hello.txt containing the word hello, using the Bash tool (echo hello > hello.txt). Then reply with only: done'], approval: 'manual', tool: true, approve: true },
  interrupt: { prompts: ['Say hello in one short sentence. Then run `sleep 120` with the Bash tool.'], approval: 'bypassPermissions', interrupt: true, tool: true },
  subagent: { prompts: ['Use the Agent tool with a general-purpose subagent to read README.md and report its first line. Then reply with that line only.'], approval: 'bypassPermissions', subagent: true },
};

export function parseRecording(text: string): ClaudeRecording {
  const lines = text.split('\n').filter(line => line.trim());
  return { meta: JSON.parse(lines[0]!) as ClaudeRecordingMeta, events: lines.slice(1).map(line => JSON.parse(line) as ClaudeRecordedEvent) };
}

export function formatRecording(recording: ClaudeRecording): string {
  return [recording.meta, ...recording.events].map(item => JSON.stringify(item)).join('\n') + '\n';
}

/** The `type` of every transcript row of a recording, and the hook event names: what drift compares. */
export function recordingVocabulary(recording: ClaudeRecording): Set<string> {
  const names = new Set<string>();
  for (const event of recording.events) {
    if (event.kind === 'hook') names.add(`hook:${String(event.payload.hook_event_name ?? 'status-line')}`);
    if (event.kind === 'transcript' && event.file.endsWith('.jsonl')) {
      for (const line of event.text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { type?: unknown; subtype?: unknown };
          names.add(`row:${String(row.type)}${typeof row.subtype === 'string' ? `/${row.subtype}` : ''}`);
        } catch { /* a partial line */ }
      }
    }
  }
  return names;
}

export interface ReplayResult { rows: JournalRow[]; /** The rows of each subagent lane the main lane names, by lane. */ lanes: Record<string, JournalRow[]>; phases: string[]; stops?: string[] }

/** What a scenario has to have produced, from the journal rows of its replay and the phases seen. */
export function scenarioProblems(scenario: ClaudeScenario, result: Pick<ReplayResult, 'rows' | 'phases' | 'stops'> & { responded?: number; stopped?: boolean }): string[] {
  const { rows, phases } = result;
  const problems: string[] = [];
  const count = (kind: string) => rows.filter(row => row.kind === kind).length;
  const turns = scenario.prompts.length;
  if (count('meta.turn_started') < turns) problems.push(`${count('meta.turn_started')} turn starts, expected ${turns}`);
  const ended = rows.filter(row => row.kind === 'meta.turn_ended');
  // A turn the CLI reports as interrupted is `cancelled` in the journal (`transcript-source.ts` maps the marker so).
  const status = scenario.interrupt ? 'cancelled' : 'completed';
  if (ended.length < turns) problems.push(`${ended.length} turn ends, expected ${turns}`);
  else if (scenario.interrupt ? (ended.at(-1)?.payload as { status?: string })?.status !== status : ended.some(row => (row.payload as { status?: string })?.status !== status)) {
    problems.push(`turn ends ${JSON.stringify(ended.map(row => (row.payload as { status?: string })?.status))}, expected ${status}`);
  }
  if (phases.at(-1) !== 'idle') problems.push(`the session ends ${phases.at(-1) ?? 'without a phase'}, expected idle`);
  if (count('user_message_chunk') < turns) problems.push(`${count('user_message_chunk')} prompts, expected ${turns}`);
  if (!scenario.interrupt && count('agent_message_chunk') < turns) problems.push(`${count('agent_message_chunk')} answers, expected at least ${turns}`);
  if (scenario.tool && !count('tool_call')) problems.push('no tool call');
  if (scenario.approve && !phases.includes('attention')) problems.push('no permission card (phase attention) was shown');
  if (scenario.approve && !result.responded) problems.push('the permission card was not answered');
  for (const stop of result.stops ?? []) if (stop !== 'ok') problems.push(`the stop was refused: ${stop}`);
  if (scenario.subagent && !rows.some(row => row.kind === 'meta.subagent')) problems.push('no subagent lane');
  return problems;
}

/** A stand-in for the two probes `available()` runs on the executable. */
const stubCli = (version: string) => `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "${version} (Claude Code)"
  exit 0
fi
echo "Usage: claude [options]"
echo "  --settings --session-id --resume --model --permission-mode"
`;

/** A drawn input box: what the pane shows when nothing has been typed. */
const IDLE_SCREEN = ['Welcome back', '', '─'.repeat(60), '❯ ', '─'.repeat(60), '  ? for shortcuts'].join('\n');

class FakeTerminals {
  private terminal?: TerminalInfo;
  screen = IDLE_SCREEN;
  /** Pasted and not yet submitted: the CLI echoes it into the box. */
  typed?: string;
  readonly observers = new Set<(observation: { type: 'exit' | 'state'; terminal: TerminalInfo }) => void>();
  create(projectId: string, sessionId: string): TerminalInfo {
    this.terminal = {
      id: 'terminal-1', projectId, sessionId, title: 'Claude Agent', kind: 'native',
      state: 'running', persistent: true, epoch: 1, cols: 120, rows: 40, createdAt: '',
    };
    return { ...this.terminal };
  }
  get(): TerminalInfo {
    if (!this.terminal) throw new Error('Terminal not found');
    return { ...this.terminal };
  }
  shown(): string {
    return this.typed === undefined ? this.screen : this.screen.replace(/^❯ ?$/m, `❯ ${this.typed.includes('\n') ? `[Pasted text #1 +${this.typed.split('\n').length - 1} lines]` : this.typed}`);
  }
}

export interface ClaudeReplayOptions {
  /** Called with the phase after every event, for tests that want more than the sequence. */
  onStep?: (event: ClaudeRecordedEvent, phase: string) => void;
}

/** How long the runtime gets to settle after an event before the replay goes on. */
const SETTLE_MS = 60;
/** One read of the runtime, and how many in a row have to find the phase unchanged. */
const SETTLE_STEP_MS = 30;
const SETTLE_STILL = 4;
/** The longest the replay waits for the phase a hook is meant to bring about. */
const SETTLE_UNTIL_MS = 3_000;
/** The longest a hook is given to be answered. */
const HOOK_WAIT_MS = 3_000;

/**
 * Plays a recording through `ClaudeBackendAdapter` with an in-memory host: a stub CLI, a temp config dir whose
 * transcript directory takes the recorded files, fake terminals showing the recorded pane, and a `Journal`
 * fed by a `TranscriptIngest` as the service does. Resolves with the journal rows and the phases seen.
 */
export async function replayRecording(recording: ClaudeRecording, options: ClaudeReplayOptions = {}): Promise<ReplayResult & { responded: number; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'riffet-claude-replay-'));
  const executable = join(root, 'claude-stub');
  await writeFile(executable, stubCli(recording.meta.version), { mode: 0o755 });
  await chmod(executable, 0o755);
  const configDir = join(root, 'config');
  const transcripts = join(configDir, 'projects', '-workspace-project');
  await mkdir(transcripts, { recursive: true });
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const nativeSessionId = RECORDED_SESSION_ID;
  await writeFile(join(transcripts, `${nativeSessionId}.jsonl`), '');

  const id = 'recording-session';
  const project: Project = { id: 'recording-project', name: 'Project', cwd: workspace, createdAt: '', updatedAt: '' };
  let session: Session = {
    id, projectId: project.id, kind: 'native', title: 'Recording', tags: [], state: 'idle',
    mode: 'agent', model: recording.meta.model, approval: recording.meta.approval, backendId: 'claude', backendProfileId: 'local',
    nativeSessionId, configRevision: 1, createdAt: '', updatedAt: '',
  };
  const update = (patch: Partial<Session>) => { session = { ...session, ...patch }; return structuredClone(session); };
  const profile: NativeBackendProfileConfig = { id: 'local', backendId: 'claude', name: 'Claude Code CLI', config: { executable, configDir } };
  const terminals = new FakeTerminals();
  const launches: NativePtyLaunchSpec[] = [];
  const receipts = new Map<string, NativeInteractionReceipt>();
  const host = {
    getSession: () => structuredClone(session),
    getProject: () => project,
    updateSession: (_id: string, patch: Partial<Session>) => update(patch),
    bumpConfig: (_id: string, patch: Partial<Session>) => update({ ...patch, configRevision: (session.configRevision ?? 0) + 1 }),
    setNativeSessionId: (_id: string, value: string | undefined) => update({ nativeSessionId: value, cursorSessionId: value }),
    emit: () => undefined,
    emitEvent: () => undefined,
    saveRunMetrics: () => undefined,
    findRunIdByCommand: () => undefined,
    findRunIdByNativeMessage: () => undefined,
    stats: { recordUsage: () => undefined, observeEvents: () => undefined },
    getInteractionReceipt: (_sessionId: string, requestId: string) => receipts.get(requestId),
    saveInteractionReceipt: (_sessionId: string, requestId: string, receipt: NativeInteractionReceipt) => { receipts.set(requestId, receipt); return receipt; },
    readAttachment: async () => { throw new Error('No attachments in recordings'); },
    commitDispatchFence: () => ({}),
    isRunCancelled: () => false,
    launchPty: async (_session: Session, launchProject: Project, spec: NativePtyLaunchSpec) => {
      launches.push(spec);
      return terminals.create(launchProject.id, id);
    },
    terminal: {
      get: async () => terminals.get(),
      screen: async () => terminals.shown(),
      paste: async () => undefined,
      sendKeys: async () => undefined,
      stop: async () => undefined,
      observe: (_terminalId: string, callback: never) => { terminals.observers.add(callback); return () => terminals.observers.delete(callback); },
      subscribe: () => () => undefined,
      withInteraction: async (_terminalId: string, task: (control: never) => Promise<unknown>) => task({
        screen: async () => terminals.shown(),
        keys: async (keys: string[]) => { if (keys.includes('Enter')) terminals.typed = undefined; },
        paste: async (text: string) => { terminals.typed = text; },
      } as never),
    },
    withSessionLock: async <T>(_sessionId: string, operation: () => Promise<T> | T) => await operation(),
  } as unknown as NativeBackendHost;

  const adapter = new ClaudeBackendAdapter();
  const journal = new Journal(new DatabaseSync(':memory:'));
  const ingest = new TranscriptIngest({ journal, source: () => adapter.transcript(host, structuredClone(session), profile) });
  host.transcript = {
    drain: sessionId => ingest.drain(sessionId),
    endTurn: (sessionId, turnId, status, at, error) => ingest.endTurn(sessionId, turnId, status, at, error),
    withSource: (sessionId, task) => ingest.control(sessionId, task),
    wake: sessionId => ingest.wake(sessionId),
  };
  const release = ingest.follow(id);

  const phases: string[] = [];
  const phase = () => adapter.status(host, structuredClone(session)).phase;
  const note = () => { const current = phase(); if (phases.at(-1) !== current) phases.push(current); return current; };
  const read = async () => {
    const runtime = await (adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<{ monitor(): Promise<void>; refreshTranscript(): Promise<void> }> })
      .ensureRuntime(host, structuredClone(session), project, profile, false);
    await runtime.monitor();
    await runtime.refreshTranscript();
    await ingest.drain(id);
  };
  /** Reads until the phase has held still for a few reads: the runtime's own timers move it between events. */
  const settle = async (until?: (phase: string) => boolean) => {
    const deadline = Date.now() + (until ? SETTLE_UNTIL_MS : 0);
    let stillFor = 0;
    let last = '';
    for (let rounds = 0; ; rounds += 1) {
      await new Promise(resolve => setTimeout(resolve, SETTLE_STEP_MS));
      await read();
      const current = note();
      stillFor = current === last ? stillFor + 1 : 0;
      last = current;
      if (until && !until(current) && Date.now() < deadline) continue;
      if (stillFor >= SETTLE_STILL) return;
    }
  };

  const opened = await adapter.openOrResume(host, structuredClone(session), project, profile);
  if (opened.terminalId) update({ terminalId: opened.terminalId });
  note();
  const url = launches.at(-1)?.env?.RIFFET_CLAUDE_HOOK_URL;
  const token = launches.at(-1)?.env?.RIFFET_CLAUDE_HOOK_TOKEN;
  if (!url || !token) throw new Error('The stub CLI was not handed a hook bridge');
  let deliveries = 0;
  let responded = 0;
  /** How each stop ended: `ok`, or the error code it was refused with. */
  const stops: string[] = [];
  let turn = 0;
  const transcriptPath = (file: string) => join(transcripts, file === 'main' ? `${nativeSessionId}.jsonl` : join(nativeSessionId, file));
  const restore = (text: string) => text.replaceAll(TRANSCRIPTS_TOKEN, transcripts);

  for (const event of recording.events) {
    if (event.kind === 'send') {
      turn += 1;
      const request: NativeBackendSendRequest = {
        session: structuredClone(session), project, profile, commandId: `command-${turn}`, runId: `run-${turn}`,
        input: { text: event.text, attachmentIds: [], context: [] },
        config: { mode: 'agent' },
        commitDispatchFence: () => ({} as never),
      };
      // The send waits for the CLI to take the prompt in (the UserPromptSubmit hook and its row), which the replay delivers after it.
      void adapter.send(host, request).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    } else if (event.kind === 'transcript') {
      const file = transcriptPath(event.file);
      await mkdir(dirname(file), { recursive: true });
      if (event.file.endsWith('.meta.json')) await writeFile(file, restore(event.text));
      else await appendFile(file, restore(event.text));
    } else if (event.kind === 'hook') {
      deliveries += 1;
      const payload = JSON.parse(restore(JSON.stringify(event.payload))) as Record<string, unknown>;
      const posted = fetch(`${url}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ deliveryId: `delivery-${deliveries}`, payload }),
      }).then(response => response.text()).catch(() => undefined);
      // The driver holds a permission request until the card is answered; every other hook answers at once.
      if (payload.hook_event_name === 'PermissionRequest') await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
      else await Promise.race([posted, new Promise(resolve => setTimeout(resolve, HOOK_WAIT_MS))]);
    } else if (event.kind === 'screen') {
      terminals.screen = event.text;
    } else if (event.kind === 'respond') {
      const card = adapter.interaction(host, structuredClone(session));
      if (card) {
        responded += 1;
        await adapter.respond(host, structuredClone(session), profile, { interactionId: card.id, revision: card.revision, requestId: `recording-answer-${responded}`, action: event.action });
      }
    } else if (event.kind === 'stop') {
      // Named the way a client names it: the turn, terminal and epoch the status published. The CLI's
      // answer to the key is in the events that follow, so the stop is not awaited.
      const active = adapter.status(host, structuredClone(session)).activeTurn;
      const terminal = terminals.get();
      const expectedStop = {
        requestId: `recording-stop-${stops.length + 1}`, nativeSessionId: active?.nativeSessionId ?? session.nativeSessionId!,
        ...(active?.turnId ? { turnId: active.turnId } : {}), terminalId: terminal.id, terminalEpoch: terminal.epoch,
      };
      void adapter.interrupt(host, structuredClone(session), profile, { expectedStop })
        .then(() => { stops.push('ok'); }, (error: { code?: string }) => { stops.push(error?.code ?? 'error'); });
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    }
    await settle(event.kind === 'hook' && event.payload.hook_event_name === 'SessionStart' ? current => current !== 'starting' : undefined);
    options.onStep?.(event, phases.at(-1) ?? '');
  }
  // Whatever the last event started finishes here: the runtime's own timers, bounded.
  for (let rounds = 0; rounds < 3; rounds += 1) await settle();

  await ingest.drain(id);
  const rows = rowsOf(journal, id);
  const lanes: Record<string, JournalRow[]> = {};
  for (const row of rows) {
    const lane = row.kind === 'meta.subagent' ? (row.payload as { lane?: unknown }).lane : undefined;
    if (typeof lane === 'string' && lane.startsWith('sub:')) lanes[lane] = rowsOf(journal, laneKey(id, lane as `sub:${string}`));
  }
  return {
    rows, lanes, phases, responded, stops,
    dispose: async () => { release(); ingest.close(); await adapter.close().catch(() => undefined); await rm(root, { recursive: true, force: true }).catch(() => undefined); },
  };
}
