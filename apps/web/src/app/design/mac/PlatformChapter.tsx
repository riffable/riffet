import { useLingui } from '@lingui/react/macro';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Plate, Token } from '../specimen';

function Column({ title, items }: { title: string; items: Array<[string, string]> }) {
  return (
    <div className="flex flex-col gap-4">
      <h4 className="text-sm font-medium text-fg">{title}</h4>
      <ul className="flex flex-col edge-b">
        {items.map(([rule, api]) => (
          <li key={rule} className="flex items-baseline justify-between gap-4 py-2.5 edge-t">
            <span className="text-sm text-fg-2">{rule}</span>
            <Token className="shrink-0 text-fg-3">{api}</Token>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlatformChapter() {
  const { t } = useLingui();
  const platform: Array<[string, string]> = [
    [t`设置是独立窗口，⌘, 打开`, 'Settings'],
    [t`弹窗是附着在窗口上的 sheet`, '.sheet'],
    [t`右键菜单用系统菜单`, '.contextMenu'],
    [t`设置表单用系统控件`, '.riffetForm()'],
    [t`提示气泡用系统的`, '.help'],
    [t`工具栏的命令在菜单栏都有对应项`, 'RiffetCommands'],
    [t`窗口失焦时选中态变淡`, 'appearsActive'],
  ];
  const shared: Array<[string, string]> = [
    [t`文字角色`, 'RiffetFont'],
    [t`间距档位`, 'Space'],
    [t`圆角档位`, 'Radius'],
    [t`阴影档位`, '.elevation(_:)'],
    [t`动效档位`, 'Motion'],
    [t`页面的内容列与内边距`, 'PageScaffold'],
    [t`弹窗的四档宽度与页脚`, 'SheetScaffold'],
    [t`选择控件的选用规则`, 'patterns.md §3'],
  ];
  const generated: Array<[string, string, string]> = [
    ['pnpm gen:theme', 'index.css', 'Theme/RiffetTheme.swift'],
    ['pnpm gen:tokens', 'design-tokens.ts', 'Theme/Controls.swift'],
    ['pnpm gen:styles', 'interface-styles.ts', 'Theme/InterfaceStyles.swift'],
    ['pnpm gen:mac-icons', 'icon-map.json', 'Theme/IconSymbols.generated.swift'],
  ];
  return (
    <Chapter title={t`平台分工`} lede={t`行为跟 macOS 的人机界面指南，外观跟风格配方；桌面的数值 Mac 与 Web 相同，单位是 pt。`} source="docs/design/system/macos.md">
      <Plate number={1} title={t`跟平台，还是跟 Web`} note={t`用户在 Mac 上已有的预期：窗口、sheet、右键菜单和快捷键，照系统的做。其余取 Web 的同一组值。`}>
        <div className="grid gap-10 md:grid-cols-2">
          <Column title={t`跟平台`} items={platform} />
          <Column title={t`跟 Web`} items={shared} />
        </div>
      </Plate>
      <Plate number={2} title={t`生成到 Mac`} note={t`Mac 不手写这些值：改源文件，运行生成器，再用 --check 确认生成物最新。`}>
        <Frame className="flex flex-col p-6 max-md:p-4">
          {generated.map(([command, source, target], index) => (
            <div key={command} className={cn('grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.4fr)] items-baseline gap-4 py-3 max-md:grid-cols-1 max-md:gap-1', index > 0 && 'edge-t')}>
              <Token>{command}</Token>
              <Token className="text-fg-3">{source}</Token>
              <Token className="text-fg-2">apps/macos/Riffet/{target}</Token>
            </div>
          ))}
        </Frame>
      </Plate>
    </Chapter>
  );
}
