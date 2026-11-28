import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackendTier, BuiltinCliBackendId } from '../manifest.js';
import {
  DEFAULT_CLAUDE_TOOLS,
  DEFAULT_GENERIC_TOOLS,
  type MockLlmHub,
  type TckToolMap,
} from '../mock-llm/index.js';
import type { CompatSandbox } from '../sandbox.js';

export type BackendProtocol =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-chat'
  | 'google-generative-ai'
  | 'proprietary';

export type BackendToolArgProfile = 'claude' | 'codex' | 'pi' | 'droid' | 'generic';

export type BackendToolMap = TckToolMap & {
  readonly argProfile?: BackendToolArgProfile;
};

export interface BuildProfileInput {
  mockHub: MockLlmHub;
  sandbox: CompatSandbox;
  executable?: string;
  model?: string;
  profileId?: string;
  live?: boolean;
}

export interface BuiltProfileSpec {
  profileId: string;
  payload: Record<string, unknown>;
  model?: string;
  liveOnly?: boolean;
  note?: string;
}

export interface BackendCompatSpec {
  readonly id: BuiltinCliBackendId | string;
  readonly label: string;
  readonly tier: BackendTier;
  readonly protocol: BackendProtocol;
  readonly defaultCommand: string;
  readonly executableEnvVar?: string;
  readonly defaultModel: string;
  readonly toolMap: BackendToolMap;
  /** Built-in plugin ID that must be enabled when booting the in-process server. */
  readonly requiresPlugin?: 'riffet.cursor' | 'riffet.antigravity' | string;
  /** External development plugin directory loaded via `RIFFET_DEV_PLUGINS`. */
  readonly pluginDir?: string;
  /** Matches the driver's `traits.survivesRestart` declaration. */
  readonly supportsRestartTakeover: boolean;
  /** Whether the backend supports Riffet background tasks + stopActivity lifecycle. */
  readonly supportsBackgroundTasks: boolean;
  /** Whether the backend supports subagent invocation / child lanes. */
  readonly supportsSubagents: boolean;
  /** Backend-specific approval mode identifiers for approval vs auto-run scenarios. */
  readonly approvalModes?: {
    readonly ask?: string;
    readonly auto?: string;
  };
  /** Optional isolated CLI home initialization (e.g. Claude onboarding, Codex config.toml, Droid BYOK). */
  prepareCliHome?(input: { sandbox: CompatSandbox; mockHub: MockLlmHub; model: string }): Promise<void>;
  /** Extra process env vars applied while running TCK for this backend. */
  extraEnv?(input: { sandbox: CompatSandbox; mockHub: MockLlmHub }): Record<string, string>;
  /** Builds the `POST /api/backends/:id/profiles` payload for isolated TCK runs. */
  buildProfilePayload(input: BuildProfileInput): BuiltProfileSpec;
}

export interface ExternalPluginBackendOptions {
  pluginDir: string;
  label?: string;
  tier?: BackendTier;
  protocol?: BackendProtocol;
  command?: string;
  model?: string;
  toolMap?: Partial<BackendToolMap>;
  supportsRestartTakeover?: boolean;
  supportsBackgroundTasks?: boolean;
  supportsSubagents?: boolean;
  requiresPlugin?: string;
}

const CLAUDE_TCK_TOOLS: BackendToolMap = {
  ...DEFAULT_CLAUDE_TOOLS,
  argProfile: 'claude',
};

const CODEX_TCK_TOOLS: BackendToolMap = {
  read: 'read_file',
  write: 'apply_patch',
  bash: 'exec_command',
  subagent: 'spawn_agent',
  askUser: 'request_user_input',
  argProfile: 'codex',
};

const PI_TCK_TOOLS: BackendToolMap = {
  read: 'read',
  write: 'write',
  bash: 'bash',
  subagent: 'subagent',
  askUser: 'ask_user',
  argProfile: 'pi',
};

const DSH_TCK_TOOLS: BackendToolMap = {
  read: 'read_file',
  write: 'write_file',
  bash: 'run_shell',
  subagent: 'subagent',
  askUser: 'ask_user',
  argProfile: 'generic',
};

