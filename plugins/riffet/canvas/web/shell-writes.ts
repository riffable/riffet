/*
 * The files a shell command wrote. Agents often edit through the shell — a Python heredoc that opens
 * a file for writing, `sed -i`, `cat > file`, `tee` — and such a call carries no diff, so without this
 * the write track misses the edit. Only the forms that name their target plainly are read; a write
 * the command does not spell out is not guessed at.
 */

/** File names worth calling a write: a name with one of these extensions, nothing else. */
const EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html', 'md', 'mdx', 'txt', 'svg', 'kt', 'kts', 'swift', 'py', 'rs', 'go', 'java', 'po', 'xcstrings', 'strings', 'plist', 'pbxproj', 'toml', 'yml', 'yaml', 'xml', 'gradle', 'sh']);
const PATH = /^[~\w@./+-]+$/;

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** Where the shell is: a directory, and whether it is known or only assumed (a shell that kept an earlier call's `cd`). */
export interface ShellDir { cwd: string; known: boolean }

function resolve(target: string, at: ShellDir, home: string | undefined): string | undefined {
  const path = target.replace(/^['"]|['"]$/g, '');
  const ext = path.slice(path.lastIndexOf('.') + 1);
  if (!PATH.test(path) || !path.slice(path.lastIndexOf('/') + 1).includes('.') || !EXTENSIONS.has(ext)) return undefined;
  if (path.startsWith('~')) return home ? normalize(home + path.slice(1)) : undefined;
  // A relative name in an assumed directory could be anywhere; better no write than one in the wrong place.
  if (!path.startsWith('/') && !at.known) return undefined;
  const full = normalize(path.startsWith('/') ? path : `${at.cwd}/${path}`);
  // Scratch files are not the project's.
  return /^\/(private\/)?tmp\/|^\/dev\//.test(full) ? undefined : full;
}

/** The command's simple commands, each with the directory earlier `cd`s left it in; heredoc bodies are not commands. */
function segments(command: string, start: ShellDir, home: string | undefined): { parts: Array<{ text: string; at: ShellDir }>; end: ShellDir } {
  const parts: Array<{ text: string; at: ShellDir }> = [];
  let at = start;
  const body = command.split(/<<-?\s*['"]?\w+['"]?/)[0] ?? command;
  for (const raw of body.split(/&&|\|\||;|\n/)) {
    const text = raw.trim().replace(/^\(+/, '').trim();
    if (!text) continue;
    const cd = /^cd\s+(\S+)/.exec(text);
    if (cd) {
      const to = cd[1]!.replace(/^['"]|['"]$/g, '');
      const absolute = to.startsWith('/') || (to.startsWith('~') && Boolean(home));
      at = { cwd: normalize(to.startsWith('~') && home ? home + to.slice(1) : to.startsWith('/') ? to : `${at.cwd}/${to}`), known: absolute || at.known };
      continue;
    }
    parts.push({ text, at });
  }
  return { parts, end: at };
}

/**
 * Absolute paths of the files [command], run [at] a directory, plainly wrote, and where the shell is
 * after it (a shell that keeps its directory between calls starts the next one there).
 */
export function shellWrites(command: string, at: ShellDir, home?: string): { files: string[]; end: ShellDir } {
  const files = new Set<string>();
  const add = (target: string | undefined, dir: ShellDir) => {
    const path = target && resolve(target, dir, home);
    if (path) files.add(path);
  };
  const { parts, end } = segments(command, at, home);
  // A script fed on stdin runs where the `cd`s before it left the shell.
  const scriptCwd = parts.find((part) => /^python3?\s+-/.test(part.text))?.at ?? end;
  if (/python3?\s+-\s*<</.test(command) && /open\([^)]*['"]w['"]|\.write\(|write_text\(/.test(command)) {
    for (const match of command.matchAll(/\b(?:p|path|f)\s*=\s*['"]([^'"]+\.\w+)['"]/g)) add(match[1], scriptCwd);
    for (const match of command.matchAll(/open\(\s*['"]([^'"]+)['"]\s*,\s*['"]w/g)) add(match[1], scriptCwd);
    for (const match of command.matchAll(/Path\(\s*['"]([^'"]+)['"]\s*\)\.write_text/g)) add(match[1], scriptCwd);
  }
  // `cat <<'EOF' > file`: the target follows the heredoc's marker, before its body.
  for (const match of command.matchAll(/<<-?\s*['"]?\w+['"]?\s*>>?\s*([^\s;&|]+)/g)) add(match[1], end);
  for (const { text, at: dir } of parts) {
    if (/^sed\s+(?:-\w+\s+)*-i/.test(text) || /^perl\s+-\w*i/.test(text)) {
      const tokens = text.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
      for (const token of tokens.slice(1)) if (!/^[-'"]/.test(token)) add(token, dir);
    }
    const redirect = /^(?:cat|printf|echo)\b[^|]*?>>?\s*([^\s;&|>]+)$/.exec(text);
    if (redirect) add(redirect[1], dir);
    const tee = /^tee\s+(?:-a\s+)?(\S+)/.exec(text);
    if (tee) add(tee[1], dir);
  }
  return { files: [...files], end };
}
