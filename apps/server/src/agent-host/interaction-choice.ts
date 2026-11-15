import { createHash } from 'node:crypto';
import type { NativeInteraction, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import type { DialogScreen } from './interaction-screen.js';
import { claudeComposerBounds } from '../adapters/cli/claude-code.js';

type TerminalIdentity = Pick<TerminalInfo, 'id' | 'epoch'>;
type Choice = { label: string; selected: boolean };

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const stripAnsi = (value: string) => value
  .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\u001b[ -/]*[@-_]/g, '')
  .replace(/\r/g, '');

function linesOf(screen: string): string[] {
  return stripAnsi(screen).split('\n').map(line => line.replace(/[\t ]+$/g, ''));
}

/** Remove only terminal frame columns, preserving the indentation used by Ink's option rows. */
function contentLine(line: string): string {
  return line.replace(/^\s*[│┃]\s?/, '').replace(/[│┃]\s*$/, '');
}

function textLine(line: string): string {
  return contentLine(line).trim();
}

function horizontalRule(line: string): boolean {
  return /^\s*[─━]{3,}\s*$/.test(line) || /^\s*[┌╭][─━]{3,}[┐╮]\s*$/.test(line);
}

function roundedTop(line: string): boolean { return /^\s*╭[─━]+╮\s*$/.test(line); }
function roundedBottom(line: string): boolean { return /^\s*╰[─━]+╯\s*$/.test(line); }
function boxEdge(line: string): boolean { return /^\s*[┌╭└╰][─━]+[┐╮┘╯]\s*$/.test(line); }
function framedBodyLine(line: string): boolean { return /^\s*[│┃].*[│┃]\s*$/.test(line); }

function onlyBlankLines(lines: string[], from: number): boolean {
  return lines.slice(from).every(line => !textLine(line));
}

/**
 * Every CLI marks its focused row with a leading glyph, and they are not the same glyph: Cursor uses
 * `→`/`▶`, Claude Code `❯`, Codex `›`. Both the row reader and the identity builder have to know the
 * whole set — the identity is what `NativeInteractions` checks while it moves that focus, so a glyph
 * it fails to strip makes every move look like the dialog changed underneath the reader.
 */
const FOCUS_GLYPH_CLASS = '→|▶|❯|›';
const FOCUS_PREFIX = new RegExp(`^(?:${FOCUS_GLYPH_CLASS})\\s+`);
const FOCUS_ROW = new RegExp(`^(\\s*)(?:${FOCUS_GLYPH_CLASS})(\\s+)(\\S.*?)\\s*$`);

function identityLines(lines: string[]): string[] {
  return lines.map(line => textLine(line).replace(FOCUS_PREFIX, ''));
}

/**
 * Read an option row. `column` restricts the match to rows whose label starts in that exact
 * column, which is how a decision surface's own rows are told apart from the prose above them.
 *
 * A glyph the parser does not know reads as "no focus", and a dialog with no visible focus is
 * deliberately left to the terminal.
 */
function focusRow(raw: string, column?: number): { focused: boolean; label: string; column: number } | undefined {
  const line = contentLine(raw);
  const selected = FOCUS_ROW.exec(line);
  if (selected) {
    const at = selected[1]!.length + 1 + selected[2]!.length;
    return column === undefined || at === column ? { focused: true, label: selected[3]!, column: at } : undefined;
  }
  const plain = /^(\s{2,})(\S.*?)\s*$/.exec(line);
  if (!plain) return undefined;
  const at = plain[1]!.length;
  return column === undefined || at === column ? { focused: false, label: plain[2]!, column: at } : undefined;
}

/** Ink wraps an option too long for the pane onto the next line, starting in column one. */
function wrapContinuation(raw: string): boolean {
  const text = textLine(raw);
  if (!text || boxEdge(raw) || horizontalRule(raw) || /^←\/→/.test(text)) return false;
  return /^\S/.test(contentLine(raw));
}

/**
 * Lines indented to where a numbered row's label text starts (after `N. `) that continue its label: Claude Code
 * 2.1.302 wraps `2. Yes, and always allow access to` over `   /tmp/project from`. A description or a note sits
 * the same way, so the run counts only when the next row follows it at once; how many lines it takes, else 0.
 */
