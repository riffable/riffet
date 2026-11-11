/**
 * What a program's own output set, read from a raw byte stream: the private modes and cursor shape
 * tmux has no format variable for (bracketed paste, focus reporting, DECSCUSR), and the SGR pen for
 * history tails. A seed takes these from here; everything tmux does state comes from its formats.
 * Whatever was set before the stream was first observed reads as its default.
 */
export class OuterTerminalState {
  private pending = '';
  private modes = new Map<number, boolean>();
  private attributes = new Map<string, string>();
  /** The last DECSCUSR sequence, or '' for the terminal's own shape. */
  cursorStyle = '';

  mode(mode: number): boolean { return this.modes.get(mode) === true; }

  accept(data: string): void {
    const text = this.pending + data;
    this.pending = '';
    let at = 0;
    while ((at = text.indexOf('\u001b', at)) >= 0) {
      if (at + 1 >= text.length) { this.pending = text.slice(at); return; }
      const kind = text[at + 1];
      if (kind === '[') {
        const match = /^[\x20-\x3f]*[\x40-\x7e]/.exec(text.slice(at + 2));
        if (!match) { this.pending = text.slice(at); return; }
        const command = match[0];
        const args = command.slice(0, -1);
        const final = command.at(-1);
        if ((final === 'h' || final === 'l') && /^\?[\d;]+$/.test(args)) {
          for (const mode of args.slice(1).split(';').map(Number)) {
            // Screen buffers and synchronized-output are presentation transactions, not input modes.
            if (![3, 47, 1047, 1048, 1049, 2026].includes(mode)) this.modes.set(mode, final === 'h');
          }
        } else if (final === 'm' && /^[\d;:]*$/.test(args)) this.sgr(args);
        else if (final === 'q' && /^\d* $/.test(args)) this.cursorStyle = `\u001b[${command}`;
        at += command.length + 2;
      } else if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
        const end = text.indexOf('\u001b\\', at + 2);
        const bell = kind === ']' ? text.indexOf('\u0007', at + 2) : -1;
        const stop = end < 0 ? bell : bell < 0 ? end : Math.min(end, bell);
        if (stop < 0) { this.pending = `\u001b${kind}${text.endsWith('\u001b') ? '\u001b' : ''}`; return; }
        at = stop + (stop === bell ? 1 : 2);
      } else {
        if (kind === 'c') { this.modes.clear(); this.attributes.clear(); this.cursorStyle = ''; }
        at += 2;
      }
    }
  }

  private sgr(parameters: string): void {
    const values = parameters.split(';');
    for (let at = 0; at < values.length; at++) {
      let value = values[at]!;
      const code = Number(value.split(':')[0]);
      if (code === 0) { this.attributes.clear(); continue; }
      if ([38, 48, 58].includes(code) && !value.includes(':')) {
        const size = values[at + 1] === '2' ? 4 : values[at + 1] === '5' ? 2 : 0;
        value = values.slice(at, at + size + 1).join(';');
        at += size;
      }
      const key = code === 38 || code === 39 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97) ? 'fg'
        : code === 48 || code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107) ? 'bg'
        : code === 58 || code === 59 ? 'ulcolor'
        : code === 4 || code === 21 || code === 24 ? 'underline'
        : code === 3 || code === 23 ? 'italic'
        : code === 5 || code === 6 || code === 25 ? 'blink'
        : code === 7 || code === 27 ? 'inverse'
        : code === 8 || code === 28 ? 'invisible'
        : code === 9 || code === 29 ? 'strike'
        : code === 53 || code === 55 ? 'overline'
        : code >= 10 && code <= 19 ? 'font'
        : code === 51 || code === 52 || code === 54 ? 'frame'
        : code === 26 || code === 50 ? 'proportional'
        : code >= 60 && code <= 65 ? 'ideogram'
        : code >= 73 && code <= 75 ? 'script' : String(code);
      if (code === 22) { this.attributes.delete('1'); this.attributes.delete('2'); }
      else this.attributes.set(key, value);
    }
  }

  /** The drawing attributes in effect, from a reset. */
  style(): string {
    return '\u001b[0m' + (this.attributes.size ? `\u001b[${[...this.attributes.values()].join(';')}m` : '');
  }
}
