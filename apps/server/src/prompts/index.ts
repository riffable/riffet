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
export const historyCompactionPrompt = () => render('history-compaction');
export const deviceObserveDescription = () => render('device-observe');
export const screenRules = (topic: 'observe' | 'steps' | 'flow' | 'errors') => render(`screen-help-${topic}`);

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

export type TaskPart = 'head' | 'description' | 'criteria' | 'previous' | 'answered' | 'comments' | 'tools' | 'answer' | 'rework';
/** One fragment of what a task sends its conversations (docs/TASK-BOARD.md §6), in `language`. */
export function taskPart(language: BriefLanguage, part: TaskPart, vars?: Record<string, string | number>): string {
  return section(`task.${language}`, part, vars);
}
