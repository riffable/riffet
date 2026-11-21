import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod/v4';
import {
  ASSISTANT_QUERY_BUDGET, MODEL_PICKER_BUDGET, parseSelection, rememberProfileModel,
  type AppSettings, type NativeBackendCatalogEntry, type NativeBackendDefaults, type NativeBackendId,
} from '../../../../packages/contracts/src/index.js';
import { defineRead, defineSettingCommand, type SettingCommandTurn } from '../assistant-capability.js';
import type { BackendCatalog } from '../backends/catalog.js';
import { isNativeBackendId } from '../backends/registry.js';
import { AppError } from '../errors.js';
import { defaultBackendForClient, type DefaultBackendSource } from '../native/client-features.js';
import { legacyDefaults } from '../session-identity.js';
import { validateBackendDefaults } from './backend-defaults.js';
import type { SettingsService } from './index.js';

const scope = {
  kind: 'instance',
  takesEffect: 'Across Riffet clients for future conversations that inherit instance defaults. Task launches can inherit them when their own defaults are absent.',
  exceptions: 'Existing sessions, explicit choices, the personal assistant’s own settings, and Quick Chat keep their own selections. Older clients may fall back to a backend they support.',
  billingImpact: 'A different Agent, provider, or model can use a different account, quota, or billing rate.',
};

const choiceId = z.string().trim().min(1).max(200);
const pageLimit = z.number().int().min(1).max(ASSISTANT_QUERY_BUDGET.pageItems).default(20);
const readArgs = z.strictObject({
  backendId: choiceId.optional(), profileId: choiceId.optional(),
  afterProfileId: choiceId.optional(), afterModelId: choiceId.optional(), limit: pageLimit,
});
const commandArgs = z.strictObject({
  sourceTurn: z.string().min(1).max(64),
  action: z.enum(['propose', 'apply']),
  backendId: choiceId.optional(), profileId: choiceId.optional(), model: choiceId.optional(),
  makeDefaultAgent: z.boolean().optional().describe('Also make this backend the instance default Agent.'),
});

type Catalog = Pick<BackendCatalog, 'listBackends' | 'validateProfile' | 'capabilitiesFor' | 'entry' | 'normalizeModel'>;
type Settings = Pick<SettingsService, 'getSettings' | 'setSettings'>;
type Change = { backendId: NativeBackendId; profileId?: string; model?: string; makeDefaultAgent: boolean };
type PickedProfile = ReturnType<Catalog['validateProfile']>;

function optionBackendId(value: string | undefined, offered: readonly NativeBackendId[]): NativeBackendId {
  if (!value || !isNativeBackendId(value) || value === 'chat' || !offered.includes(value)) {
    throw new AppError('INVALID_BACKEND', 'Choose an Agent from settings.agent_defaults.');
  }
  return value;
}

function optionPage<T extends { id: string }>(items: T[], after: string | undefined, limit: number) {
  const sorted = items.filter(item => after === undefined || item.id > after).sort((left, right) => left.id < right.id ? -1 : Number(left.id > right.id));
  const page = sorted.slice(0, limit);
  return { items: page, nextId: sorted.length > limit ? page.at(-1)!.id : null };
}

async function readCatalog(catalog: Catalog, backendId: NativeBackendId, profileId: string): Promise<NativeBackendCatalogEntry | undefined> {
  try {
    const selected = await catalog.entry(backendId, undefined, profileId);
    return selected.available && !selected.reason ? selected : undefined;
  } catch { return undefined; }
}

function effectiveModel(catalog: Catalog, saved: AppSettings, backendId: NativeBackendId, profile: PickedProfile, defaults?: NativeBackendDefaults) {
  const providerDefault = typeof profile.config.defaultModel === 'string' ? profile.config.defaultModel : undefined;
  const raw = defaults?.model || providerDefault || legacyDefaults(backendId, saved).model;
  return raw ? catalog.normalizeModel(backendId, profile.id, raw) : null;
}

