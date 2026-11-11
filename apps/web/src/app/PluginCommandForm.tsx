import { useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { TaskParamField } from '@contracts';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { localizedText } from '@/lib/plugins';

export type CommandArgs = Record<string, string | number | boolean>;

/** The value a field starts with: its default, else nothing for text, off for a switch, the first option for a choice. */
const initial = (field: TaskParamField): string | number | boolean =>
  field.default ?? (field.kind === 'boolean' ? false : field.kind === 'choice' ? field.options?.[0] ?? '' : '');

/** The arguments that carry a value: a blank optional text is left out. */
function argsOf(params: readonly TaskParamField[], values: Record<string, string | number | boolean>): CommandArgs {
  const args: CommandArgs = {};
  for (const field of params) {
    const value = values[field.key] ?? initial(field);
    if (value !== '') args[field.key] = value;
  }
  return args;
}

/** What a command asks before it runs, one field per parameter, filled with the defaults. */
export function PluginCommandForm({ request, onSubmit, onCancel }: {
  /** Open while there is one. */
  request: { title: string; pluginTitle: string; params: readonly TaskParamField[] } | undefined;
  onSubmit: (args: CommandArgs) => void;
  onCancel: () => void;
}) {
  const { i18n } = useLingui();
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  // The content stays through the closing animation after `request` is cleared, and each opening starts from the defaults.
  const last = useRef(request);
  if (request && request !== last.current) setValues({});
  if (request) last.current = request;
  const shown = request ?? last.current;
  const params = shown?.params ?? [];
  const label = (field: TaskParamField) => localizedText(field.label, [i18n.locale]) ?? field.key;
  const value = (field: TaskParamField) => values[field.key] ?? initial(field);
  const missing = params.some((field) => field.required && field.kind === 'text' && String(value(field)).trim() === '');
  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent mobileSheet className="max-w-sm">
        <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); if (!missing) onSubmit(argsOf(params, values)); }}>
          <DialogHeader>
            <DialogTitle>{shown?.title}</DialogTitle>
            <DialogDescription>{shown?.pluginTitle}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 pt-1">
            {params.map((field) => field.kind === 'boolean'
              ? (
                <label key={field.key} className="flex items-center justify-between gap-3 text-sm font-medium text-fg">
                  {label(field)}
                  <Switch checked={value(field) === true} onCheckedChange={(checked) => setValues((current) => ({ ...current, [field.key]: checked }))} />
                </label>
              )
              : (
                <Field key={field.key} label={label(field)}>
                  {field.kind === 'choice'
                    ? <Select value={String(value(field))} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}>
                      {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                    </Select>
                    : <Input autoFocus={field === params.find((item) => item.kind === 'text')} value={String(value(field))} required={field.required === true} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />}
                </Field>
              ))}
          </DialogBody>
          <DialogFooter>
            <Button type="button" size="sm" variant="secondary" onClick={onCancel}><Trans>取消</Trans></Button>
            <Button type="submit" size="sm" variant="primary" disabled={missing}><Trans>运行</Trans></Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
