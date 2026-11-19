/**
 * Records a scenario against a real agent CLI for the replay tests (docs/guide/aif.md §5.4).
 *
 *   pnpm record codex <scenario|all> [--out <dir>]
 *
 * Codex: drives `CodexBackendAdapter` over the App Server with an in-memory host and keeps every
 * message that crossed the `CodexAppServerClient` seam, in a scratch project with two small files.
 * Uses the CLI's own configuration (model, provider, sign-in), like scripts/probe-codex-e2e.ts.
 * Output: apps/server/src/backends/codex/fixtures/app-server/<cli version>/<scenario>.jsonl, then run
 * `npx vitest run apps/server/src/backends/codex/recordings.test.ts -u` to write the expected rows.
 *
 * Recordings are committed to a public repository, so machine paths, the user name, URLs and model
 * ids are replaced with synthetic text, and accounts, rate limits and provider configuration are
 * dropped (`redact`). Read the diff before committing; `pnpm check:privacy` scans it too.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from '../apps/server/src/backends/shared/codex-app-server.js';
import { resolveCliExecutable } from '../apps/server/src/backends/shared/cli-resolve.js';
import { probeAppServer } from '../apps/server/src/backends/codex/config.js';
import { CODEX_SCENARIOS, formatRecording, recordingFactory, recordingHarness, type RecordedMessage, type Recording } from '../apps/server/src/backends/codex/recording.js';

const root = join(import.meta.dirname, '..');
const [backend, scenarioName, ...rest] = process.argv.slice(2);
const outFlag = rest.indexOf('--out');
if (backend !== 'codex' || !scenarioName || (outFlag >= 0 && !rest[outFlag + 1])) {
  console.error(`usage: pnpm record codex <${Object.keys(CODEX_SCENARIOS).join('|')}|all> [--out <dir>]`);
  process.exit(2);
}
const names = scenarioName === 'all' ? Object.keys(CODEX_SCENARIOS) : [scenarioName];
for (const name of names) if (!CODEX_SCENARIOS[name]) {
  console.error(`unknown scenario ${name}; known: ${Object.keys(CODEX_SCENARIOS).join(', ')}`);
  process.exit(2);
}

const executable = resolveCliExecutable({ command: process.env.CODEX_CLI?.trim() || 'codex' }).executable;
const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
const versionDir = /(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? 'unknown';
const probe = await probeAppServer(executable);
const outDir = outFlag >= 0 ? rest[outFlag + 1]! : join(root, 'apps/server/src/backends/codex/fixtures/app-server', versionDir);

/** Keys whose values describe the account, the provider or the machine rather than the protocol. */
const DROPPED_KEYS = /^(account|accounts|email|planType|rateLimits|rateLimitsByLimitId|credits|authMode|apiKey|baseUrl|base_url|model_providers|modelProviders|env|http_headers|headers|token|accessToken|userAgent|serviceTier|service_tier|instructionSources)$/;
/** Requests about the account or the provider configuration: kept, so the replay takes the same path, with an empty answer. */
const EMPTIED_METHODS = /^(account\/|config\/read$)/;
/**
 * Notifications about this machine's setup rather than the conversation: the user's own hooks and MCP
 * servers, the account, remote control, and the provider's moderation metadata.
 */
const DROPPED_NOTIFICATIONS = /^(hook\/|mcpServer\/startupStatus\/|account\/|remoteControl\/|turn\/moderationMetadata$)/;