export function agentDefaultsRead(service: Settings, catalog: Catalog, source: DefaultBackendSource) {
  return defineRead('settings.agent_defaults', 'Read the Riffet instance’s default Agent and configured provider/model selections. Supply a backendId and optionally profileId to list that provider’s models.',
    ['default agent', 'default model', 'provider', 'backend', 'profile', 'model', 'billing', '默认', '模型', '提供商', '后端', '费用'],
    readArgs, async (_id, { backendId, profileId, afterProfileId, afterModelId, limit }) => {
      if (!backendId && (profileId || afterProfileId || afterModelId)) throw new AppError('INVALID_ARGUMENT', 'Select a backendId before requesting its providers or models.');
      const saved = service.getSettings();
      const offered = source.offeredBackendIds();
      const entries = (await catalog.listBackends()).filter(entry => entry.backendId !== 'chat');
      const backends = entries.map(entry => {
        const id = entry.backendId;
        const defaults = saved.nativeBackendDefaults?.[id];
        const selected = defaults?.profileId ?? (entry.profiles.find(item => item.isDefault) ?? entry.profiles[0])?.id;
        const profile = entry.profiles.some(item => item.id === selected) ? catalog.validateProfile(id, selected) : undefined;
        return {
          id, name: entry.label, providerAvailability: { profileId: (entry.profiles.find(item => item.isDefault) ?? entry.profiles[0])?.id ?? null,
            available: entry.available, needsLogin: entry.needsLogin === true },
          configuredProfileId: defaults?.profileId ?? null, configuredModel: defaults?.model ?? null,
          effectiveProfileId: profile?.id ?? null, effectiveModel: profile ? effectiveModel(catalog, saved, id, profile, defaults) : null,
        };
      });
      const instance = {
        configuredBackendId: saved.defaultBackendId ?? null,
        effectiveBackendId: await defaultBackendForClient(undefined, saved.defaultBackendId, source),
        backends, scope, action: 'agent_defaults_set',
      };
      if (!backendId) return instance;
      const id = optionBackendId(backendId, offered);
      const backend = entries.find(entry => entry.backendId === id);
      if (!backend) throw new AppError('INVALID_BACKEND', 'Choose an Agent with a configured provider.');
      const profile = catalog.validateProfile(id, profileId ?? backends.find(entry => entry.id === id)?.effectiveProfileId ?? undefined);
      const profiles = optionPage(backend.profiles.map(item => ({ id: item.id, name: item.name.slice(0, 200), isDefault: item.isDefault === true })), afterProfileId, limit);
      const entry = await readCatalog(catalog, id, profile.id);
      const models = optionPage((entry?.models ?? []).filter(model => model.value.length <= 200).map(item => ({ id: item.value, name: item.name.slice(0, 200) })), afterModelId, limit);
      return {
        ...instance, backendId: id, profiles, profileId: profile.id,
        models: { ...models, status: !entry ? 'unavailable' : entry.capabilities.supportsModelSelection ? 'available' : 'unsupported', defaultModel: entry?.defaultModel ?? null },
      };
    });
}

