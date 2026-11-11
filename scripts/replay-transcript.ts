import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, createServer } from 'vite';

/**
 * Records a session's sync stream and replays it into the real web transcript in headless Chrome,
 * reporting every frame where rows moved, remounted or vanished for no reason a reader would accept
 * (docs/WEB.md, 转录回放), and every layout shift the browser saw with no animation carrying it
 * (`unanimated-shift`, docs/WEB.md 布局稳定性). Nothing is sent to the session: the recorder only
 * reads, and the replay page has no server at all.
 *
 *   pnpm replay:transcript record <sessionId> [--seconds 120] [--until-idle] [--out file.jsonl]
 *   pnpm replay:transcript run <file.jsonl> [--speed 1] [--max-gap 1500] [--width 1280] [--height 900] [--headed] [--json report.json]
 *
 * `record` signs in to the local server with ~/.local/share/riffet/access-token (RIFFET_URL, default
 * http://localhost:4337). `run` exits 1 when the report has incidents.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

async function record(sessionId: string) {
  const base = process.env.RIFFET_URL ?? 'http://localhost:4337';
  const token = readFileSync(join(homedir(), '.local/share/riffet/access-token'), 'utf8').trim();
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token }) });
  if (!login.ok) throw new Error(`Sign-in failed: ${login.status}`);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const out = option('out', `transcript-${sessionId.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)!;
  const file = createWriteStream(out);
  // The session itself arrives in the stream's hello.
  file.write(`${JSON.stringify({ recording: 1, sessionId, recordedAt: new Date().toISOString() })}\n`);

  const controller = new AbortController();
  const seconds = Number(option('seconds', '0'));
  if (seconds > 0) setTimeout(() => controller.abort(), seconds * 1000);
  process.on('SIGINT', () => controller.abort());
  const response = await fetch(`${base}/api/v3/sessions/${sessionId}/sync?lane=main`, { headers: { cookie, Accept: 'text/event-stream' }, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`Stream failed: ${response.status}`);
  const started = performance.now();
  let frames = 0;
  let busy = false;
  let pending = '';
  let event: { type?: string; id?: string; data: string[] } = { data: [] };
  const decoder = new TextDecoder();
  console.log(`Recording ${sessionId} into ${out}${seconds > 0 ? ` for ${seconds}s` : ''}; Ctrl-C stops.`);
  try {
    const reader = response.body.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const chunk = read.value;
      const t = Math.round(performance.now() - started);
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line === '') {
          if (event.type && event.data.length) {
            const data = event.data.join('\n');
            file.write(`${JSON.stringify({ t, type: event.type, data, ...(event.id ? { id: event.id } : {}) })}\n`);
            frames += 1;
            if (event.type === 'status' || event.type === 'hello') {
              const phase = (JSON.parse(data) as { status?: { phase?: string } }).status?.phase;
              if (phase === 'busy') busy = true;
              else if (busy && phase === 'idle' && flag('until-idle')) controller.abort();
            }
          }
          event = { data: [] };
        } else if (line.startsWith('event:')) event.type = line.slice(6).trim();
        else if (line.startsWith('data:')) event.data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('id:')) event.id = line.slice(3).trim();
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  // A turn that just went idle still settles its rows; give them a moment to arrive.
  await new Promise((done) => file.end(done));
  console.log(`${frames} frames recorded.`);
}

/** The DevTools protocol over Node's own WebSocket: one browser connection, one page session. */
async function devtools(url: string) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let next = 0;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.onmessage = (message) => {
    const reply = JSON.parse(String(message.data)) as { id?: number; result?: unknown; error?: { message: string } };
    const entry = reply.id === undefined ? undefined : waiting.get(reply.id);
    if (!entry) return;
    waiting.delete(reply.id!);
    if (reply.error) entry.reject(new Error(reply.error.message));
    else entry.resolve(reply.result);
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, close: () => socket.close() };
}

function chromePath(): string {
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH');
  return found;
}

interface Incident { kind: string; at: number; frame: number; frames: string[]; key?: string; dy?: number; rows?: number; value?: number; nodes?: string[] }
interface Report { frames: number; samples: number; durationMs: number; counts: Record<string, number>; incidents: Incident[]; closedAt?: number }

