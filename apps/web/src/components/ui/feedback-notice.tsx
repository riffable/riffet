import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { useFeedbackTimer, useRetainedFeedback } from '@/lib/feedback';
import { copyWithToast } from '@/lib/files';
import { cn } from '@/lib/utils';
import { Collapse } from './collapse';
import { Notice } from './notice';
import { Button } from './button';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from './dialog';

type Tone = ComponentProps<typeof Notice>['tone'];
/** `detail` is the original diagnostic behind a plain `text`, shown only when asked for. */
export interface FeedbackMessage { id: string; text: string; detail?: string; tone?: Tone; }

/** Always mount the owner, including when its source clears; retained rows contain data, not actions. */
export function FeedbackNotices({ messages, scope, action, renderMessage, className, noticeClassName, icon, floating, recovered = false }: {
  messages: readonly FeedbackMessage[];
  scope: string;
  action?: (message: FeedbackMessage) => ReactNode;
  renderMessage?: (message: FeedbackMessage, current: boolean) => ReactNode;
  className?: string;
  noticeClassName?: string;
  icon?: ReactNode;
  floating?: boolean;
  recovered?: boolean;
}) {
  const { items, finish } = useRetainedFeedback(messages, scope);
  return <div className={cn('pointer-events-none flex flex-col gap-2 empty:hidden', className)}>
    {items.map(item => <FeedbackRow key={`${scope}:${item.value.id}`} message={item.value} current={item.current} revision={item.revision}
      onFinished={() => finish(item.value.id)} action={item.current ? action?.(item.value) : undefined}
      renderMessage={renderMessage} floating={floating} recovered={recovered} noticeClassName={noticeClassName} icon={icon} />)}
  </div>;
}

function FeedbackRow({ message, current, revision, onFinished, action, renderMessage, floating, recovered, noticeClassName, icon }: {
  message: FeedbackMessage; current: boolean; revision: number; onFinished: () => void;
  action?: ReactNode; renderMessage?: (message: FeedbackMessage, current: boolean) => ReactNode; floating?: boolean; recovered: boolean;
  noticeClassName?: string; icon?: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [pointerReading, setPointerReading] = useState(false);
  const [focusReading, setFocusReading] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [preview, setPreview] = useState<HTMLDivElement | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  if (current && leaving) setLeaving(false);
  const ref = useFeedbackTimer<HTMLDivElement>(current, () => setLeaving(true), revision, !leaving, detailOpen || pointerReading || focusReading);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => setOpened(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useLayoutEffect(() => {
    const element = preview;
    if (!element || !floating) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [preview, floating, message.text]);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => finished.current(), 200);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return <><Collapse open={opened && !leaving}>
    <div ref={ref} className="pointer-events-auto"
      onPointerEnter={() => setPointerReading(true)} onPointerLeave={() => setPointerReading(false)}
      onFocusCapture={() => setFocusReading(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusReading(false); }}>
      <Notice tone={current ? message.tone : 'neutral'} action={action} icon={icon} className={cn(noticeClassName, floating && 'border border-line-strong bg-elevated! shadow-soft')}>
        {!current && recovered && <span className="mr-2 text-xs text-fg-3"><Trans>已恢复</Trans></span>}
        {floating ? <>
          <div ref={setPreview} className="line-clamp-3 whitespace-pre-wrap break-words">{message.text}</div>
          {overflow && <Button variant="quiet" size="xs" onClick={() => setDetailOpen(true)}><Trans>详情</Trans></Button>}
        </> : renderMessage ? renderMessage(message, current) : message.text}
      </Notice>
    </div>
  </Collapse>
    {floating && <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
      <DialogContent mobileSheet aria-describedby={undefined}>
        <DialogHeader><DialogTitle><Trans>通知详情</Trans></DialogTitle></DialogHeader>
        <DialogBody><div className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words text-sm text-fg-2">{message.text}</div>
          <Button variant="quiet" size="xs" className="mt-3" onClick={() => void copyWithToast(message.text)}><Trans>复制</Trans></Button>
        </DialogBody>
      </DialogContent>
    </Dialog>}
  </>;
}

export function FeedbackNotice({ message, tone, ...props }: Omit<ComponentProps<typeof FeedbackNotices>, 'messages'> & { message?: string | null | false; tone?: Tone }) {
  return <FeedbackNotices {...props} messages={message ? [{ id: message, text: message, tone }] : []} />;
}
