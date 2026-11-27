/**
 * The model list of one provider, plus the action that asks the provider what it serves.
 *
 * Fetching uses the values the form currently shows — including a key typed but not yet saved —
 * so adding a provider is one pass instead of save-then-return. The reply is candidates the user
 * picks from, never configuration written behind them.
 *
 * A provider that cannot be interrogated is not a dead end: the failure is shown above the rows,
 * and ids typed by hand become the list on their own.
 */
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ModelContextWindows, ModelInfo, ModelInputModalities, ModelInputModality, NativeBackendId, NativeModelApiProtocol, NativeModelSource } from '@contracts';
import { IconPlus, IconRefreshCw, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Select } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { formatTokens } from '@/lib/stats-format';
import { cleanLabel, errorMessage } from '@/lib/utils';

/** The two types DSH's own model editor offers, in the order it shows them. */
const INPUT_TYPES: ModelInputModality[] = ['text', 'image'];
/** The windows a gateway model is usually served with; anything else stored stays as its own option. */
const WINDOW_SIZES = [131_072, 200_000, 262_144, 1_048_576];

/** Windows are quoted in binary and decimal units alike: 131072 and 128000 both read 128K, 1048576 and 1000000 both 1M. */
function formatWindow(tokens: number): string {
  for (const [size, unit] of [[1_048_576, 'M'], [1_000_000, 'M'], [1_000, 'K'], [1_024, 'K']] as const) {
    if (tokens >= size && tokens % size === 0) return `${tokens / size}${unit}`;
  }
  return formatTokens(tokens);
}

