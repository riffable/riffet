/**
 * Claude Code draws an answer as it streams but writes it to the transcript only once the block is complete, so the
 * answer in flight is read off the terminal. This file is the layout contract that reading rests on: every mark the
 * reader keys on is named in `CLAUDE_SCREEN_LAYOUT`, and every real screen it was checked against is a fixture
 * (`../fixtures/screens/<version>/live-*.txt`, `../screen-fixtures.test.ts`).
 *
 * The contract is the CLI's, not ours, and changes without notice. Everything here fails towards drawing nothing: a
 * screen that does not read as the contract says gives no turn, and a block that is not clearly prose is not text.
 * What a wrong read costs is a draft that the transcript replaces seconds later; what it must never cost is the
 * transcript itself, which is read from the JSONL alone.
 *
 * When a CLI update breaks it: capture the new screens (`scripts/probe-claude-e2e.ts --capture`, or a stream probe
 * that samples `capture-pane -S -<rows>` while an answer streams), add them under the new version, and change the
 * marks below until every version's fixtures read. The drift report (`drafts.ts`) is the sign in the field.
 */
import { claudeComposerBounds } from '../../../adapters/cli/claude-code.js';

export const CLAUDE_SCREEN_LAYOUT = {
  /** A message sent to the CLI, echoed at the left edge; its wrapped lines hang under it at `indent`. */
  prompt: /^❯ /,
  /** Every assistant block, text or tool, starts at the left edge with this bullet; an answer not begun yet is the bullet alone. */
  block: /^⏺(?: |$)/,
  /** A block's content, and a prompt's wrapped lines, sit this far in. */
  indent: '  ',
  /** A tool's output, or a hint under the spinner, hangs below its line. */
  result: /^ {2}⎿/,
  /** A tool's header: `Bash(ls)`, `Read(a.ts)`, `riffet - read_context (MCP)(…)`. */
  toolHeader: /^⏺ [A-Za-z][\w-]*(?: - [\w.-]+ \(MCP\))?\(/,
  /** Thinking and tool calls folded into one line: `Thought for 6s, listed 1 directory (ctrl+o to expand)`. */
  collapsed: /\(ctrl\+[or] to expand\)\s*$/,
  /**
   * Anything else at the left edge ends the block above it: the spinner (`✻ Frosting… (3s · ↓ 78 tokens)`), the
   * turn's end (`✻ Worked for 11s`), the banner, a warning.
   */
  edge: /^\S/,
} as const;

/** `other`: a folded group, a status line; never drafted, but it ends the text above it. */
export type ScreenBlockKind = 'text' | 'tool' | 'other';
export interface ScreenBlock { kind: ScreenBlockKind; lines: string[] }

/**
 * The turn at the bottom of the conversation. `prompt` is the echo it starts at, when that is still in the rows read;
 * without it the rows read are all one turn's (the echo scrolled out above them).
 */
export interface ScreenTurn { prompt?: string; blocks: ScreenBlock[] }

/** Runs of lines this long or shorter, repeated right after themselves, are the trace of a redraw (`dedupeSeams`). */
const SEAM_LINES = 8;

/**
 * The blocks after the last prompt echo, above the input box. Undefined when the input box is not drawn: a dialog, the
 * transcript view (ctrl+o) or a resize in progress shows something the contract does not describe.
 */
export function readScreenTurn(tail: string): ScreenTurn | undefined {
  const lines = tail.split('\n').map(line => line.trimEnd());
  const composer = claudeComposerBounds(lines);
  if (!composer) return undefined;
  const area = lines.slice(0, composer.top);
  // A full redraw (resize, `/clear`) repaints the conversation below what scrolled off: the last echo is the current one.
  const at = area.findLastIndex(line => CLAUDE_SCREEN_LAYOUT.prompt.test(line));
  let start = 0, prompt: string | undefined;
  if (at >= 0) {
    const echo = [area[at]!.replace(CLAUDE_SCREEN_LAYOUT.prompt, '')];
    start = at + 1;
    while (start < area.length && area[start]!.startsWith(CLAUDE_SCREEN_LAYOUT.indent)) echo.push(area[start++]!.trim());
    prompt = echo.join(' ');
  }
  const blocks: ScreenBlock[] = [];
  let open: ScreenBlock | undefined;
  for (const line of area.slice(start)) {
    if (!line) { open?.lines.push(''); continue; }
    if (CLAUDE_SCREEN_LAYOUT.block.test(line)) {
      const first = line.slice(2);
      const kind = CLAUDE_SCREEN_LAYOUT.toolHeader.test(line) || CLAUDE_SCREEN_LAYOUT.collapsed.test(line) ? 'tool' : 'text';
      blocks.push(open = { kind, lines: first ? [first] : [] });
      continue;
    }
    if (CLAUDE_SCREEN_LAYOUT.collapsed.test(line) || CLAUDE_SCREEN_LAYOUT.edge.test(line)) {
      blocks.push(open = { kind: 'other', lines: [line.trim()] });
      if (CLAUDE_SCREEN_LAYOUT.collapsed.test(line)) open = undefined;
      continue;
    }
    if (CLAUDE_SCREEN_LAYOUT.result.test(line)) {
      // Prose never hangs a result: a block that does is a tool's.
      if (open?.kind === 'text') open.kind = 'tool';
      if (!open) blocks.push(open = { kind: 'other', lines: [] });
      open.lines.push(line.trim());
      continue;
    }
    if (!open) blocks.push(open = { kind: 'other', lines: [] });
    open.lines.push(line.slice(CLAUDE_SCREEN_LAYOUT.indent.length));
  }
  for (const block of blocks) {
    while (block.lines.at(-1) === '') block.lines.pop();
    if (block.kind === 'text') block.lines = dedupeSeams(block.lines);
  }
  return { ...(prompt !== undefined ? { prompt } : {}), blocks };
}

/**
 * Drops a run of lines repeated right after itself. Ink repaints its live region by moving the cursor up over it; rows
 * that scrolled into the scrollback meanwhile cannot be reached and stay, so the repaint lands below a copy of them.
 * Real text that repeats two or more non-blank lines verbatim, back to back, loses the copy in the draft only.
 */
export function dedupeSeams(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    for (let size = Math.min(SEAM_LINES, Math.floor(out.length / 2)); size >= 2; size -= 1) {
      const tail = out.length - size;
      let same = true, filled = 0;
      for (let i = 0; i < size && same; i += 1) {
        same = out[tail + i] === out[tail - size + i];
        if (out[tail + i]!.trim()) filled += 1;
      }
      if (same && filled >= 2) { out.length = tail; break; }
    }
  }
  return out;
}
