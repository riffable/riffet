import { createHash } from 'node:crypto';
import type {
  AppSettings,
  ExtensionDetail,
  ExtensionDocument,
  ExtensionFile,
  ExtensionItem,
  LinkInfo,
  NativeBackendCatalogEntry,
  PluginDescriptor,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { rawPromptSource, riffetPackSkills, riffetSkills } from '../prompts/index.js';
import { RIFFET_SKILLS_REASON } from './riffet-skills.js';

export interface RiffetCatalogTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface RiffetCatalogMcp {
  serverName: string;
  core: readonly RiffetCatalogTool[];
  agents: readonly RiffetCatalogTool[];
  task: readonly RiffetCatalogTool[];
  remote: readonly RiffetCatalogTool[];
  device: readonly RiffetCatalogTool[];
  screen: readonly RiffetCatalogTool[];
  window: readonly RiffetCatalogTool[];
  assistant: readonly RiffetCatalogTool[];
  capabilities: ReadonlyArray<{ id: string; domain: string; description: string; inputSchema?: Record<string, unknown> }>;
  plugins: ReadonlyArray<{ id: string; owner: string; toolPrefix: string; enabled: boolean; tools: readonly RiffetCatalogTool[] }>;
}

export interface RiffetCatalogDevice {
  id: string;
  name: string;
  platform?: string;
  online: boolean;
  allowControl?: boolean;
  capabilities?: readonly string[];
}

export interface RiffetCatalogInput {
  version: string;
  selfName: string;
  mcp: RiffetCatalogMcp;
  backends: readonly NativeBackendCatalogEntry[];
  plugins: readonly PluginDescriptor[];
  devices: readonly RiffetCatalogDevice[];
  links: readonly LinkInfo[];
  settings: AppSettings;
}

export type RiffetActivation = 'auto' | 'opt-in' | 'assistant' | 'task' | 'pack' | 'readonly';

export type RiffetExtensionItem = ExtensionItem & { activation?: RiffetActivation };

export interface RiffetExtensionInventory {
  items: RiffetExtensionItem[];
  diagnostics: string[];
  checkedAt: string;
}

export interface RiffetExtensionSnapshot {
  inventory: RiffetExtensionInventory;
  details: Map<string, ExtensionDetail & { item: RiffetExtensionItem }>;
  documents: Map<string, ExtensionDocument>;
}

const hashId = (...parts: string[]) => createHash('sha256').update(['riffet-catalog', ...parts].join('\0')).digest('hex').slice(0, 40);
const contentHash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

function escapeCell(value: string): string {
  return value.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

function formatSchemaParams(schema?: Record<string, unknown>): string {
  if (!schema || typeof schema !== 'object') return '无参数';
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, { type?: string; enum?: unknown[]; description?: string }>
    : undefined;
  if (!properties || !Object.keys(properties).length) return '无参数';
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties).map(([name, spec]) => {
    const type = Array.isArray(spec?.enum) ? spec.enum.map(String).join(' | ') : spec?.type ?? 'any';
    const mark = required.has(name) ? '*' : '';
    const desc = spec?.description ? `：${spec.description}` : '';
    return `- \`${name}${mark}\`（\`${type}\`）${desc}`;
  }).join('\n');
}

function renderToolsMarkdown(tools: readonly RiffetCatalogTool[]): string {
  if (!tools.length) return '_当前没有已激活的工具。_\n';
  return tools.map(tool => [
    `### \`${tool.name}\``,
    '',
    tool.description.trim(),
    '',
    '**参数**',
    '',
    formatSchemaParams(tool.inputSchema),
  ].join('\n')).join('\n\n') + '\n';
}

function renderCapabilitiesTable(capabilities: RiffetCatalogMcp['capabilities']): string {
  if (!capabilities.length) return '';
  const byDomain = new Map<string, typeof capabilities[number][]>();
  for (const cap of capabilities) {
    const list = byDomain.get(cap.domain) ?? [];
    list.push(cap);
    byDomain.set(cap.domain, list);
  }
  const sections: string[] = ['## 工作台只读能力目录（`capability_find` / `capability_read`）', ''];
  for (const [domain, list] of byDomain) {
    sections.push(`### ${domain}`, '', '| 能力 ID | 说明 |', '| --- | --- |');
    for (const item of list) sections.push(`| \`${escapeCell(item.id)}\` | ${escapeCell(item.description)} |`);
    sections.push('');
  }
  return sections.join('\n');
}

function formatPlatform(platform?: LinkInfo['platform']): string {
  if (!platform) return '—';
  const os = platform.os === 'darwin' ? 'macOS' : platform.os === 'linux' ? 'Linux' : platform.os === 'win32' ? 'Windows' : platform.os;
  return platform.arch ? `${os} (${platform.arch})` : os;
}

/**
 * Builds a read-only catalog of everything Riffet itself provides — built-in MCP tool groups,
 * bundled skills, system rules, and non-sensitive runtime configuration — using the standard
 * `ExtensionItem` / `ExtensionDetail` / `ExtensionDocument` contracts.
 */
export function buildRiffetExtensions(input: RiffetCatalogInput): RiffetExtensionSnapshot {
  const items: RiffetExtensionItem[] = [];
  const details = new Map<string, ExtensionDetail & { item: RiffetExtensionItem }>();
  const documents = new Map<string, ExtensionDocument>();

  const register = (spec: {
    key: string;
    kind: ExtensionItem['kind'];
    name: string;
    description: string;
    sourcePath: string;
    activation: RiffetActivation;
    enabled?: boolean;
    ownerPluginId?: string;
    files: Array<{ path: string; content: string; language?: ExtensionDocument['language'] }>;
  }) => {
    const itemId = hashId('item', spec.kind, spec.key);
    const extFiles: ExtensionFile[] = [];
    for (const file of spec.files) {
      const docId = hashId('doc', spec.kind, spec.key, file.path);
      const doc: ExtensionDocument = {
        id: docId,
        path: file.path,
        editable: false,
        reason: RIFFET_SKILLS_REASON,
        content: file.content,
        hash: contentHash(file.content),
        language: file.language ?? 'markdown',
        applyEffect: '随 Riffet 服务端版本与实时状态更新。',
      };
      documents.set(docId, doc);
      extFiles.push({ id: docId, path: file.path, editable: false, reason: RIFFET_SKILLS_REASON });
    }
    const item: RiffetExtensionItem = {
      id: itemId,
      kind: spec.kind,
      name: spec.name,
      description: spec.description,
      scope: 'riffet',
      sourcePath: spec.sourcePath,
      activation: spec.activation,
      ...(spec.ownerPluginId ? { ownerPluginId: spec.ownerPluginId } : {}),
      enabled: spec.enabled ?? true,
      runtimeState: 'unknown',
      readOnlyReason: RIFFET_SKILLS_REASON,
      ...(extFiles[0] ? { documentId: extFiles[0].id } : {}),
      actions: [],
    };
    items.push(item);
    details.set(itemId, { item, files: extFiles });
  };

  const mcpBackends = input.backends.filter(item => item.capabilities.supportsRiffetTools).map(item => item.label);
  const mcpBackendNote = mcpBackends.length ? mcpBackends.join('、') : '无已安装的支持后端';
  const pluginNames = new Map(input.plugins.map(plugin => [plugin.id, plugin.name]));

  // 1. Built-in Riffet MCP tool groups
  register({
    key: 'mcp:core',
    kind: 'mcp',
    name: 'riffet:core',
    activation: 'auto',
    description: `基础工具（${input.mcp.core.length} 项）：会话引用读取、定时唤醒、自动化创建、通知与设备查询。`,
    sourcePath: 'riffet:mcp/core.md',
    files: [{
      path: 'riffet:mcp/core.md',
      content: [
        '# Riffet MCP · 基础工具（`riffet:core`）',
        '',
        `- **MCP 服务名**：\`${input.mcp.serverName}\`（按次启动 CLI 动态注入，不修改 Agent 全局配置）`,
        `- **注入范围**：所有非归档、非快速对话的普通会话默认携带（\`schedule_task\` 在个人助理中除外）`,
        `- **支持的 Agent**：${mcpBackendNote}`,
        '',
        '## 工具清单',
        '',
        renderToolsMarkdown(input.mcp.core),
      ].join('\n'),
    }],
  });

  register({
    key: 'mcp:agents',
    kind: 'mcp',
    name: 'riffet:agents',
    activation: 'auto',
    description: `Agent 协作调用（${input.mcp.agents.length} 项）：列出可调用 Agent、发起/继续/等待/停止调用。`,
    sourcePath: 'riffet:mcp/agents.md',
    files: [{
      path: 'riffet:mcp/agents.md',
      content: [
        '# Riffet MCP · Agent 协作调用（`riffet:agents`）',
        '',
        '- **注入范围**：除被其他会话调用启动的子会话外默认列出；实际调用权限取决于用户在消息中 `@` 提及目标 Agent 或在「技能与工具」中开启「允许调用所有 Agent」',
        `- **支持的 Agent**：${mcpBackendNote}`,
        '',
        '## 工具清单',
        '',
        renderToolsMarkdown(input.mcp.agents),
      ].join('\n'),
    }],
  });

  const remoteStatusRows = input.links.length
    ? [
        '| 显示名 | 短别名 (`alias`) | 平台 | 状态 | 备注 |',
        '| --- | --- | --- | --- | --- |',
        ...input.links.map(link => `| ${escapeCell(link.name)} | \`${escapeCell(link.alias)}\` | ${escapeCell(formatPlatform(link.platform))} | ${link.state === 'online' && link.outbound ? '可用' : link.state === 'online' ? '对端未允许操作' : link.state} | ${escapeCell(link.note ?? '—')} |`),
      ].join('\n')
    : '_当前未互联其他服务器。可在「设置 › 服务器链接」中添加。_';

  register({
    key: 'mcp:remote',
    kind: 'mcp',
    name: 'riffet:remote',
    activation: 'opt-in',
    description: `互联机器远端执行（${input.mcp.remote.length} 项）：按会话显式勾选后经隧道在指定对端运行命令。`,
    sourcePath: 'riffet:mcp/remote.md',
    files: [{
      path: 'riffet:mcp/remote.md',
      content: [
        '# Riffet MCP · 互联机器（`riffet:remote`）',
        '',
        '- **注入方式**：默认不注入。在本机对话的输入框「+」→「技能与工具」→「互联机器」中按会话显式勾选（`server:<serverId>`），默认不跨对话继承',
        '- **安全边界**：服务端按当前会话白名单强制校验；取消勾选或对端关闭「允许对方操作本机」后立即拒绝后续调用',
        '- **命令行共用底座**：终端中可使用 `riffet ssh <alias>` 打开交互式终端，或 `riffet ssh <alias> <cmd...>` 运行非交互命令',
        '',
        '## 当前已互联服务器',
        '',
        remoteStatusRows,
        '',
        '## 工具清单',
        '',
        renderToolsMarkdown(input.mcp.remote),
      ].join('\n'),
    }],
  });

  const deviceToolCount = input.mcp.device.length + input.mcp.screen.length + input.mcp.window.length;
  const deviceRows = input.devices.length
    ? [
        '| 设备名称 | 平台 | 在线 | 允许控制 | 能力 |',
        '| --- | --- | --- | --- | --- |',
        ...input.devices.map(device => `| ${escapeCell(device.name)} | ${escapeCell(device.platform ?? '—')} | ${device.online ? '在线' : '离线'} | ${device.allowControl ? '允许' : '未开启'} | ${escapeCell((device.capabilities ?? []).join(', ') || '—')} |`),
      ].join('\n')
    : '_当前没有已配对设备。可在「设置 › 设备管理」中配对手机或 Mac。_';

  register({
    key: 'mcp:devices',
    kind: 'mcp',
    name: 'riffet:devices',
    activation: 'opt-in',
    description: `已配对设备与屏幕操控（${deviceToolCount} 项）：通知、剪贴板、拍照、Mac 窗口截图与手机屏幕操作。`,
    sourcePath: 'riffet:mcp/devices.md',
    files: [{
      path: 'riffet:mcp/devices.md',
      content: [
        '# Riffet MCP · 设备与屏幕操控（`riffet:devices`）',
        '',
        '- **注入方式**：在输入框「+」→「技能与工具」中为当前对话勾选已配对设备后注入；未勾选时不包含设备工具',
        '- **分层能力**：基础设备能力（T0）、手机屏幕操作（T1，需设备开启控制与无障碍权限）、Mac 窗口截图',
        '',
        '## 当前已配对设备',
        '',
        deviceRows,
        '',
        '## 基础设备工具（T0）',
        '',
        renderToolsMarkdown(input.mcp.device),
        '## 手机屏幕操控工具（T1）',
        '',
        renderToolsMarkdown(input.mcp.screen),
        '## Mac 窗口截图工具',
        '',
        renderToolsMarkdown(input.mcp.window),
      ].join('\n'),
    }],
  });

  register({
    key: 'mcp:task',
    kind: 'mcp',
    name: 'riffet:task',
    activation: 'task',
    description: `任务会话交付工具（${input.mcp.task.length} 项）：向任务看板提交交付结果或向用户提问。`,
    sourcePath: 'riffet:mcp/task.md',
    files: [{
      path: 'riffet:mcp/task.md',
      content: [
        '# Riffet MCP · 任务会话交付（`riffet:task`）',
        '',
        '- **注入范围**：仅当会话归属于任务看板中的某项任务时自动注入，且只能操作所属任务',
        '',
        '## 工具清单',
        '',
        renderToolsMarkdown(input.mcp.task),
      ].join('\n'),
    }],
  });

  register({
    key: 'mcp:assistant',
    kind: 'mcp',
    name: 'riffet:assistant',
    activation: 'assistant',
    description: `个人助理与工作台能力（${input.mcp.assistant.length} 项工具 · ${input.mcp.capabilities.length} 项只读能力）。`,
    sourcePath: 'riffet:mcp/assistant.md',
    files: [{
      path: 'riffet:mcp/assistant.md',
      content: [
        '# Riffet MCP · 个人助理与工作台能力（`riffet:assistant`）',
        '',
        '- **注入范围**：仅注入给「个人助理」项目下的会话（主对话与后台跟进/委托运行）',
        '- **只读查询目录**：通过 `capability_find` 与 `capability_read` 按需检索并读取工作台与插件提供的只读状态',
        '',
        '## 工具清单',
        '',
        renderToolsMarkdown(input.mcp.assistant),
        renderCapabilitiesTable(input.mcp.capabilities),
      ].join('\n'),
    }],
  });

  for (const pluginGroup of input.mcp.plugins) {
    const ownerName = pluginNames.get(pluginGroup.owner) ?? pluginGroup.owner;
    register({
      key: `mcp:plugin:${pluginGroup.id}`,
      kind: 'mcp',
      name: pluginGroup.id,
      activation: 'opt-in',
      description: `${ownerName} 插件工具组（前缀 \`${pluginGroup.toolPrefix}\`，${pluginGroup.enabled ? `${pluginGroup.tools.length} 项工具` : '插件已停用'}）。`,
      sourcePath: `riffet:mcp/plugins/${pluginGroup.id}.md`,
      enabled: pluginGroup.enabled,
      ownerPluginId: pluginGroup.owner,
      files: [{
        path: `riffet:mcp/plugins/${pluginGroup.id}.md`,
        content: [
          `# Riffet MCP · 插件工具组 \`${pluginGroup.id}\``,
          '',
          `- **所属插件**：${ownerName}（\`${pluginGroup.owner}\`）`,
          `- **插件状态**：${pluginGroup.enabled ? '已启用' : '已停用（可在侧栏「插件」页开启）'}`,
          `- **工具前缀**：\`${pluginGroup.toolPrefix}\``,
          '- **启用方式**：在输入框「+」→「技能与工具」中为当前对话勾选对应分组',
          '',
          '## 工具清单',
          '',
          pluginGroup.enabled
            ? renderToolsMarkdown(pluginGroup.tools)
            : '_所属插件当前已停用，启用插件后将列出其注册的工具定义。_\n',
        ].join('\n'),
      }],
    });
  }

  // 2. Bundled Riffet Skills (assistant skills + capability pack skills)
  for (const skill of riffetSkills('assistant')) {
    register({
      key: `skill:assistant:${skill.name}`,
      kind: 'skill',
      name: `riffet:${skill.name}`,
      activation: 'assistant',
      description: skill.description,
      sourcePath: `riffet:${skill.name}/SKILL.md`,
      files: [{ path: `riffet:${skill.name}/SKILL.md`, content: skill.text }],
    });
  }

  for (const pack of riffetPackSkills()) {
    const files: Array<{ path: string; content: string; language?: ExtensionDocument['language'] }> = [
      { path: `riffet:pack/${pack.id}/SKILL.md`, content: pack.skillText },
    ];
    if (pack.memoryText) files.push({ path: `riffet:pack/${pack.id}/memory.md`, content: pack.memoryText });
    register({
      key: `skill:pack:${pack.id}`,
      kind: 'skill',
      name: `riffet:pack/${pack.name}`,
      activation: 'pack',
      description: pack.description || '可在「设置 › 个人助理 › 能力包」中启用。',
      sourcePath: `riffet:pack/${pack.id}/SKILL.md`,
      files,
    });
  }

  // 3. Built-in Riffet system rules & operational guides
  const ruleEntries: Array<{ key: string; name: string; activation: RiffetActivation; description: string; source: Parameters<typeof rawPromptSource>[0]; path: string }> = [
    { key: 'rule:assistant', name: 'riffet:assistant-rules', activation: 'assistant', description: '个人助理默认规则模版（写入助理目录的 AGENTS.md 初始内容）。', source: 'assistant', path: 'riffet:rules/assistant.md' },
    { key: 'rule:assistant-system', name: 'riffet:assistant-system', activation: 'assistant', description: '个人助理系统提示词，约束记忆、委托、工具调用与安全边界。', source: 'assistant-system', path: 'riffet:rules/assistant-system.md' },
    { key: 'rule:quick-chat', name: 'riffet:quick-chat-system', activation: 'auto', description: '快速对话模式的内置系统提示词。', source: 'quick-chat-system', path: 'riffet:rules/quick-chat-system.md' },
    { key: 'rule:task-verify', name: 'riffet:task-verify', activation: 'task', description: '任务看板自动核验阶段的提示词与核验规范。', source: 'task-verify', path: 'riffet:rules/task-verify.md' },
  ];
  for (const rule of ruleEntries) {
    register({
      key: rule.key,
      kind: 'rule',
      name: rule.name,
      activation: rule.activation,
      description: rule.description,
      sourcePath: rule.path,
      files: [{ path: rule.path, content: rawPromptSource(rule.source) }],
    });
  }

  const screenGuideIntro = [
    '# Riffet 设备屏幕操控规范（`device_help`）',
    '',
    '当会话启用手机屏幕操控（T1）时，Agent 可通过 `device_help` 按主题按需读取以下四份内置规范文件（在右侧「文件」页签切换阅读全文）：',
    '',
    '- `observe.md`：页面观察与元素定位规范',
    '- `steps.md`：批量操作步骤语法与注意事项',
    '- `flow.md`：多步流程与恢复策略',
    '- `errors.md`：常见错误码与处理方式',
    '',
  ].join('\n');
  register({
    key: 'rule:screen-help',
    kind: 'rule',
    name: 'riffet:screen-rules',
    activation: 'opt-in',
    description: '手机屏幕操控的四份内置操作规范（observe / steps / flow / errors）。',
    sourcePath: 'riffet:rules/screen/README.md',
    files: [
      { path: 'riffet:rules/screen/README.md', content: screenGuideIntro },
      { path: 'riffet:rules/screen/observe.md', content: rawPromptSource('screen-help-observe') },
      { path: 'riffet:rules/screen/steps.md', content: rawPromptSource('screen-help-steps') },
      { path: 'riffet:rules/screen/flow.md', content: rawPromptSource('screen-help-flow') },
      { path: 'riffet:rules/screen/errors.md', content: rawPromptSource('screen-help-errors') },
    ],
  });

  // 4. Non-sensitive runtime configuration & compatibility summaries
  const backendMatrix = input.backends.length
    ? [
        '| Agent | 可用 | Riffet MCP 按次注入 | 按对话关 MCP | 按对话关 Skills |',
        '| --- | --- | --- | --- | --- |',
        ...input.backends.map(backend => {
          const toggles = backend.capabilities.extensionToggles;
          return `| ${escapeCell(backend.label)} (\`${backend.backendId}\`) | ${backend.available ? '是' : '否'} | ${backend.capabilities.supportsRiffetTools ? '支持' : '不支持'} | ${toggles?.mcp ? '支持' : '不支持'} | ${toggles?.skills ? '支持' : '不支持'} |`;
        }),
      ].join('\n')
    : '_暂无已注册的 Agent 后端。_';

  const assistantSettings = input.settings.assistant;
  const defaultBackend = input.settings.defaultBackendId;
  const defaultApproval = defaultBackend ? input.settings.nativeBackendDefaults?.[defaultBackend]?.approval : undefined;
  const overviewConfig = [
    '# Riffet 服务配置与能力总览',
    '',
    '本页为当前本机服务器的只读摘要，不含任何凭据或密钥。修改请前往对应「设置」分区。',
    '',
    '## 基本信息',
    '',
    `- **Riffet 版本**：\`${input.version}\``,
    `- **本机服务器名称**：${input.selfName}`,
    `- **默认 Agent**：\`${defaultBackend ?? '未固定'}\``,
    `- **默认模型**：\`${input.settings.defaultModel || '跟随 Agent 默认'}\``,
    `- **默认审批模式**：\`${defaultApproval ?? 'default'}\``,
    `- **新会话自动作为任务**：${input.settings.workItems?.composerSessions ? '开启' : '关闭'}（设置 › 任务看板）`,
    '',
    '## 个人助理运行配置（设置 › 个人助理）',
    '',
    `- **后台跟进任务**：${assistantSettings?.supervision ? '开启' : '关闭'}`,
    `- **自动记忆整理**：${assistantSettings?.consolidation === false ? '关闭' : '开启'}`,
    `- **24 小时后台运行上限**：${assistantSettings?.dailyRuns ?? '默认上限'} 次`,
    `- **开始任务前确认策略**：\`${assistantSettings?.dispatch ?? 'edits'}\``,
    '',
    '## Agent 扩展能力兼容矩阵',
    '',
    backendMatrix,
    '',
  ].join('\n');

  register({
    key: 'config:overview',
    kind: 'config',
    name: 'riffet:overview',
    activation: 'readonly',
    description: `版本 ${input.version} · 本机运行配置、个人助理设置与各 Agent 能力兼容矩阵。`,
    sourcePath: 'riffet:config/overview.md',
    files: [{ path: 'riffet:config/overview.md', content: overviewConfig }],
  });

  const pluginRows = input.plugins.length
    ? [
        '| 插件 | ID | 来源 | 状态 | 扩展点 |',
        '| --- | --- | --- | --- | --- |',
        ...input.plugins.map(plugin => {
          const c = plugin.declared;
          const parts = [
            c?.agentTools?.length ? `MCP 工具组(${c.agentTools.length})` : '',
            c?.agentBackends?.length ? `Agent(${c.agentBackends.length})` : '',
            c?.modelSources?.length ? `模型源(${c.modelSources.length})` : '',
            c?.views?.length ? `视图(${c.views.length})` : '',
            c?.commands?.length ? `命令(${c.commands.length})` : '',
            c?.tasks?.length ? `任务(${c.tasks.length})` : '',
            c?.imChannels?.length ? `机器人通道(${c.imChannels.length})` : '',
          ].filter(Boolean).join('、') || '—';
          const sourceLabel = plugin.source === 'builtin' ? '内置' : plugin.source === 'development' ? '开发' : '已安装';
          return `| ${escapeCell(plugin.name)} | \`${escapeCell(plugin.id)}\` | ${sourceLabel} | ${plugin.enabled ? '已启用' : '已停用'} | ${escapeCell(parts)} |`;
        }),
      ].join('\n')
    : '_当前未加载任何插件。_';

  register({
    key: 'config:plugins',
    kind: 'config',
    name: 'riffet:plugins',
    activation: 'readonly',
    description: `共 ${input.plugins.length} 个插件（${input.plugins.filter(p => p.enabled).length} 个已启用），可在侧栏「插件」页管理。`,
    sourcePath: 'riffet:config/plugins.md',
    files: [{
      path: 'riffet:config/plugins.md',
      content: [
        '# Riffet 插件与扩展点总览',
        '',
        '启停、安装与插件专属配置请前往侧栏「插件」页（`/plugins`）。',
        '',
        pluginRows,
        '',
      ].join('\n'),
    }],
  });

  register({
    key: 'config:links',
    kind: 'config',
    name: 'riffet:links',
    activation: 'readonly',
    description: `本机名称「${input.selfName}」，已互联 ${input.links.length} 台服务器（${input.links.filter(l => l.state === 'online').length} 台在线）。`,
    sourcePath: 'riffet:config/links.md',
    files: [{
      path: 'riffet:config/links.md',
      content: [
        '# Riffet 服务器互联配置',
        '',
        `- **本机显示名称**：${input.selfName}（修改入口：「设置 › 服务器链接」或 \`riffet link self-name <名称>\`）`,
        '- **模式一（全权在对端运行）**：在新会话页顶部切换目标服务器，目录、Agent、模型与 `/` 命令全部切换到对端',
        '- **模式二（本机 Agent 挂载互联机器）**：在本机对话输入框「+」→「技能与工具」→「互联机器」中按对话显式勾选；命令行可使用 `riffet ssh <alias>`',
        '',
        '## 已互联服务器',
        '',
        remoteStatusRows,
        '',
      ].join('\n'),
    }],
  });

  register({
    key: 'config:devices',
    kind: 'config',
    name: 'riffet:devices',
    activation: 'readonly',
    description: `已配对 ${input.devices.length} 台设备（${input.devices.filter(d => d.online).length} 台在线）。`,
    sourcePath: 'riffet:config/devices.md',
    files: [{
      path: 'riffet:config/devices.md',
      content: [
        '# Riffet 已配对设备配置',
        '',
        '配对与吊销入口：「设置 › 设备管理」。是否在某个对话里开放给 Agent，请在输入框「+」→「技能与工具」按对话勾选。',
        '',
        deviceRows,
        '',
      ].join('\n'),
    }],
  });

  return {
    inventory: { items, diagnostics: [], checkedAt: new Date().toISOString() },
    details,
    documents,
  };
}

export function requireRiffetDetail(snapshot: RiffetExtensionSnapshot, itemId: string): ExtensionDetail {
  const detail = snapshot.details.get(itemId);
  if (!detail) throw new AppError('EXTENSION_NOT_FOUND', 'Extension item does not exist', 404);
  return detail;
}

export function requireRiffetDocument(snapshot: RiffetExtensionSnapshot, documentId: string): ExtensionDocument {
  const doc = snapshot.documents.get(documentId);
  if (!doc) throw new AppError('EXTENSION_DOCUMENT_NOT_FOUND', 'Extension document does not exist', 404);
  return doc;
}
