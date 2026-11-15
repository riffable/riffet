import { useLingui } from '@lingui/react/macro';
import { GeneratedList, SplitColumn } from '../platform';
import { Chapter, Frame, Plate } from '../specimen';

export function PlatformChapter() {
  const { t } = useLingui();
  const platform: Array<[string, string]> = [
    [t`系统返回与预测式返回`, 'PageBackDispatcher'],
    [t`内容画到系统栏下，按 inset 让位`, 'enableEdgeToEdge'],
    [t`长按打开操作菜单`, 'combinedClickable'],
    [t`点击区至少 48`, 'controlHeight'],
    [t`短暂反馈`, 'Snackbar'],
    [t`字体倍率与动画时长缩放`, 'fontScale'],
    [t`权限、文件选择与分享`, t`系统界面`],
  ];
  const shared: Array<[string, string]> = [
    [t`颜色角色`, 'LocalRiffetColors'],
    [t`文字角色`, 'LocalRiffetTypography'],
    [t`尺寸、间距、圆角`, 'DesignMetrics'],
    [t`动效档位`, 'LocalRiffetMotion'],
    [t`组件的种类与状态`, 'ui/design/'],
    [t`选择控件的选用规则`, 'patterns.md §3'],
    [t`确认、反馈与空状态`, 'patterns.md'],
  ];
  const generated: Array<[string, string, string]> = [
    ['pnpm gen:theme', 'index.css', 'riffet/theme/RiffetTheme.kt'],
    ['pnpm gen:tokens', 'mobile-styles.ts', 'riffet/ui/design/MobileStyles.generated.kt'],
    ['pnpm gen:icons', 'lucide-react', 'riffet/ui/icons/LucideIcons.generated.kt'],
  ];
  return (
    <Chapter title={t`平台分工`} lede={t`行为跟 Material 3 与 Android 系统，外观跟风格配方；数值以 material3 风格为准，其余风格只改配方里写到的字段。`} source="docs/design/system/android.md">
      <Plate number={1} title={t`跟平台，还是跟共用的规范`} note={t`用户在 Android 上已有的预期：返回手势、长按、Snackbar 和系统界面，照系统的做。其余取共用的语义。`}>
        <div className="grid gap-10 md:grid-cols-2">
          <SplitColumn title={t`跟平台`} items={platform} />
          <SplitColumn title={t`跟共用的规范`} items={shared} />
        </div>
      </Plate>
      <Plate number={2} title={t`风格是配方`} note={t`五种风格只在 themePreset() 里按名字分派一次；组件读 LocalInterfaceStyle 的字段。`}>
        <Frame className="flex flex-col gap-3 p-6 font-mono text-xs text-fg-2 max-md:p-4">
          <span><span className="text-fg-3">LocalInterfaceStyle.current</span>.metrics<span className="ml-4 text-fg-4">// {t`尺寸、间距、圆角`}</span></span>
          <span><span className="text-fg-3">LocalInterfaceStyle.current</span>.components<span className="ml-4 text-fg-4">// {t`每类组件的形态`}</span></span>
          <span><span className="text-fg-3">LocalInterfaceStyle.current</span>.variants<span className="ml-4 text-fg-4">// {t`主题可切换的外观变体`}</span></span>
          <span><span className="text-fg-3">LocalInterfaceStyle.current</span>.motion<span className="ml-4 text-fg-4">// {t`时长与弹簧`}</span></span>
        </Frame>
      </Plate>
      <Plate number={3} title={t`生成到 Android`} note={t`Android 不手写这些值：改源文件，运行生成器，再用 --check 确认生成物最新。`}>
        <GeneratedList rows={generated} />
      </Plate>
    </Chapter>
  );
}
