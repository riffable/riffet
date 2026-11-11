import type { NativeSlashItem } from '@riffet/contracts';

/**
 * A `/name` token bounded by whitespace or the ends of the text: the shape the composer inserts
 * when a skill is picked. A second `/` or trailing punctuation breaks the match, which keeps paths
 * (`/usr/bin`), fractions (`5/8`) and prose (`/plan。`) out. Names may carry the `plugin:skill`
 * namespace Codex and Claude Code use.
 */
const SLASH_TOKEN = /(^|\s)\/([A-Za-z0-9][\w.:-]*)(?=\s|$)/g;

export interface SlashToken { name: string; start: number; end: number }

/** Every `/name` token in `text`, in order; `start` is the offset of the slash. */
export function slashTokens(text: string): SlashToken[] {
  const tokens: SlashToken[] = [];
  for (const match of text.matchAll(SLASH_TOKEN)) {
    const start = match.index + match[1]!.length;
    tokens.push({ name: match[2]!, start, end: start + 1 + match[2]!.length });
  }
  return tokens;
}

/** The skills `text` names, deduplicated in first-seen order; unknown names stay prose. */
export function referencedSkills<T extends Pick<NativeSlashItem, 'name'>>(text: string, skills: readonly T[]): T[] {
  const byName = new Map(skills.map(skill => [skill.name, skill]));
  const found: T[] = [];
  for (const token of slashTokens(text)) {
    const skill = byName.get(token.name);
    if (skill && !found.includes(skill)) found.push(skill);
  }
  return found;
}