export function ProviderModelList({ backendId, profileId, apiEndpoint, apiKey, clearKey, modelSource, apiProtocol, probe: canProbe = true, catalog, value, onChange, inputs, onInputsChange, windows, savedWindows, onWindowsChange, disabled }: {
  backendId: NativeBackendId;
  profileId?: string;
  /** Empty when the provider uses the CLI's own login, which has no endpoint to interrogate. */
  apiEndpoint: string;
  apiKey: string;
  clearKey?: boolean;
  /** A named source answers for itself, so it can be interrogated with no address typed. */
  modelSource?: NativeModelSource;
  apiProtocol?: NativeModelApiProtocol;
  /** What the backend reports for the saved settings; the starting point before any fetch. */
  catalog: ModelInfo[];
  /** `null` means every model, including ones the provider adds later. */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  /** Declared input types per model id; only a backend that consumes them passes this in. */
  inputs?: ModelInputModalities;
  onInputsChange?: (next: ModelInputModalities) => void;
  /** Declared context windows per model id; only a backend that consumes them passes this in. */
  windows?: ModelContextWindows;
  /** The saved declarations, which the saved catalog already reports in place of the gateway's figure. */
  savedWindows?: ModelContextWindows;
  onWindowsChange?: (next: ModelContextWindows) => void;
  disabled?: boolean;
  /** Whether the address can be asked for its models before a save; `false` for a gateway that has no model listing. */
  probe?: boolean;
}) {
  const { t } = useLingui();
  const INPUT_LABELS: Record<ModelInputModality, string> = { text: t`文本`, image: t({ message: '图片', context: 'settings-image-modality' }) };
  const [fetched, setFetched] = useState<ModelInfo[]>();
  const [probing, setProbing] = useState(false);
  const [failure, setFailure] = useState('');
  const [manual, setManual] = useState('');
  const [filter, setFilter] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    request.current?.abort();
    setFetched(undefined);
    setFailure('');
    setProbing(false);
    return () => request.current?.abort();
  }, [backendId, profileId, apiEndpoint, apiKey, clearKey, modelSource, apiProtocol, catalog]);

  const listed = fetched ?? catalog;
  const known = new Map(listed.map((model) => [model.value, model]));
  // Ids the user typed outlive any catalog, so they stay on the list even when a fetch replaces it.
  const candidates = [...listed, ...(value ?? []).filter((id) => !known.has(id)).map((id) => ({ value: id, name: id, configOptions: [] }))];
  const query = filter.trim().toLowerCase();
  const visible = query ? candidates.filter((model) => `${model.name} ${model.value}`.toLowerCase().includes(query)) : candidates;

  const isOn = (id: string) => value === null || value.includes(id);
  const toggle = (id: string) => {
    const base = value ?? candidates.map((model) => model.value);
    onChange(base.includes(id) ? base.filter((item) => item !== id) : [...base, id]);
  };
  const add = () => {
    const id = manual.trim();
    if (!id) return;
    const base = value ?? candidates.map((model) => model.value);
    if (!base.includes(id)) onChange([...base, id]);
    setManual('');
  };

  // Declaring types only reaches DSH through the profile's own catalog, which Riffet writes for a
  // profile that lists its ids from an endpoint. Without one, DSH's built-in catalog already knows
  // the model, and a control that quietly did nothing would be worse than no control.
  const declaring = Boolean(onInputsChange) && Boolean(apiEndpoint.trim());
  const inputsOf = (id: string): ModelInputModality[] => inputs?.[id] ?? ['text'];
  const toggleInput = (id: string, modality: ModelInputModality) => {
    if (!onInputsChange) return;
    const current = inputsOf(id);
    const next = current.includes(modality) ? current.filter((item) => item !== modality) : [...current, modality];
    // A model that accepts nothing is not a model; the last box stays checked.
    if (!next.length) return;
    const wanted = INPUT_TYPES.filter((item) => next.includes(item));
    onInputsChange({ ...(inputs ?? {}), [id]: wanted });
  };

  // A window only matters for a gateway model; the CLI's own login already knows its models.
  const sizing = Boolean(onWindowsChange) && Boolean(apiEndpoint.trim() || modelSource);
  const setWindow = (id: string, tokens: number | undefined) => {
    if (!onWindowsChange) return;
    const { [id]: _previous, ...rest } = windows ?? {};
    onWindowsChange(tokens ? { ...rest, [id]: tokens } : rest);
  };
  const windowChoices = (id: string) => [...new Set([...WINDOW_SIZES, savedWindows?.[id] ?? 0, windows?.[id] ?? 0])].filter(Boolean).sort((x, y) => x - y);
  // A fetched list is the gateway's own answer; the saved catalog carries the saved declaration instead.
  const defaultWindow = (id: string) => {
    if (!fetched && savedWindows?.[id] !== undefined) return t`默认`;
    const reported = known.get(id)?.contextWindow;
    const size = reported ? formatWindow(reported) : t`未声明`;
    return t`默认（${size}）`;
  };

  const probe = async () => {
    if (!apiEndpoint.trim() && !modelSource) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setProbing(true);
    setFailure('');
    try {
      const result = await api.probeBackendModels(backendId, {
        ...(apiEndpoint.trim() ? { apiEndpoint: apiEndpoint.trim() } : {}),
        ...(apiKey || clearKey ? { apiKey } : {}),
        ...(modelSource ? { modelSource } : {}),
        ...(apiProtocol ? { apiProtocol } : {}),
        ...(profileId ? { profileId } : {}),
      }, controller.signal);
      if (controller.signal.aborted) return;
      setFetched(result.models);
      if (!result.models.length) setFailure(t`这个地址没有返回任何模型，可以在下方手动填写模型 ID。`);
    } catch (error) { if (!controller.signal.aborted) setFailure(errorMessage(error, t`读取失败，可以在下方手动填写模型 ID。`)); }
    finally { if (!controller.signal.aborted) setProbing(false); }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {canProbe && (apiEndpoint.trim() || modelSource) && (
          <Button size="xs" variant="secondary" disabled={disabled} onClick={() => void probe()} busy={probing}><IconRefreshCw /><Trans>获取模型列表</Trans></Button>
        )}
        <span className="text-xs text-fg-3">{value === null ? t`全部 ${candidates.length} 个` : t`已选 ${value.length} / ${candidates.length} 个`}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="ghost" disabled={disabled || value === null} onClick={() => onChange(null)}><Trans>全选</Trans></Button>
          <Button size="xs" variant="ghost" disabled={disabled || value?.length === 0} onClick={() => onChange([])}><Trans>全不选</Trans></Button>
        </div>
      </div>
      {failure && <p className="rounded-lg bg-warning-soft px-2.5 py-1.5 text-xs text-warning">{failure}</p>}
      {candidates.length > 8 && (
        <Input aria-label={t`筛选模型`} className="h-8 max-md:h-11" value={filter} disabled={disabled} placeholder={t({ message: '筛选', context: 'settings-model-filter' })} onChange={(event) => setFilter(event.target.value)} />
      )}
      {declaring && backendId === 'dsh' && (
        <p className="text-xs text-fg-3"><Trans>网关模型不在 DSH 目录时会按纯文本处理；勾选「图片」才能收到图。</Trans></p>
      )}
      <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
        {visible.length === 0
          ? <p className="px-3 py-4 text-xs text-fg-3">{candidates.length === 0 ? <Trans>还没有模型。拉取或在下方手动添加。</Trans> : <Trans>没有匹配的模型。</Trans>}</p>
          : visible.map((model) => (
            <div key={model.value} className="[&:not(:last-child)]:edge-b hover:bg-hover">
              <div className="flex items-center gap-3 px-3 py-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <Checkbox checked={isOn(model.value)} disabled={disabled} onCheckedChange={() => toggle(model.value)} />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{cleanLabel(model.name)}</span>
                  {model.name !== model.value && <span className="shrink-0 truncate font-mono text-2xs text-fg-3">{model.value}</span>}
                </label>
                {!known.has(model.value) && (
                  <Button size="icon-xs" variant="ghost" aria-label={t`移除 ${model.value}`} disabled={disabled} onClick={() => onChange((value ?? []).filter((item) => item !== model.value))}><IconTrash2 /></Button>
                )}
              </div>
              {declaring && isOn(model.value) && (
                <div className="flex items-center gap-3 pb-2 pl-10 pr-3">
                  <span className="text-2xs text-fg-3"><Trans>输入类型</Trans></span>
                  {INPUT_TYPES.map((modality) => {
                    const on = inputsOf(model.value).includes(modality);
                    return (
                      <label key={modality} className="flex cursor-pointer items-center gap-1.5 text-xs text-fg-2">
                        <Checkbox
                          checked={on}
                          // The backend reads a missing entry as text-only, so the last box must stay on.
                          disabled={disabled || (on && inputsOf(model.value).length === 1)}
                          onCheckedChange={() => toggleInput(model.value, modality)}
                        />
                        {INPUT_LABELS[modality]}
                      </label>
                    );
                  })}
                </div>
              )}
              {sizing && isOn(model.value) && (
                <div className="flex items-center gap-3 pb-2 pl-10 pr-3">
                  <span className="text-2xs text-fg-3"><Trans>上下文长度</Trans></span>
                  <Select
                    label={t`${model.value} 上下文长度`}
                    className="h-7 w-36 text-xs"
                    value={String(windows?.[model.value] ?? '')}
                    disabled={disabled}
                    onChange={(next) => setWindow(model.value, Number(next) || undefined)}
                    // A stored value outside the presets stays selectable, so saving never rewrites it.
                    options={[
                      { value: '', label: defaultWindow(model.value) },
                      ...windowChoices(model.value).map((tokens) => ({ value: String(tokens), label: formatWindow(tokens) })),
                    ]}
                  />
                </div>
              )}
            </div>
          ))}
      </div>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); add(); }}>
        <Input aria-label={t`手动添加模型 ID`} className="h-8 flex-1 font-mono max-md:h-11" value={manual} disabled={disabled} placeholder={t`手动添加模型 ID`} onChange={(event) => setManual(event.target.value)} />
        <Button type="submit" size="sm" variant="secondary" disabled={disabled || !manual.trim()}><IconPlus /><Trans>添加</Trans></Button>
      </form>
    </div>
  );
}
