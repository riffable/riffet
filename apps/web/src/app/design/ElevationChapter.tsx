import { useLingui } from '@lingui/react/macro';
import { cn } from '@/lib/utils';
import { Chapter, display, Frame, Plate, Token, useInView, useRootValue } from './specimen';

/** The five tiers as sheets laid over one another, each casting its own shadow. */
function Sheets() {
  const { t } = useLingui();
  const tiers: Array<{ name: string; token: string; use: string; surface: string }> = [
    { name: t`平面`, token: 'border-line', use: t`卡片、列表、面板`, surface: 'border border-line bg-elevated' },
    { name: t`抬起`, token: 'shadow-soft', use: t`分段控件的选中项、开关滑块`, surface: 'bg-elevated shadow-soft' },
    { name: t`浮动`, token: 'shadow-composer', use: t`输入框；聚焦时加深一级`, surface: 'bg-elevated shadow-composer' },
    { name: t`弹出`, token: 'shadow-pop', use: t`菜单、弹出层、提示气泡、弹窗`, surface: 'bg-popover shadow-pop' },
    { name: t({ message: '悬浮', context: 'elevation' }), token: 'shadow-peek', use: t`悬浮面板、全屏预览`, surface: 'bg-elevated shadow-peek' },
  ];
  const [ref, seen] = useInView({ once: true, margin: '0px 0px -25% 0px' });
  return (
    <div ref={ref}>
    <Frame className="relative aspect-[16/10] max-md:aspect-auto max-md:p-5">
      <div className="absolute inset-0 max-md:static max-md:flex max-md:flex-col max-md:gap-5">
        {tiers.map((tier, index) => (
          <div
            key={tier.token}
            className="absolute w-[40%] transition-[opacity,translate] duration-[calc(var(--duration-slow)*2.4)] ease-[var(--ease-out-soft)] max-md:static max-md:w-full"
            style={{ left: `${5 + index * 12}%`, top: `${6 + index * 12}%`, height: '36%', opacity: seen ? 1 : 0, translate: seen ? '0 0' : '0 -28px', transitionDelay: `${index * 140}ms` }}
          >
            <div className={cn('flex h-full flex-col gap-1.5 rounded-xl px-5 py-4 transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)] hover:-translate-y-1.5 max-md:pb-10', tier.surface)}>
              <div className="flex items-baseline gap-3">
                <span className="text-base font-medium text-fg">{tier.name}</span>
                <Token className="text-fg-3">{tier.token}</Token>
                <span className="ml-auto font-mono text-2xs text-fg-4">{String(index).padStart(2, '0')}</span>
              </div>
              <span className="truncate text-xs text-fg-3">{tier.use}</span>
            </div>
          </div>
        ))}
      </div>
    </Frame>
    </div>
  );
}

function Floor({ token, name, index }: { token: string; name: string; index: number }) {
  const value = Number(useRootValue(`--z-${token}`)) || 0;
  const [ref, seen] = useInView<HTMLLIElement>({ once: true, margin: '0px 0px -10% 0px' });
  return (
    <li ref={ref} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_64px] items-center gap-6 py-3 edge-b">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-fg">{name}</span>
        <Token className="text-fg-3">{`z-${token}`}</Token>
      </div>
      <span className="h-1 origin-left rounded-full bg-fg-3 transition-transform duration-[calc(var(--duration-slow)*3)] ease-[var(--ease-out-soft)]" style={{ width: `${value}%`, transform: seen ? 'none' : 'scaleX(0)', transitionDelay: `${index * 50}ms` }} />
      <span className="text-right font-medium tabular-nums text-fg" style={display(22, '2.2vw', 28)}>{value}</span>
    </li>
  );
}

export function ElevationChapter() {
  const { t } = useLingui();
  const floors: Array<[string, string]> = [
    ['toast', t`通知`],
    ['tooltip', t`提示气泡`],
    ['menu', t`菜单`],
    ['dialog', t`弹窗`],
    ['scrim', t`遮罩`],
    ['drop', t`拖放提示`],
    ['fullscreen', t`全屏`],
    ['dock', t`底部停靠`],
    ['panel', t`侧栏与面板`],
    ['rail', t`对话内导航`],
  ];
  return (
    <Chapter id="elevation" number="05" title={t`层级`} lede={t`层次首先由底色表达。阴影分五档，用于脱离文档流的元素；叠放顺序由一组 --z-* 变量定义。`} tone="canvas" source="apps/web/src/styles/index.css">
      <Plate number="5.1" title={t`阴影`} note={t`阴影随明暗模式切换，与配色无关。Mac 端由生成器换算为 Elevation；SwiftUI 没有扩散参数，按高斯分布折算。`}>
        <Sheets />
      </Plate>
      <Plate number="5.2" title={t`叠放顺序`} note={t`数值越大越靠前。组件引用变量名。`}>
        <ol className="flex flex-col edge-t">
          {floors.map(([token, name], index) => <Floor key={token} token={token} name={name} index={index} />)}
        </ol>
      </Plate>
    </Chapter>
  );
}
