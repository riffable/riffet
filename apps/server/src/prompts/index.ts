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
export const historyCompactionPrompt = () => render('history-compaction');
export const deviceObserveDescription = () => render('device-observe');
export const screenRules = (topic: 'observe' | 'steps' | 'flow' | 'errors') => render(`screen-help-${topic}`);

export type BriefLanguage = 'zh' | 'en';
export type BriefPart = 'head' | 'turn' | 'continues' | 'actions' | 'replies' | 'earlier' | 'changed' | 'transcript' | 'transcriptOmitted' | 'empty';

const briefSections = new Map<BriefLanguage, Map<string, string>>();
function sections(language: BriefLanguage): Map<string, string> {
  let parts = briefSections.get(language);
  if (!parts) {
    parts = new Map();
    const source = PROMPT_SOURCES[`brief.${language}`];
    for (const [, name, body] of source.matchAll(/^<!-- (\w+) -->\n([\s\S]*?)(?=^<!-- \w+ -->$|$(?![\s\S]))/gm)) parts.set(name!, body!.replace(/\n$/, ''));
    briefSections.set(language, parts);
  }
  return parts;
}

/** One fragment of the context a continuing conversation starts from, in `language`. */
export function briefPart(language: BriefLanguage, part: BriefPart, vars?: Record<string, string | number>): string {
  const template = sections(language).get(part);
  if (template === undefined) throw new Error(`brief.${language}: no section ${part}`);
  return fillTemplate(template, vars, `brief.${language}#${part}`);
}
