import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DEFAULT_QUICK_CHAT_RETENTION_DAYS, type AppSettings, type AuxiliaryModelOption, type AuxiliaryModelRef, type ModelLeaderboardRow } from '@contracts';
import { IconChevronDown } from '@/components/icons';
import { Select, Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { formatDuration, formatSpeed } from '@/lib/stats-format';
import { errorMessage } from '@/lib/utils';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

const OFF = '';
const keyOf = (ref: AuxiliaryModelRef) => JSON.stringify([ref.backendId, ref.profileId, ref.model]);
const RETENTION_DAYS = [0, 1, 3, 7, 14, 30];

type SaveProps = {
  settings: AppSettings;
  onSaved: (settings: AppSettings, patch: Partial<AppSettings>) => void;
  onError: (message: string) => void;
};

/** The default model and retention policy for quick chats. */
export function QuickChatSection({ settings, onSaved, onError }: SaveProps) {
  const { t } = useLingui();
  const [options, setOptions] = useState<AuxiliaryModelOption[]>();
  const [board, setBoard] = useState<Map<string, ModelLeaderboardRow>>();
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api.auxiliaryModels(controller.signal)
      .then((result) => setOptions(result.models))
      .catch((error) => { if (!controller.signal.aborted) setLoadError(errorMessage(error, t`无法读取可用模型`)); });
    void api.modelLeaderboard({ category: 'stream', source: 'all', days: 30 }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setBoard(new Map(result.rows.map((row) => [row.key, row]))); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const retentionDays = settings.quickChat?.retentionDays ?? DEFAULT_QUICK_CHAT_RETENTION_DAYS;
  const currentModel = settings.auxiliaryModels?.chat;
  const currentOption = options?.find((option) => keyOf(option) === (currentModel ? keyOf(currentModel) : OFF));

  const saveModel = async (key: string) => {
    if (busy || key === (currentModel ? keyOf(currentModel) : OFF)) return;
    const choice = options?.find((option) => keyOf(option) === key);
    const ref: AuxiliaryModelRef | null = choice ? { backendId: choice.backendId, profileId: choice.profileId, model: choice.model } : null;
    setBusy(true);
    try {
      const saved = await api.updateSettings({ auxiliaryModels: { chat: ref } });
      onSaved(saved, { auxiliaryModels: saved.auxiliaryModels });
    } catch (error) { onError(errorMessage(error, t`无法保存辅助模型`)); }
    finally { setBusy(false); }
  };

  const saveRetention = async (days: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await api.updateSettings({ quickChat: { retentionDays: days } });
      onSaved(saved, { quickChat: saved.quickChat });
    } catch (error) { onError(errorMessage(error, t`无法保存快速对话设置`)); }
    finally { setBusy(false); }
  };

  const retentionOptions = RETENTION_DAYS.includes(retentionDays) ? RETENTION_DAYS : [...RETENTION_DAYS, retentionDays];

  const description = loadError || (currentOption?.transport === 'cli-process' ? t`走 CLI 进程启动，较慢` : undefined);
  return <SettingsGroup note={t`置顶或有收藏的对话不会归档`}>
    <SettingsRow title={t`默认模型`} description={description}>
      <ModelPicker busy={busy} loading={!options && !loadError} current={currentModel} currentOption={currentOption} options={options} board={board} onChange={(key) => void saveModel(key)} />
    </SettingsRow>
    <SettingsRow title={t`自动归档`}>
      <Select
        label={t`自动归档`}
        className="w-40"
        value={String(retentionDays)}
        disabled={busy}
        onChange={(next) => void saveRetention(Number(next))}
        options={retentionOptions.map((days) => ({ value: String(days), label: days === 0 ? t`永不` : t`${days} 天` }))}
      />
    </SettingsRow>
  </SettingsGroup>;
}

function ModelPicker({ busy, loading, current, currentOption, options, board, onChange }: {
  busy: boolean;
  loading: boolean;
  current?: AuxiliaryModelRef;
  currentOption?: AuxiliaryModelOption;
  options?: AuxiliaryModelOption[];
  board?: Map<string, ModelLeaderboardRow>;
  onChange: (key: string) => void;
}) {
  const { t } = useLingui();
  const label = currentOption ? `${currentOption.profileName} · ${currentOption.model}` : current?.model ?? t`不设置`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`默认模型`}
        aria-busy={loading || undefined}
        disabled={busy || loading}
        className="group/model inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm text-fg-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 max-md:h-11 max-md:flex-1"
      >
        {/* Loading shows inside the trigger, so the row keeps its height when the models arrive. */}
        {loading ? <Spinner /> : <span className="min-w-0 truncate md:max-w-56">{label}</span>}
        <IconChevronDown className="ml-auto size-3 shrink-0 text-fg-4 transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)] group-data-[state=open]/model:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="max-h-[min(60dvh,420px)] w-[min(22rem,calc(100vw-24px))] overflow-y-auto">
        <DropdownMenuRadioGroup value={current ? keyOf(current) : OFF} onValueChange={onChange}>
          <DropdownMenuRadioItem value={OFF}>{t`不设置`}</DropdownMenuRadioItem>
          {current && !currentOption && (
            <DropdownMenuRadioItem value={keyOf(current)}><Trans>{current.model}（提供商里已不可用）</Trans></DropdownMenuRadioItem>
          )}
          {options?.map((option) => {
            const stats = board?.get(`${option.backendId}|${option.profileId}|${option.model}`);
            const hint = stats?.ttftMs
              ? `${formatDuration(stats.ttftMs.p50)}${stats.outputTokensPerSecond ? ` · ${formatSpeed(stats.outputTokensPerSecond.p50)}` : ''}`
              : undefined;
            return (
              <DropdownMenuRadioItem key={keyOf(option)} value={keyOf(option)} textValue={`${option.profileName} · ${option.model}`}>
                <span className="min-w-0 flex-1 truncate">{option.profileName} · {option.model}</span>
                {hint && <span className="ml-2 shrink-0 text-xs tabular-nums text-fg-3">{hint}</span>}
                {option.transport === 'cli-process' && <span className="ml-2 shrink-0 text-xs text-fg-3"><Trans>CLI · 较慢</Trans></span>}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