const DROID_TCK_TOOLS: BackendToolMap = {
  read: 'Read',
  write: 'Create',
  bash: 'Execute',
  subagent: 'Task',
  askUser: 'AskUser',
  argProfile: 'droid',
};

const ANTIGRAVITY_TCK_TOOLS: BackendToolMap = {
  read: 'read_file',
  write: 'write_file',
  bash: 'run_shell_command',
  subagent: 'subagent',
  askUser: 'ask_user',
  argProfile: 'generic',
};

const CURSOR_TCK_TOOLS: BackendToolMap = {
  read: 'Read',
  write: 'Write',
  bash: 'Shell',
  subagent: 'Task',
  askUser: 'AskQuestion',
  argProfile: 'generic',
};

function resolvedExecutable(spec: { defaultCommand: string; executableEnvVar?: string }, override?: string): string {
  if (override?.trim()) return override.trim();
  if (spec.executableEnvVar) {
    const fromEnv = process.env[spec.executableEnvVar]?.trim();
    if (fromEnv) return fromEnv;
  }
  return spec.defaultCommand;
}

const CLAUDE_MOCK_API_KEY = 'tck-mock-anthropic-key';

export const BUILTIN_BACKEND_SPECS: Record<BuiltinCliBackendId, BackendCompatSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    tier: 'A',
    protocol: 'anthropic-messages',
    defaultCommand: 'claude',
    executableEnvVar: 'CLAUDE_CLI',
    defaultModel: 'claude-mock-4',
    toolMap: CLAUDE_TCK_TOOLS,
    supportsRestartTakeover: true,
    supportsBackgroundTasks: true,
    supportsSubagents: true,
    approvalModes: { ask: 'manual', auto: 'bypassPermissions' },
    async prepareCliHome({ sandbox }) {
      const claudeDir = join(sandbox.cliHome, 'claude');
      await mkdir(claudeDir, { recursive: true, mode: 0o700 });
      const claudeJson = {
        hasCompletedOnboarding: true,
        numStartups: 1,
        projects: {
          [sandbox.projectDir]: {
            hasTrustDialogAccepted: true,
            allowedTools: [],
          },
        },
        customApiKeyResponses: {
          approved: [CLAUDE_MOCK_API_KEY.slice(-20)],
          rejected: [],
        },
      };
      const settingsJson = {
        skipDangerousModePermissionPrompt: true,
      };
      await Promise.all([
        writeFile(join(claudeDir, '.claude.json'), `${JSON.stringify(claudeJson, null, 2)}\n`, { mode: 0o600 }),
        writeFile(join(claudeDir, 'settings.json'), `${JSON.stringify(settingsJson, null, 2)}\n`, { mode: 0o600 }),
      ]);
    },
    buildProfilePayload({ mockHub, sandbox, executable, model, profileId, live }) {
      const id = profileId ?? 'compat-claude';
      const chosenModel = model ?? 'claude-mock-4';
      const execPath = resolvedExecutable({ defaultCommand: 'claude', executableEnvVar: 'CLAUDE_CLI' }, executable);
      if (live) {
        return {
          profileId: id,
          model: model,
          payload: {
            id,
            name: 'Compat Claude (live)',
            executable: execPath,
            disableAutoUpdate: true,
          },
        };
      }
      return {
        profileId: id,
        model: chosenModel,
        payload: {
          id,
          name: 'Compat Claude (mock)',
          executable: execPath,
          configDir: join(sandbox.cliHome, 'claude'),
          apiEndpoint: mockHub.url,
          apiKey: CLAUDE_MOCK_API_KEY,
          defaultModel: chosenModel,
          enabledModels: [chosenModel],
          disableAutoUpdate: true,
        },
      };
    },
  },

  codex: {
    id: 'codex',
    label: 'Codex',
    tier: 'A',
    protocol: 'openai-responses',
    defaultCommand: 'codex',
    executableEnvVar: 'CODEX_CLI',
    defaultModel: 'gpt-5-mock',
    toolMap: CODEX_TCK_TOOLS,
    supportsRestartTakeover: true,
    supportsBackgroundTasks: true,
    supportsSubagents: true,
    // `read-only` forces approval for workspace writes (matching codex/recording.ts), while `danger-full-access` runs non-interactively.
    approvalModes: { ask: 'read-only', auto: 'danger-full-access' },
    async prepareCliHome({ sandbox, mockHub, model }) {
      const codexDir = join(sandbox.cliHome, 'codex');
      await mkdir(codexDir, { recursive: true, mode: 0o700 });
      const configToml = [
        `model = ${JSON.stringify(model)}`,
        'model_provider = "riffet"',
        '',
        '[model_providers.riffet]',
        'name = "Riffet"',
        `base_url = ${JSON.stringify(`${mockHub.url}/v1`)}`,
        'wire_api = "responses"',
        'env_key = "RIFFET_CODEX_API_KEY"',
        'requires_openai_auth = false',
        'supports_websockets = false',
        '',
      ].join('\n');
      await writeFile(join(codexDir, 'config.toml'), configToml, { mode: 0o600 });
    },
    buildProfilePayload({ mockHub, sandbox, executable, model, profileId, live }) {
      const id = profileId ?? 'compat-codex';
      const chosenModel = model ?? 'gpt-5-mock';
      const execPath = resolvedExecutable({ defaultCommand: 'codex', executableEnvVar: 'CODEX_CLI' }, executable);
      if (live) {
        return {
          profileId: id,
          model,
          payload: {
            id,
            name: 'Compat Codex (live)',
            executable: execPath,
          },
        };
      }
      // Note: Codex rejects `sourceDir` and `disableAutoUpdate: true` in profile validation.
      return {
        profileId: id,
        model: chosenModel,
        payload: {
          id,
          name: 'Compat Codex (mock)',
          executable: execPath,
          configDir: join(sandbox.cliHome, 'codex'),
          apiEndpoint: `${mockHub.url}/v1`,
          apiKey: 'tck-mock-openai-key',
          defaultModel: chosenModel,
          enabledModels: [chosenModel],
        },
      };
    },
  },

  traex: {
    id: 'traex',
    label: 'TRAE CLI',
    tier: 'B',
    protocol: 'openai-responses',
    defaultCommand: 'traex',
    executableEnvVar: 'TRAEX_CLI',
    defaultModel: 'gpt-5-mock',
    toolMap: CODEX_TCK_TOOLS,
    supportsRestartTakeover: true,
    supportsBackgroundTasks: true,
    supportsSubagents: true,
    // `read-only` forces approval for workspace writes (matching codex/recording.ts), while `danger-full-access` runs non-interactively.
    approvalModes: { ask: 'read-only', auto: 'danger-full-access' },
    async prepareCliHome({ sandbox }) {
      await mkdir(join(sandbox.cliHome, 'traex'), { recursive: true, mode: 0o700 });
    },
    buildProfilePayload({ sandbox, executable, model, profileId, live }) {
      const id = profileId ?? 'compat-traex';
      const execPath = resolvedExecutable({ defaultCommand: 'traex', executableEnvVar: 'TRAEX_CLI' }, executable);
      // TRAE CLI uses its own account login and rejects custom apiEndpoint/apiKey in profile settings.
      return {
        profileId: id,
        model,
        liveOnly: !live,
        note: 'TRAE CLI signs in with its own account; full turns require --live mode.',
        payload: {
          id,
          name: live ? 'Compat TRAE CLI (live)' : 'Compat TRAE CLI (hybrid)',
          executable: execPath,
          ...(live ? {} : { configDir: join(sandbox.cliHome, 'traex') }),
        },
      };
    },
  },

  pi: {
    id: 'pi',
    label: 'pi',
    tier: 'A',
    protocol: 'anthropic-messages',
    defaultCommand: 'pi',
    executableEnvVar: 'PI_CLI',
    defaultModel: 'claude-mock-4',
    toolMap: PI_TCK_TOOLS,
    supportsRestartTakeover: false,
    supportsBackgroundTasks: false,
    supportsSubagents: false,
    async prepareCliHome({ sandbox }) {
      await mkdir(join(sandbox.cliHome, 'pi'), { recursive: true, mode: 0o700 });
    },
    buildProfilePayload({ mockHub, sandbox, executable, model, profileId, live }) {
      const id = profileId ?? 'compat-pi';
      const chosenModel = model ?? 'claude-mock-4';
      const execPath = resolvedExecutable({ defaultCommand: 'pi', executableEnvVar: 'PI_CLI' }, executable);
      if (live) {
        return {
          profileId: id,
          model,
          payload: {
            id,
            name: 'Compat pi (live)',
            executable: execPath,
          },
        };
      }
      return {
        profileId: id,
        model: chosenModel,
        payload: {
          id,
          name: 'Compat pi (mock)',
          executable: execPath,
          configDir: join(sandbox.cliHome, 'pi'),
          apiEndpoint: mockHub.url,
          apiProtocol: 'anthropic-messages',
          apiKey: 'tck-mock-pi-key',
          defaultModel: chosenModel,
          enabledModels: [chosenModel],
          modelInputModalities: { [chosenModel]: ['text', 'image'] },
        },
      };
    },
  },

  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness',
    tier: 'A',
    protocol: 'openai-chat',
    defaultCommand: 'dsh',
    executableEnvVar: 'DSH_CLI',
    defaultModel: 'gpt-4o-mock',
    toolMap: DSH_TCK_TOOLS,
    supportsRestartTakeover: false,
    supportsBackgroundTasks: false,
    supportsSubagents: true,
    approvalModes: { ask: 'read-only', auto: 'danger-full-access' },
    async prepareCliHome({ sandbox }) {
      await mkdir(join(sandbox.cliHome, 'dsh'), { recursive: true, mode: 0o700 });
    },
    buildProfilePayload({ mockHub, sandbox, executable, model, profileId, live }) {
      const id = profileId ?? 'compat-dsh';
      const chosenModel = model ?? 'gpt-4o-mock';
      const execPath = resolvedExecutable({ defaultCommand: 'dsh', executableEnvVar: 'DSH_CLI' }, executable);
      if (live) {
        return {
          profileId: id,
          model,
          payload: {
            id,
            name: 'Compat DSH (live)',
            executable: execPath,
          },
        };
      }
      return {
        profileId: id,
        model: chosenModel,
        payload: {
          id,
          name: 'Compat DSH (mock)',
          executable: execPath,
          configDir: join(sandbox.cliHome, 'dsh'),
          apiEndpoint: `${mockHub.url}/v1`,
          apiKey: 'tck-mock-dsh-key',
          defaultModel: chosenModel,
          enabledModels: [chosenModel],
          modelInputModalities: { [chosenModel]: ['text', 'image'] },
        },
      };
    },
  },

  droid: {
    id: 'droid',
    label: 'Factory Droid',
    tier: 'A',
    protocol: 'anthropic-messages',
    defaultCommand: 'droid',
    executableEnvVar: 'DROID_CLI',
    defaultModel: 'custom:claude-mock-4',
    toolMap: DROID_TCK_TOOLS,
    supportsRestartTakeover: false,
    supportsBackgroundTasks: false,
    supportsSubagents: true,
    approvalModes: { ask: 'off', auto: 'high' },
    extraEnv({ sandbox }) {
      return {
        FACTORY_HOME_OVERRIDE: join(sandbox.cliHome, 'factory'),
      };
    },
    async prepareCliHome({ sandbox, mockHub, model }) {
      const factoryDir = join(sandbox.cliHome, 'factory', '.factory');
      await mkdir(factoryDir, { recursive: true, mode: 0o700 });
      const bareModel = model.replace(/^custom:/, '');
      const settings = {
        custom_models: [
          {
            model_display_name: bareModel,
            model: bareModel,
            base_url: mockHub.url,
            api_key: 'tck-mock-factory-byok-key',
            provider: 'anthropic',
            max_tokens: 4096,
          },
        ],
        cloudSessionSync: false,
        ideAutoConnect: false,
      };
      await writeFile(join(factoryDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    },
    buildProfilePayload({ executable, model, profileId, live }) {
      const id = profileId ?? 'compat-droid';
      const chosenModel = model ?? 'custom:claude-mock-4';
      const execPath = resolvedExecutable({ defaultCommand: 'droid', executableEnvVar: 'DROID_CLI' }, executable);
      if (live) {
        return {
          profileId: id,
          model,
          payload: {
            id,
            name: 'Compat Droid (live)',
            executable: execPath,
          },
        };
      }
      return {
        profileId: id,
        model: chosenModel,
        payload: {
          id,
          name: 'Compat Droid (mock BYOK)',
          executable: execPath,
          apiKey: 'tck-mock-factory-key',
          defaultModel: chosenModel,
        },
      };
    },
  },

  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    tier: 'A',
    protocol: 'google-generative-ai',
    defaultCommand: 'agy',
    executableEnvVar: 'ANTIGRAVITY_CLI',
    defaultModel: 'gemini-2.5-mock',
    toolMap: ANTIGRAVITY_TCK_TOOLS,
    requiresPlugin: 'riffet.antigravity',
    supportsRestartTakeover: true,
    supportsBackgroundTasks: false,
    supportsSubagents: true,
    approvalModes: { ask: 'request-review', auto: 'always-proceed' },
    async prepareCliHome({ sandbox }) {
      await mkdir(join(sandbox.cliHome, 'antigravity', 'antigravity-cli'), { recursive: true, mode: 0o700 });
    },
    buildProfilePayload({ mockHub, sandbox, executable, model, profileId, live }) {
      const id = profileId ?? 'compat-antigravity';
      const chosenModel = model ?? 'gemini-2.5-mock';
      const execPath = resolvedExecutable({ defaultCommand: 'agy', executableEnvVar: 'ANTIGRAVITY_CLI' }, executable);
      if (live) {
        return {
          profileId: id,
          model,
          payload: {
            id,
            name: 'Compat Antigravity (live)',
            executable: execPath,
            disableAutoUpdate: true,
          },
        };
      }
      return {
        profileId: id,
        model: chosenModel,
        payload: {
          id,
          name: 'Compat Antigravity (mock)',
          executable: execPath,
          sourceDir: join(sandbox.cliHome, 'antigravity'),
          apiEndpoint: mockHub.url,
          apiProtocol: 'google-generative-ai',
          apiKey: 'tck-mock-gemini-key',
          defaultModel: chosenModel,
          disableAutoUpdate: true,
        },
      };
    },
  },

  cursor: {
    id: 'cursor',
    label: 'Cursor Agent',
    tier: 'C',
    protocol: 'proprietary',
    defaultCommand: 'cursor-agent',
    executableEnvVar: 'CURSOR_AGENT_CLI',
    defaultModel: 'auto',
    toolMap: CURSOR_TCK_TOOLS,
    requiresPlugin: 'riffet.cursor',
    supportsRestartTakeover: true,
    supportsBackgroundTasks: false,
    supportsSubagents: true,
    approvalModes: { ask: 'allowlist', auto: 'unrestricted' },
    async prepareCliHome({ sandbox }) {
      await mkdir(join(sandbox.cliHome, 'cursor'), { recursive: true, mode: 0o700 });
    },
    buildProfilePayload({ sandbox, executable, model, profileId, live }) {
      const id = profileId ?? 'compat-cursor';
      const execPath = resolvedExecutable({ defaultCommand: 'cursor-agent', executableEnvVar: 'CURSOR_AGENT_CLI' }, executable);
      return {
        profileId: id,
        model,
        liveOnly: !live,
        note: 'Cursor Agent uses a proprietary protocol; full turns require --live mode.',
        payload: {
          id,
          name: live ? 'Compat Cursor (live)' : 'Compat Cursor (offline)',
          executable: execPath,
          ...(live ? {} : { configDir: join(sandbox.cliHome, 'cursor') }),
          disableAutoUpdate: true,
        },
      };
    },
  },
};

