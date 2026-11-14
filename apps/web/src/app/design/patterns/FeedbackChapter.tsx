import { useLingui } from '@lingui/react/macro';
import { IconCircleAlert, IconCopy, IconRefreshCw, IconSmartphone } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Field, Input } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/lib/toast';
import { FailureDetails } from '../../session/FailureDetails';
import { WorkingIndicator } from '../../session/Timeline';
import { Chapter, Frame, Plate } from '../specimen';
import { Mark, Pair } from './parts';

/** One kind of feedback beside its place on the page. */
function Cell({ name, where, children }: { name: string; where: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-24 flex-col items-start justify-center gap-2 rounded-xl bg-bg p-4 shadow-[0_0_0_1px_var(--line)]">{children}</div>
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-xs text-fg">{name}</span>
        <span className="text-xs text-fg-3">{where}</span>
      </div>
    </div>
  );
}

function Where() {
  const { t } = useLingui();
  return (
    <Frame className="grid grid-cols-2 gap-x-6 gap-y-8 p-8 max-md:grid-cols-1 max-md:p-4">
      <Cell name="Field error" where={t`行内：紧挨出错的字段或步骤`}>
        <Field label={t`工作目录`} error={t`目录不存在`}><Input defaultValue="~/missing" /></Field>
      </Cell>
      <Cell name="toast" where={t`一次操作的结果；撤销放在它的操作里`}>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => toast.success(t`已复制链接`)}><IconCopy />{t`复制链接`}</Button>
          <Button variant="secondary" onClick={() => toast.success(t`已丢弃`, { action: { label: t`撤销`, onClick: () => undefined } })}>{t`带撤销`}</Button>
          <Button variant="secondary" onClick={() => toast.error(t`无法复制链接`)}>{t`失败`}</Button>
        </div>
      </Cell>
      <Cell name="Notice" where={t`持续的状态：留在内容里，状态解除才消失`}>
        <div className="w-full"><Notice tone="warning">{t`Codex 本周额度剩余 8%。`}</Notice></div>
      </Cell>
      <Cell name="FailureDetails" where={t`会话里的失败：原因可见，诊断折叠`}>
        <div className="w-full text-sm text-danger"><FailureDetails text={t`请求被拒绝`} detail={'HTTP 403 · request_id=req_01H8'} /></div>
      </Cell>
    </Frame>
  );
}

function Loading() {
  const { t } = useLingui();
  return (
    <Frame className="grid grid-cols-3 gap-x-6 gap-y-8 p-8 max-md:grid-cols-1 max-md:p-4">
      <Cell name="Spinner" where={t`原地：等待它的那个控件`}>
        <Button size="sm" busy>{t`安装`}</Button>
      </Cell>
      <Cell name="Skeleton" where={t`骨架：首次加载的整块内容，与真实内容同高`}>
        <div className="flex w-full flex-col gap-2"><Skeleton className="h-8 rounded-lg" /><Skeleton className="h-12 rounded-lg" /></div>
      </Cell>
      <Cell name="WorkingIndicator" where={t`会话里：圆点加已用时间`}>
        <WorkingIndicator startedAt={Date.now() - 12_000} />
      </Cell>
    </Frame>
  );
}

function Empty() {
  const { t } = useLingui();
  return (
    <Frame className="grid grid-cols-2 gap-6 p-8 max-md:grid-cols-1 max-md:p-4">
      <div className="rounded-xl bg-bg shadow-[0_0_0_1px_var(--line)]"><EmptyState icon={<IconSmartphone />} title={t`没有已配对的设备`} /></div>
      <div className="rounded-xl bg-bg shadow-[0_0_0_1px_var(--line)]">
        <EmptyState icon={<IconCircleAlert />} title={t`无法读取设备`} description={t`连接已断开`}>
          <Button size="sm"><IconRefreshCw />{t`重试`}</Button>
        </EmptyState>
      </div>
    </Frame>
  );
}

function KeepSize() {
  const { t } = useLingui();
  return (
    <Pair
      good={<Button size="sm" variant="secondary" busy>{t`安装`}</Button>}
      goodNote={t`进行中的按钮宽度不变，Spinner 叠在原位。`}
      bad={<Button size="sm" variant="secondary" disabled>{t`正在安装插件`}</Button>}
      badNote={t`换文案让按钮变宽，邻近的控件跟着移动。`}
    />
  );
}

export function FeedbackChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`反馈与加载`} lede={t`反馈出现在发生的地方：错误贴着字段，结果在浮出的通知里，状态留在内容中。等待只由正在等待的控件表达。`} source="docs/design/system/patterns.md">
      <Plate number={1} title={t`反馈放在哪里`} note={<>{t`展示时序见`} <Mark>docs/design/feedback-presentation.md</Mark></>}>
        <Where />
      </Plate>
      <Plate number={2} title={t`加载`} note={t`等待不产生通知，结束后也不留下「已完成」。`}>
        <Loading />
      </Plate>
      <Plate number={3} title={t`空状态`} note={t`标题说明现在是什么；失败的空状态附一个下一步。`}>
        <Empty />
      </Plate>
      <Plate number={4} title={t`保持尺寸`} note={t`加载前后，控件占的位置不变。`}>
        <KeepSize />
      </Plate>
    </Chapter>
  );
}