function alignedWrap(lines: string[], from: number, textColumn: number, column: number | undefined): number {
  let index = from;
  while (index < lines.length && textLine(lines[index]!) && !focusRow(lines[index]!, column)) {
    const line = contentLine(lines[index]!);
    if (line.length - line.trimStart().length !== textColumn) return 0;
    index += 1;
  }
  const next = index < lines.length ? focusRow(lines[index]!, column) : undefined;
  return index > from && next && /^\d+\.\s/.test(next.label) ? index - from : 0;
}

function dropDecisionHint(label: string): string {
  return label.replace(/\s+\((?:y|n|b|c|p|Tab|Shift\+Tab|enter|Esc|p or Esc|esc or n|esc or n or p)\)$/i, '').trim();
}

/**
 * The key hint a CLI prints under a blocking select, in the CLI's own wording. Unlike `selectHint`
 * this lets `Esc` lead, because the hint that *closes* a decision surface is not the one that
 * confirms it — Claude Code ends its read approval with `Esc to cancel · Tab to amend`. It is only
 * ever asked about a line already below a complete option list, never used to title a screen.
 */
const KEY_HINT_KEY = /^(?:esc|escape|enter|return|tab|shift\+tab|space|↑\/↓|←\/→)(?:\s|$)/i;
function keyHintLine(raw: string): boolean {
  const text = textLine(raw);
  if (!text || text.length > 120) return false;
  const clauses = text.split(/\s*[·|]\s*/).filter(Boolean);
  return clauses.length > 0 && clauses.every(clause => KEY_HINT_KEY.test(clause) && /^[\w+/↑↓←→ -]+$/u.test(clause));
}

const WIDE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** Rejoin a label Ink wrapped at the pane width; CJK text wraps without a separating space. */
export function joinWrapped(head: string, tail: string): string {
  return WIDE.test(head.at(-1) ?? '') || WIDE.test(tail[0] ?? '') ? head + tail : `${head} ${tail}`;
}

/**
 * Collect the consecutive option rows starting at `start`. `parse` both recognizes and normalizes
 * a row; anything it rejects before the first row is skipped, and after the first row ends the list.
 * With `wrap`, a line that begins in column one continues the previous row instead of ending the
 * list, which is how Ink renders an option too long for the pane.
 */
function choiceRows(
  lines: string[],
  start: number,
  parse: (label: string) => string | undefined,
  { wrap = false, column }: { wrap?: boolean; column?: number } = {},
): { rows: Choice[]; end: number } {
  const collected: Array<{ label: string; selected: boolean }> = [];
  let began = false;
  let end = start;
  let textColumn: number | undefined;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    const text = textLine(line);
    if (!text) {
      if (began) { end = index; break; }
      continue;
    }
    const row = focusRow(line, column);
    if (row && parse(row.label)) {
      began = true;
      collected.push({ label: row.label, selected: row.focused });
      const number = /^\d+\.\s+/.exec(row.label)?.[0];
      textColumn = number ? row.column + number.length : undefined;
      end = index + 1;
      continue;
    }
    if (wrap && began && !row && wrapContinuation(line)) {
      collected.at(-1)!.label = joinWrapped(collected.at(-1)!.label, text);
      end = index + 1;
      continue;
    }
    const aligned = wrap && began && !row && textColumn !== undefined ? alignedWrap(lines, index, textColumn, column) : 0;
    if (aligned) {
      for (const continued of lines.slice(index, index + aligned)) collected.at(-1)!.label = joinWrapped(collected.at(-1)!.label, textLine(continued));
      index += aligned - 1;
      end = index + 1;
      continue;
    }
    if (began) { end = index; break; }
  }
  const rows: Choice[] = [];
  for (const row of collected) {
    const label = parse(row.label);
    if (!label) return { rows: [], end };
    rows.push({ label, selected: row.selected });
  }
  return { rows, end };
}

/**
 * A permission surface's plain answers, by the words every CLI draws for them: `Yes` approves once,
 * `No` (Claude Code adds `, and tell Claude what to do differently`) refuses. Clients offer these two
 * as quick actions, as they do a protocol request's `allow` and `deny`; a row that grants more (`Yes,
 * and always allow …`) or reads otherwise keeps no tone and is chosen in the full reader.
 */
