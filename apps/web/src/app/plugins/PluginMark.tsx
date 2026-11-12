import type { PluginDescriptor } from '@contracts';
import { IconBot, IconCpu, IconLayers, IconPuzzle, IconSquareArrowOutUpRight, IconSun, IconTerminal } from '@/components/icons';

// The first kind of contribution a plugin declares decides its mark.
const MARKS = [['agentBackends', IconBot], ['modelSources', IconCpu], ['appearance', IconSun], ['tasks', IconTerminal], ['views', IconLayers], ['sharePublisher', IconSquareArrowOutUpRight]] as const;

export function Mark({ has }: { has: (contribution: string) => boolean }) {
  const Icon = MARKS.find(([key]) => has(key))?.[1] ?? IconPuzzle;
  return <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-fg-2"><Icon className="size-5" /></span>;
}

export function PluginMark({ plugin }: { plugin: PluginDescriptor }) {
  const declared = plugin.declared as Record<string, unknown> | undefined;
  return <Mark has={key => { const value = declared?.[key]; return Array.isArray(value) ? value.length > 0 : Boolean(value); }} />;
}
