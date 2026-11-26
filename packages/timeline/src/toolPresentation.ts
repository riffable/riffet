import { isRecord, records, str } from './values.js';
import { cleanLabel, commandHeadline, describeCommandActions, formatTargetList, isCommandTitle, shortFileLabels, stripRoot, toolDataKind } from './toolTitle.js';

/*
 * Unified one-line presentation for tool calls across all agents (docs/design/DECISIONS.md
 * "工具调用统一四槽位语法与 Shell 语义摘要", docs/design/system/surfaces.md §1.4).
 *
 * Pure functions over a tool event's data — no DOM, no locale strings, no LLM calls — so
 * historical sessions and every client render from the same rules while keeping raw commands,
 * outputs and diffs intact for click-to-expand inspection.
 */

export type ToolVerb =
  | 'Read'
  | 'Edit'
  | 'Write'
  | 'Delete'
  | 'Move'
  | 'Search'
  | 'List'
  | 'Run'
  | 'Git'
  | 'Fetch'
  | 'MCP'
  | 'Plan'
  | 'Ask'
  | 'Send'
  | 'Mode'
  | 'Image'
  | 'Agent'
  | 'Tool';

export type ToolIconKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'git'
  | 'fetch'
  | 'mcp'
  | 'agent'
  | 'message'
  | 'question'
  | 'plan'
  | 'switch_mode'
  | 'image'
  | 'think'
  | 'other';

export interface ToolRowPresentation {
  icon: ToolIconKind;
  verb: ToolVerb;
  /** Muted interpreter/runtime prefix before the primary target (e.g. `python3`, `node`). */
  prefix?: string;
  primary: string;
  primaryKind: 'path' | 'code' | 'prose';
  /** Muted secondary argument or scope (e.g. search file `gen-contracts.ts`, git arg `main`). */
  secondary?: string;
  /** Line range for file reads (`L155–194`). */
  lineRange?: string;
  /** Line count shown for fallback inline scripts (`28 lines`). */
  lineCount?: number;
  /** Additional sub-commands in a chained shell line (`+2`). */
  extraCommands?: number;
  /** Additional edited files beyond those listed inline (`+4 files`). */
  extraFiles?: number;
  /** Adjacent calls sharing a non-empty `mergeKey` collapse into one row with `×N`. */
  mergeKey?: string;
  /** Generalized `secondary` when merged calls differ only by an ID (e.g. `actions/runs/…/jobs`). */
  mergedSecondary?: string;
}

const ROOT_CD = /^cd\s+\.?\s*(?:&&|;)\s*/;
const SHELL_WRAPPER = /^(?:\/(?:usr\/)?bin\/)?(?:z|ba|da|k|a)?sh\s+-[a-z]*c\s+([\s\S]+)$/;

/** Unwrap `/bin/zsh -lc '...'` or `/bin/bash -c "..."` envelopes emitted by Codex/CLI shells. */
function unwrapShell(raw: string): string {
  const trimmed = raw.trim();
  const match = SHELL_WRAPPER.exec(trimmed);
  if (!match) return trimmed;
  const inner = match[1]!.trim();
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
    return inner.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  return inner;
}

/** Collapse long absolute paths outside the project root (`~/.cursor/…/terminals/426378.txt`, `/tmp/…/pack.log`). */
export function compactDisplayPath(path: string, root?: string): string {
  const rel = stripRoot(path.trim(), root).replace(/^\.\//, '');
  if (!rel.startsWith('/') && !rel.startsWith('~')) return rel;
  const home = rel.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
  const leadingSlash = home.startsWith('/');
  const parts = home.split('/').filter(Boolean);
  if (parts.length === 3 && leadingSlash && (parts[0] === 'tmp' || parts[0] === 'var') && parts[1]!.length > 18) {
    return `/${parts[0]}/…/${parts[2]}`;
  }
  if (parts.length <= 3) return home;
  const first = leadingSlash ? `/${parts[0]}` : parts[0]!;
  const second = parts[1]!;
  const last = parts[parts.length - 1]!;
  const parent = parts[parts.length - 2]!;
  // Keep `~/.cursor/…/terminals/file.txt` when the leading dir is a short dot-dir or `/tmp`.
  const head = first === '~' && second.startsWith('.') && second.length <= 16 ? `${first}/${second}` : first;
  const tail = parent.length <= 18 && !/^[0-9a-f-]{16,}$/i.test(parent) && !/-[0-9]+\.[0-9]+\.[0-9]+\./.test(parent)
    ? `${parent}/${last}`
    : last;
  return `${head}/…/${tail}`;
}

/** Compact a search regex or query for one-line display: no shell quotes, bounded OR branches. */
export function compactSearchQuery(raw: string): string {
  const fallback = cleanLabel(raw);
  let q = fallback.replace(/^['"]|['"]$/g, '');
  q = q.replace(/^\\b|\\b$/g, '');
  if (q.startsWith('(?:') && q.endsWith(')') && isWrappedGroup(q)) {
    q = q.slice(3, -1);
  } else if (q.startsWith('(') && q.endsWith(')') && isWrappedGroup(q)) {
    q = q.slice(1, -1);
  }
  if (q.includes('|')) {
    const parts = q.split(/\\?\|/).map(part => part.trim()).filter(Boolean);
    if (parts.length > 2) {
      const two = `${parts[0]}|${parts[1]}`;
      q = two.length <= 20 ? `${two}…` : `${parts[0]!.slice(0, 18)}…`;
    }
  }
  if (!q) q = fallback;
  if (q.length > 24) q = `${q.slice(0, 22)}…`;
  return q;
}

/** True when the opening `(` at index 0 closes only at the final character of `text`. */
function isWrappedGroup(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\') { i += 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i === text.length - 1;
    }
  }
  return false;
}

/** Compact a search target path: basename for a single file, last 2 segments for a directory. */
export function compactSearchScope(path: string | undefined, root?: string): string | undefined {
  if (!path) return undefined;
  const clean = stripRoot(path.trim(), root).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean === '.') return undefined;
  if (clean.startsWith('/') || clean.startsWith('~')) return compactDisplayPath(clean, root);
  const parts = clean.split('/').filter(Boolean);
  if (parts.length <= 1) return clean;
  const last = parts[parts.length - 1]!;
  if (/\.[a-z0-9]{1,10}$/i.test(last)) return last;
  return parts.slice(-2).join('/');
}

