import { useEffect } from 'react';
import { useLingui } from '@lingui/react/macro';
import { catalogEntry, catalogParams, catalogSelection, parseSelection, type NativeBackendCatalogEntry, type NativeBackendId } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { IconMessageSquareText } from '@/components/icons';
import { agentMarkStyle, backendSelection, useBackendLabel } from '@/lib/backends';
import { cleanLabel } from '@/lib/utils';
import { useAgentModels } from './agentModels';
import type { ModelProviderChoices } from './ModelPicker';
import { modelUsageAliases, type Choice } from './model';

/** An agent, its provider and a model: what a model menu picks. `model` carries the composer's parameters (`model[effort=high]`). */
export interface AgentModelValue { backendId: NativeBackendId; profileId?: string; model?: string }

/** An agent's mark in the menu; quick chat has none of its own and is drawn as the tab bar draws it. */
const agentIcon = (backendId: NativeBackendId, className?: string) => backendId === 'chat'
  ? <IconMessageSquareText className={['size-3.5 text-fg-3', className].filter(Boolean).join(' ')} aria-hidden />
  : <AgentLogo backend={backendId} size={14} {...(className ? { className } : {})} style={agentMarkStyle(backendId)} />;

/** A choice names its provider too, as in the composer: two providers may offer the same model id. */
const SEPARATOR = '\u0000';
const compose = (profileId: string | undefined, model: string) => profileId === undefined ? model : `${profileId}${SEPARATOR}${model}`;
function split(id: string): { profileId?: string; model: string } {
  const at = id.indexOf(SEPARATOR);
  return at < 0 ? { model: id } : { profileId: id.slice(0, at), model: id.slice(at + 1) };
}
/** With several agents in one menu every id names its agent too; SOH keeps them apart from the single-agent ids. */
const AGENT = '\u0001';
const sourceOf = (backendId: NativeBackendId, profileId?: string) => `${AGENT}${backendId}${AGENT}${profileId ?? ''}`;
const choiceOf = (backendId: NativeBackendId, profileId: string | undefined, model: string) => `${sourceOf(backendId, profileId)}${AGENT}${model}`;
function splitAgent(id: string): { backendId: NativeBackendId; profileId?: string; model: string } | undefined {
  if (!id.startsWith(AGENT)) return undefined;
  const [backendId = '', profileId = '', ...model] = id.slice(1).split(AGENT);
  return { backendId: backendId as NativeBackendId, ...(profileId ? { profileId } : {}), model: model.join(AGENT) };
}

/**
 * What a settings page or dialog needs to run the composer's model menu on a saved choice: the
 * `ModelPicker` props (spread them) and `pick`, which turns a picked id back into agent, provider and
 * model. With `agents` the menu also picks the agent (a new conversation's menu, Agent → provider →
 * model); without, it lists the providers of the choice's own agent. `quickChat` lists quick chat among the agents.
 */
