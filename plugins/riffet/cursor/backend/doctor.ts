import type { CapabilityReport } from '@contracts';
import { cliCheck, type DoctorCheck } from '@riffet/plugin-api';
import { CURSOR_CLI_VERSIONS } from '../cli-adapter.js';

/**
 * `riffet doctor`'s row for cursor-agent. Its capability report has already run `--version` and
 * asked who is signed in, so neither is asked again. `profileExecutables` lists the executables of
 * the saved profiles and throws when they cannot be read. Handed to `doctorChecks` like any Agent's
 * `Contributions.doctorChecks`.
 */
export async function cursorDoctorChecks(profileExecutables: () => ReadonlyArray<string | undefined>, capabilities: Pick<CapabilityReport, 'authenticated' | 'cliVersion' | 'cliPath'>): Promise<DoctorCheck[]> {
  const commands = [capabilities.cliPath];
  let note = '';
  try {
    for (const executable of profileExecutables()) if (executable?.trim()) commands.push(executable.trim());
  } catch { note = '; saved profiles could not be read'; }
  return [await cliCheck({
    id: 'cursor', name: 'Cursor CLI', commands, note, versions: CURSOR_CLI_VERSIONS,
    install: 'Install it with `curl https://cursor.com/install -fsS | bash`, or pass --cli <path>.',
    readVersion: async () => capabilities.cliVersion,
    blocked: where => capabilities.authenticated ? undefined : {
      detail: `${where}${capabilities.cliVersion ? ` · ${capabilities.cliVersion}` : ''} · not signed in${note}`,
      fix: 'Run `cursor-agent login`, or save an API key in 设置 → 模型设置 → Cursor.',
    },
  })];
}
