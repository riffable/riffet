import type { DoctorCheck } from '../index.js';
import { describeSearch, resolveCliExecutable } from './cli-resolve.js';
import { cliVersionReport, type CliVersionRange } from './cli-version.js';

export interface CliCheckInput {
  /** The check is reported as `backend:<id>`, labelled `<name> (<id>)`. */
  id: string;
  name: string;
  /** The command to look for, then each profile's own executable. */
  commands: readonly string[];
  install: string;
  versions: CliVersionRange;
  /** Appended to every detail, such as the note that saved profiles could not be read. */
  note?: string;
  /** What `--version` printed for the first CLI found, or undefined when it did not answer. */
  readVersion(executable: string): Promise<string | undefined>;
  /** The CLI is there but cannot be used yet (not signed in): the warning to give instead of rating its version. */
  blocked?(where: string): { detail: string; fix: string } | undefined;
}

/**
 * The doctor's row for one Agent CLI: where it was found, or what was searched; a CLI outside its
 * adapter's declared range is a warning, since only the adapter's own checks refuse one.
 * `installed` tells `riffet doctor` that at least one CLI exists on this machine.
 */
export async function cliCheck(input: CliCheckInput): Promise<DoctorCheck & { installed: boolean }> {
  const { id, versions } = input, note = input.note ?? '';
  const label = `${input.name} (${id})`;
  const resolutions = [...new Set(input.commands)].map(command => resolveCliExecutable({ command }));
  const found = resolutions.filter(resolution => resolution.resolved);
  if (!found.length) {
    return { id: `backend:${id}`, label, status: 'warn', detail: `not found: ${[...new Set(input.commands)].join(', ')}${note}.${describeSearch(resolutions[0]!, 4)}`, fix: input.install, installed: false };
  }
  const where = found.map(resolution => resolution.executable).join(', ');
  const blocked = input.blocked?.(where);
  if (blocked) return { id: `backend:${id}`, label, status: 'warn', ...blocked, installed: true };
  const report = cliVersionReport(versions, await input.readVersion(found[0]!.executable));
  const detail = `${where}${report.version ? ` · ${report.version}` : ''}`;
  if (report.status === 'too-old') {
    return { id: `backend:${id}`, label, status: 'warn', detail: `${detail} · below the supported minimum ${report.minimum}${note}`, fix: `Update ${input.name} to ${report.minimum} or newer.`, installed: true };
  }
  if (report.status === 'untested') {
    return { id: `backend:${id}`, label, status: 'warn', detail: `${detail} · newer than ${report.testedThrough}, the newest verified with Riffet${note}`, fix: `Usable as is; if sessions misbehave, install ${report.testedThrough}.`, installed: true };
  }
  return { id: `backend:${id}`, label, status: 'ok', detail: `${detail}${note}`, installed: true };
}
