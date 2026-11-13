/** One `@@` hunk of a unified diff, as the two sides a diff block shows. */
export type DiffHunk = { oldText: string; newText: string; lineOffset?: number; newLineOffset?: number };

// Each `@@` hunk becomes its own diff so it keeps its place in the file instead of being glued to
// the previous one at line 1. Its two sides start at their own lines: an earlier hunk that added
// or removed lines moves the new side away from the old.
export function splitUnifiedDiff(value: string): DiffHunk[] {
  const hunks: Array<{ oldLines: string[]; newLines: string[]; offset: number; newOffset: number }> = [];
  let hunk: (typeof hunks)[number] | undefined;
  // Lines the current header still promises; while any remain, a `---`/`+++` or blank line is body.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      oldLeft = header ? Number(header[2] ?? 1) : 0;
      newLeft = header ? Number(header[4] ?? 1) : 0;
      // An empty side (`-5,0`) inserts after line 5 rather than at it.
      const offset = header ? Math.max(0, Number(header[1]) - (oldLeft ? 1 : 0)) : 0;
      const newOffset = header ? Math.max(0, Number(header[3]) - (newLeft ? 1 : 0)) : 0;
      hunks.push(hunk = { oldLines: [], newLines: [], offset, newOffset });
      continue;
    }
    const inBody = oldLeft > 0 || newLeft > 0;
    if (line.startsWith('\\') || (!inBody && (line.startsWith('+++') || line.startsWith('---')))) continue;
    const marker = inBody && line === '' ? ' ' : line[0];
    if (marker !== '+' && marker !== '-' && marker !== ' ') continue;
    if (!hunk) hunks.push(hunk = { oldLines: [], newLines: [], offset: 0, newOffset: 0 });
    const text = line.slice(1);
    if (marker !== '+') { hunk.oldLines.push(text); oldLeft--; }
    if (marker !== '-') { hunk.newLines.push(text); newLeft--; }
  }
  if (!hunks.length) return [{ oldText: '', newText: '' }];
  return hunks.map(({ oldLines, newLines, offset, newOffset }) => ({
    oldText: oldLines.join('\n'), newText: newLines.join('\n'),
    ...(offset ? { lineOffset: offset } : {}), ...(newOffset !== offset ? { newLineOffset: newOffset } : {}),
  }));
}
