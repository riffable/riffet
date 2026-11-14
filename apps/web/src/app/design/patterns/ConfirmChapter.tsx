import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';
import { confirmDialog, promptDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { Chapter, Frame, Matrix, Plate } from '../specimen';
import { Pair } from './parts';

/** The one question that decides: can the result be taken back. */
function Decide() {
  const { t } = useLingui();
  const mono = (text: string) => <span className="font-mono text-xs text-fg">{text}</span>;
  return (
    <Frame className="flex flex-col gap-8 p-8 max-md:p-4">
      <Matrix
        columns={[t`操作`, t`用`, t`例`]}
        rows={[
          { label: t`可恢复`, cells: [t`立即执行，通知里带撤销`, <span className="text-fg-2">{t`丢弃已备份的改动、清空评论`}</span>] },
          { label: t`不可恢复`, cells: [mono('confirmDialog({ destructive: true })'), <span className="text-fg-2">{t`丢弃无法备份的文件、删除会话`}</span>] },
          { label: t`会丢失输入`, cells: [mono('useDiscardGuard'), <span className="text-fg-2">{t`关闭未保存的编辑器`}</span>] },
        ]}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => toast.success(t`已丢弃`, { action: { label: t`撤销`, onClick: () => undefined } })}>{t`丢弃改动`}</Button>
        <Button variant="danger" onClick={() => void confirmDialog({ title: t`丢弃“notes.md”？`, description: t`这个文件无法先备份，丢弃后不能恢复。`, confirmLabel: t`丢弃`, destructive: true })}>{t`丢弃无备份的文件`}</Button>
      </div>
    </Frame>
  );
}

function Dialogs() {
  const { t } = useLingui();
  return (
    <Frame className="flex flex-wrap gap-3 p-8 max-md:p-4">
      <Button variant="danger" onClick={() => void confirmDialog({ title: t`删除这个会话？`, description: t`会话和它的历史从所有设备移除，无法恢复。`, confirmLabel: t`删除会话`, destructive: true })}>confirmDialog · destructive</Button>
      <Button variant="secondary" onClick={() => void confirmDialog({ title: t`添加这个项目？`, confirmLabel: t`添加项目` })}>confirmDialog</Button>
      <Button variant="secondary" onClick={() => void promptDialog({ title: t`重命名会话`, label: t`标题`, initial: t`超时改用共享的时长常量`, confirmLabel: t`保存` })}>promptDialog</Button>
    </Frame>
  );
}

function Wording() {
  const { t } = useLingui();
  const mini = (title: string, cancel: string, ok: string, tone: 'primary' | 'danger') => (
    <div className="flex w-full max-w-xs flex-col gap-3">
      <span className="text-sm font-semibold text-fg">{title}</span>
      <span className="flex justify-end gap-2"><Button size="sm" variant="ghost" tabIndex={-1}>{cancel}</Button><Button size="sm" variant={tone} tabIndex={-1}>{ok}</Button></span>
    </div>
  );
  return (
    <Pair
      good={mini(t`删除这个会话？`, t`取消`, t`删除会话`, 'danger')}
      goodNote={t`标题陈述要发生的事，按钮是动词加对象。`}
      bad={mini(t`确认`, t`取消`, t`确定`, 'primary')}
      badNote={t`读者要回到上下文才知道确定的是什么。`}
    />
  );
}

export function ConfirmChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`确认与撤销`} lede={t`能撤销的操作直接执行并给出撤销；不能撤销的才询问。询问只出现在代价无法挽回之前。`} tone="canvas" source="docs/design/system/patterns.md">
      <Plate number={1} title={t`确认还是撤销`} note={t`同一个动作随能否备份在两条路径间切换，Git 面板的丢弃即是如此。`}>
        <Decide />
      </Plate>
      <Plate number={2} title={t`确认与输入`} note={t`危险确认打开时焦点在取消上；输入一个值用 promptDialog。`}>
        <Dialogs />
      </Plate>
      <Plate number={3} title={t`措辞`}>
        <Wording />
      </Plate>
    </Chapter>
  );
}