function permissionTone(label: string): { tone: 'primary' | 'danger'; shortLabel?: string } | undefined {
  const text = label.replace(/^\d+\.\s+/, '').trim();
  if (/^yes$/i.test(text)) return { tone: 'primary' };
  if (/^no$/i.test(text)) return { tone: 'danger' };
  if (/^no,\s/i.test(text)) return { tone: 'danger', shortLabel: 'No' };
  return undefined;
}

/** A preview's dashed rules (`╌╌╌` around a command) frame the terminal's width, not content. */
const DASHED_RULE = /^[╌╍┄┅┈┉]{3,}$/;

function finish(
  terminal: TerminalIdentity,
  screen: string,
  kind: NativeInteraction['kind'],
  title: string,
  message: string,
  choices: Choice[],
  identityContext: string[],
): DialogScreen | undefined {
  if (!choices.length || choices.length > 20) return;
  const focus = choices.findIndex(choice => choice.selected);
  if (focus < 0 || choices.filter(choice => choice.selected).length !== 1) return;
  const options = choices.map((choice, index) => ({ id: `option-${index}`, label: choice.label, selected: choice.selected }));
  const identity = digest([terminal.id, terminal.epoch, kind, title, message, identityLines(identityContext), options.map(({ id, label }) => [id, label])]);
  const interaction: NativeInteraction = {
    id: identity,
    // The revision covers the question the reader is answering — the dialog's own lines — not the
    // whole pane. Digesting the pane invalidated the card whenever anything else on screen repainted
    // (a spinner, another region's status line), which is not a change to the question.
    revision: digest([identity, identityLines(identityContext).join('\n')]),
    terminalId: terminal.id,
    epoch: terminal.epoch,
    kind,
    title,
    ...(message ? { message } : {}),
    options,
    actions: options.map(option => ({ id: `option:${option.id}`, label: option.label, ...(kind === 'permission' ? permissionTone(option.label) : {}) })),
  };
  return { interaction, focus, rows: options.map(option => ({ ...option, other: false })) };
}

/**
 * Lift a live decision surface by its shape rather than by its wording. The CLI draws every one
 * of them the same way: a preview block closed by a horizontal rule, a question line, optional
 * detail lines, then a column-aligned option list carrying exactly one focus glyph and nothing
 * below it. Matching that shape means a renamed prompt, a new permission kind, or a file type
 * that previews no diff still reaches the web UI instead of silently stranding the user in the
 * terminal — which a list of known titles and known option labels could never do.
 *
 * Over-matching is bounded by how answers are delivered: `NativeInteractions` moves the CLI's
 * own focus one key at a time and re-reads the screen, so a row the user pressed is the row that
 * gets chosen even if this parser missed a sibling row entirely.
 */
