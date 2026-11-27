import type { ComponentType } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { IconActivity, IconBot, IconColumns2, IconCornerDownLeft, IconCpu, IconDatabase, IconFileCog, IconGauge, IconHardDriveDownload, IconImage, IconInfo, IconKeyboard, IconLaptop, IconLayers, IconLink, IconMessagesSquare, IconPanelLeft, IconPanelRight, IconPencilLine, IconSend, IconServer, IconSettings2, IconSmartphone, IconSparkles, IconSquareArrowOutUpRight, IconSquareKanban, IconSun, IconSwatchBook, IconTerminal, IconUser, IconWrapText } from '@/components/icons';

/**
 * Shared by the settings navigation and command palette. `appearance` is the theme page: the
 * appearance page it named was split into its group's pages, and links to it keep working. A page
 * a plugin contributes is named by its view id (`<pluginId>/<name>`). `design` opens the
 * standalone design-system page (`/design`) and closes Settings.
 */
export type SettingsSection = 'profile' | 'general' | 'appearance' | 'typography' | 'sidebar' | 'tabs' | 'views' | 'terminal' | 'appicon' | 'design' | 'interaction' | 'shortcuts' | 'notifications' | 'titles' | 'files' | 'backends' | 'providers' | 'integrations' | 'auxiliary' | 'quickchat' | 'assistant' | 'workitems' | 'connection' | 'shares' | 'devices' | 'links' | 'channels' | 'service' | 'storage' | 'backup' | 'diagnostics' | 'about' | PluginSettingsSection;
export type PluginSettingsSection = `${string}/${string}`;

/** The navigation's groups. 个人资料 and 通用设置 stand alone at the top, untitled; the others are titled. */
export type SettingsSectionGroup = 'general' | 'appearance' | 'behavior' | 'features' | 'models' | 'access' | 'server' | 'support';

const groupTitles: Record<SettingsSectionGroup, MessageDescriptor | undefined> = {
  general: undefined,
  appearance: msg`外观`,
  behavior: msg`行为`,
  features: msg`功能`,
  models: msg`模型`,
  access: msg({ message: '连接', context: 'settings-group' }),
  server: msg`服务器`,
  support: msg`支持`,
};

/** A group's heading, resolved when read like the labels below; `undefined` for 通用设置's. */
export function settingsGroupTitle(group: SettingsSectionGroup): string | undefined {
  const title = groupTitles[group];
  return title && i18n._(title);
}

export type SettingsSectionIcon = ComponentType<{ className?: string }>;

export interface SettingsSectionItem {
  id: SettingsSection;
  label: string;
  group: SettingsSectionGroup;
  /** Each page has its own icon; a subpage's shows only where it is listed on its own (the command palette). */
  icon: SettingsSectionIcon;
  /** Search terms in both languages so settings navigation and the command palette match settings inside a page. */
  keywords: string;
  /** A subpage: opened from a row on its parent page, which stays selected in the navigation. */
  parent?: SettingsSection;
}

interface SettingsSectionDefinition extends Omit<SettingsSectionItem, 'label'> {
  label: MessageDescriptor;
}

