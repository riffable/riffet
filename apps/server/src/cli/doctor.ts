import { homedir } from 'node:os';
import { applyProcessEnvironment, currentEnvironmentReport } from '../environment.js';
import { SettingsService } from '../settings/index.js';
import { doctorChecks, machineReport, type DoctorCheck, type DoctorSection } from '../doctor.js';
import { compactDatabase, recordCompaction } from '../storage/compaction.js';
import { active, stateDir } from './context.js';
import { serviceEnvironment } from './service.js';
import { CliError, MARK, columns, mark, out, plural, printJson, printLines, spinner, success, truncate } from './ui.js';

/** Paths under the home directory read as `~/…`, as everywhere else in the CLI. */
const tildeAll = (text: string) => text.split(homedir()).join('~');

function render(sections: DoctorSection[]): string[] {
  const labelCells = Math.min(24, Math.max(...sections.flatMap(section => section.checks.map(check => check.label.length))));
  const lines: string[] = [];
  for (const section of sections) {
    if (lines.length) lines.push('');
    lines.push(out.bold(section.title));
    for (const check of section.checks) {
      const [row] = columns([[mark(check.status), out.bold(truncate(check.label, labelCells).padEnd(labelCells)), check.status === 'ok' ? out.dim(tildeAll(check.detail)) : tildeAll(check.detail)]], { indent: 2 });
      lines.push(row!);
      if (check.status !== 'ok' && check.fix) lines.push(`      ${out.dim(MARK.arrow)} ${out.prose(tildeAll(check.fix))}`);
    }
  }
  const all = sections.flatMap(section => section.checks);
  const failed = all.filter(check => check.status === 'fail').length, warned = all.filter(check => check.status === 'warn').length;
  lines.push('', failed ? `${out.fail(MARK.fail)} ${out.bold(plural(failed, 'problem'))}${warned ? out.dim(` · ${plural(warned, 'warning')}`) : ''}`
    : warned ? `${out.ok(MARK.ok)} ${out.bold('Ready')}${out.dim(` · ${plural(warned, 'warning')}`)}`
    : `${out.ok(MARK.ok)} ${out.bold('Everything looks good')}`);
  return lines;
}

/** Evaluating plugins logs what the report itself shows (a package that did not load); keep that out of the report. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => undefined;
  try { return await work(); } finally { Object.assign(console, saved); }
}

/** One report that explains a machine, instead of only failing on it. */
export async function doctor(options: { stateDir: string; host: string; port: string; cli: string; json?: boolean; compact?: boolean }): Promise<void> {
  const dir = stateDir(options.stateDir);
  if (options.compact) {
    if (await active(dir)) throw new CliError('Stop Riffet before compacting its database', ['riffet stop']);
    const progress = spinner('Compacting databases');
    let result: ReturnType<typeof recordCompaction>;
    try { result = recordCompaction(dir, () => compactDatabase(dir)); } finally { progress.stop(); }
    if (result.error) throw new CliError(result.error);
    success('Compacted databases');
    return;
  }
  const progress = options.json ? undefined : spinner('Checking this machine');
  let environment: Awaited<ReturnType<typeof applyProcessEnvironment>>, machine: Awaited<ReturnType<typeof machineReport>>, sections: DoctorSection[];
  try {
    environment = currentEnvironmentReport() ?? await applyProcessEnvironment({ stateDir: dir });
    const settings = new SettingsService({ stateDir: dir, cliPath: options.cli });
    machine = await machineReport();
    sections = await quietly(async () => doctorChecks({ stateDir: dir, host: options.host, port: options.port, settings, machine, daemon: await active(dir) }));
  } finally { progress?.stop(); }
  const checks: Array<DoctorCheck & { group: string }> = sections.flatMap(section => section.checks.map(check => ({ ...check, group: section.title })));
  if (checks.some(check => check.status === 'fail')) process.exitCode = 1;
  if (!options.json) { printLines(render(sections)); return; }
  printJson({
    environment: {
      platform: environment.platform,
      shell: environment.shell,
      node: environment.node,
      pathSource: environment.path.source,
      path: environment.path.value,
      addedDirectories: environment.path.added,
      ...(environment.path.note ? { pathNote: environment.path.note } : {}),
      droppedVariables: environment.dropped,
      serviceEnvironment: Object.keys(serviceEnvironment()),
    },
    capabilities: machine,
    checks,
  });
}
