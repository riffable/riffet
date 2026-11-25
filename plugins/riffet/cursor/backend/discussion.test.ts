import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDiscussionRequest } from '@riffet/plugin-api/experimental/agent';
import { afterEach, expect, it } from 'vitest';
import { resolveCursorLaunchProfile } from '../cli-driver.js';
import { streamCursorDiscussion } from './discussion.js';

const owners: string[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture(output: string) {
  const owner = await mkdtemp(join(tmpdir(), 'riffet-discussion-profile-'));
  owners.push(owner);
  await writeFile(join(owner, 'cli-config.json'), JSON.stringify({ network: { useHttp1ForAgent: true }, approvalMode: 'unrestricted' }));
  const executable = join(owner, 'cursor');
  const capture = join(owner, 'capture.json');
  await writeFile(executable, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const { execSync } = require('node:child_process');
const config = process.env.CURSOR_CONFIG_DIR;
const hooks = JSON.parse(readFileSync(config + '/hooks.json'));
const rule = hooks.hooks.preToolUse[0];
let denied = false;
try { execSync(rule.command); } catch (error) { denied = error.status === 2; }
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  cwd: process.cwd(), home: require('node:os').homedir(), config, args: process.argv.slice(2), key: process.env.CURSOR_API_KEY,
  settings: JSON.parse(readFileSync(config + '/cli-config.json')), hook: { denied, failClosed: rule.failClosed },
  prompt: readFileSync(0, 'utf8'),
}));
const print = event => process.stdout.write(JSON.stringify(event) + '\\n');
const text = (s, extra = { timestamp_ms: 1700000000000 }) => print({ type: 'assistant', ...extra, message: { content: [{ type: 'text', text: s }] } });
${output}
`, { mode: 0o700 });
  const profile = resolveCursorLaunchProfile({ executable, configDir: owner, apiEndpoint: 'https://cursor.example', agentEndpoint: 'https://agent.example' }, undefined, 'test-only');
  const request: AgentDiscussionRequest = {
    model: 'auto', system: 'Freeze the source', messages: [{ role: 'user', content: 'First question' }, { role: 'assistant', content: 'Original answer' }, { role: 'user', content: 'Follow-up question' }],
    signal: new AbortController().signal, idleTimeoutMs: 10_000, maxOutputTokens: 100, onDelta: () => {},
  };
  return { profile, capture, request, owner };
}

it('runs a fresh tool-free Cursor question on the selected provider and streams each part once', async () => {
  const { capture, profile, request, owner } = await fixture(`
text('one'); text(' two'); text('one two', { timestamp_ms: 1700000000000, model_call_id: 'm1' }); print({ type: 'usage' });
text('!'); text('!'); text('!!'); print({ type: 'retry' });
text(' three'); text(' three', {}); text(process.env.CURSOR_API_KEY);
print({ type: 'result', subtype: 'success', result: 'one two!! three' + process.env.CURSOR_API_KEY });`);
  const deltas: string[] = [];
  await streamCursorDiscussion(profile, { ...request, onDelta: text => deltas.push(text) });
  expect(deltas).toEqual(['one', ' two', '!', '!', ' three', '[REDACTED]']);
  const launch = JSON.parse(await readFile(capture, 'utf8'));
  expect(launch.args).toEqual(expect.arrayContaining(['--mode', 'ask', '--allowed-tools=', '--endpoint', 'https://cursor.example', '--agent-endpoint', 'https://agent.example', '--model', 'auto']));
  expect(launch.args).not.toContain('--resume');
  expect(launch).toMatchObject({ key: 'test-only', settings: { network: { useHttp1ForAgent: true } }, hook: { denied: true, failClosed: true } });
  expect(launch.settings.approvalMode).toBeUndefined();
  for (const content of [request.system, ...request.messages.map(message => message.content)]) expect(launch.prompt).toContain(content);
  expect(launch.config).not.toBe(owner);
  expect(launch.config).toBe(join(launch.home, '.cursor'));
  expect(launch.args).not.toContain('--exclude-workspace-context');
  expect(existsSync(launch.config)).toBe(false);
  expect(existsSync(launch.cwd)).toBe(false);
});

it('stops a CLI that reports a tool call and removes its temporary state', async () => {
  const { capture, profile, request } = await fixture("print({ type: 'tool_call', subtype: 'started' }); setInterval(() => {}, 1000);");
  await expect(streamCursorDiscussion(profile, request)).rejects.toThrow('requested a tool');
  const launch = JSON.parse(await readFile(capture, 'utf8'));
  expect(existsSync(launch.config)).toBe(false);
});