/** `effectiveDefaultId`: the Agent a new conversation starts on now (`defaultBackendForClient`). */
function settingSnapshot(service: Settings, catalog: Catalog, change: Change, effectiveDefaultId: NativeBackendId) {
  const saved = service.getSettings();
  const { backendId, model, makeDefaultAgent } = change;
  const current = saved.nativeBackendDefaults?.[backendId];
  const profile = catalog.validateProfile(backendId, change.profileId ?? current?.profileId);
  const beforeProfileId = current?.profileId ?? catalog.validateProfile(backendId).id;
  let oldProfile: PickedProfile | undefined;
  try { oldProfile = beforeProfileId === profile.id ? profile : catalog.validateProfile(backendId, beforeProfileId); }
  catch (error) { if (!(error instanceof AppError) || error.code !== 'NATIVE_PROFILE_NOT_FOUND') throw error; }
  const updateBackend = change.profileId !== undefined || model !== undefined;
  const entry: NativeBackendDefaults = { ...current, profileId: profile.id };
  if (profile.id !== beforeProfileId) delete entry.model;
  if (model !== undefined) entry.model = model;
  const next = updateBackend ? rememberProfileModel(current, entry, MODEL_PICKER_BUDGET.rememberedProviders) : current;
  const before = {
    defaultAgentId: effectiveDefaultId, backendId, profileId: beforeProfileId,
    configuredModel: current?.model ?? null, effectiveModel: oldProfile ? effectiveModel(catalog, saved, backendId, oldProfile, current) : null,
  };
  const after = {
    defaultAgentId: makeDefaultAgent ? backendId : before.defaultAgentId, backendId, profileId: profile.id,
    configuredModel: next?.model ?? null, effectiveModel: effectiveModel(catalog, saved, backendId, profile, next),
  };
  // The derived default follows which CLIs are installed, so it is shown but not part of the revision: a probe that
  // flips between propose and apply is not a conflict.
  const revision = createHash('sha256').update(JSON.stringify([saved.defaultBackendId, { ...before, defaultAgentId: null }, { ...after, defaultAgentId: makeDefaultAgent ? backendId : null }, current, oldProfile?.config, profile.config])).digest('hex');
  const backendChanged = updateBackend && (before.profileId !== after.profileId || before.configuredModel !== after.configuredModel);
  // Compared with what is saved: making the derived default the default pins it, so it stops following the CLIs.
  const agentChanged = makeDefaultAgent && saved.defaultBackendId !== backendId;
  const patch = {
    ...(agentChanged ? { defaultBackendId: backendId } : {}),
    ...(backendChanged ? { nativeBackendDefaults: { ...saved.nativeBackendDefaults, [backendId]: entry } } : {}),
  };
  return { before, after, revision, patch, changed: backendChanged || agentChanged };
}

async function validateChoice(catalog: Catalog, change: Change, profileId: string, configuredModel: string | null) {
  try { await validateBackendDefaults(catalog, change.backendId, profileId, change.model); }
  catch (error) {
    if (error instanceof AppError && ['NATIVE_MODEL_UNSUPPORTED', 'NATIVE_PROFILE_NOT_FOUND'].includes(error.code)) throw error;
    throw new AppError('AGENT_DEFAULTS_UNAVAILABLE', 'Check this Agent and provider in Riffet Agent Settings, then request a new change.', 409);
  }
  const entry = await readCatalog(catalog, change.backendId, profileId);
  if (!entry) throw new AppError('AGENT_DEFAULTS_UNAVAILABLE', 'Check that the Agent and provider are available in Riffet Agent Settings, then request a new change.', 409);
  if (change.model !== undefined && !entry.models.some(item => item.value === change.model)) {
    throw new AppError('INVALID_MODEL', 'Choose a model listed for this provider by settings.agent_defaults.');
  }
  // A saved full selection can include parameters and aliases that the Agent settings keep on a provider switch.
  if (change.model === undefined && configuredModel && change.profileId !== undefined) {
    const modelId = parseSelection(configuredModel).model;
    if (!entry.models.some(item => item.value === configuredModel || item.value === modelId || item.aliases?.includes(modelId))) {
      throw new AppError('INVALID_MODEL', 'The provider’s remembered model is absent from its catalog. Choose a listed model explicitly.');
    }
  }
}

type Snapshot = ReturnType<typeof settingSnapshot>;
type Proposal = {
  sessionId: string; runId: string; expiresAt: number; code: string;
  change: Change; revision: string; before: Snapshot['before']; after: Snapshot['after'];
  appliedRunId?: string;
};

const expired = () => new AppError('SETTING_CONFIRMATION_EXPIRED', 'Ask for a fresh default Agent or model proposal.', 409);
const conflict = () => new AppError('SETTINGS_CONFLICT', 'Agent defaults or provider settings changed. Read settings.agent_defaults and show a new proposal for confirmation.', 409);

