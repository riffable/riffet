// The host half of the canvas's fold: how a tool call reads and how an edit diffs, as the web host
// builds it in `apps/web/src/plugins/host.ts`, from the same modules.
import type { FoldContext } from '../../../../plugins/riffet/canvas/web/detail';
import type { Messages } from '../../../../plugins/riffet/canvas/web/messages';
import { timelineItem } from '../../../web/src/sync/rows';
import { stripRoot, toolDiffStats, toolView } from '../../../web/src/app/session/toolView';
import { lineDiff } from '../../../web/src/app/session/lineDiff';

/** Marks an image file the host loads by path; the layout hands the path on and never builds a URL. */
export const MEDIA_PREFIX = 'media:';

export function foldContext(m: Messages): FoldContext {
  return {
    timeline: {
      toolCall: (row, id, root) => {
        const item = timelineItem(row, id);
        if (!item) return undefined;
        const view = toolView(item.event, root);
        const data = item.event.data as Record<string, unknown>;
        const rawInput = typeof data.rawInput === 'object' && data.rawInput ? data.rawInput as Record<string, unknown> : undefined;
        const toolName = typeof data.toolName === 'string' ? data.toolName : typeof data.name === 'string' ? data.name : undefined;
        const diff = ['edit', 'delete', 'move'].includes(view.kind) ? toolDiffStats(view) : undefined;
        return {
          id: view.id, title: view.title, kind: view.kind, status: view.status, locations: view.locations, contents: view.contents,
          ...(view.command ? { command: view.command } : {}), ...(rawInput ? { rawInput } : {}), ...(toolName ? { toolName } : {}),
          ...(diff ? { diff: { added: diff.added, removed: diff.removed } } : {}),
        } as never;
      },
      relativePath: stripRoot,
      lineDiff: (before, after, context) => lineDiff(before, after, context) as never,
    } as FoldContext['timeline'],
    media: (_id, path) => `${MEDIA_PREFIX}${path}`,
    words: { think: m.think, plan: m.plan, subagent: m.subagent, backgroundTask: m.backgroundTask, toolCall: m.toolCall },
  };
}
