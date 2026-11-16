import { extensionsOffNames } from '../../extensions/toggles.js';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import { modelSourceOf } from '../shared/model-source.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import type { ClaudeHookBridge } from './hook-bridge.js';
import { shellQuote, readStatusLineForward, readOwnerConnection, configDirOf, gatewayBearer, apiKeyHelper, providerEnv } from './launch.js';
import { selectedFast, gatewayContextEnv } from './models.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const hookScriptPath = resolve(moduleDir, 'hook-cli.mjs');
const statuslineScriptPath = resolve(moduleDir, 'statusline-cli.mjs');

/**
 * A request that waits on a person (a permission, a question) has no deadline of its own: it stays
 * answerable for as long as the CLI keeps waiting, and ends only by an answer, the transcript showing
 * the CLI got one, the turn ending, the process exiting or the hook connection closing.
 *
 * Claude Code kills a hook command at its registered `timeout` and then draws its own native dialog,
 * which Riffet can no longer answer through the hook. These hooks are therefore registered for a day,
 * far past any realistic wait, so the connection (not a clock) decides when they end: `hook-cli.mjs`
 * exits the moment the server closes it, and the server closes it when the CLI exits or the turn ends.
 * Every other hook keeps the routine timeout: a stuck server must not stall each tool call for a day.
 * `RIFFET_CLAUDE_INTERACTION_HOOK_TIMEOUT_MS` shortens it for the end-to-end probe only.
 */
const INTERACTION_HOOK_TIMEOUT_MS = 24 * 60 * 60_000;
const HOOK_TIMEOUT_MS = 10 * 60_000;
const STANDING_TRANSCRIPT_DAYS = 3650;
/** Skills of the CLI's built-in plugins, which `disableBundledSkills` does not cover (verified on 2.1.322). */
const STANDING_OFF_SKILLS = ['plugin-authoring'];

function interactionHookTimeoutMs(): number {
  const override = Number(process.env.RIFFET_CLAUDE_INTERACTION_HOOK_TIMEOUT_MS);
  return Number.isFinite(override) && override >= 1000 ? Math.ceil(override) : INTERACTION_HOOK_TIMEOUT_MS;
}

export class ClaudeHookOverlay {
  private unregisterHooks?: () => void;
  private tempDir?: string;
  overlayFile?: string;
  /** This launch's `--mcp-config` file, when the conversation has Riffet tool groups. */
  mcpConfigFile?: string;
  hookUrl?: string;
  hookToken?: string;

  constructor(private readonly deps: {
    host: NativeBackendHost;
    bridge: ClaudeHookBridge;
    nativeSessionId: string;
    project: Project;
    profile(): NativeBackendProfileConfig;
    session(): Session;
    isDisposed(): boolean;
    onHook: Parameters<ClaudeHookBridge['register']>[1];
  }) {}

  /** Whether this runtime is the destination of its conversation's hooks. */
  get registered(): boolean { return this.unregisterHooks !== undefined; }

  /** Makes this runtime the destination of its conversation's hooks, whoever launched the CLI behind them. */
  async registerHooks(): Promise<void> {
    if (this.deps.isDisposed() || this.unregisterHooks) return;
    const bridge = await this.deps.bridge.start();
    if (this.deps.isDisposed() || this.unregisterHooks) return;
    this.hookUrl = bridge.url;
    this.hookToken = bridge.token;
    this.unregisterHooks = this.deps.bridge.register(this.deps.nativeSessionId, this.deps.onHook, this.deps.session().id);
  }

