import type { TuiScreenMarkers } from './types.js';

/*
 * What Riffet reads off Claude Code's screen: the input box, the footer's agent list and tasks entry, and the
 * "Background" task list. Its dialogs and questions are read in `backends/claude/screen-dialog.ts`. Everything
 * else (turns, tools, permissions, questions while their hook is held) comes from hooks and the transcript.
 *
 * The TUI is no contract, so every reader is checked against real captures of each version it was verified on,
 * `backends/claude/fixtures/screens/<version>/` (`screen-fixtures.test.ts`). Walking a screen over several keys
 * runs only on a version up to `CLAUDE_CLI_VERSIONS.testedThrough`. To verify a new version:
 *
 *   node --import tsx scripts/probe-claude-e2e.ts [--source <id> | --profile <name>] --capture apps/server/src/backends/claude/fixtures/screens
 *
 * then make `screen-fixtures.test.ts` pass on the new captures and raise `testedThrough`.
 */

/**
 * Claude Code's legacy interrupt hint — kept for older CLIs. Since 2.1.302 Claude no longer draws this
 * hint and instead renders a live spinner above the composer (`✽ Noodling… (6m 22s · ↓ 21.2k tokens)`).
 * Bare words such as "thinking" or "working" also appear in replies and in the footer's cwd.
 */
export const CLAUDE_CODE_BUSY_PATTERN = /esc(?:ape)?\s+to\s+interrupt|ctrl\+c\s+to\s+interrupt/i;

/**
 * Live spinner line drawn directly above the composer (2.1.302 / 2.1.322+): a spinner glyph at column 0
 * followed by status text carrying an ellipsis (`✽ Noodling… (3s · ↓ 9 tokens)`, `✶ Recombobulating…`,
 * `✽ Compacting conversation… (0s)`). Finished turn summaries (`✻ Worked for 17s · done 11:25 PM`,
 * `✻ Waiting for 1 background agent to finish`) have no ellipsis and do not match.
 */
const CLAUDE_SPINNER_LINE_PATTERN = /^[·✢✳✶✻✽]\s+\S[^\n]*…(?:\s*\([^\n]*\))?\s*$/;

/** Tool execution status hanging directly above the composer (`  ⎿  Running… (10s)`, `Waiting…`, `Initializing…`). */
const CLAUDE_TOOL_BUSY_LINE_PATTERN = /^ {2}⎿\s+(?:Running|Waiting|Initializing)…/;

/** Explicit interruption line that ends a turn without a `✻ Worked for …` summary. */
const CLAUDE_INTERRUPTED_LINE_PATTERN = /^ {2}⎿\s+Interrupted\b/;

/** Trailing TUI chrome that may sit between an active spinner/answer and the composer's top rule. */
const CLAUDE_TIP_LINE_PATTERN = /^ {2}⎿\s+Tip:/;
const CLAUDE_TIP_CONTINUATION_PATTERN = /^ {5}\S/;
const CLAUDE_TMUX_NOTICE_PATTERN = /^ {2}tmux\s+/;
const CLAUDE_EFFORT_BADGE_PATTERN = /^\s+[◉●]\s+.*\/effort\s*$/;

/**
 * Whether the captured Claude Code screen shows active turn work: the legacy interrupt hint, a live
 * spinner or running tool line directly above the composer, or an open `⏺` block streaming without a
 * closing `✻ … for …` / `Interrupted` line.
 */