/** Split a shell headline on top-level `;`, `&&`, `||` (respecting single/double quotes and backslashes). */
function splitChainedCommands(headline: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let parenDepth = 0;
  for (let i = 0; i < headline.length; i += 1) {
    const ch = headline[i]!;
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < headline.length) {
      current += ch + headline[i + 1]!;
      i += 1;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') parenDepth += 1;
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1;
    if (parenDepth === 0) {
      const next = headline[i + 1];
      if (ch === ';') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Tokenize a single shell segment into words (quotes stripped, preserving content). */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasWord = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < segment.length && /["\\$`]/.test(segment[i + 1]!)) {
        current += segment[++i]!;
      } else if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      current += segment[++i]!;
      hasWord = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasWord) { words.push(current); current = ''; hasWord = false; }
      continue;
    }
    current += ch;
    hasWord = true;
  }
  if (hasWord) words.push(current);
  return words;
}

/** Strip output redirections (`> file`, `2>/dev/null`, `2>&1`, `&>log`) only outside quotes. */
function stripRedirections(segment: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      out += ch + segment[i + 1]!;
      i += 1;
      continue;
    }
    if (quote === '"') {
      out += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    const atTokenStart = i === 0 || /\s/.test(segment[i - 1]!);
    if (atTokenStart) {
      const rest = segment.slice(i);
      const op = /^(?:\d*>>?|&>>?)/.exec(rest);
      if (op) {
        let j = i + op[0].length;
        if (segment[j] === '&' && /\d/.test(segment[j + 1] ?? '')) {
          j += 1;
          while (j < segment.length && /\d/.test(segment[j]!)) j += 1;
        } else {
          while (j < segment.length && /[ \t]/.test(segment[j]!)) j += 1;
          let targetQuote: '"' | "'" | null = null;
          while (j < segment.length) {
            const c = segment[j]!;
            if (targetQuote === "'") { j += 1; if (c === "'") targetQuote = null; continue; }
            if (c === '\\' && j + 1 < segment.length) { j += 2; continue; }
            if (targetQuote === '"') { j += 1; if (c === '"') targetQuote = null; continue; }
            if (c === "'" || c === '"') { targetQuote = c; j += 1; continue; }
            if (/\s/.test(c)) break;
            j += 1;
          }
        }
        i = j - 1;
        continue;
      }
    }
    out += ch;
  }
  return out.trim();
}

/** Strip trailing formatting pipes (`| tail`, `| head`, `| cut`, `| wc`, `| sort`, `| jq`) and redirections. */
function cleanSegment(raw: string): string {
  // Cut at first top-level single pipe if the right-hand side is a formatter.
  let seg = raw.trim();
  const pipeIndex = findTopLevelPipe(seg);
  if (pipeIndex > 0) {
    const rhs = seg.slice(pipeIndex + 1).trim();
    const rhsProgram = rhs.split(/\s+/)[0]?.split('/').at(-1) ?? '';
    if (/^(?:head|tail|cut|wc|sort|uniq|tr|nl|column|cat|sed|awk|jq|tee|xargs|grep|rg)$/.test(rhsProgram)) {
      seg = seg.slice(0, pipeIndex).trim();
    }
  }
  // Drop output redirections like `> /tmp/foo.log 2>&1`, `2>/dev/null`, `1>&2` (quote-aware).
  seg = stripRedirections(seg);
  // Drop leading env assignments (`FOO=bar BAZ=1 cmd`).
  const words = shellWords(seg);
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!)) start += 1;
  if (start === 0) return seg.trim();
  // Rebuild from raw by skipping `start` leading env tokens cleanly.
  return seg.replace(new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\\S*)\\s+){1,${start}}`), '').trim();
}

function findTopLevelPipe(text: string): number {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (quote === '"') { if (ch === '"') quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    if (depth === 0 && ch === '|' && text[i + 1] !== '|' && text[i - 1] !== '|') return i;
  }
  return -1;
}

const SILENT_PROGRAMS = new Set(['cd', 'echo', 'printf', 'true', ':', 'pwd', 'export', 'set', 'unset']);
const INLINE_RUNTIMES = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'tsx', 'bun', 'deno']);
const GIT_ACTION_PRIORITY = new Set(['merge', 'rebase', 'commit', 'push', 'pull', 'cherry-pick', 'checkout', 'switch', 'reset', 'tag', 'stash']);

/** Pick the most informative segment from a chained command (`git fetch && git merge` -> `git merge`). */
function pickPrimarySegment(segments: string[]): { primary: string; index: number; fetchRef?: string } {
  let fetchRef: string | undefined;
  for (const seg of segments) {
    const words = shellWords(cleanSegment(seg));
    if (programOf(words[0]) === 'git') {
      const sub = gitSubcommand(words.slice(1));
      if (sub.name === 'fetch') {
        const ref = sub.operands.find(op => op.includes('refs/heads/') || (op !== '.' && !op.startsWith('-')));
        if (ref) fetchRef = ref.replace(/^refs\/heads\//, '');
      }
    }
  }
  // Prefer high-signal git mutations over leading guard checks (`git diff --quiet && git commit --amend`).
  for (let i = 0; i < segments.length; i += 1) {
    const words = shellWords(cleanSegment(segments[i]!));
    if (programOf(words[0]) === 'git') {
      const rest = words.slice(1);
      const sub = gitSubcommand(rest);
      if (sub.name === 'tag' && (rest.includes('--list') || rest.includes('-l') || sub.operands.length === 0)) continue;
      if (GIT_ACTION_PRIORITY.has(sub.name)) return { primary: segments[i]!, index: i, fetchRef };
    }
  }
  return { primary: segments[0]!, index: 0, fetchRef };
}

function programOf(word: string | undefined): string {
  if (!word) return '';
  return word.includes('/') ? word.split('/').at(-1)! : word;
}

const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
const GIT_NOISE_FLAGS = new Set([
  '--quiet', '-q', '--no-tags', '--no-edit', '--short', '-s', '--branch', '-b', '-uall', '--porcelain',
  '--reset-author', '--no-verify', '--no-pager', '--no-ext-diff', '--no-color', '--color=never',
]);

function gitSubcommand(args: string[]): { name: string; modifiers: string[]; operands: string[] } {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (GIT_GLOBAL_VALUE_FLAGS.has(arg)) { i += 2; continue; }
    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=') || arg.startsWith('-C') && arg.length > 2) { i += 1; continue; }
    if (arg.startsWith('-')) { i += 1; continue; }
    break;
  }
  const name = args[i] ?? '';
  const rest = args.slice(i + 1);
  const modifiers: string[] = [];
  const operands: string[] = [];
  let afterDoubleDash = false;
  for (let j = 0; j < rest.length; j += 1) {
    const arg = rest[j]!;
    if (!afterDoubleDash && arg === '--') { afterDoubleDash = true; continue; }
    if (!afterDoubleDash && arg.startsWith('-')) {
      if (GIT_NOISE_FLAGS.has(arg) || arg.startsWith('--format') || arg.startsWith('--pretty')) continue;
      if (arg === '-n' && rest[j + 1] && /^\d+$/.test(rest[j + 1]!)) { modifiers.push(`-${rest[++j]}`); continue; }
      if (/^-\d+$/.test(arg) && name === 'log') { modifiers.push(arg); continue; }
      if (arg === '--stat' || arg === '--amend' || arg === '--cached' || arg === '--staged' || arg === '--hard' || arg === '--soft' || arg === '--force' || arg === '-f') {
        modifiers.push(arg);
        continue;
      }
      if (arg === '-m' && rest[j + 1]) { operands.push(rest[++j]!); continue; }
      continue;
    }
    operands.push(arg);
  }
  return { name, modifiers, operands };
}

/** Extract files referenced inside an inline Python/Node script body. */
function extractScriptFiles(body: string, root?: string): string[] {
  const candidates: string[] = [];
  // Explicit file API calls (`Path('...')`, `open('...')`, `readFileSync('...')`, `tarfile.open('...')`, etc.)
  const apiPattern = /\b(?:Path|open|readFileSync|writeFileSync|readFile|writeFile|connect|glob|unlink|remove|stat)\s*\(\s*[rfbu]?(['"])([^'"\n]{2,180})\1/g;
  for (const match of body.matchAll(apiPattern)) {
    const candidate = match[2]!.trim();
    if (looksLikeFilePath(candidate)) candidates.push(candidate);
  }
  if (!candidates.length) {
    // Fallback: string literals that look like repo/tmp paths with an extension.
    const literalPattern = /(['"])((?:\/tmp\/|~\/|\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,12})\1/g;
    for (const match of body.matchAll(literalPattern)) {
      const candidate = match[2]!.trim();
      if (looksLikeFilePath(candidate)) candidates.push(candidate);
    }
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const clean = stripRoot(raw, root);
    if (!seen.has(clean)) { seen.add(clean); unique.push(clean); }
  }
  return unique;
}

function looksLikeFilePath(value: string): boolean {
  if (!value || value.length < 3 || value.startsWith('/dev/') || /^https?:\/\//.test(value)) return false;
  if (/^(?:utf-?8|ascii|latin-?1|r|w|rb|wb|a|ab)$/i.test(value)) return false;
  // Require either a path separator or a realistic filename extension (avoid `v1.0` or `foo.bar` method strings).
  if (value.includes('/')) return !/\s/.test(value);
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|swift|kt|kts|py|rb|go|rs|sh|zsh|bash|yml|yaml|toml|po|xcstrings|plist|xml|html|css|sql|sqlite|db|log|txt|tgz|gz|zip|tar|csv|env|lock)$/i.test(value);
}

/** First meaningful comment line in an inline script (`# ...` or `// ...`). */
function extractScriptComment(body: string): string | undefined {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines.slice(0, 2)) {
    if (line.startsWith('#!')) continue;
    const match = /^(?:#|\/\/)\s*(.+)$/.exec(line);
    if (match) {
      const note = cleanLabel(match[1]!);
      if (note.length >= 4 && note.length <= 72 && !/^coding[:=]/i.test(note)) return note;
    }
    break;
  }
  return undefined;
}

