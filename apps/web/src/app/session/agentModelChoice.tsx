import { useEffect } from 'react';
import { useLingui } from '@lingui/react/macro';
import { catalogEntry, catalogSelection, parseSelection, type NativeBackendCatalogEntry, type NativeBackendId } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { agentMarkStyle, useBackendLabel } from '@/lib/backends';
import { cleanLabel } from '@/lib/utils';
import { useAgentModels } from './agentModels';
import type { ModelProviderChoices } from './ModelPicker';
import type { Choice } from './model';

/** An agent, its provider and a model: what a model menu picks. `model` carries the composer's parameters (`model[effort=high]`). */
export interface AgentModelValue { backendId: NativeBackendId; profileId?: string; model?: string }

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
 * model); without, it lists the providers of the choice's own agent.
 */
export function useAgentModelChoice({ projectId, backends, choice, agents = false }: {
  projectId: string;
  backends: readonly NativeBackendCatalogEntry[];
  choice: AgentModelValue | undefined;
  agents?: boolean;
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
  const listed = (id: NativeBackendId, profileId?: string): Choice[] => (agentModels.read(id, profileId) ?? []).map((item) => ({ id: choiceId(id, profileId, item.value), label: cleanLabel(item.name) }));
  const providersOf = (entry: NativeBackendCatalogEntry): ModelProviderChoices[] => {
    const agent = { id: entry.backendId, label: label(entry.backendId), icon: <AgentLogo backend={entry.backendId} size={14} style={agentMarkStyle(entry.backendId)} /> };
    const saved = entry.profiles.find((profile) => profile.isDefault)?.id;
    return (entry.profiles.length ? entry.profiles : [undefined]).map((profile): ModelProviderChoices => {
      const list = listed(entry.backendId, profile?.id);
      const loading = !list.length && agentModels.loading(entry.backendId, profile?.id);
      const issue = list.length ? undefined : agentModels.issue(entry.backendId, profile?.id);
      // An agent that lists nothing still starts on its own default model.
      const fallback = agents && !loading && !list.length && (agentModels.read(entry.backendId, profile?.id) !== undefined || Boolean(issue));
      return {
        id: sourceId(entry.backendId, profile?.id),
        label: profile?.name ?? agent.label,
        models: fallback ? [{ id: choiceId(entry.backendId, profile?.id, ''), label: t`默认模型` }] : list,
        loading,
        ...(issue ? { issue } : {}),
        ...(agents ? { agent, preferred: profile?.id === saved } : {}),
      };
    });
  };
  const workers = backends.filter((entry) => entry.backendId !== 'chat' && entry.available !== false);
  const providers: ModelProviderChoices[] | undefined = agents ? workers.flatMap(providersOf) : backend && profiles.length ? providersOf(backend) : undefined;
  // The saved model names the model alone; its parameters ride along when another model is picked.
  const saved = parseSelection(choice?.model);
  const savedModel = backendId && saved.model ? catalogEntry(agentModels.read(backendId, activeProfileId) ?? [], saved.model)?.value ?? saved.model : saved.model;
  const withProfile = profiles.length ? activeProfileId : undefined;
  const value = backendId && savedModel ? choiceId(backendId, withProfile, savedModel) : undefined;
  /** A model found beside others is filed under its agent, and its provider where the agent has several. */
  const groupOf = (provider: ModelProviderChoices, all: ModelProviderChoices[]) => !provider.agent ? provider.label
    : all.filter((other) => other.agent?.id === provider.agent!.id).length > 1 ? `${provider.agent.label} · ${provider.label}` : provider.agent.label;
  const everything: Choice[] = providers ? providers.flatMap((provider) => provider.models.map((model) => ({ ...model, group: groupOf(provider, providers) }))) : backendId ? listed(backendId) : [];
  // Until its provider's list arrives, the trigger still names the model rather than the raw choice id.
  const models = value && !everything.some((item) => item.id === value) ? [...everything, { id: value, label: cleanLabel(savedModel) }] : everything;

  const pick = (id: string): AgentModelValue | undefined => {
    const picked = agents ? splitAgent(id) : backendId ? { backendId, ...split(id) } : undefined;
    if (!picked) return undefined;
    const sameModel = picked.backendId === backendId;
    const model = picked.model ? catalogSelection(agentModels.read(picked.backendId, picked.profileId) ?? [], picked.model, sameModel ? saved.params : {}) : '';
    return { backendId: picked.backendId, ...(picked.profileId ? { profileId: picked.profileId } : {}), ...(model ? { model } : {}) };
  };

  return {
    pick,
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
      ...(agents && backendId ? { leading: <><AgentLogo backend={backendId} size={14} className="shrink-0" style={agentMarkStyle(backendId)} /><span className="sr-only">{label(backendId)}</span></> } : {}),
    },
  };
}
