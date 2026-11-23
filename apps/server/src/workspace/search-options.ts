import { AppError } from '../errors.js';

// Find in Files options: what the route accepts, how they become ripgrep arguments, and the same
// semantics in JavaScript for the walk that runs when ripgrep is not installed.

export interface SearchOptions {
  /** Case-sensitive; the default is case-insensitive. */
  caseSensitive?: boolean;
  /** Whole words only. */
  word?: boolean;
  /** The query is a regular expression (Rust syntax with ripgrep, JavaScript without); the default is a fixed string. */
  regex?: boolean;
  /** File masks, comma-separated (`*.kt,*.java`); only matching files are searched. */
  include?: string;
  /** Masks or directories (`build,*.min.js`) that are not searched. */
  exclude?: string;
}

const MAX_MASKS = 32;
const MAX_MASK_LENGTH = 200;
/** A JavaScript regular expression longer than this is refused by the fallback walk: it has no time limit of its own. */
const MAX_FALLBACK_REGEX = 200;

export function parseMasks(list: string | undefined): string[] {
  const masks = (list ?? '').split(',').map(item => item.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '')).filter(Boolean);
  if (masks.length > MAX_MASKS || masks.some(mask => mask.length > MAX_MASK_LENGTH)) throw new AppError('INVALID_QUERY', 'Too many or too long file masks');
  return masks;
}

/** One glob as a pattern for a project-relative path: `*` and `?` stay inside a segment, `**` crosses them. */
function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/**
 * Tests a project-relative path against masks. A mask without `/` matches a file name (an exclude also
 * matches any directory name on the way); one with `/` matches a path from any depth. An exclude also
 * covers everything below a match.
 */
export function maskMatcher(masks: readonly string[], below: boolean): (relative: string) => boolean {
  const tests = masks.map((mask) => {
    const slashed = mask.includes('/');
    const source = globSource(mask);
    return { slashed, whole: new RegExp(slashed ? `^(?:.*/)?${source}$` : `^${source}$`, 'i') };
  });
  return (relative) => {
    const parts = relative.split('/');
    return tests.some(({ slashed, whole }) => {
      if (!below) return slashed ? whole.test(relative) : whole.test(parts.at(-1)!);
      if (!slashed) return parts.some(part => whole.test(part));
      for (let end = 1; end <= parts.length; end++) if (whole.test(parts.slice(0, end).join('/'))) return true;
      return false;
    });
  };
}

/** Arguments that narrow ripgrep to the masks while it still honours ignore files (a plain `-g` include would override them). */
export function ripgrepMaskArgs(options: SearchOptions): { args: string[]; filter?: (relative: string) => boolean } {
  const args: string[] = [];
  const include = parseMasks(options.include);
  const exclude = parseMasks(options.exclude);
  let filter: ((relative: string) => boolean) | undefined;
  if (include.length) {
    // File types match the file name only; masks with a directory part are checked on each hit instead.
    if (include.some(mask => mask.includes('/'))) filter = maskMatcher(include, false);
    else for (const mask of include) args.push('--type-add', `mask:${mask}`);
    if (!filter) args.push('-t', 'mask');
  }
  for (const mask of exclude) args.push('-g', `!${mask.includes('/') ? '**/' : ''}${mask}`);
  return { args, filter };
}

/** The query as a JavaScript matcher, for the walk without ripgrep. */
export function lineMatcher(query: string, options: SearchOptions): (line: string) => boolean {
  if (options.regex && query.length > MAX_FALLBACK_REGEX) throw new AppError('INVALID_QUERY', 'Regular expression is too long to search without ripgrep');
  const body = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const expression = new RegExp(options.word ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body, options.caseSensitive ? 'u' : 'iu');
    return line => expression.test(line);
  } catch (error) {
    throw new AppError('INVALID_QUERY', error instanceof Error ? error.message : 'Invalid regular expression');
  }
}
