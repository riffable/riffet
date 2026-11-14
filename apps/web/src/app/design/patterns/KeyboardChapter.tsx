import { i18n } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import { IconSearch } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input, Kbd } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { isApplePlatform, shortcutLabel } from '@/lib/platform';
import { primaryEnterHint } from '../../session/composerKeyboard';
import { keybindingCaps, registerKeybindings } from '../../pluginKeybindings';
import { hostShortcuts, type HostShortcut } from '../../hostShortcuts';
import { shortcutCaps } from '../../tabs/keys';
import { Chapter, Frame, Plate } from '../specimen';
import { Mark } from './parts';

const caps = (keys: readonly string[]) => <span className="flex shrink-0 gap-1 whitespace-nowrap">{keys.map((key, index) => <Kbd key={index}>{key}</Kbd>)}</span>;

/** One group of shortcuts: its name and its rows. */
function Group({ title, rows }: { title: string; rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="mb-1 text-xs font-medium text-fg-3">{title}</span>
      {rows.map(([label, keys]) => (
        <div key={label} className="flex items-center justify-between gap-4 border-b border-line py-2 text-sm text-fg">
          <span className="min-w-0 truncate">{label}</span>{keys}
        </div>
      ))}
    </div>
  );
}

function ShortcutMap() {
  const { t } = useLingui();
  const mod = isApplePlatform ? '⌘' : 'Ctrl';
  const rows = (group: HostShortcut['group']) => hostShortcuts.filter((shortcut) => shortcut.group === group).map((shortcut): [string, React.ReactNode] => [
    i18n._(shortcut.label),
    caps(group === 'tabs' ? shortcutCaps(shortcut.keys) : shortcut.keys.map((key) => key === 'Mod' ? mod : key)),
  ]);
  return (
    <Frame className="grid gap-x-10 gap-y-8 p-8 md:grid-cols-2 xl:grid-cols-3 max-md:p-4">
      <Group title={t`工作台`} rows={rows('workbench')} />
      <Group title={t`会话标签页`} rows={rows('tabs')} />
      <Group title={t`输入框`} rows={[
        [t`发送`, caps([primaryEnterHint('newline')])],
        [t`换行`, caps([isApplePlatform ? '⇧' : 'Shift', '↵'])],
        [t`关闭菜单`, caps(['Esc'])],
      ]} />
    </Frame>
  );
}

function Shown() {
  const { t } = useLingui();
  return (
    <Frame className="grid grid-cols-3 gap-6 p-8 max-md:grid-cols-1 max-md:p-4">
      <div className="flex flex-col items-start gap-3">
        <Tip label={t`搜索`} kbd={shortcutLabel('K')}><Button size="icon" variant="secondary" aria-label={t`搜索`}><IconSearch /></Button></Tip>
        <Mark>{'Tip kbd'}</Mark>
      </div>
      <div className="flex flex-col items-start gap-3">
        {caps([isApplePlatform ? '⌘' : 'Ctrl', 'K'])}
        <Mark>Kbd</Mark>
      </div>
      <div className="flex flex-col items-start gap-3">
        <span className="font-mono text-sm text-fg">{shortcutLabel('K')}</span>
        <Mark>shortcutLabel</Mark>
      </div>
    </Frame>
  );
}

function Focus() {
  const { t } = useLingui();
  return (
    <Frame className="flex flex-col gap-6 p-8 max-md:p-4">
      <div className="flex flex-wrap items-center gap-6">
        <Button variant="secondary" tabIndex={-1} className="ring-2 ring-focus">{t`按钮`}</Button>
        <Input defaultValue={t`输入框`} tabIndex={-1} className="w-40 border-accent ring-3 ring-accent/15" />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm text-fg-2">
        {[t`菜单`, t`弹窗`, t`页面`].map((layer, index) => <span key={layer} className="flex items-center gap-3">{index > 0 && <span className="text-fg-4">→</span>}<span className="rounded-lg bg-bg px-3 py-1.5 shadow-[0_0_0_1px_var(--line)]">{layer}</span></span>)}
        <Kbd>Esc</Kbd>
      </div>
    </Frame>
  );
}

function Plugins() {
  const { t } = useLingui();
  const declared = [{ id: 'open-notes', keybinding: 'Mod+Shift+L' }, { id: 'search', keybinding: 'Mod+K' }, { id: 'other', keybinding: 'Mod+Shift+L' }];
  const { rejected } = registerKeybindings(declared, isApplePlatform);
  const reasons = { host: t`工作台已占用`, plugin: t`前一个命令已占用`, invalid: t`不是可用的组合` };
  const row = ({ id, keybinding }: { id: string; keybinding: string }) => {
    const refused = rejected.find((item) => item.id === id);
    return (
      <div key={id} className="flex items-center justify-between gap-4 border-b border-line py-2 text-sm">
        <span className="font-mono text-xs text-fg">{id}</span>{caps(keybindingCaps(keybinding, isApplePlatform))}<span className="w-40 text-right text-xs text-fg-3 max-md:w-auto">{refused ? reasons[refused.reason] : t`已注册`}</span>
      </div>
    );
  };
  return (
    <Frame className="p-8 max-md:p-4">
      <div className="mx-auto flex max-w-xl flex-col">
        {declared.map(row)}
      </div>
    </Frame>
  );
}

export function KeyboardChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`键盘`} lede={t`Mac 用 ⌘，其他平台用 Ctrl；标签页用 ⌥（Alt）。Escape 关闭最上面的一层。`} source="docs/design/system/patterns.md">
      <Plate number={1} title={t`快捷键`} note={t`工作台与标签页两栏读自 hostShortcuts.ts，输入框的发送键随「回车键行为」设置变化。`}>
        <ShortcutMap />
      </Plate>
      <Plate number={2} title={t`显示`} note={t`纯图标按钮的名称旁带快捷键；列表里用 Kbd；文字里用 shortcutLabel。`}>
        <Shown />
      </Plate>
      <Plate number={3} title={t`焦点与 Escape`} note={t`键盘焦点显示 2px 的焦点环，输入框改用强调色边框；浮层关闭后焦点回到打开前输入的位置。`}>
        <Focus />
      </Plate>
      <Plate number={4} title={t`插件快捷键`} note={t`插件只能声明默认值；与工作台或先注册的命令冲突时被拒绝。`}>
        <Plugins />
      </Plate>
    </Chapter>
  );
}
