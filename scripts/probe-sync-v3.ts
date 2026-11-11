/**
 * Probe for sync v3 (docs/SYNC-V3.md, U11) against a running server. It subscribes to one lane of a
 * conversation and checks the protocol: `hello` first, snapshot parts in order with only the final one
 * carrying an id, rows contiguous in seq; then it resumes under the same generation, by query and by
 * `Last-Event-ID`, and checks that only the delta comes; and that `timeline/changes` agrees. It only
 * reads: nothing is sent to, configured on or stopped in the conversation.
 *
 * Run: node --import tsx scripts/probe-sync-v3.ts <baseUrl> <sessionId> [--lane sub:<toolCallId>] [--watch <seconds>] [--pause <seconds>]
 * `--pause` (default 2) is how long it stays away before resuming, so a busy conversation's resume carries rows.
 * Token: RIFFET_TOKEN (the access token, or a paired device's `wkn_…` token), else `<state dir>/access-token`
 * read from RIFFET_STATE_DIR or ~/.local/share/riffet.
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createGunzip } from 'node:zlib';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const [base, sessionId] = args.filter((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
if (!base || !sessionId) throw new Error('Usage: probe-sync-v3.ts <baseUrl> <sessionId> [--lane sub:<toolCallId>] [--watch <seconds>]');
const lane = option('--lane') ?? 'main';
const watchMs = Number(option('--watch') ?? 5) * 1000;
const pauseMs = Number(option('--pause') ?? 2) * 1000;
const origin = new URL(base);

interface Frame { event: string; id?: string; data: any; at: number }
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ check: name, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

function token(): string {
  if (process.env.RIFFET_TOKEN) return process.env.RIFFET_TOKEN.trim();
  return readFileSync(join(process.env.RIFFET_STATE_DIR ?? join(homedir(), '.local/share/riffet'), 'access-token'), 'utf8').trim();
}

/** A device token is a bearer credential; the access token signs in for a cookie. */
async function credentials(): Promise<Record<string, string>> {
  const secret = token();
  if (secret.startsWith('wkn_')) return { authorization: `Bearer ${secret}` };
  const response = await fetch(new URL('/api/auth/login', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: secret }) });
  if (!response.ok) throw new Error(`Sign-in failed: ${response.status} ${await response.text()}`);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]!).find(value => value.startsWith('cw_session='));
  return cookie ? { cookie } : {};
}

/** Opens the sync stream; `until` decides when the probe has seen enough of it. */
function subscribe(headers: Record<string, string>, query: string, until: (frames: Frame[]) => boolean, timeoutMs: number): Promise<{ frames: Frame[]; wireBytes: number; status: number; ended: boolean }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const frames: Frame[] = [];
    let wireBytes = 0, status = 0, ended = false, done = false;
    const url = new URL(`/api/v3/sessions/${encodeURIComponent(sessionId!)}/sync?lane=${encodeURIComponent(lane)}${query}`, origin);
    const finish = () => { if (done) return; done = true; clearTimeout(timer); request.destroy(); resolve({ frames, wireBytes, status, ended }); };
    const timer = setTimeout(finish, timeoutMs);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers: { ...headers, 'accept-encoding': 'gzip', accept: 'text/event-stream' } }, (response: IncomingMessage) => {
      status = response.statusCode ?? 0;
      response.on('data', (chunk: Buffer) => { wireBytes += chunk.length; });
      const body = response.headers['content-encoding'] === 'gzip' ? response.pipe(createGunzip()) : response;
      body.setEncoding('utf8');
      let buffer = '';
      body.on('data', (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const fields = new Map(block.split('\n').filter(line => line && !line.startsWith(':')).map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trimStart()]));
          if (!fields.has('data')) continue;
          frames.push({ event: fields.get('event') ?? 'message', ...(fields.has('id') ? { id: fields.get('id') } : {}), data: JSON.parse(fields.get('data')!), at: performance.now() - started });
          if (until(frames)) finish();
        }
      });
      body.on('end', () => { ended = true; finish(); });
      body.on('error', () => { ended = true; finish(); });
    });
    request.on('error', error => { if (!done) { done = true; clearTimeout(timer); reject(error); } });
    request.end();
  });
}

const ofType = (frames: Frame[], event: string) => frames.filter(frame => frame.event === event);
const ms = (value: number | undefined) => value === undefined ? '—' : `${value.toFixed(0)}ms`;

/** Rows frames continue from `held`, each from the one before; returns where they end, or why not. */
function contiguity(frames: Frame[], held: number): { held: number; gap?: string } {
  for (const frame of ofType(frames, 'rows')) {
    if (frame.data.from !== held + 1) return { held, gap: `rows from ${frame.data.from} after ${held}` };
    if (frame.id !== `${frame.data.generation}:${frame.data.to}`) return { held, gap: `rows id ${frame.id} for to=${frame.data.to}` };
    held = frame.data.to;
  }
  return { held };
}

const headers = { ...(await credentials()) };