function parseDecisionSurface(screen: string, terminal: TerminalIdentity, lines: string[]): DialogScreen | undefined {
  const boundary = lines.findLastIndex(horizontalRule);
  if (boundary < 0) return;

  // A live surface marks exactly one row as focused. Transcript text that merely quotes a prompt
  // carries no glyph, and two glyphs mean two frames are overlapping mid-repaint.
  const focused: number[] = [];
  for (let index = boundary + 1; index < lines.length; index++) {
    if (focusRow(lines[index]!)?.focused) focused.push(index);
  }
  if (focused.length !== 1) return;
  const arrow = focused[0]!;
  const column = focusRow(lines[arrow]!)!.column;

  let start = arrow;
  while (start - 1 > boundary && (focusRow(lines[start - 1]!, column) || wrapContinuation(lines[start - 1]!))) start--;
  while (start < arrow && !focusRow(lines[start]!, column)) start++;

  const parsed = choiceRows(lines, start, dropDecisionHint, { wrap: true, column });
  if (parsed.rows.length < 2 || parsed.rows.some(row => row.label.length > 200)) return;
  if (parsed.rows.filter(row => row.selected).length !== 1) return;
  // A boxed AskQuestion frame that lost its bottom edge reaches this shape parser too. Its rows are
  // checkboxes, not a permission surface, and answering a clipped question is worse than the
  // terminal: `parseDialog` rejects the frame, and this parser stays out of it.
  if (parsed.rows.some(row => /^\[[ xX]\]\s*\S/.test(row.label))) return;
  // The option list is the bottom of the screen. A box edge may close it, and the CLI's own key
  // hint may follow it. Anything else means this is not the foreground surface.
  if (lines.slice(parsed.end).some(line => textLine(line) && !keyHintLine(line) && !boxEdge(line))) return;

  // The question and its detail lines form the unbroken run directly above the options.
  let runStart = start;
  while (runStart - 1 > boundary && textLine(lines[runStart - 1]!) && !horizontalRule(lines[runStart - 1]!)) runStart--;
  const run = lines.slice(runStart, start).map(textLine).filter(Boolean);
  const titleIndex = run.findLastIndex(line => line.endsWith('?'));
  if (titleIndex < 0 || run[titleIndex]!.length > 200) return;

  // Whatever precedes the question is the preview of the operation being approved. Binary writes
  // preview only a path, and the CLI puts that above the rule, so pick it up from there too.
  const preview = [...lines.slice(boundary + 1, runStart).map(textLine).filter(Boolean), ...run.slice(0, titleIndex)].filter(line => !DASHED_RULE.test(line));
  const abovePreview = boundary > 0 && !horizontalRule(lines[boundary - 1]!) ? textLine(lines[boundary - 1]!) : '';
  if (abovePreview) preview.unshift(abovePreview);
  if (!preview.length) return;

  const message = [...preview, ...run.slice(titleIndex + 1)].join('\n');
  const identityContext = lines.slice(boundary, parsed.end).map(textLine);
  const kind: NativeInteraction['kind'] = PLAN_TITLES.test(run[titleIndex]!) ? 'plan' : 'permission';
  return finish(terminal, screen, kind, run[titleIndex]!, message, parsed.rows, identityContext);
}

/**
 * Titles of the borderless startup dialogs the workbench has seen. Alongside the exact command
 * permission title, these bound which hint-closed surfaces can become actionable cards.
 */
const COMMAND_PERMISSION_TITLE = /^Would you like to run the following command\?$/;
const HINTED_TITLES = /^(?:Accessing workspace:|Managed settings require approval|Trust gateway|Hooks need review|Implement this plan\.?|Choose what happens to the current task\.?|Review hooks$|Ready to code\?|Claude wants to exit plan mode|Exit plan mode\?|Review plan$|Teach auto mode about your environment\?$|Update available\b)/;

/**
 * The surfaces that ask the reader to approve a plan and leave plan mode. Claude Code titles the
 * same consent by version — `Claude wants to exit plan mode` in 2.1.x, `Ready to code?` under its
 * newer rows — and its cloud hand-off reuses `Implement this plan.`. Reading them as `plan` is what
 * turns the generic option list into an approval the reader recognizes; the CLI's own option labels
 * (`Yes, auto-accept edits`, `No, keep planning`) stay exactly as printed, because they are what the
 * keys below them select.
 */
const PLAN_TITLES = /^(?:Ready to code\?|Claude wants to exit plan mode|Exit plan mode\?|Implement this plan\.?|Review plan$)/;

/** The key hint a CLI prints under a blocking select, in the CLI's own wording. */
function selectHint(line: string): boolean {
  const text = textLine(line);
  // The AskQuestion box prints its own navigation hint and also says "Enter"; that dialog belongs to
  // the box parser, so a clipped frame of one has to stay in the terminal.
  if (/\b(?:space select|question)\b/i.test(text)) return false;
  // `tab`/`shift+tab` lead Claude Code's plan consent ("shift+tab to approve with this feedback"),
  // which is the one key hint that names its action instead of a generic confirm. The arrow
  // alternatives end on a glyph, so the key has to be followed by whitespace rather than `\b`.
  return /^(?:enter|return|↑\/↓|←\/→|tab|shift\+tab)(?:\s|$).*(?:confirm|select|submit|skip|cancel|approve|continue)/i.test(text);
}

/**
 * Lift a blocking select that closes the screen with its own key hint: Claude Code's workspace-trust
 * and settings dialogs, Codex's numbered startup screens. None of them draws a border or the rule
 * `parseDecisionSurface` needs, so shape alone cannot find them; the hint line plus exactly one focus
 * glyph is what makes them safe to lift. Everything below the hint stays untouched, which is what
 * keeps transcript text that merely quotes option labels from being mistaken for a live dialog.
 */
