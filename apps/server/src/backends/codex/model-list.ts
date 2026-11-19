import type { ModelInfo, NativeBackendUsage, Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import { fetchGatewayModels } from '../shared/gateway-models.js';
import { modelSourceOf, sourceCatalog } from '../shared/model-source.js';
import type { NativeBackendProfileConfig } from '../types.js';
import { listModels, readUsage } from './catalog.js';
import type { CodexFlavor } from './flavors.js';
import { usesOwnProvider } from './flavors.js';
import { str } from './util.js';

export interface ModelListContext {
  readonly flavor: CodexFlavor;
  readonly consumesProtocols: readonly string[];
  withTransport<T>(project: Project | undefined, profile: NativeBackendProfileConfig, session: Session | undefined, read: (transport: CodexAppServerClient) => Promise<T>): Promise<T>;
}

export async function listModelsOf(ctx: ModelListContext, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<ModelInfo[]> {
  // A named source publishes its own catalog over HTTP, so it is answered without starting an
  // app-server — and for some sources it is the only answer there is, since their models are not
  // in any Codex-side listing.
  const source = modelSourceOf(profile.config);
  if (source) return await sourceCatalog(source, ctx.consumesProtocols ?? [], profile.config);
  const builtIn = () => ctx.withTransport(project, profile, session, transport => listModels(transport, ctx.flavor));
  // A typed endpoint with a key is a provider of its own: the app-server's `model/list` still
  // answers from Codex's built-in OpenAI catalog and never asks it, so the gateway says which
  // models exist. Many gateways list bare ids, so a model Codex also knows keeps Codex's effort
  // ladder and Fast tier; listing it also teaches the driver that tier's request value.
  if (ctx.flavor.id === 'codex' && usesOwnProvider(profile.config)) {
    const apiKey = str(profile.config.apiKey);
    const [served, known] = await Promise.all([
      fetchGatewayModels({ baseUrl: str(profile.config.apiEndpoint)!, ...(apiKey ? { apiKey } : {}), reasoningLevels: true }),
      builtIn().catch(() => [] as ModelInfo[]),
    ]);
    const byId = new Map(known.map(model => [model.value, model]));
    return served.map(model => {
      const codex = byId.get(model.value);
      if (!codex) return model;
      // The gateway's declared ladder is what it accepts; Codex's fills in when it declares none.
      const own = new Set(model.configOptions.map(option => option.id));
      return { ...model, name: model.name === model.value ? codex.name : model.name, configOptions: [...model.configOptions, ...codex.configOptions.filter(option => !own.has(option.id))] };
    });
  }
  return await builtIn();
}

export async function usageOf(ctx: Pick<ModelListContext, 'flavor' | 'withTransport'>, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<NativeBackendUsage> {
  // TRAE's managed runtime route stops the CLI from publishing its internal daily bindings, so
  // usage reads through a fresh read-only CLI with the same profile instead of a live session.
  // Explicit profile or global configuration still reaches that CLI through the normal env.
  const live = ctx.flavor.id === 'traex' ? undefined : session;
  return await ctx.withTransport(project, profile, live, transport => readUsage(transport, ctx.flavor, { account: !usesOwnProvider(profile.config) }));
}
