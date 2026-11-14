import { useLingui } from '@lingui/react/macro';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Plate, Reveal } from '../specimen';
import { Pipeline } from './Pipeline';

interface Layer { name: string; holds: string; paths: string[] }

/** The six layers from the page down to the principles; each refers only to the ones below it. */
function Layers({ layers }: { layers: Layer[] }) {
  const { t } = useLingui();
  return (
    <Frame className="p-2">
      <div className="relative flex flex-col">
        {layers.map((layer, index) => (
          <Reveal key={layer.name} delay={index * 70}>
            <div className={cn('grid grid-cols-[3rem_minmax(0,9rem)_minmax(0,1fr)_minmax(0,1.3fr)] items-baseline gap-x-6 gap-y-1 rounded-xl px-4 py-4 transition-colors hover:bg-bg max-md:grid-cols-[2rem_minmax(0,1fr)]', index > 0 && 'edge-t')}>
              <span className="font-mono text-xs tabular-nums text-fg-4">{layers.length - index}</span>
              <span className="text-base font-semibold text-fg">{layer.name}</span>
              <span className="text-sm text-fg-2 max-md:col-start-2">{layer.holds}</span>
              <span className="flex flex-col gap-0.5 font-mono text-2xs text-fg-3 max-md:col-start-2">{layer.paths.map((path) => <span key={path} className="[overflow-wrap:anywhere]">{path}</span>)}</span>
            </div>
          </Reveal>
        ))}
      </div>
      <p className="px-4 pb-3 pt-2 text-xs text-fg-3">{t`上层引用下层的名字，下层不知道上层。`}</p>
    </Frame>
  );
}

function Commands({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <span className="text-sm font-medium text-fg">{title}</span>
      <div className="flex flex-col rounded-xl bg-bg shadow-[0_0_0_1px_var(--line)] [&>*+*]:edge-t">
        {rows.map(([command, effect]) => (
          <div key={command} className="flex flex-col gap-1 px-4 py-3">
            <span className="font-mono text-xs text-fg">{command}</span>
            <span className="text-sm text-fg-3">{effect}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ArchitectureChapter() {
  const { t } = useLingui();
  const layers: Layer[] = [
    { name: t`页面`, holds: t`产品功能`, paths: ['apps/web/src/app/', 'apps/macos/Riffet/Features/'] },
    { name: t({ message: '模式', context: 'design-system-layer' }), holds: t`页面骨架、设置行、弹窗结构、确认与通知`, paths: ['docs/design/system/patterns.md', 'app/settings/SettingsLayout.tsx', 'lib/dialogs.ts · lib/toast.ts'] },
    { name: t`组件`, holds: t`每种组件每端一个实现`, paths: ['apps/web/src/components/ui/', 'apps/macos/Riffet/Theme/', 'apps/mobile/shared/…/riffet/ui/design/', 'apps/mobile/iosApp/Riffet/Design/'] },
    { name: t`生成文件`, holds: t`各端直接引用的常量，由生成器写入`, paths: ['Theme/Controls.swift · RiffetTheme.swift', 'MobileStyles.generated.kt', 'RiffetDesign.swift'] },
    { name: t`源`, holds: t`颜色角色与主题取值；间距、字号、圆角、动效；风格配方`, paths: ['apps/web/src/styles/index.css', 'packages/contracts/src/design-tokens.ts', 'mobile-styles.ts · interface-styles.ts · theme.ts'] },
    { name: t`原则`, holds: t`三条原则与设计决定`, paths: ['docs/design/system/README.md', 'docs/design/DECISIONS.md'] },
  ];
  const steps: Array<{ title: string; items: string[] }> = [
    { title: t`新增一个取值`, items: [t`改源：index.css 或 packages/contracts`, t`运行对应的 gen 命令`, t`运行 --check 与 check:design`, t`在 foundations.md 写明用途`] },
    { title: t`新增一个组件`, items: [t`确认现有组件加一个参数能否覆盖`, t`按模板写规范`, t`依次实现 Web、Mac、Android、iOS`, t`迁移调用点，删除旧写法`] },
    { title: t`新增一种模式`, items: [t`写进 patterns.md`, t`列出不符合的现有实现`, t`迁移后删掉对应的现状条目`] },
    { title: t`推翻一条规则`, items: [t`在 DECISIONS.md 追加新决定`, t`写明原因与否决的做法`, t`再改规范与代码`] },
  ];
  return (
    <Chapter title={t`架构`} lede={t`设计体系在代码里分六层，依赖只向下。颜色在 index.css 里改，其余数值在 packages/contracts 里改，然后重新生成。`} source="docs/design/system/architecture.md">
      <Plate number={1} title={t`分层`} note={t`页面只经组件和模式使用样式；组件只引用颜色角色和档位。`}>
        <Layers layers={layers} />
      </Plate>
      <Plate number={2} title={t`一处定义，四端生成`} note={t`间距、字号、圆角、动效以 packages/contracts 为源；颜色以 index.css 为源。`}>
        <Pipeline />
      </Plate>
      <Plate number={3} title={t`生成与检查`} note={t`每个生成命令都有 --check 模式，生成结果过期时以非零状态退出。`}>
        <Frame className="grid gap-6 p-6 md:grid-cols-2 max-md:p-4">
          <Commands title={t`生成`} rows={[
            ['pnpm gen:theme', t`主题颜色写入 Mac、Android、iOS 与 Web 的主题文件`],
            ['pnpm gen:tokens', t`间距、字号、圆角、动效写入四端`],
            ['pnpm gen:styles', t`风格配方写入 Mac 的 InterfaceStyles.swift`],
          ]} />
          <Commands title={t({ message: '检查', context: 'design-system-checks' })} rows={[
            ['pnpm check:design', t`手写的字号、圆角、层级、色值与无说明的循环动画`],
            ['pnpm check:motion', t`绕过 lib/motion.ts 读取动画状态`],
            ['pnpm check:compose', t`导致重建或逐帧重组的 Compose 写法`],
            ['pnpm i18n:check', t`消息之外新增的中文字面量`],
          ]} />
        </Frame>
      </Plate>
      <Plate number={4} title={t`改动的顺序`} note={t`规则先于实现：先改规范，再改代码。`}>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, index) => (
            <Reveal key={step.title} delay={index * 80}>
              <Frame className="flex h-full flex-col gap-4 p-5">
                <span className="text-sm font-medium text-fg">{step.title}</span>
                <ol className="flex flex-col gap-2.5">
                  {step.items.map((item, at) => (
                    <li key={item} className="flex gap-3 text-sm text-fg-2">
                      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-fg/[0.07] font-mono text-2xs tabular-nums text-fg-2">{at + 1}</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ol>
              </Frame>
            </Reveal>
          ))}
        </div>
      </Plate>
    </Chapter>
  );
}
