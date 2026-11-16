import { createHash } from 'node:crypto';
import type { ExtensionItem } from '../../../../packages/contracts/src/extensions.js';
import { riffetSkills, type SkillScenario } from '../prompts/index.js';
import type { ExtensionContext, ExtensionDocumentDescriptor } from './types.js';

export const RIFFET_SKILLS_REASON = 'Provided by Riffet. Updated with the server.';

type Launch = Pick<ExtensionContext, 'backendId' | 'project'>;

/** The 助理's conversations on the agent that isolates them: launched without the owner's own configuration (docs/ASSISTANT.md §4). */
function standing(ctx: Launch): boolean {
  return ctx.project?.system === 'assistant' && ctx.backendId === 'claude';
}

/** Which set of Riffet's own skills a conversation of this request context receives, if any. */
export function riffetSkillScenario(ctx: Launch): SkillScenario | undefined {
  return standing(ctx) ? 'assistant' : undefined;
}

/**
 * Whether a launch in this context reads what the scope holds. An isolated launch reads the project's
 * own files and what Riffet attaches; the owner's configuration directory (skills, plugins, hooks,
 * rules) is left out, so listing it there would offer edits that change nothing.
 */
export function scopeInEffect(ctx: Launch, scope: ExtensionItem['scope']): boolean {
  return !standing(ctx) || scope === 'project' || scope === 'riffet';
}

function id(ctx: ExtensionContext, part: string, scenario: SkillScenario, name: string): string {
  return createHash('sha256').update([ctx.backendId, ctx.profile.id, 'riffet', part, scenario, name].join('\0')).digest('hex').slice(0, 40);
}

/** The scenario's skills as read-only items whose documents are served from memory, never from disk. */
export function riffetSkillEntries(ctx: ExtensionContext): Array<{ item: ExtensionItem; document: ExtensionDocumentDescriptor }> {
  const scenario = riffetSkillScenario(ctx);
  if (!scenario) return [];
  return riffetSkills(scenario).map(skill => {
    const documentId = id(ctx, 'document', scenario, skill.name);
    const sourcePath = `riffet:${skill.name}/SKILL.md`;
    const document: ExtensionDocumentDescriptor = {
      id: documentId, path: sourcePath, editable: false, reason: RIFFET_SKILLS_REASON,
      absolutePath: '', root: '', relativePath: sourcePath, scope: 'riffet', language: 'markdown',
      applyEffect: 'Updated with the server.', content: skill.text,
    };
    const item: ExtensionItem = {
      id: id(ctx, 'item', scenario, skill.name), kind: 'skill', name: `riffet:${skill.name}`, description: skill.description,
      scope: 'riffet', sourcePath, enabled: true, runtimeState: 'unknown', readOnlyReason: RIFFET_SKILLS_REASON, documentId, actions: [],
    };
    document.itemId = item.id;
    return { item, document };
  });
}
