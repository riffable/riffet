// The "additive only within an API version" promise of `index.ts`, checked by the ordinary `tsc --noEmit`.
//
// `../released/<version>/` holds the declarations of the root entry as that package version was released
// (`scripts/gen-plugin-api-released.ts`, regenerated with `pnpm gen:plugin-api` only when the SDK version is
// bumped). Two directions, because a type either comes from the host or goes to it:
//
// - Host-provided (what the host hands a plugin): the current type must be assignable to the released one, so the host
//   still gives everything it promised. A removed or retyped member fails here.
// - Plugin-provided (what a plugin hands the host): the released type must be assignable to the current one, so a plugin
//   written against the release still satisfies today's interface. A new required member fails here.
//
// Method-shorthand members compare their parameters bivariantly, which hides a retyped parameter; the host methods
// plugins call most are therefore compared on parameters and result explicitly.
//
// A failing line is a break: make the change additive, or bump `PLUGIN_API_VERSION` (and the SDK version with a new baseline).

import type * as Current from './index.js';
import type * as Released from '../released/1.0.0/index.js';

/**
 * Proposed members are outside the promise. They are available to in-process packages only (built-in, development,
 * trusted installs), may change without an API version bump, and graduate to the promise when a second independent
 * consumer exists. Their types reference the experimental Agent protocol, which is why they are omitted from the
 * assertions below rather than compared.
 */
export const PROPOSED_CONTRIBUTIONS = ['agentBackends', 'runtimeHooks', 'services', 'channels', 'agentTools'] as const;
export const PROPOSED_HOST_MEMBERS = ['agentProfiles', 'services', 'sessions'] as const;

type Proposed = (typeof PROPOSED_CONTRIBUTIONS)[number];
type ProposedHost = (typeof PROPOSED_HOST_MEMBERS)[number];

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
/** The member of `Current` is assignable to the one of `Released`. */
type Provides<C, R> = Extends<C, R>;
/** The member of `Released` is assignable to the one of `Current`. */
type Accepts<C, R> = Extends<R, C>;

/** A host method a plugin calls: a released caller's arguments are accepted and the result is still what it was promised. */
type MethodKept<C extends (...args: never[]) => unknown, R extends (...args: never[]) => unknown> =
  [Extends<Parameters<R>, Parameters<C>>, Extends<ReturnType<C>, ReturnType<R>>] extends [true, true] ? true : false;

type HostOf<T> = Omit<T, ProposedHost>;
type ContributionsOf<T> = Omit<T, Proposed>;

// ── Host-provided: current ⊆ released ───────────────────────────────────────

export type HostProvided = [
  Assert<Provides<HostOf<Current.PluginHost>, HostOf<Released.PluginHost>>>,
  Assert<Provides<Current.ActivationScope, Released.ActivationScope>>,
  Assert<Provides<Current.ProjectContext, Released.ProjectContext>>,
  Assert<Provides<Current.DiagnosticsContext, Released.DiagnosticsContext>>,
  Assert<Provides<Current.CommandContext, Released.CommandContext>>,
  Assert<Provides<Current.AgentToolContext, Released.AgentToolContext>>,
  Assert<Provides<Current.PluginChannelContext, Released.PluginChannelContext>>,
  Assert<Provides<Current.PluginChannelSocket, Released.PluginChannelSocket>>,
  Assert<Provides<Current.RuntimeContext, Released.RuntimeContext>>,
  Assert<Provides<Current.PluginPageContext, Released.PluginPageContext>>,
  Assert<Provides<Current.AvatarStyleRequest, Released.AvatarStyleRequest>>,
  Assert<Provides<Current.PluginSessionView, Released.PluginSessionView>>,
  // The host methods plugins call most.
  Assert<MethodKept<Current.PluginHost['runProcess'], Released.PluginHost['runProcess']>>,
  Assert<MethodKept<Current.PluginHost['resolveCli'], Released.PluginHost['resolveCli']>>,
  Assert<MethodKept<Current.PluginHost['stateDir'], Released.PluginHost['stateDir']>>,
  Assert<MethodKept<Current.PluginHost['settings'], Released.PluginHost['settings']>>,
  Assert<MethodKept<Current.PluginHost['secrets']['get'], Released.PluginHost['secrets']['get']>>,
  Assert<MethodKept<Current.PluginHost['secrets']['set'], Released.PluginHost['secrets']['set']>>,
  Assert<MethodKept<Current.PluginHost['gateway']['fetchModels'], Released.PluginHost['gateway']['fetchModels']>>,
];

// ── Plugin-provided: released ⊆ current ─────────────────────────────────────

export type PluginProvided = [
  Assert<Accepts<Omit<Current.Plugin, 'activate'>, Omit<Released.Plugin, 'activate'>>>,
  Assert<Accepts<ContributionsOf<Awaited<ReturnType<Current.Plugin['activate']>>>, ContributionsOf<Awaited<ReturnType<Released.Plugin['activate']>>>>>,
  Assert<Accepts<Current.PluginManifest, Released.PluginManifest>>,
  Assert<Accepts<ContributionsOf<Current.Contributions>, ContributionsOf<Released.Contributions>>>,
  Assert<Accepts<Current.ModelSourceProvider, Released.ModelSourceProvider>>,
  Assert<Accepts<Current.ResolvedSource, Released.ResolvedSource>>,
  Assert<Accepts<Current.SourceOverrides, Released.SourceOverrides>>,
  Assert<Accepts<Current.SharePublisher, Released.SharePublisher>>,
  Assert<Accepts<Current.NativeRuntimeHook, Released.NativeRuntimeHook>>,
  Assert<Accepts<Current.RuntimeAttachment, Released.RuntimeAttachment>>,
  Assert<Accepts<Current.ActionHandler, Released.ActionHandler>>,
  Assert<Accepts<Current.DeviceFlow, Released.DeviceFlow>>,
  Assert<Accepts<Current.DoctorCheck, Released.DoctorCheck>>,
  Assert<Accepts<Current.TaskProvider, Released.TaskProvider>>,
  Assert<Accepts<Current.TaskPlan, Released.TaskPlan>>,
  Assert<Accepts<Current.TaskActionSpec, Released.TaskActionSpec>>,
  Assert<Accepts<Current.CommandHandler, Released.CommandHandler>>,
  Assert<Accepts<Current.PluginPageProvider, Released.PluginPageProvider>>,
  Assert<Accepts<Current.AvatarStyleProvider, Released.AvatarStyleProvider>>,
  Assert<Accepts<Current.AgentToolGroup, Released.AgentToolGroup>>,
  Assert<Accepts<Current.AgentToolDefinition, Released.AgentToolDefinition>>,
  Assert<Accepts<Current.AgentToolResult, Released.AgentToolResult>>,
  Assert<Accepts<Current.PluginChannelHandler, Released.PluginChannelHandler>>,
];
