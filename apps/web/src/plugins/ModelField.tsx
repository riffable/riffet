import { Trans } from '@lingui/react/macro';
import type { ModelFieldProps } from '@riffet/plugin-web';
import { Button } from '@/components/ui/button';
import { catalogParams, parseSelection, serializeSelection } from '@/lib/models';
import { cleanLabel } from '@/lib/utils';
import { ModelPicker } from '../app/session/ModelPicker';

/** A model, and its options, chosen from a list in a settings row; the plugin SDK's `ModelField`. */
export function ModelField({ value, models, fallbackIds = [], placeholder, disabled, onChange, onOpen }: ModelFieldProps) {
  const catalog = [...models];
  const choices = catalog.length ? catalog.map((item) => ({ id: item.value, label: cleanLabel(item.name) })) : fallbackIds.map((id) => ({ id, label: id }));
  const { model, params: selected } = parseSelection(value);
  const params = catalogParams(catalog, model, selected);
  const values = (list: typeof params) => Object.fromEntries(list.map((param) => [param.id, param.value]));
  return (
    <div className="flex items-center gap-1 max-md:w-full">
      {value && <Button size="xs" variant="ghost" disabled={disabled} onClick={() => onChange('')}><Trans>清除</Trans></Button>}
      <ModelPicker
        disabled={disabled}
        side="bottom"
        {...(placeholder ? { placeholder } : {})}
        className="h-8 rounded-lg border border-line-strong bg-elevated px-3 text-fg-2 max-md:min-w-0 max-md:flex-1"
        models={choices}
        value={model || undefined}
        params={params}
        onChange={(id) => onChange(serializeSelection(id, values(catalogParams(catalog, id, {}))))}
        onParamChange={(id, next) => onChange(serializeSelection(model, { ...values(params), [id]: next }))}
        {...(onOpen ? { refreshCatalog: () => onOpen() } : {})}
      />
    </div>
  );
}
