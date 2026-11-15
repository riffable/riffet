import { useLingui } from '@lingui/react/macro';
import { IconListTodo, IconSettings, IconSquarePen } from '@/components/icons';
import { cn } from '@/lib/utils';
import { SplitColumn } from '../platform';
import { Chapter, Frame, Plate, Value } from '../specimen';
import { ANDROID, ANDROID_STYLES } from './values';

const BASE = ANDROID_STYLES[0]!.dimensions;

/** A material3 page with its bands measured: the top bar, the inset content column, the tab bar. */
function Anatomy() {
  const { t } = useLingui();
  const { width, status, gesture } = ANDROID.phone;
  const height = 520;
  const bands: Array<{ label: string; value: string; top: number; size: number }> = [
    { label: t`顶栏`, value: `barHeight ${BASE.barHeight}`, top: status, size: BASE.barHeight },
    { label: t`正文`, value: `pageInset ${BASE.pageInset}`, top: status + BASE.barHeight, size: height - status - BASE.barHeight - BASE.tabBarHeight - gesture },
    { label: t`底栏`, value: `tabBarHeight ${BASE.tabBarHeight}`, top: height - BASE.tabBarHeight - gesture, size: BASE.tabBarHeight },
  ];
  return (
    <Frame className="flex justify-center gap-10 p-8 max-md:flex-col max-md:items-center max-md:p-4">
      <div className="relative shrink-0 overflow-hidden bg-bg shadow-[0_0_0_1px_var(--line-strong)]" style={{ width, height, borderRadius: 32 }} aria-hidden>
        <div className="absolute inset-x-0 flex items-center px-4 text-fg" style={{ top: status, height: BASE.barHeight, fontSize: 22 }}>{t({ message: '任务', context: 'design-sample' })}</div>
        <div className="absolute flex flex-col gap-3" style={{ top: status + BASE.barHeight + 8, left: BASE.pageInset, right: BASE.pageInset }}>
          {[0, 1, 2, 3].map((row) => <span key={row} className="rounded-lg bg-fg/[0.05]" style={{ height: BASE.rowHeight }} />)}
        </div>
        <span className="absolute inset-y-0 left-0 bg-accent/10" style={{ width: BASE.pageInset, top: status + BASE.barHeight, bottom: BASE.tabBarHeight + gesture }} />
        <span className="absolute inset-y-0 right-0 bg-accent/10" style={{ width: BASE.pageInset, top: status + BASE.barHeight, bottom: BASE.tabBarHeight + gesture }} />
        <div className="absolute inset-x-0 bottom-0 flex bg-elevated edge-t" style={{ height: BASE.tabBarHeight + gesture, paddingBottom: gesture }}>
          {[<IconSquarePen key="a" />, <IconListTodo key="b" />, <IconSettings key="c" />].map((icon, index) => (
            <span key={index} className={cn('flex flex-1 items-center justify-center [&_svg]:size-6', index === 1 ? 'text-accent' : 'text-fg-3')}>{icon}</span>
          ))}
        </div>
      </div>
      <div className="relative w-56 shrink-0 max-md:w-full" style={{ height }}>
        {bands.map((band) => (
          <div key={band.label} className="absolute inset-x-0 flex flex-col justify-center border-l border-line-strong pl-3" style={{ top: band.top, height: band.size }}>
            <span className="text-sm text-fg">{band.label}</span>
            <Value className="text-fg-3">{band.value}</Value>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** Where a back swipe returns: past a third of the width, or a flick past 5%. */
function BackSwipe() {
  const { t } = useLingui();
  const width = 360;
  const marks = [
    { at: ANDROID.back.flick, label: t`速度超过 ${ANDROID.back.velocity} dp/s 时返回` },
    { at: ANDROID.back.distance, label: t`超过这里松手即返回` },
  ];
  return (
    <Frame className="flex flex-col items-center gap-6 px-6 pb-8 pt-16 max-md:px-4">
      <div className="relative h-2 rounded-full bg-fg/[0.08]" style={{ width }}>
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent/40" style={{ width: width * ANDROID.back.distance }} />
        {marks.map((mark, index) => (
          <span key={mark.at} className="absolute flex -translate-x-1/2 flex-col items-center" style={{ left: width * mark.at, bottom: index ? -48 : 14 }}>
            {index === 0 && <span className="whitespace-nowrap pb-1 text-xs text-fg-2">{mark.label}</span>}
            <span className="h-5 w-px bg-fg-3" />
            <Value className="text-fg-3">{Math.round(mark.at * 100)}%</Value>
            {index === 1 && <span className="whitespace-nowrap pt-1 text-xs text-fg-2">{mark.label}</span>}
          </span>
        ))}
      </div>
      <span className="pt-10 text-xs text-fg-3">{t`屏幕宽度 · 从左边缘向右`}</span>
    </Frame>
  );
}

export function PagesChapter() {
  const { t } = useLingui();
  const places: Array<[string, string]> = [
    [t`新会话、任务、设置三个目的地，只有图标`, 'RiffetTabBar'],
    [t`宽屏换成侧边导航栏`, 'HomeTabs'],
    [t`统计、下载、Git、文件、终端压栈打开，隐藏底栏`, 'PageStack'],
    [t`左侧栏：服务器、收藏、下载、统计`, 'WorkbenchDrawer'],
    [t`右侧栏：会话详情，宽 ${BASE.drawerWidth}`, 'SessionDetailsPane'],
  ];
  const page: Array<[string, string]> = [
    [t`页面主体放进页面骨架`, 'RiffetPageScaffold'],
    [t`转场结束后再组合正文并淡入`, 'PageBody'],
    [t`可收起的大标题`, 'LargeTitleBar'],
    [t`宽屏的内容最宽 ${BASE.contentMaxWidth}`, 'contentMaxWidth'],
    [t`一页一个滚动区`, 'ScrollablePage'],
  ];
  const back = [
    t`系统返回、预测式返回和右滑返回走同一个分发`,
    t`预测式返回时页面缩到 ${ANDROID.back.previewScale} 并带圆角`,
    t`横向滑动只留给侧栏和返回，列表行不做左滑操作`,
    t`表单有未保存的改动时，任何一种返回都先确认`,
  ];
  return (
    <Chapter title={t`页面与导航`} lede={t`底栏三个目的地，其余页面压栈打开；左右两个侧栏不是浮层，返回手势与系统一致。`} source="apps/mobile/shared/src/commonMain/kotlin/riffet/ui/app/RiffetPageScaffold.kt">
      <Plate number={1} title={t`页面的结构`} note={t`material3 风格的取值；其他风格的导航栏与底栏高度见「风格」一章。`}>
        <Anatomy />
      </Plate>
      <Plate number={2} title={t`去哪里，用什么搭`}>
        <div className="grid gap-10 md:grid-cols-2">
          <SplitColumn title={t`导航`} items={places} />
          <SplitColumn title={t`页面骨架`} items={page} />
        </div>
      </Plate>
      <Plate number={3} title={t`返回`} note={t`右滑返回可以在设置里关掉，或只留屏幕边缘。`}>
        <div className="flex flex-col gap-6">
          <BackSwipe />
          <ul className="flex flex-col edge-b">
            {back.map((rule) => <li key={rule} className="py-2.5 text-sm text-fg-2 edge-t">{rule}</li>)}
          </ul>
        </div>
      </Plate>
    </Chapter>
  );
}