const definitions: readonly SettingsSectionDefinition[] = [
  { id: 'profile', label: msg`个人资料`, group: 'general', icon: IconUser, keywords: 'profile avatar name 头像 昵称' }, // i18n-ignore
  { id: 'general', label: msg`通用设置`, group: 'general', icon: IconSettings2, keywords: 'general language locale settings modal dialog page presentation 语言 地区 设置 弹窗 整页' }, // i18n-ignore
  { id: 'appearance', label: msg`主题`, group: 'appearance', icon: IconSun, keywords: 'theme dark light color palette syntax highlight code 浅色 深色 配色 代码高亮 背景' }, // i18n-ignore
  { id: 'typography', label: msg`排版`, group: 'appearance', icon: IconWrapText, keywords: 'font typography size density spacing width 字体 字号 间距 阅读列宽' }, // i18n-ignore
  { id: 'sidebar', label: msg`侧栏`, group: 'appearance', icon: IconPanelLeft, keywords: 'sidebar pin navigation order 固定 导航 排序' }, // i18n-ignore
  { id: 'tabs', label: msg`标签页`, group: 'appearance', icon: IconColumns2, keywords: 'tabs preview keep strip inline 临时标签 标题栏' }, // i18n-ignore
  { id: 'views', label: msg`视图`, group: 'appearance', icon: IconPanelRight, keywords: 'views panel dock float 侧边面板 悬浮 停靠' }, // i18n-ignore
  { id: 'terminal', label: msg`终端`, group: 'appearance', icon: IconTerminal, keywords: 'terminal shell font padding 字体 字号 边距' }, // i18n-ignore
  { id: 'appicon', label: msg`图标`, group: 'appearance', icon: IconImage, keywords: 'icon app permission shield 应用图标 权限图标' }, // i18n-ignore
  { id: 'interaction', label: msg`输入`, group: 'behavior', icon: IconCornerDownLeft, keywords: 'input enter send voice dictation microphone 回车 发送 语音输入 麦克风' }, // i18n-ignore
  { id: 'shortcuts', label: msg`快捷键`, group: 'behavior', icon: IconKeyboard, keywords: 'shortcuts keybinding hotkey 改键 组合键' }, // i18n-ignore
  { id: 'notifications', label: msg`通知`, group: 'behavior', icon: IconActivity, keywords: 'notifications alert push desktop 桌面通知 推送 提醒' }, // i18n-ignore
  { id: 'titles', label: msg`会话标题`, group: 'behavior', icon: IconPencilLine, keywords: 'title rules naming auto 自动命名 标题规则' }, // i18n-ignore
  { id: 'files', label: msg`文件与编辑器`, group: 'behavior', icon: IconFileCog, keywords: 'files editor directory workspace 外部编辑器 无项目目录 工作区' }, // i18n-ignore
  { id: 'assistant', label: msg`个人助理`, group: 'features', icon: IconBot, keywords: 'assistant followup memory packs delegation 跟进 记忆整理 能力包 委托' }, // i18n-ignore
  { id: 'workitems', label: msg`任务看板`, group: 'features', icon: IconSquareKanban, keywords: 'tasks workitems board verify kanban 任务 核验 看板' }, // i18n-ignore
  { id: 'quickchat', label: msg`模型对话`, group: 'features', icon: IconMessagesSquare, keywords: 'model chat quickchat presets archive 快速对话 预设 归档' }, // i18n-ignore
  { id: 'channels', label: msg`机器人`, group: 'features', icon: IconSend, keywords: 'bot channels im feishu lark 飞书 通道 绑定' }, // i18n-ignore
  { id: 'backends', label: msg`Agent`, group: 'models', icon: IconSparkles, keywords: 'agent cli default approval launch 默认 启动设置 审批' }, // i18n-ignore
  { id: 'providers', label: msg`模型提供商`, group: 'models', icon: IconLayers, keywords: 'provider model api key gateway proxy quota endpoint 网关 代理 密钥 额度' }, // i18n-ignore
  { id: 'auxiliary', label: msg`辅助模型`, group: 'models', icon: IconCpu, keywords: 'auxiliary title summary translate probe speed 标题 摘要 翻译 测速' }, // i18n-ignore
  { id: 'connection', label: msg`连接与访问`, group: 'access', icon: IconLaptop, keywords: 'connection access auth token lan share 令牌 局域网 登录 分享' }, // i18n-ignore
  { id: 'shares', label: msg`会话分享`, group: 'access', icon: IconSquareArrowOutUpRight, parent: 'connection', keywords: 'shares publish link 分享 链接' }, // i18n-ignore
  { id: 'devices', label: msg`设备管理`, group: 'access', icon: IconSmartphone, keywords: 'devices phone pair qr revoke 手机 配对 二维码 撤销' }, // i18n-ignore
  { id: 'links', label: msg`互联`, group: 'access', icon: IconLink, keywords: 'links multi server ssh devbox peer 多服务器 链接串' }, // i18n-ignore
  { id: 'service', label: msg`服务管理`, group: 'server', icon: IconServer, keywords: 'service monitor cpu memory process restart reclaim 内存 进程 监控 重启 回收' }, // i18n-ignore
  { id: 'storage', label: msg`存储空间`, group: 'server', icon: IconDatabase, keywords: 'storage disk cache cleanup snapshot 磁盘 清理 缓存 快照' }, // i18n-ignore
  { id: 'backup', label: msg`备份与恢复`, group: 'server', icon: IconHardDriveDownload, keywords: 'backup restore export import 导出 导入 迁移' }, // i18n-ignore
  { id: 'diagnostics', label: msg`诊断`, group: 'support', icon: IconGauge, keywords: 'diagnostics logs status check 日志 状态 检查' }, // i18n-ignore
  { id: 'design', label: msg`设计规范`, group: 'support', icon: IconSwatchBook, keywords: 'design system components tokens 组件 规范' }, // i18n-ignore
  { id: 'about', label: msg`关于 Riffet`, group: 'support', icon: IconInfo, keywords: 'about version update changelog 版本 更新日志' }, // i18n-ignore
];

/**
 * Labels are resolved when read rather than when this module loads: the navigation inventory is a
 * module constant shared with the command palette, but the active locale is not known at import.
 */
export const settingsSections: readonly SettingsSectionItem[] = definitions.map(({ label, ...section }) => ({
  ...section,
  get label() { return i18n._(label); },
}));

export const settingsNavigationSections = settingsSections.filter((section) => !section.parent);

/** First top-level settings section, used when opening Settings with no prior visit stored. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = settingsNavigationSections[0]!.id;

/** Resolves a raw section id (from a URL or caller) to a known settings section, or `undefined`. `design` is a standalone page, not a persisted settings section. */
export function resolveSettingsSection(raw: string | undefined): SettingsSection | undefined {
  if (!raw || raw === 'design') return undefined;
  return settingsSections.find((item) => item.id === raw)?.id;
}

/** Filters top-level navigation sections by space-separated tokens across label, group title, and keywords. */
export function filterSettingsNavigation(query: string): readonly SettingsSectionItem[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return settingsNavigationSections;
  return settingsNavigationSections.filter((item) => {
    const groupTitle = settingsGroupTitle(item.group) ?? '';
    const subpages = settingsSections.filter((entry) => entry.parent === item.id);
    const haystack = [
      item.label,
      item.id,
      groupTitle,
      item.keywords,
      ...subpages.flatMap((sub) => [sub.label, sub.id, sub.keywords]),
    ].join(' ').toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
