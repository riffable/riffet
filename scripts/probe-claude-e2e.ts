/**
 * Manual real-CLI probe of the Claude Code backend, driven through the in-process server.
 *
 *   node --import tsx scripts/probe-claude-e2e.ts [--source <model source id> | --profile <name>] [--model <alias>] [--only 1,5,10] [--out report.json] [--timeout <seconds>] [--capture <dir>]
 *
 * `--source <id>` runs every conversation through a Claude profile on that model source (written into the
 * temp state dir, never into the user's), and picks the model from that source's catalog unless `--model`
 * names one. Without it the CLI's own route is used.
 * `--profile <name>` instead copies that Claude profile (a custom LLM: address, key, models) of the user's own
 * Riffet into the temp state dir, read only, and uses its DeepSeek V4.1 Flash unless `--model` names another.
 *
 * `--capture <dir>` writes the TUI screens the parsers read (composer, agent list, dialogs, the Background list) to
 * `<dir>/<CLI version>/<name>.txt`, temp paths, home and the names of `RIFFET_FIXTURE_REDACTIONS_FILE` scrubbed: real screens per CLI version for the tests.
 *
 * Each conversation is read the way a client reads it, over the sync v3 stream of its main lane
 * (scripts/probe-sync-e2e-lib.ts): seq contiguous and unique, the last answer of every turn delivered,
 * and every interaction card after the text in front of it.
 *
 * Isolation: a private state directory, tmux socket, Git project and ephemeral loopback port.
 * When testing restart takeover, the directory lives under the user's home so closing the test
 * server leaves its tmux sessions alive. Cleanup removes the directory and its tmux server.
 * The real Claude config dir is still used (credentials); transcripts of the temp project land in
 * `<config>/projects/<encoded temp cwd>` and are left there.
 *
 * The probe only reports. Each scenario records the session/phase/run timelines and the transcript
 * record kinds it produced; a failed scenario never stops the next one.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { crc32 as zlibCrc32, deflateSync } from 'node:zlib';
import type { NativeActivity, NativeInteraction, NativeStatus, NativeStopRequest, NativeWorkbenchEvent, Run, Session, SyncFrame, TimelineRow } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/server/src/app.js';
import { JournalFeed, latestEvents } from '../apps/server/src/journal/feed.js';
import { ClaudeHookBridge } from '../apps/server/src/backends/claude/hook-bridge.js';
import { sourceEndpoint } from '../apps/server/src/backends/shared/model-source.js';
import { getScreenMarkers } from '../apps/server/src/adapters/cli/registry.js';
import {
  CLAUDE_CODE_PASTE_PLACEHOLDER_PATTERN, claudeAgentRows, claudeBackgroundScreen, claudeComposer, claudeFooterFocused, claudeTasksEntryFocused, claudeTasksEntryShown, claudeViewsSubagent,
} from '../apps/server/src/adapters/cli/claude-code.js';
import { localRedactions } from './terminal-fixture-guards.js';
import { copyRiffetProfile, initProbeProject, openLane, requireCli, type LaneStream } from './probe-sync-e2e-lib.js';

// The probe may itself be launched from inside a Claude Code / Riffet session; those variables would
// make the CLI it starts behave like a nested child instead of the standalone launch Riffet does.
for (const name of Object.keys(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|RIFFET_CLAUDE_HOOK_.*|AI_AGENT)$/.test(name)) delete process.env[name];
}

const args = process.argv.slice(2);
/** `--name value` or `--name=value`. */
const option = (name: string, fallback: string) => {
  const joined = args.find(arg => arg.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  return args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
};
const modelOverride = option('--model', '');
const modelSource = option('--source', '');
/** `--profile <name>`: a Claude profile of the user's own Riffet (a custom LLM route), copied into the temp state dir. */
const profileName = option('--profile', '');
requireCli(process.env.CLAUDE_CLI?.trim() || 'claude', 'Claude Code', 'Install Claude Code (`npm i -g @anthropic-ai/claude-code`) and sign in, or set CLAUDE_CLI.');
const only = new Set(option('--only', '').split(',').filter(item => item.trim()).map(item => Number(item.trim())).filter(Number.isFinite));
const outFile = option('--out', '');
const scenarioSeconds = Number(option('--timeout', '300'));
const captureDir = option('--capture', '');
/** The CLI version the captured screens belong to. */
const cliVersion = captureDir ? /\d+\.\d+\.\d+/.exec(execFileSync(process.env.CLAUDE_CLI?.trim() || 'claude', ['--version'], { encoding: 'utf8' }))?.[0] ?? 'unknown' : '';
const started = Date.now();
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const log = (message: string) => console.error(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);

// ---------------------------------------------------------------------------------------------
// Isolated environment
// ---------------------------------------------------------------------------------------------
const testsRestart = only.size === 0 || only.has(6);
const directory = await realpath(await mkdtemp(testsRestart
  ? join(homedir(), '.riffet-claude-e2e-')
  : join(tmpdir(), 'riffet-claude-e2e-')));
const stateDir = join(directory, 'state');
const projectDir = join(directory, 'project');
const SLEEPER_SECONDS = 70;
async function prepareProject(): Promise<void> {
  await initProbeProject(projectDir);
  await mkdir(join(projectDir, '.claude', 'agents'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'agents', 'sleeper.md'), `---
name: sleeper
description: Runs a long sleep in the background. Use only when explicitly asked to use the sleeper subagent.
tools: Bash
background: true
---
Run the Bash command \`printf 'STARTING\\n'; sleep ${SLEEPER_SECONDS}; printf 'DONE\\n'\` and then reply with only the word DONE.
`);
}

/**
 * Machine-specific text a captured screen must not keep: the temp project and directory (as realpath, without
 * `/private`, and as `tmpdir()` spells them), then home. Names listed in `RIFFET_FIXTURE_REDACTIONS_FILE` are replaced too; the brand words stay, since the parsers read them literally.
 */
const scrubs: Array<readonly [string, string]> = [
  ...[projectDir, projectDir.replace(/^\/private/, ''), join(tmpdir(), basename(directory), 'project')].map(path => [path, '/tmp/project'] as const),
  ...(projectDir.startsWith(homedir() + '/') ? [[`~${projectDir.slice(homedir().length)}`, '/tmp/project'] as const] : []),
  ...[directory, directory.replace(/^\/private/, ''), join(tmpdir(), basename(directory))].map(path => [path, '/tmp/riffet-claude-e2e'] as const),
  [homedir(), '~'],
  ...localRedactions,
];
/** Writes a scrubbed pane screen to `<--capture>/<version>/<name>.txt`; without `--capture` it does nothing. */
async function capture(name: string, screen: string): Promise<void> {
  if (!captureDir) return;
  let text = screen;
  for (const [from, to] of scrubs) text = text.split(from).join(to);
  // What the TUI cut short (`/private/var/folders/…/T/wo…`) no longer matches a whole path.
  text = text.replace(/(?:\/private)?\/var\/folders\/[^/\s]+\/[^/\s]+\/T\//g, '/tmp/').replace(/(?:\/private)?\/var\/folders\/\S*/g, '/tmp/…').replace(/\/Users\/[^/\s]+/g, '~');
  text = `${text.split('\n').map(line => line.trimEnd()).join('\n').replace(/\n+$/, '')}\n`;
  const folder = join(resolve(captureDir), cliVersion);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.txt`), text);
  log(`  captured ${name}`);
}

/** The tmux socket TerminalService derives from the state dir (mirrors its constructor). */
function tmuxSocket(): string {
  const candidate = join(resolve(stateDir), 'tmux.sock');
  if (Buffer.byteLength(candidate) <= 90) return candidate;
  const folder = join(tmpdir(), `riffet-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(resolve(stateDir)).digest('hex').slice(0, 12)}`);
  return join(folder, 'tmux.sock');
}
const socket = tmuxSocket();
if (socket.startsWith(join(homedir(), '.local', 'share', 'riffet'))) throw new Error('refusing to use the real Riffet state');
const tmux = (...rest: string[]) => { try { return execFileSync('tmux', ['-S', socket, ...rest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };

type Services = Awaited<ReturnType<typeof createApp>>;
interface Http { code: number; body: any }
let services!: Services;
let headers: Record<string, string> = {};
/** Where the sync streams connect: a loopback port of this probe's own server. */
let listening = { port: 0, cookie: '' };
async function boot(): Promise<void> {
  services = await createApp({ stateDir, cliPath: 'cursor-agent', auth: false });
  await services.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = { host: '127.0.0.1:4337', origin: 'http://127.0.0.1:4337' };
  const auth = await services.app.inject({ url: '/api/auth/status', headers: origin });
  headers = { ...origin, cookie: String(auth.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': auth.json().csrfToken as string };
  listening = { port: (services.app.server.address() as { port: number }).port, cookie: headers.cookie! };
}
/** Never throws on HTTP errors: the probe judges status codes itself. */
async function http(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>): Promise<Http> {
  const response = await services.app.inject({ url, method, headers, ...(payload ? { payload } : {}) });
  let body: any = response.body;
  try { body = response.body ? response.json() : undefined; } catch { /* keep text */ }
  return { code: response.statusCode, body };
}
async function ok(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>): Promise<any> {
  const result = await http(method, url, payload);
  if (result.code >= 400) throw new Error(`${method} ${url}: ${result.code} ${JSON.stringify(result.body)}`);
  return result.body;
}
// Test instrumentation only: log every hook the server routes (event, prompt_id, agent) so a stall can be
// matched against what the CLI actually delivered. The method is wrapped on the instance's prototype, not edited.
const hookLog: Array<{ tool?: string; at: number; session: string; event: string; promptId?: string; agent?: string; ms?: number; error?: string }> = [];
{
  const proto = ClaudeHookBridge.prototype as unknown as { dispatch: (payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal) => Promise<unknown> };
  const original = proto.dispatch;
  proto.dispatch = async function (this: unknown, payload, deliveryId, signal) {
    const entry = { tool: String(payload.tool_name ?? ''), at: Date.now(), session: String(payload.session_id ?? '').slice(0, 8), event: String(payload.hook_event_name ?? payload.event ?? '?'), ...(payload.prompt_id ? { promptId: String(payload.prompt_id).slice(0, 8) } : {}), ...(payload.agent_id ? { agent: String(payload.agent_id).slice(0, 6) } : {}) } as (typeof hookLog)[number];
    if (entry.event === '?') entry.event = `?[${Object.keys(payload).filter(key => key !== 'session_id').slice(0, 8).join(',')}${payload.type ? ' type=' + String(payload.type) : ''}${payload.source ? ' source=' + String(payload.source) : ''}]`;
    hookLog.push(entry);
    try { return await original.call(this, payload, deliveryId, signal); }
    catch (error) { entry.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { entry.ms = Date.now() - entry.at; }
  };
}

// ---------------------------------------------------------------------------------------------
// Result bookkeeping
// ---------------------------------------------------------------------------------------------
interface Check { name: string; ok: boolean; evidence: string; kind: 'defect' | 'limit' }
interface Result {
  n: number; title: string; pass: boolean; checks: Check[]; timelines: string[]; notes: string[]; rows: string[]; ms: number;
}
const results: Result[] = [];
/** (scenario, action) -> transcript record kinds, for the section-9 table. */
const contract: Array<{ scenario: number; action: string; kinds: string[] }> = [];

const snip = (value: unknown, max = 160) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return (text ?? '').replace(/\s+/g, ' ').slice(0, max); };
const rel = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** The system activity an event carries (`session/update` with `sessionUpdate: 'activity'`). */
const activityOf = (event: NativeWorkbenchEvent): NativeActivity | undefined => event.data.sessionUpdate === 'activity' ? event.data.activity as NativeActivity : undefined;

// ---------------------------------------------------------------------------------------------
// Timeline recorder: session.state, native status phase and every Run's delivery/stage/state
// ---------------------------------------------------------------------------------------------
class Recorder {
  t0 = Date.now();
  sessionSteps: Array<[number, string]> = [];
  phaseSteps: Array<[number, string]> = [];
  runSteps = new Map<string, Array<[number, string]>>();
  runOrder: string[] = [];
  notices = new Set<string>();
  errors = new Set<string>();
  live: Array<{ at: number; event: NativeWorkbenchEvent }> = [];
  /**
   * What a client holds of the main lane: every row by key, as its latest change brought it (as an event,
   * so the checks read it like the transcript). `violations` are frames that would leave a client with a
   * gap, an overlap or two rows under one seq.
   */
  held = new Map<string, NativeWorkbenchEvent>();
  private heldTop = -1;
  private sequenceOwner = new Map<number, string>();
  violations: string[] = [];
  private stream?: LaneStream;
  /** When this subscription opened: a turn that began earlier reaches a client through its snapshot, not the stream. */
  attachedAt = 0;
  statuses: Array<{ at: number; status: NativeStatus }> = [];
  /**
   * Every interaction card the client was shown, with what the transcript already held in front of it at that
   * instant and what the client already held of it: the card must not outrun the text that precedes it.
   */
  cards: Array<{ at: number; when: number; tool?: string; id: string; kind: string; requestId?: string; texts: string[]; toolUseOnDisk: boolean; held: string; heldTop: number; landed: string[] }> = [];
  private seenCards = new Set<string>();
  private poll?: NodeJS.Timeout;
  private unwatchStore?: () => void;
  constructor(readonly sessionId: string) {}
  private push(list: Array<[number, string]>, label: string) {
    if (list.at(-1)?.[1] !== label) list.push([Date.now() - this.t0, label]);
  }
  mark(label: string) { this.push(this.sessionSteps, `<${label}>`); this.push(this.phaseSteps, `<${label}>`); }
  sample(): void {
    try {
      const session = services.store.getSession(this.sessionId);
      this.push(this.sessionSteps, session.state);
      if (session.error) this.errors.add(`session.error: ${snip(session.error, 300)}`);
      let status: NativeStatus | undefined;
      try { status = services.nativeBackends.status(this.sessionId); } catch { /* no runtime yet */ }
      if (status) {
        this.push(this.phaseSteps, status.phase + (status.interaction ? `!${status.interaction.kind}` : '') + (status.activeTurn ? '' : ''));
        if (status.notice) this.notices.add(snip(status.notice, 300));
        if (status.connection && status.connection.state !== 'connected') this.notices.add(`connection:${status.connection.state} ${snip(status.connection.message ?? '', 120)}`);
      }
      for (const run of services.store.listRuns(this.sessionId)) {
        if (!this.runSteps.has(run.id)) { this.runSteps.set(run.id, []); this.runOrder.push(run.id); }
        this.push(this.runSteps.get(run.id)!, `${run.state}/${run.native?.delivery ?? '-'}/${run.native?.stage ?? '-'}`);
        if (run.error) this.errors.add(`run ${this.runOrder.indexOf(run.id) + 1}: ${snip(run.error, 300)}`);
      }
    } catch { /* the session may be gone */ }
  }
  attach(): void {
    this.detach();
    this.attachedAt = Date.now();
    // A new stream starts from a snapshot: what it held before is replaced.
    this.held.clear();
    this.sequenceOwner.clear();
    this.heldTop = -1;
    this.stream = openLane(listening, this.sessionId, 'main', undefined, frame => this.onFrame(frame));
    this.unwatchStore = services.store.subscribe(this.sessionId, () => this.sample());
    this.poll = setInterval(() => this.sample(), 200);
    this.sample();
  }
  /** Called synchronously with the status frame, so `held` and the file are the state at the moment the card reaches a client. */
  private noteCard(status: NativeStatus): void {
    const card = status.interaction;
    if (!card || this.seenCards.has(card.id)) return;
    this.seenCards.add(card.id);
    let texts: string[] = [], toolUseOnDisk = false;
    try {
      const rows = readRows(this.sessionId);
      const toolAt = card.requestId ? rows.findIndex(({ row }) => row.type === 'assistant' && Array.isArray(row.message?.content) && row.message.content.some((block: any) => block?.type === 'tool_use' && block.id === card.requestId)) : -1;
      toolUseOnDisk = toolAt >= 0;
      const upTo = rows.slice(0, toolAt >= 0 ? toolAt : rows.length);
      const promptAt = upTo.findLastIndex(({ row }) => isPromptRow(row));
      texts = upTo.slice(promptAt + 1).flatMap(({ row }) => row.type === 'assistant' && !row.isSidechain && Array.isArray(row.message?.content)
        ? row.message.content.filter((block: any) => block?.type === 'text' && String(block.text ?? '').trim()).map((block: any) => String(block.text)) : []);
    } catch { /* no transcript yet: nothing precedes the card */ }
    const entry = {
      at: Date.now() - this.t0, when: Date.now(), id: card.id, kind: card.kind,
      ...(typeof (card.request as { toolName?: unknown } | undefined)?.toolName === 'string' ? { tool: (card.request as { toolName: string }).toolName } : card.kind === 'question' ? { tool: 'AskUserQuestion' } : {}), ...(card.requestId ? { requestId: card.requestId } : {}), texts, toolUseOnDisk,
      held: [...this.held.values()].filter(event => event.type === 'agent_message_chunk').map(textOf).join('\n').replace(/\s+/g, ' '),
      heldTop: Math.max(0, ...[...this.held.values()].map(event => event.sequence)), landed: [],
    } as Recorder['cards'][number];
    this.cards.push(entry);
    // Diagnostic: when the rows of the turn the card belongs to reach the disk, relative to the card.
    const shown = new Set<string>();
    const watch = setInterval(() => {
      try {
        const rows = readRows(this.sessionId);
        const promptAt = rows.findLastIndex(({ row }) => isPromptRow(row));
        const open = hookLog.some(item => item.ms === undefined && (item.event === 'PreToolUse' || item.event === 'PermissionRequest'));
        for (const { i, row } of rows.slice(promptAt + 1)) {
          const blocks = Array.isArray(row.message?.content) ? row.message.content.map((block: any) => String(block?.type)).join('+') : String(row.type);
          const key = `${i}:${row.type}:${blocks}`;
          if (shown.has(key) || !['assistant', 'user'].includes(row.type)) continue;
          shown.add(key);
          entry.landed.push(`${row.type === 'assistant' ? blocks : 'result'}@${Date.now() - this.t0 - entry.at}ms${open ? '(hook open)' : ''}`);
        }
      } catch { /* ignore */ }
    }, 50);
    watch.unref?.();
    setTimeout(() => clearInterval(watch), 40_000).unref?.();
  }
  private onFrame(frame: SyncFrame): void {
    const at = Date.now() - this.t0;
    if (frame.type === 'hello' || frame.type === 'status') {
      this.statuses.push({ at, status: frame.status });
      this.noteCard(frame.status);
    } else if (frame.type === 'reset') {
      this.held.clear(); this.sequenceOwner.clear(); this.heldTop = -1;
    } else if (frame.type === 'snapshot' || frame.type === 'rows') {
      const rows = frame.type === 'rows' ? frame.upserts : frame.rows;
      if (frame.type === 'rows') {
        if (this.heldTop >= 0 && frame.from !== this.heldTop + 1) this.violations.push(`rows ${frame.from}..${frame.to} after ${this.heldTop}: a client would ${frame.from > this.heldTop + 1 ? 'miss' : 'repeat'} changes`);
        this.heldTop = frame.to;
        for (const key of frame.deletes ?? []) this.held.delete(key);
      } else if (frame.final) this.heldTop = frame.asOfSeq;
      for (const row of rows) {
        const owner = this.sequenceOwner.get(row.seq);
        if (owner !== undefined && owner !== row.key) this.violations.push(`seq ${row.seq} shared by ${row.kind}(${row.key.slice(-40)}) and ${owner.slice(-40)}`);
        this.sequenceOwner.set(row.seq, row.key);
        const event = eventOfRow(this.sessionId, row);
        this.held.set(row.key, event);
        if (frame.type === 'rows') this.live.push({ at, event });
      }
    } else return;
    this.sample();
  }
  detach(): void {
    this.stream?.close(); this.unwatchStore?.();
    if (this.poll) clearInterval(this.poll);
    this.stream = this.unwatchStore = this.poll = undefined;
  }
  /** Time (ms from t0) the run first showed a label starting with `prefix`. */
  runAt(runId: string, prefix: string): number | undefined {
    return this.runSteps.get(runId)?.find(([, label]) => label.includes(prefix))?.[0];
  }
  phaseAt(prefix: string, after = 0): number | undefined { return this.phaseSteps.find(([at, label]) => at >= after && label.startsWith(prefix))?.[0]; }
  render(): string[] {
    const fmt = (steps: Array<[number, string]>) => steps.map(([at, label]) => `${label}@${rel(at)}`).join('→') || '-';
    return [
      `Session.state: ${fmt(this.sessionSteps)}`,
      `status.phase : ${fmt(this.phaseSteps)}`,
      ...this.runOrder.map((id, index) => `Run#${index + 1} state/delivery/stage: ${fmt(this.runSteps.get(id)!)}`),
      ...(this.notices.size ? [`notice: ${[...this.notices].join(' | ')}`] : []),
      ...(this.errors.size ? [`error : ${[...this.errors].join(' | ')}`] : []),
    ];
  }
}

