import type { NativeCliVersion, NativeCliVersionStatus } from '@riffet/contracts';

/** A version as an upstream CLI prints it, reduced to what orders it. */
export interface CliVersion {
  major: number;
  minor: number;
  patch: number;
  /** Semver prerelease identifiers (`rc.2` → `['rc', '2']`); empty for a release. */
  prerelease: readonly string[];
  /** The matched version as printed, without a leading `v`. */
  text: string;
}

/**
 * The CLI versions a backend adapter is known to work with. Both ends are optional: only a
 * version proven to break the adapter sets `minimum`, and only one actually exercised end to end
 * sets `testedThrough`.
 */
export interface CliVersionRange {
  /** Below this the adapter is known to be broken. */
  readonly minimum?: string;
  /** The newest version actually verified; anything newer is untested, not refused. */
  readonly testedThrough?: string;
}

const VERSION = /(?<![\d.])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;
/** A commit id after a hyphen is a build, not a prerelease: Cursor prints `2026.10.01-e373342`. */
const COMMIT_SUFFIX = /^(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/i;

/**
 * The first `major.minor.patch[-prerelease][+build]` in a CLI's output, which may carry a product
 * name before it (`codex-cli 0.160.0`) and more after it (`2.1.302 (Claude Code)`, TRAE's
 * `installation: internal` line).
 */
export function parseVersion(output: string | undefined): CliVersion | undefined {
  const match = output ? VERSION.exec(output) : null;
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const suffix = match[4];
  return {
    major: major!, minor: minor!, patch: patch!,
    prerelease: suffix && !COMMIT_SUFFIX.test(suffix) ? suffix.split('.') : [],
    text: match[0].replace(/^v/, ''),
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  // A release ranks above its own prereleases; a shorter prerelease above a longer one it prefixes.
  if (!left.length || !right.length) return Math.sign(right.length - left.length);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB) return Math.sign(Number(a) - Number(b));
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Semver precedence: negative when `left` is older, zero when equal; build ids never count. */
export function compareVersions(left: CliVersion, right: CliVersion): number {
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Whether a version (parsed, or a CLI's raw output) is at least `minimum`; unreadable is not. */
export function versionAtLeast(found: CliVersion | string | undefined, minimum: string): boolean {
  const version = typeof found === 'string' ? parseVersion(found) : found;
  const floor = parseVersion(minimum);
  return Boolean(version && floor && compareVersions(version, floor) >= 0);
}

/** Where a CLI's reported version falls against the range its adapter declares. */
export function cliVersionStatus(range: CliVersionRange | undefined, found: CliVersion | string | undefined): NativeCliVersionStatus {
  const version = typeof found === 'string' ? parseVersion(found) : found;
  if (!version) return 'unknown';
  if (range?.minimum && !versionAtLeast(version, range.minimum)) return 'too-old';
  const tested = range?.testedThrough ? parseVersion(range.testedThrough) : undefined;
  if (tested && compareVersions(version, tested) > 0) return 'untested';
  return 'supported';
}

/**
 * How much of a backend adapter's automation is safe to run against a CLI version:
 * - `blocked`: below `minimum`; the adapter refuses to start.
 * - `full`: within `[minimum, testedThrough]`; all L1 and L2 automation is enabled.
 * - `conservative`: above `testedThrough` or unreadable; L1 basic messaging stays enabled while
 *   L2 fragile automation (multi-step TUI walking, screen layout inference) degrades safely.
 */
export type CliCapabilityMode = 'full' | 'conservative' | 'blocked';

/** Runtime capability gate for a CLI's reported version against its adapter's declared range. */
export function cliCapabilityMode(range: CliVersionRange | undefined, found: CliVersion | string | undefined): CliCapabilityMode {
  const status = cliVersionStatus(range, found);
  if (status === 'too-old') return 'blocked';
  if (status === 'supported') return 'full';
  return 'conservative';
}

/** Whether a CLI version falls within the adapter's verified `[minimum, testedThrough]` range. */
export function isVerifiedCliVersion(range: CliVersionRange | undefined, found: CliVersion | string | undefined): boolean {
  return cliCapabilityMode(range, found) === 'full';
}

/** The public report for a CLI's raw `--version` output, or for none when it could not be read. */
export function cliVersionReport(range: CliVersionRange | undefined, output: string | undefined): NativeCliVersion {
  const version = parseVersion(output);
  return {
    ...(version ? { version: version.text } : {}),
    status: cliVersionStatus(range, version),
    ...(range?.minimum ? { minimum: range.minimum } : {}),
    ...(range?.testedThrough ? { testedThrough: range.testedThrough } : {}),
  };
}