// 1. A fresh subscription: hello, the snapshot, then whatever changes while it is watched.
const fresh = await subscribe(headers, '', () => false, watchMs);
check('stream opens (200)', fresh.status === 200, `status ${fresh.status}`);
const hello = fresh.frames[0];
check('hello is the first frame', hello?.event === 'hello', hello ? `first ${hello.event}` : 'no frames');
if (hello?.event !== 'hello') process.exit(1);
check('hello speaks protocol 3 on the asked lane', hello.data.protocol === 3 && hello.data.lane === lane, `protocol ${hello.data.protocol}, lane ${hello.data.lane}`);
check('hello without a resume point asks for a snapshot', hello.data.mode === 'snapshot');
check('hello carries at most 200 live activities and 50 outline turns', hello.data.activities.length <= 200 && hello.data.outline.turns.length <= 50, `${hello.data.activities.length} activities, ${hello.data.outline.turns.length}/${hello.data.outline.turnCount} turns`);
const generation = hello.data.generation as string;
const parts = ofType(fresh.frames, 'snapshot');
const final = parts.find(frame => frame.data.final);
check('snapshot parts arrive in order and end with a final one', parts.length > 0 && parts.every((frame, index) => frame.data.part === index) && parts.at(-1) === final, `${parts.length} parts`);
check('snapshot is of hello\'s generation and seq', Boolean(final) && parts.every(frame => frame.data.generation === generation && frame.data.asOfSeq === hello.data.headSeq));
check('only the final part carries an id', Boolean(final) && final!.id === `${generation}:${hello.data.headSeq}` && parts.slice(0, -1).every(frame => frame.id === undefined), final?.id);
const transcriptAfterSnapshot = fresh.frames.slice(fresh.frames.indexOf(final!) + 1);
const live = contiguity(transcriptAfterSnapshot, hello.data.headSeq);
check('rows are contiguous in seq after the snapshot', !live.gap, live.gap ?? `${ofType(transcriptAfterSnapshot, 'rows').length} rows frames to seq ${live.held}`);
check('no frame exceeds 256KB', fresh.frames.every(frame => Buffer.byteLength(JSON.stringify(frame.data)) <= 256 * 1024));
const resets = ofType(fresh.frames, 'reset');
console.log(`     time to hello ${ms(hello.at)}, to final snapshot part ${ms(final?.at)}; ${fresh.frames.length} frames, ${(fresh.wireBytes / 1024).toFixed(0)}KB on the wire; ${resets.length} resets, ${ofType(fresh.frames, 'status').length} status, ${ofType(fresh.frames, 'error').length} errors`);
for (const error of ofType(fresh.frames, 'error')) console.log(`     error ${error.data.code}: ${error.data.message}`);

if (resets.length) console.log('     the lane started over while watched; resume checks use the newest generation');
const latest = [...fresh.frames].reverse().find(frame => frame.event === 'snapshot' && frame.data.final);
const heldGeneration = (latest?.data.generation ?? generation) as string;
const held = resets.length ? contiguity(fresh.frames.slice(fresh.frames.indexOf(latest!) + 1), latest!.data.asOfSeq).held : live.held;

// 2. Resuming where the client holds the lane: only the delta, contiguous from there.
await new Promise(resolve => setTimeout(resolve, pauseMs));
for (const [label, query, extra] of [
  ['query', `&generation=${heldGeneration}&after=${held}`, {}],
  ['Last-Event-ID', '', { 'last-event-id': `${heldGeneration}:${held}` }],
] as const) {
  const resumed = await subscribe({ ...headers, ...extra }, query, frames => frames.length > 0 && (frames[0]!.data.headSeq <= held || ofType(frames, 'rows').at(-1)?.data.to >= frames[0]!.data.headSeq), Math.max(3_000, watchMs));
  const first = resumed.frames[0];
  const gotDelta = first?.event === 'hello' && first.data.mode === 'delta' && first.data.generation === heldGeneration;
  check(`resume by ${label} gets hello mode delta`, gotDelta, first ? `${first.event} ${first.data.mode ?? ''} ${first.data.generation === heldGeneration ? 'same generation' : 'other generation'}` : 'no frames');
  if (!gotDelta) continue;
  check(`resume by ${label} sends no snapshot`, ofType(resumed.frames, 'snapshot').length === 0);
  const delta = contiguity(resumed.frames, held);
  check(`resume by ${label} continues from seq ${held + 1}`, !delta.gap && delta.held >= first!.data.headSeq, delta.gap ?? `to seq ${delta.held}, head ${first!.data.headSeq}`);
  console.log(`     time to hello ${ms(first!.at)}; ${ofType(resumed.frames, 'rows').length} rows frames`);
}

// 3. The same rule over a plain request.
const changes = await fetch(new URL(`/api/v3/sessions/${encodeURIComponent(sessionId)}/timeline/changes?lane=${encodeURIComponent(lane)}&generation=${heldGeneration}&after=${held}`, origin), { headers });
const body = await changes.json() as { mode?: string; from?: number; headSeq?: number; generation?: string };
check('timeline/changes answers a delta from the same point', changes.ok && body.mode === 'delta' && body.generation === heldGeneration && (body.headSeq === held || body.from === held + 1), `${changes.status} ${body.mode} from ${body.from} head ${body.headSeq}`);

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — failed: ${failed.map(result => result.check).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