function parseHintedSelect(screen: string, terminal: TerminalIdentity, lines: string[]): DialogScreen | undefined {
  // Claude keeps its input box below the auto-mode invitation, even while the menu owns the keys.
  // Read only that ruled panel: the composer and earlier turns can carry their own focus glyphs.
  // Other transcript content above a composer is not a live dialog just because it quotes key hints.
  const composer = claudeComposerBounds(lines);
  if (composer) {
    const above = lines.slice(0, composer.top);
    const boundary = above.findLastIndex(horizontalRule);
    const panel = above.slice(boundary + 1);
    if (boundary >= 0 && panel.find(line => textLine(line))?.trim() === 'Teach auto mode about your environment?') lines = panel;
  }
  let hint = lines.length - 1;
  while (hint >= 0 && !textLine(lines[hint]!)) hint--;
  if (hint < 0 || !selectHint(lines[hint]!) || !onlyBlankLines(lines, hint + 1)) return;

  const focused: number[] = [];
  for (let index = 0; index < hint; index++) {
    if (focusRow(lines[index]!)?.focused) focused.push(index);
  }
  if (focused.length !== 1) return;
  const arrow = focused[0]!;
  const column = focusRow(lines[arrow]!)!.column;

  // Numbered rows must form a complete 1..N sequence. A continuation can be crossed upwards only
  // when it leads to the immediately preceding numbered row in the same column. This gives every
  // focus position the same block without absorbing same-column command prose above option 1.
  const numbered = /^\d+\.\s/.test(focusRow(lines[arrow]!)!.label);
  let start = arrow;
  if (numbered) {
    let expected = Number(/^\d+/.exec(focusRow(lines[arrow]!)!.label)![0]);
    if (expected < 1 || expected > 20) return;
    while (expected > 1) {
      let previous = start - 1;
      while (previous >= 0 && !focusRow(lines[previous]!, column) && wrapContinuation(lines[previous]!)) previous--;
      const row = previous >= 0 ? focusRow(lines[previous]!, column) : undefined;
      if (!row || !/^\d+\.\s/.test(row.label) || Number(/^\d+/.exec(row.label)![0]) !== expected - 1) return;
      start = previous;
      expected--;
    }
  } else {
    while (start > 0 && focusRow(lines[start - 1]!, column)) start--;
  }
  const parsed = choiceRows(lines.slice(0, hint), start, label => {
    if (selectHint(label) || (numbered && !/^\d+\.\s/.test(label))) return undefined;
    return label;
  }, { wrap: true, column });
  if (numbered && parsed.rows.some((row, index) => Number(/^\d+/.exec(row.label)![0]) !== index + 1)) return;
  if (parsed.rows.length < 2 || parsed.rows.length > 20) return;
  if (parsed.rows.some(row => row.label.length > 200)) return;
  if (parsed.rows.filter(row => row.selected).length !== 1) return;
  // The block has to run into the hint, or this is a fragment of something larger.
  if (lines.slice(parsed.end, hint).some(line => textLine(line))) return;

  let titleIndex = -1;
  for (let index = start - 1; index >= 0; index--) {
    const raw = lines[index]!;
    const text = textLine(raw);
    if (COMMAND_PERMISSION_TITLE.test(text) || HINTED_TITLES.test(text)) { titleIndex = index; break; }
    // Only the currently visible candidate may supply its title. Completed dialogs, separators,
    // new input turns and unknown standalone questions are not command/plan context to walk across.
    // Quoted command questions and labelled Thread/Reason details remain ordinary body text; a bare
    // question in prose is ambiguous, so leave that layout to the terminal rather than borrow a title.
    if (selectHint(raw) || horizontalRule(raw) || boxEdge(raw)
      || /^(?:esc|escape)\s+(?:to\s+)?(?:cancel|skip|go back)\b/i.test(text)
      || /^(?:>\s*|(?:user|assistant)\s*:)/i.test(text)
      || (text.endsWith('?') && !/^(?:\$\s|[\w -]+:\s)/.test(text))) break;
  }
  // A known title is the liveness signal this shape has: the wording alone ("a hint line and one
  // focus glyph") is also what a transcript that *quotes* a dialog looks like, and answering that
  // would drive keys into a CLI showing no dialog at all. Unknown titles therefore stay in the
  // terminal; when a CLI renames one of these screens, its new title belongs in the list above.
  if (titleIndex < 0) return;
  const title = textLine(lines[titleIndex]!);
  if (title.length > 200) return;
  const commandPermission = COMMAND_PERMISSION_TITLE.test(title);
  // This exact TRAE surface has four numbered choices. A clipped three-row repaint must not turn
  // into an actionable subset (in particular, one without its reject choice).
  if (commandPermission && (!numbered || parsed.rows.length !== 4)) return;
  const message = lines.slice(titleIndex + 1, start).map(textLine).filter(Boolean).join('\n');
  const kind: NativeInteraction['kind'] = commandPermission ? 'permission' : PLAN_TITLES.test(title) ? 'plan' : 'confirmation';
  return finish(terminal, screen, kind, title, message, parsed.rows, lines.slice(titleIndex, hint + 1).map(textLine));
}

