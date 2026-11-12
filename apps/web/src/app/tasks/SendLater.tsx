import { useCallback, useEffect, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Attachment, Automation } from '@contracts';
import { IconCalendarClock, IconPaperclip, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api, messageContext, type PromptContextReference } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { formatWhen, nameFromPrompt, ONCE_PRESETS, onceDate, onceLabel, onceTrigger, toLocalInput, type OncePreset } from './automation';

/** A time picked by hand, in a dialog both the composer and the quick bar open. */
export function CustomTimeDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (at: Date) => void }) {
  const { t } = useLingui();
  const [value, setValue] = useState('');
  useEffect(() => { if (open) setValue(toLocalInput(onceDate('1h'))); }, [open]);
  const at = value ? new Date(value) : undefined;
  const valid = Boolean(at && at.getTime() > Date.now());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle><Trans>选择时间</Trans></DialogTitle></DialogHeader>
        <DialogBody>
          <Input autoFocus type="datetime-local" value={value} min={toLocalInput(new Date())} onChange={(event) => setValue(event.target.value)} aria-label={t`选择时间`} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}><Trans context="tasks-cancel-action">取消</Trans></Button>
          <Button variant="primary" disabled={!valid} onClick={() => { if (at && valid) { onOpenChange(false); onPick(at); } }}><Trans>确定</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The input box's "send later": a quiet clock beside the model picker with the same one-time presets as the tasks page. */
export function SendLaterMenu({ disabled, onPick }: { disabled?: boolean; onPick: (at: Date) => void }) {
  const { t } = useLingui();
  const [custom, setCustom] = useState(false);
  return (
    <>
      <DropdownMenu>
        <Tip label={t`稍后发送`}>
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t`稍后发送`}
                disabled={disabled}
                className="grid size-11 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-45 disabled:hover:bg-transparent data-[state=open]:bg-hover md:size-7"
              >
                <IconCalendarClock className="size-[18px]" />
              </button>
            </DropdownMenuTrigger>
          </span>
        </Tip>
        <DropdownMenuContent align="start" side="top" className="w-44">
          {ONCE_PRESETS.map((preset: OncePreset) => <DropdownMenuItem key={preset} onSelect={() => onPick(onceDate(preset))}>{onceLabel(preset)}</DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCustom(true)}><Trans>自定义时间…</Trans></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CustomTimeDialog open={custom} onOpenChange={setCustom} onPick={onPick} />
    </>
  );
}

/** The pending follow-ups of one conversation, the agent's own wake-ups included. */
export function useSessionFollowUps(sessionId: string) {
  const [items, setItems] = useState<Automation[]>([]);
  const refresh = useCallback(async () => {
    try {
      const all = await api.automations();
      const now = Date.now();
      setItems(all.filter((item) => item.followUp?.sessionId === sessionId && item.enabled && item.nextRunAt && Date.parse(item.nextRunAt) > now)
        .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)));
    } catch { /* the strip is an extra; the conversation does not depend on it */ }
  }, [sessionId]);
  useEffect(() => {
    setItems([]);
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);
  const cancel = useCallback(async (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    try { await api.deleteAutomation(id); } catch (error) { toast.error(errorMessage(error, i18n._(msg`无法取消`))); void refresh(); }
  }, [refresh]);
  return { items, refresh, cancel };
}

/** Queues a typed message for a later time; true when the server took it. */
export async function scheduleFollowUp(sessionId: string, prompt: string, attachments: readonly Attachment[], references: readonly PromptContextReference[], at: Date): Promise<boolean> {
  try {
    // One id for the request, so a retry after a lost response does not schedule it twice.
    await api.createAutomation({
      id: crypto.randomUUID(), name: nameFromPrompt(prompt), prompt, followUp: { sessionId }, triggers: [onceTrigger(at)],
      ...(attachments.length ? { attachments: attachments.map(({ id }) => ({ id })) } : {}),
      ...messageContext(references),
    });
    return true;
  } catch (error) {
    toast.error(errorMessage(error, i18n._(msg`无法安排发送`)));
    return false;
  }
}

/** One compact line per pending follow-up above the input box. */
export function FollowUpList({ items, onCancel }: { items: Automation[]; onCancel: (id: string) => void }) {
  const { t } = useLingui();
  return (
    <ul className="flex flex-col rounded-2xl bg-elevated px-2 py-1 max-md:border max-md:border-line-strong md:shadow-composer" aria-label={t`稍后发送`}>
      {items.map((item) => (
        <li key={item.id} className="flex min-h-11 min-w-0 items-center gap-2 px-1.5 md:min-h-8">
          <IconCalendarClock className="size-3.5 shrink-0 text-fg-4" />
          <span className="min-w-0 flex-1 truncate text-sm text-fg-2">
            <span className="tabular-nums text-fg-3">{formatWhen(item.nextRunAt!)}</span> · {item.prompt.split('\n')[0]}
          </span>
          {Boolean(item.input?.attachmentIds.length) && <span className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-fg-4"><IconPaperclip className="size-3.5" />{item.input!.attachmentIds.length > 1 ? item.input!.attachmentIds.length : null}</span>}
          <Tip label={t`取消`}>
            <button type="button" aria-label={t`取消`} onClick={() => onCancel(item.id)} className="grid size-11 shrink-0 place-items-center rounded-full text-fg-3 transition-colors hover:bg-hover hover:text-danger md:size-6.5"><IconX className="size-3.5" /></button>
          </Tip>
        </li>
      ))}
    </ul>
  );
}
