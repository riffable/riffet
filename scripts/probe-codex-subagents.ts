/**
 * Validates the workbench's assumptions about the Codex app-server subagent protocol.
 *
 * A subagent panel is opened from the `receiverThreadIds` on a `collabAgentToolCall` item, and the
 * child transcript is then read by `thread/read` + `thread/turns/list`. All three are the app-server's
 * own contract: an older CLI simply reports no receivers, and the collaboration row silently stays a
 * plain tool row. Run this after a Codex update to find out which assumption a version dropped:
 *
 *   pnpm tsx scripts/probe-codex-subagents.ts
 *
 * It only runs `codex --version` and `codex app-server generate-json-schema` into a temp directory;
 * no session is opened and no turn is started. Set CODEX_CLI to probe another executable.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { requireCli } from './probe-sync-e2e-lib.js';

type Level = 'ok' | 'warn' | 'fail';
interface Check { level: Level; name: string; detail: string }
const checks: Check[] = [];
const add = (level: Level, name: string, detail: string) => { checks.push({ level, name, detail }); };
const execFileAsync = promisify(execFile);
const executable = process.env.CODEX_CLI ?? 'codex';
requireCli(executable, 'Codex', 'Install the Codex CLI (`npm i -g @openai/codex`), or set CODEX_CLI.');

/** The generated schema is a bundle of named definitions; every version we know of nests them. */
type Schema = { definitions?: Record<string, unknown> };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function main(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 30_000 });
    add('ok', 'executable', `${executable} reports ${stdout.trim().split('\n')[0]}`);
  } catch (error) {
    add('fail', 'executable', `${executable} could not report its version: ${(error as Error).message}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'codex-schema-'));
  try {
    await execFileAsync(executable, ['app-server', 'generate-json-schema', '--out', dir], { timeout: 120_000 });
  } catch (error) {
    add('fail', 'generate-json-schema', `this Codex cannot emit its protocol schema: ${(error as Error).message}`);
    return;
  }
  try {
    const files = readdirSync(dir).filter(name => name.endsWith('.schemas.json'));
    // The v2 bundle is the one that carries the thread-item union; fall back to whichever parses.
    const ordered = [...files].sort((left, right) => Number(right.includes('.v2.')) - Number(left.includes('.v2.')));
    let schema: Schema | undefined;
    let used: string | undefined;
    for (const file of ordered) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Schema;
        if (record(parsed.definitions)?.ThreadItem) { schema = parsed; used = file; break; }
      } catch { /* try the next bundle */ }
    }
    if (!schema?.definitions) {
      add('fail', 'protocol schema', `no bundle in ${files.join(', ') || '(none generated)'} carries a ThreadItem union`);
      return;
    }
    add('ok', 'protocol schema', used!);
    const definitions = schema.definitions;

    const items = record(definitions.ThreadItem)?.oneOf;
    const collab = (Array.isArray(items) ? items : []).map(record).find(item => {
      const variants = record(item)?.properties;
      return record(variants)?.type !== undefined && JSON.stringify(variants).includes('collabAgentToolCall');
    });
    const collabProps = record(record(collab)?.properties);
    if (!collabProps) add('fail', 'collabAgentToolCall item', 'the ThreadItem union has no collaboration variant');
    else {
      const required = Array.isArray(record(collab)?.required) ? (record(collab)!.required as unknown[]).map(String) : [];
      add(required.includes('receiverThreadIds') ? 'ok' : 'fail', 'receiverThreadIds', required.includes('receiverThreadIds') ? 'required on the collaboration item' : `absent (required: ${required.join(', ')})`);
      for (const field of ['senderThreadId', 'agentsStates', 'tool', 'prompt', 'model']) {
        add(collabProps[field] ? 'ok' : 'warn', field, collabProps[field] ? 'present' : 'absent — that part of the row falls back to a generic label');
      }
    }

    const tools = record(definitions.CollabAgentTool)?.enum;
    const toolNames = Array.isArray(tools) ? tools.map(String) : [];
    add(toolNames.includes('spawnAgent') ? 'ok' : 'fail', 'spawnAgent tool', toolNames.length ? `collab tools: ${toolNames.join(', ')}` : 'the schema names no collaboration tools');
    add(record(record(definitions.CollabAgentState)?.properties)?.status ? 'ok' : 'warn', 'agentsStates entry', record(record(definitions.CollabAgentState)?.properties)?.status ? 'carries a status' : 'no status field — "still working" falls back to the child turn alone');

    const threadProps = record(record(definitions.Thread)?.properties);
    for (const field of ['parentThreadId', 'agentNickname', 'agentRole']) {
      add(threadProps?.[field] ? 'ok' : 'warn', `Thread.${field}`, threadProps?.[field] ? 'present' : 'absent — the child title/type falls back to the prompt');
    }
    const listProps = record(record(definitions.ThreadListParams)?.properties);
    add(listProps?.sourceKinds ? 'ok' : 'warn', 'ThreadListParams.sourceKinds', listProps?.sourceKinds ? 'present (the fallback that lists subagent threads)' : 'absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();

for (const check of checks) console.log(`${check.level === 'ok' ? '  ok' : check.level === 'warn' ? 'warn' : 'FAIL'}  ${check.name}: ${check.detail}`);
const failed = checks.filter(check => check.level === 'fail').length;
const warned = checks.filter(check => check.level === 'warn').length;
console.log('');
console.log(failed ? `${failed} assumption(s) broken${warned ? `, ${warned} warning(s)` : ''}.` : warned ? `All hard assumptions hold; ${warned} warning(s).` : 'All assumptions hold.');
process.exitCode = failed ? 1 : 0;