function boxFor(lines: string[], titleIndex: number): { start: number; end: number } | undefined {
  const start = lines.findLastIndex((line, index) => index < titleIndex && /^\s*[┌╭][─━]+[┐╮]\s*$/.test(line));
  if (start < 0) return;
  const end = lines.findIndex((line, index) => index > titleIndex && /^\s*[└╰][─━]+[┘╯]\s*$/.test(line));
  if (end < 0) return;
  if (!lines.slice(start + 1, end).every(framedBodyLine)) return;
  return { start, end };
}

function parsePlan(screen: string, terminal: TerminalIdentity, lines: string[]): DialogScreen | undefined {
  for (let titleIndex = lines.length - 1; titleIndex >= 0; titleIndex--) {
    if (textLine(lines[titleIndex]!) !== 'Suggested Plan') continue;
    const box = boxFor(lines, titleIndex);
    if (!box) continue;
    const questionIndex = lines.findIndex((line, index) => index > titleIndex && index < box.end && textLine(line) === 'Ready to build?');
    if (questionIndex < 0) continue;
    const planLines = lines.slice(titleIndex + 1, questionIndex).map(textLine).filter(Boolean);
    if (!planLines.length || planLines.some(line => /(?:plan truncated|output truncated|content clipped|…\s*\(truncated\))/i.test(line))) continue;
    const parsed = choiceRows(lines, questionIndex + 1, label => {
      const match = /^(\d+)\.\s+(Yes, build locally|Yes, build in cloud|No, propose changes)(?:\s+\((?:b|c|p or Esc)\))?$/.exec(label.trim());
      return match ? `${match[1]}. ${match[2]}` : undefined;
    });
    const labels = parsed.rows.map(row => row.label);
    const isLocalOrReject = labels.length === 2 && labels[0] === '1. Yes, build locally' && labels[1] === '2. No, propose changes';
    const isLocalCloudReject = labels.length === 3 && labels[0] === '1. Yes, build locally' && labels[1] === '2. Yes, build in cloud' && labels[2] === '3. No, propose changes';
    if (!isLocalOrReject && !isLocalCloudReject) continue;
    if (parsed.rows.filter(row => row.selected).length !== 1) continue;
    if (!onlyBlankLines(lines, box.end + 1)) continue;
    const context = [...planLines, textLine(lines[questionIndex]!)];
    return finish(terminal, screen, 'plan', 'Suggested Plan', context.join('\n'), parsed.rows, lines.slice(box.start, parsed.end).map(textLine));
  }
}

