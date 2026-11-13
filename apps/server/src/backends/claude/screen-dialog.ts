import { createHash } from 'node:crypto';
import type { NativeInteraction, TerminalInfo } from '../../../../../packages/contracts/src/index.js';
import { parseDialog } from '../../agent-host/interaction-screen.js';

const ID_PREFIX = 'claude-screen:';
/** One hint in the frame's `·`-joined footer: the key or chord, `to`, and what it does. */
const FOOTER_HINT = /^\S+ to \w+(?: \w+)?$/i;
const RULE = /^\s*─{20,}\s*$/;
/** A numbered list means Enter picks whichever row is highlighted, which a confirm button must not do blindly. */
const NUMBERED_OPTION = /^\s*(?:[❯›]\s*)?\d+\.\s/;
/**
 * The same blind press without numbers: `Enter` on a list, tab or settings surface activates whatever
 * it has highlighted (`←/→ to switch · ↑/↓ to navigate · Enter to select · Esc to close`), which is
 * navigation rather than an answer, so those footers stay a terminal matter.
 */
const NAVIGATION_VERB = /^(?:select|view|open|switch|navigate|scroll|filter|expand|cycle|toggle)$/i;
/** A dialog can be a full screen of its own — the auto-mode proposal review runs past sixty lines. */
const MAX_BODY_LINES = 200;
/**
 * How much of an unruled dialog the card describes. The auto-mode proposal review is a full screen
 * of its own, so this is the dialog's tail — what the screen shows and what its choices are — rather
 * than a guess at where the conversation above it stopped.
 */
const UNRULED_BODY_LINES = 40;
/** Every live decision surface marks its focused row; prose and a clipped frame do not. */
const FOCUS_ROW = /^\s*(?:❯|›|>)\s+\S/;
const FOCUS_MARK = /^\s*(?:❯|›|>)?\s*/;
// The `ctrl+g to edit in Vim` hint joins the footer while the free-text row has focus.
const QUESTION_FOOTER = /^Enter to select\s+·\s+↑\/↓ to navigate(?:\s+·\s+ctrl\+g to edit in Vim)?\s+·\s+Esc to cancel$/;
const FREE_TEXT_LABEL = 'Type something.';
const QUESTION_OPTION = /^(\s*)([❯›]\s*)?(\d+)\.\s+(.+)$/;

const VERB_LABELS: Record<string, string> = { continue: '继续', confirm: '确认', accept: '接受', cancel: '取消', exit: '退出', 'go back': '返回', skip: '跳过' };

export interface ClaudeScreenDialog {
  body: string; confirm: string; cancel: string;
  /**
   * Where a form's own confirm row (`Continue`) is from the focused row. Enter acts on the focused row — on
   * the auto-mode setup form it flips the toggle under the cursor — so only that row confirms.
   */
  confirmRow?: 'focused' | 'above' | 'below';
}

/**
 * The frame's footer is one hint per control it has, joined by `·`. A card can drive only the Enter
 * and Esc ones, and the CLI puts the hints a card cannot press in front of them: the auto-mode
 * setup screen ends with `←/→ to change · Enter to continue · Esc to cancel`. A footer without the
 * Enter/Esc pair (a screen that only navigates) is left to the terminal.
 */
function parseFooter(line: string): { confirm: string; cancel: string } | undefined {
  const hints = line.split(/\s+·\s+/);
  if (hints.some(hint => !FOOTER_HINT.test(hint))) return undefined;
  const confirm = hints.find(hint => /^Enter to /i.test(hint));
  const cancel = hints.at(-1);
  if (!confirm || !cancel || !/^Esc to /i.test(cancel)) return undefined;
  const verb = confirm.slice('Enter to '.length).toLowerCase();
  if (NAVIGATION_VERB.test(verb)) return undefined;
  return { confirm: verb, cancel: cancel.slice('Esc to '.length).toLowerCase() };
}

/**
 * Claude Code's own full-screen notices (billing changes, release notes, and similar) are drawn by
 * the TUI and never reach a hook, so a turn behind one looks busy forever. They share one shape: the
 * frame's key hints as the last line of the screen, above them the dialog, and — when the TUI draws
 * it as a frame — a full-width rule above the title.
 *
 * In fullscreen mode the whole conversation, the dialog included, sits in a scroll viewport and the
 * frame leaves the rule out; the transcript then ends right above the title with nothing to separate
 * them. Only the dialog's own tail can be told apart there, so that is what the card describes.
 */
