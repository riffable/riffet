import { useLingui } from '@lingui/react/macro';
import { IconCheck } from '@/components/icons';
import { cn } from '@/lib/utils';
import { SplitColumn } from '../platform';
import { Chapter, Frame, Plate, Value } from '../specimen';
import { useAndroidStyleNote } from './notes';
import { ANDROID, ANDROID_STYLES } from './values';

const PHONE = { width: 300, height: 520 };

/** A phone dimmed behind a bottom sheet of model choices, at most 70% of the screen high. */
function Sheet() {
  const { t } = useLingui();
  const d = ANDROID_STYLES[0]!.dimensions;
  const options = ['Sonnet 5.5', 'Opus 5.5', 'Haiku 5.5'];
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative overflow-hidden bg-bg shadow-[0_0_0_1px_var(--line-strong)]" style={{ ...PHONE, borderRadius: 28 }} aria-hidden>
        <div className="absolute inset-0 bg-black/30" />
        <div className="absolute inset-x-0 bottom-0 flex flex-col bg-elevated" style={{ maxHeight: PHONE.height * ANDROID.sheetHeight, borderTopLeftRadius: d.groupRadius, borderTopRightRadius: d.groupRadius }}>
          <span className="mx-auto mb-2 mt-3 h-1 w-8 rounded-full bg-fg/20" />
          <span className="px-5 pb-2 text-base font-medium text-fg">{t`模型`}</span>
          {options.map((option, index) => (
            <span key={option} className={cn('mx-2 flex items-center justify-between px-3 text-sm text-fg', index === 0 && 'bg-accent/10')} style={{ height: d.menuRowHeight, borderRadius: d.rowRadius }}>
              {option}{index === 0 && <IconCheck className="size-4 text-accent" />}
            </span>
          ))}
          <span className="h-6" />
        </div>
      </div>
      <Value className="text-fg-3">PickerSheet · {t`最高 ${Math.round(ANDROID.sheetHeight * 100)}%`} · groupRadius {d.groupRadius}</Value>
    </div>
  );
}

/** The confirmation in material3 (Material's dialog) and in ios (the shared one), each at its style's width. */
function Alerts() {
  const { t } = useLingui();
  const note = useAndroidStyleNote();
  const shown = ANDROID_STYLES.filter((style) => style.id === 'material3' || style.id === 'ios');
  return (
    <div className="flex flex-wrap items-end justify-center gap-4">
      {shown.map((style) => {
        const d = style.dimensions;
        const material = style.recipes.dialogs === 'material';
        return (
          <div key={style.id} className="flex flex-col items-center gap-3">
            <div className={cn('flex flex-col bg-elevated shadow-pop', material ? 'gap-4 p-6' : 'text-center')} style={{ width: d.alertWidth, borderRadius: d.groupRadius }}>
              <div className={cn('flex flex-col gap-2', !material && 'px-4 pb-4 pt-5')}>
                <span className="text-fg" style={{ fontSize: style.type.dialogTitle.size, lineHeight: `${style.type.dialogTitle.line}px`, fontWeight: style.type.dialogTitle.weight }}>{t`删除这个会话？`}</span>
                <span className="text-sm text-fg-2">{t`转录与附件一起删除，无法恢复。`}</span>
              </div>
              {material ? (
                <div className="flex justify-end gap-2">
                  <span className="flex h-10 items-center px-3 text-sm font-medium text-accent">{t`取消`}</span>
                  <span className="flex h-10 items-center px-3 text-sm font-medium text-danger">{t`删除`}</span>
                </div>
              ) : (
                <div className="grid grid-cols-2 edge-t">
                  <span className="flex h-11 items-center justify-center text-base text-accent">{t`取消`}</span>
                  <span className="flex h-11 items-center justify-center text-base font-medium text-danger shadow-[inset_1px_0_0_var(--line)]">{t`删除`}</span>
                </div>
              )}
            </div>
            <Value className="text-fg-3">{note(style).title} · alertWidth {d.alertWidth}</Value>
          </div>
        );
      })}
    </div>
  );
}

export function OverlayChapter() {
  const { t } = useLingui();
  const choice: Array<[string, string]> = [
    [t`只有图标的按钮的名称`, 'contentDescription'],
    [t`对一项内容执行操作`, 'RiffetDropdownMenu'],
    [t`在一组值里选一个`, 'PickerSheet'],
    [t`有提交和取消的任务`, t`压栈的页面`],
    [t`确认一次不可逆的操作`, 'AlertDialog'],
    [t`报告一次操作的结果`, 'RiffetSnackbar'],
  ];
  const rules: Array<[string, string]> = [
    [t`菜单与面板最高为屏高的 70%，超出时在外壳里滚动`, 'SheetRecipe'],
    [t`遮罩挂在窗口层，盖住顶栏和底栏`, 'PickerSheetFrame'],
    [t`主操作写动作本身，危险操作用 danger 色`, 'AlertDialog'],
    [t`超大字体时确认框的操作改为竖排`, 'DialogRecipe'],
    [t`Snackbar 整个应用一个队列，不压在底栏上`, 'bottomBar()'],
  ];
  return (
    <Chapter title={t`浮层`} lede={t`触摸屏上没有悬停：名称交给无障碍，操作用长按菜单，选值用底部面板，确认用弹窗。`} tone="canvas" source="apps/mobile/shared/src/commonMain/kotlin/riffet/ui/pickers/PickerUi.kt">
      <Plate number={1} title={t`选哪一种`}>
        <div className="grid gap-10 md:grid-cols-2">
          <SplitColumn title={t`需要`} items={choice} />
          <SplitColumn title={t`规则`} items={rules} />
        </div>
      </Plate>
      <Plate number={2} title={t`底部面板`} note={t`选项多或要读说明时用；就在触发点旁的两三个选项用菜单。`}>
        <Frame className="flex justify-center p-8 max-md:p-4"><Sheet /></Frame>
      </Plate>
      <Plate number={3} title={t`确认框`} note={t`material3 与 expressive 用 Material 的弹窗；其余风格用共享实现，宽度和操作排列读配方。`}>
        <Frame className="p-8 max-md:p-4"><Alerts /></Frame>
      </Plate>
    </Chapter>
  );
}
