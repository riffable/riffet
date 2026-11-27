import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { parseSelection, type AppSettings, type AppSettingsUpdate, type AuxiliaryModelOption, type AuxiliaryModelRef, type ModelLeaderboardCategory, type ModelLeaderboardRow, type NativeBackendCatalogEntry, type NativeBackendId } from '@contracts';
import { IconGauge, IconInfoOutline } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { localizedText, usePlugins } from '@/lib/plugins';
import { formatDuration, formatSpeed } from '@/lib/stats-format';
import { errorMessage } from '@/lib/utils';
import { useAgentModelChoice } from '../session/agentModelChoice';
import { ModelPicker } from '../session/ModelPicker';
import { useCatalog } from '../state/stores';
import { AuxiliaryInspectDialog } from './AuxiliaryInspectDialog';
import { AuxiliaryPreviewDialog, type PreviewPurpose } from './AuxiliaryPreviewDialog';
import { ModelProbeDialog } from './ModelProbeDialog';
import { SettingsGroup, SettingsLinkRow, SettingsRow } from './SettingsLayout';

const AUXILIARY_BACKENDS = new Set<NativeBackendId>(['claude', 'dsh', 'codex']);

type SaveProps = {
  settings: AppSettings;
  onSaved: (settings: AppSettings, patch: Partial<AppSettings>) => void;
  onError: (message: string) => void;
  /** Opens 行为 › 会话标题, where rules change how the titles this model writes are shown. */
  onOpenTitleRules?: () => void;
};

/**
 * Models for Riffet's own small jobs (session titles, handoff summaries, canvas summaries), one per purpose, and for the
 * jobs enabled plugins declare (`modelUses`, docs/PLUGIN_ARCHITECTURE.md「模型用途」). Reuses the composer's grouped
 * Agent -> Provider -> Model picker over the backends and providers eligible for auxiliary calls.
 */
