import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { THEME_ANSI_KEYS, type CodeThemeRole, type ThemeRole } from '@contracts';

/**
 * How the editor presents the palette. The grouping and labels are presentation only; the role
 * list itself comes from the contract, so a role added to the stylesheet shows up in a group the
 * moment the generator accepts it. `Record<ThemeRole, string>` makes a forgotten label a type error.
 */
export interface ThemeRoleGroup {
  title: string;
  roles: readonly ThemeRole[];
}

/** Read through a proxy so a label follows the active language at the moment a view renders it. */
function translatedRecord<K extends string>(messages: Record<K, MessageDescriptor | string>): Record<K, string> {
  return new Proxy(messages, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || !Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
      const message = target[key as K];
      return typeof message === 'string' ? message : i18n._(message);
    },
  }) as unknown as Record<K, string>;
}

export const THEME_ROLE_GROUPS: readonly ThemeRoleGroup[] = [
  { get title() { return i18n._(msg`背景`); }, roles: ['bg', 'bg-sidebar', 'bg-subtle', 'bg-muted', 'bg-elevated', 'bg-popover', 'bg-hover', 'bg-active', 'bg-bubble'] },
  { get title() { return i18n._(msg`文本`); }, roles: ['fg', 'fg-2', 'fg-3', 'fg-4'] },
  { get title() { return i18n._(msg`分隔线`); }, roles: ['line', 'line-soft', 'line-strong'] },
  { get title() { return i18n._(msg({ message: '主要操作', context: 'common-theme-role-primary' })); }, roles: ['primary', 'primary-hover', 'primary-fg'] },
  { get title() { return i18n._(msg`强调色`); }, roles: ['accent', 'accent-hover', 'accent-soft', 'accent-fg'] },
  { get title() { return i18n._(msg({ message: '状态', context: 'common-theme-role-state' })); }, roles: ['success', 'success-soft', 'warning', 'warning-soft', 'danger', 'danger-soft', 'danger-fg'] },
  { title: 'Diff', roles: ['diff-add', 'diff-add-gutter', 'diff-add-marker', 'diff-add-strong', 'diff-del', 'diff-del-gutter', 'diff-del-marker', 'diff-del-strong'] },
  { get title() { return i18n._(msg`工具提示`); }, roles: ['toast'] },
  { title: 'Agent', roles: ['agent-cursor', 'agent-codex', 'agent-claude', 'agent-dsh'] },
  { get title() { return i18n._(msg`图表`); }, roles: ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8'] },
];

export const THEME_ROLE_LABELS: Record<ThemeRole, string> = translatedRecord({
  bg: msg`页面背景`,
  'bg-sidebar': msg`侧栏`,
  'bg-subtle': msg`次级背景`,
  'bg-muted': msg`弱化背景`,
  'bg-elevated': msg`浮层背景`,
  'bg-popover': msg`弹出层`,
  'bg-hover': msg`悬停背景`,
  'bg-active': msg`激活背景`,
  'bg-bubble': msg`气泡背景`,
  fg: msg({ message: '正文', context: 'common-theme-role-body' }),
  'fg-2': msg`次要文本`,
  'fg-3': msg`辅助文本`,
  'fg-4': msg`占位文本`,
  line: msg`分隔线`,
  'line-soft': msg`淡分隔线`,
  'line-strong': msg`强调分隔线`,
  primary: msg`主按钮`,
  'primary-hover': msg`主按钮悬停`,
  'primary-fg': msg`主按钮文字`,
  accent: msg`强调色`,
  'accent-hover': msg`强调色悬停`,
  'accent-soft': msg`强调浅底`,
  'accent-fg': msg`强调色文字`,
  success: msg`成功`,
  'success-soft': msg`成功浅底`,
  warning: msg`警告`,
  'warning-soft': msg`警告浅底`,
  danger: msg`危险`,
  'danger-soft': msg`危险浅底`,
  'danger-fg': msg`危险文字`,
  'diff-add': msg`新增行`,
  'diff-add-gutter': msg`新增行号`,
  'diff-add-marker': msg`新增标记`,
  'diff-add-strong': msg`新增强调`,
  'diff-del': msg`删除行`,
  'diff-del-gutter': msg`删除行号`,
  'diff-del-marker': msg`删除标记`,
  'diff-del-strong': msg`删除强调`,
  toast: msg`工具提示`,
  'toast-success': msg`成功提示`,
  'toast-danger': msg`危险提示`,
  'agent-cursor': 'Cursor',
  'agent-codex': 'Codex',
  'agent-claude': 'Claude',
  'agent-dsh': 'DSH',
  'chart-1': msg`图表 1`,
  'chart-2': msg`图表 2`,
  'chart-3': msg`图表 3`,
  'chart-4': msg`图表 4`,
  'chart-5': msg`图表 5`,
  'chart-6': msg`图表 6`,
  'chart-7': msg`图表 7`,
  'chart-8': msg`图表 8`,
});

export const THEME_ANSI_LABELS: Record<(typeof THEME_ANSI_KEYS)[number], string> = translatedRecord({
  black: msg`黑`,
  red: msg`红`,
  green: msg`绿`,
  yellow: msg`黄`,
  blue: msg`蓝`,
  magenta: msg`品红`,
  cyan: msg`青`,
  white: msg`白`,
  brightBlack: msg`亮黑`,
  brightRed: msg`亮红`,
  brightGreen: msg`亮绿`,
  brightYellow: msg`亮黄`,
  brightBlue: msg`亮蓝`,
  brightMagenta: msg`亮品红`,
  brightCyan: msg`亮青`,
  brightWhite: msg`亮白`,
});

export const CODE_ROLE_LABELS: Record<CodeThemeRole, string> = translatedRecord({
  comment: msg`注释`,
  keyword: msg`关键字`,
  string: msg`字符串`,
  number: msg`数字`,
  constant: msg`常量`,
  declaration: msg`函数与声明`,
  type: msg`类型`,
  property: msg`成员属性`,
  namespace: msg`命名空间`,
  tag: msg({ message: '标签', context: 'code-syntax-role-tag' }),
  attribute: msg`属性名`,
  annotation: msg`注解`,
  escape: msg`转义与插值`,
  heading: msg({ message: '标题', context: 'code-syntax-role-heading' }),
});

/**
 * The pairs the editor advises on. Contrast is advice, never a save gate: a theme can be saved
 * while a warning stands, which is what lets a reader keep a deliberately low-contrast palette.
 */
export interface ThemeContrastCheck {
  label: string;
  foreground: ThemeRole;
  background: ThemeRole;
  minimum: number;
}

export const THEME_CONTRAST_CHECKS: readonly ThemeContrastCheck[] = [
  { get label() { return i18n._(msg`正文 / 页面`); }, foreground: 'fg', background: 'bg', minimum: 4.5 },
  { get label() { return i18n._(msg`次要文本 / 页面`); }, foreground: 'fg-2', background: 'bg', minimum: 4.5 },
  { get label() { return i18n._(msg`辅助文本 / 页面`); }, foreground: 'fg-3', background: 'bg', minimum: 3 },
  { get label() { return i18n._(msg`强调色 / 页面`); }, foreground: 'accent', background: 'bg', minimum: 3 },
  { get label() { return i18n._(msg`强调文字 / 强调色`); }, foreground: 'accent-fg', background: 'accent', minimum: 4.5 },
  { get label() { return i18n._(msg`主按钮文字 / 主按钮`); }, foreground: 'primary-fg', background: 'primary', minimum: 4.5 },
  { get label() { return i18n._(msg`成功 / 页面`); }, foreground: 'success', background: 'bg', minimum: 3 },
  { get label() { return i18n._(msg`警告 / 页面`); }, foreground: 'warning', background: 'bg', minimum: 3 },
  { get label() { return i18n._(msg`危险 / 页面`); }, foreground: 'danger', background: 'bg', minimum: 3 },
];
