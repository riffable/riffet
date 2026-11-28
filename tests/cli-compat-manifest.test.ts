import { describe, expect, it } from 'vitest';
import {
  cliCapabilityMode,
  cliVersionStatus,
  isVerifiedCliVersion,
  parseVersion,
  type CliVersionRange,
} from '@riffet/plugin-api/kit';
import {
  BUILTIN_CLI_BACKENDS,
  TCK_SCENARIO_IDS,
  checkManifestConsistency,
  loadManifest,
  mergeBackendRun,
  readDeclaredCliVersions,
  type CompatManifest,
} from '../scripts/cli-compat/manifest.js';
import {
  UPSTREAM_CHANNELS,
  checkUpstreamVersions,
  formatUpstreamTable,
  resolveAntigravityManifestUrl,
} from '../scripts/cli-compat/upstream.js';

describe('cliCapabilityMode and isVerifiedCliVersion', () => {
  const range: CliVersionRange = { minimum: '2.1.200', testedThrough: '2.1.332' };

  it('blocks versions below minimum', () => {
    expect(cliVersionStatus(range, '2.1.199')).toBe('too-old');
    expect(cliCapabilityMode(range, '2.1.199')).toBe('blocked');
    expect(isVerifiedCliVersion(range, '2.1.199')).toBe(false);
    expect(cliCapabilityMode(range, parseVersion('2.0.999 (Claude Code)'))).toBe('blocked');
  });

  it('enables full mode within [minimum, testedThrough] inclusive', () => {
    for (const version of ['2.1.200', '2.1.302', '2.1.332', '2.1.332 (Claude Code)']) {
      expect(cliCapabilityMode(range, version)).toBe('full');
      expect(isVerifiedCliVersion(range, version)).toBe(true);
    }
    expect(cliCapabilityMode({ testedThrough: '0.172.0' }, 'codex-cli 0.172.0')).toBe('full');
    expect(cliCapabilityMode({ testedThrough: '2026.11.22-e9042b2' }, '2026.11.22-e9042b2')).toBe('full');
  });

  it('degrades to conservative mode for versions newer than testedThrough', () => {
    expect(cliVersionStatus(range, '2.1.333')).toBe('untested');
    expect(cliCapabilityMode(range, '2.1.333')).toBe('conservative');
    expect(isVerifiedCliVersion(range, '2.1.333')).toBe(false);
    expect(cliCapabilityMode(range, '3.0.0')).toBe('conservative');
  });

  it('degrades to conservative mode when version is unknown or unreadable', () => {
    for (const unknown of [undefined, '', 'not-a-version']) {
      expect(cliVersionStatus(range, unknown)).toBe('unknown');
      expect(cliCapabilityMode(range, unknown)).toBe('conservative');
      expect(isVerifiedCliVersion(range, unknown)).toBe(false);
    }
    expect(cliCapabilityMode(undefined, undefined)).toBe('conservative');
    expect(cliCapabilityMode(undefined, '1.0.0')).toBe('full');
  });

  it('respects semver prerelease ordering', () => {
    const dshRange: CliVersionRange = { minimum: '0.2.0-rc.2', testedThrough: '0.2.2-rc.5' };
    expect(cliCapabilityMode(dshRange, '0.2.0-rc.1')).toBe('blocked');
    expect(cliCapabilityMode(dshRange, '0.2.0-rc.2')).toBe('full');
    expect(cliCapabilityMode(dshRange, '0.2.2-rc.5')).toBe('full');
    expect(cliCapabilityMode(dshRange, '0.2.2')).toBe('conservative');
  });
});

