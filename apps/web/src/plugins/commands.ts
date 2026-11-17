import type { CommandDeclaration, CommandIcon, CommandMenu, CommandScope, PluginDescriptor, TaskParamField } from '@contracts';
import { localizedText } from '@/lib/plugins';
import { matches, type ViewFacts } from './catalog';

/** A command of an enabled plugin, ready to list. */
export interface PluginCommand {
  /** `<pluginId>/<name>`. */
  id: string;
  pluginId: string;
  pluginTitle: string;
  title: string;
  scope: CommandScope;
  params: readonly TaskParamField[];
  when: CommandDeclaration['when'];
  keybinding: string | undefined;
  icon: CommandIcon | undefined;
}

/**
 * Every command the enabled plugins declare for the palette and shortcuts, in plugin order, or with [menu] the ones
 * listed in that host menu instead: a command with menus runs on what its menu gives it, so the palette never lists it.
 * A package whose client SDK this build does not match is left out like its views.
 */
export function enabledCommands(descriptors: readonly PluginDescriptor[] | undefined, locale: string, menu?: CommandMenu): PluginCommand[] {
  const commands: PluginCommand[] = [];
  for (const descriptor of descriptors ?? []) {
    if (!descriptor.enabled || descriptor.compatibility?.web?.ok === false) continue;
    const pluginTitle = localizedText(descriptor.title, [locale]) ?? descriptor.name;
    for (const command of descriptor.declared?.commands ?? []) {
      if (menu ? !command.menus?.includes(menu) : command.menus?.length) continue;
      commands.push({
        id: command.id, pluginId: descriptor.id, pluginTitle,
        title: localizedText(command.title, [locale]) ?? command.id,
        scope: command.scope ?? 'project',
        params: command.params ?? [],
        when: command.when,
        keybinding: command.keybinding,
        icon: command.icon,
      });
    }
  }
  return commands;
}

/**
 * Whether `command` is offered now: the context its scope needs exists and its `when` holds. This
 * only decides whether to show it; the server checks both again when it runs.
 */
export function offersCommand(command: PluginCommand, facts: ViewFacts): boolean {
  if (command.scope === 'project' && !facts.hasProject) return false;
  if (command.scope === 'session' && !(facts.hasProject && facts.hasSession)) return false;
  return matches(command.when, facts);
}