export function parseClaudeScreenDialog(screen: string): ClaudeScreenDialog | undefined {
  const lines = screen.split(/\r?\n/).map(line => line.trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  const footer = parseFooter(lines.at(-1)?.trim() ?? '');
  if (!footer) return undefined;
  let start = lines.length - 2;
  while (start >= 0 && !RULE.test(lines[start]!)) start -= 1;
  const unruled = start < 0;
  const body = unruled ? lines.slice(Math.max(0, lines.length - 1 - UNRULED_BODY_LINES), -1) : lines.slice(start + 1, -1);
  while (body.length && !body[0]) body.shift();
  while (body.length && !body.at(-1)) body.pop();
  if (!body.length || body.length > MAX_BODY_LINES || body.some(line => NUMBERED_OPTION.test(line))) return undefined;
  // Without the rule a quoted hint and a clipped frame read the same as a dialog; only a focused row
  // says the TUI is drawing a decision surface here instead of printing prose.
  if (unruled && !body.some(line => FOCUS_ROW.test(line))) return undefined;
  const indent = Math.min(...body.filter(Boolean).map(line => line.length - line.trimStart().length));
  const focused = body.findIndex(line => FOCUS_ROW.test(line));
  const target = body.findIndex(line => line.replace(FOCUS_MARK, '').trim().toLowerCase() === footer.confirm);
  const confirmRow = focused < 0 || target < 0 ? undefined : target === focused ? 'focused' : target > focused ? 'below' : 'above';
  return { body: body.map(line => line.slice(indent)).join('\n'), confirm: footer.confirm, cancel: footer.cancel, ...(confirmRow ? { confirmRow } : {}) };
}

/** What Claude Code's own single-select `AskUserQuestion` dialog shows: the choices, the free-text row and where the cursor is. */
export interface ClaudeScreenQuestion {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  /** Row under the cursor: an option, `options.length` for the free-text row, `options.length + 1` for "Chat about this". */
  focus: number;
  /** What was typed into the free-text row, once something was. */
  typed?: string;
  /** The dialog without its cursor and typed text, so its identity survives both. */
  body: string;
}

/**
 * Claude Code draws this dialog itself once a hook can no longer answer the question (the hook timed
 * out, the server restarted, the connection broke). Only the single-question, single-select layout is
 * read; the tabbed multi-question and the checkbox multi-select layouts are not, and stay a terminal matter.
 */
export function parseClaudeScreenQuestion(screen: string): ClaudeScreenQuestion | undefined {
  const lines = screen.split(/\r?\n/).map(line => line.trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  if (!QUESTION_FOOTER.test(lines.at(-1)?.trim() ?? '')) return undefined;
  let divider = lines.length - 2;
  while (divider >= 0 && !RULE.test(lines[divider]!)) divider -= 1;
  if (divider < 0) return undefined;
  const below = lines.slice(divider + 1, -1).filter(line => line.trim());
  if (below.length !== 1) return undefined;
  const chat = QUESTION_OPTION.exec(below[0]!);
  if (!chat || chat[4] !== 'Chat about this') return undefined;
  let start = divider - 1;
  while (start >= 0 && !RULE.test(lines[start]!)) start -= 1;
  if (start < 0) return undefined;
  const body = lines.slice(start + 1, divider);
  if (body.length > MAX_BODY_LINES) return undefined;
  const first = body.findIndex(line => QUESTION_OPTION.test(line));
  if (first < 0) return undefined;
  // Both the question header and its prompt must still be visible; never reconstruct a clipped pane.
  const heading = body.slice(0, first).filter(line => line.trim());
  if (heading.length < 2 || !/^\s*[□☐]\s+\S/.test(heading[0]!) || heading.some(line => /^\s*(?:>|●|❯|›)/.test(line))) return undefined;
  const rows: RegExpExecArray[] = [];
  const descriptions: string[][] = [];
  let focus = -1;
  let focused = chat[2] ? 1 : 0;
  for (const line of body.slice(first)) {
    const row = QUESTION_OPTION.exec(line);
    if (row) {
      if (Number(row[3]) !== rows.length + 1) return undefined;
      rows.push(row);
      descriptions.push([]);
      if (row[2]) { focused += 1; focus = rows.length - 1; }
    } else if (line.trim()) {
      // Wrapped labels/descriptions stay under a row, not at the question or focus column.
      const previous = rows.at(-1);
      const labelColumn = previous ? previous[0].length - previous[4]!.length : 0;
      if (!previous || line.length - line.trimStart().length < labelColumn) return undefined;
      descriptions.at(-1)!.push(line.trim());
    }
  }
  // Two to four answers, then the native free-text editor and the separate discussion command.
  if (rows.length < 3 || rows.length > 5 || focused !== 1 || Number(chat[3]) !== rows.length + 1) return undefined;
  if (chat[2]) focus = rows.length;
  const free = rows.at(-1)!;
  // Typed text takes the place of the row's label while the row has focus.
  const typed = free[4] === FREE_TEXT_LABEL ? undefined : free[2] ? free[4] : null;
  if (typed === null) return undefined;
  if (rows.slice(0, -1).some(row => /^(?:Type something\.|Chat about this)$/.test(row[4]!))) return undefined;
  const answers = rows.slice(0, -1);
  if (answers.length < 2 || answers.length > 4 || answers.some(row => /^\[[ ✔xX]\]\s/.test(row[4]!))) return undefined;
  const identity = body.map(line => {
    const text = line.replace(/^(\s*)[❯›]\s*/, '$1  ').trimEnd();
    const row = QUESTION_OPTION.exec(line);
    return row && Number(row[3]) === rows.length ? `${text.slice(0, text.length - row[4]!.length)}${FREE_TEXT_LABEL}` : text;
  });
  const question = heading.slice(1).map(line => line.replace(/^\s*[│┃]\s?/, '').trim()).join(' ');
  return {
    header: heading[0]!.replace(/^\s*[□☐]\s+/, '').trim(), question,
    options: answers.map((row, index) => ({ label: row[4]!, ...(descriptions[index]!.length ? { description: descriptions[index]!.join(' ') } : {}) })),
    focus, ...(typed ? { typed } : {}), body: identity.join('\n').trim(),
  };
}

export function isClaudeScreenInteraction(interaction: Pick<NativeInteraction, 'id'> | undefined): boolean {
  return interaction?.id.startsWith(ID_PREFIX) === true;
}

/**
 * A screen has one owner. A dialog the shared terminal parser recognizes (trust, choice lists) is
 * lifted and answered by `TerminalDialogObserver`; reading it here as well would give the same
 * screen two interaction ids on two poll cadences, and the card would flicker between them.
 */
export function claudeScreenInteraction(screen: string, terminal: Pick<TerminalInfo, 'id' | 'epoch'>): NativeInteraction | undefined {
  if (parseDialog(screen, terminal)) return undefined;
  const question = parseClaudeScreenQuestion(screen);
  if (question) {
    const digest = createHash('sha256').update(`${terminal.id}\0question\0${question.body}`).digest('hex').slice(0, 24);
    return {
      id: `${ID_PREFIX}${digest}`, revision: '1', transport: 'terminal', terminalId: terminal.id, epoch: terminal.epoch,
      kind: 'question', title: question.header, message: question.question,
      options: question.options.map((option, index) => ({ id: `option-${index}`, label: option.label, selected: false })),
      // Only the single-question layout is read (see `parseClaudeScreenQuestion`): this is the last question.
      allowOther: true, questionIndex: 1, questionCount: 1,
      actions: [{ id: 'answer', label: 'Submit', tone: 'primary' }],
    };
  }
  const dialog = parseClaudeScreenDialog(screen);
  if (!dialog) return undefined;
  // The terminal epoch moves whenever a browser takes control, so it is carried but kept out of the
  // identity; otherwise opening the terminal drawer would invalidate an answer in flight.
  const digest = createHash('sha256').update(`${terminal.id}\0${dialog.confirm}\0${dialog.cancel}\0${dialog.body}`).digest('hex').slice(0, 24);
  return {
    id: `${ID_PREFIX}${digest}`, revision: '1', transport: 'terminal', terminalId: terminal.id, epoch: terminal.epoch,
    kind: 'confirmation', title: 'Claude Code 需要确认', message: dialog.body, options: [],
    actions: [
      { id: 'continue', label: VERB_LABELS[dialog.confirm] ?? dialog.confirm, tone: 'primary' },
      { id: 'cancel', label: VERB_LABELS[dialog.cancel] ?? dialog.cancel },
    ],
  };
}
