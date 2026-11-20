/** One simple command of a shell line: its words, and whether it reads the previous command's output through `|`. */
export interface ShellSegment { words: string[]; piped: boolean }

/**
 * Splits a shell line into simple commands at `;`, `&&`, `||`, `|` and newlines, with quotes and
 * escapes removed from the words and `#` comments dropped. Conservative: a line this cannot read
 * word for word returns undefined, namely a command or process substitution, a subshell, a heredoc, a
 * background job, an unclosed quote, or a redirection that writes anywhere but `/dev/null` or another
 * descriptor. Variables and globs stay as written.
 */
export function shellSegments(command: string): ShellSegment[] | undefined {
  const segments: ShellSegment[] = [{ words: [], piped: false }];
  let word: string | undefined;
  let quote = '';
  const finish = () => { if (word !== undefined) segments.at(-1)!.words.push(word); word = undefined; };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote === "'") { if (char === "'") quote = ''; else word += char; continue; }
    if (char === '`' || (char === '$' && next === '(')) return undefined;
    if (char === '\\') {
      // Inside double quotes a backslash escapes only `$`, a backquote, `"`, `\` and a line break; before anything else it stays.
      index += 1;
      // A line continuation joins the lines and adds no word of its own.
      if (next === '\n') continue;
      const escapes = quote !== '"' || (next !== undefined && '$`"\\'.includes(next));
      word = (word ?? '') + (escapes ? next ?? '' : char + (next ?? ''));
      continue;
    }
    if (quote === '"') { if (char === '"') quote = ''; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; word ??= ''; continue; }
    if (char === '#' && word === undefined) {
      while (index + 1 < command.length && command[index + 1] !== '\n') index += 1;
      continue;
    }
    if (char === ' ' || char === '\t') { finish(); continue; }
    if (char === '\n' || char === ';' || char === '|' || (char === '&' && next === '&')) {
      finish();
      // A line break after `|` or `&&` continues the same list.
      if (char === '\n' && !segments.at(-1)!.words.length) continue;
      const piped = char === '|' && next !== '|';
      if ((char === '|' || char === '&') && (next === '|' || next === '&')) index += 1;
      segments.push({ words: [], piped });
      continue;
    }
    if (char === '(' || char === ')') return undefined;
    if (char === '>' || char === '<' || char === '&') {
      // A file descriptor written before the operator (`2>`) belongs to it.
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      finish();
      let operator = char;
      while (operator.length < 3 && index + 1 < command.length && '<>&|'.includes(command[index + 1]!)) operator += command[++index];
      if (operator === '&' || operator.startsWith('<<') || /[<>]\($/.test(operator + (command[index + 1] ?? ''))) return undefined;
      while (command[index + 1] === ' ') index += 1;
      let target = '';
      while (index + 1 < command.length && !' \t\n;|&<>()'.includes(command[index + 1]!)) target += command[++index];
      const writes = operator !== '<';
      if (operator.endsWith('&') && writes ? !/^(\d+|-)$/.test(target) : writes && target !== '/dev/null') return undefined;
      continue;
    }
    word = (word ?? '') + char;
  }
  if (quote) return undefined;
  finish();
  return segments.filter(segment => segment.words.length);
}
