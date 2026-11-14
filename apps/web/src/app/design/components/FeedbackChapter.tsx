import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconCircleAlert, IconCircleCheck, IconCopy, IconSmartphone, IconInfo, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Spinner } from '@/components/ui/controls';
import { Collapse } from '@/components/ui/collapse';
import { Skeleton } from '@/components/ui/skeleton';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { Notice } from '@/components/ui/notice';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Chapter, Family, Specimen } from '../specimen';

const TONES = ['neutral', 'accent', 'warning', 'danger'] as const;

/** The toast surface as ToastRow draws it (overlays.tsx:126), without the queue, timer or animation. */
function ToastSurface({ tone, message, action }: { tone: 'success' | 'info' | 'error'; message: string; action?: string }) {
  const { t } = useLingui();
  return (
    <div className="flex max-w-md items-start gap-2.5 rounded-xl bg-elevated py-2 pl-3 pr-2 text-sm text-fg shadow-pop">
      {tone === 'success' ? <IconCircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : tone === 'error' ? <IconCircleAlert className="mt-0.5 size-4 shrink-0 text-danger" /> : <IconInfo className="mt-0.5 size-4 shrink-0 text-fg-3" />}
      <span className="min-w-0 flex-1">{message}</span>
      {action && <span className="-my-0.5 inline-flex h-6 shrink-0 items-center rounded-md bg-subtle px-2 text-sm font-medium text-fg">{action}</span>}
      <span aria-label={t`关闭通知`} className="grid size-5 shrink-0 place-items-center rounded-md text-fg-3"><IconX className="size-3.5" /></span>
    </div>
  );
}

/** The tooltip surface as Tip draws it (tooltip.tsx:50). */
function TipSurface({ label, kbd }: { label: string; kbd?: string }) {
  return (
    <span className="flex max-w-72 items-center gap-2 rounded-md bg-toast px-2 py-1 text-xs text-white shadow-pop">
      <span>{label}</span>
      {kbd && <span className="rounded bg-white/15 px-1 font-sans text-2xs text-white/80">{kbd}</span>}
    </span>
  );
}

export function FeedbackChapter() {
  const { t } = useLingui();
  const [open, setOpen] = useState(true);
  const copy: Record<(typeof TONES)[number], string> = { neutral: t`这段历史来自导入的终端会话。`, accent: t`有新版本可用。`, warning: t`Codex 本周额度剩余 8%。`, danger: t`无法连接到服务器。` };
  return (
    <Chapter title={t`反馈`} lede={t`告诉用户发生了什么。按持续时间分：提示气泡随指针，toast 报告结果，Notice 随状态存在。`} source="apps/web/src/components/ui/">
      <Family title="Tip">
        <Specimen name={t`实际组件`} prop="label · kbd · side" note={t`纯图标按钮的名称与快捷键。`}>
          <Tip label={t`复制链接`} kbd="⌘⇧C"><Button size="icon" variant="secondary" aria-label={t`复制链接`}><IconCopy /></Button></Tip>
        </Specimen>
        <Specimen name={t`表面`} prop="bg-toast">
          <div className="flex flex-col items-start gap-3"><TipSurface label={t`复制链接`} /><TipSurface label={t`搜索`} kbd="⌘K" /></div>
        </Specimen>
      </Family>
      <Family title="toast">
        <Specimen name={t`语气`} prop="success · info · error" note={t`自动消失，时长 2.8 · 3.5 · 6.5 秒；带操作的至少 6 秒。`} wide>
          <div className="flex w-full flex-col items-center gap-2.5">
            <ToastSurface tone="success" message={t`已复制链接`} />
            <ToastSurface tone="info" message={t`已切换到 Codex`} />
            <ToastSurface tone="error" message={t`无法连接到服务器`} />
          </div>
        </Specimen>
        <Specimen name={t`带操作`} prop="action" note={t`撤销这类操作放在 toast 上。`}>
          <ToastSurface tone="success" message={t`已丢弃 3 处改动`} action={t`撤销`} />
        </Specimen>
      </Family>
      <Family title="Notice">
        <Specimen name={t`语气`} prop="tone" wide>
          <div className="grid w-full max-w-xl gap-2">
            {TONES.map((tone) => <Notice key={tone} tone={tone}>{copy[tone]}</Notice>)}
          </div>
        </Specimen>
        <Specimen name={t`带操作`} prop="action">
          <div className="w-full max-w-sm"><Notice tone="warning" action={<Button size="xs" variant="secondary">{t`查看`}</Button>}>{t`Codex 本周额度剩余 8%。`}</Notice></div>
        </Specimen>
        <Specimen name={t`无图标`} prop="icon={null}">
          <div className="w-full max-w-sm"><Notice tone="neutral" icon={null}>{t`这段历史来自导入的终端会话。`}</Notice></div>
        </Specimen>
      </Family>
      <Family title="FeedbackNotice">
        <Specimen name={t`随来源出现与退场`} prop="message · scope" note={t`来源清空后保留一次退场动画，可显示「已恢复」。`}>
          <div className="w-full max-w-sm"><FeedbackNotice scope="design-specimen" message={t`草稿无法保存到浏览器`} tone="warning" /></div>
        </Specimen>
      </Family>
      <Family title="Spinner">
        <Specimen name={t`尺寸与着色`} prop="className" note={t`默认 14 像素、次级文字色；在按钮里用 text-current。`}>
          <Spinner />
          <Spinner className="size-4" />
          <Button disabled><Spinner className="text-current" />{t`保存中`}</Button>
        </Specimen>
      </Family>
      <Family title="Skeleton">
        <Specimen name={t`与内容同高`} prop="className" note={t`尺寸与圆角写在 className；减少动态时静止。数据到达时页面不跳动。`} wide>
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Skeleton className="h-8 rounded-lg" />
            <Skeleton className="h-12 rounded-lg" />
          </div>
        </Specimen>
      </Family>
      <Family title="EmptyState">
        <Specimen name={t`图标、说明与操作`} prop="icon · title · description" wide>
          <EmptyState icon={<IconSmartphone />} title={t`还没有设备`} description={t`在手机上扫码配对后出现在这里。`}><Button variant="secondary">{t`添加设备`}</Button></EmptyState>
        </Specimen>
        <Specimen name={t`只有标题`} prop="title">
          <EmptyState title={t`没有改动`} className="py-4" />
        </Specimen>
      </Family>
      <Family title="Collapse">
        <Specimen name={t`高度动画`} prop="open · keep" note={t`内容任意高度；折叠后卸载，keep 保留状态。`} wide>
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)} className="self-start">{open ? t`收起` : t`展开`}</Button>
            <Collapse open={open}>
              <div className={cn('rounded-xl bg-elevated p-3 text-sm text-fg-2')}>{t`失败详情：连接在 8 秒后超时。`}</div>
            </Collapse>
          </div>
        </Specimen>
      </Family>
    </Chapter>
  );
}
