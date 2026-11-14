import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconBookmark } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { formatDuration } from '@/lib/format-duration';
import { formatCount, formatPercent, formatSpeed, formatTokens } from '@/lib/stats-format';
import { gitTimeAgo } from '../../panels/gitFormat';
import { Chapter, Frame, Matrix, Plate, Token } from '../specimen';
import { Rule } from './TypesetChapter';

/** A confirmation as the dialog draws it, without the overlay. */
function ConfirmCard({ title, description, cancel, confirm, destructive }: { title: string; description?: string; cancel: string; confirm: string; destructive?: boolean }) {
  return (
    <div className="flex w-full max-w-72 flex-col gap-4 rounded-xl bg-elevated p-4 text-left shadow-[0_0_0_1px_var(--line)]">
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium text-fg">{title}</p>
        {description && <p className="text-sm text-fg-3">{description}</p>}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm">{cancel}</Button>
        <Button variant={destructive ? 'danger' : 'primary'} size="sm">{confirm}</Button>
      </div>
    </div>
  );
}

export function ContentChapter() {
  const { t } = useLingui();
  const terms: Array<{ label: ReactNode; cells: ReactNode[] }> = [
    { label: t`中文`, cells: [<span key="a" className="text-sm text-fg">{t`会话 · 项目 · 插件 · 收藏 · 产出 · 审批 · 终端`}</span>] },
    { label: t`技能与工具`, cells: [<span key="a" className="text-sm text-fg">{t`输入框里的入口；其中的条目写 Skill、MCP`}</span>] },
    { label: t`保留英文`, cells: [<span key="a" className="text-sm text-fg">Agent · Skill · MCP · Worktree · token · Codex · Claude</span>] },
    { label: t`模型与工具名`, cells: [<span key="a" className="font-mono text-sm text-fg">gpt-5 · Read · Bash</span>] },
    { label: 'Git', cells: [<span key="a" className="text-sm text-fg">{t`面板内整块英文：branch、commit、1 file / 2 files`}</span>] },
  ];
  return (
    <Chapter title={t`文案`} lede={t`界面文字只写用户推断不出的信息。动词开头，与结果一致；一条不超过一句。`} tone="canvas" source="docs/design/system/content.md">
      <Plate number={1} title={t`说明`} note={t`只写存储位置、能否撤销、是否跨设备、是否需重启、权限与计费。`}>
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-3">
          <Rule struck={false} title={t`复述界面`} good={<span className="text-base">{t`仅保存在这台 Mac`}</span>} bad={<span className="text-base">{t`整套配色决定界面颜色，选择立即生效并只保存在这台 Mac`}</span>} />
          <Rule struck={false} title={t`操作说明`} good={<span className="text-base">{t`技能与工具`}</span>} bad={<span className="text-base">{t`点击下方按钮选择要启用的技能与工具`}</span>} />
          <Rule struck={false} title={t`语气`} good={<span className="text-base">{t`已保存`}</span>} bad={<span className="text-base">{t`太棒了，设置已成功保存！`}</span>} />
        </div>
      </Plate>
      <Plate number={2} title={t`按钮与菜单`} note={t`动词开头，写出会发生的事。`}>
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-3">
          <Rule struck={false} title={t`破坏性操作`} good={<Button variant="danger">{t`删除会话`}</Button>} bad={<Button variant="danger">{t`确定`}</Button>} />
          <Rule struck={false} title={t`创建`} good={<Button variant="primary">{t`新建会话`}</Button>} bad={<Button variant="primary">{t`提交`}</Button>} />
          <Rule struck={false} title={t`关闭`} good={<Button variant="ghost">{t`取消`}</Button>} bad={<Button variant="ghost">{t`否`}</Button>} />
        </div>
      </Plate>
      <Plate number={3} title={t`错误`} note={t`发生了什么，下一步做什么。`}>
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-2">
          <Rule struck={false} title={t`发送`} good={<span className="text-base">{t`发送失败，可恢复内容后重试`}</span>} bad={<span className="text-base">{t`操作失败`}</span>} />
          <Rule struck={false} title={t`读取`} good={<span className="text-base">{t`会话暂时无法读取，请重试`}</span>} bad={<span className="text-base">{t`出错了`}</span>} />
        </div>
      </Plate>
      <Plate number={4} title={t`空状态`} note={t`说明为什么空，给出下一步。`}>
        <div className="grid gap-6 md:grid-cols-2">
          <Frame><EmptyState icon={<IconBookmark />} title={t`还没有收藏`} description={t`在会话里收藏回答或片段，会出现在这里`} /></Frame>
          <Frame className="grid place-items-center"><span className="text-base text-fg-4 line-through decoration-1">{t`暂无数据`}</span></Frame>
        </div>
      </Plate>
      <Plate number={5} title={t`确认`} note={t`标题写成问句，按钮写动作；不可逆时说明后果，危险按钮不作默认。`}>
        <div className="grid gap-6 md:grid-cols-2">
          <Frame className="grid place-items-center p-8"><ConfirmCard destructive title={t`删除这个会话？`} description={t`删除后无法恢复`} cancel={t`取消`} confirm={t`删除会话`} /></Frame>
          <Frame className="grid place-items-center p-8"><div className="opacity-60"><ConfirmCard title={t`确定要删除吗？`} cancel={t`取消`} confirm={t`确定`} /></div></Frame>
        </div>
      </Plate>
      <Plate number={6} title={t`术语`} note={t`同一个东西只有一个名字。`}>
        <Frame className="px-8 py-6 max-md:px-4"><Matrix rows={terms} /></Frame>
      </Plate>
      <Plate number={7} title={t`时间与数字`} note={t`读自 lib 里的格式化函数。`}>
        <Frame className="px-8 py-6 max-md:px-4">
          <Matrix
            columns={[t`样例`, t`函数`]}
            rows={[
              { label: t`时长`, cells: [<span key="a" className="tabular-nums text-sm text-fg">{formatDuration(101_000)}</span>, <Token key="b">format-duration.ts</Token>] },
              { label: 'token', cells: [<span key="a" className="tabular-nums text-sm text-fg">{formatTokens(2300)}</span>, <Token key="b">stats-format.ts</Token>] },
              { label: t`计数`, cells: [<span key="a" className="tabular-nums text-sm text-fg">{formatCount(11711)}</span>, <Token key="b">stats-format.ts</Token>] },
              { label: t`比例`, cells: [<span key="a" className="tabular-nums text-sm text-fg">{formatPercent(0.842)}</span>, <Token key="b">stats-format.ts</Token>] },
              { label: t`速度`, cells: [<span key="a" className="tabular-nums text-sm text-fg">{formatSpeed(42.6)}</span>, <Token key="b">stats-format.ts</Token>] },
              { label: 'Git', cells: [<span key="a" className="tabular-nums text-sm text-fg">{gitTimeAgo(new Date(Date.now() - 6 * 60_000).toISOString())}</span>, <Token key="b">panels/gitFormat.ts</Token>] },
            ]}
          />
        </Frame>
      </Plate>
    </Chapter>
  );
}
