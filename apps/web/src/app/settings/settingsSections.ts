import type { ComponentType } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { IconActivity, IconBot, IconColumns2, IconCornerDownLeft, IconCpu, IconDatabase, IconFileCog, IconGauge, IconHardDriveDownload, IconImage, IconInfo, IconLaptop, IconLayers, IconMessagesSquare, IconPanelLeft, IconPanelRight, IconSend, IconServer, IconSettings2, IconSmartphone, IconSparkles, IconSquareArrowOutUpRight, IconSquareKanban, IconSun, IconSwatchBook, IconTerminal, IconUser, IconWrapText } from '@/components/icons';

/** The settings dialog's box, shared with the frame that stands in while its chunk loads. */
export const SETTINGS_DIALOG_CLASS = 'h-[min(820px,calc(100dvh-32px))] flex-col overflow-hidden p-0';

/**
 * Shared by the settings navigation and command palette. `appearance` is the theme page: the
 * appearance page it named was split into its group's pages, and links to it keep working. A page
 * a plugin contributes is named by its view id (`<pluginId>/<name>`). `design` is not a section: it
 * opens the design system's own page, and the dialog closes.
 */
export type SettingsSection = 'profile' | 'general' | 'appearance' | 'typography' | 'sidebar' | 'tabs' | 'views' | 'terminal' | 'appicon' | 'design' | 'interaction' | 'notifications' | 'files' | 'backends' | 'providers' | 'integrations' | 'auxiliary' | 'quickchat' | 'assistant' | 'workitems' | 'connection' | 'shares' | 'devices' | 'channels' | 'service' | 'storage' | 'backup' | 'diagnostics' | 'about' | PluginSettingsSection;
export type PluginSettingsSection = `${string}/${string}`;

/** The navigation's groups. 通用设置 and 个人资料 stand alone at the top, untitled; the others are titled. */
export type SettingsSectionGroup = 'general' | 'appearance' | 'behavior' | 'features' | 'models' | 'access' | 'server' | 'support';

const groupTitles: Record<SettingsSectionGroup, MessageDescriptor | undefined> = {
  general: undefined,
  appearance: msg`外观`,
  behavior: msg`行为`,
  features: msg`功能`,
  models: msg`模型`,
  access: msg`访问`,
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
  /** A subpage: opened from a row on its parent page, which stays selected in the navigation. */
  parent?: SettingsSection;
}

interface SettingsSectionDefinition extends Omit<SettingsSectionItem, 'label'> {
  label: MessageDescriptor;
}

/** The pages every client shares, in their groups, each followed by its subpages. */
const definitions: readonly SettingsSectionDefinition[] = [
  { id: 'profile', label: msg`个人资料`, group: 'general', icon: IconUser },
  { id: 'general', label: msg`通用设置`, group: 'general', icon: IconSettings2 },
    { id: 'appearance', label: msg`主题`, group: 'appearance', icon: IconSun },
  { id: 'typography', label: msg`排版`, group: 'appearance', icon: IconWrapText },
  { id: 'sidebar', label: msg`侧栏`, group: 'appearance', icon: IconPanelLeft },
  { id: 'tabs', label: msg`标签页`, group: 'appearance', icon: IconColumns2 },
  { id: 'views', label: msg`视图`, group: 'appearance', icon: IconPanelRight },
  { id: 'terminal', label: msg`终端`, group: 'appearance', icon: IconTerminal },
  { id: 'appicon', label: msg`应用图标`, group: 'appearance', icon: IconImage },
  { id: 'interaction', label: msg`输入`, group: 'behavior', icon: IconCornerDownLeft },
  { id: 'notifications', label: msg`通知`, group: 'behavior', icon: IconActivity },
  { id: 'files', label: msg`文件与编辑器`, group: 'behavior', icon: IconFileCog },
  { id: 'assistant', label: msg`个人助理`, group: 'features', icon: IconBot },
  { id: 'workitems', label: msg`任务看板`, group: 'features', icon: IconSquareKanban },
  { id: 'quickchat', label: msg`快速对话`, group: 'features', icon: IconMessagesSquare },
  { id: 'channels', label: msg`机器人`, group: 'features', icon: IconSend },
  { id: 'backends', label: msg`Agent`, group: 'models', icon: IconSparkles },
  { id: 'providers', label: msg`模型提供商`, group: 'models', icon: IconLayers },
  { id: 'auxiliary', label: msg`辅助模型`, group: 'models', icon: IconCpu },
  { id: 'connection', label: msg`连接与访问`, group: 'access', icon: IconLaptop },
  { id: 'shares', label: msg`会话分享`, group: 'access', icon: IconSquareArrowOutUpRight, parent: 'connection' },
  { id: 'devices', label: msg`设备管理`, group: 'access', icon: IconSmartphone },
  { id: 'service', label: msg`服务管理`, group: 'server', icon: IconServer },
  { id: 'storage', label: msg`存储空间`, group: 'server', icon: IconDatabase },
  { id: 'backup', label: msg`备份与恢复`, group: 'server', icon: IconHardDriveDownload },
  { id: 'diagnostics', label: msg`诊断`, group: 'support', icon: IconGauge },
  { id: 'design', label: msg`设计规范`, group: 'support', icon: IconSwatchBook },
  { id: 'about', label: msg`关于 Riffet`, group: 'support', icon: IconInfo },
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