export function claudeScreenBusy(screen: string): boolean {
  if (CLAUDE_CODE_BUSY_PATTERN.test(screen)) return true;
  const lines = screen.split(/\r?\n/);
  const bounds = claudeComposerBounds(lines);
  if (!bounds) return false;
  let end = bounds.top - 1;
  while (end >= 0) {
    const line = lines[end]!;
    if (!line.trim() || CLAUDE_TMUX_NOTICE_PATTERN.test(line) || CLAUDE_EFFORT_BADGE_PATTERN.test(line) || CLAUDE_TIP_LINE_PATTERN.test(line)) {
      end -= 1;
      continue;
    }
    if (CLAUDE_TIP_CONTINUATION_PATTERN.test(line)) {
      let probe = end - 1;
      while (probe >= 0 && CLAUDE_TIP_CONTINUATION_PATTERN.test(lines[probe]!)) probe -= 1;
      if (probe >= 0 && CLAUDE_TIP_LINE_PATTERN.test(lines[probe]!)) {
        end = probe - 1;
        continue;
      }
    }
    break;
  }
  if (end < 0) return false;
  const last = lines[end]!;
  if (CLAUDE_SPINNER_LINE_PATTERN.test(last) || CLAUDE_TOOL_BUSY_LINE_PATTERN.test(last)) return true;
  if (CLAUDE_INTERRUPTED_LINE_PATTERN.test(last)) return false;
  for (let index = end; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (/^\S/.test(line)) return /^⏺(?: |$)/.test(line);
  }
  return false;
}

/**
 * The composer: a `❯` (or `>` on terminals without the powerline glyph) opening the input box.
 *
 * A bare prompt is not enough to recognise it by. Claude seeds an empty composer with a greyed
 * suggestion — `❯ Try "write a test for Timeline.tsx"` — which is indistinguishable from typed
 * text, so a prompt alone on its line only covers a composer that has already been used once.
 * The box's own top rule is the reliable marker: the first composer line always sits directly
 * under it, and a prompt character quoted inside transcript text never does.
 *
 * Being at the composer says nothing about whether a turn is running — Claude keeps the box
 * drawn and accepts typing while it works. What the CLI is doing is read from its transcript and
 * hooks, never from this.
 */
export const CLAUDE_CODE_READY_PATTERN = /(?:^|\n)[^\S\n]*(?:❯|>)[^\S\n]*$|(?:^|\n)[─━]{3,}[^\n]*\n[^\S\n]*(?:❯|>)/m;

/**
 * Screen-level markers only. Claude Code's turn state comes from its transcript and hooks
 * (`backends/claude/session-state.ts`); the screen shows whether the input box is drawn.
 */
export const claudeCodeScreenMarkers: TuiScreenMarkers = {
  readyPattern: CLAUDE_CODE_READY_PATTERN,
  busyPattern: CLAUDE_CODE_BUSY_PATTERN,
};

/** The bottom edge is always a plain rule. */
const COMPOSER_RULE_PATTERN = /^[^\S\n]*[─━]{3,}[^\S\n]*$/;

/**
 * The top edge may carry text drawn into the rule: fast mode's glyph (`──── ↯ ─`) and, since Claude
 * Code 2.1.252, the session name (`──── fix-transcript-runtime-state ─`). Both ends keep a run of
 * rule characters, so a line of prose that merely starts with dashes is not taken for it.
 */
const COMPOSER_TOP_PATTERN = /^[^\S\n]*(?:[─━]{3,}(?:[^\S\n]+\S[^\n]*?[^\S\n]+[─━]+)?|[─━]+[^\S\n]+↯[^\S\n]+[─━]+)[^\S\n]*$/;

/** Terminal columns a line occupies: East Asian wide and fullwidth characters take two. */
export function cellWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    const code = char.codePointAt(0)!;
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
  }
  return width;
}

/** A plain top edge must match the bottom exactly; one with a title is allowed a little slack for glyph widths. */
function sameWidth(top: string, width: number): boolean {
  const text = top.trim();
  return COMPOSER_RULE_PATTERN.test(top) ? text.length === width : Math.abs(cellWidth(text) - width) <= 2;
}

/** Only a complete, equally wide pair containing the input prompt is a composer. */
export function claudeComposerBounds(lines: string[]): { top: number; bottom: number } | undefined {
  let bottom = -1;
  for (const [index, line] of lines.entries()) if (COMPOSER_RULE_PATTERN.test(line)) bottom = index;
  if (bottom < 2) return undefined;
  const width = lines[bottom]!.trim().length;
  for (let top = bottom - 1; top >= 0; top -= 1) {
    if (!COMPOSER_TOP_PATTERN.test(lines[top]!) || !sameWidth(lines[top]!, width)) continue;
    // `!` is the prompt of the box's shell mode, which a message starting with `!` switches it into.
    if (bottom - top < 2 || !/^[^\S\n]*(?:❯|>|!)/.test(lines[top + 1]!)) return undefined;
    return { top, bottom };
  }
  return undefined;
}

