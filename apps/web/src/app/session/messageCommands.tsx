import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type AnimationEventHandler, type ComponentType, type CSSProperties, type Ref } from 'react';
import { useLingui } from '@lingui/react/macro';
import { PLUGIN_COMMAND_BUDGET, type CommandIcon, type CommandSelection, type LocalizedText } from '@contracts';
import { IconBookOpen, IconFileText, IconLanguages, IconListChecks, IconMessageSquareQuote, IconPuzzle, IconSearch, IconSparkles, IconVolume2, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { CopyButton } from '@/components/ui/copy-button';
import { HttpError } from '@/lib/errors';
import { localizedText, runPluginCommand, usePlugins } from '@/lib/plugins';
import { toast } from '@/lib/toast';
import { cn, errorMessage, newId } from '@/lib/utils';
import { enabledCommands, type PluginCommand } from '@/plugins/commands';
import { Markdown } from './Markdown';

// Plugin commands in an answer's more menu (docs/PLUGIN_ARCHITECTURE.md「消息菜单」): which are offered, running one on
// the answer, and the `text` it answers shown under that answer. Results live in memory only, for every conversation of
// this tab together, within `PLUGIN_COMMAND_BUDGET.keptResults`; a row scrolled away and back finds its result again.

/** The conversation a transcript shows, for commands run on its messages. Absent where its messages take no commands (a shared page, an image export). */
export const MessageCommandsContext = createContext<{ sessionId: string; openModelSettings(section: 'auxiliary' | 'quickchat'): void } | undefined>(undefined);

const ICONS: Record<CommandIcon, ComponentType<{ className?: string }>> = {
  languages: IconLanguages, sparkles: IconSparkles, 'book-open': IconBookOpen, 'file-text': IconFileText,
  'list-checks': IconListChecks, search: IconSearch, 'message-square-quote': IconMessageSquareQuote, 'volume-2': IconVolume2,
};
export const commandIcon = (name: CommandIcon | undefined) => (name && ICONS[name]) || IconPuzzle;

type Shown = { commandId: string; state: 'running' } | { commandId: string; state: 'shown'; text: string; title?: LocalizedText };

/** Insertion order is age. Keyed by conversation, command and message, so the same answer run twice shows once. */
// perf-rules: allow bounded by PLUGIN_COMMAND_BUDGET.keptResults in `put`, oldest first
const results = new Map<string, Shown>();
const listeners = new Set<() => void>();
/** Changes on every write, so a row re-reads only when something changed. */
let version = 0;
const changed = () => { version += 1; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };

function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return `${text.length}:${(value >>> 0).toString(36)}`;
}
const messageKey = (sessionId: string, text: string, runId: string | undefined) => `${sessionId}\0${runId ?? ''}\0${hash(text)}`;

function put(key: string, shown: Shown): void {
  results.delete(key);
  results.set(key, shown);
  for (const oldest of results.keys()) {
    if (results.size <= PLUGIN_COMMAND_BUDGET.keptResults) break;
    results.delete(oldest);
  }
  changed();
}
function drop(key: string): void { if (results.delete(key)) changed(); }

/** The menu items for one answer: the enabled plugins' `message` commands, each running on [text]. Empty when the answer cannot be sent. */
export function useMessageCommandItems(text: string | undefined, runId: string | undefined): Array<{ command: PluginCommand; run(): void }> {
  const { t, i18n } = useLingui();
  const scope = useContext(MessageCommandsContext);
  const descriptors = usePlugins();
  const commands = useMemo(() => enabledCommands(descriptors, i18n.locale, 'message'), [descriptors, i18n.locale]);
  const sessionId = scope?.sessionId;
  const openSettings = scope?.openModelSettings;
  const run = useCallback(async (command: PluginCommand) => {
    if (!sessionId || !text) return;
    const key = `${command.id}\0${messageKey(sessionId, text, runId)}`;
    const known = results.get(key);
    if (known) { put(key, known); return; }
    // This run's own entry: a reply is wanted only while it is still the one shown (not closed, not replaced by a rerun).
    const running: Shown = { commandId: command.id, state: 'running' };
    put(key, running);
    try {
      const result = await runPluginCommand(command.id, {
        requestId: newId(), sessionId, locale: i18n.locale,
        message: { role: 'assistant', text, ...(runId ? { runId } : {}) },
      });
      if (results.get(key) !== running) return;
      if (result.kind === 'text') put(key, { commandId: command.id, state: 'shown', text: result.text, ...(result.title ? { title: result.title } : {}) });
      else {
        drop(key);
        const message = result.kind === 'done' ? localizedText(result.message, [i18n.locale]) : undefined;
        if (message) toast.success(message);
      }
    } catch (error) {
      if (results.get(key) !== running) return;
      drop(key);
      toastFailure(error, t`选择模型`, openSettings);
    }
  }, [i18n.locale, openSettings, runId, sessionId, t, text]);
  if (!sessionId || !text?.trim() || text.length > PLUGIN_COMMAND_BUDGET.messageChars) return [];
  return commands.map((command) => ({ command, run: () => void run(command) }));
}

