import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeBackendOption } from '../../../../../packages/contracts/src/index.js';
import { launchSource, modelSourceOf, sourceEndpoint } from '../shared/model-source.js';
import type { CliVersionRange } from '../shared/cli-version.js';

/** What `--help` says a CLI build can do; each flavor decides what it needs out of it. */
export interface AppServerProbe {
  version?: string;
  appServer: boolean;
  /** `app-server --listen unix://…` */
  unixSocket: boolean;
  /** `app-server --listen ws://… --ws-auth capability-token` */
  wsAuth: boolean;
  /** `resume --remote unix://…` */
  remoteUnix: boolean;
  /** `resume --remote ws://… --remote-auth-token-env VAR` */
  remoteWs: boolean;
  /** Inline TUI mode, which leaves scrollback in the hosting terminal. */
  noAltScreen: boolean;
}

/**
 * The differences between the CLIs that speak the Codex app-server protocol.
 *
 * TRAE CLI (`traex`) is a fork of Codex: same JSON-RPC methods, notifications and server requests,
 * same rollout layout. Everything that is not the same is listed here, so the driver itself stays
 * one piece of code.
 */
export interface CodexFlavor {
  readonly id: 'codex' | 'traex';
  readonly label: string;
  readonly profileName: string;
  /** Env var naming the executable, and the bare command used when it is unset. */
  readonly executableEnv: string;
  readonly command: string;
  /** See `NativeBackendDriver.cliVersions`. */
  readonly cliVersions: CliVersionRange;
  /**
   * The `turn/start` field that tags a submitted message with the workbench's command id, and the
   * user item field the provider echoes it back in. Codex: `clientUserMessageId` → `clientId`.
   * TRAE CLI ignores that field and instead takes `userMessageId`, which becomes the item's `id`.
   */
  readonly messageTag: { request: 'clientUserMessageId' | 'userMessageId'; echo: 'clientId' | 'id' };
  readonly modes: NativeBackendOption[];
  /** Whether `thread/contextUsage` splits the context window into categories. */
  readonly contextUsage: boolean;
  /**
   * The request that ends a background terminal (`thread/backgroundTerminals/…`, experimental in both
   * CLIs). Codex answers `terminate` with `{ terminated }` and lists `data[]`; TRAE CLI calls it `stop`,
   * answers `{ outcome }` and lists bare `processIds[]`.
   */
  readonly backgroundTerminalStop: 'thread/backgroundTerminals/terminate' | 'thread/backgroundTerminals/stop';
  /** Directory holding `sessions/YYYY/MM/DD/rollout-*.jsonl`. */
  stateHome(config: Record<string, unknown>): string;
  env(config: Record<string, unknown>): Record<string, string>;
  args(config: Record<string, unknown>): string[];
  unsupportedProfileSetting(config: Record<string, unknown>): string | undefined;
  /** Why this build cannot run sessions at all, or undefined when it can. */
  unavailableReason(probe: AppServerProbe, executable: string): string | undefined;
  /** How browser and TUI share one app-server, or `none` when this build cannot attach a TUI. */
  terminalTransport(probe: AppServerProbe): 'unix' | 'ws' | 'none';
}

