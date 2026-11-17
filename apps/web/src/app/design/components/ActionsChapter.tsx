import { useLingui } from '@lingui/react/macro';
import { IconArchive, IconEllipsis, IconFolder, IconGitCompare, IconPencilLine, IconPin, IconPlus, IconSettings2, IconTerminal } from '@/components/icons';
import { ActionBar, ActionBarButton } from '@/components/ui/action-bar';
import { Button, type ButtonProps } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { Chapter, Family, Matrix, Specimen } from '../specimen';

type Variant = NonNullable<ButtonProps['variant']>;
type Size = NonNullable<ButtonProps['size']>;
/** `accent` is a legacy alias of `primary` kept for the plugin SDK, so it is not drawn. */
const VARIANTS: Variant[] = ['primary', 'secondary', 'ghost', 'quiet', 'danger', 'danger-ghost', 'link'];
const SIZES: Size[] = ['xs', 'sm', 'md', 'lg'];
const ICON_SIZES: Size[] = ['icon-xs', 'icon-sm', 'icon'];
const TONES = ['neutral', 'accent', 'success', 'warning', 'danger'] as const;

export function ActionsChapter() {
  const { t } = useLingui();
  const noop = () => {};
  const columns = [t`默认`, t`带图标`, t`禁用`, t`进行中`];
  return (
    <Chapter title={t`操作`} lede={t`触发一次动作的控件。名称由文字或 Tip 给出，状态通过同一组参数表达。`} source="apps/web/src/components/ui/button.tsx">
      <Family title="Button">
        <Specimen name={t`变体`} prop="variant" full>
          <div className="w-full">
            <Matrix
              columns={columns}
              rows={VARIANTS.map((variant) => ({
                label: variant,
                cells: [
                  <Button key="a" variant={variant}>{t`继续`}</Button>,
                  <Button key="b" variant={variant}><IconPlus />{t`新建`}</Button>,
                  <Button key="c" variant={variant} disabled>{t`继续`}</Button>,
                  <Button key="d" variant={variant} busy>{t`继续`}</Button>,
                ],
              }))}
            />
          </div>
        </Specimen>
        <Specimen name={t`尺寸`} prop="size">
          <div className="flex flex-col items-start gap-3">
            {SIZES.map((size) => <Button key={size} size={size} variant="secondary">{size}</Button>)}
          </div>
        </Specimen>
        <Specimen name={t`图标按钮`} prop="icon-xs · icon-sm · icon" note={t`名称由 Tip 与 aria-label 给出。`}>
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              {ICON_SIZES.map((size) => <Tip key={size} label={t`设置`}><Button size={size} variant="quiet" aria-label={t`设置`}><IconSettings2 /></Button></Tip>)}
            </div>
            <div className="flex items-center gap-2">
              {ICON_SIZES.map((size) => <Tip key={size} label={t`设置`} kbd="⌘,"><Button size={size} variant="secondary" aria-label={t`设置`}><IconSettings2 /></Button></Tip>)}
            </div>
          </div>
        </Specimen>
      </Family>
      <Family title="StatusPill">
        <Specimen name={t`语气`} prop="tone" note={t`指针悬停或键盘聚焦时标签换成操作名；触屏一开始就显示操作名。`}>
          <div className="flex flex-col items-start gap-2.5">
            {TONES.map((tone) => <StatusPill key={tone} tone={tone} label={t`连接失败`} actionLabel={t`重试`} onAction={noop} />)}
          </div>
        </Specimen>
        <Specimen name={t`进行中`} prop="busy" note={t`保持可聚焦，不触发第二次操作。`}>
          <StatusPill tone="warning" label={t`重连中`} actionLabel={t`重试`} onAction={noop} busy />
        </Specimen>
        <Specimen name={t`禁用`} prop="disabled">
          <StatusPill tone="danger" label={t`连接失败`} actionLabel={t`重试`} onAction={noop} disabled />
        </Specimen>
      </Family>
      <Family title="ActionBar">
        <Specimen name={t`去处`} prop="active" note={t`手机面板专用，二到四格。`}>
          <ActionBar className="w-80">
            <ActionBarButton icon={<IconGitCompare />} label={t`变更`} active aria-pressed onClick={noop} />
            <ActionBarButton icon={<IconFolder />} label={t`文件`} aria-pressed={false} onClick={noop} />
            <ActionBarButton icon={<IconTerminal />} label={t`终端`} aria-pressed={false} onClick={noop} />
          </ActionBar>
        </Specimen>
        <Specimen name={t`操作`} prop="disabled">
          <ActionBar className="w-80">
            <ActionBarButton icon={<IconPin />} label={t`置顶`} onClick={noop} />
            <ActionBarButton icon={<IconPencilLine />} label={t`重命名`} disabled />
            <ActionBarButton icon={<IconArchive />} label={t`归档`} onClick={noop} />
            <ActionBarButton icon={<IconEllipsis />} label={t`更多`} onClick={noop} />
          </ActionBar>
        </Specimen>
      </Family>
    </Chapter>
  );
}
