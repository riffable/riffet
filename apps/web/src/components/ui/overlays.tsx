import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconCircleAlert, IconCircleCheck, IconInfo, IconX } from '@/components/icons';
import { closeDialog, useDialogRequest } from '@/lib/dialogs';
import { dismissToast, pauseToast, resumeToast, runToastAction, setToastPresented, useToasts, type ToastItem } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Input, Textarea } from './controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { animationsOf, settled } from '@/lib/motion';

export function Toaster() {
  const toasts = useToasts();
  const [detail, setDetail] = useState<{ item?: ToastItem; open: boolean }>({ open: false });
  useLayoutEffect(() => {
    if (!detail.open || !detail.item) return;
    const id = detail.item.id;
    pauseToast(id, 'details');
    return () => resumeToast(id, 'details');
  }, [detail.open, detail.item?.id]);
  return (
    <>
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-(--z-toast) flex flex-col px-3">
      {/* Each row collapses its own height (gap included) as it leaves, so the toasts below slide up
          instead of jumping once the row is removed. */}
      {toasts.slice(0, 4).map((item) => <ToastRow key={item.id} item={item} onDetails={() => setDetail({ item, open: true })} />)}
    </div>
    <Dialog open={detail.open} onOpenChange={(open) => setDetail(previous => ({ ...previous, open }))}>
      <DialogContent mobileSheet className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader><DialogTitle><Trans>通知详情</Trans></DialogTitle></DialogHeader>
        <DialogBody><div className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words text-sm text-fg-2">{detail.item?.details ? <><p className="mb-3">{detail.item.message}</p>{detail.item.details}</> : detail.item?.message}</div></DialogBody>
      </DialogContent>
    </Dialog>
    </>
  );
}

function toastFits(element: HTMLDivElement): boolean {
  const rect = element.getBoundingClientRect();
  const surface = element.querySelector<HTMLElement>('[data-toast-surface]')?.getBoundingClientRect();
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const left = viewport?.offsetLeft ?? 0;
  const fullscreen = document.fullscreenElement;
  return document.visibilityState !== 'hidden' && (!fullscreen || fullscreen.contains(element)) && rect.height > 0 && rect.top >= top && rect.bottom <= top + (viewport?.height ?? window.innerHeight) && (surface?.left ?? rect.left) >= left && (surface?.right ?? rect.right) <= left + (viewport?.width ?? window.innerWidth);
}

/** Hidden queue heads still have a measurable box, but never consume reading time or input. */
function ToastRow({ item, onDetails }: { item: ToastItem; onDetails(): void }) {
  const { t } = useLingui();
  const row = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(false);
  const [entered, setEntered] = useState(false);

  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => {
      const visible = toastFits(element);
      // Siblings keep their measured height while waiting, so a later row cannot pass a queue head.
      setAvailable(visible);
      if (!visible) setToastPresented(item.id, false);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    document.addEventListener('visibilitychange', measure);
    document.addEventListener('fullscreenchange', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      document.removeEventListener('visibilitychange', measure);
      document.removeEventListener('fullscreenchange', measure);
    };
  }, [item.id]);

  // A preceding row can move without changing this row's size (for example after its exit).
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const visible = toastFits(element);
    setAvailable(visible);
    if (!visible) setToastPresented(item.id, false);
  });

  useLayoutEffect(() => {
    setEntered(false);
    const element = surface.current;
    if (!element || !available || item.leaving) return;
    let active = true;
    // CSS and reduced-motion styles determine the duration; no second animation clock to drift.
    void settled(animationsOf(element)).then(() => {
      if (active) setEntered(true);
    });
    return () => { active = false; };
  }, [available, item.leaving]);

  useLayoutEffect(() => {
    setToastPresented(item.id, available && entered && !item.leaving);
    return () => setToastPresented(item.id, false);
  }, [item.id, available, entered, item.leaving]);

  useLayoutEffect(() => () => {
    setToastPresented(item.id, false);
    resumeToast(item.id, 'pointer');
    resumeToast(item.id, 'focus');
  }, [item.id]);

  return <div ref={row} aria-hidden={!available || undefined} inert={!available || item.leaving} style={{ visibility: available ? undefined : 'hidden' }} className={cn('grid transition-[grid-template-rows] duration-[var(--duration-exit-base)] ease-[var(--ease-accelerate)]', item.leaving ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]')}>
    <div className={cn('min-h-0', item.leaving && 'overflow-hidden')}>
      <div className="flex justify-center pb-2">
        <div
          ref={surface}
          data-toast-surface
          role={item.tone === 'error' ? 'alert' : 'status'}
          onPointerEnter={() => pauseToast(item.id, 'pointer')}
          onPointerLeave={() => resumeToast(item.id, 'pointer')}
          onFocus={() => pauseToast(item.id, 'focus')}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resumeToast(item.id, 'focus'); }}
          className={cn('pointer-events-auto flex max-w-[min(30rem,100%)] items-start gap-2.5 rounded-xl bg-elevated py-2 pl-3 pr-2 text-sm text-fg shadow-pop', item.leaving ? 'animate-out fade-out-0 duration-[var(--duration-exit-base)] ease-[var(--ease-accelerate)] fill-mode-forwards' : available && 'animate-in fade-in-0 slide-in-from-top-2 duration-[var(--duration-base)] ease-[var(--ease-decelerate)]')}
        >
          {item.tone === 'success' ? <IconCircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : item.tone === 'error' ? <IconCircleAlert className="mt-0.5 size-4 shrink-0 text-danger" /> : <IconInfo className="mt-0.5 size-4 shrink-0 text-fg-3" />}
          <ToastMessage item={item} onDetails={onDetails} />
          {item.action && <button type="button" onClick={() => runToastAction(item.id)} className="-my-0.5 h-6 shrink-0 rounded-md bg-subtle px-2 text-sm font-medium text-fg transition-colors hover:bg-hover">{item.action.label}</button>}
          <button type="button" aria-label={t`关闭通知`} onClick={() => dismissToast(item.id)} className="grid size-5 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"><IconX className="size-3.5" /></button>
        </div>
      </div>
    </div>
  </div>;
}

