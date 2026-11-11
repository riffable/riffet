// Claude Code hands its status line command the only machine-readable statement of the context
// window (see `context.ts`). This collector forwards that payload to the workbench over the same
// loopback bridge the hooks use, and — when the reader already had a status line — runs their
// command on the same bytes so the bar they configured keeps rendering.
//
// Claude Code captures this process's stdout, so the reader's command is spawned with an inherited
// stdout and writes the row itself. Nothing else is ever printed: hook diagnostics can carry
// prompts, tool arguments or credentials, and a failing bridge must leave the bar alone rather than
// break it.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { defaultDescriptorPath, isHookTarget, readHookDescriptor } from './hook-target.mjs';

const maxBytes = 1024 * 1024;
const args = process.argv.slice(2);
const forwardIndex = args.indexOf('--forward');
const forward = forwardIndex >= 0 ? args[forwardIndex + 1]?.trim() : undefined;
const descriptorIndex = args.indexOf('--descriptor');
const descriptorPath = descriptorIndex >= 0 ? args[descriptorIndex + 1] : undefined;
// Same discovery as `hook-cli.mjs`, but a status line is drawn many times a second and nobody waits on
// it: it posts to the live descriptor, or to the environment address of a CLI that predates descriptors.
const envUrl = process.env.RIFFET_HOOK_URL || process.env.RIFFET_CLAUDE_HOOK_URL;
const envToken = process.env.RIFFET_HOOK_TOKEN || process.env.RIFFET_CLAUDE_HOOK_TOKEN;
const described = readHookDescriptor(descriptorPath ?? defaultDescriptorPath());
let target = described.state === 'live' ? described : undefined;
if (!target && descriptorPath === undefined && described.state === 'absent' && isHookTarget(envUrl, envToken)) target = { url: envUrl, token: envToken };
const chunks = [];
let size = 0;
for await (const part of process.stdin) {
  size += part.length;
  if (size > maxBytes) process.exit(0);
  chunks.push(part);
}
const raw = Buffer.concat(chunks);

/**
 * The reader's own bar first: a slow or absent bridge must never delay or blank it. `--forward` is
 * the command string from their own settings, run through a shell exactly as Claude Code would.
 */
const rendered = forward
  ? new Promise(resolve => {
      const child = spawn(forward, { shell: true, stdio: ['pipe', 'inherit', 'ignore'] });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
      child.stdin.on('error', () => resolve());
      child.stdin.end(raw);
    })
  : Promise.resolve();

let payload;
try { payload = JSON.parse(raw.toString('utf8')); }
catch { payload = undefined; }
const posted = payload === undefined || !target
  ? Promise.resolve()
  : fetch(`${target.url}/hook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: randomUUID(), payload }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);

await Promise.all([rendered, posted]);
