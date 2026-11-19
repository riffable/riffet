import { createHash } from 'node:crypto';
import { joinWrapped, parseChoiceDialog } from './interaction-choice.js';
import type { NativeInteraction, TerminalInfo } from '../../../../packages/contracts/src/index.js';

export interface DialogScreen {
  interaction: NativeInteraction;
  focus: number;
  rows: Array<{ id: string; label: string; selected: boolean; other: boolean }>;
  cursorApprovalBatch?: string;
  /** Visible Other text before rejoining wraps, whose boundary spaces the terminal cannot preserve. */
  otherValueLines?: string[];
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const QUESTION_HINT = '↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip';

/** Check every visible character; only whitespace at a terminal wrap boundary is ambiguous. */
export function matchesOtherValue(screen: DialogScreen, value: string): boolean {
  if (!screen.otherValueLines || !value) return screen.interaction.otherValue === value;
  let remaining = value;
  for (const [index, line] of screen.otherValueLines.entries()) {
    if (index > 0) remaining = remaining.trimStart();
    if (!remaining.startsWith(line)) return false;
    remaining = remaining.slice(line.length);
  }
  return remaining.length === 0;
}

/** Only inspect a complete foreground dialog. Transcript text and clipped frames are not controls. */
export function dialogLines(screen: string): string[] | undefined {
  const lines = screen.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split('\n');
  const start = lines.findLastIndex(line => /^\s*[┌╭][─━]+[┐╮]\s*$/.test(line));
  if (start < 0) return;
  const end = lines.findIndex((line, index) => index > start && /^\s*[└╰][─━]+[┘╯]\s*$/.test(line));
  if (end < 0 || lines.slice(end + 1).some(line => line.trim())) return;
  const body = lines.slice(start + 1, end);
  if (!body.every(line => /^\s*[│┃].*[│┃]\s*$/.test(line))) return;
  return body.map(line => line.replace(/^\s*[│┃]\s?/, '').replace(/[│┃]\s*$/, '').trim());
}

export function parseDialog(screen: string, terminal: Pick<TerminalInfo, 'id' | 'epoch'>): DialogScreen | undefined {
  const lines = dialogLines(screen);
  if (!lines) return parseChoiceDialog(screen, terminal);
  const marker = lines.findIndex(line => /^Question \d+ of \d+$/.test(line));
  if (marker < 0) return parseChoiceDialog(screen, terminal);
  // On a narrow pane the key hint wraps over several lines at the bottom of the box.
  const tail = (from: number) => lines.slice(from).join(' ').replace(/\s+/g, ' ').trim();
  let hint = lines.length;
  while (hint > marker + 1 && tail(hint).length < QUESTION_HINT.length) hint--;
  if (tail(hint) !== QUESTION_HINT) return;
  const [, indexText, countText] = /^Question (\d+) of (\d+)$/.exec(lines[marker]!)!;
  const index = Number(indexText), count = Number(countText);
  if (index < 1 || index > count || count > 100) return;
  const rows: DialogScreen['rows'] = [];
  const prompt: string[] = [];
  const otherValueLines: string[] = [];
  let focus = -1;
  for (const line of lines.slice(marker + 1, hint)) {
    if (!line) continue;
    const match = /^(›\s*)?\[([ xX])\]\s+(.+)$/.exec(line);
    if (match) {
      if (match[1]) { if (focus >= 0) return; focus = rows.length; }
      const other = /^Other:/.test(match[3]!);
      if (other) otherValueLines.push(match[3]!.slice('Other:'.length).trim());
      rows.push({ id: other ? 'other' : `option-${rows.length}`, label: match[3]!, selected: match[2]!.toLowerCase() === 'x', other });
    } else if (rows.length) {
      // Ink wraps labels within their row. Preserve the words rather than inventing another option.
      rows.at(-1)!.label = joinWrapped(rows.at(-1)!.label, line);
      if (rows.at(-1)!.other) otherValueLines.push(line);
    } else prompt.push(line);
  }
  if (!rows.length || rows.length > 100 || focus < 0 || rows.filter(row => row.other).length > 1) return;
  if (!prompt[0]?.startsWith(`${index}. `)) return;
  const multiSelect = /\s*\(multi-\s?select\)$/;
  const question = prompt.reduce(joinWrapped);
  const multiple = multiSelect.test(question);
  const message = question.replace(/^\d+\.\s*/, '').replace(multiSelect, '');
  const other = rows.find(row => row.other);
  // Every question in this CLI version has a final Other row; its absence indicates clipping.
  if (!other || rows.at(-1) !== other) return;
  const otherValue = other.label.slice('Other:'.length).trim();
  const title = lines.slice(0, marker).filter(Boolean).join(' ') || '需要你回答';
  const structure = { kind: 'question', title, message, index, count, multiple, options: rows.filter(row => !row.other).map(row => row.label) };
  const interaction: NativeInteraction = {
    id: digest([terminal.id, terminal.epoch, structure]), revision: digest([terminal.id, terminal.epoch, lines]), terminalId: terminal.id, epoch: terminal.epoch,
    kind: 'question', title, message, options: rows.filter(row => !row.other).map(({ id, label, selected }) => ({ id, label, selected })),
    multiple, allowOther: true, otherValue: otherValue === '(type to answer)' ? '' : otherValue, otherSelected: other.selected,
    questionIndex: index, questionCount: count,
    actions: [
      ...(index > 1 ? [{ id: 'previous', label: '上一题' }] : []),
      ...(index < count ? [{ id: 'next', label: '下一题（保留当前答案）' }] : []),
      { id: 'answer', label: index < count ? '保存并下一题' : '提交全部答案', tone: 'primary' },
      { id: 'skip', label: '跳过整组问题' },
    ],
  };
  return { interaction, focus, rows, otherValueLines };
}