/** A command that failed; when its model is not chosen yet, with a button to where it is chosen. */
function toastFailure(error: unknown, chooseLabel: string, openSettings: ((section: 'auxiliary' | 'quickchat') => void) | undefined): void {
  // A use the plugin declares is chosen on the 辅助模型 page; a plain completion runs on 快速对话's model.
  const unchosen = error instanceof HttpError && error.code === 'PLUGIN_MODEL_NOT_CHOSEN' && openSettings;
  const section = unchosen && (error.details as { use?: unknown } | undefined)?.use ? 'auxiliary' : 'quickchat';
  toast.error(errorMessage(error), unchosen ? { action: { label: chooseLabel, onClick: () => openSettings(section) } } : undefined);
}

/**
 * The selection toolbar's plugin items: the enabled plugins' `selection` commands. `run` answers the `text` a command
 * gives for the shown card, or nothing when it answered otherwise or failed (said in a toast). Nothing is kept: the
 * card is gone once closed, and the plugin keeps what it wants to reuse.
 */
export function useSelectionCommands(): { commands: PluginCommand[]; run(command: PluginCommand, selection: CommandSelection): Promise<{ text: string; title?: string } | undefined> } {
  const { t, i18n } = useLingui();
  const scope = useContext(MessageCommandsContext);
  const descriptors = usePlugins();
  const commands = useMemo(() => scope ? enabledCommands(descriptors, i18n.locale, 'selection') : [], [descriptors, i18n.locale, scope]);
  const sessionId = scope?.sessionId;
  const openSettings = scope?.openModelSettings;
  const run = useCallback(async (command: PluginCommand, selection: CommandSelection) => {
    if (!sessionId || !selection.text.trim() || selection.text.length > PLUGIN_COMMAND_BUDGET.messageChars) return undefined;
    try {
      const result = await runPluginCommand(command.id, { requestId: newId(), sessionId, locale: i18n.locale, selection });
      if (result.kind === 'text') {
        const title = localizedText(result.title, [i18n.locale]);
        return { text: result.text, ...(title ? { title } : {}) };
      }
      const message = result.kind === 'done' ? localizedText(result.message, [i18n.locale]) : undefined;
      if (message) toast.success(message);
    } catch (error) {
      toastFailure(error, t`选择模型`, openSettings);
    }
    return undefined;
  }, [i18n.locale, openSettings, sessionId, t]);
  return { commands, run };
}

/** One result under an answer: the command's icon (a spinner while it runs), its title, copy and close, then the Markdown. */
export function MessageCommandBlock({ icon, title, text, onClose, className, style, ref, onAnimationEnd }: { icon: CommandIcon | undefined; title: string; /** Absent while the command runs. */ text?: string; onClose(): void; className?: string; style?: CSSProperties; ref?: Ref<HTMLElement>; onAnimationEnd?: AnimationEventHandler<HTMLElement> }) {
  const { t } = useLingui();
  const Icon = commandIcon(icon);
  return (
    <section ref={ref} style={style} onAnimationEnd={onAnimationEnd} aria-busy={text === undefined || undefined} aria-label={title} className={cn('flex flex-col rounded-xl bg-subtle px-4 py-3', className)}>
      <div className="flex items-center gap-2 text-sm">
        {text === undefined ? <Spinner className="size-4 text-fg-3" /> : <Icon className="size-4 text-fg-3" />}
        <span className="font-medium text-fg">{title}</span>
        <div className="-mr-2 ml-auto flex items-center">
          {text !== undefined && <CopyButton text={text} />}
          <Button variant="ghost" size="icon-xs" aria-label={t`关闭`} title={t`关闭`} onClick={onClose}><IconX /></Button>
        </div>
      </div>
      {text !== undefined && <div className="mt-2 min-h-0 min-w-0 overflow-y-auto"><Markdown text={text} /></div>}
    </section>
  );
}

/** What the commands run on this answer have answered, under it, newest last. */
export function MessageCommandResults({ text, runId }: { text: string; runId?: string }) {
  const { i18n } = useLingui();
  const scope = useContext(MessageCommandsContext);
  const descriptors = usePlugins();
  useSyncExternalStore(subscribe, () => version);
  if (!scope || !text) return null;
  const suffix = messageKey(scope.sessionId, text, runId);
  const shown = [...results].filter(([key]) => key.endsWith(`\0${suffix}`));
  if (!shown.length) return null;
  const commands = enabledCommands(descriptors, i18n.locale, 'message');
  return <>{shown.map(([key, entry]) => {
    const command = commands.find((item) => item.id === entry.commandId);
    const title = (entry.state === 'shown' ? localizedText(entry.title, [i18n.locale]) : undefined) ?? command?.title ?? '';
    return <MessageCommandBlock key={key} icon={command?.icon} title={title} {...(entry.state === 'shown' ? { text: entry.text } : {})} onClose={() => drop(key)} />;
  })}</>;
}
