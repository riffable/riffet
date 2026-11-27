import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentProfile } from '@riffet/plugin-api/experimental/agent';

/*
 * Cursor profiles beyond the built-in one (docs: plugins/riffet/cursor/README.md「提供商」).
 *
 * `CURSOR_CONFIG_DIR` holds what belongs to one account: `cli-config.json` (`authInfo`, `privacyCache`,
 * `serverConfigCache`, the selected model, `network.useHttp1ForAgent`), `chats/` and `statsig-cache.json`.
 * The CLI has no flag or variable for any of these, so two accounts sharing a directory overwrite each
 * other. A profile that connects through its own gateway therefore gets a directory of its own under the
 * state directory, unless it names one. A profile on the CLI's own login keeps the login's directory
 * (`~/.cursor`), the one a terminal `cursor-agent` uses. Rules, skills, hooks and MCP servers come from
 * `CURSOR_DATA_DIR` and the home directory, which every profile keeps sharing.
 */

/** The profile `cursor-cli.json` stores (`apps/server/src/settings/cursor-compat.ts`). */
export const CURSOR_DEFAULT_PROFILE_ID = 'default';

/** `cli-config.json` keys that are the user's preferences rather than an account's state, copied into a new directory. */
const SHARED_PREFERENCES = ['version', 'permissions', 'approvalMode', 'sandbox', 'attribution', 'autoAcceptWebSearch', 'display', 'editor', 'notifications', 'rewind', 'steering', 'exploreSubagentModel'] as const;

/** Where a gateway profile without a directory of its own keeps its CLI state. Profile ids are path-safe (`[A-Za-z0-9][A-Za-z0-9._-]*`). */
export function cursorProfileDir(stateDir: string, profileId: string): string {
  return join(stateDir, 'cursor-profiles', profileId);
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * The launch config of `profile`. The built-in profile is used as stored. Another profile takes the CLI
 * management the built-in one holds (executable, auto-update: one CLI per machine) unless it sets its own,
 * sends agent traffic to its gateway unless it names another endpoint, and runs a gateway in its own directory.
 */
export function cursorProfileConfig(profile: AgentProfile, builtin: Record<string, unknown> | undefined, stateDir: string): Record<string, unknown> {
  if (profile.id === CURSOR_DEFAULT_PROFILE_ID) return profile.config;
  const config: Record<string, unknown> = { ...profile.config };
  for (const key of ['executable', 'cliPath', 'disableAutoUpdate'] as const) {
    if (config[key] === undefined && builtin?.[key] !== undefined) config[key] = builtin[key];
  }
  const endpoint = text(config.apiEndpoint);
  if (endpoint && !text(config.agentEndpoint)) config.agentEndpoint = endpoint;
  if (!text(config.configDir) && (endpoint || text(config.apiKey))) config.configDir = cursorProfileDir(stateDir, profile.id);
  return config;
}

/**
 * Creates a gateway profile's directory on first use, with the preferences of the login's `cli-config.json`
 * (`sourceDir`) and none of its account state. Agent traffic goes over HTTP/1: a gateway that does not carry
 * HTTP/2 streams end to end fails every turn with `Server error`, and HTTP/1 is the transport the CLI itself
 * falls back to. An existing `cli-config.json` is left alone, so a later `/config` change stays; a failure
 * leaves the CLI to write its own defaults.
 */
export function prepareCursorProfileDir(dir: string, sourceDir: string): void {
  const target = join(dir, 'cli-config.json');
  if (existsSync(target)) return;
  let temporary: string | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let source: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(sourceDir, 'cli-config.json'), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) source = parsed as Record<string, unknown>;
    } catch { /* no login configuration to copy from */ }
    const seeded = { ...Object.fromEntries(SHARED_PREFERENCES.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]])), network: { useHttp1ForAgent: true } };
    temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(seeded, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
    temporary = undefined;
  } catch { /* the CLI creates the file itself */ }
  finally {
    if (temporary) try { unlinkSync(temporary); } catch { /* already gone */ }
  }
}
