import { createHash } from 'node:crypto';

export const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export const composerText = (screen: string | undefined): string => {
  const lines = (screen ?? '').split(/\r?\n/);
  const borders = lines.flatMap((line, index) => (/^\s*[─━]{8,}\s*$/.test(line) ? [index] : []));
  if (borders.length < 2) return '';
  return lines
    .slice(borders.at(-2)! + 1, borders.at(-1)!)
    .join('\n')
    .replace(/^\s*>\s?/, '');
};

// An empty composer may still show the current mode's grey hint, e.g. "Plan mode: research & plan only (shift+tab to cycle)".
const EMPTY_COMPOSER = /[─━]{8,}\r?\n[ \t]*>[ \t]*(?:[A-Z][A-Za-z-]* mode: [^\n]* \(shift\+tab to cycle\)[ \t]*)?\r?\n[─━]{8,}/;
export const emptyComposer = (screen: string | undefined) => Boolean(screen && EMPTY_COMPOSER.test(screen));

const compact = (value: string) => value.replace(/\s/g, '');

/**
 * Whether the composer holds `text`. agy collapses a multi-line or long paste into one
 * `[Pasted text #N +L lines]` / `[Pasted text #N C chars]` chip (1.5.7); its USER_INPUT record
 * still carries the full text, which `receipts` matches afterwards.
 */
export const composerHolds = (composer: string, text: string): boolean => {
  if (compact(composer).includes(compact(text))) return true;
  const lines = text.split(/\r?\n/).length;
  const sizes = [text.length, [...text].length];
  return [...composer.matchAll(/\[Pasted text #\d+ (?:\+(\d+) lines?|(\d+) chars?)\]/g)].some(match =>
    match[1] ? [lines, lines - 1].includes(Number(match[1])) : sizes.includes(Number(match[2])),
  );
};

/**
 * Whether a USER_INPUT body is the text Riffet typed. In plan mode agy records it as `/plan <text>` (1.5.7);
 * Riffet itself never sends a leading slash command (`send` refuses one), so that prefix is agy's own.
 */
export const sameInput = (body: unknown, rendered: string | undefined): boolean => {
  if (typeof body !== 'string' || rendered === undefined) return false;
  return body === rendered || (body.endsWith(rendered) && /^\/[a-z][a-z-]* $/.test(body.slice(0, body.length - rendered.length)));
};