function parseModal(screen: string, terminal: TerminalIdentity, lines: string[]): DialogScreen | undefined {
  for (let titleIndex = lines.length - 1; titleIndex >= 0; titleIndex--) {
    const rawTitle = textLine(lines[titleIndex]!);
    const title = rawTitle.replace(/^(?:⚠️?\s*)/, '');
    if (title !== 'Workspace Trust Required' && title !== 'MCP Server Approval Required') continue;
    const box = boxFor(lines, titleIndex);
    if (!box || !roundedTop(lines[box.start]!) || !roundedBottom(lines[box.end]!)) continue;
    const parsed = choiceRows(lines, titleIndex + 1, label => {
      const match = /^\[([a-z])\]\s*(.+)$/i.exec(label.trim());
      return match ? match[2]!.trim() : undefined;
    });
    const firstOptionIndex = lines.findIndex((line, index) => index > titleIndex && index < box.end && /^\s*[│┃]?\s*(?:▶\s*)?\[[a-z]\]\s*/i.test(contentLine(line)));
    if (firstOptionIndex < 0) continue;
    const optionEnd = lines.findIndex((line, index) => index >= firstOptionIndex && index < box.end && !/^\s*[│┃]?\s*(?:▶\s*)?\[[a-z]\]\s*/i.test(contentLine(line)) && textLine(line));
    const tailStart = optionEnd < 0 ? box.end : optionEnd;
    const inBoxTail = lines.slice(tailStart, box.end).map(textLine).filter(Boolean);
    if (inBoxTail.length !== 1 || inBoxTail[0] !== 'Use arrow keys to navigate, Enter to select, or press the key shown') continue;
    const labels = parsed.rows.map(row => row.label);
    if (parsed.rows.filter(row => row.selected).length !== 1) continue;
    if (title === 'Workspace Trust Required') {
      const standard = ['Trust this workspace', 'Quit'];
      const withMcpChoice = ['Trust this workspace', "Trust this workspace, but don't enable all MCP servers", 'Quit'];
      if (JSON.stringify(labels) !== JSON.stringify(standard) && JSON.stringify(labels) !== JSON.stringify(withMcpChoice)) continue;
      const visible = lines.slice(box.start + 1, parsed.end).map(textLine).join('\n');
      if (!visible.includes('can execute code and access files in this directory.') || !visible.includes('Do you trust the contents of this directory?')) continue;
      const message = lines.slice(titleIndex + 1, firstOptionIndex).map(textLine).filter(Boolean).join('\n');
      if (!message) continue;
      if (!onlyBlankLines(lines, box.end + 1)) continue;
      return finish(terminal, screen, 'confirmation', title, message, parsed.rows, lines.slice(box.start, parsed.end).map(textLine));
    }
    const mcpOptions = ['Approve all servers', 'Continue without approval', 'Quit'];
    if (JSON.stringify(labels) !== JSON.stringify(mcpOptions)) continue;
    const visible = lines.slice(box.start + 1, parsed.end).map(textLine).join('\n');
    if (!visible.includes('server') && !visible.includes('Server')) continue;
    const message = lines.slice(titleIndex + 1, firstOptionIndex).map(textLine).filter(Boolean).join('\n');
    if (!message) continue;
    if (!onlyBlankLines(lines, box.end + 1)) continue;
    return finish(terminal, screen, 'permission', title, message, parsed.rows, lines.slice(box.start, parsed.end).map(textLine));
  }
}

/** Titles of the dialogs that block a CLI on their own, with no tool call behind them: trust, hook review, plan consent, updates. */
const MODAL_TITLES = /^(?:Workspace Trust Required|MCP Server Approval Required|Suggested Plan)$/;
export function isKnownBlockingTitle(title: string): boolean {
  const text = title.replace(/^(?:⚠️?\s*)/, '').trim();
  return COMMAND_PERMISSION_TITLE.test(text) || HINTED_TITLES.test(text) || PLAN_TITLES.test(text) || MODAL_TITLES.test(text);
}

/**
 * Parse a live CLI dialog. Plans and the blocking modals have semantics worth reading exactly;
 * everything else is recognized by shape. Clipped frames and prompts without a visible focus glyph
 * still stay in the terminal.
 *
 * Order matters: the rule-and-question shape is tried before the hint-closed shape, so Cursor's
 * decision surfaces keep their richer title/message extraction. `parseHintedSelect` runs last and
 * only claims screens that end on a CLI key hint, which no transcript does.
 */
export function parseChoiceDialog(screen: string, terminal: TerminalIdentity): DialogScreen | undefined {
  const lines = linesOf(screen);
  const plan = parsePlan(screen, terminal, lines);
  // A plan the strict parser turned down was truncated on screen. Approving a plan nobody can
  // finish reading is worse than answering it in the terminal, so the shape parser stays out.
  if (lines.some(line => textLine(line) === 'Suggested Plan')) return plan;
  return parseModal(screen, terminal, lines)
    ?? parseDecisionSurface(screen, terminal, lines)
    ?? parseHintedSelect(screen, terminal, lines);
}
