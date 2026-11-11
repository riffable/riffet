import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ExtensionAction, ExtensionActionRequest, ExtensionActionResult, ExtensionItem, ExtensionManagementCapabilities } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { runProcess, type ProcessResult } from '../git/exec.js';
import { redactConfigDocument } from '../settings/config-documents.js';
import type { NativeBackendDriver, NativeBackendHost } from '../backends/types.js';
import { resolveCliExecutable } from '../backends/shared/cli-resolve.js';
import { versionAtLeast } from '../backends/shared/cli-version.js';
import { codexFlavor, traexFlavor } from '../backends/codex/flavors.js';
import type { ExtensionContext } from './types.js';
import { SKILL_SETTINGS_MIN_VERSIONS } from './skill-settings.js';

type Runner = typeof runProcess;
interface Probe { capabilities: ExtensionManagementCapabilities; help: string; at: number; }
const commands: Partial<Record<ExtensionContext['backendId'], string>> = { codex: 'codex', traex: 'traex', claude: 'claude', droid: 'droid', dsh: 'dsh', pi: 'pi' };
const commandVerbs: Record<string, Partial<Record<ExtensionAction, string>>> = {
  codex: { install: 'add', uninstall: 'remove' },
  traex: { install: 'install', uninstall: 'uninstall', enable: 'enable', disable: 'disable', update: 'upgrade' },
  claude: { install: 'install', uninstall: 'uninstall', enable: 'enable', disable: 'disable', update: 'update' },
  droid: { install: 'install', uninstall: 'uninstall', update: 'update' },
};

function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }

export function extensionCommand(context: ExtensionContext, args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const { config } = context.profile;
  if (context.layout?.command) return context.layout.command(config, args);
  const env = { ...process.env };
  const configDir = string(config.configDir);
  if (context.backendId === 'droid' && configDir && path.resolve(configDir.replace(/^~(?=\/|$)/, homedir())) !== path.join(homedir(), '.factory')) throw new AppError('EXTENSION_PROFILE_UNSUPPORTED', 'The Droid native runtime does not support a custom configDir; clear it before managing extensions', 409);
  if (context.backendId === 'claude' && configDir) env.CLAUDE_CONFIG_DIR = configDir;
  if (context.backendId === 'pi' && configDir) env.PI_CODING_AGENT_DIR = path.resolve(configDir.replace(/^~(?=\/|$)/, homedir()));
  if (context.backendId === 'codex') Object.assign(env, codexFlavor.env({ configDir }));
  if (context.backendId === 'traex') Object.assign(env, traexFlavor.env({ configDir }));
  // These commands manage local configuration; do not add gateway credentials or CLI trust flags.
  const executable = string(config.executable) ?? (context.backendId === 'codex' ? process.env.CODEX_CLI : context.backendId === 'traex' ? process.env.TRAEX_CLI : context.backendId === 'claude' ? process.env.CLAUDE_CLI : context.backendId === 'pi' ? process.env.PI_CLI : undefined) ?? commands[context.backendId] ?? context.backendId;
  return { command: resolveCliExecutable({ command: executable }).executable, args, env };
}

export function validateExtensionTarget(value: unknown): string {
  if (typeof value !== 'string' || value.length > 240 || !/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value)) throw new AppError('INVALID_EXTENSION_TARGET', 'Use the plugin\'s native identifier, such as name@marketplace; paths, commands and options are not accepted');
  return value;
}

export function pluginActionArgs(backend: string, action: ExtensionAction, target: string, scope: 'user' | 'project', help: string): string[] {
  validateExtensionTarget(target);
  const verb = commandVerbs[backend]?.[action];
  if (!verb) throw new AppError('EXTENSION_ACTION_UNSUPPORTED', 'This agent does not support this native action', 409, undefined, { subject: 'agent' });
  const args = ['plugin', verb];
  if (/--scope\b/.test(help)) args.push('--scope', scope);
  else if (scope === 'project') throw new AppError('EXTENSION_SCOPE_UNSUPPORTED', 'This CLI has no project-level option; the action is not narrowed to user level', 409);
  args.push(target);
  return args;
}

