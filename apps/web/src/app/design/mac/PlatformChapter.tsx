import { useLingui } from '@lingui/react/macro';
import { GeneratedList, SplitColumn } from '../platform';
import { Chapter, Plate } from '../specimen';

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
    ['pnpm gen:theme', 'index.css', 'apps/macos/Riffet/Theme/RiffetTheme.swift'],
    ['pnpm gen:tokens', 'design-tokens.ts', 'apps/macos/Riffet/Theme/Controls.swift'],
    ['pnpm gen:styles', 'interface-styles.ts', 'apps/macos/Riffet/Theme/InterfaceStyles.swift'],
    ['pnpm gen:mac-icons', 'icon-map.json', 'apps/macos/Riffet/Theme/IconSymbols.generated.swift'],
  ];
  return (
    <Chapter title={t`平台分工`} lede={t`行为跟 macOS 的人机界面指南，外观跟风格配方；桌面的数值 Mac 与 Web 相同，单位是 pt。`} source="docs/design/system/macos.md">
      <Plate number={1} title={t`跟平台，还是跟 Web`} note={t`用户在 Mac 上已有的预期：窗口、sheet、右键菜单和快捷键，照系统的做。其余取 Web 的同一组值。`}>
        <div className="grid gap-10 md:grid-cols-2">
          <SplitColumn title={t`跟平台`} items={platform} />
          <SplitColumn title={t`跟 Web`} items={shared} />
        </div>
      </Plate>
      <Plate number={2} title={t`生成到 Mac`} note={t`Mac 不手写这些值：改源文件，运行生成器，再用 --check 确认生成物最新。`}>
        <GeneratedList rows={generated} />
      </Plate>
    </Chapter>
  );
}
