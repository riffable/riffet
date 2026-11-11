import { TERMINAL_SCROLLBACK_ROWS } from '../../../../packages/contracts/src/index.js';
import { unescapeOctal } from './control.js';
import { OuterTerminalState } from './protocol-state.js';

/** What tmux can state about a pane's modes; bracketed paste and focus reporting have no format and come from the raw stream. */
const FORMATS = [
  'pane_width', 'pane_height', 'history_size', 'alternate_on', 'cursor_x', 'cursor_y', 'cursor_flag', 'insert_flag',
  'keypad_cursor_flag', 'keypad_flag', 'wrap_flag', 'origin_flag', 'mouse_standard_flag', 'mouse_button_flag', 'mouse_any_flag',
  'mouse_sgr_flag', 'mouse_utf8_flag', 'scroll_region_upper', 'scroll_region_lower', 'alternate_saved_x', 'alternate_saved_y',
];

/**
 * The commands whose replies, run back to back in one control-stream line, describe a pane: its
 * geometry and modes, the scrollback, the saved normal screen (empty unless an alternate screen is
 * on), the visible screen, and the escape sequence the pane's parser has only half received. `-N`
 * keeps physical rows with their background cells; `-C` escapes bytes the way `%output` does.
 */
export function seedCommands(pane: string): string[][] {
  const capture = (...flags: string[]) => ['capture-pane', '-p', '-e', '-C', '-N', ...flags, '-t', pane];
  return [
    ['display-message', '-p', '-t', pane, FORMATS.map(name => `#{${name}}`).join(' ')],
    capture('-S', `-${TERMINAL_SCROLLBACK_ROWS}`, '-E', '-1'),
    capture('-a', '-q'),
    capture(),
    ['capture-pane', '-p', '-P', '-C', '-t', pane],
  ];
}

/** One control-stream line for `seedCommands`; five blocks come back. */
export function seedLine(pane: string): string {
  const quote = (token: string) => /^[\w%.:@=-]+$/.test(token) ? token : `'${token}'`;
  return seedCommands(pane).map(tokens => tokens.map(quote).join(' ')).join(' ; ');
}

export const SEED_BLOCKS = 5;

/** Modes read from the pane's raw output, tracked by `OuterTerminalState`. */
export interface TrackedModes {
  mode(mode: number): boolean;
  readonly cursorStyle: string;
}

export interface Seed { data: string; cols: number; rows: number }

const ESC = '\u001b';
const rowsOf = (lines: Buffer[]) => lines.map(line => unescapeOctal(line).toString('utf8'));

/**
 * `capture-pane -e` states a style once and lets it run across rows, but the line feed that scrolls
 * the emulator fills the new line with the pen in force. So every row ends with a reset, and the
 * next row starts by restating the style the capture carried into it.
 */
function joinRows(rows: string[]): string {
  const pen = new OuterTerminalState();
  return rows.map(row => {
    const lead = pen.style().slice(`${ESC}[0m`.length);
    pen.accept(row);
    return lead + row;
  }).join(`${ESC}[0m\r\n`);
}

/**
 * Builds the bytes that bring one fresh emulator to the pane's present state, from the replies to
 * `seedCommands`. Rows are joined with `\r\n` and no erase-display is used, so history scrolls into
 * the emulator's own scrollback instead of being erased. Not recoverable from tmux: the current
 * drawing pen, saved cursors, character sets and the title; the next repaint of a TUI restores them.
 * `history: false` leaves out the scrollback (protocol 2 clients read it from `/history`).
 */
export function assembleSeed(blocks: Buffer[][], tracked: TrackedModes, history: boolean): Seed | undefined {
  if (blocks.length < SEED_BLOCKS) return undefined;
  const values = blocks[0]![0]?.toString('latin1').trim().split(' ').map(Number) ?? [];
  const [cols, rows, historySize, alternateOn, cursorX, cursorY, cursorFlag, insertFlag, keypadCursor, keypad, wrap, origin,
    mouseStandard, mouseButton, mouseAny, mouseSgr, mouseUtf8, regionUpper, regionLower, savedX, savedY] = values as number[];
  if (values.length < FORMATS.length || !(cols! >= 1) || !(rows! >= 1) || values.some(Number.isNaN)) return undefined;
  const rowCount = rows!, colCount = cols!;
  // tmux reports an unset saved cursor as 4294967295.
  const clamp = (value: number | undefined, limit: number) => value === undefined || !(value >= 0) || value >= 2 ** 31 ? 0 : Math.min(value, limit - 1);
  const alt = alternateOn === 1;
  // With no history `-E -1` still returns the first screen line.
  const scrollback = history && historySize! > 0 ? rowsOf(blocks[1]!).slice(-historySize!) : [];
  const saved = rowsOf(blocks[2]!), screen = rowsOf(blocks[3]!);
  const normal = (alt ? saved : screen).slice(-rowCount);

  const parts: string[] = [`${ESC}c`];
  if (scrollback.length) parts.push(joinRows(scrollback), `${ESC}[0m\r\n`);
  parts.push(joinRows(normal), `${ESC}[0m`);
  if (alt) {
    // Park the saved cursor where the normal screen had it, so leaving the alternate screen returns there.
    parts.push(`${ESC}[${clamp(savedY, rowCount) + 1};${clamp(savedX, colCount) + 1}H${ESC}[?1049h`);
    screen.slice(-rowCount).forEach((row, index) => parts.push(`${ESC}[${index + 1};1H`, row));
    parts.push(`${ESC}[0m`);
  }
  const flag = (on: number | boolean | undefined, code: string, prefix = '?') => `${ESC}[${prefix}${code}${on ? 'h' : 'l'}`;
  const regionTop = clamp(regionUpper, rowCount), regionBottom = clamp(regionLower, rowCount);
  const full = regionTop === 0 && regionBottom === rowCount - 1;
  parts.push(
    full ? `${ESC}[r` : `${ESC}[${regionTop + 1};${regionBottom + 1}r`,
    flag(keypadCursor, '1'), keypad ? `${ESC}=` : `${ESC}>`, flag(insertFlag, '4', ''), flag(wrap, '7'), flag(origin, '6'),
    // xterm.js keeps one mouse protocol: any `l` resets it, so reset first and set only the one in force.
    `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l`,
    mouseAny ? `${ESC}[?1003h` : mouseButton ? `${ESC}[?1002h` : mouseStandard ? `${ESC}[?1000h` : '',
    flag(mouseSgr, '1006'), flag(mouseUtf8, '1005'), flag(cursorFlag, '25'),
    flag(tracked.mode(2004), '2004'), flag(tracked.mode(1004), '1004'), tracked.cursorStyle,
    // Origin mode counts rows from the top of the scroll region.
    `${ESC}[${clamp(cursorY, rowCount) + 1 - (origin ? regionTop : 0)};${clamp(cursorX, colCount) + 1}H`,
    unescapeOctal(blocks[4]![0] ?? Buffer.alloc(0)).toString('utf8'),
  );
  return { data: parts.join(''), cols: colCount, rows: rowCount };
}