export const codexFlavor: CodexFlavor = {
  id: 'codex',
  label: 'Codex',
  profileName: 'Codex CLI',
  executableEnv: 'CODEX_CLI',
  command: 'codex',
  // No release is known to break the adapter; the help probe gates what it needs. Newest verified:
  // docs/STEER.md.
  cliVersions: { testedThrough: '0.160.0' },
  messageTag: { request: 'clientUserMessageId', echo: 'clientId' },
  modes: [],
  contextUsage: false,
  backgroundTerminalStop: 'thread/backgroundTerminals/terminate',
  stateHome: config => str(config.configDir) ?? (process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')),
  env(config) {
    const result: Record<string, string> = {};
    const configDir = str(config.configDir);
    if (configDir) result.CODEX_HOME = configDir;
    const source = modelSourceOf(config);
    const { resolved, credential } = launchSource(config);
    // A command credential and `env_key` are exclusive — exporting a key as well would make Codex
    // prefer the wrong one.
    if (credential?.kind === 'static') result[str(config.apiEndpoint) || source ? 'RIFFET_CODEX_API_KEY' : 'OPENAI_API_KEY'] = credential.key;
    for (const { env, value } of sourceHeaders(sourceEndpoint(resolved, 'openai-responses')?.headers)) result[env] = value;
    return result;
  },
  args(config) {
    const { resolved, credential } = launchSource(config);
    const gateway = sourceEndpoint(resolved, 'openai-responses');
    // A source supplies the address when the user did not type one; a typed endpoint still wins.
    const endpoint = gateway?.baseUrl ?? str(config.apiEndpoint);
    if (!endpoint) return [];
    if (credential) {
      return [
        '-c', 'model_provider="riffet"',
        '-c', 'model_providers.riffet.name="Riffet"',
        '-c', `model_providers.riffet.base_url=${tomlString(endpoint)}`,
        // `responses` is the only wire protocol current Codex accepts, so a custom endpoint has to
        // implement the OpenAI Responses API.
        '-c', 'model_providers.riffet.wire_api="responses"',
        ...(credential.kind === 'command' ? [
          // A credential minted per request: Codex is told to run the command rather than read a
          // key. `env_key` must not be emitted alongside this: the two are alternatives.
          '-c', `model_providers.riffet.auth.command=${tomlString(credential.command)}`,
          '-c', `model_providers.riffet.auth.args=${tomlArray(credential.args)}`,
        ] : [
          '-c', 'model_providers.riffet.env_key="RIFFET_CODEX_API_KEY"',
        ]),
        ...(resolved?.disableWebsockets ? ['-c', 'model_providers.riffet.supports_websockets=false'] : []),
        // Header values travel in the environment, next to the key, rather than in argv.
        ...sourceHeaders(gateway?.headers).flatMap(({ name, env }) => ['-c', `model_providers.riffet.env_http_headers.${tomlKey(name)}=${tomlString(env)}`]),
        // The saved API key is the only credential a third-party gateway needs; without this Codex
        // additionally demands a ChatGPT login.
        '-c', 'model_providers.riffet.requires_openai_auth=false',
      ];
    }
    // Keep the built-in OpenAI provider's normal authentication when no API key is saved.
    return ['-c', `openai_base_url=${tomlString(endpoint)}`];
  },
  unsupportedProfileSetting(config) {
    if (str(config.agentEndpoint)) return 'Codex app-server does not support a separate agent endpoint; configure API endpoint instead.';
    if (str(config.sourceDir)) return 'Codex sessions always run in the selected project workspace; a profile source directory is not supported.';
    if (config.disableAutoUpdate === true) return 'This Codex adapter cannot disable CLI auto-updates for a profile.';
    return undefined;
  },  unavailableReason(probe, executable) {
    if (!probe.appServer || !probe.unixSocket) return `Codex at “${executable}” does not expose the required Unix-socket app-server transport.`;
    if (!probe.remoteUnix) return `Codex at “${executable}” does not support attaching the native TUI to a shared app-server.`;
    return undefined;
  },
  terminalTransport: probe => probe.remoteUnix && probe.unixSocket ? 'unix' : 'none',
};

export const traexFlavor: CodexFlavor = {
  id: 'traex',
  label: 'TRAE CLI',
  profileName: 'TRAE CLI',
  executableEnv: 'TRAEX_CLI',
  command: 'traex',
  // As for Codex; newest verified: docs/TRAEX.md §11.
  cliVersions: { testedThrough: '0.211.1' },
  messageTag: { request: 'userMessageId', echo: 'id' },
  contextUsage: true,
  backgroundTerminalStop: 'thread/backgroundTerminals/stop',
  modes: [
    { id: 'default', label: 'Agent', description: 'Works on the task directly' },
    { id: 'plan', label: 'Plan', description: 'Proposes a plan first and asks before changing anything' },
  ],
  // `TRAE_HOME` is the configuration root; sessions and state live under its `cli` directory unless
  // `TRAECLI_HOME` moves them. `CODEX_HOME` is ignored by this fork.
  stateHome: config => process.env.TRAECLI_HOME?.trim()
    || join(str(config.configDir) ?? (process.env.TRAE_HOME?.trim() || join(homedir(), '.trae')), 'cli'),
  env(config): Record<string, string> {
    const configDir = str(config.configDir);
    return configDir ? { TRAE_HOME: configDir } : {};
  },
  args: () => [],
  unsupportedProfileSetting(config) {
    if (str(config.apiEndpoint) || str(config.apiKey) || str(config.agentEndpoint) || modelSourceOf(config)) return 'TRAE CLI signs in with its own TRAE account; a service address or API key is not supported.';
    if (str(config.sourceDir)) return 'TRAE CLI sessions always run in the selected project workspace; a profile source directory is not supported.';
    if (config.disableAutoUpdate === true) return 'This TRAE CLI adapter cannot disable CLI auto-updates for a profile.';
    return undefined;
  },
  unavailableReason(probe, executable) {
    if (!probe.appServer || (!probe.unixSocket && !probe.wsAuth)) return `TRAE CLI at “${executable}” does not expose an app-server transport this workbench can use.`;
    return undefined;
  },
  // This fork's TUI only attaches over WebSocket, and only an authenticated loopback listener is as
  // private as the Unix socket Codex uses.
  terminalTransport: probe => probe.wsAuth && probe.remoteWs ? 'ws' : 'none',
};

/**
 * Whether a Codex profile talks to a provider of its own (a named source, or a typed endpoint with a
 * credential) rather than the CLI's built-in OpenAI one. Such a profile neither lists the built-in
 * catalog nor owns the ChatGPT account the CLI may still be signed in to.
 */
export function usesOwnProvider(config: Record<string, unknown>): boolean {
  if (modelSourceOf(config)) return true;
  return Boolean(str(config.apiEndpoint) && launchSource(config).credential);
}

export function readProbe(version: string, appHelp: string, resumeHelp: string): AppServerProbe {
  const remote = /--remote\s+<ADDR>/i.test(resumeHelp);
  return {
    // TRAE prints installation metadata after its version. Only a recognized version line counts.
    version: version.split(/\r?\n/).map(line => line.trim()).find(line => /^(?:codex(?:-cli)?|traecli|traex)\s+v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(line)),
    appServer: /app-server/i.test(appHelp) && /Usage:/i.test(appHelp),
    unixSocket: /unix:\/\//.test(appHelp),
    wsAuth: /--ws-auth\b/.test(appHelp) && /--ws-token-file\b/.test(appHelp) && /ws:\/\//.test(appHelp),
    remoteUnix: remote && /unix:\/\//.test(resumeHelp),
    remoteWs: remote && /--remote-auth-token-env\b/.test(resumeHelp),
    noAltScreen: /--no-alt-screen\b/.test(resumeHelp),
  };
}

export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** A TOML array of strings, for `-c` values that take a list. */
export function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function str(value: unknown): string | undefined { return typeof value === 'string' && value.length ? value : undefined; }

/**
 * The variable a source header's value is exported under: `RIFFET_SOURCE_HEADER_` and the header's name in capitals
 * (`X-Acme-Client` → `RIFFET_SOURCE_HEADER_X_ACME_CLIENT`). A source supplies the names, so they get a prefix nothing else
 * in a launch uses: under plain `RIFFET_`, a header called `codex-api-key` or `hook-url` would replace that variable.
 */
const SOURCE_HEADER_ENV = 'RIFFET_SOURCE_HEADER_';

/** Each header of a source with its variable and value; names that capitalise alike get a numbered variable each. */
function sourceHeaders(headers: Record<string, string> | undefined): Array<{ name: string; env: string; value: string }> {
  const taken = new Set<string>();
  return Object.entries(headers ?? {}).map(([name, value]) => {
    const base = SOURCE_HEADER_ENV + name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
    let env = base;
    for (let index = 2; taken.has(env); index++) env = `${base}_${index}`;
    taken.add(env);
    return { name, env, value };
  });
}

function tomlKey(name: string): string { return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name); }
