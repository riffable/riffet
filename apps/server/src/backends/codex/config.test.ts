import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendProfileConfig } from '../types.js';
import { availabilityOf } from './availability.js';
import { executableOf, matchesRuntimeFingerprint, probeAppServer, reportedTraePermission, runtimeFingerprintFor } from './config.js';
import { codexFlavor, traexFlavor, type CodexFlavor } from './flavors.js';

const project = { cwd: '/workspace/profile-test' } as Project;
function profile(flavor: CodexFlavor): NativeBackendProfileConfig {
  return { id: 'local', backendId: flavor.id, name: flavor.profileName, config: { executable: flavor.command } };
}
function legacyFingerprint(value: NativeBackendProfileConfig, flavor: CodexFlavor): string {
  return createHash('sha256').update(JSON.stringify([
    project.cwd, value.id, executableOf(value, flavor), JSON.stringify(value.config),
  ])).digest('hex');
}
afterEach(() => vi.unstubAllEnvs());

describe.each([codexFlavor, traexFlavor])('$label process identity', flavor => {
  it('keeps profile preferences and metadata out of the identity, including property order', () => {
    const builtin = profile(flavor);
    const saved = { ...builtin, config: {
      name: 'Renamed', defaultModel: 'another-model', isDefault: true, enabledModels: ['another-model'],
      backendId: flavor.id, executable: flavor.command, id: 'local', description: 'A presentation change',
    } };
    expect(runtimeFingerprintFor(project, saved, flavor)).toBe(runtimeFingerprintFor(project, builtin, flavor));
    expect(matchesRuntimeFingerprint(legacyFingerprint(builtin, flavor), project, saved, flavor)).toBe(true);
    expect(matchesRuntimeFingerprint(legacyFingerprint(saved, flavor), project, saved, flavor)).toBe(true);
  });

  it.each([
    ['executable', '/different/agent'], ['configDir', '/different/home'],
  ])('does not migrate the builtin binding after a real %s change', (key, value) => {
    const builtin = profile(flavor);
    const changed = { ...builtin, config: { ...builtin.config, [key]: value } };
    expect(matchesRuntimeFingerprint(legacyFingerprint(builtin, flavor), project, changed, flavor)).toBe(false);
    expect(runtimeFingerprintFor(project, changed, flavor)).not.toBe(runtimeFingerprintFor(project, builtin, flavor));
  });

  it('rejects an unknown old fingerprint and changes in thread scope', () => {
    const builtin = profile(flavor);
    const saved = runtimeFingerprintFor(project, builtin, flavor);
    expect(matchesRuntimeFingerprint('0'.repeat(64), project, builtin, flavor)).toBe(false);
    expect(matchesRuntimeFingerprint(saved, { ...project, cwd: '/different/workspace' }, builtin, flavor)).toBe(false);
    expect(matchesRuntimeFingerprint(saved, project, { ...builtin, id: 'another-profile' }, flavor)).toBe(false);
  });
});

it.each(['apiEndpoint', 'apiKey'])('does not migrate an old builtin after changing Codex %s', key => {
  const builtin = profile(codexFlavor);
  const changed = { ...builtin, config: { ...builtin.config, [key]: key === 'apiEndpoint' ? 'https://gateway.example/v1' : 'test-only-key' } };
  expect(matchesRuntimeFingerprint(legacyFingerprint(builtin, codexFlavor), project, changed, codexFlavor)).toBe(false);
});