describe('compat-manifest consistency', () => {
  it('matches real compat-manifest.json against all 8 declared source cliVersions', () => {
    const manifest = loadManifest();
    const declared = readDeclaredCliVersions();

    expect(Object.keys(declared).sort()).toEqual([...BUILTIN_CLI_BACKENDS].sort());
    expect(TCK_SCENARIO_IDS).toHaveLength(40);

    const result = checkManifestConsistency(manifest, declared);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('detects testedThrough drift', () => {
    const manifest = loadManifest();
    const declared = readDeclaredCliVersions();
    const drifted: CompatManifest = {
      ...manifest,
      backends: {
        ...manifest.backends,
        claude: { ...manifest.backends.claude!, testedThrough: '2.1.999' },
      },
    };

    const result = checkManifestConsistency(drifted, declared);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('claude: testedThrough mismatch'))).toBe(true);
  });

  it('detects minimum drift', () => {
    const manifest = loadManifest();
    const declared = readDeclaredCliVersions();
    const drifted: CompatManifest = {
      ...manifest,
      backends: {
        ...manifest.backends,
        pi: { ...manifest.backends.pi!, minimum: '1.3.0' },
      },
    };

    const result = checkManifestConsistency(drifted, declared);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('pi: minimum mismatch'))).toBe(true);
  });

  it('rejects any scenario in fail state', () => {
    const manifest = loadManifest();
    const declared = readDeclaredCliVersions();
    const failed = mergeBackendRun(manifest, 'codex', {
      scenarios: { 'steer-valid': { status: 'fail', note: 'receipt mismatch' } },
    });

    const result = checkManifestConsistency(failed, declared);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('codex.steer-valid') && error.includes('"fail"'))).toBe(true);
  });

  it('rejects missing built-in backend, empty core passes, and unknown scenario IDs', () => {
    const manifest = loadManifest();
    const declared = readDeclaredCliVersions();

    const { droid: _dropped, ...withoutDroid } = manifest.backends;
    const missingResult = checkManifestConsistency({ ...manifest, backends: withoutDroid }, declared);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.some(error => error.includes('Missing built-in CLI backend "droid"'))).toBe(true);

    const noCorePass = mergeBackendRun(manifest, 'pi', {
      scenarios: {
        'probe-basic': { status: 'not-exercised' },
        'basic-turn': { status: 'not-exercised' },
      },
    });
    const noCoreResult = checkManifestConsistency(noCorePass, declared);
    expect(noCoreResult.ok).toBe(false);
    expect(noCoreResult.errors.some(error => error.includes('pi: at least one core scenario'))).toBe(true);

    const unknownScenario: CompatManifest = {
      ...manifest,
      backends: {
        ...manifest.backends,
        codex: {
          ...manifest.backends.codex!,
          scenarios: {
            ...manifest.backends.codex!.scenarios,
            ...({ 'bogus-scenario': { status: 'pass' } } as Record<string, { status: 'pass' }>),
          },
        },
      },
    };
    const unknownResult = checkManifestConsistency(unknownScenario, declared);
    expect(unknownResult.ok).toBe(false);
    expect(unknownResult.errors.some(error => error.includes('unknown scenario id "bogus-scenario"'))).toBe(true);
  });

  it('merges partial runs without mutating the input manifest or erasing untouched scenarios when version is unchanged', () => {
    const original = loadManifest();
    const merged = mergeBackendRun(original, 'claude', {
      testedThrough: original.backends.claude!.testedThrough,
      testedAt: '2026-11-29',
      scenarios: { 'multi-turn': { status: 'pass', note: 'TCK run' } },
    });

    expect(original.backends.claude!.scenarios['multi-turn']?.status).toBe('not-exercised');
    expect(merged.backends.claude!.scenarios['multi-turn']).toEqual({ status: 'pass', note: 'TCK run' });
    expect(merged.backends.claude!.scenarios['basic-turn']?.status).toBe('pass');
    expect(merged.backends.claude!.testedAt).toBe('2026-11-29');
  });

  it('resets unexercised historical scenarios to not-exercised when testedThrough changes', () => {
    const original = loadManifest();
    expect(original.backends.claude!.scenarios['basic-turn']?.status).toBe('pass');

    const bumped = mergeBackendRun(original, 'claude', {
      testedThrough: '2.2.0',
      testedAt: '2026-12-01',
      scenarios: {
        'probe-basic': { status: 'pass', note: 'version=2.2.0' },
      },
    });

    expect(bumped.backends.claude!.testedThrough).toBe('2.2.0');
    expect(bumped.backends.claude!.scenarios['probe-basic']).toEqual({ status: 'pass', note: 'version=2.2.0' });
    // Historical pass from previous version must NOT carry over to the new version.
    expect(bumped.backends.claude!.scenarios['basic-turn']).toEqual({
      status: 'not-exercised',
      note: 'reset on version change',
    });
    // Original manifest remains untouched.
    expect(original.backends.claude!.scenarios['basic-turn']?.status).toBe('pass');
  });
});

