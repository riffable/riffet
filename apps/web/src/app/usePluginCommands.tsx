import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { PluginCommandResult, TaskConfirmation } from '@contracts';
import { IconPuzzle } from '@/components/icons';
import { HttpError } from '@/lib/errors';
import { localizedText, runPluginCommand, usePlugins } from '@/lib/plugins';
import { isApplePlatform } from '@/lib/platform';
import type { ProjectRecord } from '@/lib/api';
import { focusTask, taskConfirmation, tasksApi, useProjectTypes } from '@/lib/tasks';
import { toast } from '@/lib/toast';
import { errorMessage, newId } from '@/lib/utils';
import { enabledCommands, offersCommand, type PluginCommand } from '@/plugins/commands';
import { TaskConfirmDialog } from '@/plugins/TaskConfirmDialog';
import { useViewCatalog } from '@/plugins/registry';
import type { PaletteAction } from './CommandPalette';
import { PluginCommandForm, type CommandArgs } from './PluginCommandForm';
import { registerKeybindings, chordOf } from './pluginKeybindings';
import { isComposingKey } from './session/composerKeyboard';
import { useHasGit } from './state/gitStatusStore';
import { useStores } from './state/stores';

/** The ids a command is sent with: only what its scope names. */
interface RunContext { projectId?: string; sessionId?: string }

const NO_CAPABILITIES: ReadonlySet<string> = new Set();
const GIT_CAPABILITIES: ReadonlySet<string> = new Set(['git']);

const REJECTION = { invalid: 'is not a usable key combination', host: 'is used by the workbench', plugin: 'is used by another plugin command' } as const;

/** A command asks for a form unless every parameter already has a value. */
const needsForm = (command: PluginCommand): boolean => command.params.some((field) => field.default === undefined);

const defaultArgs = (command: PluginCommand): CommandArgs =>
  Object.fromEntries(command.params.filter((field) => field.default !== undefined).map((field) => [field.key, field.default!]));

/**
 * The commands of enabled plugins (docs/design/plugin-system.md §4.3) for the palette and their default
 * shortcuts: which are offered now, running one and acting on its answer, and the form and the
 * confirmation a run may stop at. `dialogs` is drawn once by the workbench.
 */