it('recognizes only unmodified TRAE native presets, never custom effective profiles', () => {
  const settings = { approvalPolicy: 'on-request', approvalsReviewer: 'user', activePermissionProfile: { id: ':workspace', modifications: [] },
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: true, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
  expect(reportedTraePermission(settings)).toBe('on-request');
  expect(reportedTraePermission({ ...settings, approvalsReviewer: 'auto_review' })).toBe('auto-review');
  for (const activePermissionProfile of [
    { id: ':workspace', modifications: [{ type: 'additionalWritableRoot', path: '/outside/workspace' }] },
    { id: ':read-only', modifications: [{ type: 'additionalWritableRoot', path: '/outside/workspace' }] },
    { id: ':danger-full-access', modifications: [{ type: 'additionalWritableRoot', path: '/outside/workspace' }] },
    { id: 'custom-workspace', modifications: [] }, { id: ':workspace' },
  ]) {
    expect(reportedTraePermission({ ...settings, activePermissionProfile })).toBeUndefined();
  }
  expect(reportedTraePermission({ ...settings, activePermissionProfile: null })).toBe('on-request');
  expect(reportedTraePermission({ ...settings, activePermissionProfile: null,
    sandboxPolicy: { ...settings.sandboxPolicy, writableRoots: ['/outside/workspace'] } })).toBeUndefined();
});

it('tracks the effective configuration home inherited by Codex', () => {
  const builtin = profile(codexFlavor);
  vi.stubEnv('CODEX_HOME', '/first/config-home');
  const saved = runtimeFingerprintFor(project, builtin, codexFlavor);
  vi.stubEnv('CODEX_HOME', '/second/config-home');
  expect(matchesRuntimeFingerprint(saved, project, builtin, codexFlavor)).toBe(false);
});

it('refreshes the CLI probe after installation at the same path and retries a previously missing CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-codex-version-'));
  const executable = join(directory, 'codex');
  const current = { ...profile(codexFlavor), config: { executable } };
  const calls = join(directory, 'calls');
  const launcher = (version: string) => `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'call\\n');\nconsole.log(process.argv.includes('--version') ? 'codex-cli ${version}' : 'Usage: app-server --listen unix:// --remote <ADDR> --no-alt-screen');\n`;
  try {
    expect(await availabilityOf(codexFlavor, current)).toMatchObject({ available: false, cliMissing: true });
    await writeFile(executable, `#!${join(directory, 'missing-interpreter')}\n`, { mode: 0o755 });
    const broken = await availabilityOf(codexFlavor, current);
    expect(broken.available).toBe(false);
    expect(broken.cliMissing).toBeUndefined();
    await writeFile(executable, launcher('0.166.0'));
    expect(await availabilityOf(codexFlavor, current)).toEqual({ available: true, version: 'codex-cli 0.166.0' });
    expect((await probeAppServer(executable)).version).toBe('codex-cli 0.166.0');
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(3);
    const previous = await stat(executable);
    const replacement = join(directory, 'replacement');
    await writeFile(replacement, launcher('0.167.2'));
    await chmod(replacement, 0o755);
    await utimes(replacement, previous.atime, previous.mtime);
    await rename(replacement, executable);
    expect((await probeAppServer(executable)).version).toBe('codex-cli 0.167.2');
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('retries the TRAE help command that timed out during cold startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-trae-probe-'));
  const executable = join(directory, 'traex');
  const calls = join(directory, 'calls');
  try {
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const command = process.argv[2];
const calls = ${JSON.stringify(calls)};
fs.appendFileSync(calls, command + '\\n');
if (command === '--version') console.log('traecli 0.217.0');
else if (command === 'resume') console.log('Usage: resume --remote <ADDR> --remote-auth-token-env VAR');
else if (fs.readFileSync(calls, 'utf8').split('app-server').length === 2) {
  process.on('SIGTERM', () => {});
  setTimeout(() => {}, 30_000);
}
else console.log('Usage: app-server --listen ws:// --ws-auth capability-token --ws-token-file FILE');
`, { mode: 0o755 });
    const current = { ...profile(traexFlavor), config: { executable } };
    expect(await availabilityOf(traexFlavor, current)).toEqual({ available: true, version: 'traecli 0.217.0' });
    expect((await readFile(calls, 'utf8')).trim().split('\n').sort())
      .toEqual(['--version', 'app-server', 'app-server', 'resume']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