/** Find an unquoted heredoc marker (`<<'EOF'`, `<<-PY`) inside a single shell segment. */
function findUnquotedHeredoc(segment: string): { marker: string; raw: string } | undefined {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (quote === '"') { if (ch === '"') quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '<' && segment[i + 1] === '<' && segment[i + 2] !== '<') {
      const m = /^<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(segment.slice(i));
      if (m) return { marker: m[1]!, raw: m[0] };
    }
  }
  return undefined;
}

/** Extract inline script body from heredoc (`python3 - <<'PY'\n...`) or `-c`/`-e` flag. */
function parseInlineScript(
  program: string,
  chosenSegment: string,
  words: string[],
  fullCommand: string,
): { body: string; lines: number } | undefined {
  if (!INLINE_RUNTIMES.has(program)) return undefined;
  // Heredoc form: `python3 - <<'PY'\n<body>\nPY` (matched only outside quotes in the chosen segment)
  const heredoc = findUnquotedHeredoc(chosenSegment);
  if (heredoc) {
    const markerIdx = fullCommand.indexOf(heredoc.raw);
    const firstNl = fullCommand.indexOf('\n', markerIdx >= 0 ? markerIdx : 0);
    if (firstNl >= 0) {
      const rest = fullCommand.slice(firstNl + 1);
      const endMatch = new RegExp(`(?:^|\\r?\\n)[ \\t]*${heredoc.marker}(?:\\r?\\n|$)`).exec(rest);
      const body = (endMatch ? rest.slice(0, endMatch.index) : rest).trim();
      const lines = body ? body.split(/\r?\n/).length : 0;
      return { body, lines };
    }
    return { body: '', lines: 0 };
  }
  // `-c <code>` (python/sh) or `-e <code>` (node/ruby/perl), supporting multiline quoted arguments
  const flagIdx = words.findIndex((word, idx) => idx > 0 && (word === '-c' || word === '-e' || word === '--eval'));
  if (flagIdx > 0) {
    let rawBody = words[flagIdx + 1];
    if (fullCommand.includes('\n')) {
      for (const fullSeg of splitChainedCommands(fullCommand)) {
        const fullWords = shellWords(cleanSegment(fullSeg));
        if (programOf(fullWords[0]) !== program) continue;
        const fullFlagIdx = fullWords.findIndex((word, idx) => idx > 0 && (word === '-c' || word === '-e' || word === '--eval'));
        if (fullFlagIdx > 0 && fullWords[fullFlagIdx + 1] !== undefined) {
          rawBody = fullWords[fullFlagIdx + 1]!;
          break;
        }
      }
    }
    if (rawBody !== undefined) {
      const body = rawBody.trim();
      return { body, lines: body ? body.split(/\r?\n/).length : 0 };
    }
  }
  return undefined;
}

