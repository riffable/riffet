import { z } from 'zod/v4';
import { ASSISTANT_QUERY_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { resolveLocalizedText, type LocalizedText } from '../../../../packages/contracts/src/plugins.js';
import { defineRead } from '../assistant-capability.js';

/** The topics enabled plugins declare in `contributes.assistantEvents`, as the 助理 reads them (docs/ASSISTANT.md §7.3). */
interface DeclaredEvent { id: string; plugin: string; title: LocalizedText; description: LocalizedText }

export const assistantEventsRead = (events: () => DeclaredEvent[]) => defineRead(
  'workbench.assistant_events',
  'List the events enabled plugins can raise, each with its topic, what it means and what its payload holds. Use a topic as the trigger {"kind":"plugin-event","topic":"…"} of delegation_create.',
  ['plugin event', 'topic', 'delegation', 'trigger', '插件事件', '委托', '触发'],
  z.strictObject({}),
  () => ({
    events: events().slice(0, ASSISTANT_QUERY_BUDGET.pageItems).map(({ id, plugin, title, description }) => ({
      topic: id, plugin, title: resolveLocalizedText(title, []) ?? id, description: resolveLocalizedText(description, []) ?? '',
    })),
    observedAt: new Date().toISOString(),
  }),
);
