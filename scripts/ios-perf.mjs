#!/usr/bin/env node
// iPhone performance checks (docs/guide/ios-performance.md §3), on a simulator running a Debug build.
// Nothing here goes through XCTest: once XCTest attaches to the app, accessibility automation stays on
// and adds its own work to every frame (about 40 ms per frame on a long transcript), so frames are
// measured with the app's own monitors instead.
//
//   node scripts/ios-perf.mjs seed <dir> [--server http://127.0.0.1:4399]
//       The same stress data as Android (scripts/perf-seed.mjs).
//   node scripts/ios-perf.mjs launch [--open <session-id>] [--stall-ms 17]
//       Relaunches the app, logging every main-thread stall over --stall-ms (StallMonitor), and opens
//       the session when given (PerfProbe, Debug builds only).
//   node scripts/ios-perf.mjs open <session-id> [seconds]
//       Opens the session in the running app (PerfProbe) and prints the stalls in the next seconds (default 6).
//   node scripts/ios-perf.mjs type [count,interval-ms]
//       Types into the composer on screen (default 150 characters, one per 60 ms) and prints the stalls.
//   node scripts/ios-perf.mjs stalls <seconds>
//       Collects the stalls logged while you drive the app, then prints their count, sum and largest.
//   node scripts/ios-perf.mjs scroll <speed,distance,cycles>...
//       Scrolls the page on screen at a constant speed (points per second), towards the top and back,
//       and prints frame pacing and the stalls during it.
//   node scripts/ios-perf.mjs sample <seconds> [filter]
//       Samples the main thread with `sample`, then prints the app's frames by inclusive time.
//
// RIFFET_SIMULATOR_ID picks the simulator (default: the booted one).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from './perf-seed.mjs';

const bundle = 'io.github.riffable.iphone';
const device = process.env.RIFFET_SIMULATOR_ID ?? 'booted';
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const predicate = `subsystem == "${bundle}" AND category == "perf"`;
const [command, ...rest] = process.argv.slice(2);
const option = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);

if (command === 'seed') await seed(rest[0], option('--server', 'http://127.0.0.1:4399'));
else if (command === 'launch') launch();
else if (command === 'open') await open(rest[0], Number(rest[1] ?? 6));
else if (command === 'type') await type(rest[0] ?? '150,60');
else if (command === 'stalls') report(await collect(Number(rest[0] ?? 5) * 1000), 'stalls');
else if (command === 'scroll') for (const spec of rest) await scroll(spec);
else if (command === 'sample') sample(Number(rest[0] ?? 5), rest[1]);
else {
  console.error('usage: ios-perf.mjs seed <dir> | launch [--open <id>] [--stall-ms n] | open <id> [s] | type [n,ms] | stalls <s> | scroll <speed,distance,cycles>... | sample <s> [filter]');
  process.exit(2);
}

function launch() {
  try { simctl('terminate', device, bundle); } catch {}
  const args = ['-riffet.perf.stallMs', option('--stall-ms', '17')];
  const open = option('--open');
  if (open) args.push('-riffet.perf.open', `riffet://session?id=${open}`);
  simctl('launch', device, bundle, ...args);
}

async function open(id, seconds) {
  simctl('spawn', device, 'defaults', 'write', bundle, 'riffet.perf.open', `riffet://session?id=${id}`);
  const lines = collect(seconds * 1000);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  simctl('spawn', device, 'notifyutil', '-p', `${bundle}.perf.open`);
  report(await lines, `open ${id}`);
}

async function type(spec) {
  simctl('spawn', device, 'defaults', 'write', bundle, 'riffet.perf.type', spec);
  const lines = collect(120_000, / typed \d+ characters/);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  simctl('spawn', device, 'notifyutil', '-p', `${bundle}.perf.type`);
  const seen = await lines;
  console.log(seen.find((line) => / typed /.test(line))?.replace(/.* typed /, 'typed ') ?? 'no result (is the composer on screen?)');
  report(seen, '  stalls');
}

/** The perf log lines for `ms`, or until `until` matches one of them. */
function collect(ms, until) {
  return new Promise((resolve) => {
    const lines = [];
    const stream = spawn('xcrun', ['simctl', 'spawn', device, 'log', 'stream', '--level', 'info', '--style', 'compact', '--predicate', predicate]);
    const done = () => { clearTimeout(timer); stream.kill(); resolve(lines); };
    const timer = setTimeout(done, ms);
    let buffered = '';
    stream.stdout.on('data', (chunk) => {
      buffered += chunk;
      const parts = buffered.split('\n');
      buffered = parts.pop();
      for (const line of parts) {
        lines.push(line);
        if (until && until.test(line)) done();
      }
    });
  });
}

function report(lines, label) {
  const stalls = lines.map((line) => /stall (\d+) ms/.exec(line)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  const sum = stalls.reduce((a, b) => a + b, 0);
  console.log(stalls.length
    ? `${label}: ${stalls.length} stalls, ${sum} ms in all, largest ${stalls.at(-1)} ms  [${stalls.join(' ')}]`
    : `${label}: no stalls over the threshold`);
}

async function scroll(spec) {
  simctl('spawn', device, 'defaults', 'write', bundle, 'riffet.perf.scroll', spec);
  const lines = collect(120_000, / scroll .*frames=/);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  simctl('spawn', device, 'notifyutil', '-p', `${bundle}.perf.scroll`);
  const seen = await lines;
  const result = seen.find((line) => / scroll .*frames=/.test(line))?.replace(/.* scroll /, '') ?? 'no result (is a scrollable page on screen?)';
  console.log(`scroll ${spec}: ${result}`);
  report(seen, '  stalls');
}

function sample(seconds, filter) {
  const pid = execFileSync('pgrep', ['-f', 'Riffet.app/Riffet'], { encoding: 'utf8' }).trim().split('\n')[0];
  const file = join(mkdtempSync(join(tmpdir(), 'riffet-sample-')), 'main.txt');
  execFileSync('sample', [pid, String(seconds), '1', '-mayDie', '-file', file], { stdio: 'ignore' });
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((line) => /Thread_\d+.*(Main Thread|com\.apple\.main-thread)/.test(line));
  const totals = new Map();
  for (const line of lines.slice(start + 1)) {
    if (/^\s{4}\d+ Thread_/.test(line)) break;
    const match = /^[\s+!:|]*(\d+)\s+(.*?)\s+\(in ([^)]+)\)/.exec(line);
    if (!match || !match[3].startsWith('Riffet')) continue;
    const name = match[2].replace(/\s+\+ \d+.*$/, '');
    if (filter && !name.includes(filter)) continue;
    totals.set(name, (totals.get(name) ?? 0) + Number(match[1]));
  }
  console.log(`main thread, ${seconds} s, samples in the app's own code (1 sample = 1 ms):`);
  for (const [name, count] of [...totals].sort((a, b) => b[1] - a[1]).slice(2, 32)) console.log(`${String(count).padStart(6)}  ${name.slice(0, 150)}`);
}