export class ExtensionManagement {
  private readonly probes = new Map<string, Probe>();
  private readonly installed = new Map<string, { at: number; items: ExtensionItem[]; diagnostics: string[] }>();
  private readonly pending = new Set<string>();
  private readonly skillReads = new Map<string, { at: number; value: Promise<{ states: Array<{ path: string; enabled: boolean }>; diagnostics: string[] }> }>();
  private readonly settingsSupport = new Map<string, { at: number; value: Promise<boolean> }>();
  constructor(private readonly run: Runner = runProcess) {}

  private key(context: ExtensionContext): string {
    return createHash('sha256').update(JSON.stringify([context.backendId, context.profile.id, context.profile.config])).digest('hex');
  }
  private async command(context: ExtensionContext, args: string[], scope: 'user' | 'project' = 'user', timeoutMs = 8_000): Promise<ProcessResult> {
    const spec = extensionCommand(context, args);
    return this.run(spec.command, spec.args, { env: spec.env, cwd: scope === 'project' ? context.project!.cwd : homedir(), timeoutMs, maxOutputBytes: 256 * 1024 });
  }
  async supportsSkillSettings(context: ExtensionContext): Promise<boolean> {
    if (context.backendId !== 'claude' && context.backendId !== 'droid') return false;
    const key = this.key(context);
    const cached = this.settingsSupport.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = this.command(context, ['--version']).then(result => {
      if (result.code !== 0 || result.timedOut || result.truncated) return false;
      return versionAtLeast(result.stdout + result.stderr, SKILL_SETTINGS_MIN_VERSIONS[context.backendId as 'claude' | 'droid']);
    }).catch(() => false);
    if (this.settingsSupport.size >= 32) this.settingsSupport.clear();
    this.settingsSupport.set(key, { at: Date.now(), value });
    return value;
  }

  /** Coalesce native reads across list/detail requests; never start a conversation. */
  async skillStates(context: ExtensionContext, driver: NativeBackendDriver, host: NativeBackendHost) {
    if (!driver.skillStates) return { states: [], diagnostics: [] };
    const key = JSON.stringify([this.key(context), context.project?.cwd ?? '']);
    const cached = this.skillReads.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = driver.skillStates(host, context.project, context.profile)
      .then(states => ({ states, diagnostics: [] as string[] }))
      .catch(() => ({ states: [], diagnostics: ['未能读取原生 Skill 开关状态；保留文件目录，可稍后刷新重试。'] }));
    if (this.skillReads.size >= 32) this.skillReads.clear();
    this.skillReads.set(key, { at: Date.now(), value });
    return value;
  }

