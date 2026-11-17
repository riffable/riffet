/**
 * Quotes taken from answers (the selection toolbar's 引用). A message carries them as Markdown block quotes ahead of
 * what the reader wrote, so every agent and every client reads them as text; the web draws the leading ones as chips.
 */

/** [quotes] as block quotes, one blank line apart, then [body]. */
export function joinQuotes(quotes: readonly string[], body: string): string {
  if (!quotes.length) return body;
  const blocks = quotes.map((quote) => quote.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'));
  return [...blocks, body].join('\n\n');
}

/** The block quotes a message starts with, and what follows them; the reverse of `joinQuotes`. */
export function splitQuotes(text: string): { quotes: string[]; body: string } {
  const lines = text.split('\n');
  const quotes: string[] = [];
  let index = 0;
  while (index < lines.length && /^>( |$)/.test(lines[index]!)) {
    const quote: string[] = [];
    while (index < lines.length && /^>( |$)/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^> ?/, ''));
    quotes.push(quote.join('\n'));
    while (index < lines.length && !lines[index]!.trim()) index += 1;
  }
  return quotes.length ? { quotes, body: lines.slice(index).join('\n') } : { quotes, body: text };
}

/** A quote's first line of words, for its chip: code fences are not words. */
export function quoteLabel(quote: string): string {
  return quote.split('\n').map((line) => line.trim()).find((line) => line && !/^(`{3,}|~{3,})/.test(line)) ?? quote.trim();
}
