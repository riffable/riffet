import type { MessageCatalogs } from '@riffet/plugin-web';

/*
 * Cursor's own settings text. `zh-Hans` is the source, `en` follows its keys exactly, and
 * `useMessages(catalogs)` picks one by the host's locale.
 */

const zhHans = {
  unavailable: (reason?: string) => reason ? `Cursor 不可用：${reason}` : 'Cursor 不可用',

  // CLI page
  launchNote: '启动配置保存在服务器，需重启 Riffet 后生效。',
  launchSettings: '启动设置',
  executable: '自定义 CLI 入口',
  executableLabel: 'Cursor CLI 入口',
  executablePlaceholder: 'cursor-agent（默认）',
  configDir: 'Cursor 配置目录',
  configDirHint: '留空继承启动环境；更换目录会切换 CLI 历史范围。',
  configDirPlaceholder: '~/.cursor（默认）',
  disableAutoUpdate: '关闭自动更新',
  disableAutoUpdateLabel: '关闭 Cursor CLI 自动更新',
  save: '保存',
  saveIncomplete: '保存未完成，请检查输入后重试。已成功保存的设置会保留。',

  environment: '运行环境',
  detectAgain: '重新检测',
  detectFailed: '无法检测运行环境',
  cliVersion: 'Cursor CLI 版本',
  unknown: '未知',
  cliPath: 'CLI 路径',
  customService: '自定义服务',
  cliAccount: 'CLI 账户',
  connected: '连接正常',
  signedIn: '已登录',
  notSignedIn: '未登录',
  persistence: '持久化',
  checkedAt: '检测时间',
  notDetected: '尚未检测到运行环境。',
  detectedModels: '检测到的 Cursor 模型',
  fullReport: '查看完整能力报告',
  runCommand: '运行命令',
  status: '状态',
  models: '模型',
  account: '账户',
  team: '团队',
  plugins: '插件',
  command: '命令',
  args: '参数',
  argsPlaceholder: '参数（空格分隔）',
  argsInvalid: '参数需要是字符串数组 JSON，或用空格分隔',
  commandFailed: '命令执行失败',
  run: '运行',
  commandScope: (project?: string) => `命令经服务端允许列表校验，在${project ? `「${project}」` : '用户'}范围内执行。`,
  exitCode: (code: number | null) => `退出码 ${code ?? '?'}`,
  timedOut: '超时',
  truncated: '已截断',
  noOutput: '（无输出）',
};

type Messages = typeof zhHans;

const en: Messages = {
  unavailable: (reason) => reason ? `Cursor unavailable: ${reason}` : 'Cursor unavailable',

  launchNote: 'Launch settings are saved on the server and take effect after Riffet restarts.',
  launchSettings: 'Launch settings',
  executable: 'Custom CLI executable',
  executableLabel: 'Cursor CLI executable',
  executablePlaceholder: 'cursor-agent (default)',
  configDir: 'Cursor config folder',
  configDirHint: 'Leave blank to inherit the startup environment; changing the folder switches the CLI history scope.',
  configDirPlaceholder: '~/.cursor (default)',
  disableAutoUpdate: 'Disable auto-update',
  disableAutoUpdateLabel: 'Disable Cursor CLI auto-update',
  save: 'Save',
  saveIncomplete: "The save didn't finish. Check your input and try again. Settings that were saved successfully are kept.",

  environment: 'Runtime environment',
  detectAgain: 'Check again',
  detectFailed: "Couldn't detect the runtime environment",
  cliVersion: 'Cursor CLI version',
  unknown: 'Unknown',
  cliPath: 'CLI path',
  customService: 'Custom service',
  cliAccount: 'CLI account',
  connected: 'Connected',
  signedIn: 'Signed in',
  notSignedIn: 'Not signed in',
  persistence: 'Persistence',
  checkedAt: 'Checked at',
  notDetected: 'No runtime environment detected yet.',
  detectedModels: 'Detected Cursor models',
  fullReport: 'View the full capability report',
  runCommand: 'Run command',
  status: 'Status',
  models: 'Model',
  account: 'Account',
  team: 'Team',
  plugins: 'Plugins',
  command: 'Command',
  args: 'Arguments',
  argsPlaceholder: 'Arguments (space-separated)',
  argsInvalid: 'Arguments must be a JSON string array or space-separated',
  commandFailed: 'Command failed',
  run: 'Run',
  commandScope: (project) => `Commands are checked against the server allowlist and run within ${project ? `"${project}"` : 'the user scope'}.`,
  exitCode: (code) => `Exit code ${code ?? '?'}`,
  timedOut: 'Timed out',
  truncated: 'Truncated',
  noOutput: '(No output)',
};

export const catalogs: MessageCatalogs<Messages> = { 'zh-Hans': zhHans, en };
export type { Messages };
