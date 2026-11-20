import { posix } from 'node:path';
import { shellSegments, type ShellSegment } from './shell-words.js';

/**
 * What a shell command does, in the shape Codex reports for its own commands (`commandActions` on a
 * `commandExecution` item), so a backend whose shell tool sends only a command string (Claude Code's
 * `Bash`) renders its reads and searches the way Codex's do: `Read a.ts, b.ts`, `Search foo in src`.
 *
 * Modeled on Codex's `parse_command`: only programs that read are recognized, a pipeline's trailing
 * formatters (`| head`, `| wc -l`) belong to the command they format, `cd` moves where later paths
 * point, and `echo` separators drop out. The result is all or nothing: one segment that is not a read,
 * a search or a listing, or a line `shellSegments` cannot read, leaves the command as written.
 */
export type CommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'search'; command: string; query?: string; path?: string }
  | { type: 'listFiles'; command: string; path?: string };

/** A segment that only prints or moves, which a summary of the line leaves out. */
const SILENT = new Set(['echo', 'printf', 'true', ':', 'pwd']);
/** Programs that, after a `|`, only shape what the command before them printed. */
const FORMATTERS = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk']);

/** Options of each program that take the next word (or the rest of a short cluster) as their value. */
const SHORT_VALUES: Record<string, string> = {
  head: 'nc', tail: 'nc', nl: 'bdfhilnsvw', grep: 'efABCmdD', rg: 'efgtTABCmMjEr', fd: 'etEdSocj', tree: 'LIP', ls: 'Iw',
  cut: 'bcdf', sort: 'ktS', column: 'cs', 'git-ls-files': 'xX',
};
const LONG_VALUES = new Set([
  '--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count', '--include', '--exclude',
  '--exclude-dir', '--exclude-from', '--label', '--binary-files', '--devices', '--directories', '--glob', '--iglob',
  '--type', '--type-not', '--type-add', '--max-depth', '--max-columns', '--threads', '--encoding', '--replace', '--sort',
  '--sortr', '--colors', '--lines', '--bytes', '--extension',
]);

interface Parsed { options: Array<{ name: string; value?: string }>; operands: string[] }

/** grep's spellings, whose options are grep's. */
const GREPS = new Set(['egrep', 'fgrep', 'git-grep']);

/** Options and operands of `args`, after the conventions most of these programs share. */
function parseArgs(program: string, args: readonly string[]): Parsed {
  const short = SHORT_VALUES[GREPS.has(program) ? 'grep' : program] ?? '';
  const options: Parsed['options'] = [];
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') { operands.push(...args.slice(index + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) options.push({ name: arg.slice(0, eq), value: arg.slice(eq + 1) });
      else if (LONG_VALUES.has(arg) && index + 1 < args.length) options.push({ name: arg, value: args[++index] });
      else options.push({ name: arg });
      continue;
    }
    // `-50` (head, tail) and `+5` after `-n` are counts, never files.
    if (/^-\d+$/.test(arg)) { options.push({ name: '-n', value: arg.slice(1) }); continue; }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const flag = arg[at]!;
        if (short.includes(flag)) {
          const rest = arg.slice(at + 1);
          options.push({ name: `-${flag}`, value: rest || args[++index] });
          break;
        }
        options.push({ name: `-${flag}` });
      }
      continue;
    }
    operands.push(arg);
  }
  return { options, operands };
}

const has = (parsed: Parsed, ...names: string[]) => parsed.options.some(option => names.includes(option.name));
/** A file a summary can name: not standard input, not a device. */
const isFile = (path: string) => path !== '-' && !path.startsWith('/dev/');
/** The search scope worth naming: one directory or file, and not the directory the command runs in. */
const scope = (paths: readonly string[]) => paths.length === 1 && paths[0] !== '.' && paths[0] !== './' ? paths[0] : undefined;

type Action = { type: 'read'; path: string } | { type: 'search'; query?: string; path?: string } | { type: 'listFiles'; path?: string };

/** Programs whose operands are files they print, and their options that make them do something else. */
function readFiles(program: string, args: readonly string[]): Action[] | undefined {
  const parsed = parseArgs(program, args);
  if (program === 'tail' && has(parsed, '-f', '-F', '--follow')) return undefined;
  const files = parsed.operands.filter(isFile);
  return files.length ? files.map(path => ({ type: 'read', path })) : undefined;
}

/** A sed script that prints line ranges (`1,80p`, `$p`), and nothing else. */
const LINE_PRINTS = /^\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?\s*p\s*;?\s*)+$/;
/** A sed script that substitutes in the stream: no `w` (write) or `e` (run) flag, nothing after it. */
const SUBSTITUTION = /^s([^\\\n\w\s])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpiI\d]*$/;

