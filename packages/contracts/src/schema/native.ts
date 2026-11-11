import { z } from 'zod/v4';
import { NATIVE_BACKEND_IDS, PLUGIN_AGENT_ID, PLUGIN_AGENT_ID_MAX } from '../index.js';

/**
 * Kotlin keeps this strict; new backend values reach only clients that named their feature.
 * `negotiated` lists enum values; `negotiatedPattern` says any further string matching it (a plugin's
 * Agent id, `PluginAgentId`) may also arrive, again only for a client that advertises `plugin-agents`.
 * The node stays an enum so the released snapshot compares as before; the pattern is documentation the
 * compatibility check (`compat.ts`) reads as "not a break".
 */
export const NativeBackendIdSchema = z.enum(NATIVE_BACKEND_IDS).meta({
  negotiated: ['chat', 'pi'],
  negotiatedPattern: { feature: 'plugin-agents', pattern: PLUGIN_AGENT_ID.source, maxLength: PLUGIN_AGENT_ID_MAX },
});