describe('resolveAntigravityManifestUrl', () => {
  it('resolves platform/arch dynamically with darwin_arm64 fallback', () => {
    expect(resolveAntigravityManifestUrl('darwin', 'arm64')).toMatch(/\/darwin_arm64\.json$/);
    expect(resolveAntigravityManifestUrl('darwin', 'x64')).toMatch(/\/darwin_x64\.json$/);
    expect(resolveAntigravityManifestUrl('linux', 'x64')).toMatch(/\/linux_x64\.json$/);
    expect(resolveAntigravityManifestUrl('win32', 'x64')).toMatch(/\/darwin_arm64\.json$/);
  });
});

describe('checkUpstreamVersions', () => {
  it('parses npm dist-tags, JSON manifests, manual channels, and degrades errors cleanly', async () => {
    const responses: Record<string, () => Promise<Response>> = {
      [UPSTREAM_CHANNELS.claude.url!]: async () =>
        new Response(JSON.stringify({ latest: '2.1.340', stable: '2.1.332' }), { status: 200 }),
      [UPSTREAM_CHANNELS.codex.url!]: async () =>
        new Response(JSON.stringify({ 'dist-tags': { latest: '0.172.0' } }), { status: 200 }),
      [UPSTREAM_CHANNELS.pi.url!]: async () =>
        new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' }),
      [UPSTREAM_CHANNELS.dsh.url!]: async () => {
        throw new Error('network unreachable');
      },
      [UPSTREAM_CHANNELS.traex.url!]: async () =>
        new Response(JSON.stringify({ version: '0.218.0' }), { status: 200 }),
      [UPSTREAM_CHANNELS.antigravity.url!]: async () =>
        new Response(JSON.stringify({ version: '1.5.18' }), { status: 200 }),
    };

    const mockFetch: typeof fetch = async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const handler = responses[url];
      if (!handler) throw new Error(`Unexpected URL: ${url}`);
      return await handler();
    };

    const installed: Record<string, string | undefined> = {
      claude: '2.1.332',
      codex: '0.172.0',
      traex: '0.217.0',
      pi: '1.7.0',
      dsh: '0.2.2-rc.5',
      droid: '1.21.1',
      antigravity: '1.5.18',
      cursor: '2026.11.22-e9042b2',
    };

    const results = await checkUpstreamVersions({
      fetchImpl: mockFetch,
      declared: readDeclaredCliVersions(),
      probeLocalVersion: async id => installed[id],
      timeoutMs: 1_000,
    });

    const byId = Object.fromEntries(results.map(item => [item.backendId, item]));
    expect(byId.claude).toMatchObject({
      status: 'ok',
      testedThrough: '2.1.332',
      installedVersion: '2.1.332',
      installedStatus: 'supported',
      upstreamVersion: '2.1.340',
      stableVersion: '2.1.332',
      upstreamAhead: true,
    });
    expect(byId.codex).toMatchObject({
      status: 'ok',
      upstreamVersion: '0.172.0',
      upstreamAhead: false,
    });
    expect(byId.traex).toMatchObject({
      status: 'ok',
      upstreamVersion: '0.218.0',
      upstreamAhead: true,
    });
    expect(byId.antigravity).toMatchObject({
      status: 'ok',
      upstreamVersion: '1.5.18',
      upstreamAhead: false,
    });
    expect(byId.pi).toMatchObject({ status: 'error' });
    expect(byId.pi!.error).toContain('HTTP 503');
    expect(byId.dsh).toMatchObject({ status: 'error' });
    expect(byId.dsh!.error).toContain('network unreachable');
    expect(byId.droid?.status).toBe('manual');
    expect(byId.droid?.upstreamVersion).toBeUndefined();
    expect(byId.cursor?.status).toBe('manual');
    expect(byId.cursor?.upstreamVersion).toBeUndefined();

    const table = formatUpstreamTable(results);
    expect(table).toContain('Backend');
    expect(table).toContain('claude');
    expect(table).toContain('upgrade-available');
    expect(table).toContain('up-to-date');
    expect(table).toContain('manual');
    expect(table).toContain('error');
    expect(table).toContain('stable=2.1.332');
  });
});