export function AuxiliaryModelsSection({ settings, onSaved, onError, onOpenTitleRules }: SaveProps) {
  const { t, i18n } = useLingui();
  const plugins = usePlugins();
  const catalogBackends = useCatalog((state) => state.backends);
  const uses = (plugins ?? []).filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.declared?.modelUses ?? []);
  const [options, setOptions] = useState<AuxiliaryModelOption[]>();
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ purpose: PreviewPurpose; model: AuxiliaryModelRef }>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [probeOpen, setProbeOpen] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [probeTick, setProbeTick] = useState(0);
  const [boards, setBoards] = useState<Partial<Record<ModelLeaderboardCategory, Map<string, ModelLeaderboardRow>>>>({});

  useEffect(() => {
    const controller = new AbortController();
    void api.auxiliaryModels(controller.signal)
      .then((result) => setOptions(result.models))
      .catch((error) => { if (!controller.signal.aborted) setLoadError(errorMessage(error, t`无法读取可用模型`)); });
    return () => controller.abort();
  }, []);

  const loadBoards = useCallback((signal?: AbortSignal) => {
    void Promise.all(['short', 'stream', 'long'].map(async (category) => {
      const res = await api.modelLeaderboard({ category: category as ModelLeaderboardCategory, source: 'all', days: 30 }, signal);
      return [category, new Map(res.rows.map((row) => [row.key, row]))] as const;
    })).then((entries) => {
      if (!signal?.aborted) setBoards(Object.fromEntries(entries));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadBoards(controller.signal);
    return () => controller.abort();
  }, [loadBoards, probeTick]);

  const transportByProfile = useMemo(() => {
    const map = new Map<string, AuxiliaryModelOption['transport']>();
    for (const option of options ?? []) {
      const key = `${option.backendId}|${option.profileId}`;
      if (!map.has(key) && option.transport) map.set(key, option.transport);
    }
    return map;
  }, [options]);

  const eligibleBackends = useMemo(() => {
    const keys = options ? new Set(options.map((option) => `${option.backendId}|${option.profileId}`)) : undefined;
    return catalogBackends.flatMap((entry) => {
      if (!AUXILIARY_BACKENDS.has(entry.backendId)) return [];
      const profiles = (keys ? entry.profiles.filter((profile) => keys.has(`${entry.backendId}|${profile.id}`)) : entry.profiles)
        .map((profile) => transportByProfile.get(`${entry.backendId}|${profile.id}`) === 'cli-process'
          ? { ...profile, name: `${profile.name} (${t`CLI · 较慢`})` }
          : profile);
      return profiles.length ? [{ ...entry, profiles }] : [];
    });
  }, [catalogBackends, options, t, transportByProfile]);

  const slowNote = (ref: AuxiliaryModelRef | undefined) =>
    ref && transportByProfile.get(`${ref.backendId}|${ref.profileId}`) === 'cli-process' ? t`走 CLI 进程启动，较慢` : undefined;

  const speedHint = (ref: AuxiliaryModelRef | undefined, category: ModelLeaderboardCategory, trigger?: string): string | undefined => {
    const parts: string[] = [];
    if (trigger) parts.push(trigger);
    if (ref) {
      const slow = slowNote(ref);
      const row = boards[category]?.get(`${ref.backendId}|${ref.profileId}|${ref.model}`);
      if (row && row.samples > 0) {
        if (category === 'short') {
          if (row.durationMs) parts.push(t`耗时 ${formatDuration(row.durationMs.p50)}`);
          if (row.authMs && row.authMs.p50 >= 20) parts.push(t`鉴权 ${formatDuration(row.authMs.p50)}`);
        } else {
          if (row.ttftMs) parts.push(`TTFT ${formatDuration(row.ttftMs.p50)}`);
          if (row.outputTokensPerSecond) parts.push(formatSpeed(row.outputTokensPerSecond.p50));
          else if (row.durationMs) parts.push(t`耗时 ${formatDuration(row.durationMs.p50)}`);
        }
        if ((row.thinkingRate ?? 0) > 0.2) parts.push(t`未关思考`);
      }
      if (slow) parts.push(slow);
    }
    return parts.length ? parts.join(' · ') : undefined;
  };

  const save = async (patch: AppSettingsUpdate) => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await api.updateSettings(patch);
      onSaved(saved, { auxiliaryModels: saved.auxiliaryModels, pluginModels: saved.pluginModels });
    } catch (error) { onError(errorMessage(error, t`无法保存辅助模型`)); }
    finally { setBusy(false); }
  };

  const tryIt = (purpose: PreviewPurpose) => {
    const model = settings.auxiliaryModels?.[purpose] ?? settings.auxiliaryModels?.default;
    if (!model) return;
    setPreview({ purpose, model });
    setPreviewOpen(true);
  };

  const loading = !options && !loadError;
  const shared = { backends: eligibleBackends, busy, loading };
  const hasDefault = Boolean(settings.auxiliaryModels?.default);
  const probeInitial = [
    settings.auxiliaryModels?.default,
    settings.auxiliaryModels?.title,
    settings.auxiliaryModels?.handoff,
    settings.auxiliaryModels?.summary,
    ...Object.values(settings.pluginModels ?? {}),
  ].filter((ref): ref is AuxiliaryModelRef => Boolean(ref));

  const groupActions = (
    <div className="flex items-center gap-1">
      <Button size="xs" variant="ghost" disabled={!options?.length || busy} onClick={() => setProbeOpen(true)}>
        <IconGauge />
        <Trans>测速</Trans>
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setInspectOpen(true)}>
        <IconInfoOutline />
        <Trans>Prompt 与日志</Trans>
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t`内置用途`} action={groupActions}>
        <AuxiliaryModelRow
          {...shared}
          title={t`默认模型`}
          description={loadError || speedHint(settings.auxiliaryModels?.default, 'stream', t`未单独设置的用途回退到此模型`)}
          offLabel={t`不使用`}
          current={settings.auxiliaryModels?.default}
          onSave={(ref) => save({ auxiliaryModels: { default: ref } })}
        />
        <AuxiliaryModelRow
          {...shared}
          title={t`会话标题`}
          description={speedHint(settings.auxiliaryModels?.title ?? settings.auxiliaryModels?.default, 'short', t`首条消息开始时生成`)}
          offLabel={hasDefault ? t`跟随默认` : t`只用 CLI 标题`}
          current={settings.auxiliaryModels?.title}
          previewDisabled={!hasDefault && !settings.auxiliaryModels?.title}
          onSave={(ref) => save({ auxiliaryModels: { title: ref } })}
          onPreview={() => tryIt('title')}
        />
        {onOpenTitleRules && <SettingsLinkRow title={t`标题规则`} value={settings.titleRules?.length ? t`${settings.titleRules.length} 条` : t`未设置`} onClick={onOpenTitleRules} />}
        <AuxiliaryModelRow
          {...shared}
          title={t`交接摘要`}
          description={speedHint(settings.auxiliaryModels?.handoff ?? settings.auxiliaryModels?.default, 'long', t`发起会话交接时生成`)}
          offLabel={hasDefault ? t`跟随默认` : t`不使用`}
          current={settings.auxiliaryModels?.handoff}
          previewDisabled={!hasDefault && !settings.auxiliaryModels?.handoff}
          onSave={(ref) => save({ auxiliaryModels: { handoff: ref } })}
          onPreview={() => tryIt('handoff')}
        />
        <AuxiliaryModelRow
          {...shared}
          title={t`画布摘要`}
          description={speedHint(settings.auxiliaryModels?.summary ?? settings.auxiliaryModels?.default, 'short', t`打开画布查看节点时按轮生成`)}
          offLabel={hasDefault ? t`跟随默认` : t`不使用`}
          current={settings.auxiliaryModels?.summary}
          onSave={(ref) => save({ auxiliaryModels: { summary: ref } })}
        />
      </SettingsGroup>
      {uses.length > 0 && (
        <SettingsGroup title={t`插件`}>
          {uses.map((use) => {
            const title = localizedText(use.title, [i18n.locale]) ?? use.id;
            const offLabel = use.fallback === 'default' ? t`跟随默认` : use.fallback === 'chat' ? t`跟随模型对话` : t`不使用`;
            const current = settings.pluginModels?.[use.id];
            const effective = current ?? (use.fallback === 'default' ? settings.auxiliaryModels?.default : use.fallback === 'chat' ? settings.auxiliaryModels?.chat : undefined);
            return (
              <AuxiliaryModelRow
                key={use.id}
                {...shared}
                title={title}
                description={speedHint(effective, 'stream', use.id === 'riffet.translate/translation' ? t`点击翻译回答或选区时生成` : undefined)}
                offLabel={offLabel}
                current={current}
                onSave={(ref) => save({ pluginModels: { [use.id]: ref } })}
              />
            );
          })}
        </SettingsGroup>
      )}
      {preview && <AuxiliaryPreviewDialog open={previewOpen} purpose={preview.purpose} model={preview.model} onOpenChange={setPreviewOpen} />}
      <ModelProbeDialog
        open={probeOpen}
        onOpenChange={setProbeOpen}
        options={options ?? []}
        initialSelected={probeInitial}
        {...(settings.auxiliaryModels?.default ? { defaultModel: settings.auxiliaryModels.default } : {})}
        onSetDefault={(ref) => save({ auxiliaryModels: { default: ref } })}
        onCompleted={() => setProbeTick((tick) => tick + 1)}
      />
      <AuxiliaryInspectDialog open={inspectOpen} onOpenChange={setInspectOpen} />
    </div>
  );
}