  async ensureHookServer(model: string | undefined): Promise<void> {
    await this.registerHooks();
    if (!this.tempDir) {
      this.tempDir = await mkdtemp(join(tmpdir(), 'riffet-claude-'));
      await chmod(this.tempDir, 0o700);
      this.overlayFile = join(this.tempDir, 'settings.json');
    }
    // The descriptor is how a CLI finds the server again after it restarts: it is read on every hook.
    const descriptor = this.deps.bridge.descriptorPath ? ` --descriptor ${shellQuote(this.deps.bridge.descriptorPath)}` : '';
    const hookCommand = `${shellQuote(process.execPath)} ${shellQuote(hookScriptPath)}`;
    const ownerArg = ` --owner ${shellQuote(this.deps.session().id)}`;
    const hookWith = (timeoutMs: number) => ({ type: 'command', command: `${hookCommand} ${timeoutMs}${descriptor}${ownerArg}`, timeout: Math.ceil(timeoutMs / 1000) });
    const commandHook = hookWith(HOOK_TIMEOUT_MS);
    const interactionHook = hookWith(interactionHookTimeoutMs());
    /**
     * The status line is where Claude Code states the context window, and it states it nowhere else:
     * no transcript record, no config file, no API frame carries it (see `context.ts`). This launch
     * therefore installs the collector, which forwards the payload over the hook bridge; a reader's
     * own status line command is handed the same bytes so their bar keeps rendering.
     */
    const forward = await readStatusLineForward(configDirOf(this.deps.profile()), this.deps.project.cwd);
    const statusLineCommand = `${shellQuote(process.execPath)} ${shellQuote(statuslineScriptPath)}`
      + descriptor + (forward ? ` --forward ${shellQuote(forward)}` : '');
    // Claude Code composes hook registrations across managed/user/project/--settings sources.
    // This overlay only adds our hooks, so existing user and project hooks remain intact.
    const fastMode = selectedFast(model);
    const gateway = gatewayBearer(this.deps.profile());
    const helper = apiKeyHelper(this.deps.profile());
    const provider = {
      ...providerEnv(this.deps.profile()),
      ...await gatewayContextEnv(this.deps.profile(), model),
      // Anthropic documents this for bearer-only gateways, whose account availability probe cannot
      // authenticate. Native model/managed-policy gates and the upstream request still decide Fast.
      ...(gateway && fastMode === true ? { CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1' } : {}),
    };
    // Riffet tools (docs/DEVICES.md §2) reach this launch through a file of its own, never `~/.claude.json`.
    const riffetMcp = this.deps.host.riffetMcp?.server(this.deps.session().id);
    if (riffetMcp) {
      this.mcpConfigFile = join(this.tempDir!, 'mcp.json');
      await writeFile(this.mcpConfigFile, `${JSON.stringify({ mcpServers: { [riffetMcp.name]: { type: 'stdio', command: riffetMcp.command, args: riffetMcp.args } } })}\n`, { mode: 0o600 });
    } else this.mcpConfigFile = undefined;
    // Extensions this conversation switched off (docs/EXTENSIONS.md): read from the session record, so a change applies at the next launch like its tool groups.
    const standing = this.deps.host.standing?.launch(this.deps.project);
    // Left out with the rest of the reader's settings, their sign-in is carried here; the profile's own still wins.
    const owner = standing ? await readOwnerConnection(configDirOf(this.deps.profile()), this.deps.project.cwd) : { settings: {} };
    const extensionsOff = this.deps.host.getSession(this.deps.session().id).extensionsOff;
    // A standing conversation's skills are the ones in its directory. The CLI's own (code review, plugin authoring…)
    // are for coding work: `disableBundledSkills` drops them, and `plugin-authoring`, which comes with a built-in
    // plugin that switch leaves in place, is turned off by name.
    const offSkills = [...extensionsOffNames(extensionsOff, 'skill'), ...(standing ? STANDING_OFF_SKILLS : [])];
    const offMcp = extensionsOffNames(extensionsOff, 'mcp');
    const overlay = {
      ...owner.settings,
      ...(Object.keys(provider).length || owner.env ? { env: { ...owner.env, ...provider } } : {}),
      ...(offSkills.length ? { skillOverrides: Object.fromEntries(offSkills.map(name => [name, 'off'])) } : {}),
      ...(standing ? { disableBundledSkills: true } : {}),
      ...(offMcp.length ? { deniedMcpServers: offMcp.map(serverName => ({ serverName })) } : {}),
      // The workbench's own tools act only on this conversation; asking before each would make a
      // wake-up or notice wait for a reader who may be away. Permission rules merge across sources.
      ...(riffetMcp || standing ? { permissions: {
        ...(riffetMcp ? { allow: [`mcp__${riffetMcp.name}`] } : {}),
        // A deny rule holds in every permission mode. It stops the CLI's file tools, not a shell command.
        ...(standing?.protectedFiles.length ? { deny: standing.protectedFiles.map(file => `Edit(/${file})`) } : {}),
      } } : {}),
      // A flag-scoped helper takes precedence over saved Console and OAuth credentials. Native
      // client construction awaits it, keeping both auth paths on the selected profile. The
      // command reads the child's scoped environment, so it also survives server restarts that
      // detach the still-running CLI and remove its temporary settings file.
      ...(helper ? { apiKeyHelper: helper } : {}),
      // A standing conversation keeps its notes in its own directory. Its launches read no user settings, so
      // without a period of their own they would clean the whole config directory at the CLI's 30-day default,
      // whatever the reader had set. Other conversations' CLIs still clean by their own setting.
      ...(standing ? { autoMemoryDirectory: standing.memoryDir, cleanupPeriodDays: STANDING_TRANSCRIPT_DAYS } : {}),
      ...(fastMode === undefined ? {} : { fastMode }),
      // Publishing to claude.ai requires Anthropic account auth, absent from this bearer gateway.
      ...(gateway || modelSourceOf(this.deps.profile().config) ? { enableArtifact: false } : {}),
      /**
       * Bypass-permissions and auto mode each gate their first use behind a one-time TUI disclaimer.
       * Both are ordinary settings keys, and `--settings` is the `flagSettings` source the check
       * reads, so the workbench answers them here: the reader already chose the mode in the UI, and
       * a mode that can only be confirmed in a terminal is a mode the UI cannot offer. The write is
       * scoped to this launch's overlay file; the reader's own settings are untouched.
       */
      skipDangerousModePermissionPrompt: true,
      skipAutoPermissionPrompt: true,
      statusLine: { type: 'command', command: statusLineCommand },
      hooks: {
        SessionStart: [{ hooks: [commandHook] }],
        SessionEnd: [{ hooks: [commandHook] }],
        UserPromptSubmit: [{ hooks: [commandHook] }],
        PermissionRequest: [{ hooks: [interactionHook] }],
        PermissionDenied: [{ hooks: [commandHook] }],
        PreToolUse: [{ hooks: [interactionHook] }],
        PostToolUse: [{ hooks: [commandHook] }],
        PostToolUseFailure: [{ hooks: [commandHook] }],
        Stop: [{ hooks: [commandHook] }],
        StopFailure: [{ hooks: [commandHook] }],
        // In the background: a PreCompact hook's stdout becomes instructions for the summary, and this one only listens.
        PreCompact: [{ hooks: [{ ...commandHook, async: true }] }],
      },
    };
    await writeFile(this.overlayFile!, `${JSON.stringify(overlay)}\n`, { mode: 0o600 });
    await chmod(this.overlayFile!, 0o600);
  }

  async dispose(): Promise<void> {
    this.unregisterHooks?.();
    this.unregisterHooks = undefined;
    if (this.tempDir) await rm(this.tempDir, { recursive: true, force: true }).catch(() => undefined);
    this.tempDir = undefined;
  }
}