// ---------------------------------------------------------------------------------------------
// Claude transcript (private JSONL) readers
// ---------------------------------------------------------------------------------------------
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
function transcriptFile(nativeSessionId: string | undefined): string | undefined {
  if (!nativeSessionId) return undefined;
  const projects = join(configDir, 'projects');
  const preferred = [projectDir, projectDir.replace(/^\/private/, '')].map(cwd => join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeSessionId}.jsonl`));
  for (const candidate of preferred) if (existsSync(candidate)) return candidate;
  try {
    for (const name of readdirSync(projects)) {
      const candidate = join(projects, name, `${nativeSessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* no projects dir */ }
  return undefined;
}
interface Row { i: number; at: number; row: any }
function readRows(sessionId: string): Row[] {
  const file = transcriptFile(services.store.getSession(sessionId).nativeSessionId);
  if (!file) return [];
  const rows: Row[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { const row = JSON.parse(line); rows.push({ i, at: Date.parse(row.timestamp ?? '') || 0, row }); } catch { /* partial line */ }
  });
  return rows;
}
function rowKey(row: any): string {
  const parts = [String(row.type)];
  if (row.subtype) parts.push(`sub=${row.subtype}`);
  if (row.operation) parts.push(`op=${row.operation}`);
  const origin = row.origin?.kind ?? (typeof row.origin === 'string' ? row.origin : undefined);
  if (origin) parts.push(`origin=${origin}`);
  if (row.type === 'attachment' && row.attachment?.type) parts.push(`att=${row.attachment.type}`);
  const content = row.message?.content;
  if (row.type === 'user' && Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) parts.push('tool_result');
  if (row.isMeta) parts.push('meta');
  if (row.isSidechain) parts.push('sidechain');
  return parts.join(' ');
}
function rowText(row: any): string {
  if (typeof row.content === 'string') return row.content;
  const content = row.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((block: any) => block?.text ?? (block?.type === 'tool_use' ? `[tool_use ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 80)}]` : block?.type === 'tool_result' ? '[tool_result]' : `[${block?.type}]`)).join(' ');
  return '';
}
/** A real human/web prompt row: a `user` row that is neither a tool result nor meta. */
const isPromptRow = (row: any) => row.type === 'user' && !row.isMeta && !row.isSidechain
  && !(Array.isArray(row.message?.content) && row.message.content.some((block: any) => block?.type === 'tool_result'));
function summarizeRows(rows: Row[], since: number): { keys: Map<string, { n: number; first: number }>; text: string } {
  const keys = new Map<string, { n: number; first: number }>();
  for (const { row, at } of rows) {
    const key = rowKey(row);
    const entry = keys.get(key) ?? { n: 0, first: at ? at - since : 0 };
    entry.n += 1; keys.set(key, entry);
  }
  return { keys, text: [...keys].map(([key, { n, first }]) => `${key}×${n}@${rel(first)}`).join('; ') };
}
function digest(rows: Row[], since: number, filter: (row: any) => boolean, limit = 30): string[] {
  return rows.filter(item => filter(item.row)).slice(0, limit).map(({ i, at, row }) => {
    const extra = row.type === 'queue-operation' ? ` keys[${Object.keys(row).filter(key => !['type', 'sessionId', 'timestamp'].includes(key)).join(',')}]` : '';
    return `  L${i} @${at ? rel(at - since) : '-'} ${rowKey(row)}${row.promptId || row.prompt_id ? ' prompt_id' : ''}${extra} "${snip(rowText(row), 110)}"`;
  });
}
/** Record kinds with counts and first-seen offsets, for the section-9 table. */
function kindList(rows: Row[], since: number): string[] {
  return [...summarizeRows(rows, since).keys].map(([key, { n, first }]) => `${key}x${n}@${rel(first)}`);
}
function subagentMetas(sessionId: string, activeBackgroundOnly = false): string[] {
  const file = transcriptFile(services.store.getSession(sessionId).nativeSessionId);
  if (!file) return [];
  const dir = join(file.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
      if (activeBackgroundOnly && (meta.requestShape !== 'background' || meta.finished || meta.stoppedByUser)) continue;
      const status = Object.entries(meta).filter(([key, value]) => /status|state|type|kind|depth|background|async/i.test(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')).map(([key, value]) => `${key}=${snip(String(value), 40)}`);
      lines.push(`  ${name.slice(0, 18)}…: fields[${Object.keys(meta).join(',')}] ${status.join(' ')}`);
    } catch { if (!activeBackgroundOnly) lines.push(`  ${name}: unreadable`); }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Workbench event helpers
// ---------------------------------------------------------------------------------------------
const textOf = (event: NativeWorkbenchEvent) => (event.data.content as { text?: string } | undefined)?.text ?? '';
/** Each row of the main lane by key, with its seq, as `/timeline/changes` serves them. */
async function laneSeqs(sessionId: string): Promise<{ generation: string; seqs: Map<string, number> }> {
  const changes = await ok('GET', `/api/v3/sessions/${sessionId}/timeline/changes?lane=main&after=0&rows=1000&budget=2097152`) as { generation: string; rows: TimelineRow[] };
  return { generation: changes.generation, seqs: new Map(changes.rows.map(row => [row.key, row.seq])) };
}
/**
 * The conversation's events as sync v3 serves them: its main lane's journal, each entity as it now stands. The
 * share read of the CLI's own files cannot say which run a prompt belongs to, which is the server's to know.
 */
async function events(sessionId: string): Promise<NativeWorkbenchEvent[]> {
  const feed = new JournalFeed(services.store.journal);
  try { return latestEvents(feed.recent(sessionId, 'main', Number.MAX_SAFE_INTEGER).items); }
  finally { feed.close(); }
}
/**
 * A sync row read as the event it was folded from, so live and stored checks share one shape: the type
 * of its first source event, with the folded text and the latest status; `sequence` is the row's lane seq.
 */
function eventOfRow(sessionId: string, row: TimelineRow): NativeWorkbenchEvent {
  const base = { sessionId, sequence: row.seq, nativeId: row.key, createdAt: row.event.createdAt, ...(row.runId ?? row.event.runId ? { runId: row.runId ?? row.event.runId } : {}) };
  switch (row.kind) {
    case 'user': return { ...base, type: 'user_message_chunk', data: { ...row.event.data, content: { type: 'text', text: row.text } } } as NativeWorkbenchEvent;
    case 'assistant': return { ...base, type: 'agent_message_chunk', data: { ...row.event.data, content: { type: 'text', text: row.text } } } as NativeWorkbenchEvent;
    case 'thought': return { ...base, type: 'agent_thought_chunk', data: { ...row.event.data, content: { type: 'text', text: row.text } } } as NativeWorkbenchEvent;
    case 'activity': return { ...base, type: row.event.type, data: { ...row.event.data, sessionUpdate: 'activity', activity: row.activity } } as NativeWorkbenchEvent;
    default: return { ...base, type: row.event.type, data: row.event.data } as NativeWorkbenchEvent;
  }
}
const userEvents = (list: NativeWorkbenchEvent[], needle: string) => list.filter(event => event.type === 'user_message_chunk' && textOf(event).includes(needle));
const rawPrompts = (rows: Row[], needle: string) => rows.filter(({ row }) => isPromptRow(row) && rowText(row).includes(needle));
const rawQueue = (rows: Row[], needle: string, op?: string) => rows.filter(({ row }) => row.type === 'queue-operation' && (!op || row.operation === op) && (!needle || rowText(row).includes(needle)));

// ---------------------------------------------------------------------------------------------
// Scenario context
// ---------------------------------------------------------------------------------------------
class Ctx {
  checks: Check[] = [];
  notes: string[] = [];
  rows: string[] = [];
  recorders: Recorder[] = [];
  sessions: string[] = [];
  deadline: number;
  t0 = Date.now();
  constructor(readonly n: number, readonly title: string, seconds: number) { this.deadline = Date.now() + seconds * 1000; }
  check(name: string, passed: boolean, evidence = '', kind: 'defect' | 'limit' = 'defect') {
    this.checks.push({ name, ok: passed, evidence: snip(evidence, 400), kind });
    log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${passed || !evidence ? '' : ` — ${snip(evidence, 200)}`}`);
  }
  note(text: string) { this.notes.push(text); log(`  note ${snip(text, 220)}`); }
  async until(label: string, test: () => boolean | Promise<boolean>, ms = 60_000): Promise<boolean> {
    const end = Math.min(Date.now() + ms, this.deadline);
    while (!await test()) {
      if (Date.now() >= end) {
        if (Date.now() >= this.deadline) throw new Error(`scenario timeout while waiting for ${label}`);
        return false;
      }
      await sleep(200);
    }
    return true;
  }
  /** Wait for a run to reach a terminal state; false on timeout. */
  async settle(runId: string, ms = 120_000): Promise<Run> {
    await this.until(`run ${runId.slice(0, 6)} to finish`, () => ['completed', 'failed', 'interrupted', 'cancelled'].includes(services.store.getRun(runId).state), ms);
    return services.store.getRun(runId);
  }
  phase(sessionId: string): string { try { return services.nativeBackends.status(sessionId).phase; } catch { return 'n/a'; } }
  /** Idle with every Run finished, held for 2.5s so the short busy pulse after a turn is not mistaken for rest. */
  async quiet(sessionId: string, ms = 60_000): Promise<boolean> {
    let since = 0;
    return this.until('idle with no unfinished runs', () => {
      const runs = services.store.listRuns(sessionId);
      const calm = this.phase(sessionId) === 'idle' && runs.every(run => ['completed', 'failed', 'interrupted', 'cancelled'].includes(run.state));
      if (!calm) { since = 0; return false; }
      since ||= Date.now();
      return Date.now() - since >= 2500;
    }, ms);
  }
  private stallTimers: NodeJS.Timeout[] = [];
  private stalls = new Set<string>();
  /**
   * While a Run is unfinished although the CLI already logged the end of its turn (stop_hook_summary),
   * capture the pane once per stall: that is the evidence for "Claude finished but Riffet still says busy".
   */
  watchStalls(sessionId: string, rec: Recorder) {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const live = services.store.listRuns(sessionId).filter(run => run.state === 'running');
          if (!live.length) return;
          const run = live[0]!;
          const startedAt = rec.t0 + (rec.runAt(run.id, '/observed/') ?? 0);
          const stops = readRows(sessionId).filter(({ row }) => row.type === 'system' && row.subtype === 'stop_hook_summary' && Date.parse(row.timestamp) >= startedAt);
          const last = stops.at(-1);
          if (!last || Date.now() - last.at < 8000) return;
          const key = `${run.id}:${last.i}`;
          if (this.stalls.has(key)) return;
          this.stalls.add(key);
          const terminalId = services.store.getSession(sessionId).terminalId;
          const screen = terminalId ? (await services.terminal.screen(terminalId)) ?? '' : '';
          const lines = screen.trimEnd().split(/\r?\n/);
          const tail = lines.slice(-8).map(line => line.trimEnd()).join(' / ');
          const markers = getScreenMarkers('claude-code');
          const verdict = `busyPattern=${markers.busyPattern.test(lines.slice(-8).join('\n'))} readyPattern=${markers.readyPattern.test(lines.slice(-8).join('\n'))}`;
          const hooks = hookLog.filter(item => services.store.getSession(sessionId).nativeSessionId?.startsWith(item.session) && item.at >= startedAt - 1000).map(item => `${item.event}${item.promptId ? ':' + item.promptId : ''}${item.agent ? ':agent' : ''}@${rel(item.at - rec.t0)}${item.ms !== undefined ? '/' + item.ms + 'ms' : '/pending'}${item.error ? '!' + item.error : ''}`);
          this.note(`STALL @${rel(Date.now() - rec.t0)}: Run#${rec.runOrder.indexOf(run.id) + 1} still ${run.state}/${run.native?.delivery} ${rel(Date.now() - last.at)} after the CLI's stop_hook_summary (nativeTurnId=${run.native?.nativeTurnId?.slice(0, 8)} expectsTurnOutcome=${run.native?.expectsTurnOutcome}); status ${statusLine(sessionId)}; hooks routed to this session since the Run started: [${hooks.join(' ')}]; product screen verdict: ${verdict}; last 8 pane lines: ${snip(tail, 520)}`);
        } catch { /* best effort */ }
      })();
    }, 2000);
    this.stallTimers.push(timer);
  }
  stopWatches() { for (const timer of this.stallTimers) clearInterval(timer); this.stallTimers = []; }
  /** Generic checks every scenario gets: completion lag after the CLI's turn end, and busy pulses with no Run. */
  finalChecks() {
    for (const rec of this.recorders) {
      const rows = readRows(rec.sessionId).filter(({ row }) => row.type === 'system' && row.subtype === 'turn_duration');
      const lags: string[] = [];
      for (const [index, id] of rec.runOrder.entries()) {
        const steps = rec.runSteps.get(id)!;
        const started = steps.find(([, label]) => label.includes('/observed/'))?.[0];
        const done = steps.find(([, label]) => label.startsWith('completed'))?.[0];
        if (started === undefined || done === undefined) continue;
        // Not before the Run was seen: a turn_duration written a moment earlier is the previous turn's (the CLI writes it only after its slowest Stop hook).
        const end = rows.find(item => item.at >= rec.t0 + started);
        if (end && rec.t0 + done - end.at > 15_000) lags.push(`Run#${index + 1}: CLI turn_duration @${rel(end.at - rec.t0)} but Run completed @${rel(done)} (+${rel(rec.t0 + done - end.at)})`);
      }
      this.check(`Run completes soon after the CLI ends the turn (session ${rec.sessionId.slice(0, 6)})`, lags.length === 0, lags.join('; '));
      const pulses: string[] = [];
      for (const [at, label] of rec.phaseSteps) {
        if (!label.startsWith('busy')) continue;
        const next = rec.phaseSteps.find(([when]) => when > at)?.[0] ?? at;
        const mid = (at + next) / 2;
        const open = rec.runOrder.some(id => { const list = rec.runSteps.get(id)!; const idx = list.findLastIndex(([when]) => when <= mid); return idx >= 0 && !/^(completed|failed|interrupted|cancelled)/.test(list[idx]![1]); });
        if (!open && next - at >= 300) pulses.push(`${rel(at)}+${rel(next - at)}`);
      }
      this.check(`stream sequences are unique and increasing, nothing a client would drop (session ${rec.sessionId.slice(0, 6)})`, rec.violations.length === 0, rec.violations.slice(0, 4).join('; '));
      const slowHooks = hookLog.filter(item => (item.ms ?? 0) > 1500 && rec.sessionId && services.store.getSession(rec.sessionId).nativeSessionId?.startsWith(item.session));
      if (slowHooks.length) this.note(`slow hooks (>1.5s): ${slowHooks.map(item => `${item.event}${item.tool ? ':' + item.tool : ''}@${rel(item.at - rec.t0)}+${item.ms}ms`).join(' ')}`);
      const missing: string[] = [];
      let turns = 0;
      const all = readRows(rec.sessionId);
      const lastTextOf = (list: Row[]) => list.flatMap(({ row }) => row.type === 'assistant' && !row.isSidechain && Array.isArray(row.message?.content) ? row.message.content.filter((block: any) => block?.type === 'text' && String(block.text ?? '').trim()).map((block: any) => String(block.text)) : []).at(-1);
      const starts = all.flatMap((item, index) => isPromptRow(item.row) ? [index] : []);
      const held = [...rec.held.values()].filter(event => event.type === 'agent_message_chunk').map(textOf).join('\n');
      for (const [position, start] of starts.entries()) {
        if (all[start]!.at < rec.attachedAt - 200) continue;
        const text = lastTextOf(all.slice(start, starts[position + 1] ?? all.length));
        if (!text) continue;
        turns += 1;
        const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!held.replace(/\s+/g, ' ').includes(probe)) {
          const seen = rec.live.filter(item => item.event.type === 'agent_message_chunk' && textOf(item.event).replace(/\s+/g, ' ').includes(probe)).map(item => `seq${item.event.sequence}@${rel(item.at)}`);
          missing.push(`turn ${position + 1}: "${snip(probe, 40)}" (delivered ${seen.join(',') || 'never'}; held top ${Math.max(0, ...[...rec.held.values()].map(event => event.sequence))}; row at ${rel(all[start]!.at - rec.t0)})`);
        }
      }
      this.check(`the last answer of every turn reached the client (${turns} turn(s), session ${rec.sessionId.slice(0, 6)})`, missing.length === 0, missing.join('; '));
      // Every card must arrive after the assistant text in front of its tool call. "In front of" is judged on the
      // finished transcript: the CLI may write those rows only after the card is up, which is exactly the failure.
      const cardMiss: string[] = [];
      let preceding = 0;
      const claimed = new Set<string>();
      for (const card of rec.cards) {
        const turnStart = all.findLastIndex(item => isPromptRow(item.row) && item.at <= card.when + 500);
        const turnEnd = all.findIndex((item, index) => index > turnStart && isPromptRow(item.row));
        const turn = all.slice(turnStart + 1, turnEnd < 0 ? undefined : turnEnd);
        const call = turn.flatMap(item => item.row.type === 'assistant' && !item.row.isSidechain && Array.isArray(item.row.message?.content)
          ? item.row.message.content.filter((block: any) => block?.type === 'tool_use' && (!card.tool || block.name === card.tool) && !claimed.has(block.id)).map((block: any) => ({ index: item.i, id: String(block.id) })) : [])
          .find(candidate => card.requestId === undefined || !card.id.startsWith('claude-question:') || card.id === `claude-question:${candidate.id}`);
        if (!call) continue;
        claimed.add(call.id);
        const texts = turn.filter(item => item.i < call.index).flatMap(item => item.row.type === 'assistant' && !item.row.isSidechain && Array.isArray(item.row.message?.content)
          ? item.row.message.content.filter((block: any) => block?.type === 'text' && String(block.text ?? '').trim()).map((block: any) => String(block.text)) : []);
        preceding += texts.length;
        for (const text of texts) {
          const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40);
          if (!card.held.includes(probe)) cardMiss.push(`${card.kind} card for ${card.tool ?? '?'} @${rel(card.at)} (${card.texts.length} of the text(s) were on disk then, tool_use ${card.toolUseOnDisk ? 'on disk' : 'not on disk'}; client held up to seq ${card.heldTop}) arrived without "${snip(probe, 40)}" (${text.length} chars)`);
        }
      }
      for (const card of rec.cards) this.note(`card ${card.kind} ${card.id.slice(0, 30)} @${rel(card.at)}: ${card.texts.length} text(s) on disk before it (${card.texts.map(text => text.length).join('+') || '-'} chars), tool_use ${card.toolUseOnDisk ? 'on disk' : 'not on disk'}, client held up to seq ${card.heldTop}; rows reaching the disk after the card: ${card.landed.join(' ') || '-'}`);
      this.check(`every interaction card arrived after the text in front of it (${rec.cards.length} card(s), ${preceding} preceding text(s), session ${rec.sessionId.slice(0, 6)})`, cardMiss.length === 0, cardMiss.join('; '));
      if (pulses.length) this.note(`phantom busy (phase=busy while every Run is finished) x${pulses.length}: ${pulses.slice(0, 6).join(' ')}`);
    }
  }
}