/** 5-tier presentation for inline `python3` / `node` scripts. */
function presentInlineScript(
  program: string,
  script: { body: string; lines: number },
  diffPaths: string[],
  extraCommands: number | undefined,
  root?: string,
): ToolRowPresentation {
  // Tier 1: observed file edits -> upgrade to Edit with affected files
  if (diffPaths.length > 0) {
    if (diffPaths.length === 1) {
      const p = compactDisplayPath(diffPaths[0]!, root);
      return {
        icon: 'edit', verb: 'Edit', prefix: program, primary: p, primaryKind: 'path',
        ...(extraCommands ? { extraCommands } : { mergeKey: `edit:${program}:${diffPaths[0]}` }),
      };
    }
    const labels = shortFileLabels(diffPaths);
    return {
      icon: 'edit', verb: 'Edit', prefix: program,
      primary: labels.slice(0, 2).join(', '),
      primaryKind: 'code',
      ...(diffPaths.length > 2 ? { extraFiles: diffPaths.length - 2 } : {}),
      ...(extraCommands ? { extraCommands } : {}),
    };
  }
  // Tier 2: meaningful leading comment
  const note = extractScriptComment(script.body);
  if (note) {
    return { icon: 'execute', verb: 'Run', prefix: program, primary: note, primaryKind: 'prose', ...(extraCommands ? { extraCommands } : {}) };
  }
  // Tier 3: static scan of files touched/read inside the script
  const files = extractScriptFiles(script.body, root);
  if (files.length === 1) {
    const p = compactDisplayPath(files[0]!, root);
    return {
      icon: 'execute', verb: 'Run', prefix: program, primary: p, primaryKind: 'path',
      ...(extraCommands ? { extraCommands } : { mergeKey: `script:${program}:${files[0]}` }),
    };
  }
  if (files.length > 1) {
    const labels = shortFileLabels(files);
    return {
      icon: 'execute', verb: 'Run', prefix: program,
      primary: formatTargetList(labels, 2),
      primaryKind: 'code',
      ...(extraCommands ? { extraCommands } : {}),
    };
  }
  // Tier 4: short one-liner expression
  if (script.lines <= 1 && script.body) {
    const expr = cleanLabel(script.body.replace(/^(?:import\s+[\w.,\s]+;\s*)+/, ''));
    if (expr && expr.length <= 32) {
      return { icon: 'execute', verb: 'Run', prefix: program, primary: expr, primaryKind: 'code', ...(extraCommands ? { extraCommands } : {}) };
    }
  }
  // Tier 5: fallback with line count (never verbose "inline script")
  return {
    icon: 'execute', verb: 'Run', primary: program, primaryKind: 'code',
    ...(script.lines > 1 ? { lineCount: script.lines } : {}),
    ...(extraCommands ? { extraCommands } : {}),
  };
}

/** Parse a `rg`/`grep`/`find`/`fd` shell segment into compact Search presentation. */
function presentSearchSegment(program: string, args: string[], extraCommands: number | undefined, root?: string): ToolRowPresentation | undefined {
  const shortVal = program === 'rg' ? 'efgtTABCmMjEr' : program === 'fd' ? 'etEdSocj' : 'efABCmdD';
  const patterns: string[] = [];
  const operands: string[] = [];
  let listFiles = false;
  if (program === 'find') {
    const start = args.findIndex(a => a.startsWith('-') || a === '!' || a === '(');
    const paths = start < 0 ? args : args.slice(0, start);
    const names = args.flatMap((a, idx) => /^-(?:i?name|i?path|i?regex)$/.test(a) && args[idx + 1] ? [args[idx + 1]!] : []);
    const scope = compactSearchScope(paths.find(p => p !== '.' && p !== './'), root);
    if (!names.length) return { icon: 'read', verb: 'List', primary: scope ?? '.', primaryKind: 'code', ...(extraCommands ? { extraCommands } : {}) };
    return { icon: 'search', verb: 'Search', primary: compactSearchQuery(names.join('|')), primaryKind: 'code', ...(scope ? { secondary: scope } : {}), ...(extraCommands ? { extraCommands } : {}) };
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--files') { listFiles = true; continue; }
    if (arg === '--') { operands.push(...args.slice(i + 1)); break; }
    if (arg === '-e' || arg === '--regexp') { if (args[i + 1]) patterns.push(args[++i]!); continue; }
    if (arg.startsWith('--regexp=')) { patterns.push(arg.slice('--regexp='.length)); continue; }
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && /^--(?:glob|iglob|type|type-not|include|exclude|max-count|max-depth|context|after-context|before-context|file|ignore-file)$/.test(arg)) i += 1;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const last = arg[arg.length - 1]!;
      if (shortVal.includes(last) && arg.length === 2) i += 1;
      continue;
    }
    operands.push(arg);
  }
  if (listFiles) {
    const scope = compactSearchScope(operands[0], root);
    return {
      icon: 'read', verb: 'List',
      primary: scope ?? '.',
      primaryKind: 'code',
      ...(extraCommands ? { extraCommands } : {}),
    };
  }
  const query = patterns.length ? patterns.join('|') : operands.shift();
  if (!query) return undefined;
  const scope = compactSearchScope(operands[0], root);
  return {
    icon: 'search', verb: 'Search', primary: compactSearchQuery(query), primaryKind: 'code',
    ...(scope ? { secondary: scope } : {}),
    ...(extraCommands ? { extraCommands } : {}),
  };
}

/** Present a `git` shell segment cleanly (`Git  merge main`, `Git  diff --stat apps/macos`). */
function presentGitSegment(args: string[], fetchRef: string | undefined, extraCommands: number | undefined, root?: string): ToolRowPresentation {
  const sub = gitSubcommand(args);
  if (!sub.name) return { icon: 'git', verb: 'Git', primary: 'git', primaryKind: 'code', ...(extraCommands ? { extraCommands } : {}) };
  const subLabel = [sub.name, ...sub.modifiers.slice(0, 1)].join(' ');
  const cleanedOps = sub.operands
    .map(op => (op === 'FETCH_HEAD' && fetchRef ? fetchRef : stripRoot(op, root)))
    .filter(op => op && op !== '.');
  let secondary: string | undefined;
  if (cleanedOps.length === 1) {
    const op = cleanedOps[0]!;
    secondary = op.includes('/') && !op.startsWith('refs/') ? compactDisplayPath(op, root) : op;
  } else if (cleanedOps.length > 1) {
    secondary = formatTargetList(shortFileLabels(cleanedOps), 2);
  }
  if (secondary && secondary.length > 44) secondary = `${secondary.slice(0, 42)}…`;
  return {
    icon: 'git', verb: 'Git', primary: subLabel, primaryKind: 'code',
    ...(secondary ? { secondary } : {}),
    ...(extraCommands ? { extraCommands } : { mergeKey: `git:${subLabel}:${secondary ?? ''}` }),
  };
}

const GH_API_VALUE_FLAGS = new Set(['-X', '--method', '-q', '--jq', '-H', '--header', '-f', '-F', '--raw-field', '--field', '--input', '--hostname', '--cache', '-t', '--template', '-p', '--preview']);

