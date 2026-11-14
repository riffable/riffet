import { useLingui } from '@lingui/react/macro';
import { IconBookmark, IconCopy, IconEllipsis, IconFileText, IconPencilLine, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ListRow, RowActions } from '@/components/ui/list-row';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Plate } from '../specimen';
import { Mark } from './parts';

function RowMenu() {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={t`更多操作`}><IconEllipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem><IconPencilLine />{t`重命名`}</DropdownMenuItem>
        <DropdownMenuItem><IconCopy />{t`复制链接`}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger"><IconTrash2 />{t`删除`}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One row: leading icon, title, meta, and trailing actions that appear with the pointer or the keyboard. */
function Row({ title, meta, current, shown }: { title: string; meta: string; current?: boolean; shown?: boolean }) {
  const { t } = useLingui();
  return (
    <ListRow
      selected={current}
      leading={<IconFileText aria-hidden />}
      meta={meta}
      actions={<RowActions className={cn(shown && 'opacity-100')}>
        <Button size="icon-sm" variant="quiet" aria-label={t`收藏`}><IconBookmark /></Button>
        <RowMenu />
      </RowActions>}
    >{title}</ListRow>
  );
}

function RowFigure() {
  const { t } = useLingui();
  return (
    <Frame className="flex flex-col gap-4 p-8 max-md:p-4">
      <div className="flex flex-col gap-1 rounded-xl bg-bg p-2 shadow-[0_0_0_1px_var(--line)]">
        <Row title={t`修复登录超时`} meta={t`3 分钟前`} current />
        <Row title={t`整理发布说明`} meta={t`昨天`} shown />
        <Row title={t`重命名会话的弹窗`} meta={t`周三`} />
      </div>
      <div className="grid grid-cols-4 gap-2 max-md:grid-cols-2">
        <Mark>{t`图标 16 · fg-3`}</Mark><Mark>{t`标题 · 截断`}</Mark><Mark>{t`元信息 · text-xs`}</Mark><Mark>{t`操作 · 悬停或聚焦时出现`}</Mark>
      </div>
    </Frame>
  );
}

export function ListsChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`列表`} lede={t`一行由图标、标题、元信息和尾部操作组成。操作在指针停留或键盘进入时出现，触屏上常驻。`} source="docs/design/system/patterns.md">
      <Plate number={1} title={t`行的结构`} note={t`第一行是当前行；第二行示意操作出现后的样子。`}>
        <RowFigure />
      </Plate>
      <Plate number={2} title={t`空列表`} note={t`标题说明现状，下一步用一个按钮给出。`}>
        <Frame className="p-8 max-md:p-4">
          <div className="mx-auto max-w-md rounded-xl bg-bg shadow-[0_0_0_1px_var(--line)]">
            <EmptyState icon={<IconBookmark />} title={t`还没有收藏`}><Button size="sm" variant="secondary">{t`查看会话`}</Button></EmptyState>
          </div>
        </Frame>
      </Plate>
    </Chapter>
  );
}
