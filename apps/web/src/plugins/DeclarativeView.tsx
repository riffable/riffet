import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { LocalizedText, PluginCommandResult, TaskConfirmation, TaskParamField } from '@contracts';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch } from '@/components/ui/controls';
import { localizedText, pluginTitle, runPluginCommand, usePlugins } from '@/lib/plugins';
import { errorMessage } from '@/lib/utils';
import { focusTask, taskConfirmation, tasksApi } from '@/lib/tasks';
import { useOpenProjectFile } from './projectFileOpener';
import { TaskConfirmDialog } from './TaskConfirmDialog';
import { useViewCatalog } from './registry';
import { useStores } from '../app/state/stores';
import type { DeclarativeViewProps } from './catalog';

const initial = (field: TaskParamField): string | number | boolean => field.default ?? (field.kind === 'boolean' ? false : field.kind === 'choice' ? field.options?.[0] ?? '' : '');

/** Declarative views reuse the workbench's controls and command protocol on every client. */
export function DeclarativeView({ declaration, context }: DeclarativeViewProps) {
  const { i18n } = useLingui();
  const { handlers, ui, lists, nav } = useStores();
  const openFile = useOpenProjectFile();
  const catalog = useViewCatalog();
  const plugins = usePlugins();
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState<{ command: string; args?: Record<string, string | number | boolean>; confirmation: TaskConfirmation }>();
  const renderer = declaration.renderer;
  const text = (value?: LocalizedText) => localizedText(value, [i18n.locale]) ?? '';
  const handle = async (result: PluginCommandResult) => {
    if (result.kind === 'done') setMessage(text(result.message));
    else if (result.kind === 'open') {
      if (result.sessionId) { const session = lists.get().sessions.find(item => item.id === result.sessionId); if (session) handlers.selectSession(session); }
      if (result.view) { ui.set({ panelTab: result.view }); ui.setPanelOpen(true); }
      if (result.path) openFile(result.path);
    } else if (result.kind === 'task') {
      const task = await tasksApi.get(result.taskId, context.signal);
      if (context.signal.aborted || nav.get().projectId !== task.projectId) return;
      const view = catalog.find(entry => entry.location === 'sidebar' && entry.render?.kind === 'declarative' && entry.render.declaration.renderer?.provider === task.providerId);
      if (view) { focusTask(task.id); ui.set({ panelTab: view.id }); ui.setPanelOpen(true); }
    }
  };
  const execute = async (command: string, args?: Record<string, string | number | boolean>, confirm?: string) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await runPluginCommand(command, { requestId: crypto.randomUUID(), projectId: context.projectId, sessionId: context.sessionId, args, ...(confirm ? { confirm } : {}) }, context.signal);
      if (!context.signal.aborted) await handle(result);
    } catch (error) { if (!context.signal.aborted) { const confirmation = taskConfirmation(error); if (confirmation) setConfirming({ command, args, confirmation }); else setMessage(errorMessage(error)); } }
    finally { if (!context.signal.aborted) setBusy(false); }
  };
  if (!renderer || renderer.kind === 'tasks') return null;
  return <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
    <TaskConfirmDialog title={pluginTitle(plugins, declaration.id.split('/')[0]!, [i18n.locale])} confirmation={confirming?.confirmation} onCancel={() => setConfirming(undefined)} onConfirm={() => { if (confirming) { const pending = confirming; setConfirming(undefined); void execute(pending.command, pending.args, pending.confirmation.fingerprint); } }} />
    {renderer.kind === 'list' && <ul className="flex flex-col divide-y divide-line">{renderer.items.map(item => <li key={item.id} className="py-2">
      {item.command ? <Button variant="quiet" className="w-full justify-start" disabled={busy} onClick={() => void execute(item.command!, item.args)}>{text(item.title)}</Button> : <p className="text-sm text-fg">{text(item.title)}</p>}
      {item.description && <p className="text-xs text-fg-3">{text(item.description)}</p>}
    </li>)}</ul>}
    {renderer.kind === 'detail' && <><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">{renderer.fields.map((field, index) => <div key={index} className="contents"><dt className="text-fg-3">{text(field.label)}</dt><dd className="break-words text-fg">{text(field.value)}</dd></div>)}</dl><div className="flex flex-wrap gap-2">{renderer.actions?.map(action => <Button key={action.id} size="sm" variant="secondary" disabled={busy} onClick={() => void execute(action.command, action.args)}>{text(action.title)}</Button>)}</div></>}
    {renderer.kind === 'form' && <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); const args = Object.fromEntries((renderer.fields ?? []).map(field => [field.key, values[field.key] ?? initial(field)]).filter(([, value]) => value !== '')); void execute(renderer.command, args); }}>
      {(renderer.fields ?? []).map(field => field.kind === 'boolean' ? <label key={field.key} className="flex items-center justify-between gap-3 text-sm">{text(field.label)}<Switch checked={(values[field.key] ?? initial(field)) === true} onCheckedChange={value => setValues(current => ({ ...current, [field.key]: value }))} /></label> : <Field key={field.key} label={text(field.label)}>{field.kind === 'choice' ? <Select label={text(field.label)} value={String(values[field.key] ?? initial(field))} onChange={next => setValues(current => ({ ...current, [field.key]: next }))} options={(field.options ?? []).map(option => ({ value: option, label: option }))} /> : <Input required={field.required} value={String(values[field.key] ?? initial(field))} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} />}</Field>)}
      <Button type="submit" className="self-start" size="sm" disabled={busy}>{renderer.submit ? text(renderer.submit) : <Trans>运行</Trans>}</Button>
    </form>}
    {message && <p className="break-words text-sm text-fg-3" role="status">{message}</p>}
  </div>;
}