/** Present a `gh` (GitHub CLI) command cleanly and enable polling merges (`actions/runs/…/jobs`). */
function presentGhSegment(args: string[], extraCommands: number | undefined): ToolRowPresentation {
  const sub = args[0] ?? '';
  if (sub === 'api') {
    let endpoint = '';
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i]!;
      if (GH_API_VALUE_FLAGS.has(arg)) { i += 1; continue; }
      if (arg.startsWith('-')) continue;
      endpoint = arg;
      break;
    }
    const shortEndpoint = endpoint.replace(/^\/?repos\/[^/]+\/[^/]+\//, '');
    const generalized = shortEndpoint.replace(/\/\d+(?=\/|$)/g, '/…');
    return {
      icon: 'execute', verb: 'Run', primary: 'gh api', primaryKind: 'code',
      ...(shortEndpoint ? { secondary: shortEndpoint } : {}),
      ...(extraCommands ? { extraCommands } : {}),
      ...(!extraCommands && shortEndpoint ? { mergeKey: `gh-api:${generalized}` } : {}),
      ...(generalized !== shortEndpoint ? { mergedSecondary: generalized } : {}),
    };
  }
  const rest = args.slice(1).filter(a => !a.startsWith('-'));
  const subCmd = rest[0] ? `gh ${sub} ${rest[0]}` : sub ? `gh ${sub}` : 'gh';
  const arg = rest[1];
  return {
    icon: 'execute', verb: 'Run', primary: subCmd, primaryKind: 'code',
    ...(arg ? { secondary: arg } : {}),
    ...(extraCommands ? { extraCommands } : { mergeKey: `gh:${subCmd}:${arg ?? ''}` }),
  };
}

const RUNNER_TOOLS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'pnpx', 'cargo', 'go', 'swift', 'xcodebuild', 'gradle', 'gradlew', 'pytest', 'vitest', 'jest', 'make', 'docker', 'kubectl', 'uv', 'poetry', 'pip', 'pip3']);

function presentRunnerSegment(program: string, args: string[], extraCommands: number | undefined, root?: string): ToolRowPresentation {
  // Drop common noise flags with values (`--pack-destination <dir>`, `--cwd <dir>`, `-C <dir>`).
  const kept: string[] = [];
  let testFilter: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((arg === '--tests' || arg === '-k') && args[i + 1]) {
      testFilter = args[++i]!.replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^(?:-C|--cwd|--prefix|--pack-destination|--reporter|--config)$/.test(arg)) { i += 1; continue; }
    if (arg.startsWith('--')) continue;
    if (arg.startsWith('-') && arg.length <= 3) continue;
    kept.push(stripRoot(arg, root));
  }
  let primary = program;
  let secondary: string | undefined;
  let extraFiles: number | undefined;
  if (program === 'npx' || program === 'pnpx') {
    const tool = kept.shift();
    const sub = kept.shift();
    primary = [tool, sub].filter(Boolean).join(' ') || program;
    secondary = kept[0] ? compactDisplayPath(kept[0], root) : undefined;
    if (kept.length > 1) extraFiles = kept.length - 1;
  } else if (kept.length > 0) {
    // Keep up to 2 subcommand words (`pnpm aif context`, `pnpm build`, `vitest run`).
    const sub1 = kept[0]!;
    const sub2 = kept[1] && !kept[1].includes('/') && !kept[1].includes('.') && !kept[1].startsWith(':') && kept[1].length <= 16 ? kept[1] : undefined;
    primary = sub2 ? `${program} ${sub1} ${sub2}` : `${program} ${sub1}`;
    const restStart = sub2 ? 2 : 1;
    const rest = kept.slice(restStart);
    if (testFilter) {
      const shortClass = testFilter.includes('.') ? testFilter.split('.').at(-1)! : testFilter;
      secondary = shortClass;
      if (rest.length > 0) extraCommands = (extraCommands ?? 0) + rest.length;
    } else if (rest[0]) {
      secondary = rest[0].includes('/') ? compactDisplayPath(rest[0], root) : rest[0];
      if (rest.length > 1) extraFiles = rest.length - 1;
    }
  }
  if (secondary && secondary.length > 44) secondary = `${secondary.slice(0, 42)}…`;
  return {
    icon: 'execute', verb: 'Run', primary, primaryKind: 'code',
    ...(secondary ? { secondary } : {}),
    ...(extraFiles ? { extraFiles } : {}),
    ...(extraCommands ? { extraCommands } : {}),
    ...(!extraCommands && !extraFiles ? { mergeKey: `run:${primary}:${secondary ?? ''}` } : {}),
  };
}