export function useAgentModelChoice({ projectId, backends, choice, agents = false, quickChat = false, allowDefault = false }: {
  projectId: string;
  backends: readonly NativeBackendCatalogEntry[];
  choice: AgentModelValue | undefined;
  agents?: boolean;
  quickChat?: boolean;
  /** Prepend a "默认模型" option to every provider list so callers can clear an explicit model back to the backend's default. */
  allowDefault?: boolean;
}) {
  const { t } = useLingui();
  const label = useBackendLabel();
  const agentModels = useAgentModels(projectId);
  const backendId = choice?.backendId;
  const backend = backends.find((entry) => entry.backendId === backendId);
  const profiles = backend?.profiles ?? [];
  const activeProfileId = choice?.profileId ?? profiles.find((profile) => profile.isDefault)?.id ?? profiles[0]?.id;
  const { load } = agentModels;
  useEffect(() => { if (backendId) load(backendId, activeProfileId); }, [load, backendId, activeProfileId]);

  const sourceId = (id: NativeBackendId, profileId?: string) => agents ? sourceOf(id, profileId) : profileId ?? '';
  const choiceId = (id: NativeBackendId, profileId: string | undefined, model: string) => agents ? choiceOf(id, profileId, model) : compose(profileId, model);
  const defaultOption = (id: NativeBackendId, profileId?: string): Choice => ({ id: choiceId(id, profileId, ''), label: t`默认模型` });
  const rawListed = (id: NativeBackendId, profileId?: string): Choice[] => (agentModels.read(id, profileId) ?? []).map((item) => ({ id: choiceId(id, profileId, item.value), label: cleanLabel(item.name), aliases: modelUsageAliases(item) }));
  const listed = (id: NativeBackendId, profileId?: string): Choice[] => {
    const items = rawListed(id, profileId);
    return allowDefault && items.length ? [defaultOption(id, profileId), ...items] : items;
  };
  const providersOf = (entry: NativeBackendCatalogEntry): ModelProviderChoices[] => {
    const agent = { id: entry.backendId, label: label(entry.backendId), icon: agentIcon(entry.backendId) };
    const saved = entry.profiles.find((profile) => profile.isDefault)?.id;
    return (entry.profiles.length ? entry.profiles : [undefined]).map((profile): ModelProviderChoices => {
      const items = rawListed(entry.backendId, profile?.id);
      const loading = !items.length && agentModels.loading(entry.backendId, profile?.id);
      const issue = items.length ? undefined : agentModels.issue(entry.backendId, profile?.id);
      // An agent that lists nothing still starts on its own default model.
      const fallback = (agents || allowDefault) && !loading && !items.length && (agentModels.read(entry.backendId, profile?.id) !== undefined || Boolean(issue));
      const models = items.length
        ? (allowDefault ? [defaultOption(entry.backendId, profile?.id), ...items] : items)
        : fallback ? [defaultOption(entry.backendId, profile?.id)] : [];
      return {
        id: sourceId(entry.backendId, profile?.id),
        label: profile?.name ?? agent.label,
        models,
        loading,
        ...(issue ? { issue } : {}),
        ...(agents ? { agent, preferred: profile?.id === saved } : {}),
      };
    });
  };
  const workers = backends.filter((entry) => (quickChat || entry.backendId !== 'chat') && entry.available !== false);
  const providers: ModelProviderChoices[] | undefined = agents ? workers.flatMap(providersOf) : backend && profiles.length ? providersOf(backend) : undefined;
  const catalogEntryValue = backendId ? agentModels.entry(backendId, activeProfileId) : undefined;
  const catalog = catalogEntryValue?.models ?? [];
  // Normalize native variant ids back to family model + params so effort/fast/context controls stay in sync.
  const saved = parseSelection(backendId && choice?.model ? backendSelection(backendId, catalog, choice.model) : choice?.model);
  const savedModel = backendId && saved.model ? catalogEntry(catalog, saved.model)?.value ?? saved.model : saved.model;
  const withProfile = profiles.length ? activeProfileId : undefined;
  const hasModels = catalog.length > 0;
  const value = backendId && (savedModel || (allowDefault && hasModels)) ? choiceId(backendId, withProfile, savedModel) : undefined;
  /** A model found beside others is filed under its agent, and its provider where the agent has several. */
  const groupOf = (provider: ModelProviderChoices, all: ModelProviderChoices[]) => !provider.agent ? provider.label
    : all.filter((other) => other.agent?.id === provider.agent!.id).length > 1 ? `${provider.agent.label} · ${provider.label}` : provider.agent.label;
  const everything: Choice[] = providers ? providers.flatMap((provider) => provider.models.map((model) => ({ ...model, group: groupOf(provider, providers) }))) : backendId ? listed(backendId) : [];
  // Until its provider's list arrives, the trigger still names the model rather than the raw choice id.
  const models = value && savedModel && !everything.some((item) => item.id === value) ? [...everything, { id: value, label: cleanLabel(savedModel) }] : everything;

  const pick = (id: string): AgentModelValue | undefined => {
    const picked = agents ? splitAgent(id) : backendId ? { backendId, ...split(id) } : undefined;
    if (!picked) return undefined;
    const sameModel = picked.backendId === backendId;
    const model = picked.model ? catalogSelection(agentModels.read(picked.backendId, picked.profileId) ?? [], picked.model, sameModel ? saved.params : {}) : '';
    return { backendId: picked.backendId, ...(picked.profileId ? { profileId: picked.profileId } : {}), ...(model ? { model } : {}) };
  };

  /** The saved model's parameters (effort, Fast…), for a form that keeps them; see `withParam`. */
  const params = savedModel ? catalogParams(catalog, savedModel, saved.params) : [];
  /** The choice with one parameter changed, as the composer's model menu changes it. */
  const withParam = (id: string, next: string): AgentModelValue | undefined => !backendId || !savedModel ? undefined
    : { backendId, ...(choice?.profileId ? { profileId: choice.profileId } : {}), model: catalogSelection(catalog, savedModel, { ...saved.params, [id]: next }, id) };

  return {
    pick,
    params,
    withParam,
    /** The active backend's latest catalog entry (with capabilities), falling back to the bootstrap entry. */
    capabilities: catalogEntryValue?.capabilities ?? backend?.capabilities,
    /** Spread onto `ModelPicker`. */
    picker: {
      models,
      value,
      providers,
      activeProviderId: backendId ? sourceId(backendId, withProfile) : undefined,
      onPreviewProvider: (id: string) => {
        if (!agents) { if (backendId) agentModels.load(backendId, id); return; }
        const other = splitAgent(`${id}${AGENT}`);
        if (other) agentModels.load(other.backendId, other.profileId);
      },
      loading: Boolean(backendId) && agentModels.loading(backendId!, activeProfileId) && !models.length,
      refreshCatalog: () => {
        if (backendId) agentModels.load(backendId, activeProfileId, true);
        // As the menu opens, the other agents nothing is known about yet are read too.
        if (agents) for (const provider of providers ?? []) {
          const other = splitAgent(`${provider.id}${AGENT}`);
          if (other && !provider.models.length && !(other.backendId === backendId && other.profileId === activeProfileId)) agentModels.load(other.backendId, other.profileId);
        }
      },
      ...(agents && backendId ? { leading: <>{agentIcon(backendId, 'shrink-0')}<span className="sr-only">{label(backendId)}</span></> } : {}),
    },
  };
}