function defaultModelForProtocol(protocol: BackendProtocol): string {
  switch (protocol) {
    case 'anthropic-messages':
      return 'claude-mock-4';
    case 'openai-responses':
      return 'gpt-5-mock';
    case 'openai-chat':
      return 'gpt-4o-mock';
    case 'google-generative-ai':
      return 'gemini-2.5-mock';
    case 'proprietary':
      return 'default';
  }
}

function apiProtocolForProfile(protocol: BackendProtocol): string | undefined {
  switch (protocol) {
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-responses':
      return 'openai-responses';
    case 'openai-chat':
      return 'openai-completions';
    case 'google-generative-ai':
      return 'google-generative-ai';
    case 'proprietary':
      return undefined;
  }
}

/**
 * Creates a `BackendCompatSpec` for any out-of-tree plugin agent backend loaded via `--plugin-dir`,
 * allowing external plugins to run the exact same MockLlmHub + TCK suite without modifying Riffet core.
 */
export function createExternalPluginBackendSpec(
  backendId: string,
  options: ExternalPluginBackendOptions,
): BackendCompatSpec {
  const protocol: BackendProtocol = options.protocol ?? 'openai-chat';
  const tier: BackendTier = options.tier ?? (protocol === 'proprietary' ? 'C' : 'A');
  const defaultModel = options.model ?? defaultModelForProtocol(protocol);
  const command = options.command ?? backendId;
  const toolMap: BackendToolMap = {
    ...DEFAULT_GENERIC_TOOLS,
    argProfile: 'generic',
    ...options.toolMap,
  };
  const safeDirName = backendId.replace(/[^a-z0-9._-]+/gi, '_');

  return {
    id: backendId,
    label: options.label ?? backendId,
    tier,
    protocol,
    defaultCommand: command,
    defaultModel,
    toolMap,
    pluginDir: options.pluginDir,
    ...(options.requiresPlugin ? { requiresPlugin: options.requiresPlugin } : {}),
    supportsRestartTakeover: options.supportsRestartTakeover ?? false,
    supportsBackgroundTasks: options.supportsBackgroundTasks ?? false,
    supportsSubagents: options.supportsSubagents ?? false,
    async prepareCliHome({ sandbox }) {
      await mkdir(join(sandbox.cliHome, safeDirName), { recursive: true, mode: 0o700 });
    },
    buildProfilePayload({ mockHub, sandbox, executable, model, profileId, live }) {
      const id = profileId ?? `compat-${backendId.replace(/[^a-z0-9._-]+/gi, '-')}`;
      const chosenModel = model ?? defaultModel;
      const execPath = executable?.trim() || command;
      const liveOnly = !live && protocol === 'proprietary';
      if (live || protocol === 'proprietary') {
        return {
          profileId: id,
          model,
          liveOnly,
          ...(liveOnly ? { note: 'Proprietary plugin backend requires --live for conversation scenarios.' } : {}),
          payload: {
            id,
            name: `Compat ${backendId} (${live ? 'live' : 'offline'})`,
            executable: execPath,
            ...(live ? {} : { configDir: join(sandbox.cliHome, safeDirName) }),
          },
        };
      }
      const apiProtocol = apiProtocolForProfile(protocol);
      const endpoint =
        protocol === 'openai-responses' || protocol === 'openai-chat'
          ? `${mockHub.url}/v1`
          : mockHub.url;
      return {
        profileId: id,
        model: chosenModel,
        payload: {
          id,
          name: `Compat ${backendId} (mock)`,
          executable: execPath,
          configDir: join(sandbox.cliHome, safeDirName),
          apiEndpoint: endpoint,
          ...(apiProtocol ? { apiProtocol } : {}),
          apiKey: 'tck-mock-plugin-key',
          defaultModel: chosenModel,
          enabledModels: [chosenModel],
        },
      };
    },
  };
}
