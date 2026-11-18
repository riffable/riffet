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

type Shown =
  | { commandId: string; state: 'running'; controller: AbortController }
  | { commandId: string; state: 'shown'; text: string; title?: LocalizedText; settingsKey: string }
  | { commandId: string; state: 'failed'; error: string; chooseModel?: 'auxiliary' | 'quickchat' };

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
    const evicted = results.get(oldest);
    if (evicted?.state === 'running') evicted.controller.abort();
    results.delete(oldest);
  }
  changed();
}
function drop(key: string): void { if (results.delete(key)) changed(); }
function closeResult(key: string): void {
  const current = results.get(key);
  if (current?.state === 'running') current.controller.abort();
  drop(key);
}

function unchosenSection(error: unknown): 'auxiliary' | 'quickchat' | undefined {
  if (!(error instanceof HttpError && error.code === 'PLUGIN_MODEL_NOT_CHOSEN')) return undefined;
  return (error.details as { use?: unknown } | undefined)?.use ? 'auxiliary' : 'quickchat';
}

function commandErrorMessage(error: unknown): string {
  if (error instanceof HttpError && error.code === 'COMMAND_FAILED') {
    const raw = (typeof error.params?.message === 'string' && error.params.message ? error.params.message : error.message)
      .replace(/^[A-Za-z0-9._/-]+ failed:\s*/i, '')
      .trim();
    if (raw && raw !== 'The local service could not complete this operation') return raw;
  }
  return errorMessage(error);
}

function pluginSettingsKey(descriptors: ReturnType<typeof usePlugins>, commandId: string, locale: string): string {
  const pluginId = commandId.split('/')[0];
  const plugin = descriptors?.find((item) => item.id === pluginId);
  const values = (plugin?.settings ?? []).map((field) => `${field.key}=${String(field.value ?? '')}`).join('&');
  return `${locale}\0${values}`;
}

function executeMessageCommand(
  command: PluginCommand,
  sessionId: string,
  text: string,
  runId: string | undefined,
  locale: string,
  settingsKey: string,
): void {
  const key = `${command.id}\0${messageKey(sessionId, text, runId)}`;
  const known = results.get(key);
  if (known?.state === 'running') { put(key, known); return; }
  if (known?.state === 'shown' && known.settingsKey === settingsKey) { put(key, known); return; }
  // This run's own entry: a reply is wanted only while it is still the one shown (not closed, not replaced by a rerun).
  const controller = new AbortController();
  const running: Shown = { commandId: command.id, state: 'running', controller };
  put(key, running);
  void (async () => {
    try {
      const result = await runPluginCommand(command.id, {
        requestId: newId(), sessionId, locale,
        message: { role: 'assistant', text, ...(runId ? { runId } : {}) },
      }, controller.signal);
      if (results.get(key) !== running) return;
      if (result.kind === 'text') put(key, { commandId: command.id, state: 'shown', text: result.text, ...(result.title ? { title: result.title } : {}), settingsKey });
      else {
        drop(key);
        const message = result.kind === 'done' ? localizedText(result.message, [locale]) : undefined;
        if (message) toast.success(message);
      }
    } catch (error) {
      if (results.get(key) !== running || controller.signal.aborted) return;
      const chooseModel = unchosenSection(error);
      put(key, {
        commandId: command.id,
        state: 'failed',
        error: commandErrorMessage(error),
        ...(chooseModel ? { chooseModel } : {}),
      });
    }
  })();
}

/** The menu items for one answer: the enabled plugins' `message` commands, each running on [text]. Empty when the answer cannot be sent. */
export function useMessageCommandItems(text: string | undefined, runId: string | undefined): Array<{ command: PluginCommand; run(): void }> {
  const { i18n } = useLingui();
  const scope = useContext(MessageCommandsContext);
  const descriptors = usePlugins();
  const commands = useMemo(() => enabledCommands(descriptors, i18n.locale, 'message'), [descriptors, i18n.locale]);
  const sessionId = scope?.sessionId;
  const run = useCallback((command: PluginCommand) => {
    if (!sessionId || !text) return;
    executeMessageCommand(command, sessionId, text, runId, i18n.locale, pluginSettingsKey(descriptors, command.id, i18n.locale));
  }, [descriptors, i18n.locale, runId, sessionId, text]);
  if (!sessionId || !text?.trim() || text.length > PLUGIN_COMMAND_BUDGET.messageChars) return [];
  return commands.map((command) => ({ command, run: () => run(command) }));
}

export type SelectionCommandOutcome =
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'done' }
  | { kind: 'failed'; error: string; chooseModel?: 'auxiliary' | 'quickchat' }
  | { kind: 'aborted' };

/**
 * The selection toolbar's plugin items: the enabled plugins' `selection` commands. `run` answers the `text` a command
 * gives for the shown card, or the failure to show inside the card when it failed. Nothing is kept: the card is gone
 * once closed, and the plugin keeps what it wants to reuse.
 */
