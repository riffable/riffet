import os from 'node:os';
import path from 'node:path';
import { TITLE_RULE_TEMPLATE_MAX, TITLE_RULE_VALUES_MAX, TITLE_RULES_MAX, type TitleRule, type TitleRuleMatch, type TitleRuleOrigin } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

const ORIGINS: readonly TitleRuleOrigin[] = ['manual', 'fork', 'handoff', 'attempt', 'automation', 'template', 'schedule', 'discussion', 'channel', 'assistant'];

const invalid = (message: string) => new AppError('INVALID_SETTINGS', `titleRules: ${message}`);

/**
 * `AppSettings.titleRules` as stored. A directory may be written `~/…`: it is expanded against this
 * server's home, because the rules match this server's own paths (docs/SESSION-TITLES.md §多服务器).
 */
export function validateTitleRules(raw: unknown): TitleRule[] {
  if (!Array.isArray(raw) || raw.length > TITLE_RULES_MAX) throw invalid(`must be a list of at most ${TITLE_RULES_MAX} rules`);
  const seen = new Set<string>();
  return raw.map((item, index): TitleRule => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`rule ${index} must be an object`);
    const rule = item as Record<string, unknown>;
    if (Object.keys(rule).some(key => !['id', 'match', 'template', 'scope'].includes(key))) throw invalid(`rule ${index} has an unknown field`);
    if (typeof rule.id !== 'string' || !/^[\w-]{1,64}$/.test(rule.id) || seen.has(rule.id)) throw invalid(`rule ${index} needs a unique id`);
    seen.add(rule.id);
    if (typeof rule.template !== 'string' || !rule.template.trim() || rule.template.length > TITLE_RULE_TEMPLATE_MAX || /[\0\r\n]/.test(rule.template)) throw invalid(`rule ${index} needs a one-line template of at most ${TITLE_RULE_TEMPLATE_MAX} characters`);
    if (rule.scope !== undefined && rule.scope !== 'auto' && rule.scope !== 'all') throw invalid(`rule ${index} scope must be auto or all`);
    return { id: rule.id, match: validateMatch(rule.match, index), template: rule.template.trim(), ...(rule.scope === 'all' ? { scope: 'all' as const } : {}) };
  });
}

function validateMatch(raw: unknown, index: number): TitleRuleMatch {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`rule ${index} match must be an object`);
  const match = raw as Record<string, unknown>;
  if (Object.keys(match).some(key => !['directories', 'agents', 'origins', 'tags'].includes(key))) throw invalid(`rule ${index} match has an unknown condition`);
  const result: TitleRuleMatch = {};
  const directories = strings(match.directories, index, 'directories', 4096);
  if (directories) result.directories = directories.map(value => {
    const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
    if (!path.isAbsolute(expanded)) throw invalid(`rule ${index} directory ${value} must be absolute`);
    return path.resolve(expanded);
  });
  const agents = strings(match.agents, index, 'agents', 128);
  if (agents) result.agents = agents;
  const origins = strings(match.origins, index, 'origins', 32);
  if (origins) {
    if (origins.some(origin => !(ORIGINS as readonly string[]).includes(origin))) throw invalid(`rule ${index} has an unknown origin`);
    result.origins = origins as TitleRuleOrigin[];
  }
  const tags = strings(match.tags, index, 'tags', 100);
  if (tags) result.tags = tags;
  return result;
}

function strings(raw: unknown, index: number, name: string, max: number): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > TITLE_RULE_VALUES_MAX || raw.some(value => typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value))) {
    throw invalid(`rule ${index} ${name} must be a list of at most ${TITLE_RULE_VALUES_MAX} values`);
  }
  const values = [...new Set((raw as string[]).map(value => value.trim()))];
  return values.length ? values : undefined;
}