let chosenModel = modelOverride;
let projectId = '';
/** The profile on `--source`, written into this probe's own state dir. */
let profileId = '';
let backendMode = 'default';
interface NewSession { id: string; rec: Recorder; first: Run }
async function newSession(ctx: Ctx, options: { approval?: string; text?: string; waitFirst?: boolean } = {}): Promise<NewSession> {
  const created = await ok('POST', '/api/sessions', {
    projectId, kind: 'native', backendId: 'claude', ...(profileId ? { backendProfileId: profileId } : {}), model: chosenModel, mode: backendMode, approval: options.approval ?? 'bypassPermissions',
    clientSessionId: randomUUID(),
    initialMessage: { commandId: randomUUID(), text: options.text ?? 'Do not use tools. Reply with only the word READY.' },
  });
  const id = created.session.id as string;
  // `--source` never falls back to another route: a session on any other profile ends the probe.
  if ((modelSource || profileName) && created.session.backendProfileId !== profileId) throw new Error(`session ${id} runs on profile ${created.session.backendProfileId ?? 'default'}, not ${profileId}`);
  ctx.sessions.push(id);
  const rec = new Recorder(id);
  ctx.recorders.push(rec);
  rec.attach();
  ctx.watchStalls(id, rec);
  let first = created.run as Run;
  if (options.waitFirst !== false) {
    first = await ctx.settle(first.id, 150_000);
    await ctx.quiet(id, 30_000);
  }
  return { id, rec, first };
}
let sendCounter = 0;
async function send(sessionId: string, text: string, attachments: string[] = []): Promise<Run> {
  sendCounter += 1;
  return await ok('POST', `/api/sessions/${sessionId}/native/send`, { commandId: `probe-${sendCounter}-${randomUUID()}`, text, ...(attachments.length ? { attachments: attachments.map(id => ({ id })) } : {}) });
}
async function stop(sessionId: string): Promise<Http> {
  const session = services.store.getSession(sessionId);
  const terminal = session.terminalId ? await services.terminal.get(session.terminalId) : undefined;
  const active = services.nativeBackends.status(sessionId).activeTurn;
  const nativeSessionId = active?.nativeSessionId ?? session.nativeSessionId;
  if (!nativeSessionId) throw new Error('Cannot stop a Claude session before its native identity is known');
  return await http('POST', `/api/sessions/${sessionId}/cancel`, {
    requestId: randomUUID(), nativeSessionId,
    ...(active?.turnId ? { turnId: active.turnId } : {}),
    ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}),
  } satisfies NativeStopRequest);
}
function png(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = typeof zlibCrc32 === 'function' ? (buffer: Buffer) => zlibCrc32(buffer) >>> 0 : (buffer: Buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const size = 24;
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const offset = y * (size * 3 + 1) + 1 + x * 3; raw[offset] = 220; raw[offset + 1] = 20; raw[offset + 2] = 20; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function uploadPng(): Promise<string> {
  const attachment = await ok('POST', `/api/projects/${projectId}/attachments`, { name: 'red-square.png', mimeType: 'image/png', dataBase64: png().toString('base64'), width: 24, height: 24 });
  return attachment.id as string;
}

// A project subagent declared `background: true`, so launching it never depends on the model remembering run_in_background.
const BG_PROMPT = 'Use the Agent tool to launch the "sleeper" subagent (subagent_type sleeper, run_in_background true) with the prompt "go". As soon as it is launched, end your turn by replying only LAUNCHED. Do not wait for it and do not use any other tool.';
const settled = (run: Run) => ['completed', 'failed', 'interrupted', 'cancelled'].includes(run.state);
const hasBackgroundAgent = (rows: Row[]) => rows.some(({ row }) => row.type === 'assistant' && Array.isArray(row.message?.content)
  && row.message.content.some((block: any) => block?.type === 'tool_use' && /^(Agent|Task)$/.test(block.name) && block.input?.run_in_background === true));
const statusLine = (sessionId: string) => {
  const status = services.nativeBackends.status(sessionId);
  return snip({ phase: status.phase, activeTurn: status.activeTurn ? 'yes' : 'no', activeTurnId: status.activeTurnId?.slice(0, 8), interaction: status.interaction?.title, notice: status.notice, connection: status.connection?.state, session: services.store.getSession(sessionId).state }, 300);
};


// ---------------------------------------------------------------------------------------------
// Model choice: cheapest model that actually answers through this machine's route
// ---------------------------------------------------------------------------------------------
function claudeEnvSettings(): Record<string, string> {
  try { return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')).env ?? {}; } catch { return {}; }
}
/** One real `claude -p` round trip, so a model the route cannot serve is found in seconds rather than as a stuck scenario. */
function cliPing(model: string, seconds: number): Promise<boolean> {
  return new Promise(done => {
    const child = spawn('claude', ['-p', 'Reply only READY', '--model', model, '--no-session-persistence'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: projectDir });
    let out = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(false); }, seconds * 1000);
    child.on('close', code => { clearTimeout(timer); done(code === 0 && /READY/i.test(out)); });
    child.on('error', () => { clearTimeout(timer); done(false); });
  });
}
/** The first of `models` that the `--source` route answers a one-line request for, as the CLI would send it. */
async function sourcePing(models: string[]): Promise<{ model?: string; log: string[] }> {
  const notes: string[] = [];
  const resolved = services.plugins.modelSources().find(source => source.id === modelSource)?.resolve({});
  const route = sourceEndpoint(resolved, 'anthropic-messages'), base = route?.baseUrl, credential = resolved?.credential;
  if (!base || credential?.kind !== 'static') return { log: [resolved?.reason ?? 'the source gives no Claude route with a key'] };
  for (const model of models.slice(0, 8)) {
    const response = await fetch(`${base.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': credential.key, authorization: `Bearer ${credential.key}`, 'anthropic-version': '2023-06-01', ...route?.headers },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply only READY' }] }), signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    if (!(response instanceof Error) && response.ok) { notes.push(`${model}: ok`); return { model, log: notes }; }
    notes.push(`${model}: ${response instanceof Error ? response.message : `${response.status} ${(await response.text().catch(() => '')).slice(0, 160)}`}`);
  }
  return { log: notes };
}

async function pickModel(catalogModels: Array<{ value: string; name?: string }>): Promise<{ model: string; log: string[] }> {
  const notes: string[] = [];
  const candidates: string[] = [];
  const base = process.env.ANTHROPIC_BASE_URL ?? claudeEnvSettings().ANTHROPIC_BASE_URL;
  const haiku = catalogModels.find(model => /haiku/i.test(`${model.value} ${model.name ?? ''}`))?.value;
  if (haiku) candidates.push(haiku);
  if (base) {
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(10_000) });
      const list = ((await response.json()) as { data?: Array<{ id: string; display_name?: string }> }).data ?? [];
      const rank = (item: { id: string; display_name?: string }) => /haiku/i.test(`${item.id}${item.display_name}`) ? 0 : /flash|mini|lite/i.test(`${item.id}${item.display_name}`) ? 1 : 2;
      // `[1m]` is dropped: the server refuses a 1M window it cannot verify for an unknown gateway id.
      candidates.push(...[...list].sort((a, b) => rank(a) - rank(b)).map(item => item.id.replace(/\[1m\]$/i, '')));
      // Gateway ids carry their own `[1m]` markers; the server's own context handling is part of what is probed.
    } catch (error) { notes.push(`gateway list failed: ${error instanceof Error ? error.message : error}`); }
  }
  for (const fallback of ['sonnet', 'opus']) if (!candidates.includes(fallback)) candidates.push(fallback);
  const token = process.env.ANTHROPIC_AUTH_TOKEN ?? claudeEnvSettings().ANTHROPIC_AUTH_TOKEN ?? 'x';
  let tried = 0;
  for (const model of candidates) {
    if (tried >= 8) break;
    if (base && !catalogModels.some(item => item.value === model)) {
      // Cheap HTTP gate before spending a CLI start-up on a route the gateway cannot serve.
      const answered = await fetch(`${base.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply only READY' }] }), signal: AbortSignal.timeout(20_000),
      }).then(response => response.status === 200).catch(() => false);
      if (!answered) { notes.push(`${model}: gateway refused`); continue; }
    }
    tried += 1;
    if (await cliPing(model, 45)) { notes.push(`${model}: ok`); return { model, log: notes }; }
    notes.push(`${model}: CLI did not answer in 45s`);
  }
  throw new Error(`No usable Claude model found (${notes.join('; ')}). Pass --model.`);
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------
async function s1(ctx: Ctx) {
  const needle = 'S1_NEEDLE_ALPHA';
  const { id, rec, first } = await newSession(ctx, { text: `Do not use tools. Reply with only the word S1_OK. (${needle})`, waitFirst: false });
  const run = await ctx.settle(first.id, 150_000);
  await ctx.quiet(id, 30_000);
  ctx.check('Run completed', run.state === 'completed', `state=${run.state} delivery=${run.native?.delivery} error=${run.error ?? ''}`);
  ctx.check('Session reaches idle (starting does not stick)', services.store.getSession(id).state === 'idle' && ctx.phase(id) === 'idle', `session=${services.store.getSession(id).state} phase=${ctx.phase(id)}`);
  const list = await events(id), rows = readRows(id);
  ctx.check('web events: user message exactly once', userEvents(list, needle).length === 1, `events=${userEvents(list, needle).length}`);
  ctx.check('transcript: user prompt row exactly once', rawPrompts(rows, needle).length === 1, `rows=${rawPrompts(rows, needle).length}`);
  const user = userEvents(list, needle)[0];
  ctx.check('user event carries the Run commandId (claimed)', user?.data.commandId === run.commandId, `event.commandId=${user?.data.commandId} run.commandId=${run.commandId}`);
  ctx.check('Run holds nativeTurnId (prompt_id claim)', Boolean(run.native?.nativeTurnId), `nativeTurnId=${run.native?.nativeTurnId}`);
  contract.push({ scenario: 1, action: 'new session + first message', kinds: kindList(rows, rec.t0) });
  if (captureDir) {
    const composer = await paneUntil(id, screen => claudeComposer(screen) !== undefined && composerEmpty(screen));
    if (composer) await capture('composer-idle', composer);
    else ctx.note(`composer-idle: no empty composer; pane tail ${snip(paneScreen(id).split('\n').filter(line => line.trim()).slice(-6), 360)}`);
    await capturePaste(ctx, id);
  }
}

async function s2(ctx: Ctx) {
  const { id, rec } = await newSession(ctx);
  const attachmentId = await uploadPng();
  const needle = 'MULTILINE_MARKER_77';
  const before = readRows(id).length;
  const run = await send(id, `Use the Read tool to open the attached image file (its path is the last line of this message) and reply with only its dominant color word in lowercase.\n${needle} second line.\nThird line.`, [attachmentId]);
  const done = await ctx.settle(run.id, 150_000);
  await ctx.quiet(id, 30_000);
  ctx.check('Run completed', done.state === 'completed', `state=${done.state} error=${done.error ?? ''}`);
  const list = await events(id), rows = readRows(id).slice(before > 0 ? 0 : 0);
  ctx.check('web events: user message exactly once', userEvents(list, needle).length === 1, `events=${userEvents(list, needle).length}`);
  ctx.check('transcript: prompt row exactly once', rawPrompts(rows, needle).length === 1, `rows=${rawPrompts(rows, needle).length}`);
  ctx.check('transcript prompt row contains the attachment path', rawPrompts(rows, needle).some(({ row }) => /red-square\.png/.test(rowText(row))), snip(rawPrompts(rows, needle).map(({ row }) => rowText(row))));
  ctx.check('claimed by prompt_id (Run.nativeTurnId == transcript promptId)', rawPrompts(rows, needle).some(({ row }) => (row.promptId ?? row.prompt_id) === done.native?.nativeTurnId), `run.nativeTurnId=${done.native?.nativeTurnId} rows=${rawPrompts(rows, needle).map(({ row }) => row.promptId ?? row.prompt_id)}`);
  const byType = new Map<string, Set<string>>();
  for (const event of list) { if (!byType.has(event.type)) byType.set(event.type, new Set()); byType.get(event.type)!.add(String(event.runId ?? '-').replace(/^(claude-turn:.{4}).*/, '$1…').slice(0, 14)); }
  ctx.note(`runId per event type in the web snapshot: ${[...byType].map(([type, ids]) => `${type}[${[...ids].join('|')}]`).join(' ')}; Run.id=${run.id.slice(0, 8)}…`);
  const calls = list.filter(event => event.type === 'tool_call' && /read/i.test(String(event.data.toolName ?? event.data.title ?? '')));
  ctx.check('a Read tool_call appears', calls.length > 0, `tool_calls=${list.filter(event => event.type === 'tool_call').map(event => event.data.toolName).join(',')}`);
  for (const call of calls) {
    const updates = list.filter(event => event.type === 'tool_call_update' && event.data.toolCallId === call.data.toolCallId);
    const last = updates.at(-1);
    ctx.check(`Read ${String(call.data.toolCallId).slice(-6)} ends completed`, last?.data.status === 'completed', `statuses=${updates.map(event => event.data.status).join('>') || 'no update'}`);
    ctx.check(`Read ${String(call.data.toolCallId).slice(-6)} call/update runId match`, updates.length > 0 && updates.every(event => event.runId === call.runId), `call.runId=${call.runId?.slice(0, 6)} update.runIds=${updates.map(event => event.runId?.slice(0, 6))} run=${run.id.slice(0, 6)}`);
    ctx.note(`web events are keyed by turn id, not Run id: tool_call.runId=${call.runId} vs Run.id=${run.id} (Run is joined through data.commandId)`);
    const liveCall = rec.live.filter(item => item.event.data.toolCallId === call.data.toolCallId).map(item => item.event.runId);
    if (liveCall.some(value => value !== call.runId)) ctx.check('live-stream update runId matches call', false, `live update runIds=${liveCall.map(value => value?.slice(0, 6))}`);
  }
  contract.push({ scenario: 2, action: 'multi-line + image attachment send', kinds: kindList(rows, rec.t0) });
}

async function s3(ctx: Ctx) {
  const { id, rec } = await newSession(ctx);
  const a = await send(id, 'Run the Bash command `sleep 15`, then reply with only the word FIRST_DONE_31.');
  const ok1 = await ctx.until('first run to be executing a tool', () => rec.live.some(item => item.event.type === 'tool_call' && /bash/i.test(String(item.event.data.toolName ?? ''))) || services.store.getRun(a.id).state === 'completed', 90_000);
  ctx.check('first run reached the Bash tool', ok1, `phase=${ctx.phase(id)}`, 'limit');
  const sentAt = Date.now() - rec.t0;
  const b = await send(id, 'Do not use tools. Reply with only the word SECOND_DONE_32.');
  const [ra, rb] = [await ctx.settle(a.id, 150_000), await ctx.settle(b.id, 150_000)];
  await ctx.quiet(id, 30_000);
  ctx.check('both Runs completed', ra.state === 'completed' && rb.state === 'completed', `A=${ra.state} B=${rb.state} errors=${ra.error ?? ''}|${rb.error ?? ''}`);
  const list = await events(id), rows = readRows(id);
  for (const needle of ['Run the Bash command', 'SECOND_DONE_32']) {
    ctx.check(`web events: "${needle}" user message once`, userEvents(list, needle).length === 1, `events=${userEvents(list, needle).length}`);
    ctx.check(`transcript: "${needle}" prompt row once`, rawPrompts(rows, needle).length === 1, `rows=${rawPrompts(rows, needle).length}`);
  }
  const bStart = rec.runAt(b.id, 'running') ?? rec.runAt(b.id, 'dispatch') ?? rec.runAt(b.id, 'observed');
  const aEnd = rec.runAt(a.id, 'completed');
  ctx.note(`B sent @${rel(sentAt)}; B first left queue @${bStart === undefined ? '?' : rel(bStart)}; A completed @${aEnd === undefined ? '?' : rel(aEnd)} => ${bStart !== undefined && aEnd !== undefined && bStart < aEnd ? 'B was injected while A ran (steer/type-ahead)' : 'B waited in the queue until A finished'}`);
  const queueOps = rawQueue(rows, '').map(({ row }) => `${row.operation}:"${snip(rowText(row), 40)}"`);
  ctx.note(`queue-operation rows: ${queueOps.join(' | ') || 'none'}`);
  contract.push({ scenario: 3, action: 'send while busy (queued by Riffet)', kinds: kindList(rows, rec.t0) });
  ctx.rows.push(...digest(rows, rec.t0, row => row.type === 'queue-operation' || isPromptRow(row)));
}

async function s4(ctx: Ctx) {
  const { id, rec } = await newSession(ctx);
  const run = await send(id, 'Run the Bash command `sleep 30`, then reply with only the word NEVER_REACHED.');
  const running = await ctx.until('Bash running', () => rec.live.some(item => item.event.type === 'tool_call' && /bash/i.test(String(item.event.data.toolName ?? ''))), 90_000);
  ctx.check('turn reached the Bash tool before interrupting', running, `phase=${ctx.phase(id)}`, 'limit');
  await sleep(2000);
  const t = Date.now();
  const response = await stop(id);
  ctx.note(`cancel -> ${response.code} ${snip(response.body, 200)} in ${rel(Date.now() - t)}`);
  ctx.check('cancel returned 2xx without "did not confirm"', response.code < 300 && !/did not confirm/i.test(JSON.stringify(response.body)), `${response.code} ${snip(response.body, 300)}`);
  const idle = await ctx.until('idle', () => ctx.phase(id) === 'idle', 30_000);
  ctx.check('phase returns to idle', idle, `phase=${ctx.phase(id)}`);
  const done = await ctx.settle(run.id, 30_000).catch(() => services.store.getRun(run.id));
  ctx.check('Run closed out (cancelled/interrupted)', settled(done), `state=${done.state} delivery=${done.native?.delivery} error=${done.error ?? ''}`);
  ctx.check('no "did not confirm" in Run/notice/error', ![...ctx.recorders[0]!.errors, ...ctx.recorders[0]!.notices, done.error ?? ''].some(text => /did not confirm/i.test(text)), [...ctx.recorders[0]!.errors].join('|'));
  ctx.check('Session settles at idle', services.store.getSession(id).state === 'idle', `session=${services.store.getSession(id).state}`);
  const follow = await send(id, 'Do not use tools. Reply with only the word AFTER_INT_OK.');
  const fr = await ctx.settle(follow.id, 90_000).catch(() => services.store.getRun(follow.id));
  ctx.check('conversation usable after interrupt', fr.state === 'completed', `follow-up state=${fr.state} error=${fr.error ?? ''}`);
  const rows = readRows(id);
  contract.push({ scenario: 4, action: 'interrupt main turn (Ctrl-C via /cancel)', kinds: kindList(rows.filter(item => item.at >= rec.t0), rec.t0) });
  ctx.rows.push(...digest(rows, rec.t0, row => /interrupt/i.test(rowText(row)) || row.type === 'queue-operation'));
}

/** Row timestamps (ms) of the CLI's own end-of-turn records after a given row index. */
const turnEnds = (rows: Row[], afterIndex: number) => rows.filter(item => item.i > afterIndex && item.row.type === 'system' && item.row.subtype === 'turn_duration');
/** The origin of the prompt that opened a turn the CLI has not ended yet, after its last turn_duration. */
function laterTurn(rows: Row[]): string | undefined {
  const lastEnd = rows.filter(item => item.row.type === 'system' && item.row.subtype === 'turn_duration').at(-1)?.i ?? -1;
  const prompt = rows.filter(item => item.row.type === 'user' && item.row.origin && !item.row.isSidechain).at(-1);
  return prompt && prompt.i > lastEnd ? String(prompt.row.origin.kind ?? 'prompt') : undefined;
}
const backgroundMetas = (sessionId: string) => subagentMetas(sessionId).filter(line => /requestShape=background/.test(line) || /background/.test(line));

/**
 * Shared by 5 and 10: send the launch prompt and wait for the CLI itself to finish the main turn
 * (its turn_duration row), not for the Run. What Riffet shows between that moment and the end of the
 * background task is exactly what the scenarios are about.
 */
async function launchBackground(ctx: Ctx, id: string, rec: Recorder): Promise<{ run: Run; launchedAt: number; mainEndedAt?: number }> {
  const launchedAt = Date.now();
  const before = readRows(id).at(-1)?.i ?? -1;
  const run = await send(id, BG_PROMPT);
  const ended = await ctx.until('the CLI to end the main turn', () => turnEnds(readRows(id), before).length > 0, 120_000);
  const rows = readRows(id);
  const mainEndedAt = turnEnds(rows, before)[0]?.at;
  const metas = subagentMetas(id);
  ctx.note(`launch turn: CLI ended the main turn ${mainEndedAt ? rel(mainEndedAt - launchedAt) : '?'} after the send; subagent metas: ${metas.map(line => line.trim()).join(' ; ') || 'none'}`);
  ctx.check('a background subagent was launched (meta requestShape=background)', ended && metas.some(line => /requestShape=background/.test(line) || /launchedWithDefaults|background/.test(line)), `agent tool_use=${rows.flatMap(({ row }) => Array.isArray(row.message?.content) ? row.message.content.filter((block: any) => block?.type === 'tool_use').map((block: any) => `${block.name}${block.input?.subagent_type ? ':' + block.input.subagent_type : ''}${block.input?.run_in_background ? '(bg)' : ''}`) : []).join(',')} metas=${metas.length}`, 'limit');
  void rec;
  return { run, launchedAt, ...(mainEndedAt ? { mainEndedAt } : {}) };
}

async function s5(ctx: Ctx) {
  const { id, rec } = await newSession(ctx);
  const { run, launchedAt, mainEndedAt } = await launchBackground(ctx, id, rec);
  await sleep(3000);
  const afterTurn = statusLine(id);
  const live = services.store.getRun(run.id);
  ctx.note(`3s after the CLI ended the main turn (${mainEndedAt ? rel(Date.now() - mainEndedAt) : '?'} ago): launch Run=${live.state}/${live.native?.delivery}/${live.native?.stage}; ${afterTurn}`);
  ctx.check('launch Run closes when the CLI ends the main turn', live.state === 'completed', `Run=${live.state}/${live.native?.delivery}`);
  // The CLI may take a report (the sleeper's, say) into a turn of its own as soon as the launch turn ends: then it is busy, and so is the status.
  const later = laterTurn(readRows(id));
  if (later) {
    ctx.note(`the CLI is in a later turn (${later}) ${mainEndedAt ? rel(Date.now() - mainEndedAt) : '?'} after ending the launch turn`);
    ctx.check('status.phase = busy while the CLI runs a later turn', ctx.phase(id) === 'busy', `phase=${ctx.phase(id)}`);
    ctx.check('Session.state = running while the CLI runs a later turn', services.store.getSession(id).state === 'running', `session.state=${services.store.getSession(id).state}`);
  } else {
    ctx.check('status.phase = idle while only the background task runs (user expectation)', ctx.phase(id) === 'idle', `phase=${ctx.phase(id)}`);
    ctx.check('Session.state = idle while only the background task runs', services.store.getSession(id).state === 'idle', `session.state=${services.store.getSession(id).state}`);
  }
  await captureAgentScreens(ctx, id);
  // A message to the main agent while the background task still runs.
  const pingAt = Date.now();
  const ping = await send(id, 'Do not use tools. Reply with only the word PING_OK_5.');
  const left = await ctx.until('PING to leave the queue', () => services.store.getRun(ping.id).native?.delivery !== 'queued' || settled(services.store.getRun(ping.id)), 15_000);
  const leftAt = ['dispatching', 'input_sent', 'observed'].map(label => rec.runAt(ping.id, label)).filter((value): value is number => value !== undefined).sort()[0];
  ctx.check('message to the main agent is delivered immediately (not queued behind background work)', left, `delivery=${services.store.getRun(ping.id).native?.delivery}; left queue ${leftAt === undefined ? '?' : rel(rec.t0 + leftAt - pingAt)} after the send`);
  // Stop the background agent only after PING's foreground turn has settled, so its ending cannot invalidate the stop target.
  const pingSettled = await ctx.settle(ping.id, 30_000);
  const foregroundQuiet = settled(pingSettled) && await ctx.quiet(id, 10_000);
  ctx.check('foreground PING settles before stopping background work', foregroundQuiet, `PING=${pingSettled.state}; ${statusLine(id)}`);
  if (!foregroundQuiet) throw new Error('PING did not settle before the background stop');
  const elapsed = (Date.now() - launchedAt) / 1000;
  const pingNow = services.store.getRun(ping.id);
  ctx.note(`before stop (${elapsed.toFixed(0)}s after launch, sleep ${SLEEPER_SECONDS}): PING Run=${pingNow.state}/${pingNow.native?.delivery} ${rel(Date.now() - pingAt)} after the send; launch Run=${services.store.getRun(run.id).state}; ${statusLine(id)}`);
  const bgAlive = elapsed < SLEEPER_SECONDS - 10 && subagentMetas(id, true).length > 0;
  ctx.check('background task still running at stop time', bgAlive, `elapsed=${elapsed.toFixed(0)}s`, 'limit');
  const panes = () => {
    const terminalId = services.store.getSession(id).terminalId;
    const pane = terminalId ? tmux('capture-pane', '-p', '-t', `cw-${terminalId.replace(/-/g, '').slice(0, 20)}`) : '';
    return snip(pane.split('\n').filter(line => line.trim()).slice(-12).join(' / '), 800);
  };
  ctx.note(`pane before the stop: ${panes()}`);
  const stopAt = Date.now();
  const response = await stop(id);
  ctx.note(`stop (POST /cancel) with phase=${ctx.phase(id)} -> ${response.code} ${snip(response.body, 300)} in ${rel(Date.now() - stopAt)}`);
  ctx.note(`pane after the stop: ${panes()}`);
  ctx.check('stop did not report "did not confirm…"', response.code < 300 && !/did not confirm/i.test(JSON.stringify(response.body)), `${response.code} ${snip(response.body, 300)}`);
  const pr = await ctx.settle(ping.id, 100_000).catch(() => services.store.getRun(ping.id));
  ctx.note(`PING Run after stop: ${pr.state}/${pr.native?.delivery}/${pr.native?.stage} error=${pr.error ?? ''}`);
  ctx.check('PING Run reached a terminal state', settled(pr), `state=${pr.state}`);
  const launchRun = services.store.getRun(run.id);
  ctx.check('launch Run closed after stop', settled(launchRun), `state=${launchRun.state}/${launchRun.native?.delivery}`);
  await sleep(8000);
  const rows = readRows(id);
  const killed = rows.filter(({ row }) => row.type === 'system' && row.subtype === 'agents_killed');
  ctx.check('the CLI reported that it stopped the background agent', killed.length > 0, `rows=${killed.length}`);
  ctx.note(`system/agents_killed rows: ${killed.length}${killed[0] ? ` first=${snip(killed[0].row, 240)}` : ''}`);
  ctx.note(`8s after stop: ${statusLine(id)}`);
  ctx.check('phase idle after stop', ctx.phase(id) === 'idle', `phase=${ctx.phase(id)}`);
  ctx.note(`subagents meta after stop:\n${subagentMetas(id).join('\n') || '  none'}`);
  await ctx.quiet(id, 30_000);
  const phantom5 = phantomBusy(id, rec);
  ctx.check('no phantom busy', phantom5.length === 0, phantom5.join(' | '));
  contract.push({ scenario: 5, action: 'background Agent launch / msg during bg / stop', kinds: kindList(rows, rec.t0) });
  ctx.rows.push(...digest(rows, rec.t0, row => row.type === 'queue-operation' || (row.type === 'system' && row.subtype !== 'local_command') || (row.type === 'user' && (row.origin || row.promptId)) || (row.type === 'attachment' && /task|agent|queued/i.test(row.attachment?.type ?? ''))));
}

async function s6(ctx: Ctx) {
  const { id, rec, first } = await newSession(ctx);
  ctx.check('first turn completed before restart', first.state === 'completed', first.state);
  const sessionBefore = services.store.getSession(id);
  const hookFile = join(stateDir, 'claude-hook.json');
  const hookBefore = existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : '';
  const sockets = tmux('list-sessions', '-F', '#{session_name}').trim().split('\n').filter(Boolean);
  const rowsBefore = await laneSeqs(id);
  rec.mark('close services');
  rec.detach();
  await services.app.close();
  await sleep(1500);
  const aliveAfterClose = tmux('list-sessions', '-F', '#{session_name}').trim().split('\n').filter(Boolean);
  ctx.check('CLI keeps running in tmux after services close', aliveAfterClose.length > 0 && aliveAfterClose.length >= sockets.length, `before=${sockets.length} after=${aliveAfterClose.length}`);
  const descriptorBefore = (() => { try { return JSON.parse(hookBefore) as { bootInstanceId?: string; url?: string }; } catch { return {}; } })();
  const hooksBefore = hookLog.length;
  await boot();
  const bootedAt = Date.now();
  rec.mark('createApp again');
  // The CLI that outlived the server posts its hooks to whatever the descriptor says. The descriptor has to be there,
  // and name this server, before any client opens the conversation.
  const published = await ctx.until('the hook descriptor to name the new server', () => {
    try { const now = JSON.parse(readFileSync(hookFile, 'utf8')) as { bootInstanceId?: string }; return Boolean(now.bootInstanceId) && now.bootInstanceId !== descriptorBefore.bootInstanceId; } catch { return false; }
  }, 5_000);
  const descriptorAfter = (() => { try { return JSON.parse(readFileSync(hookFile, 'utf8')) as { bootInstanceId?: string; url?: string; heartbeatAt?: number; pid?: number }; } catch { return {}; } })();
  ctx.check('the hook descriptor exists and names the new server before any client subscribes', published && descriptorAfter.url !== descriptorBefore.url && typeof descriptorAfter.heartbeatAt === 'number' && Date.now() - descriptorAfter.heartbeatAt < 15_000, `before=${descriptorBefore.url} after=${descriptorAfter.url} boot=${descriptorAfter.bootInstanceId?.slice(0, 8)}`);
  // The next thing the old CLI does is reported by its own hooks, with nobody subscribed: type a message in its pane.
  const typed = 'Do not use tools. Reply with only the word S6_TYPED_IN_PANE.';
  tmux('send-keys', '-t', paneOf(id), '-l', typed);
  tmux('send-keys', '-t', paneOf(id), 'Enter');
  const sawBusy = await ctx.until('the server to follow the turn typed in the pane', () => ctx.phase(id) === 'busy', 40_000);
  ctx.check('a hook from the surviving CLI reached the new server and brought its conversation up (busy seen with no subscriber)', sawBusy, `phase=${ctx.phase(id)}`);
  const nativeBefore = sessionBefore.nativeSessionId ?? '';
  const delivered = hookLog.slice(hooksBefore).filter(item => nativeBefore.startsWith(item.session) && item.at >= bootedAt && item.ms !== undefined && !item.error);
  ctx.check('UserPromptSubmit of that turn was delivered', delivered.some(item => item.event === 'UserPromptSubmit'), delivered.map(item => `${item.event}@${rel(item.at - bootedAt)}`).join(' '));
  await ctx.until('the typed turn to end', () => ctx.phase(id) === 'idle', 90_000);
  {
    const rowsAfter = await laneSeqs(id);
    const moved = [...rowsBefore.seqs].filter(([key, seq]) => rowsAfter.seqs.has(key) && rowsAfter.seqs.get(key) !== seq).map(([key, seq]) => `${key.slice(-30)}: ${seq} -> ${rowsAfter.seqs.get(key)}`);
    ctx.check('rows kept their seq and generation across the restart', moved.length === 0 && rowsBefore.generation === rowsAfter.generation, `moved=${moved.slice(0, 4).join('; ')} generation ${rowsBefore.generation} -> ${rowsAfter.generation}`);
  }
  rec.attach();
  await sleep(3000);
  ctx.note(`after takeover: ${statusLine(id)}`);
  const hookAfter = existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : '';
  ctx.note(`claude-hook.json descriptor: before=${snip(hookBefore.replace(/"token":"[^"]*"/, '"token":"…"'), 150)} after=${snip(hookAfter.replace(/"token":"[^"]*"/, '"token":"…"'), 150)}`);
  ctx.check('not stuck in starting after takeover', !['starting', 'offline'].includes(ctx.phase(id)) || await ctx.until('leave starting', () => !['starting', 'offline'].includes(ctx.phase(id)), 20_000), `phase=${ctx.phase(id)}`);
  const needle = 'S6_AFTER_RESTART';
  const run = await send(id, `Do not use tools. Reply with only the word ${needle}.`);
  const done = await ctx.settle(run.id, 120_000).catch(() => services.store.getRun(run.id));
  await ctx.quiet(id, 30_000);
  ctx.check('post-restart Run completed', done.state === 'completed', `state=${done.state} delivery=${done.native?.delivery} stage=${done.native?.stage} error=${done.error ?? ''}`);
  const list = await events(id), rows = readRows(id);
  ctx.check('UserPromptSubmit hook claimed the prompt (nativeTurnId set)', Boolean(done.native?.nativeTurnId), `nativeTurnId=${done.native?.nativeTurnId}`);
  ctx.check('user event carries the new commandId', userEvents(list, needle)[0]?.data.commandId === done.commandId, `event.commandId=${userEvents(list, needle)[0]?.data.commandId}`);
  ctx.check('user message exactly once after restart', userEvents(list, needle).length === 1 && rawPrompts(rows, needle).length === 1, `events=${userEvents(list, needle).length} rows=${rawPrompts(rows, needle).length}`);
  const sessionAfter = services.store.getSession(id);
  ctx.check('same terminal and native session id reused', sessionAfter.terminalId === sessionBefore.terminalId && sessionAfter.nativeSessionId === sessionBefore.nativeSessionId, `terminal ${sessionBefore.terminalId?.slice(0, 6)}→${sessionAfter.terminalId?.slice(0, 6)}`);
  ctx.check('Session.state idle at the end', sessionAfter.state === 'idle', sessionAfter.state);
  const sessionsNow = tmux('list-sessions', '-F', '#{session_name}').trim().split('\n').filter(Boolean);
  ctx.note(`tmux sessions: before restart [${sockets.join(',')}] after [${sessionsNow.join(',')}]; the saved terminal ${sessionBefore.terminalId?.slice(0, 6)} -> ${sessionAfter.terminalId?.slice(0, 6)}`);
  contract.push({ scenario: 6, action: 'send after service restart (takeover)', kinds: kindList(rows, rec.t0) });
}

async function s7(ctx: Ctx) {
  const { id, rec } = await newSession(ctx, { approval: 'default' });
  const configured = await http('POST', `/api/sessions/${id}/native/configure`, { approval: 'manual' });
  ctx.note(`configure approval=manual -> ${configured.code} ${snip(configured.body, 160)}`);
  if (configured.code >= 400) ctx.note('manual rejected; staying on "default" (Claude asks for Bash by default)');
  await ctx.quiet(id, 60_000);
  const endpoint = `/api/sessions/${id}/native/interaction`;
  async function permissionRound(label: string, file: string, action: 'allow' | 'deny') {
    const command = `touch ${file}`;
    const run = await send(id, `First write a plain-text explanation of at least 150 words about why file permissions matter (no tools yet). Only after that, in the same response, run exactly this shell command: ${command}   Your turn is not over until the command ran. Then reply with only the word DONE_${label}.`);
    // A screen card may be replaced by the hook. Wait for the protocol card with the exact command.
    const appeared = await ctx.until(`protocol permission card (${label})`, () => {
      const status = services.nativeBackends.status(id);
      return status.phase === 'attention' && status.interaction?.transport === 'protocol';
    }, 120_000);
    ctx.check(`${label}: attention phase + protocol card appears`, appeared, `phase=${ctx.phase(id)} run=${run.state}/${run.native?.delivery}`);
    if (!appeared) return;
    if (captureDir && action === 'allow') {
      // Claude Code draws its own dialog beside the held PermissionRequest hook.
      const dialog = await paneUntil(id, screen => /^\s*(?:❯\s*)?1\.\s+Yes/m.test(screen), 8000);
      if (dialog) await capture('permission-dialog', dialog);
      else ctx.note(`permission-dialog: the pane shows no dialog while the card is up; pane tail ${snip(paneScreen(id).split('\n').filter(line => line.trim()).slice(-10), 500)}`);
    }
    const current = await ok('GET', endpoint) as NativeInteraction;
    if (current?.kind !== 'permission' || current.transport !== 'protocol' || current.message !== command) {
      throw new Error(`The ${label} permission card does not show exactly ${command}`);
    }
    if (!current.actions.some(item => item.id === action)) throw new Error(`No one-time ${action} action on the ${label} card`);
    const answered = await ok('POST', endpoint, { interactionId: current.id, revision: current.revision, requestId: randomUUID(), action });
    ctx.note(`${label} ${action} -> ${snip(answered, 160)}`);
    const done = await ctx.settle(run.id, 120_000);
    await ctx.quiet(id, 30_000);
    const created = existsSync(join(projectDir, file));
    if (action === 'allow') {
      ctx.check(`${label}: approve -> Run completed and file created`, done.state === 'completed' && created, `state=${done.state} created=${created} error=${done.error ?? ''}`);
    } else {
      ctx.check(`${label}: deny -> file NOT created, Run finished, phase idle`, !created && settled(done) && ctx.phase(id) === 'idle', `state=${done.state} created=${created} phase=${ctx.phase(id)} error=${done.error ?? ''}`);
    }
  }
  await permissionRound('APPROVE', 'approved.txt', 'allow');
  await permissionRound('DENY', 'denied.txt', 'deny');
  const rows = readRows(id);
  contract.push({ scenario: 7, action: 'permission approve / deny', kinds: kindList(rows, rec.t0) });
}

async function s8(ctx: Ctx) {
  const { id, rec } = await newSession(ctx);
  const warm = await send(id, 'Do not use tools. Reply with only a two-sentence greeting.');
  await ctx.settle(warm.id, 90_000);
  await ctx.quiet(id, 30_000);
  const before = readRows(id).length;
  const run = await send(id, '/compact');
  const done = await ctx.settle(run.id, 150_000).catch(() => services.store.getRun(run.id));
  const idle = await ctx.until('idle after /compact', () => ctx.phase(id) === 'idle', 90_000);
  ctx.check('phase returns to idle after /compact', idle, `phase=${ctx.phase(id)} run=${done.state}/${done.native?.delivery}/${done.native?.stage}`);
  ctx.check('/compact Run is not misjudged (completed)', done.state === 'completed', `state=${done.state} delivery=${done.native?.delivery} stage=${done.native?.stage} error=${done.error ?? ''}`);
  ctx.check('Session.state idle', services.store.getSession(id).state === 'idle', services.store.getSession(id).state);
  const follow = await send(id, 'Do not use tools. Reply with only the word AFTER_COMPACT_OK.');
  const fr = await ctx.settle(follow.id, 90_000).catch(() => services.store.getRun(follow.id));
  ctx.check('conversation usable after /compact', fr.state === 'completed', `state=${fr.state} error=${fr.error ?? ''}`);
  const rows = readRows(id);
  contract.push({ scenario: 8, action: '/compact', kinds: kindList(rows.slice(before), rec.t0) });
  ctx.rows.push(...digest(rows.slice(before), rec.t0, row => row.type !== 'assistant' || true, 14));
}

async function s10(ctx: Ctx) {
  const { id, rec } = await newSession(ctx);
  const { launchedAt } = await launchBackground(ctx, id, rec);
  await sleep(2000);
  ctx.note(`before send: ${statusLine(id)}; launch Run=${services.store.listRuns(id).at(-1)?.state}`);
  const attachmentId = await uploadPng();
  const needle = 'IMG_OK_10_MARKER';
  const sinceRow = readRows(id).at(-1)?.i ?? -1;
  const sentAt = Date.now();
  const run = await send(id, `Do not use tools. Reply with only ${needle} (the attached image path is on the last line).`, [attachmentId]);
  ctx.note(`send accepted: Run delivery=${run.native?.delivery} stage=${run.native?.stage} (HTTP ${Date.now() - sentAt}ms)`);
  await sleep(Math.max(0, 700 - (Date.now() - sentAt)));
  const stopAt = Date.now();
  const stopStatus = statusLine(id);
  const stopResult = await stop(id);
  ctx.note(`stop @+${((stopAt - sentAt) / 1000).toFixed(1)}s after send (${stopStatus}) -> ${stopResult.code} ${snip(stopResult.body, 300)} (took ${rel(Date.now() - stopAt)})`);
  ctx.check('stop returned 2xx (no "did not confirm")', stopResult.code < 300, `${stopResult.code} ${snip(stopResult.body, 300)}`);
  const afterStop = services.store.getRun(run.id);
  ctx.note(`Run right after stop: ${afterStop.state}/${afterStop.native?.delivery}/${afterStop.native?.stage}; ${statusLine(id)}`);
  ctx.note(`delivery path: POST /native/send -> Run queued -> dispatch.execute -> ClaudeRuntime.send: pastes text + attachment-path lines into the composer (not /native/steer: steer rejects images). renderedText=${snip(afterStop.native?.renderedText ?? '(not rendered)', 220)}`);
  // Watch for the CLI submitting the message, even long after the stop.
  const limitMs = Math.min(SLEEPER_SECONDS * 1000 + 40_000, Math.max(30_000, ctx.deadline - Date.now() - 15_000));
  let seenAt: number | undefined;
  await ctx.until('the CLI to submit the text', () => {
    const hit = rawPrompts(readRows(id), needle)[0];
    if (hit && seenAt === undefined) seenAt = Date.now();
    return Boolean(hit) && Date.now() - (seenAt ?? Date.now()) > 6000;
  }, limitMs);
  const rows = readRows(id).filter(item => item.i > sinceRow);
  const finalRun = services.store.getRun(run.id);
  ctx.note(`Run final: ${finalRun.state}/${finalRun.native?.delivery}/${finalRun.native?.stage} error=${finalRun.error ?? ''}; ${statusLine(id)}`);
  const prompts = rawPrompts(rows, needle);
  const queued = rawQueue(rows, needle);
  ctx.note(`CLI rows after the send: queue-operation mentioning the text: ${queued.map(({ row, i, at }) => `L${i}@${rel(at - sentAt)} ${row.operation}`).join(', ') || 'none'}; user prompt rows: ${prompts.map(({ i, at }) => `L${i}@${rel(at - sentAt)}`).join(', ') || 'none'}; bg launched ${((sentAt - launchedAt) / 1000).toFixed(0)}s before the send`);
  const cancelledRun = ['cancelled', 'interrupted', 'failed'].includes(finalRun.state);
  // A stop that lands after the CLI took the text interrupts that turn: the Run is then rightly closed, and the
  // CLI wrote its interruption marker after the submission. A ghost is the CLI submitting text Riffet had
  // already closed the Run for.
  const closedAt = rec.t0 + (rec.runAt(run.id, 'cancelled') ?? rec.runAt(run.id, 'interrupted') ?? Number.POSITIVE_INFINITY - rec.t0);
  // A stop before the model produced anything leaves no record at all; the proof that the CLI did not run the
  // message after its Run was closed is that no assistant row ever answers it.
  const answered = readRows(id).filter(item => item.i > sinceRow && item.row.type === 'assistant' && rowText(item.row).includes(needle));
  ctx.check('no ghost send: the CLI never submitted a message after Riffet closed its Run as cancelled', !(cancelledRun && prompts.some(item => item.at > closedAt + 500)), `Run=${finalRun.state} closed@${cancelledRun ? rel(closedAt - sentAt) : '-'}; CLI user rows for the text=${prompts.length}${prompts[0] ? ` first@${rel(prompts[0].at - sentAt)} after the send` : ''}`);
  ctx.check('Run state matches reality: running/completed, or closed by a stop the CLI never answered', prompts.length === 0 || ['running', 'completed'].includes(finalRun.state) || (cancelledRun && answered.length === 0), `Run=${finalRun.state}, CLI submitted=${prompts.length > 0}, answers=${answered.length}`);
  ctx.check('submitted text contains the attachment path', prompts.length === 0 || prompts.some(({ row }) => /red-square\.png|riffet-attachments/.test(rowText(row))), `row text=${snip(prompts.map(({ row }) => rowText(row)), 240)}`);
  ctx.check('message submitted at most once', prompts.length <= 1, `rows=${prompts.length}`);
  const list = await events(id);
  ctx.check('no duplicate user events in the web timeline', userEvents(list, needle).length <= 1, `events=${userEvents(list, needle).length}`);
  ctx.rows.push(...digest(rows, sentAt, row => row.type === 'queue-operation' || isPromptRow(row) || (row.type === 'system' && /agents_killed|turn_duration/.test(row.subtype ?? '')) || (row.type === 'attachment' && /queued|task/i.test(row.attachment?.type ?? ''))));
  const phantom10 = phantomBusy(id, rec);
  ctx.check('no phantom busy', phantom10.length === 0, phantom10.join(' | '));
  contract.push({ scenario: 10, action: 'send text+image during bg task, stop within 1s', kinds: kindList(rows, sentAt) });
}

/** Every state of every activity the client was sent, per activity id, in the order they arrived. */
function activityStates(rec: Recorder): Map<string, NativeActivity[]> {
  const byId = new Map<string, NativeActivity[]>();
  for (const { event } of rec.live) {
    const activity = activityOf(event);
    if (activity) byId.set(activity.id, [...(byId.get(activity.id) ?? []), activity]);
  }
  return byId;
}
const latestOf = (states: Map<string, NativeActivity[]>, id: string) => states.get(id)?.at(-1);

/**
 * "Phantom busy": the phase says busy while the CLI itself shows no turn. A turn is what the transcript says it is
 * (a prompt or a task report, up to the turn_duration that follows); a busy stretch with no Run open that overlaps
 * none of them has no cause. Returns the stretches, with what the hooks and the rows were doing around them.
 */
function phantomBusy(sessionId: string, rec: Recorder): string[] {
  const rows = readRows(sessionId);
  const turns: Array<[number, number]> = [];
  let open: number | undefined;
  for (const { row, at } of rows) {
    if (isPromptRow(row) && !(typeof row.message?.content === 'string' && /^<local-command-std/.test(row.message.content))) open ??= at || undefined;
    if (row.type === 'system' && row.subtype === 'turn_duration' && open !== undefined) { turns.push([open, at]); open = undefined; }
    if (row.type === 'system' && row.subtype === 'compact_boundary' && open !== undefined) { turns.push([open, at]); open = undefined; }
  }
  if (open !== undefined) turns.push([open, Date.now()]);
  const found: string[] = [];
  for (const [index, [at, label]] of rec.phaseSteps.entries()) {
    if (!label.startsWith('busy')) continue;
    const next = rec.phaseSteps[index + 1]?.[0] ?? Date.now() - rec.t0;
    const a = rec.t0 + at, b = rec.t0 + next;
    const hasRun = rec.runOrder.some(id => { const list = rec.runSteps.get(id)!; const idx = list.findLastIndex(([when]) => when <= (at + next) / 2); return idx >= 0 && !/^(completed|failed|interrupted|cancelled)/.test(list[idx]![1]); });
    if (hasRun || b - a < 1500) continue;
    const covering = turns.filter(([from, to]) => from - 2500 <= b && to + 4000 >= a);
    const lastEnd = covering.length ? Math.max(...covering.map(([, to]) => to)) : undefined;
    // Busy must end soon after the last turn it overlaps ends; and it must overlap one.
    if (!covering.length || (lastEnd !== undefined && b - lastEnd > 6000)) {
      const hooks = hookLog.filter(item => item.at >= a - 1000 && item.at <= b + 1000).map(item => `${item.event}@${rel(item.at - rec.t0)}`).join(' ');
      found.push(`busy ${rel(at)}–${rel(next)} (${rel(next - at)}) overlaps ${covering.length} transcript turn(s)${lastEnd ? `, the last ended ${rel(lastEnd - rec.t0)}` : ''}; hooks: ${snip(hooks, 200)}`);
    }
  }
  return found;
}

/**
 * Context compaction (`/compact`): one user bubble, one compaction activity that runs and completes with the numbers
 * the CLI reports, its summary kept out of the conversation and fetchable as a blob, and none of the CLI's own markup.
 */
async function s12(ctx: Ctx) {
  const { id, rec } = await newSession(ctx);
  const warm = await send(id, 'Do not use tools. Reply with only a two-sentence greeting.');
  await ctx.settle(warm.id, 90_000);
  await ctx.quiet(id, 30_000);
  const before = readRows(id).length;
  const run = await send(id, '/compact');
  const done = await ctx.settle(run.id, 150_000).catch(() => services.store.getRun(run.id));
  await ctx.until('idle after /compact', () => ctx.phase(id) === 'idle', 90_000);
  await ctx.until('compaction activity completed', () => [...activityStates(rec).values()].some(states => states.at(-1)?.kind === 'compaction' && states.at(-1)?.status === 'completed' && Boolean(states.at(-1)?.blobRef)), 30_000);
  ctx.check('/compact Run completed', done.state === 'completed', `state=${done.state} delivery=${done.native?.delivery} error=${done.error ?? ''}`);
  const all = await events(id);
  const slash = all.filter(event => event.type === 'user_message_chunk' && textOf(event).trim() === '/compact');
  ctx.check('exactly one /compact user event', slash.length === 1, `events=${slash.length}: ${snip(all.filter(event => event.type === 'user_message_chunk').map(textOf), 300)}`);
  const compactions = [...activityStates(rec).values()].filter(states => states[0]!.kind === 'compaction');
  ctx.check('exactly one compaction activity', compactions.length === 1, `activities=${compactions.length}`);
  const states = compactions[0] ?? [];
  const order = states.map(state => state.status);
  // The summary row follows the boundary and adds the preview and the blob to the same (completed) activity.
  ctx.check('compaction goes running, then completed', order[0] === 'running' && order.at(-1) === 'completed' && order.slice(1).every(status => status === 'completed'), order.join('→'));
  const last = states.at(-1);
  ctx.check('completed compaction carries trigger and token counts', last?.compaction?.trigger === 'manual' && typeof last.compaction.preTokens === 'number' && typeof last.compaction.postTokens === 'number' && last.compaction.preTokens > last.compaction.postTokens, snip(last?.compaction, 200));
  ctx.check('compaction has a duration and a start before its end', typeof last?.durationMs === 'number' && Boolean(last.startedAt) && Boolean(last.endedAt) && Date.parse(last.startedAt!) <= Date.parse(last.endedAt!), snip({ d: last?.durationMs, s: last?.startedAt, e: last?.endedAt }, 200));
  ctx.check('status.activity.compacting was true while it ran', rec.statuses.some(({ status }) => status.activity?.compacting === true), `statuses with activity: ${rec.statuses.filter(({ status }) => status.activity).length}`);
  ctx.check('status.activity is gone once it completed', services.nativeBackends.status(id).activity === undefined, snip(services.nativeBackends.status(id).activity, 100));
  const summaryRow = readRows(id).find(({ row }) => row.isCompactSummary === true);
  const summaryText = summaryRow ? rowText(summaryRow.row) : '';
  ctx.check('the CLI wrote a summary row', summaryText.length > 0, 'no isCompactSummary row');
  const probe = summaryText.replace(/\s+/g, ' ').trim().slice(0, 60);
  const asUser = all.filter(event => event.type === 'user_message_chunk' && (textOf(event).replace(/\s+/g, ' ').includes(probe) || /continued from a previous conversation/.test(textOf(event))));
  ctx.check('the summary is not a user message', probe.length > 0 && asUser.length === 0, `user events with the summary: ${asUser.length}`);
  const raw = JSON.stringify(all.filter(event => activityOf(event) === undefined));
  ctx.check('no local-command markup reaches the conversation', !/local-command-std|<command-name>|Compacted \(ctrl\+o/.test(raw), (/local-command-std|<command-name>|Compacted \(ctrl\+o/.exec(raw)?.[0] ?? ''));
  const everything = JSON.stringify(all);
  ctx.check('no local_command activity for the Compacted… output', !all.some(event => activityOf(event)?.kind === 'local_command'), snip(all.filter(event => activityOf(event)?.kind === 'local_command').map(event => activityOf(event)), 200));
  ctx.check('summary preview is at most 2KB', Boolean(last?.detail) && last!.detail!.length <= 2048 && !/\u001b/.test(everything), `detail=${last?.detail?.length}`);
  const blob = last?.blobRef ? await http('GET', `/api/sessions/${id}/blobs/${last.blobRef}`) : undefined;
  const blobText = typeof blob?.body === 'string' ? blob.body : JSON.stringify(blob?.body ?? '');
  ctx.check('the blob is fetchable and holds the summary', blob?.code === 200 && blobText.replace(/\s+/g, ' ').includes(probe), `code=${blob?.code} len=${blobText.length}`);
  const follow = await send(id, 'Do not use tools. Reply with only the word AFTER_COMPACT_12.');
  const fr = await ctx.settle(follow.id, 90_000).catch(() => services.store.getRun(follow.id));
  ctx.check('conversation usable after /compact', fr.state === 'completed', `state=${fr.state} error=${fr.error ?? ''}`);
  const phantom = phantomBusy(id, rec);
  ctx.check('no phantom busy', phantom.length === 0, phantom.join(' | '));
  const rows = readRows(id);
  contract.push({ scenario: 12, action: '/compact (activity)', kinds: kindList(rows.slice(before), rec.t0) });
}

/**
 * Background tasks: a Bash command that ends by itself (exit code 3), a Bash command that keeps running, and a
 * Monitor that reports events and stays up. Their activities appear, update in place, end with the CLI's own
 * report, and a stop shows `stopping` until the CLI reports each stopped.
 */
async function s13(ctx: Ctx) {
  const { id, rec } = await newSession(ctx);
  const before = readRows(id).at(-1)?.i ?? -1;
  const launch = await send(id, 'Call these three tools in one reply, in parallel, without waiting for anything: (1) Bash with run_in_background true, command "echo QUICK_OUT; sleep 4; exit 3", description "quick job"; (2) Bash with run_in_background true, command "sleep 600", description "long job"; (3) Monitor with command "for i in 1 2 3; do echo tick$i; sleep 5; done; sleep 600", description "ticker", timeout_ms 900000, persistent false. Afterwards reply with only LAUNCHED.');
  await ctx.until('the CLI to end the launch turn', () => turnEnds(readRows(id), before).length > 0, 120_000);
  const find = (title: string) => [...activityStates(rec).values()].find(states => states[0]!.title === title);
  const arrived = await ctx.until('three background activities', () => Boolean(find('quick job') && find('long job') && find('ticker')), 60_000);
  ctx.check('quick job, long job and ticker all appeared as background activities', arrived, `ids=${[...activityStates(rec).values()].map(states => `${states[0]!.title}:${states.map(state => state.status).join('>')}`).join(', ')}`);
  const [quick, long, ticker] = ['quick job', 'long job', 'ticker'].map(find);
  ctx.check('all are background_task, stoppable per session, with a task kind', [quick, long, ticker].every(states => states?.[0]?.kind === 'background_task' && states[0].stop?.via === 'session') && quick?.[0]?.task?.kind === 'shell' && ticker?.[0]?.task?.kind === 'monitor', snip([quick?.[0], ticker?.[0]], 400));
  const launchCalls = new Map<string, string>();
  for (const event of await events(id)) if (event.type === 'tool_call' && /Bash|Monitor/.test(String(event.data.toolName))) launchCalls.set(String(event.data.title), String(event.data.toolCallId));
  ctx.check('each activity hangs on the row that launched it', quick?.[0]?.toolCallId === launchCalls.get('quick job') && long?.[0]?.toolCallId === launchCalls.get('long job') && ticker?.[0]?.toolCallId === launchCalls.get('ticker'), snip({ quick: quick?.[0]?.toolCallId, expected: [...launchCalls] }, 300));
  await ctx.until('the quick job to end', () => (find('quick job')?.at(-1)?.status ?? 'running') !== 'running', 60_000);
  const quickEnd = find('quick job')?.at(-1);
  ctx.check('quick job ended failed with exit code 3', quickEnd?.status === 'failed' && quickEnd.task?.exitCode === 3 && typeof quickEnd.durationMs === 'number', snip(quickEnd, 300));
  await ctx.until('the quick job output', () => Boolean(find('quick job')?.at(-1)?.detail?.includes('QUICK_OUT')), 10_000);
  ctx.check('its output tail is in the detail', Boolean(find('quick job')?.at(-1)?.detail?.includes('QUICK_OUT')), snip(find('quick job')?.at(-1), 300));
  await ctx.until('the ticker to report three events', () => Boolean(find('ticker')?.at(-1)?.detail?.includes('tick3')), 60_000);
  const tickerStates = find('ticker') ?? [];
  const ids = new Set([...activityStates(rec).keys()]);
  ctx.check('Monitor events update one activity instead of adding activities', ids.size === 3 && tickerStates.length >= 2 && tickerStates.every(state => state.status === 'running') && Boolean(tickerStates.at(-1)?.detail?.includes('tick3')), `activities=${ids.size} states=${tickerStates.length} detail=${snip(tickerStates.at(-1)?.detail, 80)}`);
  await sleep(1500);
  const live = services.nativeBackends.status(id);
  ctx.check('status.activity.background counts the two that still run', live.activity?.background === 2, snip(live.activity, 100));
  ctx.check('background count never exceeded the tasks launched', rec.statuses.every(({ status }) => (status.activity?.background ?? 0) <= 3), `max=${Math.max(0, ...rec.statuses.map(({ status }) => status.activity?.background ?? 0))}`);
  await ctx.quiet(id, 60_000);
  await captureBackgroundTasks(ctx, id);
  // Stop all background work through the one activity the reader tapped.
  const stopAt = Date.now();
  const stop = await http('POST', `/api/sessions/${id}/native/activities/${encodeURIComponent(long![0]!.id)}/stop`, {});
  ctx.note(`stop -> ${stop.code} ${snip(stop.body, 300)} in ${rel(Date.now() - stopAt)}`);
  ctx.check('stop returned 200 with the activity', stop.code === 200 && stop.body?.activity?.id === long![0]!.id, `${stop.code} ${snip(stop.body, 300)}`);
  await ctx.until('both to be stopped', () => find('long job')?.at(-1)?.status === 'stopped' && find('ticker')?.at(-1)?.status === 'stopped', 60_000);
  const longOrder = (find('long job') ?? []).map(state => state.status);
  ctx.check('the long job showed stopping before stopped', longOrder.includes('stopping') && longOrder.at(-1) === 'stopped' && longOrder.indexOf('stopping') < longOrder.indexOf('stopped'), longOrder.join('>'));
  ctx.check('the ticker ended stopped too (stop is for the whole session)', find('ticker')?.at(-1)?.status === 'stopped', (find('ticker') ?? []).map(state => state.status).join('>'));
  const rows = readRows(id).filter(item => item.i > before);
  const killed = (taskId: string) => rows.some(({ row }) => /<status>killed<\/status>/.test(JSON.stringify(row)) && JSON.stringify(row).includes(taskId));
  const taskIds = [long![0]!.id, ticker![0]!.id].map(value => value.replace(/^claude:/, ''));
  ctx.check('the CLI reported both as killed (the evidence for stopped)', taskIds.every(killed), `killed reports: ${taskIds.map(taskId => `${taskId}=${killed(taskId)}`).join(' ')}`);
  await ctx.until('background count to reach 0', () => services.nativeBackends.status(id).activity === undefined, 15_000);
  ctx.check('status.activity is gone with no background work', services.nativeBackends.status(id).activity === undefined, snip(services.nativeBackends.status(id).activity, 100));
  const events2 = await events(id);
  ctx.check('no task report became a user message', !events2.some(event => event.type === 'user_message_chunk' && /task-notification/.test(textOf(event))), '');
  const wrongKind = events2.filter(event => event.type === 'task_notification' && event.data.kind === 'subagent');
  ctx.check('shell and monitor reports are not labelled subagent notices', wrongKind.length === 0, snip(wrongKind.map(event => event.data), 300));
  await ctx.quiet(id, 60_000);
  const phantom = phantomBusy(id, rec);
  ctx.check('no phantom busy', phantom.length === 0, phantom.join(' | '));
  const nativeId = services.store.getSession(id).nativeSessionId ?? '';
  ctx.note(`hooks for this session: ${hookLog.filter(item => nativeId.startsWith(item.session) && !['PreToolUse', 'PostToolUse'].includes(item.event)).map(item => `${item.event}${item.promptId ? ':' + item.promptId : ''}@${rel(item.at - rec.t0)}`).join(' ')}`);
  ctx.note(`busy stretches: ${rec.phaseSteps.map(([at, label]) => `${label}@${rel(at)}`).join('→')}`);
  contract.push({ scenario: 13, action: 'background Bash + Monitor, stop all', kinds: kindList(readRows(id).filter(item => item.i > before), rec.t0) });
  ctx.rows.push(...digest(readRows(id).filter(item => item.i > before), rec.t0, row => row.type === 'queue-operation' || (row.type === 'user' && Boolean(row.origin)) || (row.type === 'system' && /agents_killed|turn_duration/.test(row.subtype ?? ''))));
  void launch;
}

/** The tmux session the terminal service gave a Riffet terminal (mirrors its `terminalName`). */
const paneOf = (sessionId: string) => `cw-${services.store.getSession(sessionId).terminalId!.replaceAll('-', '').slice(0, 20)}`;
const paneScreen = (sessionId: string) => tmux('capture-pane', '-p', '-t', paneOf(sessionId));
const paneKeys = (sessionId: string, ...keys: string[]) => tmux('send-keys', '-t', paneOf(sessionId), ...keys);
/** The pane once `test` holds for it, or undefined after `ms`. */
async function paneUntil(sessionId: string, test: (screen: string) => boolean, ms = 4000): Promise<string | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const screen = paneScreen(sessionId);
    if (test(screen)) return screen;
    if (Date.now() >= end) return undefined;
    await sleep(150);
  }
}
/** Presses one key and returns the pane once the TUI had time to redraw. */
async function paneKey(sessionId: string, key: string): Promise<string> {
  paneKeys(sessionId, key);
  await sleep(400);
  return paneScreen(sessionId);
}
/** The composer with nothing typed in it (an untouched box may show a greyed `Try "…"` suggestion). */
const composerEmpty = (screen: string) => /^(?:Try ".*")?$/.test((claudeComposer(screen) ?? 'x').replace(/[❯>│|]/g, '').trim());
/**
 * The footer has the keyboard: its agent list, or the tasks entry, which 2.1.302 marks only by reverse video (no
 * `Enter to view tasks`), so it is read from the styled capture below the composer's last rule.
 */
function footerFocused(sessionId: string): boolean {
  return claudeFooterFocused(paneScreen(sessionId)) || claudeTasksEntryFocused(tmux('capture-pane', '-p', '-e', '-t', paneOf(sessionId)));
}
/**
 * Hands the keyboard back to the main composer the way the server does: never Esc (it stops an agent whose view
 * is open) nor Ctrl-C. The list climbs to `main`, Enter leaves the agent view, Up leaves the footer.
 */
async function backToMainComposer(sessionId: string): Promise<boolean> {
  let screen = paneScreen(sessionId);
  for (let step = 0; step < 8 && claudeViewsSubagent(screen) && !claudeAgentRows(screen).some(row => row.name === 'main' && row.selected); step += 1) {
    screen = await paneKey(sessionId, claudeAgentRows(screen).some(row => row.selected) ? 'Up' : 'Down');
  }
  if (claudeViewsSubagent(screen)) screen = await paneKey(sessionId, 'Enter');
  for (let step = 0; step < 8 && footerFocused(sessionId); step += 1) screen = await paneKey(sessionId, 'Up');
  return !claudeViewsSubagent(screen) && !footerFocused(sessionId) && claudeComposer(screen) !== undefined;
}

/** `composer-paste`: a multi-line bracketed paste left unsubmitted in an idle composer, then taken out again. */
async function capturePaste(ctx: Ctx, sessionId: string): Promise<void> {
  if (!captureDir) return;
  const file = join(directory, 'paste.txt');
  await writeFile(file, ['first pasted line', 'second pasted line', 'third pasted line', 'fourth pasted line', 'fifth pasted line'].join('\n'));
  tmux('load-buffer', '-b', 'probe-paste', file);
  tmux('paste-buffer', '-p', '-d', '-b', 'probe-paste', '-t', paneOf(sessionId));
  const held = await paneUntil(sessionId, screen => CLAUDE_CODE_PASTE_PLACEHOLDER_PATTERN.test(claudeComposer(screen) ?? ''));
  if (held) await capture('composer-paste', held);
  else ctx.note(`composer-paste: no placeholder in the box; pane tail ${snip(paneScreen(sessionId).split('\n').filter(line => line.trim()).slice(-6), 360)}`);
  let screen = await paneKey(sessionId, 'C-u');
  for (let step = 0; step < 80 && !composerEmpty(screen); step += 1) { paneKeys(sessionId, 'BSpace'); await sleep(60); screen = paneScreen(sessionId); }
  ctx.check('composer-paste: the box is empty again', composerEmpty(screen), snip(claudeComposer(screen), 200), 'limit');
}

/**
 * `agent-list` and `agent-view` while a background agent runs and the composer talks to main: the list under the
 * footer, then the agent's own view (Down into the list, Enter on the agent's row), then back to main.
 */
async function captureAgentScreens(ctx: Ctx, sessionId: string): Promise<void> {
  if (!captureDir) return;
  const listed = await paneUntil(sessionId, screen => claudeAgentRows(screen).some(row => row.name === 'main') && claudeAgentRows(screen).length >= 2 && !claudeFooterFocused(screen), 10_000);
  if (!listed) { ctx.note(`agent-list: no agent list under the footer; pane tail ${snip(paneScreen(sessionId).split('\n').filter(line => line.trim()).slice(-8), 400)}`); return; }
  await capture('agent-list', listed);
  // With agents only, the footer has no tasks entry and Down goes straight into the list (2.1.302).
  paneKeys(sessionId, 'Down');
  const entry = await paneUntil(sessionId, screen => /Enter to view tasks/.test(screen), 1500);
  if (entry) await capture('tasks-entry-focused', entry);
  // On into the list, down to the first agent that is not main, and into its view.
  let screen = paneScreen(sessionId);
  for (let step = 0; step < 6 && !claudeAgentRows(screen).some(row => row.selected && row.name !== 'main'); step += 1) screen = await paneKey(sessionId, 'Down');
  if (claudeAgentRows(screen).some(row => row.selected && row.name !== 'main')) {
    paneKeys(sessionId, 'Enter');
    const view = await paneUntil(sessionId, claudeViewsSubagent, 3000);
    if (view) await capture('agent-view', view);
    else ctx.note(`agent-view: Enter on the agent row opened no view; pane tail ${snip(paneScreen(sessionId).split('\n').filter(line => line.trim()).slice(-8), 400)}`);
  } else ctx.note(`agent-view: the list cursor never reached an agent row; rows ${JSON.stringify(claudeAgentRows(screen))}`);
  ctx.check('captures: the composer talks to main again', await backToMainComposer(sessionId), snip(paneScreen(sessionId).split('\n').filter(line => line.trim()).slice(-8), 400), 'limit');
}

/**
 * `composer-tasks`, `tasks-entry-focused`, `background-list` and `background-task`: the input box with shells running, the footer's tasks entry (Down from the composer),
 * the "Background" list it opens (Enter) and one task's page (Enter on its row), then closed with Esc, which stops nothing there.
 * Down is followed by Enter even when the plain screen shows no change: 2.1.302 marks the focused entry by reverse video only.
 */
async function captureBackgroundTasks(ctx: Ctx, sessionId: string): Promise<void> {
  if (!captureDir) return;
  const taskPanel = (screen: string) => claudeBackgroundScreen(screen)?.kind;
  // Riffet's Stop hook answers before the CLI's other Stop hooks: its spinner (`✶ Infusing… (running Stop hooks…`) may still run.
  if (!await paneUntil(sessionId, screen => claudeComposer(screen) !== undefined && !/^\S \S+… \(/m.test(screen), 30_000)) ctx.note('background-list: the CLI still shows a running spinner');
  const idle = paneScreen(sessionId);
  if (claudeTasksEntryShown(idle)) await capture('composer-tasks', idle);
  else ctx.note(`composer-tasks: no tasks entry under the input box; pane tail ${snip(idle.split('\n').filter(line => line.trim()).slice(-6), 400)}`);
  const entry = await paneKey(sessionId, 'Down');
  if (/Enter to view tasks/.test(entry)) await capture('tasks-entry-focused', entry);
  else if (footerFocused(sessionId)) ctx.note('tasks-entry-focused: the focused tasks entry is drawn in reverse video only, so its plain screen equals the idle one; not captured');
  if (footerFocused(sessionId)) {
    paneKeys(sessionId, 'Enter');
    const shown = await paneUntil(sessionId, screen => ['list', 'task'].includes(taskPanel(screen) ?? ''), 4000);
    if (shown) {
      const isList = taskPanel(shown) === 'list';
      if (isList) {
        await capture('background-list', shown);
        paneKeys(sessionId, 'Enter');
      }
      const page = isList ? await paneUntil(sessionId, screen => taskPanel(screen) === 'task', 4000) : shown;
      if (page) await capture('background-task', page);
      else ctx.note(`background-task: Enter on the list opened no task page; pane tail ${snip(paneScreen(sessionId).split('\n').filter(line => line.trim()).slice(-10), 500)}`);
    } else ctx.note(`background-list: the tasks entry opened no list; pane tail ${snip(paneScreen(sessionId).split('\n').filter(line => line.trim()).slice(-10), 500)}`);
  } else ctx.note(`background-list: Down did not focus the tasks entry; pane tail ${snip(paneScreen(sessionId).split('\n').filter(line => line.trim()).slice(-8), 400)}`);
  // Esc only while the dialog is up: twice in an empty composer it would open the rewind menu instead.
  let screen = paneScreen(sessionId);
  for (let step = 0; step < 3 && claudeBackgroundScreen(screen)?.closable; step += 1) screen = await paneKey(sessionId, 'Escape');
  ctx.check('captures: the Background dialog is closed and the composer has the keyboard', await backToMainComposer(sessionId), snip(paneScreen(sessionId).split('\n').filter(line => line.trim()).slice(-8), 400), 'limit');
}

/**
 * Questions that wait on a person. (a) A hook-mediated question answered through Riffet. (b) The hook
 * is made to time out (test-only short timeout), so the CLI falls back to its own dialog; a key typed in
 * the pane answers it and Riffet's card closes on its own. (c) The same fallback, answered through
 * Riffet (an option, then free text). (d) Many very short turns, so the Stop hook and the last answer
 * arrive together; the generic checks then prove no answer was lost to a repeated sequence.
 */
async function s11(ctx: Ctx) {
  // `lead` makes the model write a long text in front of the tool call, which is what the "card after its text" check needs. A and B
  // (the first asks) use it; the repeats (C, C2) are plain, because a model that already wrote its paragraph
  // sometimes calls it a day and never asks, which says nothing about the product.
  const ask = (header: string, tail: string, lead = false) => `${lead ? 'First write two plain sentences announcing that you are about to ask the user a question, and then, in that same reply, ' : ''}call the AskUserQuestion tool exactly once (a reply without the tool call is wrong) with one single-select question (header "${header}", question "Which letter do you pick?", exactly two options labelled "Alpha" and "Beta" with short descriptions). Do not call any other tool. After the answer arrives, reply with only ${tail} followed by the chosen answer.`;
  const interactionOf = (id: string) => services.nativeBackends.status(id).interaction;
  /**
   * Send an ask and wait until the model has called the tool (phase attention). A model that ends its turn without calling it
   * says nothing about the product, so the ask is repeated (at most twice) and the lapse is noted.
   */
  const askModel = async (id: string, text: string): Promise<Run> => {
    let run = await send(id, text);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await ctx.until('the question call (attention) or the end of the Run', () => ctx.phase(id) === 'attention' || settled(services.store.getRun(run.id)), 120_000);
      if (ctx.phase(id) === 'attention' || attempt === 3) return run;
      ctx.note(`the model ended its turn without calling AskUserQuestion (attempt ${attempt}); asking again`);
      await ctx.quiet(id, 30_000);
      run = await send(id, text);
    }
    return run;
  };
  const answerCard = async (id: string, card: any, requestId: string, rest: Record<string, unknown>) => {
    const result = await http('POST', `/api/sessions/${id}/native/interaction`, { interactionId: card.id, revision: card.revision, requestId, action: 'answer', ...rest });
    if (result.code >= 400) {
      const status = services.nativeBackends.status(id);
      const hooks = hookLog.filter(item => item.event === 'PreToolUse' || item.event === 'PermissionRequest').slice(-4).map(item => `${item.event}@${rel(item.at - started)}/${item.ms ?? 'open'}ms`);
      ctx.note(`answer refused (${result.code}); status phase=${status.phase} interaction=${status.interaction?.id ?? '-'} transport=${status.interaction?.transport ?? '-'}; recent question hooks: ${hooks.join(' ')}; pane tail: ${snip(paneScreen(id).split('\n').filter(line => line.trim()).slice(-8), 500)}`);
    }
    return result;
  };
  /** Status the timeline ends up with for the latest AskUserQuestion call: its `tool_call`, overridden by any later `tool_call_update`. */
  const toolStatus = async (id: string): Promise<string | undefined> => {
    const list = await events(id);
    const call = list.filter(event => event.type === 'tool_call' && event.data.toolName === 'AskUserQuestion').at(-1);
    if (!call) return undefined;
    return String(list.filter(event => event.type === 'tool_call_update' && event.data.toolCallId === call.data.toolCallId).at(-1)?.data.status ?? call.data.status);
  };
  const toolResults = (id: string) => readRows(id).filter(({ row }) => row.type === 'user' && Array.isArray(row.message?.content) && row.message.content.some((block: any) => block?.type === 'tool_result' && /Which letter|answered|Alpha|Beta/i.test(JSON.stringify(block.content ?? ''))));
  const lastText = (id: string) => rowTextOfLastAssistant(id);

  // (a) -----------------------------------------------------------------------------------------
  const a = await newSession(ctx);
  const runA = await askModel(a.id, ask('Letter', 'PICKED_A:', true));
  const shownA = await ctx.until('hook-mediated question card', () => ctx.phase(a.id) === 'attention', 120_000);
  ctx.check('A: hook-mediated question card appears (phase attention)', shownA, `phase=${ctx.phase(a.id)}`);
  if (shownA) {
    // The CLI draws its own dialog beside the held hook too; B's fallback dialog, when reached, replaces this capture.
    const dialog = captureDir ? await paneUntil(a.id, screen => /Enter to select/.test(screen), 5000) : undefined;
    if (dialog) await capture('question', dialog);
    const card = await ok('GET', `/api/sessions/${a.id}/native/interaction`);
    ctx.note(`A card: kind=${card?.kind} transport=${card?.transport} title="${card?.title}" options=${card?.options?.map((item: any) => item.label).join('/')} expiresAt=${card?.expiresAt ?? '-'}`);
    ctx.check('A: card is a protocol question with both options and no expiry', card?.kind === 'question' && card?.transport === 'protocol' && card.options?.length === 2 && card.expiresAt === undefined && card.extendableUntil === undefined, JSON.stringify(card).slice(0, 300));
    // Claude Code may not have flushed the tool_use row while its hook is still open; whenever it shows, it is still in progress.
    await ctx.until('the question\'s tool call in the timeline', async () => (await toolStatus(a.id)) !== undefined, 5_000);
    const waiting = await toolStatus(a.id);
    if (waiting === undefined) ctx.note('A: the tool_use row was not in the transcript yet while the hook waited');
    ctx.check('A: the question\'s tool call is never reported finished while it waits (clients show a running tool in phase attention)', waiting === undefined || waiting === 'in_progress', `status=${waiting} phase=${ctx.phase(a.id)}`);
    const beta = card.options.find((item: any) => item.label === 'Beta')?.id ?? card.options[1]?.id;
    const answered = await answerCard(a.id, card, randomUUID(), { selectedIds: [beta] });
    ctx.note(`A answer -> ${answered.code} ${snip(answered.body, 200)}`);
    const done = await ctx.settle(runA.id, 120_000);
    await ctx.quiet(a.id, 30_000);
    ctx.check('A: Riffet answer completes the tool and the turn continues (Run completed, answer reached the model)', done.state === 'completed' && /Beta/.test(lastText(a.id) ?? ''), `state=${done.state} reply="${snip(lastText(a.id), 100)}"`);
    ctx.check('A: card gone and tool call completed', !interactionOf(a.id) && (await toolStatus(a.id)) === 'completed', `interaction=${interactionOf(a.id)?.id ?? '-'} tool=${await toolStatus(a.id)}`);
  }
  // (e) A turn that ends on a yes/no question: whatever the CLI draws for it (a suggested reply, say) blocks nothing.
  const closing = await send(a.id, 'Do not use tools. Reply with one sentence and end it with a yes/no question asking whether I want more detail.');
  const closed = await ctx.settle(closing.id, 90_000).catch(() => services.store.getRun(closing.id));
  await sleep(3000); // the screen poll has had its chances
  const closingScreen = paneScreen(a.id);
  const card = await http('GET', `/api/sessions/${a.id}/native/interaction`);
  ctx.note(`E: pane after a turn that ends on a question: ${snip(closingScreen.split('\n').filter(line => line.trim()).slice(-7), 360)}`);
  ctx.check('E: a turn ending on a question leaves no attention interaction, phase idle', closed.state === 'completed' && ctx.phase(a.id) === 'idle' && !interactionOf(a.id) && !(card.body && card.body.id), `run=${closed.state} phase=${ctx.phase(a.id)} interaction=${interactionOf(a.id)?.id ?? '-'} card=${snip(card.body, 120)}`);
  // (d) Short turns, repeated: the Stop hook races the row that holds the answer.
  for (let index = 1; index <= 8; index += 1) {
    const run = await send(a.id, `Do not use tools. Reply with only the word SHORT_${index}.`);
    const done = await ctx.settle(run.id, 90_000).catch(() => services.store.getRun(run.id));
    if (done.state !== 'completed') ctx.check(`D: short turn ${index} completes`, false, `state=${done.state}`);
  }
  await ctx.quiet(a.id, 30_000);
  ctx.note(`D: 8 short turns; client holds ${[...a.rec.held.values()].filter(event => event.type === 'agent_message_chunk' && /SHORT_\d/.test(textOf(event))).length} of their answers`);

  // (b)(c) --------------------------------------------------------------------------------------
  // The hooks that wait on a person are registered with a 6s timeout for this launch only; Claude Code kills
  // them then and draws its own dialog.
  process.env.RIFFET_CLAUDE_INTERACTION_HOOK_TIMEOUT_MS = '6000';
  let b: NewSession;
  try { b = await newSession(ctx); } finally { delete process.env.RIFFET_CLAUDE_INTERACTION_HOOK_TIMEOUT_MS; }
  const fallbackCard = async (label: string) => {
    const appeared = await ctx.until(`${label}: the hook to expire and the native dialog to be lifted`, () => interactionOf(b.id)?.id.startsWith('claude-screen:') === true, 90_000);
    const card = interactionOf(b.id);
    if (!appeared) {
      const hooks = hookLog.filter(item => services.store.getSession(b.id).nativeSessionId?.startsWith(item.session) && (item.event === 'PreToolUse' || item.event === 'PermissionRequest')).map(item => `${item.event}@${rel(item.at - started)}/${item.ms ?? 'open'}ms`);
      ctx.note(`${label}: transcript tail: ${snip(readRows(b.id).slice(-8).map(({ row }) => `${rowKey(row)} "${snip(rowText(row), 50)}"`), 700)}; all hooks since: ${hookLog.filter(item => services.store.getSession(b.id).nativeSessionId?.startsWith(item.session)).slice(-14).map(item => `${item.event}:${item.tool ?? ''}@${rel(item.at - started)}/${item.ms ?? 'open'}ms`).join(' ')}`);
      ctx.note(`${label}: no native dialog card; interaction=${card?.id ?? '-'} phase=${ctx.phase(b.id)}; question hooks: ${hooks.join(' ')}; pane tail: ${snip(paneScreen(b.id).split('\n').filter(line => line.trim()).slice(-10), 600)}`);
    }
    ctx.check(`${label}: after the hook timed out Riffet lifts the CLI's own dialog as an answerable card`, appeared && card?.kind === 'question' && card.transport === 'terminal' && card.options.map(option => option.label).join('/') === 'Alpha/Beta' && card.actions.some(action => action.id === 'answer'), JSON.stringify(card ?? null).slice(0, 300));
    ctx.note(`${label}: AskUserQuestion tool_use rows in the transcript while the dialog is up: ${readRows(b.id).filter(({ row }) => row.type === 'assistant' && Array.isArray(row.message?.content) && row.message.content.some((block: any) => block?.type === 'tool_use' && block.name === 'AskUserQuestion')).length} (results: ${toolResults(b.id).length})`);
    ctx.check(`${label}: phase stays attention (the tool is not shown as unfinished)`, ctx.phase(b.id) === 'attention', `phase=${ctx.phase(b.id)}`);
    return appeared ? card : undefined;
  };

  const runB = await askModel(b.id, ask('Letter', 'PICKED_B:', true));
  await ctx.until('B: the first (hook) card', () => ctx.phase(b.id) === 'attention', 120_000);
  {
    // What the CLI shows while its question hook is still open (the card is up, the hook has not timed out yet).
    const duringHook = interactionOf(b.id);
    const screen = paneScreen(b.id);
    ctx.note(`B while the hook is open (card ${duringHook?.id ?? '-'}, transport ${duringHook?.transport ?? '-'}): the pane ${/Enter to select/.test(screen) ? 'ALREADY shows' : 'does not yet show'} the native dialog; tail ${snip(screen.split('\n').filter(line => line.trim()).slice(-6), 360)}`);
  }
  const lifted = await fallbackCard('B');
  if (lifted) {
    const screen = paneScreen(b.id);
    await capture('question', screen);
    ctx.note(`B native dialog: ${snip(screen.split('\n').filter(line => line.trim()).slice(-9), 420)}`);
    const keysAt = Date.now();
    paneKeys(b.id, 'Down', 'Enter'); // Beta, typed by a person in the terminal
    const closed = await ctx.until('B: the card to close after the terminal answer', () => !interactionOf(b.id), 20_000);
    ctx.check('B: answering in the terminal closes Riffet\'s card by itself', closed, `interaction=${interactionOf(b.id)?.id ?? '-'} phase=${ctx.phase(b.id)}`);
    ctx.note(`B card closed ${rel(Date.now() - keysAt)} after the key press`);
    const done = await ctx.settle(runB.id, 120_000);
    await ctx.quiet(b.id, 30_000);
    ctx.check('B: Run completed with the terminal answer', done.state === 'completed' && /Beta/.test(lastText(b.id) ?? ''), `state=${done.state} reply="${snip(lastText(b.id), 100)}"`);
  }

  const runC = await askModel(b.id, ask('Letter', 'PICKED_C:'));
  const optionCard = await fallbackCard('C');
  if (optionCard) {
    const answered = await answerCard(b.id, optionCard, randomUUID(), { selectedIds: [optionCard.options[0]!.id] });
    ctx.note(`C option answer -> ${answered.code} ${snip(answered.body, 200)}`);
    const done = await ctx.settle(runC.id, 120_000);
    await ctx.quiet(b.id, 30_000);
    ctx.check('C: answering the native dialog through Riffet completes the Run with the chosen option', answered.code < 300 && done.state === 'completed' && /Alpha/.test(lastText(b.id) ?? ''), `answer=${answered.code} state=${done.state} reply="${snip(lastText(b.id), 100)}"`);
    ctx.check('C: card closed', !interactionOf(b.id), `interaction=${interactionOf(b.id)?.id ?? '-'}`);
  }
  const runD = await askModel(b.id, ask('Letter', 'PICKED_D:'));
  const textCard = await fallbackCard('C2');
  if (textCard) {
    const answered = await answerCard(b.id, textCard, randomUUID(), { otherText: 'Gamma from Riffet' });
    ctx.note(`C free-text answer -> ${answered.code} ${snip(answered.body, 200)}`);
    const done = await ctx.settle(runD.id, 120_000);
    await ctx.quiet(b.id, 30_000);
    ctx.check('C2: free text typed into the native dialog through Riffet reaches the model', answered.code < 300 && done.state === 'completed' && /Gamma from Riffet/.test(lastText(b.id) ?? ''), `answer=${answered.code} state=${done.state} reply="${snip(lastText(b.id), 100)}"`);
  }
  ctx.note(`question hooks the server routed: ${hookLog.filter(item => b.id && services.store.getSession(b.id).nativeSessionId?.startsWith(item.session) && (item.event === 'PreToolUse' || item.event === 'PermissionRequest')).map(item => `${item.event}@${rel(item.at - started)}/${item.ms ?? 'open'}ms`).join(' ')}`);
  ctx.check('tool results for the questions are in the transcripts', toolResults(a.id).length >= 1 && toolResults(b.id).length >= 3, `a=${toolResults(a.id).length} b=${toolResults(b.id).length}`);
  contract.push({ scenario: 11, action: 'AskUserQuestion via hook / native dialog', kinds: kindList(readRows(b.id), b.rec.t0) });
}

/** Text of the last assistant row of a conversation's transcript. */
function rowTextOfLastAssistant(sessionId: string): string | undefined {
  const row = readRows(sessionId).filter(item => item.row.type === 'assistant' && !item.row.isSidechain && Array.isArray(item.row.message?.content) && item.row.message.content.some((block: any) => block?.type === 'text' && String(block.text ?? '').trim())).at(-1)?.row;
  return row?.message.content.filter((block: any) => block?.type === 'text').map((block: any) => String(block.text)).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------
const scenarios: Array<{ n: number; title: string; fn: (ctx: Ctx) => Promise<void>; seconds?: number }> = [
  { n: 1, title: 'new session + first message', fn: s1 },
  { n: 2, title: 'multi-line + image attachment', fn: s2 },
  { n: 3, title: 'message while busy', fn: s3 },
  { n: 4, title: 'interrupt main turn', fn: s4 },
  { n: 5, title: 'background sub-agent', fn: s5, seconds: scenarioSeconds + 120 },
  { n: 6, title: 'service restart takeover', fn: s6 },
  { n: 7, title: 'permission approve/deny', fn: s7 },
  { n: 8, title: '/compact', fn: s8 },
  { n: 10, title: 'send text+image during bg task then stop', fn: s10, seconds: scenarioSeconds + 240 },
  // A, E, eight short turns, B, C and C2: more than one budget's worth of turns on a slower model.
  { n: 11, title: 'human-wait interactions: Riffet answer, terminal answer, hook lost', fn: s11, seconds: scenarioSeconds + 300 },
  { n: 12, title: '/compact as a system activity', fn: s12 },
  { n: 13, title: 'background Bash + Monitor activities and stop', fn: s13, seconds: scenarioSeconds + 120 },
];

async function disposeSession(id: string) {
  try {
    const terminalId = services.store.getSession(id).terminalId;
    await services.nativeBackends.dispose(id).catch(() => undefined);
    if (terminalId) await services.terminal.stop(terminalId).catch(() => undefined);
  } catch { /* already gone */ }
}

/** Why the probe could not start its scenarios. */
let setupError: string | undefined;
let cleanupTask: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleanupTask ??= (async () => {
    try { await services?.app.close(); } catch { /* closing twice */ }
    tmux('kill-server');
    await rm(directory, { recursive: true, force: true });
  })();
}
process.on('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });

try {
  await prepareProject();
  await boot();
  projectId = services.store.createProject(projectDir, 'Claude e2e').id;
  if (modelSource) {
    // The source comes from a built-in plugin; one still detecting is waited for, and one that is off ends the probe.
    const providers = (await services.plugins.descriptors()).filter(item => item.contributes.modelSources?.some(source => source.id === modelSource));
    const provider = providers.find(item => item.enabled);
    if (!provider) throw new Error(`Model source ${modelSource} is not available: ${providers.length ? providers.map(item => `${item.id} is off${item.status?.message ? ` (${item.status.message})` : ''}`).join('; ') : 'no built-in plugin provides it'}`);
    // A profile on the source, saved to <temp state>/native-backend-profiles.json like the settings page does.
    profileId = modelSource;
    await ok('POST', '/api/backends/claude/profiles', { id: profileId, name: `Probe (${modelSource})`, modelSource });
    log(`profile ${profileId} on model source ${modelSource} (${provider.id})`);
  }
  if (profileName) {
    if (modelSource) throw new Error('Give --source or --profile, not both');
    const copied = await copyRiffetProfile((url, body) => ok('POST', url, body), 'claude', profileName);
    profileId = copied.backendProfileId;
    // The profile's own route answers for its models; the CLI ping of the default route does not apply.
    chosenModel ||= copied.model ?? '';
    if (!chosenModel) throw new Error(`profile ${profileName} names no model; pass --model`);
  }
  const catalog = (await ok('GET', `/api/backends/claude/catalog?projectId=${projectId}${profileId ? `&profileId=${encodeURIComponent(profileId)}` : ''}`)) as any;
  const models: Array<{ value: string; name?: string }> = catalog.models ?? [];
  log(`catalog available=${catalog.available} reason=${catalog.reason ?? ''} models=${models.map(model => model.value).join(',')} modes=${catalog.capabilities?.modes?.map((mode: any) => mode.id).join(',')} permissions=${catalog.capabilities?.permissions?.map((item: any) => item.id).join(',')}`);
  if (!catalog.available) throw new Error(`Claude Code is unavailable: ${catalog.reason}`);
  if (modelSource) {
    // The source's own catalog, as the settings page probes it; its route is the source's, so the CLI ping below does not apply.
    const sourced = ((await ok('POST', '/api/backends/claude/model-probe', { modelSource, profileId })) as { models: Array<{ value: string; name?: string }> }).models;
    if (!sourced.length) throw new Error(`Model source ${modelSource} offers no models`);
    if (chosenModel && !sourced.some(model => model.value === chosenModel)) throw new Error(`--model ${chosenModel} is not in the ${modelSource} catalog (${sourced.map(model => model.value).join(', ')})`);
    const rank = (model: { value: string; name?: string }) => /haiku/i.test(`${model.value} ${model.name ?? ''}`) ? 0 : /flash|mini|lite|sonnet/i.test(`${model.value} ${model.name ?? ''}`) ? 1 : 2;
    const candidates = chosenModel ? [chosenModel] : [...sourced].sort((a, b) => rank(a) - rank(b)).map(model => model.value);
    const picked = await sourcePing(candidates);
    log(`model from ${modelSource}: ${picked.log.join(' | ')} (of ${sourced.length})`);
    // A catalog model its own gateway refuses would leave every scenario retrying until it times out.
    if (!picked.model) throw new Error(`Model source ${modelSource}: no catalog model answers on its route (${picked.log.join('; ')})`);
    chosenModel = picked.model;
  }
  if (!chosenModel) {
    const picked = await pickModel(models);
    chosenModel = picked.model;
    log(`model preflight: ${picked.log.join(' | ')}`);
  }
  backendMode = 'agent'; // Claude exposes no separate work modes: the server only accepts 'agent'
  log(`model=${chosenModel} mode=${backendMode} socket=${socket}`);

  for (const scenario of scenarios) {
    if (only.size && !only.has(scenario.n)) continue;
    const ctx = new Ctx(scenario.n, scenario.title, scenario.seconds ?? scenarioSeconds);
    log(`=== Scenario ${scenario.n}: ${scenario.title}`);
    try { await scenario.fn(ctx); }
    catch (error) { ctx.check('scenario ran to completion', false, error instanceof Error ? error.message : String(error), 'limit'); }
    ctx.stopWatches();
    for (const recorder of ctx.recorders) { recorder.sample(); }
    // The CLI's Stop hook can beat the last row onto disk, so the answer may follow the Run's end by a poll or two.
    await sleep(1500);
    try { ctx.finalChecks(); } catch (error) { ctx.note(`finalChecks failed: ${error}`); }
    const timelines = ctx.recorders.flatMap(recorder => recorder.render());
    const rowsAll = ctx.sessions.length ? summarizeRows(readRows(ctx.sessions[0]!), ctx.recorders[0]!.t0).text : '';
    results.push({
      n: scenario.n, title: scenario.title, pass: ctx.checks.every(check => check.ok), checks: ctx.checks,
      timelines, notes: ctx.notes, rows: [`transcript record kinds: ${rowsAll}`, ...ctx.rows], ms: Date.now() - ctx.t0,
    });
    for (const recorder of ctx.recorders) recorder.detach();
    for (const id of ctx.sessions) await disposeSession(id);
    log(`=== Scenario ${scenario.n}: ${results.at(-1)!.pass ? 'PASS' : 'FAIL'} (${rel(Date.now() - ctx.t0)})`);
  }
} catch (error) {
  // Nothing ran: the CLI, its model or its route is not usable here.
  setupError = error instanceof Error ? error.message : String(error);
} finally {
  await cleanup();
  const total = rel(Date.now() - started);
  console.log('\n================ CLAUDE E2E PROBE REPORT ================');
  console.log(`model=${chosenModel} total=${total}`);
  if (setupError) console.log(`SKIP environment: ${setupError}`);
  for (const result of results) {
    console.log(`\n### Scenario ${result.n} ${result.title}: ${result.pass ? 'PASS' : 'FAIL'} (${rel(result.ms)})`);
    for (const check of result.checks) console.log(`  [${check.ok ? 'ok' : check.kind === 'limit' ? 'FAIL-limit' : 'FAIL'}] ${check.name}${check.evidence ? ` :: ${check.evidence}` : ''}`);
    for (const line of result.timelines) console.log(`  ${line}`);
    for (const line of result.notes) console.log(`  note: ${line}`);
    for (const line of result.rows) console.log(`  ${line}`);
  }
  console.log('\n### Contract table (action -> transcript record kinds)');
  for (const item of contract) console.log(`  S${item.scenario} ${item.action}: ${item.kinds.join(' ; ')}`);
  if (outFile) writeFileSync(outFile, JSON.stringify({ model: chosenModel, total, ...(setupError ? { skipped: setupError } : {}), results, contract }, null, 1));
  process.exit(setupError ? 2 : results.some(result => !result.pass) ? 1 : 0);
}
