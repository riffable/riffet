// Semver ranges for a package's `hostApi`, without a dependency: the host API versions are whole
// numbers (`PLUGIN_API_VERSION = 1` is compared as `1.0.0`), so pre-releases and hyphen ranges
// are not supported and an unreadable range never matches.

type Version = [number, number, number];
interface Parsed { version: Version; given: number }

const PART = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;

function parse(text: string): Parsed | undefined {
  const match = PART.exec(text);
  if (!match) return undefined;
  const numbers: number[] = [];
  for (const part of [match[1], match[2], match[3]]) {
    if (part === undefined || /^[xX*]$/.test(part)) break;
    numbers.push(Number(part));
  }
  return { version: [numbers[0]!, numbers[1] ?? 0, numbers[2] ?? 0], given: numbers.length };
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The first version past everything `given` components of `version` cover: `1` -> 2.0.0, `1.2` -> 1.3.0. */
function after({ version, given }: Parsed): Version {
  return given <= 1 ? [version[0] + 1, 0, 0] : given === 2 ? [version[0], version[1] + 1, 0] : [version[0], version[1], version[2] + 1];
}

function comparator(token: string): ((version: Version) => boolean) | undefined {
  if (token === '*' || /^[xX]$/.test(token)) return () => true;
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
  const parsed = match && parse(match[2]!);
  if (!match || !parsed) return undefined;
  const { version, given } = parsed;
  switch (match[1] ?? '') {
    case '': case '=': { const upper = after(parsed); return v => compare(v, version) >= 0 && compare(v, upper) < 0; }
    case '>=': return v => compare(v, version) >= 0;
    case '>': { const upper = after(parsed); return v => compare(v, upper) >= 0; }
    case '<': return v => compare(v, version) < 0;
    case '<=': { const upper = after(parsed); return v => compare(v, upper) < 0; }
    case '~': { const upper: Version = given >= 2 ? [version[0], version[1] + 1, 0] : [version[0] + 1, 0, 0]; return v => compare(v, version) >= 0 && compare(v, upper) < 0; }
    default: {
      // ^: nothing at or past the first non-zero component changes.
      const upper: Version = version[0] > 0 || given <= 1 ? [version[0] + 1, 0, 0] : version[1] > 0 || given === 2 ? [0, version[1] + 1, 0] : [0, 0, version[2] + 1];
      return v => compare(v, version) >= 0 && compare(v, upper) < 0;
    }
  }
}

function compile(range: string): Array<Array<(version: Version) => boolean>> | undefined {
  const alternatives = range.split('||').map(part => part.trim());
  const compiled: Array<Array<(version: Version) => boolean>> = [];
  for (const alternative of alternatives) {
    // `>= 1` and `>=1` are the same comparator.
    const tokens = alternative.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!tokens.length) return undefined;
    const checks = tokens.map(comparator);
    if (checks.some(check => !check)) return undefined;
    compiled.push(checks as Array<(version: Version) => boolean>);
  }
  return compiled;
}

export function validRange(range: unknown): range is string {
  return typeof range === 'string' && range.length <= 128 && compile(range) !== undefined;
}

/** Whether host API version `version` (a whole number, or `major.minor.patch`) satisfies `range`. */
export function satisfies(version: number | string, range: string): boolean {
  const parsed = parse(String(version));
  const compiled = compile(range);
  if (!parsed || !compiled) return false;
  return compiled.some(checks => checks.every(check => check(parsed.version)));
}
