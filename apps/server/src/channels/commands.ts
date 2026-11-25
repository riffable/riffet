/*
 * The slash commands the channel handles itself. Any other `/...` text goes to the conversation
 * unchanged, so each CLI keeps its own slash commands (docs/design/channels.md, 入站流程).
 */

export type ChannelCommand =
  | { name: 'new' | 'stop' | 'project' | 'model' | 'status' | 'help' }
  | { name: 'flat'; value?: 'on' | 'off' }
  | { name: 'bind'; code: string };

export function parseCommand(text: string): ChannelCommand | undefined {
  // A bare slash opens the command panel like /help.
  if (text.trim() === '/') return { name: 'help' };
  const match = /^\/([a-z]+)(?:\s+(.*))?$/i.exec(text.trim());
  if (!match) return undefined;
  const name = match[1]!.toLowerCase();
  const rest = (match[2] ?? '').trim();
  switch (name) {
    case 'new': case 'stop': case 'project': case 'model': case 'status': case 'help': return { name };
    case 'flat': return { name, ...(rest === 'on' || rest === 'off' ? { value: rest } : {}) };
    case 'bind': return { name, code: rest };
    default: return undefined;
  }
}

export type CommandSection = '会话' | '设置' | '其他';

/** What `/help` lists, by section; the command panel and the text fallback share it. */
export const COMMANDS: ReadonlyArray<{ section: CommandSection; usage: string; description: string }> = [
  { section: '会话', usage: '/new', description: '开始新会话；个人助理里是开始新话题' },
  { section: '会话', usage: '/stop', description: '停止进行中的回合' },
  { section: '会话', usage: '/status', description: '查看项目、会话和模型' },
  { section: '设置', usage: '/project', description: '切换这个聊天的项目' },
  { section: '设置', usage: '/model', description: '切换模型、推理强度、上下文窗口和速度' },
  { section: '设置', usage: '/flat on|off', description: '群里共用一个会话，或按话题分会话' },
  { section: '其他', usage: '/bind <码>', description: '用 Riffet 里生成的绑定码绑定账号（仅私聊）' },
  { section: '其他', usage: '/help', description: '查看这些命令' },
];

const PASS_THROUGH_NOTE = '其他以 / 开头的消息原样发给会话';

/** Quick buttons of the command panel; a press runs the command as if typed. */
const QUICK_BUTTONS = [
  { action: 'status', label: '状态' },
  { action: 'model', label: '模型' },
  { action: 'new', label: '新会话' },
] as const;

/** The panel's content; `/flat` only makes sense in a group. */
export function panelContent(chatType: 'p2p' | 'group'): { sections: Array<{ title: string; commands: Array<{ usage: string; description: string }> }>; quick: Array<{ action: string; label: string }>; note: string } {
  const sections = (['会话', '设置', '其他'] as const).map(title => ({
    title,
    commands: COMMANDS.filter(command => command.section === title && (chatType === 'group' || !command.usage.startsWith('/flat'))).map(({ usage, description }) => ({ usage, description })),
  }));
  return { sections, quick: QUICK_BUTTONS.map(button => ({ ...button })), note: PASS_THROUGH_NOTE };
}

/** A quick button's `action` as a command; anything else is not one. */
export const commandOfAction = (action: string): ChannelCommand | undefined => QUICK_BUTTONS.find(button => button.action === action) ? { name: QUICK_BUTTONS.find(button => button.action === action)!.action } : undefined;

export const helpText = (): string => [
  ...COMMANDS.map(command => `- \`${command.usage}\` ${command.description}`),
  '',
  PASS_THROUGH_NOTE,
].join('\n');

/** IM-facing replies; short and plain. */
export const REPLY = {
  bound: '已绑定',
  bindFailed: '绑定码无效或已过期',
  newSession: '已开始新会话',
  newTopic: '已开始新话题，记忆保留',
  noSession: '还没有会话',
  stopped: '已请求停止',
  nothingRunning: '没有进行中的回合',
  flatOn: '这个群共用一个会话',
  flatOff: '这个群按话题分会话',
  flatGroupOnly: '只有群聊可以设置',
  noProjects: '还没有可用的项目，请先在 Riffet 里添加',
  projectChanged: (name: string) => `项目已切换为 ${name}`,
  modelSwitched: (summary: string) => `已切换为 ${summary}`,
  modelNextTurn: '下一个回合生效',
  modelUnavailable: '读不到模型列表',
  cardExpired: '这张卡片已失效',
  failed: (reason: string) => `没有发出去：${reason}`,
} as const;