  invalidateSkillStates(): void { this.skillReads.clear(); }
  /** Use a declared JSON format only. Human-readable CLI output is not a stable registry. */
  async installedPlugins(context: ExtensionContext): Promise<{ items: ExtensionItem[]; diagnostics: string[] }> {
    if (context.backendId !== 'codex') return { items: [], diagnostics: [] };
    const key = this.key(context);
    const cached = this.installed.get(key);
    if (cached && Date.now() - cached.at < 5_000) return cached;
    const items: ExtensionItem[] = [];
    const diagnostics: string[] = [];
    try {
      const help = await this.command(context, ['plugin', 'list', '--help']);
      if (help.code !== 0 || help.timedOut || help.truncated || !/--json\b/.test(help.stdout + help.stderr)) throw new Error('JSON listing unavailable');
      const result = await this.command(context, ['plugin', 'list', '--json']);
      if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('JSON listing failed');
      const parsed: unknown = JSON.parse(result.stdout);
      const rows = parsed && typeof parsed === 'object' && 'installed' in parsed ? parsed.installed : undefined;
      if (!Array.isArray(rows)) throw new Error('Unknown plugin list format');
      for (const raw of rows.slice(0, 1200)) {
        if (!raw || typeof raw !== 'object' || raw.installed !== true || typeof raw.pluginId !== 'string') continue;
        let nativeId: string;
        try { nativeId = validateExtensionTarget(raw.pluginId); } catch { continue; }
        const managed = raw.installPolicy !== 'AVAILABLE';
        items.push({ id: createHash('sha256').update([key, 'native-plugin', nativeId].join('\0')).digest('hex').slice(0, 40),
          kind: 'plugin', name: nativeId, nativeId, scope: managed ? 'managed' : 'user', runtimeState: 'unknown',
          ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
          description: `原生已安装插件${typeof raw.version === 'string' ? ` · ${redactConfigDocument(raw.version).slice(0, 100)}` : ''}`,
          ...(managed ? { readOnlyReason: '此插件的原生安装策略不允许自由管理。' } : {}),
        });
      }
    } catch { diagnostics.push('未取得 Codex 原生已安装插件清单；缓存文件仍可查看，暂不提供其卸载操作。'); }
    if (this.installed.size >= 32) this.installed.clear();
    const value = { at: Date.now(), items, diagnostics };
    this.installed.set(key, value);
    return value;
  }
  async capabilities(context: ExtensionContext, driver: NativeBackendDriver, host?: NativeBackendHost): Promise<ExtensionManagementCapabilities> {
    if (host && driver.extensionManagementCapabilities) return driver.extensionManagementCapabilities(host, context.profile);
    const key = this.key(context);
    const cached = this.probes.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.capabilities;
    const capabilities: ExtensionManagementCapabilities = { actions: [], kinds: {} };
    if (driver.setSkillEnabled) capabilities.kinds.skill = ['enable', 'disable'];
    if (driver.authorizeMcp) capabilities.kinds.mcp = ['login'];
    if (driver.reloadExtensions) capabilities.actions.push('reload');
    let help = '';
    if (commandVerbs[context.backendId]) {
      const result = await this.command(context, ['plugin', '--help']).catch(() => undefined);
      if (result && result.code === 0 && !result.timedOut && !result.truncated) {
        help = result.stdout + '\n' + result.stderr;
        const supported = Object.entries(commandVerbs[context.backendId]!).filter(([, verb]) => new RegExp(`^\\s{2,}${verb}(?:\\s|\\[|\\(|\\|)`, 'm').test(help)).map(([action]) => action as ExtensionAction);
        capabilities.kinds.plugin = supported;
        if (supported.includes('install')) {
          const installHelp = await this.command(context, ['plugin', commandVerbs[context.backendId]!.install!, '--help']).catch(() => undefined);
          if (installHelp && installHelp.code === 0 && !installHelp.timedOut && !installHelp.truncated) {
            capabilities.actions.push('install');
            capabilities.installScopes = /--scope\b/.test(installHelp.stdout + installHelp.stderr) ? ['user', 'project'] : ['user'];
          } else capabilities.kinds.plugin = supported.filter(action => action !== 'install');
        }
      } else capabilities.reason = '未能验证本机插件 CLI 的管理命令；文件查看和编辑仍然可用。';
    } else capabilities.reason = '此适配器目前通过原生配置文件管理扩展。';
    if (this.probes.size >= 32) this.probes.clear();
    this.probes.set(key, { capabilities, help, at: Date.now() });
    return capabilities;
  }

