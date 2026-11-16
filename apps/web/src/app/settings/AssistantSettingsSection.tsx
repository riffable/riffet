import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ASSISTANT_BUDGET, assistantChoice, catalogEntry, catalogSelection, parseSelection, type AssistantDelegation, type AssistantJob, type AssistantPack, type AssistantRunUsage } from '@contracts';
import { Segmented, Select, Switch } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { isAssistantProject } from '@/lib/project-family';
import { formatTokens } from '@/lib/stats-format';
import { cleanLabel } from '@/lib/utils';
import { useAgentModels } from '../session/agentModels';
import { ModelPicker, type ModelProviderChoices } from '../session/ModelPicker';
import type { Choice } from '../session/model';
import { useCatalog, useLists, useSettings, useStores } from '../state/stores';
import { DelegationsDialog } from '../work-items/AssistantSetup';
import { SettingsGroup, SettingsLinkRow, SettingsRow } from './SettingsLayout';

const DAILY_RUNS = [10, 30, 100];
/** A choice names its provider too, as in the composer: two providers may offer the same model id. */
const SEPARATOR = '\u0000';
const compose = (profileId: string | undefined, model: string) => profileId === undefined ? model : `${profileId}${SEPARATOR}${model}`;
function split(id: string): { profileId?: string; model: string } {
  const at = id.indexOf(SEPARATOR);
  return at < 0 ? { model: id } : { profileId: id.slice(0, at), model: id.slice(at + 1) };
}

/**
 * The 个人助理's settings (docs/ASSISTANT.md §7): what it does in the background, which is what costs the owner
 * tokens while they are away, and how it starts tasks. Saved at once, on the server, for every device.
 */
