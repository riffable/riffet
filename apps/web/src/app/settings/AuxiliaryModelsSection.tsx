import { Fragment, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppSettings, AuxiliaryModelOption, AuxiliaryModelPurpose, AuxiliaryModelRef } from '@contracts';
import { IconChevronDown } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { backendLabel } from '@/lib/backends';
import { errorMessage } from '@/lib/utils';
import { AuxiliaryPreviewDialog, type PreviewPurpose } from './AuxiliaryPreviewDialog';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

const OFF = '';
const keyOf = (ref: AuxiliaryModelRef) => JSON.stringify([ref.backendId, ref.profileId, ref.model]);

type SaveProps = {
  settings: AppSettings;
  onSaved: (settings: AppSettings, patch: Partial<AppSettings>) => void;
  onError: (message: string) => void;
};

/**
 * Models for Riffet's own small jobs (session titles, handoff summaries, canvas summaries), one per purpose. Choices
 * come from gateways a provider profile already holds a key for, so nothing new is configured here.
 */
export function AuxiliaryModelsSection({ settings, onSaved, onError }: SaveProps) {
  const { t } = useLingui();
  const [options, setOptions] = useState<AuxiliaryModelOption[]>();
  const [loadError, setLoadError] = useState('');
  const [preview, setPreview] = useState<{ purpose: PreviewPurpose; model: AuxiliaryModelRef }>();
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api.auxiliaryModels(controller.signal)
      .then((result) => setOptions(result.models))
      .catch((error) => { if (!controller.signal.aborted) setLoadError(errorMessage(error, t`无法读取可用模型`)); });
    return () => controller.abort();
  }, []);

  const tryIt = (purpose: PreviewPurpose) => {
    const model = settings.auxiliaryModels?.[purpose];
    if (!model) return;
    setPreview({ purpose, model });
    setPreviewOpen(true);
  };

  const picker = { settings, onSaved, onError, options, loading: !options && !loadError };
  return <SettingsGroup>
    <SettingsRow title={t`会话标题`} description={loadError || undefined}>
      <div className="flex items-center gap-2 max-md:w-full">
        <AuxiliaryModelPicker {...picker} purpose="title" label={t`会话标题`} offLabel={t`只用 CLI 标题`} />
        <Button size="xs" variant="ghost" disabled={!settings.auxiliaryModels?.title} onClick={() => tryIt('title')}><Trans>试用</Trans></Button>
      </div>
    </SettingsRow>
    <SettingsRow title={t`交接摘要`}>
      <div className="flex items-center gap-2 max-md:w-full">
        <AuxiliaryModelPicker {...picker} purpose="handoff" label={t`交接摘要`} offLabel={t`不使用`} />
        <Button size="xs" variant="ghost" disabled={!settings.auxiliaryModels?.handoff} onClick={() => tryIt('handoff')}><Trans>试用</Trans></Button>
      </div>
    </SettingsRow>
    <SettingsRow title={t`画布摘要`}>
      <AuxiliaryModelPicker {...picker} purpose="summary" label={t`画布摘要`} offLabel={t`不使用`} />
    </SettingsRow>
    {preview && <AuxiliaryPreviewDialog open={previewOpen} purpose={preview.purpose} model={preview.model} onOpenChange={setPreviewOpen} />}
  </SettingsGroup>;
}

function AuxiliaryModelPicker({ purpose, label, offLabel, options, loading, settings, onSaved, onError }: SaveProps & {
  purpose: AuxiliaryModelPurpose;
  label: string;
  offLabel: string;
  options?: AuxiliaryModelOption[];
  loading: boolean;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const current = settings.auxiliaryModels?.[purpose];

  const select = async (key: string) => {
    if (busy || key === (current ? keyOf(current) : OFF)) return;
    const choice = options?.find((option) => keyOf(option) === key);
    const ref: AuxiliaryModelRef | null = choice ? { backendId: choice.backendId, profileId: choice.profileId, model: choice.model } : null;
    setBusy(true);
    try {
      const saved = await api.updateSettings({ auxiliaryModels: { [purpose]: ref } });
      onSaved(saved, { auxiliaryModels: saved.auxiliaryModels });
    } catch (error) { onError(errorMessage(error, t`无法保存辅助模型`)); }
    finally { setBusy(false); }
  };

  const groups = new Map<string, AuxiliaryModelOption[]>();
  for (const option of options ?? []) {
    const group = `${option.profileName} · ${backendLabel(option.backendId)}`;
    groups.set(group, [...(groups.get(group) ?? []), option]);
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        aria-busy={loading || undefined}
        disabled={busy || loading}
        className="group/model inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm text-fg-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 max-md:h-11 max-md:flex-1"
      >
        {/* Loading shows inside the trigger, so the row keeps its height when the options arrive. */}
        {loading ? <Spinner /> : <span className="min-w-0 truncate md:max-w-56">{current ? current.model : offLabel}</span>}
        <IconChevronDown className="ml-auto size-3 shrink-0 text-fg-4 transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)] group-data-[state=open]/model:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="max-h-[min(60dvh,420px)] w-[min(22rem,calc(100vw-24px))] overflow-y-auto">
        <DropdownMenuRadioGroup value={current ? keyOf(current) : OFF} onValueChange={(key) => void select(key)}>
          <DropdownMenuRadioItem value={OFF}>{offLabel}</DropdownMenuRadioItem>
          {current && !options?.some((option) => keyOf(option) === keyOf(current)) && (
            <DropdownMenuRadioItem value={keyOf(current)}><Trans>{current.model}（提供商里已不可用）</Trans></DropdownMenuRadioItem>
          )}
          {[...groups].map(([group, items]) => (
            <Fragment key={group}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{group}</DropdownMenuLabel>
              {items.map((option) => (
                <DropdownMenuRadioItem key={keyOf(option)} value={keyOf(option)} textValue={option.model}>
                  <span className="truncate font-mono text-xs">{option.model}</span>
                </DropdownMenuRadioItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
        {options && !options.length && <p className="px-2 py-2 text-xs text-fg-3"><Trans>还没有带网关的提供商。先在 Claude Code、DSH 或 Codex 下添加一个自定义提供商。</Trans></p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