/** Present a shell command deterministically without leaking noisy flags, pipes or heredocs. */
function presentShellCommand(
  rawCommand: string,
  diffPaths: string[],
  root?: string,
): ToolRowPresentation {
  const unwrapped = unwrapShell(rawCommand);
  const full = stripRoot(unwrapped, root).replace(ROOT_CD, '');
  const headline = commandHeadline(full);
  const rawSegments = splitChainedCommands(headline);
  const activeSegments = rawSegments.filter(seg => {
    const words = shellWords(cleanSegment(seg));
    return words.length > 0 && !SILENT_PROGRAMS.has(programOf(words[0]));
  });
  if (!activeSegments.length) {
    return { icon: 'execute', verb: 'Run', primary: headline.slice(0, 48), primaryKind: 'code' };
  }
  const extraCommands = activeSegments.length > 1 ? activeSegments.length - 1 : undefined;
  const { primary: chosen, fetchRef } = pickPrimarySegment(activeSegments);
  const cleaned = cleanSegment(chosen);
  const words = shellWords(cleaned);
  const program = programOf(words[0]);
  const args = words.slice(1);

  // 1. Inline scripts (`python3 - <<'PY'`, `python3 -c`, `node -e`)
  const script = parseInlineScript(program, chosen, words, full);
  if (script) return presentInlineScript(program, script, diffPaths, extraCommands, root);

  // 2. Git commands
  if (program === 'git') return presentGitSegment(args, fetchRef, extraCommands, root);

  // 3. GitHub CLI
  if (program === 'gh') return presentGhSegment(args, extraCommands);

  // 4. Search commands (`rg`, `grep`, `find`, `fd`)
  if (program === 'rg' || program === 'grep' || program === 'egrep' || program === 'fgrep' || program === 'find' || program === 'fd' || program === 'fdfind') {
    const searched = presentSearchSegment(program, args, extraCommands, root);
    if (searched) return searched;
  }

  // 5. File reading commands (`cat`, `head`, `tail`, `nl`, `less`, `sed -n`)
  if (program === 'cat' || program === 'head' || program === 'tail' || program === 'nl' || program === 'less' || (program === 'sed' && args.some(a => a === '-n' || /^-[a-z]*n/.test(a)))) {
    const files = args.filter(a => !a.startsWith('-') && a !== '-' && !/^\d+$/.test(a) && !(program === 'sed' && /^\d+(?:,\d+)?p;?$/.test(a)));
    if (files.length === 1) {
      return { icon: 'read', verb: 'Read', primary: compactDisplayPath(files[0]!, root), primaryKind: 'path', ...(extraCommands ? { extraCommands } : {}) };
    }
    if (files.length > 1) {
      return { icon: 'read', verb: 'Read', primary: formatTargetList(shortFileLabels(files), 2), primaryKind: 'code', ...(extraCommands ? { extraCommands } : {}) };
    }
  }

  // 6. Directory listings (`ls`, `tree`)
  if (program === 'ls' || program === 'tree') {
    const dirs = args.filter(a => !a.startsWith('-'));
    const scope = compactSearchScope(dirs[0], root);
    return { icon: 'read', verb: 'List', primary: scope ?? '.', primaryKind: 'code', ...(extraCommands ? { extraCommands } : {}) };
  }

  // 7. Package managers, test runners & build tools
  if (RUNNER_TOOLS.has(program)) return presentRunnerSegment(program, args, extraCommands, root);

  // 7b. SQLite CLI (`sqlite3 <db> "<sql>"`)
  if (program === 'sqlite3') {
    const positional = args.filter(a => !a.startsWith('-'));
    const db = positional[0];
    const sql = positional[1]?.trim();
    const shortSql = sql && sql.startsWith('.') && sql.length <= 20 ? sql : undefined;
    const target = db ? compactDisplayPath(db, root) : undefined;
    return {
      icon: 'execute', verb: 'Run',
      ...(target ? { prefix: 'sqlite3', primary: target, primaryKind: 'path' as const } : { primary: 'sqlite3', primaryKind: 'code' as const }),
      ...(shortSql ? { secondary: shortSql } : {}),
      ...(extraCommands ? { extraCommands } : {}),
      ...(!extraCommands && db ? { mergeKey: `sqlite3:${stripRoot(db, root)}:${shortSql ?? ''}` } : {}),
    };
  }

  // 8. Script file invocation (`python3 scripts/foo.py`, `node scripts/release.mjs`)
  if (INLINE_RUNTIMES.has(program) && args[0] && !args[0].startsWith('-')) {
    return {
      icon: 'execute', verb: 'Run', prefix: program, primary: compactDisplayPath(args[0], root), primaryKind: 'path',
      ...(args[1] && !args[1].startsWith('-') ? { secondary: args[1] } : {}),
      ...(extraCommands ? { extraCommands } : {}),
    };
  }

  // 9. General cleaned command fallback
  const compact = cleanLabel(cleaned);
  return {
    icon: 'execute', verb: 'Run',
    primary: compact.length > 56 ? `${compact.slice(0, 54)}…` : compact,
    primaryKind: 'code',
    ...(extraCommands ? { extraCommands } : {}),
  };
}

/** Extract line range like `L155–194` from tool input (`offset`/`limit`) or title (`lines 155-194`). */
function extractLineRange(
  title: string,
  input: Record<string, unknown> | undefined,
  locationLine: number | undefined,
): { range?: string; cleanedTitle: string } {
  const titleMatch = /\s+(?:lines?\s+|L)(\d+)(?:\s*[-–]\s*(\d+))?$/i.exec(title);
  if (titleMatch) {
    const start = titleMatch[1]!;
    const end = titleMatch[2];
    return { range: end ? `L${start}–${end}` : `L${start}`, cleanedTitle: title.slice(0, titleMatch.index).trim() };
  }
  const offset = typeof input?.offset === 'number' && input.offset > 0 ? Math.floor(input.offset) : undefined;
  const limit = typeof input?.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : undefined;
  if (offset !== undefined && limit !== undefined) {
    return { range: `L${offset}–${offset + limit - 1}`, cleanedTitle: title };
  }
  if (offset !== undefined) return { range: `L${offset}+`, cleanedTitle: title };
  if (typeof locationLine === 'number' && locationLine > 0) return { range: `L${locationLine}`, cleanedTitle: title };
  return { cleanedTitle: title };
}

/** Parse a URL into host (primary) + compact pathname (secondary). */
function presentUrl(rawUrl: string): { primary: string; secondary?: string } {
  try {
    const parsed = new URL(rawUrl);
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '');
    return {
      primary: parsed.host,
      ...(path && path !== '/' ? { secondary: path.length > 42 ? `${path.slice(0, 40)}…` : path } : {}),
    };
  } catch {
    return { primary: rawUrl.length > 48 ? `${rawUrl.slice(0, 46)}…` : rawUrl };
  }
}

