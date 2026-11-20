import type { Project, Session, SessionOrigin } from './session.js';

/**
 * 会话标题规则 (docs/SESSION-TITLES.md): how a conversation's name is shown, on top of the title the
 * workbench and the CLI wrote. The stored `title` is never rewritten; the server puts what a rule
 * makes of it in `Session.displayTitle`, so changing or deleting a rule applies to every conversation
 * at once and a CLI's own name stays what it was.
 */

/** Where a conversation came from, as a rule matches it: `manual` is one opened from the composer. A model discussion's seats are never renamed. */
export type TitleRuleOrigin = 'manual' | Exclude<SessionOrigin['kind'], 'council'>;

/**
 * Every condition given must hold; within one, any value does. A rule with no conditions applies to
 * every conversation.
 */
export interface TitleRuleMatch {
  /** Absolute directories; a project at or under one matches, and so does a worktree of one. */
  directories?: string[];
  /** Agent ids (`NativeBackendId`). */
  agents?: string[];
  origins?: TitleRuleOrigin[];
  tags?: string[];
}

export interface TitleRule {
  id: string;
  match: TitleRuleMatch;
  /** `{{title}}`, `{{project}}`, `{{date}}` and `{{time}}` are filled in; anything else is left as written. */
  template: string;
  /** `auto` leaves a title the owner typed alone; `all` applies to it too. Unset means `auto`. */
  scope?: 'auto' | 'all';
}

export const TITLE_RULE_PLACEHOLDERS = ['title', 'project', 'date', 'time'] as const;
/** The most rules `AppSettings.titleRules` holds; past it the server refuses the list. */
export const TITLE_RULES_MAX = 50;
/** The longest template, and the longest a rendered title is kept. */
export const TITLE_RULE_TEMPLATE_MAX = 200;
/** Values one condition holds at most. */
export const TITLE_RULE_VALUES_MAX = 32;

/** What a rule reads besides the conversation: its project, the project a worktree came from, and the zone dates are told in. */
export interface TitleRuleContext {
  project?: Pick<Project, 'cwd' | 'name' | 'system'>;
  originProject?: Pick<Project, 'cwd' | 'name'>;
  /** IANA zone for `{{date}}` and `{{time}}`; unset, the runtime's own. */
  timeZone?: string;
}

type RuleSession = Pick<Session, 'title' | 'titleSource' | 'backendId' | 'origin' | 'tags' | 'createdAt'>;

/**
 * The first rule that matches [session], or `undefined`. The 助理's project and model discussions
 * name their own conversations, so no rule reaches them.
 */
export function matchTitleRule(rules: readonly TitleRule[] | undefined, session: RuleSession, context: TitleRuleContext): TitleRule | undefined {
  if (!rules?.length) return undefined;
  if (context.project?.system === 'assistant' || context.project?.system === 'council' || session.origin?.kind === 'council') return undefined;
  return rules.find(rule => (rule.scope === 'all' || session.titleSource !== 'user') && matches(rule.match, session, context));
}

/** What [session] is shown as under [rules]; `undefined` when no rule changes its title. */
export function renderDisplayTitle(rules: readonly TitleRule[] | undefined, session: RuleSession, context: TitleRuleContext): string | undefined {
  const rule = matchTitleRule(rules, session, context);
  if (!rule) return undefined;
  const value = fillTitleTemplate(rule.template, session, context);
  return value && value !== session.title ? value : undefined;
}

/** Whether [template] keeps the title it is given: without `{{title}}`, a rule replaces it outright. */
export function titleTemplateKeepsTitle(template: string): boolean {
  return /\{\{\s*title\s*\}\}/.test(template);
}

export function fillTitleTemplate(template: string, session: Pick<Session, 'title' | 'createdAt'>, context: TitleRuleContext): string {
  const stamp = wallClock(session.createdAt, context.timeZone);
  const values: Record<string, string> = {
    title: session.title,
    project: context.originProject?.name ?? context.project?.name ?? '',
    date: stamp?.date ?? '',
    time: stamp?.time ?? '',
  };
  const filled = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => values[name] ?? whole);
  const line = filled.replace(/\s+/g, ' ').trim();
  return [...line].slice(0, TITLE_RULE_TEMPLATE_MAX).join('');
}

function matches(match: TitleRuleMatch, session: RuleSession, context: TitleRuleContext): boolean {
  if (match.directories?.length) {
    const paths = [context.project?.cwd, context.originProject?.cwd].filter((item): item is string => Boolean(item));
    if (!match.directories.some(directory => paths.some(path => within(path, directory)))) return false;
  }
  if (match.agents?.length && !match.agents.includes(session.backendId ?? 'cursor')) return false;
  if (match.origins?.length && !(match.origins as readonly string[]).includes(session.origin?.kind ?? 'manual')) return false;
  if (match.tags?.length && !match.tags.some(tag => session.tags.includes(tag))) return false;
  return true;
}

function within(path: string, directory: string): boolean {
  const root = directory.length > 1 ? directory.replace(/\/+$/, '') : directory;
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function wallClock(iso: string, timeZone: string | undefined): { date: string; time: string } | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}