export function AssistantSettingsSection() {
  const { t } = useLingui();
  const { settings } = useStores();
  const assistant = useSettings((value) => value.assistant);
  const backends = useCatalog((state) => state.backends);
  const projectId = useLists((state) => state.projects.find(isAssistantProject)?.id) ?? '';
  const agentModels = useAgentModels(projectId);
  const [usage, setUsage] = useState<AssistantRunUsage>();
  const [delegations, setDelegations] = useState<AssistantDelegation[]>();
  const [delegationsOpen, setDelegationsOpen] = useState(false);
  const [packs, setPacks] = useState<AssistantPack[]>();
  const [packBusy, setPackBusy] = useState<string>();

  useEffect(() => {
    let live = true;
    api.assistantRunUsage().then((value) => { if (live) setUsage(value); }, () => undefined);
    api.assistantPacks().then((value) => { if (live) setPacks(value.packs); }, () => undefined);
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    api.assistantDelegations().then((value) => { if (live) setDelegations(value.delegations); }, () => undefined);
    return () => { live = false; };
  }, [delegationsOpen]);

  // The 助理's model, from every provider of its agent, as the composer offers them; its background runs use it too.
  const choice = assistantChoice(assistant, backends);
  const backendId = choice?.backendId;
  const backend = backends.find((entry) => entry.backendId === backendId);
  const profiles = backend?.profiles ?? [];
  const activeProfileId = choice?.profileId ?? profiles.find((profile) => profile.isDefault)?.id ?? profiles[0]?.id;
  const { load } = agentModels;
  useEffect(() => { if (backendId) load(backendId, activeProfileId); }, [load, backendId, activeProfileId]);
  const listed = (profileId: string | undefined): Choice[] => backendId ? (agentModels.read(backendId, profileId) ?? []).map((item) => ({ id: compose(profileId, item.value), label: cleanLabel(item.name) })) : [];
  const providers: ModelProviderChoices[] | undefined = profiles.length ? profiles.map((profile) => {
    const models = listed(profile.id);
    return { id: profile.id, label: profile.name, models, loading: !models.length && Boolean(backendId) && agentModels.loading(backendId!, profile.id), ...(!models.length && backendId && agentModels.issue(backendId, profile.id) ? { issue: agentModels.issue(backendId, profile.id) } : {}) };
  }) : undefined;
  // The saved model carries the composer's parameters (`model[effort=high]`); the list names the model alone.
  const saved = parseSelection(choice?.model);
  const savedModel = backendId && saved.model ? catalogEntry(agentModels.read(backendId, activeProfileId) ?? [], saved.model)?.value ?? saved.model : saved.model;
  const modelValue = savedModel ? compose(profiles.length ? activeProfileId : undefined, savedModel) : undefined;
  const listedAll = providers ? providers.flatMap((provider) => provider.models.map((model) => ({ ...model, group: provider.label }))) : listed(undefined);
  // Until its provider's list arrives, the trigger still names the model rather than the raw choice id.
  const models = modelValue && !listedAll.some((item) => item.id === modelValue) ? [...listedAll, { id: modelValue, label: cleanLabel(savedModel) }] : listedAll;
  const pickModel = (id: string) => {
    if (!backendId) return;
    const picked = split(id);
    // Kept as the composer keeps them: the parameters the new model also has.
    const model = picked.model ? catalogSelection(agentModels.read(backendId, picked.profileId) ?? [], picked.model, saved.params) : '';
    settings.rememberAssistant({ backendId, profileId: picked.profileId ?? null, model: model || null });
  };
  const dailyRuns = assistant?.dailyRuns ?? ASSISTANT_BUDGET.dailyRuns;
  const dailyOptions = DAILY_RUNS.includes(dailyRuns) ? DAILY_RUNS : [...DAILY_RUNS, dailyRuns].sort((a, b) => a - b);
  const spent = (job: AssistantJob) => {
    const row = usage?.jobs.find((item) => item.job === job);
    return row?.runs ? t`近 ${usage!.days} 天 ${row.runs} 次 · ${formatTokens(row.tokens)} tokens` : undefined;
  };
  // Nothing while none is open: the list says so itself.
  const active = delegations?.filter((item) => item.state === 'active').length ?? 0;

  // A pack of Riffet's can be added again; one the owner put there is gone with its folder, so that one asks first.
  const togglePack = async (pack: AssistantPack, on: boolean) => {
    if (!on && !pack.builtIn && !await confirmDialog({ title: t`去掉「${pack.title}」？`, detail: t`它的文件夹会删除，可以从个人助理目录的提交历史找回`, confirmLabel: t`去掉`, destructive: true })) return;
    setPackBusy(pack.id);
    try { setPacks((on ? await api.addAssistantPack(pack.id) : await api.removeAssistantPack(pack.id)).packs); }
    catch (error) { toast.error(errorMessage(error, t`无法保存`)); }
    finally { setPackBusy(undefined); }
  };

  return <div className="flex flex-col gap-6">
    <SettingsGroup>
      <SettingsRow title={t`模型`} description={backend?.label}>
        <ModelPicker side="bottom" align="end" className="h-8 rounded-lg border border-line-strong bg-elevated px-3 text-fg-2 max-md:min-w-0 max-md:flex-1" models={models} value={modelValue} placeholder={t`默认模型`} disabled={!backendId}
          providers={providers} activeProviderId={activeProfileId} onPreviewProvider={(id) => { if (backendId) agentModels.load(backendId, id); }}
          loading={Boolean(backendId) && agentModels.loading(backendId!, activeProfileId) && !models.length}
          refreshCatalog={() => { if (backendId) agentModels.load(backendId, activeProfileId, true); }}
          onChange={pickModel} />
      </SettingsRow>
    </SettingsGroup>
    {packs && packs.length > 0 && <SettingsGroup title={t`能力包`} note={t`个人助理空闲时生效；去掉后记忆保留`}>
      {packs.map((pack) => (
        <SettingsRow key={pack.id} title={pack.title} description={pack.description}>
          <Switch aria-label={pack.title} checked={pack.installed} disabled={packBusy === pack.id} onCheckedChange={(value) => void togglePack(pack, value)} />
        </SettingsRow>
      ))}
    </SettingsGroup>}
    <SettingsGroup title={t`后台运行`} note={t`用个人助理的模型，按用量计费`}>
      <SettingsRow title={t`跟进任务`} description={spent('supervise') ?? t`任务的会话停下、你不在时，核对交付或推动它`}>
        <Switch aria-label={t`跟进任务`} checked={assistant?.supervision === true} onCheckedChange={(value) => settings.rememberAssistant({ supervision: value })} />
      </SettingsRow>
      <SettingsRow title={t`记忆整理`} description={spent('consolidate') ?? t`每晚，以及主对话压缩前`}>
        <Switch aria-label={t`记忆整理`} checked={assistant?.consolidation !== false} onCheckedChange={(value) => settings.rememberAssistant({ consolidation: value })} />
      </SettingsRow>
      <SettingsLinkRow title={<span className="flex items-center justify-between gap-3">
        <Trans>委托</Trans>
        <span className="text-xs font-normal text-fg-3">{spent('delegation') ?? (active ? t`${active} 项进行中` : '')}</span>
      </span>} onClick={() => setDelegationsOpen(true)} />
      <SettingsRow title={t`24 小时内最多`} description={usage && (usage.waiting ? t`已开始 ${usage.started} 次，${usage.waiting} 次在等` : t`已开始 ${usage.started} 次`)}>
        <Select label={t`24 小时内最多`} className="w-40" value={String(dailyRuns)}
          options={dailyOptions.map((count) => ({ value: String(count), label: t`${count} 次` }))}
          onChange={(value) => settings.rememberAssistant({ dailyRuns: Number(value) })} />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title={t`任务`}>
      <SettingsRow title={t`开始任务前`}>
        <Segmented<'edits' | 'all'> size="xs" value={assistant?.dispatch ?? 'edits'} ariaLabel={t`开始任务前`} onChange={(value) => settings.rememberAssistant({ dispatch: value })}
          options={[{ value: 'edits', label: t`改代码的先问我` }, { value: 'all', label: t`都先问我` }]} />
      </SettingsRow>
    </SettingsGroup>
    <DelegationsDialog open={delegationsOpen} delegations={delegations} onClose={() => setDelegationsOpen(false)}
      onEnded={(ended) => setDelegations((current) => current?.map((item) => item.id === ended.id ? ended : item))} />
  </div>;
}