/** Parse an MCP tool name (`mcp__plugin_riffet_tools__browser_snapshot` or `server · tool`). */
function parseMcpTool(
  rawName: string,
  input: Record<string, unknown> | undefined,
  allowDotHeuristic: boolean,
): ToolRowPresentation | undefined {
  let server: string | undefined;
  let tool: string | undefined;
  if (rawName.startsWith('mcp__')) {
    const parts = rawName.slice('mcp__'.length).split('__').filter(Boolean);
    if (parts.length >= 2) {
      server = parts[0]!.replace(/^plugin_/, '').replace(/_tools$/, '').replace(/_/g, '-');
      tool = parts.slice(1).join('_');
    }
  } else if (allowDotHeuristic && rawName.includes(' · ') && !/^(?:Read|Search|List|Edit|Write|Run)\b/.test(rawName)) {
    const [left, right] = rawName.split(' · ');
    if (left && right) { server = left.trim(); tool = right.trim(); }
  }
  if (!server || !tool) return undefined;
  // Remote linked-machine tools (`remote_exec` / `remote_list`): show target machine clearly apart from local Bash.
  if (/riffet/i.test(server) && tool === 'remote_exec') {
    const target = str(input?.server);
    const cmd = str(input?.command);
    const cwd = str(input?.cwd);
    const primary = cmd ? cleanLabel(cmd).slice(0, 56) : 'remote_exec';
    return {
      icon: 'execute',
      verb: 'Run',
      ...(target ? { prefix: target } : { prefix: 'remote' }),
      primary,
      primaryKind: 'code',
      ...(cwd ? { secondary: cwd.slice(0, 40) } : {}),
    };
  }
  if (/riffet/i.test(server) && tool === 'remote_list') {
    return { icon: 'mcp', verb: 'List', primary: 'remote servers', primaryKind: 'code', mergeKey: 'mcp:remote_list' };
  }
  // Normalize `riffet / browser_snapshot` -> `browser · snapshot` when tool carries its own domain prefix.
  let label = `${server} · ${tool}`;
  const underscore = tool.indexOf('_');
  if (underscore > 0 && /riffet/i.test(server)) {
    label = `${tool.slice(0, underscore)} · ${tool.slice(underscore + 1)}`;
  }
  const argVal = str(input?.url) ?? str(input?.path) ?? str(input?.query) ?? str(input?.selector) ?? str(input?.name) ?? str(input?.id);
  const secondary = argVal
    ? (/^https?:\/\//.test(argVal) ? argVal.replace(/^https?:\/\//, '').slice(0, 40) : argVal.slice(0, 40))
    : undefined;
  return { icon: 'mcp', verb: 'MCP', primary: label, primaryKind: 'code', ...(secondary ? { secondary } : {}), mergeKey: `mcp:${label}:${secondary ?? ''}` };
}

/**
 * Produce the unified 4-slot presentation for any tool call event across all backends.
 */
export function describeToolRow(
  data: Record<string, unknown>,
  fallbackTitle: string,
  root?: string,
): ToolRowPresentation {
  const rawInput = data.rawInput ?? data.input;
  const input = isRecord(rawInput) ? rawInput : undefined;
  const rawCommand = str(input?.command)
    ?? (Array.isArray(input?.command) ? (input.command as unknown[]).join(' ') : undefined)
    ?? str(data.command);
  const command = rawCommand ? stripRoot(unwrapShell(rawCommand), root).replace(ROOT_CD, '') : undefined;
  const contents = records(data.content);
  const diffPaths = [...new Set(contents.flatMap(item => item.type === 'diff' && str(item.path) ? [stripRoot(str(item.path)!, root)] : []))];
  const locations = records(data.locations).flatMap(loc => str(loc.path) ? [{ path: stripRoot(str(loc.path)!, root), line: typeof loc.line === 'number' ? loc.line : undefined }] : []);
  const kind = toolDataKind(data);
  const rawToolName = str(data.toolName) ?? str(data.name) ?? '';
  const rawTitle = cleanLabel(str(data.title) ?? rawToolName ?? fallbackTitle).replace(/^`([^`]*)`$/, '$1');
  const description = str(input?.description)?.trim();
  const actions = isRecord(input) ? records(input.commandActions) : [];

  // 1. Subagents keep their dedicated prose row (handled specially by RegularToolRow).
  if (kind === 'agent') {
    return { icon: 'agent', verb: 'Agent', primary: rawTitle || fallbackTitle, primaryKind: 'prose' };
  }

  // 2. MCP tools (before generic fallback; ` · ` heuristic is restricted to other/mcp without a command).
  const mcp = parseMcpTool(rawToolName || rawTitle, input, !command && (kind === 'other' || kind === 'mcp'));
  if (mcp) return mcp;

  // 3. Explicit prose description on a shell command (e.g. Claude Bash `description`).
  //    Pure read/search commands without a custom description fall through to structured display.
  if (command && description && !isCommandTitle(description, command) && kind === 'execute') {
    return { icon: 'execute', verb: 'Run', primary: description, primaryKind: 'prose' };
  }

  // 4. Structured Read (native Read tool or single-action read).
  if (kind === 'read' || /^Read\s+/i.test(rawTitle)) {
    const { range, cleanedTitle } = extractLineRange(rawTitle, input, locations[0]?.line);
    if (!cleanedTitle.includes(' · ')) {
      const explicitTarget = str(input?.file_path) ?? str(input?.path);
      if (!explicitTarget && locations.length > 1) {
        const uniqueLocs = [...new Set(locations.map(l => l.path))];
        const labels = shortFileLabels(uniqueLocs);
        return {
          icon: 'read', verb: 'Read',
          primary: labels.slice(0, 2).join(', '),
          primaryKind: 'code',
          ...(uniqueLocs.length > 2 ? { extraFiles: uniqueLocs.length - 2 } : {}),
        };
      }
      const targetRaw = explicitTarget ?? locations[0]?.path
        ?? cleanedTitle.replace(/^Read(?:\s+image)?\s+/i, '').trim();
      if (targetRaw && targetRaw !== 'file' && !targetRaw.includes(', ')) {
        const display = compactDisplayPath(targetRaw, root);
        return {
          icon: 'read', verb: 'Read', primary: display, primaryKind: 'path',
          ...(range ? { lineRange: range } : {}),
          mergeKey: `read:${stripRoot(targetRaw, root)}`,
        };
      }
      if (targetRaw) {
        return { icon: 'read', verb: 'Read', primary: targetRaw, primaryKind: 'code', ...(range ? { lineRange: range } : {}) };
      }
    }
  }

  // 5. Structured Edit / Write / Delete / Move.
  if (kind === 'edit' || kind === 'delete' || kind === 'move' || /^(?:Edit|Write|MultiEdit|NotebookEdit)\s+/i.test(rawTitle)) {
    const verb: ToolVerb = kind === 'delete' ? 'Delete'
      : kind === 'move' ? 'Move'
      : /^(?:Write)\b/i.test(rawToolName || rawTitle) ? 'Write'
      : 'Edit';
    const icon: ToolIconKind = kind === 'delete' ? 'delete' : kind === 'move' ? 'move' : 'edit';
    const paths = diffPaths.length ? diffPaths
      : locations.length ? locations.map(l => l.path)
      : [str(input?.file_path) ?? str(input?.path) ?? str(input?.target_file) ?? rawTitle.replace(/^(?:Edit|Write|MultiEdit|NotebookEdit)\s+/i, '').trim()].filter(Boolean);
    const uniquePaths = [...new Set(paths.map(p => stripRoot(p, root)))];
    if (uniquePaths.length === 1) {
      const target = uniquePaths[0]!;
      return {
        icon, verb, primary: compactDisplayPath(target, root), primaryKind: 'path',
        mergeKey: `${verb.toLowerCase()}:${target}`,
      };
    }
    if (uniquePaths.length > 1) {
      const labels = shortFileLabels(uniquePaths);
      return {
        icon, verb, primary: labels.slice(0, 2).join(', '), primaryKind: 'code',
        ...(uniquePaths.length > 2 ? { extraFiles: uniquePaths.length - 2 } : {}),
      };
    }
  }

  // 6. Web fetch & Web search (normalize Droid/DSH Chinese titles like `抓取 url`, `网页搜索 q`).
  if (kind === 'fetch' || /^WebFetch$/i.test(rawToolName) || /^抓取\s+/.test(rawTitle)) {
    const url = str(input?.url) ?? /^抓取\s+(\S+)/.exec(rawTitle)?.[1] ?? (/^https?:\/\//.test(rawTitle) ? rawTitle : undefined);
    if (url) {
      const { primary, secondary } = presentUrl(url);
      return { icon: 'fetch', verb: 'Fetch', primary, primaryKind: 'code', ...(secondary ? { secondary } : {}), mergeKey: `fetch:${primary}:${secondary ?? ''}` };
    }
    const query = str(input?.query) ?? rawTitle;
    return { icon: 'fetch', verb: 'Search', primary: compactSearchQuery(query), primaryKind: 'code', secondary: 'web' };
  }
  if (/^WebSearch$|^web_search$/i.test(rawToolName) || /^网页搜索\s*/.test(rawTitle)) {
    const query = str(input?.query) ?? rawTitle.replace(/^网页搜索\s*/, '').trim();
    return { icon: 'fetch', verb: 'Search', primary: compactSearchQuery(query || rawTitle), primaryKind: 'code', secondary: 'web' };
  }

  // 7. Shell command (when raw command is present and not already a pure single-read/edit above).
  if (command) {
    // If Codex/Claude reported pure read/search/list `commandActions` of a single kind, use them with our compact Search/List rules.
    const described = actions.length ? describeCommandActions(actions, root) : undefined;
    if (described && described.kind === 'search' && actions.every(a => a.type === 'listFiles')) {
      const targets = [...new Set(actions.map(a => str(a.path)).filter((p): p is string => Boolean(p)))];
      const primary = targets.length === 1 ? (compactSearchScope(targets[0], root) ?? '.') : targets.length > 1 ? formatTargetList(shortFileLabels(targets), 2) : '.';
      return { icon: 'read', verb: 'List', primary, primaryKind: 'code' };
    }
    if (described && described.kind === 'search' && actions.length === 1 && actions[0]?.type === 'search') {
      const query = str(actions[0].query);
      const scope = compactSearchScope(str(actions[0].path), root);
      if (query) {
        return { icon: 'search', verb: 'Search', primary: compactSearchQuery(query), primaryKind: 'code', ...(scope ? { secondary: scope } : {}) };
      }
    }
    return presentShellCommand(rawCommand!, diffPaths, root);
  }

  // 8. Native Search / Glob / Grep / List tools across Claude, Droid, DSH, Pi, Cursor.
  if (kind === 'search' || /^(?:Search|grep|glob|find|ls|List files)\b/i.test(rawTitle)) {
    if (/^(?:ls|List files)\b/i.test(rawTitle)) {
      const dir = str(input?.target_directory) ?? str(input?.path) ?? locations[0]?.path ?? rawTitle.replace(/^(?:ls|List files)\s*/i, '').trim();
      return { icon: 'read', verb: 'List', primary: compactSearchScope(dir, root) ?? '.', primaryKind: 'code' };
    }
    const rawTargetDir = str(input?.target_directory) ?? str(input?.path) ?? locations[0]?.path;
    const pattern = str(input?.pattern) ?? str(input?.glob_pattern) ?? str(input?.query);
    if (pattern) {
      const trimmedPattern = pattern.trim();
      if (/^\*(?:\/\*+)?$|^\*\*$/.test(trimmedPattern)) {
        return { icon: 'read', verb: 'List', primary: compactSearchScope(rawTargetDir, root) ?? '.', primaryKind: 'code' };
      }
      const scope = compactSearchScope(rawTargetDir, root);
      return { icon: 'search', verb: 'Search', primary: compactSearchQuery(pattern), primaryKind: 'code', ...(scope ? { secondary: scope } : {}) };
    }
    const stripped = rawTitle.replace(/^(?:Search|grep|glob|find)\s+/i, '').trim();
    const inMatch = /^(.+?)\s+in\s+(.+)$/.exec(stripped);
    if (inMatch) {
      const queryPart = inMatch[1]!.trim();
      if (/^\*(?:\/\*+)?$|^\*\*$/.test(queryPart)) {
        return { icon: 'read', verb: 'List', primary: compactSearchScope(inMatch[2], root) ?? '.', primaryKind: 'code' };
      }
      const scope = compactSearchScope(inMatch[2], root);
      return { icon: 'search', verb: 'Search', primary: compactSearchQuery(queryPart), primaryKind: 'code', ...(scope ? { secondary: scope } : {}) };
    }
    if (/^\*(?:\/\*+)?$|^\*\*$/.test(stripped)) {
      return { icon: 'read', verb: 'List', primary: compactSearchScope(rawTargetDir, root) ?? '.', primaryKind: 'code' };
    }
    const scope = compactSearchScope(rawTargetDir, root);
    return { icon: 'search', verb: 'Search', primary: compactSearchQuery(stripped || rawTitle), primaryKind: 'code', ...(scope ? { secondary: scope } : {}) };
  }

  // 9. Workflow / conversation tools (plan, question, message, switch_mode, image_generation).
  if (kind === 'plan') return { icon: 'plan', verb: 'Plan', primary: rawTitle || fallbackTitle, primaryKind: 'prose' };
  if (kind === 'question') return { icon: 'question', verb: 'Ask', primary: rawTitle || fallbackTitle, primaryKind: 'prose' };
  if (kind === 'message') return { icon: 'message', verb: 'Send', primary: rawTitle || fallbackTitle, primaryKind: 'prose' };
  if (kind === 'switch_mode') return { icon: 'switch_mode', verb: 'Mode', primary: rawTitle || fallbackTitle, primaryKind: 'prose' };
  if (kind === 'image_generation') return { icon: 'image', verb: 'Image', primary: rawTitle || fallbackTitle, primaryKind: 'prose' };

  // 10. Generic tool fallback.
  return {
    icon: (kind as ToolIconKind) || 'other',
    verb: 'Tool',
    primary: stripRoot(rawTitle, root) || fallbackTitle,
    primaryKind: 'code',
  };
}

/**
 * Unified 4-slot presentation for a background shell job or background task row.
 * Uses a natural-language title when distinct from the raw command, otherwise summarizes the command.
 */
export function describeJobRow(
  title: string | undefined,
  command: string | undefined,
  root?: string,
): ToolRowPresentation {
  const cleanTitle = title?.trim();
  const cleanCommand = command?.trim();
  if (cleanTitle && !isCommandTitle(stripRoot(cleanTitle, root), cleanCommand && stripRoot(cleanCommand, root))) {
    return { icon: 'execute', verb: 'Run', primary: cleanTitle, primaryKind: 'prose' };
  }
  if (cleanCommand) return presentShellCommand(cleanCommand, [], root);
  return { icon: 'execute', verb: 'Run', primary: cleanTitle || 'shell', primaryKind: 'code' };
}

/** One-line plain string for search-in-page (`findText`) or non-rich surfaces. */
export function formatToolPresentationText(p: ToolRowPresentation): string {
  return [p.verb, p.prefix, p.primary, p.secondary, p.lineRange].filter(Boolean).join(' ');
}
