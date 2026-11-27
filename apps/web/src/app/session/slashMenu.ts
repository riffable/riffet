import type { SlashCommand } from './model';

/** A live `/` token under the caret. */
export interface SlashTrigger {
  query: string;
  /** Offset of the slash. */
  start: number;
  /** The token opens the message (leading whitespace aside), so commands are on offer too. */
  leading: boolean;
}

/** Characters that may directly precede a mid-message `/token` without triggering on paths, URLs, fractions, or CJK `A/B` pairs. */
const SLASH_BEFORE = /[\s([{"'（【「『《，。！？；：、]/;
/** Characters that close a slash query so scanning stops at the boundary of an earlier token. */
const SLASH_QUERY_STOP = /[\s)\]}"'）】」』》，。！？；：、]/;

/**
 * The `/` token the caret is in, if any. A slash opens a token at the start of the draft, after
 * whitespace, or after opening/separating punctuation; URLs (`https://`), paths (`src/app`,
 * `/Users/foo`), fractions (`1/2`), and CJK pairs (`浅色/深色`) never open the menu.
 */
export function detectSlashTrigger(text: string, caret: number): SlashTrigger | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    if (char === '/') {
      if (index > 0 && !SLASH_BEFORE.test(text[index - 1]!)) return null;
      return { query: text.slice(index + 1, caret), start: index, leading: text.search(/\S/) === index };
    }
    if (SLASH_QUERY_STOP.test(char)) return null;
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
 * parts) outranks a substring, which outranks segment-initial abbreviations (`nr` → `new-repo`).
 */
function slashScore(item: SlashCommand, query: string): number | undefined {
  if (!query) return 0;
  const name = item.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  const parts = name.split(/[-:_.]/).filter(Boolean);
  if (parts.some((part) => part.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  const initials = parts.map((part) => part[0]!).join('');
  if (query.length >= 2 && isSubsequence(query, initials)) return 4;
  if (item.description?.toLowerCase().includes(query)) return 5;
  return undefined;
}

const RAW_SLASH_COMMAND = /^[A-Za-z0-9][\w.:-]*$/;

/**
 * Whether the "send `/<query>` verbatim" row should sit ahead of catalog matches: when the user
 * typed a valid CLI command token and nothing in the catalog matched by name (only weak
 * description hits, if any), pressing Enter should send the command as in a terminal.
 */
export function passthroughSlashFirst(items: readonly SlashCommand[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle || !RAW_SLASH_COMMAND.test(needle)) return false;
  return !items.some((item) => {
    const score = slashScore(item, needle);
    return score !== undefined && score < 5;
  });
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

const SLASH_TOKEN = /(^|[\s([{"'（【「『《，。！？；：、])\/([A-Za-z0-9][\w.:-]*)(?=$|[^A-Za-z0-9_.:/-])/g;

/** Every invoked `/name` range in `text` that the backend will act on, in text order. */
export function slashTokenRanges(
  text: string,
  byName: ReadonlyMap<string, SlashCommand>,
  inlineSkills: boolean,
): Array<{ start: number; end: number; item: SlashCommand }> {
  const first = text.search(/\S/);
  const ranges: Array<{ start: number; end: number; item: SlashCommand }> = [];
  for (const match of text.matchAll(SLASH_TOKEN)) {
    const item = byName.get(match[2]!);
    if (!item) continue;
    const start = match.index + match[1]!.length;
    const leading = start === first;
    if (leading || (inlineSkills && item.kind === 'skill')) {
      ranges.push({ start, end: start + 1 + match[2]!.length, item });
    }
  }
  return ranges;
}

/**
 * The catalog entries the draft invokes as written: a bounded `/name` the backend will
 * act on — the leading token for any entry, a later one only for a skill on a backend that loads
 * skills mid-message. Deduplicated in order. The catalog comes keyed by name, so the caller builds
 * that once per catalog instead of once per keystroke.
 */
export function invokedSlashItems(text: string, byName: ReadonlyMap<string, SlashCommand>, inlineSkills: boolean): SlashCommand[] {
  const found: SlashCommand[] = [];
  for (const { item } of slashTokenRanges(text, byName, inlineSkills)) {
    if (!found.includes(item)) found.push(item);
  }
  return found;
}

/** `text` with the bounded `/name` tokens removed, collapsing the gap each leaves. */
export function removeSlashToken(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // i18n-ignore — regex boundary character class, not user-facing text
  return text.replace(new RegExp(`(^|[\\s([{"'（【「『《，。！？；：、])\\/${escaped}(?=$|[^A-Za-z0-9_.:/-])\\s?`, 'g'), '$1');
}
