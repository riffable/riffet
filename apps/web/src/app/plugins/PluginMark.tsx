import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { PluginDescriptor } from '@contracts';
import { IconBot, IconCpu, IconFolder, IconGlobe, IconLayers, IconListChecks, IconMessageSquareText, IconPuzzle, IconServer, IconSquareArrowOutUpRight, IconSun, IconTerminal } from '@/components/icons';
import { Tip } from '@/components/ui/tooltip';
import { capabilityLabel } from './PluginGrantDialog';

// The first kind of contribution a plugin declares decides its mark.
const MARKS = [['agentBackends', IconBot], ['modelSources', IconCpu], ['appearance', IconSun], ['tasks', IconTerminal], ['views', IconLayers], ['sharePublisher', IconSquareArrowOutUpRight]] as const;

export function Mark({ has }: { has: (contribution: string) => boolean }) {
  const Icon = MARKS.find(([key]) => has(key))?.[1] ?? IconPuzzle;
  return <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-fg-2"><Icon className="size-5" /></span>;
}

const declaredHas = (plugin: PluginDescriptor) => (key: string) => { const value = (plugin.declared as Record<string, unknown> | undefined)?.[key]; return Array.isArray(value) ? value.length > 0 : Boolean(value); };

export function PluginMark({ plugin }: { plugin: PluginDescriptor }) {
  return <Mark has={declaredHas(plugin)} />;
}

export type PluginGroup = 'agents' | 'workbench' | 'services';
export const PLUGIN_GROUPS: PluginGroup[] = ['agents', 'workbench', 'services'];

/** The same three groups for an installed plugin (its static declarations, so a disabled one stays put) and a listed package (its `contributes` keys). */
export function groupOf(has: (contribution: string) => boolean, workbenchViews = has('views')): PluginGroup {
  if (has('agentBackends') || has('modelSources')) return 'agents';
  if (has('appearance') || has('tasks') || workbenchViews) return 'workbench';
  return 'services';
}
export const installedGroup = (plugin: PluginDescriptor) => groupOf(declaredHas(plugin), Boolean(plugin.declared?.views?.some(view => !view.locations.includes('settings'))));

export function useGroupTitles(): Record<PluginGroup, string> {
  const { t } = useLingui();
  return { agents: t({ message: 'Agent 与模型' }), workbench: t({ message: '工作台' }), services: t({ message: '服务与分享' }) };
}

const CAPABILITY_ICONS: Record<string, typeof IconGlobe> = { network: IconGlobe, 'process.exec': IconTerminal, 'tasks.run': IconListChecks, 'projects.read': IconFolder, 'sessions.read': IconMessageSquareText, 'models.provide': IconCpu };

/** What a package may do, one icon each, named in its tooltip; the full list is in its detail. */
export function CapabilityFacts({ capabilities, trusted, trustedLabel }: { capabilities: string[]; trusted?: boolean; trustedLabel: string }) {
  const fact = (key: string, label: string, icon: ReactNode) => <Tip key={key} label={label}><span role="img" aria-label={label} className="flex">{icon}</span></Tip>;
  return <>
    {capabilities.map(capability => { const Icon = CAPABILITY_ICONS[capability] ?? IconPuzzle; return fact(capability, capabilityLabel(capability), <Icon />); })}
    {trusted && fact('trusted', trustedLabel, <IconServer />)}
  </>;
}
