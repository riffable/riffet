import { resolve as resolvePath } from 'node:path';
import type { CommandObservation } from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import { queryDirectory } from '../shared/query-directory.js';
import type { NativeBackendProfileConfig, NativeDriverCommandObservation } from '../types.js';
import { executableOf } from './config.js';
import type { CodexFlavor } from './flavors.js';
import type { CodexObservation } from './observation.js';

/** How long the settings page is answered from the last read of whether commands are observed. */
const OBSERVATION_READ_MS = 5 * 60_000;

interface CommandObservationContext {
  readonly flavor: CodexFlavor;
  readonly observation: CodexObservation;
  withTransport<T>(project: undefined, profile: NativeBackendProfileConfig, session: undefined, read: (transport: CodexAppServerClient) => Promise<T>, extraArgs: string[]): Promise<T>;
}

/** Whether the hooks that observe commands are trusted by the CLI, for the settings page. */
export function commandObservationOf(ctx: CommandObservationContext): NativeDriverCommandObservation {
    // Read, and trusted, through a management server started with the same hooks a conversation's server gets:
    // the trust is keyed by what the hooks are, so it holds for every later launch.
      // A read starts a server, so a settings page shown again within a few minutes is answered from the last one.
    const read = new Map<string, { at: number; state: CommandObservation['state'] }>();
    const cacheKey = (profile: NativeBackendProfileConfig) => JSON.stringify([executableOf(profile, ctx.flavor), resolvePath(ctx.flavor.stateHome(profile.config))]);
    const through = async (profile: NativeBackendProfileConfig, act: (transport: CodexAppServerClient, cwd: string) => Promise<CommandObservation['state']>): Promise<CommandObservation> => {
      const executable = executableOf(profile, ctx.flavor);
      const hooks = await ctx.observation.launchArgs(executable);
      if (!hooks.length) return { state: 'unsupported' };
      const cwd = await queryDirectory(undefined, profile);
      const state = await ctx.withTransport(undefined, profile, undefined, transport => act(transport, cwd), hooks);
      read.set(cacheKey(profile), { at: Date.now(), state });
      return { state };
    };
    return {
      state: async (_host, profile) => {
        const known = read.get(cacheKey(profile));
        if (known && Date.now() - known.at < OBSERVATION_READ_MS) return { state: known.state };
        return await through(profile, (transport, cwd) => ctx.observation.probe(transport, cwd));
      },
      trust: (_host, profile) => through(profile, (transport, cwd) => ctx.observation.trust(transport, cwd)),
    };
}
