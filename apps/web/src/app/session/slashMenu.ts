import type { SlashCommand } from './model';

/** A live `/` token under the caret. */
export interface SlashTrigger {
  query: string;
  /** Offset of the slash. */
  start: number;
  /** The token opens the message (leading whitespace aside), so commands are on offer too. */
  leading: boolean;
}

/**
 * The `/` token the caret is in, if any. A slash opens a token at the start of the draft or after
 * whitespace, the same boundary the backends require of a `/name` they invoke; `a/b`, URLs and
 * paths typed mid-word never open the menu. The scan stops at whitespace, so the query is the
 * text between the opening slash and the caret.
 */
export function detectSlashTrigger(text: string, caret: number): SlashTrigger | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    if (/\s/.test(char)) return null;
    if (char !== '/') continue;
    if (index > 0 && !/\s/.test(text[index - 1]!)) continue;
    return { query: text.slice(index + 1, caret), start: index, leading: text.search(/\S/) === index };
  }
  return null;
}

/** Commands only work as the leading token; skills also mid-message where the backend invokes them there. */
export function slashCandidates(items: readonly SlashCommand[], leading: boolean, inlineSkills: boolean): SlashCommand[] {
  if (leading) return [...items];
  return inlineSkills ? items.filter((item) => item.kind === 'skill') : [];
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) if (char === needle[at]) at += 1;
  return at === needle.length;
}

/**
 * How well `query` names `item`; lower is better, `undefined` is no match. Name hits outrank
 * description hits, and among name hits a prefix (of the name or of one of its `-`/`:`-separated
 * parts) outranks a substring, which outranks an ordered subsequence.
 */
function slashScore(item: SlashCommand, query: string): number | undefined {
  if (!query) return 0;
  const name = item.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/[-:_.]/).some((part) => part.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  if (isSubsequence(query, name)) return 4;
  if (item.description?.toLowerCase().includes(query)) return 5;
  return undefined;
}

/** Matching items, best first; ties keep the catalog's order. */
export function rankSlashItems(items: readonly SlashCommand[], query: string, limit = 50): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  return items
    .map((item, index) => ({ item, index, score: slashScore(item, needle) }))
    .filter((entry): entry is { item: SlashCommand; index: number; score: number } => entry.score !== undefined)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * The menu's rows: commands first, then skills, each group ranked on its own so a strong skill
 * match never splits the commands. `kind` defaults to `command` for catalogs that predate it.
 */
export function slashMenuGroups(items: readonly SlashCommand[], query: string): Array<{ kind: 'command' | 'skill'; items: SlashCommand[] }> {
  const commands = rankSlashItems(items.filter((item) => item.kind !== 'skill'), query);
  const skills = rankSlashItems(items.filter((item) => item.kind === 'skill'), query);
  return [
    ...(commands.length ? [{ kind: 'command' as const, items: commands }] : []),
    ...(skills.length ? [{ kind: 'skill' as const, items: skills }] : []),
  ];
}

const SLASH_TOKEN = /(^|\s)\/([A-Za-z0-9][\w.:-]*)(?=\s|$)/g;

/**
 * The catalog entries the draft invokes as written: a whitespace-bounded `/name` the backend will
 * act on — the leading token for any entry, a later one only for a skill on a backend that loads
 * skills mid-message. Deduplicated in order. The catalog comes keyed by name, so the caller builds
 * that once per catalog instead of once per keystroke.
 */
export function invokedSlashItems(text: string, byName: ReadonlyMap<string, SlashCommand>, inlineSkills: boolean): SlashCommand[] {
  const first = text.search(/\S/);
  const found: SlashCommand[] = [];
  for (const match of text.matchAll(SLASH_TOKEN)) {
    const item = byName.get(match[2]!);
    if (!item || found.includes(item)) continue;
    const leading = match.index + match[1]!.length === first;
    if (leading || (inlineSkills && item.kind === 'skill')) found.push(item);
  }
  return found;
}

/** `text` with the whitespace-bounded `/name` tokens removed, collapsing the gap each leaves. */
export function removeSlashToken(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(^|\\s)\\/${escaped}(?=\\s|$)\\s?`, 'g'), '$1');
}