export function useSelectionCommands(): {
  commands: PluginCommand[];
  openModelSettings?: (section: 'auxiliary' | 'quickchat') => void;
  run(command: PluginCommand, selection: CommandSelection, signal?: AbortSignal): Promise<SelectionCommandOutcome>;
} {
  const { i18n } = useLingui();
  const scope = useContext(MessageCommandsContext);
  const descriptors = usePlugins();
  const commands = useMemo(() => scope ? enabledCommands(descriptors, i18n.locale, 'selection') : [], [descriptors, i18n.locale, scope]);
  const sessionId = scope?.sessionId;
  const openModelSettings = scope?.openModelSettings;
  const run = useCallback(async (command: PluginCommand, selection: CommandSelection, signal?: AbortSignal): Promise<SelectionCommandOutcome> => {
    if (!sessionId || !selection.text.trim() || selection.text.length > PLUGIN_COMMAND_BUDGET.messageChars) return { kind: 'aborted' };
    try {
      const result = await runPluginCommand(command.id, { requestId: newId(), sessionId, locale: i18n.locale, selection }, signal);
      if (signal?.aborted) return { kind: 'aborted' };
      if (result.kind === 'text') {
        const title = localizedText(result.title, [i18n.locale]);
        return { kind: 'text', text: result.text, ...(title ? { title } : {}) };
      }
      const message = result.kind === 'done' ? localizedText(result.message, [i18n.locale]) : undefined;
      if (message) toast.success(message);
      return { kind: 'done' };
    } catch (error) {
      if (signal?.aborted) return { kind: 'aborted' };
      const chooseModel = unchosenSection(error);
      return { kind: 'failed', error: commandErrorMessage(error), ...(chooseModel ? { chooseModel } : {}) };
    }
  }, [i18n.locale, sessionId]);
  return { commands, ...(openModelSettings ? { openModelSettings } : {}), run };
}

/** One result under an answer: the command's icon (a spinner while it runs), its title, copy/retry and close, then the Markdown or error. */
export function MessageCommandBlock({ icon, title, text, error, action, onRetry, onClose, className, style, ref, onAnimationEnd }: {
  icon: CommandIcon | undefined;
  title: string;
  /** Absent while the command runs or when it failed. */
  text?: string;
  /** Present when the command failed; the block stays in place so the reader can retry. */
  error?: string;
  action?: { label: string; onClick(): void };
  onRetry?: () => void;
  onClose(): void;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
  onAnimationEnd?: AnimationEventHandler<HTMLElement>;
}) {
  const { t } = useLingui();
  const Icon = commandIcon(icon);
  const running = text === undefined && error === undefined;
  return (
    <section ref={ref} style={style} onAnimationEnd={onAnimationEnd} aria-busy={running || undefined} aria-label={title} className={cn('flex flex-col rounded-xl bg-subtle px-4 py-3', className)}>
      <div className="flex items-center gap-2 text-sm">
        {running ? <Spinner className="size-4 text-fg-3" /> : <Icon className="size-4 text-fg-3" />}
        <span className="font-medium text-fg">{title}</span>
        <div className="-mr-2 ml-auto flex items-center gap-0.5">
          {text !== undefined && <CopyButton text={text} />}
          {error !== undefined && action && <Button variant="ghost" size="xs" onClick={action.onClick}>{action.label}</Button>}
          {error !== undefined && onRetry && <Button variant="ghost" size="xs" onClick={onRetry}>{t`重试`}</Button>}
          <Button variant="ghost" size="icon-xs" aria-label={t`关闭`} title={t`关闭`} onClick={onClose}><IconX /></Button>
        </div>
      </div>
      {text !== undefined && <div className="mt-2 min-h-0 min-w-0 overflow-y-auto"><Markdown text={text} /></div>}
      {error !== undefined && <p role="alert" className="mt-1.5 min-w-0 break-words text-xs text-danger">{error}</p>}
    </section>
  );
}

/** What the commands run on this answer have answered, under it, newest last. */
export function MessageCommandResults({ text, runId }: { text: string; runId?: string }) {
  const { t, i18n } = useLingui();
  const scope = useContext(MessageCommandsContext);
  const descriptors = usePlugins();
  useSyncExternalStore(subscribe, () => version);
  if (!scope || !text) return null;
  const suffix = messageKey(scope.sessionId, text, runId);
  const shown = [...results].filter(([key]) => key.endsWith(`\0${suffix}`));
  if (!shown.length) return null;
  const commands = enabledCommands(descriptors, i18n.locale, 'message');
  const openSettings = scope.openModelSettings;
  return <>{shown.map(([key, entry]) => {
    const command = commands.find((item) => item.id === entry.commandId);
    const title = (entry.state === 'shown' ? localizedText(entry.title, [i18n.locale]) : undefined) ?? command?.title ?? '';
    const chooseModel = entry.state === 'failed' ? entry.chooseModel : undefined;
    return (
      <MessageCommandBlock
        key={key}
        icon={command?.icon}
        title={title}
        {...(entry.state === 'shown' ? { text: entry.text } : {})}
        {...(entry.state === 'failed' ? {
          error: entry.error,
          ...(command ? { onRetry: () => executeMessageCommand(command, scope.sessionId, text, runId, i18n.locale, pluginSettingsKey(descriptors, command.id, i18n.locale)) } : {}),
          ...(chooseModel && openSettings ? { action: { label: t`选择模型`, onClick: () => openSettings(chooseModel) } } : {}),
        } : {})}
        onClose={() => closeResult(key)}
      />
    );
  })}</>;
}
