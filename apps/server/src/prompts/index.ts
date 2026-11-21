import { PROMPT_SOURCES } from './prompts.generated.js';

/**
 * Every model-facing prompt is a Markdown file beside this one, rendered here. Text from the user
 * or a transcript goes in as a variable, never into the template by the caller. A placeholder
 * without a value, or a value without a placeholder, is a bug and throws.
 */
export type PromptName = keyof typeof PROMPT_SOURCES;

/** Fills `{{name}}` in `template`. */
export function fillTemplate(template: string, vars: Record<string, string | number> = {}, label = 'prompt'): string {
  const used = new Set<string>();
  const text = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`${label}: placeholder {{${key}}} has no value`);
    used.add(key);
    return String(vars[key]);
  });
  const extra = Object.keys(vars).filter(key => !used.has(key));
  if (extra.length) throw new Error(`${label}: unused variables ${extra.join(', ')}`);
  return text;
}

function render(name: PromptName, vars?: Record<string, string | number>): string { return fillTemplate(PROMPT_SOURCES[name], vars, name); }

export const titlePrompt = () => render('title');
export const turnSummaryPrompt = () => render('turn-summary');
export const handoffSummaryPrompt = () => render('handoff-summary');
export const quickChatSystemPrompt = () => render('quick-chat-system');
export const assistantInstructions = () => render('assistant');
export const assistantSystemPrompt = () => render('assistant-system');
export const historyCompactionPrompt = () => render('history-compaction');
/** The first message of one of the 助理's background runs (docs/ASSISTANT.md §7); every value is filled by the server. */
/** The first message of a task's 核验 (docs/TASK-BOARD.md §6.1). */
export const taskVerifyBrief = (vars: Record<string, string | number>) => render('task-verify', vars);
export const assistantRunBrief = (job: 'supervise' | 'consolidate' | 'delegation', vars: Record<string, string | number>) => render(`assistant-run-${job}`, vars);
/** A file of one of Riffet's capability packs for the 助理 (`pack.<id>.<part>.md`). */
export const assistantPackFile = (name: Extract<PromptName, `pack.${string}`>) => render(name);
export const deviceObserveDescription = () => render('device-observe');
export const screenRules = (topic: 'observe' | 'steps' | 'flow' | 'errors') => render(`screen-help-${topic}`);

/** Where a set of Riffet's own skills applies; each conversation gets the set of its scenario. */
export type SkillScenario = 'assistant';
/** One skill Riffet ships: `text` is the whole `SKILL.md`, front matter included. */
export interface RiffetSkill { name: string; description: string; text: string }

/**
 * The skills Riffet itself gives the conversations of `scenario`, by name. Each is a prompt file named
 * `skill.<scenario>.<name>.md` whose front matter carries the name and the description the model reads
 * to decide when to load it.
 */
export function riffetSkills(scenario: SkillScenario): RiffetSkill[] {
  const prefix = `skill.${scenario}.`;
  return (Object.keys(PROMPT_SOURCES) as PromptName[]).filter(key => key.startsWith(prefix)).sort().map(key => {
    const text = PROMPT_SOURCES[key];
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim() ?? '';
    const name = field('name');
    if (name !== key.slice(prefix.length) || !field('description')) throw new Error(`${key}: front matter needs name "${key.slice(prefix.length)}" and a description`);
    return { name, description: field('description'), text: `${text}\n` };
  });
}

export type BriefLanguage = 'zh' | 'en';
export type BriefPart = 'head' | 'turn' | 'continues' | 'actions' | 'replies' | 'earlier' | 'changed' | 'transcript' | 'transcriptOmitted' | 'empty';

const sectioned = new Map<PromptName, Map<string, string>>();
/** A prompt file split at its `<!-- name -->` markers. */
function sections(name: PromptName): Map<string, string> {
  let parts = sectioned.get(name);
  if (!parts) {
    parts = new Map();
    for (const [, part, body] of PROMPT_SOURCES[name].matchAll(/^<!-- (\w+) -->\n([\s\S]*?)(?=^<!-- \w+ -->$|$(?![\s\S]))/gm)) parts.set(part!, body!.replace(/\n$/, ''));
    sectioned.set(name, parts);
  }
  return parts;
}
function section(name: PromptName, part: string, vars?: Record<string, string | number>): string {
  const template = sections(name).get(part);
  if (template === undefined) throw new Error(`${name}: no section ${part}`);
  return fillTemplate(template, vars, `${name}#${part}`);
}

/** One fragment of the context a continuing conversation starts from, in `language`. */
export function briefPart(language: BriefLanguage, part: BriefPart, vars?: Record<string, string | number>): string {
  return section(`brief.${language}`, part, vars);
}

export type TaskPart = 'head' | 'description' | 'criteria' | 'prerequisites' | 'previous' | 'answered' | 'comments' | 'tools' | 'answer' | 'rework';
/** One fragment of what a task sends its conversations (docs/TASK-BOARD.md §6), in `language`. */
export function taskPart(language: BriefLanguage, part: TaskPart, vars?: Record<string, string | number>): string {
  return section(`task.${language}`, part, vars);
}