export function usePluginCommands({ project, sessionId, openSession }: {
  /** `undefined` where no project's commands apply, such as a quick chat. */
  project: ProjectRecord | undefined;
  sessionId: string | undefined;
  openSession: (id: string) => void;
}): { actions: () => PaletteAction[]; dialogs: ReactNode } {
  const { i18n } = useLingui();
  const { ui, nav } = useStores();
  const descriptors = usePlugins();
  const catalog = useViewCatalog();
  const projectTypes = useProjectTypes(project?.id);
  const hasGit = useHasGit(project);
  const projectId = project?.id;
  const hasSession = Boolean(project && sessionId);

  const all = useMemo(() => enabledCommands(descriptors, i18n.locale), [descriptors, i18n.locale]);
  const offered = useMemo(
    () => all.filter((command) => offersCommand(command, { hasProject: Boolean(projectId), hasSession, projectTypes, capabilities: hasGit ? GIT_CAPABILITIES : NO_CAPABILITIES })),
    [all, projectId, hasSession, projectTypes, hasGit],
  );

  const [form, setForm] = useState<{ command: PluginCommand; context: RunContext }>();
  const [confirming, setConfirming] = useState<{ command: PluginCommand; context: RunContext; args: CommandArgs; confirmation: TaskConfirmation }>();
  /** Commands in flight, and the request id of each try that got no answer, so a retry of the same run is not run twice. */
  const running = useRef(new Set<string>());
  const attempts = useRef(new Map<string, string>());

  /** Shows what a command answered. The panel moves only while the project it was run in is still the one open. */
  const present = useCallback(async (result: PluginCommandResult, context: RunContext) => {
    const here = context.projectId === undefined || nav.get().projectId === context.projectId;
    if (result.kind === 'done') {
      const message = localizedText(result.message, [i18n.locale]);
      if (message) toast.success(message);
    } else if (result.kind === 'open') {
      if (result.sessionId) openSession(result.sessionId);
      if (!here) return;
      if (result.view) { ui.set({ panelTab: result.view }); ui.setPanelOpen(true); }
      if (result.path) ui.preview(result.path);
    } else if (result.kind === 'task') {
      const task = await tasksApi.get(result.taskId).catch(() => undefined);
      if (!task) return;
      const view = catalog.find((entry) => entry.location === 'sidebar' && entry.render?.kind === 'declarative' && entry.render.declaration.renderer?.provider === task.providerId);
      if (!here || !view) return;
      focusTask(task.id);
      ui.set({ panelTab: view.id });
      ui.setPanelOpen(true);
    }
  }, [catalog, i18n.locale, nav, openSession, ui]);

  const run = useCallback(async (command: PluginCommand, context: RunContext, args: CommandArgs, confirm?: string) => {
    if (running.current.has(command.id)) return;
    running.current.add(command.id);
    const key = JSON.stringify([command.id, context, args]);
    const requestId = attempts.current.get(key) ?? newId();
    attempts.current.set(key, requestId);
    try {
      const result = await runPluginCommand(command.id, { requestId, ...context, ...(Object.keys(args).length ? { args } : {}), ...(confirm ? { confirm } : {}) });
      attempts.current.delete(key);
      await present(result, context);
    } catch (error) {
      // An answer, even a refusal, ends the try; only a failure with no answer may have run it.
      if (error instanceof HttpError) attempts.current.delete(key);
      const confirmation = taskConfirmation(error);
      if (confirmation) setConfirming({ command, context, args, confirmation });
      else toast.error(errorMessage(error));
    } finally { running.current.delete(command.id); }
  }, [present]);

  /** Runs with the defaults, or asks first when a parameter has none. */
  const start = useCallback((command: PluginCommand) => {
    const context: RunContext = command.scope === 'global' ? {} : { ...(projectId ? { projectId } : {}), ...(command.scope === 'session' && sessionId ? { sessionId } : {}) };
    if (needsForm(command)) setForm({ command, context });
    else void run(command, context, defaultArgs(command));
  }, [projectId, sessionId, run]);

  const actions = (): PaletteAction[] => offered.map((command) => ({
    id: `plugin:${command.id}`,
    label: command.title,
    keywords: `${command.pluginTitle} ${command.id}`,
    detail: command.pluginTitle,
    icon: <IconPuzzle className="size-4 shrink-0 text-fg-3" />,
    ...(needsForm(command) ? { takesFocus: true } : {}),
    run: () => start(command),
  }));

  // Default shortcuts: judged over every enabled command, so a binding does not start or stop working with the context; it runs only while its command is offered.
  const keys = useMemo(() => registerKeybindings(all, isApplePlatform), [all]);
  useEffect(() => {
    for (const { id, keybinding, reason } of keys.rejected) console.warn(`[riffet] the shortcut ${keybinding} of ${id} ${REJECTION[reason]}, so it is not registered`);
  }, [keys]);
  useEffect(() => {
    if (!keys.chords.size) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isComposingKey(event)) return;
      const id = keys.chords.get(chordOf(event));
      const command = id ? offered.find((item) => item.id === id) : undefined;
      if (!command) return;
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      // The terminal keeps its keys; on a Mac a ⌥ or ⌃ key in a text field types or edits.
      if (target?.closest('.xterm')) return;
      if (isApplePlatform && !event.metaKey && (target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      start(command);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keys, offered, start]);

  const formRequest = useMemo(() => form && { title: form.command.title, pluginTitle: form.command.pluginTitle, params: form.command.params }, [form]);
  const dialogs = (
    <>
      <PluginCommandForm
        request={formRequest}
        onCancel={() => setForm(undefined)}
        onSubmit={(args) => { if (form) void run(form.command, form.context, args); setForm(undefined); }}
      />
      <TaskConfirmDialog
        title={confirming?.command.pluginTitle ?? ''}
        confirmation={confirming?.confirmation}
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => { if (confirming) void run(confirming.command, confirming.context, confirming.args, confirming.confirmation.fingerprint); setConfirming(undefined); }}
      />
    </>
  );
  return { actions, dialogs };
}
