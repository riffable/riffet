import type { Terminal } from '@xterm/xterm';
import type { TerminalGridDiagnostics } from '@contracts';

/** Compare the live screen with tmux even when this viewer is reading scrollback. */
export function readTerminalGrid(term: Pick<Terminal, 'buffer' | 'rows' | 'cols'>): TerminalGridDiagnostics {
  const buffer = term.buffer.active;
  let lastContentRow: number | null = null;
  for (let row = term.rows; row > 0; row--) {
    if (buffer.getLine(buffer.baseY + row - 1)?.translateToString(true, 0, term.cols).trimEnd()) {
      lastContentRow = row;
      break;
    }
  }
  return { cols: term.cols, rows: term.rows, cursorRow: buffer.cursorY + 1, lastContentRow };
}