  async apply(context: ExtensionContext, driver: NativeBackendDriver, host: NativeBackendHost, request: ExtensionActionRequest, item?: ExtensionItem): Promise<ExtensionActionResult> {
    if (!request || !['enable', 'disable', 'install', 'update', 'uninstall', 'reload', 'login'].includes(request.action)) throw new AppError('INVALID_EXTENSION_ACTION', 'Choose a supported extension action');
    const scope = request.scope ?? (item?.scope === 'project' ? 'project' : 'user');
    if (!['user', 'project'].includes(scope) || (scope === 'project' && !context.project)) throw new AppError('INVALID_EXTENSION_SCOPE', 'Choose a project for a project-level action');
    const nativeSkillToggle = item?.kind === 'skill' && ['enable', 'disable'].includes(request.action) && item.actions?.includes(request.action) && driver.setSkillEnabled;
    if (item && !nativeSkillToggle && (item.scope === 'managed' || item.scope === 'builtin' || item.ownerPluginId)) throw new AppError('EXTENSION_READ_ONLY', 'Manage this extension through its plugin or managed configuration', 403, undefined, { subject: 'managed' });
    if (item && request.scope && item.scope !== request.scope) throw new AppError('EXTENSION_SCOPE_MISMATCH', 'The scope does not match where the extension comes from', 409);
    // Native tools own their config locks; this fence also avoids overlapping browser operations.
    const key = this.key(context);
    if (this.pending.has(key)) throw new AppError('EXTENSION_ACTION_BUSY', 'Another management action is running on this configuration', 409);
    this.pending.add(key);
    try {
      if (driver.manageExtension) return await driver.manageExtension(host, context.profile, request, item);
      if (request.action === 'login' && driver.authorizeMcp) {
        const name = item?.kind === 'mcp' ? item.nativeId : request.target;
        if (!name || typeof name !== 'string' || name.length > 200 || /[\r\n\0]/.test(name)) throw new AppError('INVALID_EXTENSION_TARGET', 'Choose an MCP server from the current runtime', 400, undefined, { subject: 'mcp' });
        const authorizationUrl = await driver.authorizeMcp(host, context.project, context.profile, name);
        return { success: true, authorizationUrl, applyEffect: '授权链接已生成，请在运行 Agent 的电脑上完成授权，然后刷新运行状态。' };
      }
      if (request.action === 'reload' && driver.reloadExtensions) {
        const count = await driver.reloadExtensions(host, context.project, context.profile);
        return { success: true, applyEffect: count ? `已通知 ${count} 个在线连接重载 MCP 配置；请刷新运行状态。` : '没有匹配的在线连接；下次启动会话时加载配置。' };
      }
      if (nativeSkillToggle && item?.sourcePath && driver.setSkillEnabled) {
        await driver.setSkillEnabled(host, context.project, context.profile, item.sourcePath, request.action === 'enable');
        return { success: true, applyEffect: '已更新用户级原生 Skill 开关；引用该技能的其他项目也可能受影响。现有会话的加载时机由 Agent 决定。' };
      }
      if (request.action !== 'install' && (!item || item.kind !== 'plugin')) throw new AppError('EXTENSION_ACTION_UNSUPPORTED', 'This resource does not support this native action', 409, undefined, { subject: 'resource' });
      const caps = await this.capabilities(context, driver);
      if (!caps.kinds.plugin?.includes(request.action)) throw new AppError('EXTENSION_ACTION_UNSUPPORTED', caps.reason ?? 'This CLI does not declare this action', 409, undefined, caps.reason ? { subject: 'reason', reason: caps.reason } : undefined);
      const target = validateExtensionTarget(item ? item.nativeId : request.target);
      const verb = commandVerbs[context.backendId]?.[request.action]!;
      const help = await this.command(context, ['plugin', verb, '--help']);
      if (help.code !== 0 || help.timedOut || help.truncated) throw new AppError('EXTENSION_ACTION_UNSUPPORTED', 'The native management command\'s options could not be verified', 409, undefined, { subject: 'unverified' });
      const args = pluginActionArgs(context.backendId, request.action, target, scope, help.stdout + help.stderr);
      const result = await this.command(context, args, scope, 120_000);
      let output = result.stdout + (result.stderr ? '\n' + result.stderr : '');
      for (const [name, value] of Object.entries(context.profile.config)) if (/key|secret|token|password/i.test(name) && typeof value === 'string' && value) output = output.split(value).join('[REDACTED]');
      output = redactConfigDocument(output).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').slice(0, 16_000);
      const success = result.code === 0 && !result.timedOut && !result.truncated;
      return { success, output, applyEffect: success ? '原生 CLI 已完成操作；请刷新目录。现有会话可能需要重新加载插件或重启。' : '操作未确认完成；请查看原生输出并刷新目录核对，避免重复安装。', ...(result.timedOut ? { diagnostics: ['命令已超时停止；配置可能已部分修改。'] } : {}) };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      for (const [name, value] of Object.entries(context.profile.config)) if (/key|secret|token|password/i.test(name) && typeof value === 'string' && value) message = message.split(value).join('[REDACTED]');
      throw new AppError(error instanceof AppError ? error.code : 'EXTENSION_ACTION_FAILED', redactConfigDocument(message).slice(0, 1000), error instanceof AppError ? error.statusCode : 502, undefined, error instanceof AppError ? error.params : undefined);
    } finally { this.pending.delete(key); this.installed.delete(key); this.invalidateSkillStates(); }
  }
}
