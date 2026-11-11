#!/usr/bin/env node
// The Riffet MCP server a conversation's CLI spawns over stdio (docs/DEVICES.md §2). Standalone on
// purpose: it runs next to the CLI, not in the server, and only forwards `tools/list` and
// `tools/call` to the server's restricted route with the conversation's own credential. The
// credential file is named on the command line; the secret in it never appears there. The file is
// read on every request, so a server that restarted on another port is found again.
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const argv = process.argv.slice(2);
const credentialIndex = argv.indexOf('--credential');
const credentialFile = credentialIndex >= 0 ? argv[credentialIndex + 1] : process.env.RIFFET_MCP_CREDENTIAL_FILE;

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

/*
 * A device call waits for the device for up to 300 s (docs/DEVICES.md §3). `fetch` would give up on
 * the response headers after 300 s, so the request is made with node:http and its own limit.
 */
const CALL_TIMEOUT_MS = 330_000;
const LIST_TIMEOUT_MS = 60_000;

function post(url, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(`${url}/api/riffet-mcp`);
    const payload = Buffer.from(JSON.stringify(body));
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('The Riffet server did not answer in time'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
    request.end(payload);
  });
}

function credential() {
  if (!credentialFile) throw new Error('No Riffet credential file was given');
  const saved = JSON.parse(readFileSync(credentialFile, 'utf8'));
  if (typeof saved?.url !== 'string' || typeof saved?.credential !== 'string') throw new Error('The Riffet credential file is not usable yet; the server has not reported its address');
  return saved;
}

async function forward(method, params) {
  let lastError;
  // A server restarting under the CLI is retried briefly; a tool call is only retried before it reached the server.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      // An unreadable credential file means nothing was sent yet.
      const { url, credential: token } = credential();
      response = await post(url, token, { method, params }, method === 'tools/call' ? CALL_TIMEOUT_MS : LIST_TIMEOUT_MS)
        .catch(error => { throw Object.assign(new Error(error?.message ?? String(error)), { sent: error?.code !== 'ECONNREFUSED' }); });
    } catch (error) {
      lastError = error;
      // Only a refused connection proves the request never arrived; anything else may have run.
      if (method === 'tools/call' && error?.sent) break;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    let data;
    try { data = JSON.parse(response.text); } catch { data = undefined; }
    if (response.status < 200 || response.status >= 300) throw new Error(`${data?.error?.code ?? `HTTP_${response.status}`}: ${data?.error?.message ?? response.text.slice(0, 300)}`);
    return data?.result;
  }
  throw new Error(`Riffet is unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function handle(message) {
  const { id, method, params } = message ?? {};
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') { if (isRequest) fail(id, -32600, 'Invalid request'); return; }
  // Notifications (`notifications/initialized`, `notifications/cancelled`) need no answer.
  if (!isRequest) return;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'riffet', version: '1' },
        instructions: 'Riffet tools for this conversation: read saved session references already delivered here, schedule a later wake-up of this same conversation, notify the user, list paired devices, and use the capabilities of the devices this conversation was given (device_* tools).',
      });
      return;
    }
    case 'ping': reply(id, {}); return;
    case 'tools/list':
    case 'tools/call':
      try { reply(id, await forward(method, params)); }
      catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        // A failed call is a tool error the agent can read; a failed listing is a protocol error.
        if (method === 'tools/call') reply(id, { content: [{ type: 'text', text }], isError: true });
        else fail(id, -32603, text);
      }
      return;
    case 'resources/list': reply(id, { resources: [] }); return;
    case 'prompts/list': reply(id, { prompts: [] }); return;
    default: fail(id, -32601, `Method not found: ${method}`);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); return; }
  const task = Promise.resolve(Array.isArray(message) ? Promise.all(message.map(handle)) : handle(message)).catch(() => undefined);
  pending.add(task);
  task.finally(() => pending.delete(task));
});
lines.on('close', () => { void Promise.allSettled([...pending]).then(() => process.exit(0)); });
