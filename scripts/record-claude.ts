/**
 * Records a scenario against the real Claude Code CLI for the replay tests (apps/server/src/backends/claude/recording.ts).
 *
 *   node --import tsx scripts/record-claude.ts <scenario|all> [--profile <name>] [--model <id>] [--out <dir> | --check]
 *
 * Runs the CLI as a TUI under tmux through an in-process server (own temp state dir, own tmux socket, a
 * temp git project with a README), on a copy of the user's Riffet profile `--profile` (default `aiden`;
 * a missing or refused profile ends the run, no other is tried). The CLI's real config dir is used.
 * One timeline per scenario is written to
 * apps/server/src/backends/claude/fixtures/transcript-hooks/<cli version>/<scenario>.jsonl:
 * the transcript files (as bytes appended since the last snapshot), every hook and status line payload as the
 * hook bridge received it, the pane where it changed, and what Riffet did (send, answer, stop).
 * Then `npx vitest run apps/server/src/backends/claude/recordings.test.ts -u` writes the expected rows.
 *
 * Before a hook is recorded, the transcript bytes and the pane as they are on disk at that moment are recorded,
 * so the replay keeps "what was written when the hook arrived".
 *
 * `--check` records into a scratch directory instead and reports, without writing to the repository: a CLI
 * newer than the newest recording, hook event names and transcript row types not in the recording (drift on a
 * newer CLI, a note on the same version), scenario problems, and whether replaying the fresh recording
 * yields the phase sequence the real run had. Exit 1 on findings.
 *
 * Recordings are committed to a public repository: only the transcript rows and fields the parsers read are kept
 * (`ROW_KEEP`), the user's own context injected into rows is dropped, and paths, names, model ids and accounts
 * are replaced with synthetic text. Read the diff before committing; `pnpm check:privacy` scans it too.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.js';
import { ClaudeHookBridge } from '../apps/server/src/backends/claude/hook-bridge.js';
import {
  CLAUDE_SCENARIOS, OWNER_TOKEN, RECORDED_MODEL, RECORDED_SECOND_SESSION_ID, RECORDED_SESSION_ID, SECOND_SESSION_PREFIX, TRANSCRIPTS_TOKEN, formatRecording, parseRecording, recordingVocabulary, replayRecording, scenarioProblems,
  type ClaudeRecordedEvent, type ClaudeRecording,
} from '../apps/server/src/backends/claude/recording.js';
import { localRedactions } from './terminal-fixture-guards.js';
import { copyRiffetProfile } from './probe-sync-e2e-lib.js';

// Started from inside a Claude Code / Riffet session, these would make the CLI a nested child instead of the standalone launch Riffet does.
for (const name of Object.keys(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|RIFFET_CLAUDE_HOOK_.*|AI_AGENT)$/.test(name)) delete process.env[name];
}

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name: string, fallback = '') => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const scenarioName = args[0];
const profileName = option('--profile', 'aiden');
const modelOverride = option('--model');
const outFlag = option('--out');
const check = args.includes('--check');
if (!scenarioName || scenarioName.startsWith('--') || (args.includes('--out') && !outFlag) || (check && outFlag)) {
  console.error(`usage: node --import tsx scripts/record-claude.ts <scenario|all> [--profile <name>] [--model <id>] [--out <dir> | --check]; scenarios: ${Object.keys(CLAUDE_SCENARIOS).join('|')}`);
  process.exit(2);
}
const names = scenarioName === 'all' ? Object.keys(CLAUDE_SCENARIOS) : [scenarioName];
for (const name of names) if (!CLAUDE_SCENARIOS[name]) { console.error(`unknown scenario ${name}; known: ${Object.keys(CLAUDE_SCENARIOS).join(', ')}`); process.exit(2); }

const cliCommand = process.env.CLAUDE_CLI?.trim() || 'claude';
const version = /\d+\.\d+\.\d+/.exec(execFileSync(cliCommand, ['--version'], { encoding: 'utf8' }))?.[0] ?? 'unknown';
const committed = join(root, 'apps/server/src/backends/claude/fixtures/transcript-hooks');
const outBase = check ? mkdtempSync(join(tmpdir(), 'riffet-claude-drift-')) : outFlag ? resolve(outFlag) : committed;
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const started = Date.now();
const log = (message: string) => console.error(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);

// ---------------------------------------------------------------------------------------------
// Isolated environment
// ---------------------------------------------------------------------------------------------
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'riffet-claude-rec-')));
const stateDir = join(directory, 'state');
const projectDir = join(directory, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'README.md'), '# Sample project\n\nTwo files for recording sessions.\n');
writeFileSync(join(projectDir, 'notes.txt'), 'alpha\nbeta\ngamma\n');
execFileSync('git', ['init', '-q'], { cwd: projectDir });
execFileSync('git', ['add', '-A'], { cwd: projectDir });
execFileSync('git', ['-c', 'user.email=rec@example.invalid', '-c', 'user.name=rec', 'commit', '-qm', 'init'], { cwd: projectDir });

const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const tmuxSocket = () => {
  const candidate = join(resolve(stateDir), 'tmux.sock');
  if (Buffer.byteLength(candidate) <= 90) return candidate;
  return join(tmpdir(), `riffet-${process.getuid?.() ?? 'user'}-${execFileSync('shasum', ['-a', '256'], { input: resolve(stateDir), encoding: 'utf8' }).slice(0, 12)}`, 'tmux.sock');
};
const socket = tmuxSocket();
if (socket.startsWith(join(homedir(), '.local', 'share', 'riffet'))) throw new Error('refusing to use the real Riffet state');
const tmux = (...rest: string[]) => { try { return execFileSync('tmux', ['-S', socket, ...rest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };

const services = await createApp({ stateDir, cliPath: 'cursor-agent', auth: false });
await services.app.listen({ host: '127.0.0.1', port: 0 });
const origin = { host: '127.0.0.1:4337', origin: 'http://127.0.0.1:4337' };
const auth = await services.app.inject({ url: '/api/auth/status', headers: origin });
const headers = { ...origin, cookie: String(auth.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': auth.json().csrfToken as string };
async function http(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>): Promise<{ code: number; body: any }> {
  const response = await services.app.inject({ url, method, headers, ...(payload ? { payload } : {}) });
  let body: any = response.body;
  try { body = response.body ? response.json() : undefined; } catch { /* keep text */ }
  return { code: response.statusCode, body };
}
async function ok(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>): Promise<any> {
  const result = await http(method, url, payload);
  if (result.code >= 400) throw new Error(`${method} ${url}: ${result.code} ${JSON.stringify(result.body).slice(0, 300)}`);
  return result.body;
}

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { await services.app.close(); } catch { /* closing twice */ }
  tmux('kill-server');
  rmSync(directory, { recursive: true, force: true });
}
process.on('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });

// ---------------------------------------------------------------------------------------------
// The timeline of one run
// ---------------------------------------------------------------------------------------------
type RawEvent = ClaudeRecordedEvent;
class Timeline {
  readonly events: RawEvent[] = [];
  readonly phases: string[] = [];
  /** The session this timeline belongs to, once it exists. */
  riffetId = '';
  private offsets = new Map<string, number>();
  private carry = new Map<string, string>();
  private metas = new Map<string, string>();
  private lastScreen = '';
  /** Bytes written to any transcript file of the session so far (to tell when it went quiet). */
  lastGrowth = Date.now();
  private size = 0;

  /** The CLI session ids this conversation had, in order: `/clear` moves it to a new one. */
  readonly known: string[] = [];
  learn(id: string | undefined): void { if (id && !this.known.includes(id)) this.known.push(id); }
  nativeId(): string | undefined {
    if (!this.riffetId) return undefined;
    try { return services.store.getSession(this.riffetId).nativeSessionId; } catch { return undefined; }
  }
  directory(given = this.nativeId()): string | undefined {
    const id = given;
    if (!id) return undefined;
    const projects = join(configDir, 'projects');
    for (const candidate of [projectDir, projectDir.replace(/^\/private/, '')]) {
      const dir = join(projects, candidate.replace(/[^a-zA-Z0-9]/g, '-'));
      if (existsSync(join(dir, `${id}.jsonl`))) return dir;
    }
    try {
      for (const name of readdirSync(projects)) if (existsSync(join(projects, name, `${id}.jsonl`))) return join(projects, name);
    } catch { /* no projects dir */ }
    return undefined;
  }
  phase(): string {
    if (!this.riffetId) return 'none';
    try { return services.nativeBackends.status(this.riffetId).phase; } catch { return 'none'; }
  }
  samplePhase(): void {
    const phase = this.phase();
    if (phase !== 'none' && this.phases.at(-1) !== phase) this.phases.push(phase);
  }
  private files(): Array<{ key: string; path: string }> {
    this.learn(this.nativeId());
    const found: Array<{ key: string; path: string }> = [];
    this.known.forEach((id, index) => {
      const dir = this.directory(id);
      if (!dir) return;
      const prefix = index === 0 ? '' : SECOND_SESSION_PREFIX;
      found.push({ key: `${prefix}main`, path: join(dir, `${id}.jsonl`) });
      const sub = join(dir, id, 'subagents');
      if (existsSync(sub)) for (const name of readdirSync(sub).sort()) if (/\.(jsonl|meta\.json)$/.test(name)) found.push({ key: `${prefix}subagents/${name}`, path: join(sub, name) });
    });
    return found;
  }
  /** What reached the disk since the last snapshot, as events: whole lines only, a half-written line waits. */
  snapshotTranscript(final = false): void {
    let total = 0;
    for (const { key, path } of this.files()) {
      let bytes: Buffer;
      try { bytes = readFileSync(path); } catch { continue; }
      total += bytes.length;
      if (key.endsWith('.meta.json')) {
        const text = bytes.toString('utf8');
        if (this.metas.get(key) !== text && text.trim()) { this.metas.set(key, text); this.events.push({ kind: 'transcript', file: key, text }); }
        continue;
      }
      const from = this.offsets.get(key) ?? 0;
      if (bytes.length <= from) continue;
      this.offsets.set(key, bytes.length);
      let text = (this.carry.get(key) ?? '') + bytes.subarray(from).toString('utf8');
      const cut = final ? text.length : text.lastIndexOf('\n') + 1;
      this.carry.set(key, text.slice(cut));
      text = text.slice(0, cut);
      if (text) this.events.push({ kind: 'transcript', file: key, text });
    }
    if (total !== this.size) { this.size = total; this.lastGrowth = Date.now(); }
  }
  screen(): string { return this.riffetId ? paneScreen(this.riffetId) : ''; }
  snapshotScreen(): void {
    const text = this.screen();
    if (text && text !== this.lastScreen) { this.lastScreen = text; this.events.push({ kind: 'screen', text }); }
  }
  /** Everything that is on disk and on the pane now, ahead of the event that follows. */
  mark(): void { this.snapshotTranscript(); this.snapshotScreen(); }
  push(event: RawEvent): void { this.mark(); this.events.push(event); }
}
const paneOf = (sessionId: string) => `cw-${services.store.getSession(sessionId).terminalId!.replaceAll('-', '').slice(0, 20)}`;
const paneScreen = (sessionId: string) => { try { return tmux('capture-pane', '-p', '-t', paneOf(sessionId)); } catch { return ''; } };

let current: Timeline | undefined;
/** Every hook the bridge receives, with the others' sessions; the filter is applied once the run's identity is known. */
{
  const proto = ClaudeHookBridge.prototype as unknown as { dispatch: (payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal) => Promise<unknown> };
  const original = proto.dispatch;
  proto.dispatch = async function (this: unknown, payload, deliveryId, signal) {
    const timeline = current;
    if (timeline) {
      if (payload.hook_event_name === 'SessionStart' && payload.source === 'clear' && payload.riffet_owner === timeline.riffetId) timeline.learn(String(payload.session_id));
      timeline.mark();
      timeline.events.push({ kind: 'hook', payload: structuredClone(payload) });
    }
    try { return await original.call(this, payload, deliveryId, signal); }
    finally { timeline?.samplePhase(); }
  };
}

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------
const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const paths = (...candidates: string[]) => [...new Set(candidates)].filter(Boolean).sort((a, b) => b.length - a.length);

type Redactor = ReturnType<typeof redactor>;
function redactor(timeline: Timeline, nativeIds: string[], transcriptDir: string, models: string[]) {
  const pairs: Array<[RegExp, string]> = [
    ...paths(transcriptDir, transcriptDir.replace(/^\/private/, '')).map(path => [new RegExp(literal(path), 'g'), TRANSCRIPTS_TOKEN] as [RegExp, string]),
    ...(timeline.riffetId ? [[new RegExp(literal(timeline.riffetId), 'g'), OWNER_TOKEN] as [RegExp, string]] : []),
    ...nativeIds.map((id, index) => [new RegExp(literal(id), 'g'), index === 0 ? RECORDED_SESSION_ID : RECORDED_SECOND_SESSION_ID] as [RegExp, string]),
    // The CLI names per-project folders (transcripts, task output) after the path with every other character turned into `-`.
    ...paths(projectDir, projectDir.replace(/^\/private/, '')).map(path => [new RegExp(literal(path.replace(/[^a-zA-Z0-9]/g, '-')), 'g'), '-workspace-project'] as [RegExp, string]),
    ...paths(directory, directory.replace(/^\/private/, '')).map(path => [new RegExp(literal(path.replace(/[^a-zA-Z0-9]/g, '-')), 'g'), '-tmp-riffet-recording'] as [RegExp, string]),
    [new RegExp(literal(homedir().replace(/[^a-zA-Z0-9]/g, '-')), 'g'), '-home-user'],
    [/(?:\/private)?\/tmp\/claude-\d+\//g, '/tmp/claude/'],
    ...paths(projectDir, projectDir.replace(/^\/private/, ''), join(tmpdir(), basename(directory), 'project')).map(path => [new RegExp(literal(path), 'g'), '/workspace/project'] as [RegExp, string]),
    ...paths(directory, directory.replace(/^\/private/, ''), join(tmpdir(), basename(directory))).map(path => [new RegExp(literal(path), 'g'), '/tmp/riffet-recording'] as [RegExp, string]),
    [new RegExp(literal(configDir), 'g'), '/home/user/.claude'],
    [new RegExp(literal(homedir()), 'g'), '/home/user'],
    [new RegExp(literal(realpathSync(tmpdir())), 'g'), '/tmp'],
    [new RegExp(literal(tmpdir()), 'g'), '/tmp'],
    [/(?:\/private)?\/var\/folders\/[^/\s"]+\/[^/\s"]+\/T\//g, '/tmp/'],
    [/\/Users\/[^/\s"]+/g, '/home/user'],
    // A path the TUI cut short with an ellipsis no longer matches the whole one.
    [/(?:\/private)?\/var\/folders\/[^\s"]*/g, '/tmp/…'],
    ...models.filter(Boolean).flatMap(model => [[new RegExp(literal(model), 'gi'), RECORDED_MODEL] as [RegExp, string], [new RegExp(literal(model.replace(/\[[^\]]*\]$/, '')), 'gi'), RECORDED_MODEL] as [RegExp, string]]),
    [new RegExp(`\\b${literal(userInfo().username)}\\b`, 'g'), 'user'],
    [new RegExp(`\\b${literal(hostname().split('.')[0]!)}\\b`, 'gi'), 'host'],
    [/\b(?:trae\/)?deepseek[-\w.]*/gi, RECORDED_MODEL],
    [/https?:\/\/[^\s"'<>)\\]+/g, '<url>'],
    [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-redacted'],
    [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, 'user@example.invalid'],
  ];
  const text = (value: string) => pairs.reduce((out, [pattern, to]) => out.replace(pattern, to), value);
  const screen = (value: string) => {
    let out = value;
    for (const [from, to] of localRedactions) out = out.split(from).join(to);
    // Account and route lines of the CLI's banner.
    out = out.split('\n').filter(line => !/apiKeyHelper|saved Console key/.test(line)).join('\n').replace(/ · API Usage Billing/g, '');
    return `${text(out).split('\n').map(line => line.trimEnd()).join('\n').replace(/\n+$/, '')}\n`;
  };
  const ids = new Map<string, string>();
  const messageId = (value: string) => {
    if (!ids.has(value)) ids.set(value, `msg_${String(ids.size + 1).padStart(24, '0')}`);
    return ids.get(value)!;
  };
  const deep = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return /^(model|modelId)$/.test(key) ? RECORDED_MODEL : text(value);
    if (Array.isArray(value)) return value.map(item => deep(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, deep(item, name)]));
    return value;
  };
  return { text, screen, deep, messageId, timeline, parentOf: new Map<string, string | null>(), keptIds: new Set<string>() };
}

/** Row types the parsers read (`history.ts`, `transcript-source.ts`, `subagents.ts`); the rest is the CLI's bookkeeping, snapshots and the user's own context. */
const ROW_KEEP = new Set(['user', 'assistant', 'system', 'queue-operation', 'attachment']);
/** System subtypes the driver reads. */
const SYSTEM_KEEP = new Set(['turn_duration', 'stop_hook_summary', 'compact_boundary', 'agents_killed']);
/** The attachments that reach a running turn (`handbackOf`, `agentMessageOf`); every other attachment is injected context. */
const ATTACHMENT_KEEP = new Set(['queued_command']);
/** The fields of a row the parsers read. */
const ROW_FIELDS = ['type', 'subtype', 'uuid', 'parentUuid', 'isSidechain', 'agentId', 'timestamp', 'promptId', 'prompt_id', 'origin', 'turnOrigin', 'operation', 'content', 'reason', 'sessionId',
  'isVisibleInTranscriptOnly', 'queueTranscriptOnly', 'isApiErrorMessage', 'hookCount', 'hookAdditionalContext', 'preventedContinuation', 'durationMs', 'compactMetadata', 'thinkingDisplay'];
const MESSAGE_FIELDS = ['role', 'id', 'stop_reason', 'content'];
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'output_tokens_details', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const BLOCK_FIELDS = ['type', 'text', 'thinking', 'id', 'name', 'input', 'tool_use_id', 'content', 'is_error'];
const RESULT_FIELDS = ['agentId', 'isAsync', 'status', 'statusChange', 'taskType', 'success', 'taskId', 'backgroundTaskId', 'description', 'agentType', 'prompt'];
/** The fields of a hook payload the driver reads; a status line frame (no event name) is cut down further below. */
const HOOK_KEEP = ['hook_event_name', 'session_id', 'transcript_path', 'permission_mode', 'prompt', 'prompt_id', 'agent_id', 'agent_type', 'tool_name', 'tool_input', 'tool_use_id', 'tool_response',
  'source', 'trigger', 'last_assistant_message', 'stop_hook_active', 'reason', 'message', 'notification_type', 'title', 'permission_suggestions', 'is_interrupt', 'error', 'custom_instructions',
  'agent_transcript_path', 'background_tasks'];

const pick = (source: Record<string, any> | undefined, fields: readonly string[]): Record<string, any> =>
  Object.fromEntries(fields.flatMap(field => source && source[field] !== undefined ? [[field, source[field]]] : []));

/** Injected markup in message text: reminders, the CLI's command envelopes, memory. */
const INJECTED = /<system-reminder>|<command-name>|<local-command-caveat>|CLAUDE\.md|<user-prompt-submit-hook>|<context>|<command-message>/;
const injected = (value: unknown) => typeof value === 'string' && INJECTED.test(value);

function redactBlock(block: any, r: Redactor): Record<string, unknown> | undefined {
  if (!block || typeof block !== 'object') return typeof block === 'string' ? (injected(block) ? undefined : (r.text(block) as any)) : block;
  if (block.type === 'text' && injected(block.text)) return undefined;
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    const content = block.content.map((item: any) => redactBlock(item, r)).filter(Boolean);
    return r.deep(pick({ ...block, content }, BLOCK_FIELDS)) as Record<string, unknown>;
  }
  return r.deep(pick(block, BLOCK_FIELDS)) as Record<string, unknown>;
}

function redactRow(row: Record<string, any>, r: Redactor): Record<string, unknown> | undefined {
  if (!ROW_KEEP.has(String(row.type))) return undefined;
  // Context the CLI or the user's own configuration injected into the conversation.
  if (row.isMeta === true && !(row.origin && typeof row.origin === 'object' && /^(peer|coordinator)$/.test(String(row.origin.kind)))) return undefined;
  if (row.isCompactSummary === true) return undefined;
  if (row.type === 'system' && !SYSTEM_KEEP.has(String(row.subtype))) return undefined;
  if (row.type === 'attachment') {
    if (!ATTACHMENT_KEEP.has(String(row.attachment?.type))) return undefined;
    const kept = r.deep({ ...pick(row, ROW_FIELDS), attachment: pick(row.attachment, ['type', 'prompt', 'origin', 'commandMode']) }) as Record<string, unknown>;
    return kept;
  }
  const kept: Record<string, any> = pick(row, ROW_FIELDS);
  // The hook command lines of a Stop summary name the user's own hooks.
  if (kept.type === 'system') delete kept.content;
  if (row.message && typeof row.message === 'object') {
    const message: Record<string, any> = pick(row.message, MESSAGE_FIELDS);
    if (typeof message.id === 'string') message.id = r.messageId(message.id);
    if (row.message.model !== undefined) message.model = RECORDED_MODEL;
    if (row.message.usage) message.usage = pick(row.message.usage, USAGE_FIELDS);
    if (Array.isArray(message.content)) message.content = message.content.map((block: unknown) => redactBlock(block, r)).filter(Boolean);
    else if (injected(message.content)) return undefined;
    if (Array.isArray(message.content) && !message.content.length) return undefined;
    kept.message = message;
  }
  if (row.toolUseResult && typeof row.toolUseResult === 'object') kept.toolUseResult = pick(row.toolUseResult, RESULT_FIELDS);
  return r.deep(kept) as Record<string, unknown>;
}

function redactTranscript(file: string, text: string, r: Redactor): string {
  if (file.endsWith('.meta.json')) return JSON.stringify(r.deep(JSON.parse(text)));
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.uuid === 'string') r.parentOf.set(row.uuid, typeof row.parentUuid === 'string' ? row.parentUuid : null);
    const kept = redactRow(row, r);
    if (!kept) continue;
    // The driver finds the prompt an end record belongs to through the chain of parents, so a row whose parent was dropped points at its nearest kept ancestor.
    if (typeof row.parentUuid === 'string') {
      let parent: string | null = row.parentUuid;
      while (parent && !r.keptIds.has(parent)) parent = r.parentOf.get(parent) ?? null;
      if (parent) kept.parentUuid = parent; else delete kept.parentUuid;
    }
    if (typeof row.uuid === 'string') r.keptIds.add(row.uuid);
    out.push(JSON.stringify(kept));
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

function redactHook(payload: Record<string, unknown>, r: Redactor): Record<string, unknown> {
  if (payload.hook_event_name === undefined) {
    // The status line frame: the context window and which session it is; never the model, cost or account.
    const window = (payload as Record<string, any>).context_window;
    return r.deep({
      session_id: payload.session_id, transcript_path: payload.transcript_path,
      ...(window ? { context_window: pick(window, ['total_input_tokens', 'context_window_size', 'current_usage']) } : {}),
    }) as Record<string, unknown>;
  }
  // The conversation a hook names as its owner routes the CLI's new session after `/clear`.
  return r.deep({ ...pick(payload, HOOK_KEEP), ...(typeof payload.riffet_owner === 'string' ? { riffet_owner: OWNER_TOKEN } : {}) }) as Record<string, unknown>;
}

function redactEvents(timeline: Timeline, nativeIds: string[], transcriptDir: string, models: string[]): ClaudeRecordedEvent[] {
  const r = redactor(timeline, nativeIds, transcriptDir, models);
  const out: ClaudeRecordedEvent[] = [];
  let lastScreen = '';
  for (const event of timeline.events) {
    if (event.kind === 'hook') {
      const id = event.payload.session_id;
      if (typeof id !== 'string' || !nativeIds.includes(id)) continue;
      out.push({ kind: 'hook', payload: redactHook(event.payload, r) });
    } else if (event.kind === 'transcript') {
      const text = redactTranscript(event.file, event.text, r);
      if (text) out.push({ kind: 'transcript', file: event.file, text });
    } else if (event.kind === 'screen') {
      const text = r.screen(event.text);
      if (text !== lastScreen) { lastScreen = text; out.push({ kind: 'screen', text }); }
    } else if (event.kind === 'send') out.push({ kind: 'send', text: r.text(event.text) });
    else out.push(event);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Running scenarios
// ---------------------------------------------------------------------------------------------
const settledRun = (state: string) => ['completed', 'failed', 'interrupted', 'cancelled'].includes(state);
let projectId = '';
let profileId = '';
let chosenModel = modelOverride;
let sendCounter = 0;

async function until(label: string, test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await sleep(100);
  }
  log(`timed out waiting for ${label}`);
  return false;
}

/** The turn is over once the phase is idle and the transcript has not grown for [quiet] ms. */
async function quiet(timeline: Timeline, ms: number, seconds = 180): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    timeline.samplePhase();
    timeline.snapshotTranscript();
    if (timeline.phase() === 'idle' && Date.now() - timeline.lastGrowth > ms) return;
    await sleep(100);
  }
  log(`the session did not go quiet within ${seconds}s (phase ${timeline.phase()})`);
}

function failedOnAuth(text: string): boolean { return /\b401\b|unauthori[sz]ed|invalid.*(api|key|token)|authentication/i.test(text); }

async function record(name: string): Promise<{ recording: ClaudeRecording; phases: string[] }> {
  const scenario = CLAUDE_SCENARIOS[name]!;
  const timeline = new Timeline();
  current = timeline;
  const created = await ok('POST', '/api/sessions', {
    projectId, kind: 'native', backendId: 'claude', backendProfileId: profileId, model: scenario.model ?? chosenModel, mode: 'agent', approval: scenario.approval, clientSessionId: randomUUID(),
  });
  const id = (created.session ?? created).id as string;
  timeline.riffetId = id;
  const poll = setInterval(() => timeline.samplePhase(), 100);
  try {
    for (const [index, prompt] of scenario.prompts.entries()) {
      if (scenario.restartBefore?.includes(index)) {
        // Riffet's runtime goes away and the CLI exits: the send that follows launches it again with --resume.
        const terminalId = services.store.getSession(id).terminalId;
        timeline.push({ kind: 'restart' });
        await services.nativeBackends.dispose(id);
        timeline.push({ kind: 'exit' });
        if (terminalId) await services.terminal.stop(terminalId);
        await sleep(2000);
        timeline.snapshotTranscript();
        log(`[${name}] the runtime was disposed and the CLI stopped`);
      }
      log(`[${name}] > ${prompt}`);
      timeline.push({ kind: 'send', text: prompt });
      sendCounter += 1;
      const run = await ok('POST', `/api/sessions/${id}/native/send`, { commandId: `record-${sendCounter}-${randomUUID()}`, text: prompt });
      if (scenario.approve || scenario.stopAtApproval) {
        const shown = await until('the permission card', () => timeline.phase() === 'attention', 120_000);
        if (!shown) throw new Error(`no permission card appeared (phase ${timeline.phase()}; pane tail: ${timeline.screen().split('\n').filter(line => line.trim()).slice(-8).join(' | ')})`);
        // The terminal's own dialog can be read a moment before the PermissionRequest hook arrives; the card to answer is the hook's.
        let card: any;
        for (let tries = 0; tries < 60; tries += 1) {
          card = await ok('GET', `/api/sessions/${id}/native/interaction`);
          if (card?.transport === 'protocol') break;
          await sleep(250);
        }
        // The stop has to meet the hook it refuses, not only the terminal's dialog.
        if (scenario.stopAtApproval && card?.transport !== 'protocol') throw new Error('the PermissionRequest hook did not arrive');
        if (scenario.approve) {
          const action = (card.actions as Array<{ id: string; tone?: string }>).find(item => item.tone === 'primary')?.id ?? card.actions[0].id;
          timeline.push({ kind: 'respond', action });
          const answered = await http('POST', `/api/sessions/${id}/native/interaction`, { interactionId: card.id, revision: card.revision, requestId: randomUUID(), action });
          log(`[${name}] card ${card.kind}/${card.transport} "${String(card.title).slice(0, 60)}"; answered ${action}: ${answered.code} ${answered.code >= 400 ? JSON.stringify(answered.body).slice(0, 300) : ''}`);
          if (answered.code >= 400) throw new Error('the permission card could not be answered');
        } else log(`[${name}] card ${card.kind}/${card.transport} "${String(card.title).slice(0, 60)}"; left waiting for the stop`);
      }
      if (scenario.interrupt) {
        // The first assistant text on disk (this route does not stream, so it lands whole, with the tool call behind it) or on the pane.
        const shown = scenario.stopAtApproval || await until('the first assistant text', () => {
          timeline.snapshotTranscript();
          const onDisk = timeline.events.some(event => event.kind === 'transcript' && event.file === 'main' && event.text.split('\n').some(line => /"type":"assistant"/.test(line) && /"type":"text"/.test(line)));
          return onDisk || /^⏺ \S/m.test(timeline.screen());
        }, 120_000);
        if (!shown) throw new Error('the model produced no text to interrupt');
        const session = services.store.getSession(id);
        const terminal = session.terminalId ? await services.terminal.get(session.terminalId) : undefined;
        const active = services.nativeBackends.status(id).activeTurn;
        timeline.push({ kind: 'stop' });
        const stopped = await http('POST', `/api/sessions/${id}/cancel`, {
          requestId: randomUUID(), nativeSessionId: active?.nativeSessionId ?? session.nativeSessionId,
          ...(active?.turnId ? { turnId: active.turnId } : {}), ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}),
        });
        log(`[${name}] stop: ${stopped.code} ${stopped.code >= 400 ? JSON.stringify(stopped.body).slice(0, 200) : ''}`);
        // A refused stop is the driver's defect, not something to work around in the recording.
        if (stopped.code >= 400) throw new Error(`the stop was refused: ${stopped.code} ${JSON.stringify(stopped.body).slice(0, 200)}`);
      }
      const settled = await until('the run to end', () => settledRun(services.store.getRun(run.id).state), 90_000);
      if (!settled) log(`[${name}] still running: phase ${timeline.phase()}; pane tail: ${timeline.screen().split('\n').filter(line => line.trim()).slice(-8).join(' | ')}`);
      const state = services.store.getRun(run.id);
      log(`[${name}] run ${state.state}${state.error ? `: ${String(state.error).slice(0, 120)}` : ''}`);
      if (!scenario.failure && state.error && failedOnAuth(String(state.error))) throw new AuthError(String(state.error));
      if (!settled) throw new Error('the run did not end');
      // The CLI reports its new session (SessionStart, source clear) some time after the command; the next send waits for it, as a person would.
      if (scenario.clear && prompt.trim() === '/clear' && !await until('the CLI to report its new session', () => timeline.known.length > 1, 30_000)) throw new Error('the CLI did not move to a new session after /clear');
      await quiet(timeline, 3000);
    }
  } finally {
    clearInterval(poll);
  }
  timeline.samplePhase();
  timeline.snapshotTranscript(true);
  timeline.snapshotScreen();
  timeline.learn(timeline.nativeId());
  const nativeId = timeline.known[0];
  const dir = timeline.directory(nativeId);
  if (!nativeId || !dir) throw new Error('the session left no transcript');
  const recording: ClaudeRecording = {
    meta: { cli: 'claude', version, scenario: name, prompts: scenario.prompts, approval: scenario.approval, model: RECORDED_MODEL },
    events: redactEvents(timeline, [...timeline.known], dir, [chosenModel, scenario.model ?? '']),
  };
  const raw = process.env.RECORD_CLAUDE_RAW;
  if (raw) { mkdirSync(raw, { recursive: true }); writeFileSync(join(raw, `${name}.raw.json`), JSON.stringify({ events: timeline.events, nativeId, dir })); }
  // A turn that failed on the route reads as an assistant error row.
  if (!scenario.failure && timeline.events.some(event => event.kind === 'transcript' && /"isApiErrorMessage":true/.test(event.text) && failedOnAuth(event.text))) throw new AuthError('the transcript holds an authentication error');
  await ok('POST', `/api/sessions/${id}/cancel`, { requestId: randomUUID() }).catch(() => undefined);
  current = undefined;
  return { recording, phases: [...timeline.phases] };
}

class AuthError extends Error {}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
const fresh = new Map<string, { recording: ClaudeRecording; phases: string[] }>();
let exitCode = 0;
try {
  projectId = services.store.createProject(projectDir, 'Claude recording').id;
  try {
    const copied = await copyRiffetProfile((url, body) => ok('POST', url, body), 'claude', profileName);
    profileId = copied.backendProfileId;
    chosenModel ||= copied.model ?? '';
  } catch (error) {
    console.error(`profile ${profileName} is not usable: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    exitCode = 3;
    throw error;
  }
  if (!chosenModel) throw new Error(`profile ${profileName} names no model; pass --model`);
  log(`model ${chosenModel}, profile ${profileName}, cli ${version}`);
  for (const name of names) {
    try {
      const result = await record(name);
      fresh.set(name, result);
      const events = result.recording.events;
      const count = (kind: string) => events.filter(event => event.kind === kind).length;
      log(`[${name}] ${count('hook')} hooks, ${count('transcript')} transcript chunks, ${count('screen')} screens; phases ${result.phases.join('>')}`);
      const file = join(outBase, version, `${name}.jsonl`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, formatRecording(result.recording));
      log(`[${name}] wrote ${file}`);
    } catch (error) {
      if (error instanceof AuthError) { console.error(`profile ${profileName} was refused (401 or authentication): ${error.message.slice(0, 160)}`); exitCode = 3; break; }
      console.error(`[${name}] failed: ${error instanceof Error ? error.message : String(error)}`);
      exitCode = Math.max(exitCode, 1);
    }
  }
  if (check && exitCode === 0) exitCode = (await drift()) ? 1 : 0;
} catch (error) {
  if (!exitCode) { console.error(error instanceof Error ? error.message : String(error)); exitCode = 1; }
} finally {
  await cleanup();
  if (check) rmSync(outBase, { recursive: true, force: true });
}
process.exit(exitCode);

/** The drift check; true when something changed. Leaves the repository untouched. */
async function drift(): Promise<boolean> {
  const findings: string[] = [];
  const notes: string[] = [];
  const semver = (value: string) => value.split('.').map(Number);
  const newer = (a: string, b: string) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };
  const recorded = existsSync(committed) ? readdirSync(committed).filter(name => statSync(join(committed, name)).isDirectory()).sort((a, b) => (newer(a, b) ? 1 : -1)) : [];
  const newest = recorded.at(-1);
  if (!newest) findings.push('no committed recordings');
  else if (newer(version, newest)) findings.push(`installed CLI ${version} is newer than the newest recording ${newest}: re-record (node --import tsx scripts/record-claude.ts all) and review the row diff`);
  for (const name of names) {
    const result = fresh.get(name);
    if (!result) { findings.push(`${name}: not recorded`); continue; }
    const oldFile = newest ? join(committed, newest, `${name}.jsonl`) : '';
    if (oldFile && existsSync(oldFile)) {
      const [before, after] = [recordingVocabulary(parseRecording(readFileSync(oldFile, 'utf8'))), recordingVocabulary(result.recording)];
      const added = [...after].filter(item => !before.has(item));
      const removed = [...before].filter(item => !after.has(item));
      if (added.length) (version === newest ? notes : findings).push(`${name}: not in the recording: ${added.join(', ')}`);
      if (removed.length) notes.push(`${name}: not seen this run: ${removed.join(', ')}`);
    }
    const parsed = parseRecording(readFileSync(join(outBase, version, `${name}.jsonl`), 'utf8'));
    const replay = await replayRecording(parsed).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    if (replay instanceof Error) { findings.push(`${name}: the fresh recording does not replay: ${replay.message}`); continue; }
    try {
      const problems = scenarioProblems(CLAUDE_SCENARIOS[name]!, replay);
      if (problems.length) findings.push(`${name}: the scenario broke: ${problems.join('; ')}`);
      const real = result.phases.join(' ');
      const replayed = replay.phases.join(' ');
      if (!isSubsequence(replay.phases, result.phases)) findings.push(`${name}: the replay of the fresh recording differs from the real run:\n    real:     ${real}\n    replayed: ${replayed}`);
    } finally {
      await replay.dispose();
    }
  }
  if (notes.length) console.log(`\nnotes:\n${notes.map(item => `- ${item}`).join('\n')}`);
  console.log(findings.length ? `\ndrift (${findings.length}):\n${findings.map(item => `- ${item}`).join('\n')}` : `\nno drift: CLI ${version}, ${names.length} scenario(s) match the recordings.`);
  return findings.length > 0;
}

/** The replay samples the phase after each event, the real run every 100 ms: every replayed phase must have been seen, in order. */
function isSubsequence(small: string[], big: string[]): boolean {
  let at = 0;
  for (const item of big) if (item === small[at]) at += 1;
  return at === small.length;
}
