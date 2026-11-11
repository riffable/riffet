/**
 * The command palette confronts one query with three kinds of row — actions, conversations and
 * projects — and has to rank them in a single order. Keeping that filter here, away from the
 * component and the DOM, is what makes the ranking testable: the palette only decides which rows
 * exist and what running one means.
 */

export type CommandKind = 'command' | 'conversation' | 'project';

export interface CommandCandidate {
  id: string;
  kind: CommandKind;
  /** The row's primary text; the only field a prefix match is rewarded for. */
  label: string;
  /** Secondary searchable text (cwd, tags, a settings section) that never outranks a label hit. */
  keywords?: string;
  /** Display-only companion to `label`, e.g. a conversation's project, so same-name rows differ. */
  detail?: string;
}

const PREFIX = 3;
const MENTION = 2;

function labelScore(label: string, token: string): number {
  if (label.startsWith(token)) return PREFIX;
  return label.includes(token) ? MENTION : 0;
}

/**
 * Every whitespace-separated token has to hit the label or the keywords, so "proj conv" narrows
 * rather than widens. Rows are ordered by how well their *label* answers the query; a keyword-only
 * hit has score 0 and therefore sorts below those, ties keeping the caller's order.
 */
export function matchCommands(candidates: readonly CommandCandidate[], query: string): CommandCandidate[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...candidates];
  const ranked: { candidate: CommandCandidate; score: number; index: number }[] = [];
  candidates.forEach((candidate, index) => {
    const label = candidate.label.toLocaleLowerCase();
    const keywords = candidate.keywords?.toLocaleLowerCase() ?? '';
    if (!tokens.every((token) => label.includes(token) || keywords.includes(token))) return;
    const score = tokens.reduce((best, token) => Math.max(best, labelScore(label, token)), 0);
    ranked.push({ candidate, score, index });
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.map((entry) => entry.candidate);
}