async function run(file: string) {
  const text = readFileSync(file, 'utf8');
  const width = Number(option('width', '1280'));
  const height = Number(option('height', '900'));
  // The page asks the absent server for themes and the like; those proxy failures are not the replay's.
  const logger = createLogger('error');
  const error = logger.error;
  logger.error = (message, options) => { if (!message.includes('http proxy error')) error(message, options); };
  const server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), server: { port: 0, strictPort: false, hmr: false }, customLogger: logger });
  await server.listen();
  const origin = server.resolvedUrls?.local[0];
  if (!origin) throw new Error('The dev server did not report its address');

  const profile = mkdtempSync(join(tmpdir(), 'riffet-replay-'));
  const chrome = spawn(chromePath(), [
    ...(flag('headed') ? [] : ['--headless=new']), '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise<string>((done, fail) => {
    let log = '';
    chrome.stderr!.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (match) done(match[1]!);
    });
    chrome.on('exit', () => fail(new Error(`Chrome exited before DevTools was ready:\n${log}`)));
  });

  let report: Report | undefined;
  try {
    const browser = await devtools(endpoint);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method: string, params?: Record<string, unknown>) => browser.send(method, params, sessionId);
    await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page('Page.enable');
    await page('Page.navigate', { url: new URL('replay.html', origin).href });
    for (let tries = 0; ; tries += 1) {
      const { result } = await page('Runtime.evaluate', { expression: 'typeof window.__replay', returnByValue: true });
      if (result.value === 'function') break;
      if (tries > 600) throw new Error('The replay page did not load');
      await new Promise((done) => setTimeout(done, 100));
    }
    const clock = { speed: Number(option('speed', '1')), maxGap: Number(option('max-gap', '1500')) };
    const evaluated = await page('Runtime.evaluate', { expression: `window.__replay(${JSON.stringify(text)}, ${JSON.stringify(clock)})`, awaitPromise: true, returnByValue: true });
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
    report = evaluated.result.value as Report;
    browser.close();
  } finally {
    // Chrome keeps writing its profile until it has exited.
    const exited = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((done) => chrome.once('exit', done));
    chrome.kill();
    await Promise.all([exited, server.close()]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }

  const out = option('json');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`${report.frames} frames, ${report.samples} samples, ${(report.durationMs / 1000).toFixed(1)}s`);
  if (report.closedAt !== undefined) {
    console.log(`The sync engine closed the stream at frame ${report.closedAt} (a gap or reset in the recording); later frames did not play.`);
    process.exitCode = 1;
  }
  const kinds = Object.entries(report.counts);
  if (!kinds.length) { console.log('No incidents.'); return; }
  for (const [kind, count] of kinds) console.log(`  ${kind.padEnd(16)} ${count}`);
  for (const incident of report.incidents.slice(0, 40)) {
    const detail = [
      incident.key, incident.dy !== undefined ? `${incident.dy > 0 ? '+' : ''}${incident.dy}px` : '', incident.rows ? `${incident.rows} rows` : '',
      incident.value !== undefined ? `score ${incident.value}` : '', incident.nodes?.slice(0, 3).join('; '), incident.nodes && incident.nodes.length > 3 ? `+${incident.nodes.length - 3} nodes` : '',
    ].filter(Boolean).join(' ');
    console.log(`  ${String(incident.at).padStart(7)}ms  frame ${String(incident.frame).padStart(5)}  ${incident.kind.padEnd(16)} ${detail}  [${incident.frames.join(',')}]`);
  }
  if (report.incidents.length > 40) console.log(`  … ${report.incidents.length - 40} more${out ? ` in ${out}` : ''}`);
  process.exitCode = 1;
}

const [command, target] = args;
if (command === 'record' && target) await record(target);
else if (command === 'run' && target) await run(target);
else {
  console.error('Usage: replay-transcript record <sessionId> [--seconds N] [--until-idle] [--out file] | run <file> [--speed N] [--max-gap ms] [--width px] [--height px] [--headed] [--json file]');
  process.exitCode = 2;
}