/** The input box is drawn. Says nothing about whether a turn runs: Claude keeps it up and takes typing throughout. */
export function claudeComposerVisible(screen?: string): boolean {
  if (!screen) return false;
  // tmux captures the entire pane, including unused rows below a fresh composer.
  const last = screen.trimEnd().split(/\r?\n/).slice(-8).join('\n');
  return claudeComposerBounds(screen.split(/\r?\n/)) !== undefined || CLAUDE_CODE_READY_PATTERN.test(last);
}

/**
 * How much of a prompt is compared against the composer. Long enough that a match cannot be a
 * coincidence, short enough that a narrow pane's wrap still shows it.
 */
const COMPOSER_PROMPT_CHARS = 16;

/**
 * A paste the CLI has not submitted yet. A paste of three or more line breaks, or over 800 characters,
 * is collapsed into this placeholder — the text itself never reaches the composer, which is why the box
 * has to be read for it as well as for the prompt (`❯ [Pasted text #1 +3 lines]`, or `❯ [Pasted text #2]`
 * for a long single line, `[...Truncated text #3 +40 lines...]` for a very long one; the box clears the
 * moment the message is taken).
 */
export const CLAUDE_CODE_PASTE_PLACEHOLDER_PATTERN = /\[(?:Pasted text #\d+(?: \+\d+ lines?)?|\.\.\.Truncated text #\d+ \+\d+ lines?\.\.\.)\]/;

/**
 * The composer's own lines: everything between the rule above the input box and the rule below it.
 *
 * `CLAUDE_CODE_READY_PATTERN` gets away with reading a few trailing lines because all it asks is
 * whether the box is drawn. A submission check has to read the box itself: Claude echoes a prompt it
 * has taken back into the transcript with the same `❯` prefix, so the text alone cannot say whether
 * the message is still waiting in the composer or already running above it.
 */
export function claudeComposer(screen: string): string | undefined {
  const lines = screen.split(/\r?\n/);
  const bounds = claudeComposerBounds(lines);
  return bounds ? lines.slice(bounds.top + 1, bounds.bottom).join('\n') : undefined;
}

/**
 * Whether the composer still holds a prompt that was pasted into it.
 *
 * A prompt the CLI has taken — running, or queued behind the turn in flight — leaves the box empty,
 * so a box that still shows the paste is one that never submitted. Both renderings count: a short
 * single-line paste sits in the box verbatim, and a multi-line one sits there as the placeholder
 * above. Whitespace is ignored on both sides, because the TUI re-wraps a long paste to the pane
 * width. The greyed suggestion an untouched composer shows (`❯ Try "…"`) is neither, so it is not
 * mistaken for a message waiting to go out.
 */
export function claudeComposerHoldsPrompt(screen: string, text: string): boolean {
  const box = claudeComposer(screen);
  if (!box) return false;
  if (CLAUDE_CODE_PASTE_PLACEHOLDER_PATTERN.test(box)) return true;
  const flat = box.replace(/\s+/g, '');
  const prompt = text.replace(/\s+/g, '').slice(0, COMPOSER_PROMPT_CHARS);
  if (prompt.length > 0 && flat.includes(prompt)) return true;
  // The attachment paths a prompt ends with are drawn as `[Image #N]`, so its first characters may be a path the box no
  // longer shows. Then the text before the paths has to be there (an image-only prompt is only the placeholders).
  const lines = text.split(/\r?\n/);
  if (CLAUDE_CODE_IMAGE_PLACEHOLDER_PATTERN.test(box) && lines.some(line => ATTACHMENT_PATH_LINE.test(line))) {
    const own = lines.filter(line => !ATTACHMENT_PATH_LINE.test(line)).join('').replace(/\s+/g, '').slice(0, COMPOSER_PROMPT_CHARS);
    // An image-only prompt has nothing of its own to recognise; a box with an image in it may be anyone's.
    return own.length > 0 && flat.includes(own);
  }
  return false;
}

/** An attached image the CLI draws as `[Image #1]`, and the absolute-path line of the rendered prompt it stands for. */
const CLAUDE_CODE_IMAGE_PLACEHOLDER_PATTERN = /\[Image #\d+\]/;
const ATTACHMENT_PATH_LINE = /^\s*\/[^\s/]+\/\S+\s*$/;

/**
 * One row of the agent list Claude Code draws under its footer while background agents exist:
 * `⏺` marks the agent the composer talks to, `◯` the others, and a leading
 * `❯` the row the list's own cursor is on. Sub-agents of sub-agents hang off `├`/`└`.
 *
 *   ❯ ◯ main
 *     ⏺ general-purpose  Sleep 600 seconds        12s · ↓ 243 tokens
 */
const AGENT_ROW_PATTERN = /^(❯)?[^\S\n]*(?:[├└│][^\S\n]*)*([⏺●◯○])[^\S\n]+(\S+)/;

export interface ClaudeAgentRow { name: string; focused: boolean; selected: boolean }

/** The lines under the composer: the footer hints and, when there are background agents, their list. */
function belowComposer(screen: string): string[] | undefined {
  const lines = screen.split(/\r?\n/);
  const bounds = claudeComposerBounds(lines);
  return bounds ? lines.slice(bounds.bottom + 1) : undefined;
}

export function claudeAgentRows(screen: string): ClaudeAgentRow[] {
  const rows: ClaudeAgentRow[] = [];
  for (const line of belowComposer(screen) ?? []) {
    const match = AGENT_ROW_PATTERN.exec(line);
    if (match) rows.push({ name: match[3]!, focused: match[2] === '⏺' || match[2] === '●', selected: match[1] !== undefined });
  }
  return rows;
}

/**
 * The composer talks to a background agent: the reader opened its view. Whatever is typed there goes to
 * that agent (its transcript records "resumed by the user"), never into the main transcript. An empty
 * box also says so in its placeholder, `Message @general-purpose…`.
 */
export function claudeViewsSubagent(screen: string): boolean {
  if (/^[^\S\n]*(?:❯|>)[^\S\n]*Message @\S/.test(claudeComposer(screen) ?? '')) return true;
  // The list always starts with `main`; without it a lone `●` (the footer's effort badge) is no agent.
  const rows = claudeAgentRows(screen);
  const main = rows.find(row => row.name === 'main');
  return main !== undefined && !main.focused && rows.some(row => row.focused);
}

/**
 * The keyboard is on the footer, not the composer: its agent list (`↑/↓ to select`) or the background
 * tasks entry above it (`Enter to view tasks`). A paste still lands in the box, but the Enter that
 * should submit it is taken by the footer. 2.1.302 marks a focused tasks entry in reverse video only,
 * which a plain capture does not carry; that focus goes unseen here.
 */
export function claudeFooterFocused(screen: string): boolean {
  return (belowComposer(screen) ?? []).some(line => /↑\/↓ to select|Enter to view tasks/.test(line));
}

/**
 * What the input box holds with its prompt glyph, frame and whitespace taken out: `''` for an empty box (or one
 * showing the CLI's greyed suggestion, which reads the same as typed text), `undefined` when no box is drawn.
 */
export function claudeComposerText(screen: string | undefined): string | undefined {
  return screen === undefined ? undefined : claudeComposer(screen)?.replace(/[❯>│|\s]/g, '');
}

/** The footer's count of background work (`1 shell`, `2 monitors`): the entry that opens the "Background" list. */
const TASKS_ENTRY = /\d+\s+(?:shells?|monitors?|workflows?|tasks?)\b/;

/**
 * The keyboard is on the footer's tasks entry. 2.1.302 marks that focus in reverse video only (`ESC[7m` before
 * `1 shell`), so this reads a styled capture (`capture-pane -e`). While it has the keyboard a bracketed paste is
 * dropped and Enter opens the entry; Up gives the keyboard back to the box.
 */
export function claudeTasksEntryFocused(styled: string): boolean {
  const lines = styled.split(/\r?\n/);
  const bounds = claudeComposerBounds(lines.map(line => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')));
  return bounds !== undefined && lines.slice(bounds.bottom + 1).some(line => {
    let reverse = false;
    for (const token of line.split(/(\u001b\[[0-?]*[ -/]*[@-~])/)) {
      const sgr = /^\u001b\[([0-9;:]*)m$/.exec(token);
      if (sgr) {
        // tmux merges attributes into one sequence (`ESC[1;7m`); a colour's own numbers (`38;5;7`) are not attributes.
        const params = sgr[1]!.split(';');
        for (let index = 0; index < params.length; index += 1) {
          const param = params[index] || '0';
          if (param === '0') reverse = false;
          else if (param === '7') reverse = true;
          else if (param === '27') reverse = false;
          else if (['38', '48', '58'].includes(param)) index += params[index + 1] === '5' ? 2 : params[index + 1] === '2' ? 4 : 0;
        }
      } else if (reverse && TASKS_ENTRY.test(token)) return true;
    }
    return false;
  });
}

/**
 * The footer counts the shells and monitors running in the background (`⏵⏵ … · 1 shell`); that count is the entry
 * Down reaches first from the input box, and Enter opens the "Background" list from (its focus: `claudeTasksEntryFocused`).
 */
export function claudeTasksEntryShown(screen: string): boolean {
  return (belowComposer(screen) ?? []).some(line => new RegExp(`·\\s+${TASKS_ENTRY.source}`).test(line));
}

/**
 * The "Background" list or one task's details, drawn in place of the input box under a full-width rule:
 *
 *   Background                            Shell details
 *   2 active shells                       Status:   running
 *   ❯ ⏺ sleep 600   running               Command:  sleep 600
 *   ↑/↓ to select · Enter to view ·       ← to go back · Esc/Enter/Space to close · x to stop
 *     x to stop · Esc to close
 *
 * Only the lines under the last rule are read, and never while an input box is drawn: the footer's agent list
 * prints the same `↑/↓ to select`.
 */
export type ClaudeBackgroundScreen =
  | { kind: 'list'; active?: number; closable: boolean }
  | { kind: 'task'; closable: boolean }
  | { kind: 'empty'; closable: boolean };

/** The screen's last line offers Esc to close what is drawn (`Esc to close`, `Esc/Enter/Space to close`). */
export function claudeDialogClosable(screen: string | undefined): boolean {
  return /\bEsc(?:\/\w+)* to close\b/.test(screen?.trimEnd().split(/\r?\n/).at(-1) ?? '');
}

export function claudeBackgroundScreen(screen: string | undefined): ClaudeBackgroundScreen | undefined {
  if (screen === undefined) return undefined;
  const lines = screen.split(/\r?\n/);
  if (claudeComposerBounds(lines)) return undefined;
  let rule = lines.length - 1;
  while (rule >= 0 && !COMPOSER_RULE_PATTERN.test(lines[rule]!)) rule -= 1;
  if (rule < 0) return undefined;
  const panel = lines.slice(rule + 1).map(line => line.trim()).filter(Boolean);
  const footer = panel.at(-1) ?? '';
  const closable = claudeDialogClosable(screen);
  if (panel.some(line => /^No tasks currently running/.test(line))) return { kind: 'empty', closable };
  if (!/\bx to stop\b/.test(footer)) {
    // A task's page cut short by the pane: since 2.1.322 a monitor's output box pushes the hints below a short one. The
    // page is still known by its title and status, and keeps its keys (x stops it, Esc closes it).
    return /^\S+ details$/.test(panel[0] ?? '') && /^Status:\s+\S/.test(panel[1] ?? '') ? { kind: 'task', closable: true } : undefined;
  }
  if (/↑\/↓ to (?:select|navigate)/.test(footer) && panel[0] === 'Background') {
    const active = /^(\d+) (?:active|shells?|monitors?|workflows?|tasks?)\b/.exec(panel[1] ?? '')?.[1];
    return { kind: 'list', ...(active ? { active: Number(active) } : {}), closable };
  }
  return { kind: 'task', closable };
}
