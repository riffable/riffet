import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconCheck, IconChevronRight, IconCopy, IconEllipsis, IconPencilLine, IconSettings2, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Segmented, Switch } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, MenuSub, menuItem } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Widths } from '../patterns/OverlayChapter';
import { Chapter, Family, Frame, Plate, Specimen } from '../specimen';

/** A menu row held in one state; `data-highlighted` / `data-disabled` are what Radix sets on the live row. */
function Row({ state, danger, children }: { state?: 'highlighted' | 'disabled'; danger?: boolean; children: React.ReactNode }) {
  return (
    <span
      data-highlighted={state === 'highlighted' ? '' : undefined}
      data-disabled={state === 'disabled' ? '' : undefined}
      className={cn(menuItem, danger && 'text-danger data-[highlighted]:bg-danger-soft [&_svg:not([class*=text-])]:text-danger')}
    >{children}</span>
  );
}

/** The menu surface with every kind of row, held open; the live menu is the specimen beside it. */
function MenuSurface() {
  const { t } = useLingui();
  return (
    <div className="flex w-56 flex-col rounded-xl bg-popover p-1 text-fg shadow-pop">
      <span className="px-2 pb-1 pt-1.5 text-xs font-medium text-fg-3">{t`会话`}</span>
      <Row state="highlighted"><IconPencilLine />{t`重命名`}</Row>
      <Row><IconCopy />{t`复制链接`}</Row>
      <Row state="disabled"><IconSettings2 />{t`设置`}</Row>
      <span className={menuItem}><span className="min-w-0 flex-1 truncate">{t`模式`}</span><span className="max-w-32 shrink-0 truncate text-xs text-fg-3">Auto</span><IconChevronRight className="size-3.5 text-fg-4" /></span>
      <span className="-mx-1 my-1 h-px bg-line" />
      <span className={cn(menuItem, 'pr-8 md:pr-8')}>{t`显示行号`}<IconCheck className="absolute right-2 size-4 text-fg" /></span>
      <span className="-mx-1 my-1 h-px bg-line" />
      <Row danger><IconTrash2 />{t`删除`}</Row>
    </div>
  );
}

function LiveMenu() {
  const { t } = useLingui();
  const [lines, setLines] = useState(true);
  const [mode, setMode] = useState('auto');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="secondary" size="icon" aria-label={t`更多操作`}><IconEllipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t`会话`}</DropdownMenuLabel>
        <DropdownMenuItem><IconPencilLine />{t`重命名`}</DropdownMenuItem>
        <DropdownMenuItem><IconCopy />{t`复制链接`}</DropdownMenuItem>
        <DropdownMenuItem disabled><IconSettings2 />{t`设置`}</DropdownMenuItem>
        <MenuSub label={t`模式`} value={mode === 'auto' ? 'Auto' : 'Plan'}>
          <DropdownMenuRadioGroup value={mode} onValueChange={setMode}>
            <DropdownMenuRadioItem value="auto">Auto</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="plan">Plan</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </MenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={lines} onCheckedChange={setLines}>{t`显示行号`}</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger"><IconTrash2 />{t`删除`}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LivePopover() {
  const { t } = useLingui();
  const [wrap, setWrap] = useState(true);
  const [size, setSize] = useState('13');
  return (
    <Popover>
      <PopoverTrigger asChild><Button variant="secondary"><IconSettings2 />{t`显示`}</Button></PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col p-1">
        <label className="flex h-10 items-center justify-between gap-4 rounded-lg px-3 text-sm text-fg">{t`长行自动换行`}<Switch checked={wrap} onCheckedChange={setWrap} /></label>
        <div className="flex h-10 items-center justify-between gap-4 px-3 text-sm text-fg">
          {t`字号`}
          <Segmented size="xs" value={size} onChange={setSize} ariaLabel={t`字号`} options={[{ value: '12', label: '12' }, { value: '13', label: '13' }, { value: '14', label: '14' }]} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The `ui-floating-sheet` form of a menu on a phone (index.css:2441): full width at the bottom, over a scrim. */
function PhoneSheet() {
  const { t } = useLingui();
  return (
    <Frame className="flex justify-center p-8 max-md:p-4">
      <div className="relative flex h-80 w-full max-w-[22rem] flex-col justify-end overflow-hidden rounded-3xl bg-bg shadow-[0_0_0_1px_var(--line-strong)]">
        <span aria-hidden className="absolute inset-0 bg-black/25" />
        <div className="relative flex flex-col rounded-t-2xl bg-popover p-2 pb-6 text-fg">
          <span className="flex min-h-11 items-center gap-2 rounded-lg bg-hover px-3 py-2 text-sm [&_svg]:size-4 [&_svg]:text-fg-3"><IconPencilLine />{t`重命名`}</span>
          <span className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm [&_svg]:size-4 [&_svg]:text-fg-3"><IconCopy />{t`复制链接`}</span>
          <span className="-mx-2 my-1 h-px bg-line" />
          <span className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger [&_svg]:size-4"><IconTrash2 />{t`删除`}</span>
        </div>
      </div>
    </Frame>
  );
}

export function OverlaysChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`浮层`} lede={t`盖在内容之上的表面。菜单与弹出层锚定在触发点，弹窗居中，手机上菜单与小弹窗改从底部升起。`} source="apps/web/src/components/ui/" tone="canvas">
      <Family title="DropdownMenu">
        <Specimen name={t`实际组件`} prop="DropdownMenuContent" note={t`含标签、禁用项、子菜单、勾选项和危险项。`}>
          <LiveMenu />
        </Specimen>
        <Specimen name={t`表面`} prop="menuSurface · menuItem">
          <MenuSurface />
        </Specimen>
      </Family>
      <Family title="Popover">
        <Specimen name={t`实际组件`} prop="PopoverContent" note={t`锚定在触发点旁，内容里的改动即时生效。`}>
          <LivePopover />
        </Specimen>
      </Family>
      <Family title="Dialog">
        <Specimen name={t`宽度`} prop="size" note={t`confirm · form · content · workspace。`} wide>
          <div className="w-full"><Widths /></div>
        </Specimen>
      </Family>
      <Plate number={1} title={t`手机上的底部面板`} note={t`DropdownMenuContent 默认变成底部面板；贴着光标的菜单传 mobileSheet={false}。`}>
        <PhoneSheet />
      </Plate>
    </Chapter>
  );
}