/** Only offer details when the summary cannot show the full message or the caller supplied them. */
function ToastMessage({ item, onDetails }: { item: ToastItem; onDetails(): void }) {
  const message = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const element = message.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.message]);
  return <div className="min-w-0 flex-1">
    <span ref={message} className="line-clamp-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.message}</span>
    {/* The toast sits outside business dialogs; inspecting an error must not dismiss its form. */}
    {(item.details || overflow) && <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onDetails} className="mt-1 rounded text-xs text-fg-3 underline underline-offset-2 hover:text-fg"><Trans>详情</Trans></button>}
  </div>;
}

export function DialogHost() {
  const request = useDialogRequest();
  // Keep the closing content mounted for Radix Presence. Only the live request below can resolve.
  const [displayed, setDisplayed] = useState(request);
  const [value, setValue] = useState(() => request?.type === 'prompt' ? request.initial ?? '' : '');
  if (request && request.id !== displayed?.id) {
    setDisplayed(request);
    // Reset before painting a replacement, including a new prompt during the previous exit.
    setValue(request.type === 'prompt' ? request.initial ?? '' : '');
  }
  const cancel = () => {
    if (!request) return;
    if (request.type === 'confirm') request.resolve(false); else request.resolve(null);
    closeDialog();
  };
  const accept = () => {
    if (!request) return;
    if (request.type === 'confirm') request.resolve(true); else request.resolve(value);
    closeDialog();
  };
  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) cancel(); }}>
      {displayed && (
        <DialogContent mobileSheet className="max-w-[420px]" hideClose onOpenAutoFocus={(event) => { if (displayed.type === 'confirm') { event.preventDefault(); } }}>
          <Fragment key={displayed.id}>
            <DialogHeader className="pr-5">
              <DialogTitle>{displayed.title}</DialogTitle>
              {displayed.description ? <DialogDescription>{displayed.description}</DialogDescription> : <DialogDescription className="sr-only">{displayed.title}</DialogDescription>}
            </DialogHeader>
            <DialogBody>
              {displayed.type === 'confirm' && displayed.detail && <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-subtle p-3 font-mono text-xs text-fg-2">{displayed.detail}</pre>}
              {displayed.type === 'prompt' && (
                <form onSubmit={(event) => { event.preventDefault(); accept(); }} className="flex flex-col gap-1.5">
                  {displayed.label && <span className="text-sm font-medium">{displayed.label}</span>}
                  {displayed.multiline ? (
                    <Textarea
                      autoFocus
                      rows={3}
                      value={value}
                      placeholder={displayed.placeholder}
                      onChange={(event) => setValue(event.target.value.replace(/\r?\n/g, ' '))}
                      onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
                        event.preventDefault();
                        accept();
                      }}
                      className="min-h-0 resize-none text-sm max-md:text-base"
                    />
                  ) : <Input autoFocus value={value} placeholder={displayed.placeholder} onChange={(event) => setValue(event.target.value)} />}
                </form>
              )}
            </DialogBody>
            <DialogFooter>
              {/* A destructive confirm starts on 取消, so a reflexive Enter cannot run it. */}
              <Button variant="ghost" onClick={cancel} autoFocus={displayed.type === 'confirm' && displayed.destructive}><Trans context="common-cancel-action">取消</Trans></Button>
              <Button variant={displayed.type === 'confirm' && displayed.destructive ? 'danger' : 'primary'} className={cn(displayed.type === 'confirm' && 'min-w-16')} onClick={accept} autoFocus={displayed.type === 'confirm' && !displayed.destructive}>
                {displayed.confirmLabel ?? <Trans>确定</Trans>}
              </Button>
            </DialogFooter>
          </Fragment>
        </DialogContent>
      )}
    </Dialog>
  );
}