/** `sed -n '1,80p' file`: only line ranges printed, nothing substituted, written or run. */
function sedRead(args: readonly string[]): Action[] | undefined {
  const scripts: string[] = [];
  const operands: string[] = [];
  let quiet = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-e' || arg === '--expression') { scripts.push(args[++index] ?? ''); continue; }
    if (/^-[nEr]+$/.test(arg)) { quiet ||= arg.includes('n'); continue; }
    if (arg === '--quiet' || arg === '--silent') { quiet = true; continue; }
    if (arg.startsWith('-')) return undefined;
    operands.push(arg);
  }
  if (!scripts.length) scripts.push(operands.shift() ?? '');
  if (!quiet || !scripts.every(script => LINE_PRINTS.test(script))) return undefined;
  const files = operands.filter(isFile);
  return files.length ? files.map(path => ({ type: 'read', path })) : undefined;
}

function grepSearch(program: string, args: readonly string[]): Action[] | undefined {
  const parsed = parseArgs(program, args);
  if (program === 'rg' && has(parsed, '--pre')) return undefined;
  if (program === 'rg' && has(parsed, '--files')) {
    return parsed.operands.length ? parsed.operands.map(path => ({ type: 'listFiles', path })) : [{ type: 'listFiles' }];
  }
  const patterns = parsed.options.filter(option => option.name === '-e' || option.name === '--regexp').map(option => option.value ?? '');
  const operands = [...parsed.operands];
  const query = patterns.length ? patterns.join(' | ') : operands.shift();
  if (query === undefined && !has(parsed, '-f', '--file')) return undefined;
  const path = scope(operands);
  return [{ type: 'search', ...(query !== undefined ? { query } : {}), ...(path ? { path } : {}) }];
}

function findSearch(args: readonly string[]): Action[] | undefined {
  if (args.some(arg => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(arg))) return undefined;
  const start = args.findIndex(arg => arg.startsWith('-') || arg === '!' || arg === '(');
  const paths = start < 0 ? [...args] : args.slice(0, start);
  const names = args.flatMap((arg, index) => /^-(i?name|i?path|i?wholename|i?regex)$/.test(arg) && args[index + 1] ? [args[index + 1]!] : []);
  const path = scope(paths);
  return [names.length
    ? { type: 'search', query: names.join(' | '), ...(path ? { path } : {}) }
    : { type: 'listFiles', ...(path ? { path } : {}) }];
}

function fdSearch(args: readonly string[]): Action[] | undefined {
  const parsed = parseArgs('fd', args);
  if (has(parsed, '-x', '-X', '--exec', '--exec-batch')) return undefined;
  const [query, ...paths] = parsed.operands;
  const path = scope(paths);
  return [{ type: 'search', ...(query ? { query } : {}), ...(path ? { path } : {}) }];
}

function listing(program: string, args: readonly string[]): Action[] | undefined {
  const parsed = parseArgs(program, args);
  // `tree -o file` writes the listing to a file.
  if (program === 'tree' && has(parsed, '-o')) return undefined;
  const operands = parsed.operands;
  return operands.length ? operands.map(path => ({ type: 'listFiles', path })) : [{ type: 'listFiles' }];
}

/** `git [-C dir] [--no-pager] grep|ls-files …`, the git commands that search or list files. */
function gitActions(args: readonly string[]): { actions: Action[]; dir?: string } | undefined {
  let index = 0;
  let dir: string | undefined;
  while (index < args.length && args[index]!.startsWith('-')) {
    if (args[index] === '-C') dir = args[index + 1];
    index += args[index] === '-C' || args[index] === '-c' ? 2 : 1;
  }
  const rest = args.slice(index + 1);
  // `-O` opens the matching files in a pager or an editor.
  if (args[index] === 'grep' && rest.some(arg => /^(-O|--open-files-in-pager)/.test(arg))) return undefined;
  const actions = args[index] === 'grep' ? grepSearch('git-grep', rest)
    : args[index] === 'ls-files' ? listing('git-ls-files', rest) : undefined;
  return actions && { actions, ...(dir ? { dir } : {}) };
}

/** A formatter after `|` that only shapes the output before it: no files of its own, nothing written. */
function formats(program: string, args: readonly string[]): boolean {
  if (!FORMATTERS.has(program)) return false;
  // Only flags that change no file, and scripts that print ranges or substitute in the stream.
  if (program === 'sed') {
    const scripts = args.filter(arg => arg !== '-e' && !/^-[nEr]+$/.test(arg));
    return args.length > 0 && scripts.every(arg => !arg.startsWith('-') && (LINE_PRINTS.test(arg) || SUBSTITUTION.test(arg)));
  }
  if (program === 'tr') return true;
  if (program === 'awk') return args.length === 1 && !/system|getline|[>|]/.test(args[0]!);
  if (program === 'rg' && args.some(arg => arg.startsWith('--pre'))) return false;
  if (program === 'grep' || program === 'egrep' || program === 'fgrep' || program === 'rg') return parseArgs(program, args).operands.length <= 1;
  if (program === 'sort') return !args.some(arg => /^(-[a-zA-Z]*o|--output)/.test(arg));
  if (program === 'tail' && args.some(arg => /^-[a-zA-Z]*[fF]/.test(arg))) return false;
  return parseArgs(program, args).operands.every(arg => /^[+-]?\d+$/.test(arg));
}

