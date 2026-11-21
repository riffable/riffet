#!/usr/bin/env node
// Android performance checks (docs/guide/android-performance.md §3). Run against the benchmark build
// (`./gradlew :androidApp:assembleBenchmark`), never the debug build: debug code runs interpreted and
// is several times slower, so its numbers say nothing about what users see.
//
//   node scripts/android-perf.mjs seed <dir> [--server http://127.0.0.1:4399]
//       Writes Claude Code transcripts that stress the app (a 260-turn session with diagrams, tables
//       and code; 700-line edits; 6,000-line outputs; screenshots; 44 short sessions over 4 git
//       projects) under <dir>, then imports them into a server started with
//       CLAUDE_CONFIG_DIR=<dir>/claude RIFFET_ENV_KEEP=CLAUDE_CONFIG_DIR --no-auth. Nothing is sent to an agent.
//   node scripts/android-perf.mjs frames reset
//   node scripts/android-perf.mjs frames report [label]
//       Main-thread time per frame (input to sync) for the last 120 frames since `reset`.
//   node scripts/android-perf.mjs profile <seconds> [filter]
//       Samples the main thread with simpleperf while you drive the app, then prints the app's
//       frames by inclusive share. The benchmark build keeps real names for exactly this.
//
// RIFFET_PACKAGE overrides the package (default io.github.riffable.android.benchmark).
import { execFileSync } from 'node:child_process';
import { seed } from './perf-seed.mjs';

const app = process.env.RIFFET_PACKAGE ?? 'io.github.riffable.android.benchmark';
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
const [command, ...rest] = process.argv.slice(2);

if (command === 'frames') frames(rest[0], rest[1]);
else if (command === 'profile') profile(Number(rest[0] ?? 8), rest[1]);
else if (command === 'seed') await seed(rest[0], rest.includes('--server') ? rest[rest.indexOf('--server') + 1] : 'http://127.0.0.1:4399');
else {
  console.error('usage: android-perf.mjs seed <dir> | frames reset|report [label] | profile <seconds> [filter]');
  process.exit(2);
}

function frames(action, label = '') {
  if (action === 'reset') { adb('shell', 'dumpsys', 'gfxinfo', app, 'reset'); return; }
  const out = adb('shell', 'dumpsys', 'gfxinfo', app, 'framestats');
  let header = null;
  const ui = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('Flags,')) { header = line.split(','); continue; }
    if (!header || !/^\d/.test(line)) continue;
    const row = Object.fromEntries(line.split(',').map((value, index) => [header[index], Number(value)]));
    if (row.Flags !== 0) continue;
    ui.push((row.SyncQueued - row.HandleInputStart) / 1e6);
  }
  const sorted = [...ui].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const over = limit => ui.filter(ms => ms > limit).length;
  console.log(`${label} | frames ${ui.length} · p50 ${at(0.5).toFixed(1)} · p90 ${at(0.9).toFixed(1)} · max ${(sorted.at(-1) ?? 0).toFixed(1)} ms · >16ms ${over(16)} · >32ms ${over(32)}`);
}

function profile(seconds, filter = 'riffet\\.') {
  const pid = adb('shell', 'pidof', app).trim();
  if (!pid) throw new Error(`${app} is not running`);
  console.log(`Sampling the main thread for ${seconds}s — use the app now.`);
  adb('shell', `simpleperf record --app ${app} -t ${pid} -e cpu-clock -g -f 2000 --duration ${seconds} -o /data/local/tmp/riffet-perf.data`);
  const report = adb('shell', 'simpleperf report -i /data/local/tmp/riffet-perf.data --children --sort symbol --percent-limit 1');
  const pattern = new RegExp(`${filter}|Choreographer\\.doFrame`);
  for (const line of report.split('\n')) if (/^\s*[\d.]+%/.test(line) && pattern.test(line)) console.log(line.slice(0, 180));
}
