#!/usr/bin/env node
// Records a Perfetto trace of the Android app while you use it, then prints its main-thread frame
// times. Usage: node scripts/android-frame-trace.mjs [seconds=10] [package=io.github.riffetai.android]
// Compare a debug build only against another debug build; release frames are several times faster.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const seconds = Number(process.argv[2] ?? 10);
const app = process.argv[3] ?? 'io.github.riffetai.android';
const work = mkdtempSync(join(tmpdir(), 'riffet-trace-'));
const device = `/data/misc/perfetto-traces/riffet-${Date.now()}.pftrace`;
const local = join(work, 'trace.pftrace');

const config = `
buffers { size_kb: 65536 fill_policy: RING_BUFFER }
data_sources { config { name: "linux.ftrace" ftrace_config {
  ftrace_events: "sched/sched_switch"
  atrace_categories: "gfx" atrace_categories: "view" atrace_categories: "input"
  atrace_apps: "${app}" } } }
data_sources { config { name: "linux.process_stats" } }
duration_ms: ${seconds * 1000}
`;

console.log(`Recording ${seconds}s — use the app now.`);
execFileSync('adb', ['shell', 'perfetto', '--txt', '-c', '-', '-o', device], { input: config, stdio: ['pipe', 'ignore', 'inherit'] });
execFileSync('adb', ['pull', device, local], { stdio: 'ignore' });
execFileSync('adb', ['shell', 'rm', device]);

const prebuilts = join(homedir(), '.local/share/perfetto/prebuilts');
const processor = [
  ...(existsSync(prebuilts) ? readdirSync(prebuilts).filter(name => name.startsWith('trace_processor_shell')).map(name => join(prebuilts, name)) : []),
  'trace_processor_shell',
].find(candidate => {
  try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
});
if (!processor) {
  console.log(`Trace saved to ${local}. Open it in https://ui.perfetto.dev (trace_processor_shell not found).`);
  process.exit(0);
}

const query = join(work, 'frames.sql');
writeFileSync(query, `
select cast(s.dur / 1e6 as int) as ms from slice s
join thread_track tt on s.track_id = tt.id join thread t using (utid) join process p using (upid)
where p.name = '${app}' and t.tid = p.pid and s.depth = 0 and s.name like 'Choreographer#doFrame%'
order by s.ts;
`);
const frames = execFileSync(processor, ['-q', query, local], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  .split('\n').slice(1).map(Number).filter(Number.isFinite);
const over = limit => frames.filter(ms => ms > limit).length;
console.log(`${frames.length} frames · >16ms ${over(16)} · >32ms ${over(32)} · >100ms ${over(100)}`);
console.log(`in order (ms): ${frames.join(' ')}`);
console.log(`trace: ${local}`);