/** Where `path` points from `cwd`, written the way the command wrote it when the command never left. */
function placed(path: string, cwd: string | undefined): string {
  if (!cwd || posix.isAbsolute(path) || path.startsWith('~')) return path;
  return posix.normalize(posix.join(cwd, path));
}

/** The actions of one pipeline, or undefined when any of its commands is not a read, a search or a listing. */
function pipelineActions(pipeline: readonly ShellSegment[]): { actions: Action[]; dir?: string } | undefined {
  const [head, ...tail] = pipeline;
  const words = (segment: ShellSegment) => {
    const start = segment.words.findIndex(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    return start < 0 ? [] : segment.words.slice(start);
  };
  // A program named by a relative path (`./cat`) is whatever that file is, not the system's.
  const name = (word: string | undefined) => word && (!word.includes('/') || posix.isAbsolute(word)) ? word.split('/').at(-1) : undefined;
  const first = words(head!);
  const program = name(first[0]);
  const args = first.slice(1);
  if (!program) return undefined;
  // A program fed by an earlier command in the pipe that is not itself a formatter: `… | xargs grep`.
  for (const segment of tail) {
    const formatter = words(segment);
    const formatterName = name(formatter[0]);
    if (!formatterName || !formats(formatterName, formatter.slice(1))) return undefined;
  }
  switch (program) {
    case 'cat': case 'head': case 'tail': case 'nl': case 'wc': case 'less': case 'more': {
      const actions = readFiles(program, args);
      return actions && { actions };
    }
    case 'sed': { const actions = sedRead(args); return actions && { actions }; }
    case 'grep': case 'egrep': case 'fgrep': case 'rg': { const actions = grepSearch(program, args); return actions && { actions }; }
    case 'find': { const actions = findSearch(args); return actions && { actions }; }
    case 'fd': case 'fdfind': { const actions = fdSearch(args); return actions && { actions }; }
    case 'ls': case 'tree': { const actions = listing(program, args); return actions && { actions }; }
    case 'git': return gitActions(args);
    default: return undefined;
  }
}

export function commandActions(command: string): CommandAction[] | undefined {
  const segments = shellSegments(command);
  if (!segments?.length) return undefined;
  const pipelines: ShellSegment[][] = [];
  for (const segment of segments) {
    if (segment.piped && pipelines.length) pipelines.at(-1)!.push(segment);
    else pipelines.push([segment]);
  }
  const result: CommandAction[] = [];
  let cwd: string | undefined;
  /**
   * A search or listing with no path of its own runs where the line moved to. Named only when that
   * is relative: an absolute `cd` is usually into the project root, which a title would show as `.`.
   */
  const where = (path: string | undefined, base: string | undefined) => path ? { path: placed(path, base) }
    : base && base !== '.' && !posix.isAbsolute(base) && !base.startsWith('~') ? { path: base } : {};
  for (const pipeline of pipelines) {
    const words = pipeline[0]!.words;
    if (pipeline.length === 1 && words[0] === 'cd') {
      const target = words[1];
      // A directory the line cannot know (`cd -`, `cd $DIR`) would misplace every later path.
      if (!target || target === '-' || target.includes('$')) return undefined;
      cwd = target.startsWith('~') || posix.isAbsolute(target) ? target : posix.normalize(posix.join(cwd ?? '.', target));
      continue;
    }
    if (pipeline.length === 1 && SILENT.has(words[0]!)) continue;
    const parsed = pipelineActions(pipeline);
    if (!parsed) return undefined;
    const text = pipeline.map(segment => segment.words.join(' ')).join(' | ');
    const base = parsed.dir ? placed(parsed.dir, cwd) : cwd;
    for (const action of parsed.actions) {
      if (action.type === 'read') {
        const path = placed(action.path, base);
        result.push({ type: 'read', command: text, name: posix.basename(path), path });
      } else if (action.type === 'search') {
        result.push({ type: 'search', command: text, ...(action.query !== undefined ? { query: action.query } : {}), ...where(action.path, base) });
      } else {
        result.push({ type: 'listFiles', command: text, ...where(action.path, base) });
      }
    }
  }
  return result.length ? result : undefined;
}