export function agentDefaultsCommand(service: Settings, catalog: Catalog, backends: DefaultBackendSource) {
  const offeredIds = () => backends.offeredBackendIds();
  const effectiveDefault = () => defaultBackendForClient(undefined, service.getSettings().defaultBackendId, backends);
  // The instance has one main assistant and only its most recent proposal is actionable. Restart loses it.
  let pending: Proposal | undefined;
  const show = (proposal: Proposal) => ({
    status: 'confirmation_required', before: proposal.before, after: proposal.after, scope,
    confirmation: {
      text: `确认 ${proposal.code}`, expiresAt: new Date(proposal.expiresAt).toISOString(),
      instruction: 'Show the owner the proposed values and cross-client and billing effects. Ask them to send the exact confirmation text as the next standalone message in this Riffet personal assistant conversation.',
    },
  });
  const applied = (proposal: Proposal, changed: boolean) => ({ status: 'applied', changed, before: proposal.before, after: proposal.after, scope });
  const apply = async (turn: SettingCommandTurn) => {
    const proposal = pending;
    if (!proposal || proposal.sessionId !== turn.sessionId || proposal.expiresAt <= Date.now()) throw expired();
    const message = turn.ownerText?.trim();
    if (turn.previousRunId !== proposal.runId || (message !== `确认 ${proposal.code}` && message !== `confirm ${proposal.code}`)) {
      throw new AppError('SETTING_CONFIRMATION_REQUIRED', 'Have the owner send the exact confirmation as the next standalone message from the Riffet personal assistant. If another message intervened, ask for a new proposal.', 409);
    }
    if (proposal.appliedRunId === turn.runId) return applied(proposal, false);
    if (proposal.appliedRunId) throw expired();
    optionBackendId(proposal.change.backendId, offeredIds());
    const current = settingSnapshot(service, catalog, proposal.change, await effectiveDefault());
    if (current.revision !== proposal.revision) throw conflict();
    await validateChoice(catalog, proposal.change, proposal.after.profileId, proposal.after.configuredModel);
    turn.assertCurrent();
    if (pending !== proposal || proposal.expiresAt <= Date.now()) throw expired();
    if (proposal.appliedRunId === turn.runId) return applied(proposal, false);
    if (proposal.appliedRunId) throw expired();
    const latest = settingSnapshot(service, catalog, proposal.change, await effectiveDefault());
    if (latest.revision !== proposal.revision) throw conflict();
    service.setSettings(latest.patch);
    proposal.appliedRunId = turn.runId;
    return applied(proposal, true);
  };
  return defineSettingCommand('agent_defaults_set',
    'Change the instance default Agent or a backend’s default provider or model. Read settings.agent_defaults first. Use action propose with the chosen values and show the cross-client and billing effects. When the owner sends the exact confirmation in the next personal assistant message, call action apply with only sourceTurn.',
    commandArgs, async ({ action, backendId, profileId, model, makeDefaultAgent }, getTurn) => {
      const turn = getTurn();
      if (action === 'apply') {
        if ([backendId, profileId, model, makeDefaultAgent].some(value => value !== undefined)) throw new AppError('INVALID_ARGUMENT', 'Apply takes only action and sourceTurn. The proposed values are bound on the server.');
        return apply(turn);
      }
      if (!profileId && !model && !makeDefaultAgent) throw new AppError('INVALID_ARGUMENT', 'Choose a provider or model, or set makeDefaultAgent to true.');
      const change = { backendId: optionBackendId(backendId, offeredIds()), profileId, model, makeDefaultAgent: makeDefaultAgent === true };
      const first = settingSnapshot(service, catalog, change, await effectiveDefault());
      if (!first.changed) return { status: 'unchanged', changed: false, ...first.after, scope };
      await validateChoice(catalog, change, first.after.profileId, first.after.configuredModel);
      turn.assertCurrent();
      const latest = settingSnapshot(service, catalog, change, await effectiveDefault());
      if (latest.revision !== first.revision) throw conflict();
      if (pending?.sessionId === turn.sessionId && pending.runId === turn.runId && pending.expiresAt > Date.now() &&
        pending.revision === first.revision && JSON.stringify(pending.change) === JSON.stringify(change)) return show(pending);
      pending = { sessionId: turn.sessionId, runId: turn.runId, expiresAt: Date.now() + ASSISTANT_QUERY_BUDGET.settingConfirmationMs,
        code: `RFM-${randomBytes(6).toString('hex')}`, change, revision: first.revision, before: first.before, after: first.after };
      return show(pending);
    });
}
