import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconCopy, IconEllipsis, IconPencilLine, IconSearch, IconSettings2, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input, Segmented, Switch } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Notice } from '@/components/ui/notice';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { confirmDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { SidebarUserMenu } from '../../SidebarUserMenu';
import { Chapter, Family, Frame, Plate, Specimen } from '../specimen';

function MenuDemo() {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="secondary"><IconEllipsis />{t`更多`}</Button></DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem><IconPencilLine />{t`重命名`}</DropdownMenuItem>
        <DropdownMenuItem><IconCopy />{t`复制链接`}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger"><IconTrash2 />{t`删除`}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PopoverDemo() {
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

function DialogDemo() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="secondary">{t`重命名会话`}</Button></DialogTrigger>
      <DialogContent mobileSheet>
        <DialogHeader>
          <DialogTitle>{t`重命名会话`}</DialogTitle>
          <DialogDescription>{t`标题同步到所有设备。`}</DialogDescription>
        </DialogHeader>
        <DialogBody><Input defaultValue={t`超时改用共享的时长常量`} aria-label={t`标题`} /></DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>{t`取消`}</Button>
          <Button variant="primary" onClick={() => setOpen(false)}>{t`保存`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A dialog drawn in place, with the measurements of each part. */
function Anatomy() {
  const { t } = useLingui();
  const mark = 'pointer-events-none absolute font-mono text-2xs text-fg-3';
  return (
    <Frame className="flex justify-center p-12 max-md:p-4">
      <div className="relative w-full max-w-md">
        <div className="flex flex-col rounded-2xl bg-elevated shadow-pop">
          <div className="relative flex flex-col gap-1 px-5 pb-3 pt-5 pr-12">
            <span className="text-lg font-semibold text-fg">{t`删除这个会话？`}</span>
            <span className="text-sm text-fg-3">{t`会话和它的历史从所有设备移除，无法恢复。`}</span>
            <span className="absolute right-3 top-3 grid size-7 place-items-center rounded-lg text-fg-3 shadow-[inset_0_0_0_1px_var(--line-strong)]">×</span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5 pt-4">
            <Button variant="ghost" tabIndex={-1} className="ring-2 ring-focus">{t`取消`}</Button>
            <Button variant="danger" tabIndex={-1}>{t`删除会话`}</Button>
          </div>
        </div>
        <span className={`${mark} -left-1 top-5 -translate-x-full`}>{t`内边距 20`}</span>
        <span className={`${mark} -right-1 top-4 translate-x-full`}>{t`关闭 28`}</span>
        <span className={`${mark} -bottom-6 left-0`}>{t`取消在左，主操作在右；危险确认的焦点落在取消上`}</span>
      </div>
    </Frame>
  );
}

/** The four dialog widths, nested on one sheet; the Mac's sheets take the same four. */
export function Widths() {
  const { t } = useLingui();
  const tiers: Array<[string, number]> = [[t`确认`, 420], [t`表单`, 448], [t`内容`, 768], [t`工作区`, 1080]];
  return (
    <Frame className="flex flex-col gap-3 p-8 max-md:p-4">
      {tiers.map(([name, width]) => (
        <div key={name} className="flex items-center gap-4">
          <span className="w-14 shrink-0 text-sm text-fg">{name}</span>
          <div className="relative h-9 flex-1">
            <span className="absolute inset-y-0 left-0 rounded-lg bg-elevated shadow-pop" style={{ width: `${(width / 1080) * 100}%` }} />
          </div>
          <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-fg-2">{width}</span>
        </div>
      ))}
    </Frame>
  );
}

export function OverlayChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`浮层的选用`} lede={t`七种浮层按用途区分。一次操作只出现一个浮层，它从触发它的控件展开，关闭时收回同一位置。`} tone="canvas" source="docs/design/system/patterns.md">
      <Family title={t`选哪一种`}>
        <Specimen name="Tip" note={t`纯图标按钮的名称与快捷键。`}>
          <Tip label={t`搜索`} kbd="⌘K"><Button size="icon" variant="secondary" aria-label={t`搜索`}><IconSearch /></Button></Tip>
        </Specimen>
        <Specimen name="DropdownMenu" note={t`从一个触发点执行操作或选择命令；手机上从底部升起。`}><MenuDemo /></Specimen>
        <Specimen name="Popover" note={t`锚定在触发点旁的小块内容，改动即时生效。`}><PopoverDemo /></Specimen>
        <Specimen name="Dialog" note={t`需要集中处理、有提交和取消的任务。`}><DialogDemo /></Specimen>
        <Specimen name="confirmDialog" note={t`确认一次不可逆的操作。`}>
          <Button variant="danger" onClick={() => void confirmDialog({ title: t`删除这个会话？`, description: t`会话和它的历史从所有设备移除，无法恢复。`, confirmLabel: t`删除会话`, destructive: true })}>{t`删除会话`}</Button>
        </Specimen>
        <Specimen name="toast" note={t`报告一次操作的结果，自动消失。`}>
          <Button variant="secondary" onClick={() => toast.success(t`已复制链接`)}><IconCopy />{t`复制链接`}</Button>
        </Specimen>
        <Specimen name="Notice" note={t`持续存在的状态，留在内容里，随状态解除。`} wide>
          <div className="w-full max-w-md"><Notice tone="warning">{t`Codex 本周额度剩余 8%。`}</Notice></div>
        </Specimen>
      </Family>
      <Family title={t`个人资料与更多`}>
        <Specimen name={t`个人资料`}>
          <SidebarUserMenu owner={{ revision: 0, name: 'River' }} onOpenProfile={() => {}} onOpenSettings={() => {}} />
        </Specimen>
        <Specimen name={t`无法连接服务器`}>
          <SidebarUserMenu stale={{ mode: 'offline' }} onOpenProfile={() => {}} onOpenSettings={() => {}} />
        </Specimen>
      </Family>
      <Plate number={2} title={t`弹窗结构`} note={t`标题陈述要发生的事，主操作写动词加对象。手机上，确认与小表单从底部弹出，按钮等宽铺满一行。`}>
        <Anatomy />
      </Plate>
      <Plate number={3} title={t`弹窗宽度`} note={t`四档宽度按内容选择；工作区弹窗带自己的导航。`}>
        <Widths />
      </Plate>
    </Chapter>
  );
}
