import { homedir } from 'node:os';
import type { ExtensionRuntimeReport, LoadedExtensions, Project } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { RIFFET_MCP_NAME } from '../../riffet-mcp/service.js';
import { queryDirectory } from '../shared/query-directory.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { extensionDiagnostic, fileRuntimeEntries, readConfiguredMcpNames, readMcpRuntime, readMcpServers } from './extensions.js';
import type { CodexSessionRuntime } from './runtime.js';
import { listSkills } from './skills.js';
import { useStandingSkillRoots, type CodexStanding } from './standing.js';
import { asArray, asRecord, str } from './util.js';

interface ExtensionDriverContext {
  readonly runtimes: ReadonlyMap<string, CodexSessionRuntime>;
  withTransport<T>(project: Project | undefined, profile: NativeBackendProfileConfig, session: undefined, read: (transport: CodexAppServerClient) => Promise<T>): Promise<T>;
  withManagementTransport<T>(project: Project | undefined, profile: NativeBackendProfileConfig, action: (transport: CodexAppServerClient) => Promise<T>): Promise<T>;
  standingOf(host: NativeBackendHost, project: Project): CodexStanding | undefined;
}

/**
 * What the extensions page asks of the app-server: the MCP servers and skills a directory loads,
 * their runtime state in live sessions, skill switches, reload and MCP authorization. It holds no
 * state; the live connections it inspects belong to the adapter's runtimes.
 */
export class CodexExtensionDriver {
  constructor(private readonly ctx: ExtensionDriverContext) {}

  async loaded(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig): Promise<Omit<LoadedExtensions, 'checkedAt'>> {
    const cwd = await queryDirectory(project, profile);
    const standing = this.ctx.standingOf(host, project);
    return await this.ctx.withTransport(project, profile, undefined, async transport => {
      if (standing) await useStandingSkillRoots(transport, standing);
      const [servers, configured, skills] = await Promise.all([readMcpServers(transport), readConfiguredMcpNames(transport, cwd), listSkills(transport, cwd, standing)]);
      return {
        // Plugin and app servers are listed by the app-server but cannot be switched off per thread (`readConfiguredMcpNames`).
        // The 助理's thread switches every configured one off and declares the directory's and the packs' (`standing.ts`).
        mcp: standing ? Object.keys(standing.mcpServers).map(name => ({ name })) : servers.filter(server => server.name !== RIFFET_MCP_NAME && configured.has(server.name)),
        skills: skills.map(skill => ({ name: skill.name, ...(skill.description ? { description: skill.description } : {}) })),
      };
    });
  }

  async runtime(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<ExtensionRuntimeReport> {
    const report: ExtensionRuntimeReport = { entries: [], diagnostics: [], checkedAt: new Date().toISOString() };
    if (!project) { report.diagnostics.push('选择项目以查看已运行会话的 MCP 状态。'); return report; }
    const matching = [...this.ctx.runtimes].filter(([, runtime]) => runtime.transport?.isOnline && runtime.connection.matches(project, profile));
    await Promise.all(matching.slice(0, 16).map(async ([sessionId, runtime]) => {
      const transport = runtime.transport!;
      const results = await Promise.allSettled([
        readMcpRuntime(transport, sessionId, runtime.nativeSessionId),
        transport.request('skills/list', { cwds: [project.cwd], forceReload: true }, 10_000).then(value => fileRuntimeEntries(value, 'skill', sessionId)),
        transport.request('hooks/list', { cwds: [project.cwd] }, 10_000).then(value => fileRuntimeEntries(value, 'hook', sessionId)),
      ]);
      for (const result of results) if (result.status === 'fulfilled') report.entries.push(...result.value); else report.diagnostics.push(`${sessionId}: ${extensionDiagnostic(result.reason)}`);
    }));
    if (!matching.length) report.diagnostics.push('没有与当前项目和配置匹配的在线连接；运行状态未知。');
    if (matching.length > 16) report.diagnostics.push('当前仅展示前 16 个匹配的在线会话。');
    if (report.entries.some(entry => entry.kind === 'hook')) report.diagnostics.push('Hook 目录描述原生发现结果；信任状态不代表用户已在 Riffet 中审核，执行还受会话启动策略影响。');
    return report;
  }

  async skillStates(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<Array<{ path: string; enabled: boolean }>> {
    return await this.ctx.withManagementTransport(project, profile, async transport => {
      const response = await transport.request<unknown>('skills/list', { cwds: [project?.cwd ?? homedir()], forceReload: true }, 15_000);
      const states: Array<{ path: string; enabled: boolean }> = [];
      for (const group of asArray<unknown>(asRecord(response)?.data)) {
        for (const raw of asArray<unknown>(asRecord(group)?.skills)) {
          const skill = asRecord(raw);
          const path = str(skill?.path);
          // Older or partial responses must leave state unknown rather than infer enabled.
          if (path && typeof skill?.enabled === 'boolean') states.push({ path, enabled: skill.enabled });
        }
      }
      return states;
    });
  }

  async setSkillEnabled(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, path: string, enabled: boolean): Promise<void> {
    await this.ctx.withManagementTransport(project, profile, async transport => {
      await transport.request('skills/config/write', { path, enabled }, 15_000);
    });
  }

  async reload(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<number> {
    if (!project) return 0;
    const visited = new Set<string>();
    for (const runtime of this.ctx.runtimes.values()) {
      const transport = runtime.transport;
      if (!transport?.isOnline || !runtime.connection.matches(project, profile) || visited.has(transport.remoteAddress)) continue;
      await transport.request('config/mcpServer/reload', {}, 15_000);
      visited.add(transport.remoteAddress);
    }
    return visited.size;
  }

  async authorize(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, name: string): Promise<string> {
    if (project) for (const [sessionId, runtime] of this.ctx.runtimes) {
      if (!runtime.transport?.isOnline || !runtime.connection.matches(project, profile)) continue;
      const servers = await readMcpRuntime(runtime.transport, sessionId, runtime.nativeSessionId);
      if (!servers.some(server => server.name === name)) continue;
      const response = await runtime.transport.request<{ authorizationUrl: string }>('mcpServer/oauth/login', { name, threadId: runtime.nativeSessionId, timeoutSecs: 300 }, 15_000);
      const url = new URL(response.authorizationUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new AppError('EXTENSION_AUTH_URL_INVALID', 'Agent returned an unsupported authorization URL');
      return url.toString();
    }
    throw new AppError('EXTENSION_RUNTIME_REQUIRED', 'Open a conversation that uses this MCP server before authorizing.', 409);
  }
}
