import { describe, expect, it } from 'vitest';
import { formatDoctorChecks, satisfiesMinimum } from './doctor.js';
import { cliVersionStatus, versionAtLeast } from './backends/shared/cli-version.js';

describe('doctor', () => {
  it('compares a Node version against a >= engines range', () => {
    expect(satisfiesMinimum('v24.19.0', '>=24.19.0')).toBe(true);
    expect(satisfiesMinimum('v24.20.1', '>=24.19.0')).toBe(true);
    expect(satisfiesMinimum('v25.0.0', '>=24.19.0')).toBe(true);
    expect(satisfiesMinimum('v24.18.9', '>=24.19.0')).toBe(false);
    expect(satisfiesMinimum('v22.0.0', '>=24.19.0')).toBe(false);
    expect(satisfiesMinimum('v24.19.0', '^24')).toBeUndefined();
  });

  it('rates a CLI version against its range, ordering prereleases and ignoring build ids', () => {
    const dsh = { minimum: '0.2.0-rc.2', testedThrough: '0.2.1-rc.2' };
    expect(cliVersionStatus(dsh, 'dsh 0.2.0-rc.1')).toBe('too-old');
    expect(cliVersionStatus(dsh, 'v0.2.0-rc.10')).toBe('supported');
    expect(cliVersionStatus(dsh, '0.2.1-rc.2+build.5')).toBe('supported');
    expect(cliVersionStatus(dsh, '0.2.1')).toBe('untested');
    expect(cliVersionStatus(dsh, 'installation: npm')).toBe('unknown');
    expect(cliVersionStatus({ testedThrough: '2.1.302' }, '2.1.302 (Claude Code)')).toBe('supported');
    expect(cliVersionStatus({ testedThrough: '0.210.1' }, 'traecli 0.211.0\ninstallation: npm')).toBe('untested');
    // Cursor's hyphen suffix is a commit, not a prerelease.
    expect(versionAtLeast('2026.10.01-e373342', '2026.10.01')).toBe(true);
    expect(cliVersionStatus({ testedThrough: '2026.10.01' }, '2026.10.02-a1b2c3d')).toBe('untested');
  });

  it('prints a fix hint only for items that need one', () => {
    const text = formatDoctorChecks([
      { id: 'node', label: 'Node.js', status: 'ok', detail: 'v24.20.0', fix: 'unused' },
      { id: 'tmux', label: 'tmux', status: 'fail', detail: 'missing', fix: 'brew install tmux' },
      { id: 'backend:droid', label: 'Droid', status: 'warn', detail: 'not found', fix: 'install droid' },
    ]);
    expect(text).toContain('✅ Node.js: v24.20.0');
    expect(text).not.toContain('unused');
    expect(text).toContain('❌ tmux: missing\n   → brew install tmux');
    expect(text).toContain('→ install droid');
    expect(text).toContain('1 problem(s) must be fixed, 1 warning(s).');
  });
});