function redactor(project: string, projectReal: string) {
  const models = new Map<string, string>();
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pairs: Array<[RegExp, string]> = [
    [new RegExp(literal(projectReal), 'g'), '/workspace/project'],
    [new RegExp(literal(project), 'g'), '/workspace/project'],
    [new RegExp(literal(homedir()), 'g'), '/home/user'],
    [new RegExp(literal(realpathSync(tmpdir())), 'g'), '/tmp'],
    [new RegExp(literal(tmpdir()), 'g'), '/tmp'],
    [new RegExp(`\\b${literal(userInfo().username)}\\b`, 'g'), 'user'],
    [new RegExp(`\\b${literal(hostname())}\\b`, 'g'), 'host'],
    [/https?:\/\/[^\s"'<>)]+/g, 'https://provider.example.invalid'],
  ];
  const text = (value: string) => pairs.reduce((out, [pattern, to]) => out.replace(pattern, to), value);
  const model = (value: string) => {
    if (!models.has(value)) models.set(value, `synthetic-model-${String(models.size + 1).padStart(3, '0')}`);
    return models.get(value)!;
  };
  const walk = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (/^(modelProvider|model_provider|provider)$/.test(key)) return 'synthetic-provider';
      return /^(model|modelId|model_id|slug|defaultModel|displayName|display_name)$/.test(key) ? model(value) : text(value);
    }
    if (Array.isArray(value)) return value.map(item => walk(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([name]) => !DROPPED_KEYS.test(name)).map(([name, item]) => [name, walk(item, name)]));
    }
    return value;
  };
  return { walk, text };
}

function redact(recording: Recording, project: string, projectReal: string): Recording {
  const { walk, text } = redactor(project, projectReal);
  const emptied = new Set<number>();
  const messages: RecordedMessage[] = [];
  for (const message of recording.messages) {
    if (message.kind === 'request' && EMPTIED_METHODS.test(message.method)) { emptied.add(message.id); messages.push({ ...message, params: {} }); continue; }
    if (message.kind === 'response' && emptied.has(message.id)) { messages.push({ dir: 'in', kind: 'response', id: message.id, result: {} }); continue; }
    if (message.kind === 'notification' && message.dir === 'in' && DROPPED_NOTIFICATIONS.test(message.method)) continue;
    messages.push(walk(message) as RecordedMessage);
  }
  return {
    // The user agent names the OS, architecture and terminal; only its version matters to the driver.
    meta: { ...recording.meta, serverUserAgent: /\/(\d+\.\d+\.\d+)/.exec(recording.meta.serverUserAgent ?? '')?.[1] ? `agent/${/\/(\d+\.\d+\.\d+)/.exec(recording.meta.serverUserAgent!)![1]}` : undefined },
    messages,
  };
}

mkdirSync(outDir, { recursive: true });
for (const name of names) {
  const scenario = CODEX_SCENARIOS[name]!;
  const project = mkdtempSync(join(tmpdir(), 'riffet-record-'));
  const projectReal = realpathSync(project);
  writeFileSync(join(project, 'README.md'), '# Sample project\n\nTwo files for recording sessions.\n');
  writeFileSync(join(project, 'notes.txt'), 'alpha\nbeta\ngamma\n');
  const sink: RecordedMessage[] = [];
  let serverUserAgent: string | undefined;
  const factory = recordingFactory(options => CodexAppServer.start(options), sink, client => { serverUserAgent ??= client.serverUserAgent; });
  const harness = recordingHarness({ factory, cwd: project, executable, approval: scenario.approval });
  try {
    for (const prompt of scenario.prompts) {
      console.log(`[${name}] > ${prompt}`);
      await harness.send(prompt);
      await harness.idle(180_000);
    }
    const rows = await harness.rows();
    console.log(`[${name}] ${sink.length} messages, ${rows.length} journal rows`);
  } finally {
    await harness.dispose();
    rmSync(project, { recursive: true, force: true });
  }
  const recording = redact({ meta: { cli: 'codex', version, serverUserAgent, probe, scenario: name, prompts: scenario.prompts, approval: scenario.approval }, messages: sink }, project, projectReal);
  const file = join(outDir, `${name}.jsonl`);
  writeFileSync(file, formatRecording(recording));
  console.log(`[${name}] wrote ${file}`);
}
process.exit(0);
