import { useLingui } from '@lingui/react/macro';
import { Kbd } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import { Widths } from '../patterns/OverlayChapter';
import { Chapter, Frame, Plate, Token } from '../specimen';
import { useFamilyNotes, useStyleNote } from './notes';
import { fontStack, MAC, points, STYLES } from './values';

function Choice() {
  const { t } = useLingui();
  const rows: Array<[string, string]> = [
    [t`纯图标按钮的名称和快捷键`, '.help'],
    [t`从工作台的控件执行操作或选一个命令`, 'popUpStyled · ChoiceMenu'],
    [t`右键菜单`, '.contextMenu'],
    [t`锚定在触发点旁、改动即时生效的小块内容`, 'StylePopover'],
    [t`需要集中处理、有提交和取消的任务`, '.sheet · SheetScaffold'],
    [t`确认一次不可逆的操作`, '.confirmationDialog'],
    [t`报告一次操作的结果`, 'Toast'],
    [t`一个持续存在的状态`, 'NoticeBar'],
    [t`列表或页面没有内容`, 'ContentUnavailableView'],
  ];
  return (
    <ul className="flex flex-col edge-b">
      {rows.map(([need, api]) => (
        <li key={need} className="flex items-baseline justify-between gap-4 py-2.5 edge-t">
          <span className="text-sm text-fg-2">{need}</span>
          <Token className="shrink-0 text-fg-3">{api}</Token>
        </li>
      ))}
    </ul>
  );
}

/** A sheet hanging from the window's title bar, its parts and keys named. */
function SheetAnatomy() {
  const { t } = useLingui();
  const mark = 'pointer-events-none absolute font-mono text-2xs text-fg-3';
  return (
    <Frame className="flex flex-col items-center pb-14">
      <div className="h-9 w-full shrink-0 bg-fg/[0.04] shadow-[inset_0_-1px_0_var(--line)]" aria-hidden />
      <div className="relative w-full max-w-md max-md:px-4">
        <div className="flex flex-col rounded-b-2xl bg-elevated shadow-pop">
          <div className="flex flex-col gap-1 px-5 pb-3 pt-5">
            <span className="text-base font-medium text-fg">{t`重命名会话`}</span>
            <span className="text-xs text-fg-3">{t`标题同步到所有设备。`}</span>
          </div>
          <div className="px-5"><span className="flex h-8 items-center rounded-md px-2.5 text-sm text-fg shadow-[inset_0_0_0_1px_var(--line-strong)]">{t`超时改用共享的时长常量`}</span></div>
          <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-4">
            <span className="flex h-7 items-center gap-1.5 rounded-md px-3 text-sm text-fg-2">{t`取消`}<Kbd>esc</Kbd></span>
            <span className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-fg">{t`保存`}<Kbd className="bg-primary-fg/20 text-primary-fg">↩</Kbd></span>
          </div>
        </div>
        <span className={`${mark} -left-1 top-12 -translate-x-full`}>{t`内边距 ${MAC.sheet.inset}`}</span>
        <span className={`${mark} -right-1 top-12 translate-x-full`}>{t`标题 16 · 500`}</span>
        <span className={`${mark} -bottom-6 left-0`}>{t`主操作在最右；不可逆的确认里 Return 落在取消上`}</span>
      </div>
    </Frame>
  );
}

/** Each style's menu: drawn on the paper, or the system's, at its own radius and type. */
function Menus() {
  const { t } = useLingui();
  const note = useStyleNote();
  const familyNote = useFamilyNotes();
  return (
    <Frame className="grid gap-8 p-8 sm:grid-cols-2 lg:grid-cols-3 max-md:p-4">
      {STYLES.map((style) => {
        const radius = points(style.tokens.radii.menu);
        const row = Math.min(points(style.tokens.radii.container), Math.max(4, radius - MAC.menu.pad));
        const size = points(style.tokens.text.body);
        const drawn = style.recipes.menu === 'drawn';
        return (
          <div key={style.id} className="flex flex-col items-center gap-3">
            <div
              className={cn('flex w-44 flex-col shadow-pop', drawn ? 'bg-popover' : 'bg-popover/75 backdrop-blur-xl')}
              style={{ padding: MAC.menu.pad, borderRadius: radius, fontFamily: fontStack(style.tokens.fonts.ui), fontSize: size }}
            >
              <span className="flex items-end px-2.5 pb-1 text-fg-3" style={{ height: MAC.menu.header, fontSize: points(style.tokens.text.label) }}>{t`会话`}</span>
              {[t`重命名`, t`复制链接`].map((label, index) => <span key={label} className={cn('flex items-center px-2.5 text-fg', !index && 'bg-hover')} style={{ height: MAC.menu.row, borderRadius: row }}>{label}</span>)}
              <span className="mx-2.5 my-1 h-px bg-line" />
              <span className="flex items-center px-2.5 text-danger" style={{ height: MAC.menu.row, borderRadius: row }}>{t`删除`}</span>
            </div>
            <span className="flex flex-col items-center gap-0.5 text-center">
              <span className="text-sm text-fg">{note(style).title}</span>
              <span className="font-mono text-2xs text-fg-3">{familyNote('menu').options[style.recipes.menu] ?? style.recipes.menu} · {t`圆角 ${radius}`} · {t`行 ${MAC.menu.row}`}</span>
            </span>
          </div>
        );
      })}
    </Frame>
  );
}

export function OverlayChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`浮层`} lede={t`一次操作只出现一个浮层。sheet 附着在窗口上，菜单从触发它的控件展开；右键菜单和提示气泡用系统的。`} tone="canvas" source="docs/design/system/macos.md §4">
      <Plate number={1} title={t`选哪一种`}>
        <Choice />
      </Plate>
      <Plate number={2} title={t`sheet 结构`} note={t`SheetScaffold 统一标题、正文、页脚和键盘操作，调用处只填内容和按钮。点 sheet 外部不关闭。`}>
        <SheetAnatomy />
      </Plate>
      <Plate number={3} title={t`sheet 宽度`} note={t`与 Web 弹窗相同的四档；高度随内容，超过窗口高减 64 时正文滚动。`}>
        <Widths />
      </Plate>
      <Plate number={4} title={t`菜单`} note={t`工作台控件弹出的菜单经 popUpStyled：自绘风格画在纸上，原生风格交给系统。内边距 ${MAC.menu.pad}，行高 ${MAC.menu.row}，宽 ${MAC.menu.minWidth}–${MAC.menu.maxWidth}。`}>
        <Menus />
      </Plate>
    </Chapter>
  );
}