function AuxiliaryModelRow({ title, description, offLabel, current, backends, busy, loading, previewDisabled, onSave, onPreview }: {
  title: string;
  description?: string;
  offLabel: string;
  current: AuxiliaryModelRef | undefined;
  backends: readonly NativeBackendCatalogEntry[];
  busy: boolean;
  loading: boolean;
  previewDisabled?: boolean;
  onSave: (ref: AuxiliaryModelRef | null) => Promise<void>;
  onPreview?: () => void;
}) {
  const choice = current ? { backendId: current.backendId, profileId: current.profileId, model: current.model } : undefined;
  const { picker, pick } = useAgentModelChoice({ projectId: '', backends, choice, agents: true });

  const handleChange = (id: string) => {
    const picked = pick(id);
    if (!picked) return;
    const selectedBackend = backends.find((entry) => entry.backendId === picked.backendId);
    const profileId = picked.profileId ?? selectedBackend?.profiles.find((profile) => profile.isDefault)?.id ?? selectedBackend?.profiles[0]?.id;
    const rawModel = picked.model || selectedBackend?.defaultModel;
    const model = rawModel ? parseSelection(rawModel).model : '';
    if (!profileId || !model) return;
    if (current && current.backendId === picked.backendId && current.profileId === profileId && current.model === model) return;
    void onSave({ backendId: picked.backendId, profileId, model });
  };

  return (
    <SettingsRow title={title} description={description}>
      <div className="flex items-center gap-1.5 max-md:w-full max-md:flex-wrap">
        {onPreview && (
          <Button size="xs" variant="ghost" disabled={Boolean(previewDisabled) || busy} onClick={onPreview}>
            <Trans>试用</Trans>
          </Button>
        )}
        {current && (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void onSave(null)}>
            <Trans>清除</Trans>
          </Button>
        )}
        <ModelPicker
          side="bottom"
          align="end"
          placeholder={offLabel}
          className="h-8 w-56 justify-start rounded-lg border border-line-strong bg-elevated px-2.5 text-fg-2 max-md:order-first max-md:w-auto max-md:min-w-0 max-md:flex-1"
          labelClassName="min-w-0 flex-1 truncate text-left max-w-none sm:max-w-none"
          {...picker}
          loading={loading || picker.loading}
          disabled={busy}
          onChange={handleChange}
        />
      </div>
    </SettingsRow>
  );
}
