// Authenticated loopback transport for native CLI hooks (Claude, Cursor). It fails open: any problem
// exits 0 with no output, which a hook protocol reads as "no decision".
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { defaultDescriptorPath, isHookTarget, readHookDescriptor } from './hook-target.mjs';

const maxBytes = 1024 * 1024;
const args = process.argv.slice(2);
const flagged = new Set();
const flagValue = flag => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  flagged.add(index); flagged.add(index + 1);
  return args[index + 1];
};
const configPath = flagValue('--config');
const descriptorPath = flagValue('--descriptor');
// The Riffet conversation the CLI was launched for. Its hooks name the CLI's own session, which a
// `/clear` replaces; this lets the server find the conversation's runtime for the new one.
const owner = flagValue('--owner');

// Where to post, in order. The server's address changes on every restart, so the descriptor is read
// now and never remembered. A CLI started before descriptors existed only has the old environment
// address: that one is tried first (its server may still be alive) and the default descriptor
// replaces it when nothing answers there.
const targets = [];
let legacyFallback = false;
try {
  if (configPath !== undefined) {
    const data = await readFile(configPath, 'utf8');
    if (data.length > 8192) process.exit(0);
    const config = JSON.parse(data);
    if (isHookTarget(config.url, config.token)) targets.push({ url: config.url, token: config.token });
  } else if (descriptorPath !== undefined) {
    const found = readHookDescriptor(descriptorPath);
    if (found.state === 'live') targets.push(found);
  } else {
    const url = process.env.RIFFET_HOOK_URL || process.env.RIFFET_CLAUDE_HOOK_URL;
    const token = process.env.RIFFET_HOOK_TOKEN || process.env.RIFFET_CLAUDE_HOOK_TOKEN;
    if (isHookTarget(url, token)) targets.push({ url, token });
    legacyFallback = true;
  }
} catch { process.exit(0); }
if (!targets.length && !legacyFallback) process.exit(0);

const timeoutArg = args.find((arg, index) => !flagged.has(index) && /^\d+$/.test(arg));
const timeoutMs = Number(timeoutArg) > 0 ? Number(timeoutArg) : 10 * 60_000;
const chunks = [];
let size = 0;
for await (const part of process.stdin) {
  size += part.length;
  if (size > maxBytes) process.exit(0);
  chunks.push(part);
}
try {
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const body = JSON.stringify({ deliveryId: randomUUID(), payload: owner && payload && typeof payload === 'object' ? { ...payload, riffet_owner: owner } : payload });
  // `node:http`, not `fetch`: fetch gives up on a response that has not started after five minutes
  // (undici's headers timeout), which would end every hook that waits on a person long before its own
  // deadline. A server that closes the connection (it exited, or the turn ended) ends this at once.
  const post = target => new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    // A hook that waited out its own deadline is over; only an address nobody answers is retried.
    const timer = setTimeout(() => { req.destroy(); finish({ response: undefined, final: true }); }, timeoutMs);
    const req = request(`${target.url}/hook`, {
      method: 'POST', headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      const parts = [];
      let received = 0;
      res.on('data', part => { received += part.length; if (received > maxBytes) { req.destroy(); finish({ response: undefined, final: true }); } else parts.push(part); });
      res.on('end', () => finish({ response: { ok: res.statusCode >= 200 && res.statusCode < 300, text: Buffer.concat(parts).toString('utf8') } }));
      res.on('error', () => finish({ response: undefined }));
      res.on('close', () => finish({ response: undefined }));
    });
    req.on('error', () => finish({ response: undefined }));
    req.end(body);
  });
  let result = { response: undefined };
  for (const target of targets) {
    result = await post(target);
    if (result.response || result.final) break;
  }
  if (!result.response && !result.final && legacyFallback) {
    const found = readHookDescriptor(defaultDescriptorPath());
    if (found.state === 'live') result = await post(found);
  }
  const { response } = result;
  if (!response?.ok) process.exit(0);
  const { text } = response;
  if (text.length > maxBytes) process.exit(0);
  const output = JSON.stringify(JSON.parse(text));
  await new Promise(resolve => process.stdout.write(`${output}\n`, resolve));
} catch {
  // Never print prompts, credentials, or native hook diagnostics.
}
