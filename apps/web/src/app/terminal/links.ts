import type { IDisposable, ILink, Terminal } from '@xterm/xterm';

/**
 * Matches relative or absolute source file paths with an optional `:line` or `:line:column` suffix,
 * e.g. `apps/server/src/app.ts:42:10`, `./src/index.tsx:18`, or `/Users/me/proj/main.swift:9`.
 * Deliberately requires a path separator and a file extension so plain tokens or versions are ignored.
 */
const FILE_LINK_RE = /(?:^|[\s(['"`])((?:\.{0,2}\/|~\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@-]+\.[A-Za-z0-9]{1,10})(?::(\d+)(?::(\d+))?)?(?=$|[\s)\]}'",;])/g;

export interface ParsedFileLink {
  rawPath: string;
  line?: number;
  column?: number;
  /** 1-based inclusive column range within the terminal row. */
  startX: number;
  endX: number;
}

export function findFileLinksInLine(lineText: string): ParsedFileLink[] {
  const results: ParsedFileLink[] = [];
  FILE_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_LINK_RE.exec(lineText)) !== null) {
    const rawPath = match[1]!;
    // Skip URLs already handled by WebLinksAddon (e.g. `https://example.com/a.html`).
    const fullMatch = match[0];
    const pathOffset = fullMatch.indexOf(rawPath);
    const startIndex = match.index + pathOffset;
    if (startIndex >= 3 && lineText.slice(Math.max(0, startIndex - 8), startIndex).includes('://')) continue;
    const lineNum = match[2] ? Number.parseInt(match[2], 10) : undefined;
    const colNum = match[3] ? Number.parseInt(match[3], 10) : undefined;
    const suffixLen = (match[2] ? match[2].length + 1 : 0) + (match[3] ? match[3].length + 1 : 0);
    const endIndex = startIndex + rawPath.length + suffixLen;
    results.push({
      rawPath,
      ...(lineNum && lineNum > 0 ? { line: lineNum } : {}),
      ...(colNum && colNum > 0 ? { column: colNum } : {}),
      startX: startIndex + 1,
      endX: endIndex,
    });
  }
  return results;
}

/** Normalizes a terminal path against the project root so `FilesPanel` receives a relative path when inside the project. */
export function normalizeProjectPath(rawPath: string, projectCwd?: string, terminalCwd?: string): string {
  let path = rawPath.trim();
  if (path.startsWith('./')) path = path.slice(2);
  if (projectCwd) {
    const root = projectCwd.endsWith('/') ? projectCwd : `${projectCwd}/`;
    if (path.startsWith(root)) return path.slice(root.length);
    if (!path.startsWith('/') && terminalCwd && terminalCwd.startsWith(root)) {
      const relCwd = terminalCwd.slice(root.length).replace(/\/+$/, '');
      if (relCwd && !path.startsWith(`${relCwd}/`)) return `${relCwd}/${path}`;
    }
  }
  return path;
}

/**
 * Registers an xterm link provider that makes file paths (`path:line:col`) clickable in terminal output.
 */
export function registerFilePathLinks(
  term: Terminal,
  onOpenFile: (path: string, line?: number) => void,
  getContext: () => { projectCwd?: string; terminalCwd?: string },
): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      if (!text.includes('/') || !text.includes('.')) { callback(undefined); return; }
      const matches = findFileLinksInLine(text);
      if (!matches.length) { callback(undefined); return; }
      const links: ILink[] = matches.map((item) => ({
        text: item.line ? `${item.rawPath}:${item.line}` : item.rawPath,
        range: {
          start: { x: item.startX, y: bufferLineNumber },
          end: { x: item.endX, y: bufferLineNumber },
        },
        activate(_event, _linkText) {
          const { projectCwd, terminalCwd } = getContext();
          onOpenFile(normalizeProjectPath(item.rawPath, projectCwd, terminalCwd), item.line);
        },
      }));
      callback(links);
    },
  });
}
