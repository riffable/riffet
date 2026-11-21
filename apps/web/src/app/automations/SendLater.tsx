import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Attachment, Automation } from '@contracts';
import { IconCalendarClock, IconChevronRight, IconPaperclip, IconPencilLine, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api, messageContext, type PromptContextReference } from '@/lib/api';
import { formatDate } from '@/lib/i18n/format';
import { cn, errorMessage } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { formatWhen, nameFromPrompt, ONCE_PRESETS, onceDate, onceLabel, onceTrigger, type OncePreset } from './automation';

const pad2 = (value: number) => String(value).padStart(2, '0');
const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function resolveInitialDate(initialDate?: Date | null): Date {
  const base = initialDate && initialDate.getTime() > Date.now() ? new Date(initialDate) : onceDate('1h');
  base.setSeconds(0, 0);
  return base;
}

/** A time picked by hand, in a dialog both the composer and the follow-up strip open. */
export function CustomTimeDialog({
  open,
  onOpenChange,
  initialDate,
  confirmLabel,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDate?: Date | null;
  confirmLabel?: string;
  onPick: (at: Date) => void;
}) {
  const { t } = useLingui();
  const [selected, setSelected] = useState(() => resolveInitialDate(initialDate));
  const [viewYear, setViewYear] = useState(() => selected.getFullYear());
  const [viewMonth, setViewMonth] = useState(() => selected.getMonth());
  const [hourText, setHourText] = useState(() => pad2(selected.getHours()));
  const [minuteText, setMinuteText] = useState(() => pad2(selected.getMinutes()));
  const [, setTick] = useState(0);

  const hourInputRef = useRef<HTMLInputElement>(null);
  const minuteInputRef = useRef<HTMLInputElement>(null);
  const hourListRef = useRef<HTMLDivElement>(null);
  const minuteListRef = useRef<HTMLDivElement>(null);
  const latestInitialRef = useRef(initialDate);
  latestInitialRef.current = initialDate;
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const next = resolveInitialDate(latestInitialRef.current);
    setSelected(next);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
    setHourText(pad2(next.getHours()));
    setMinuteText(pad2(next.getMinutes()));
    const raf = requestAnimationFrame(() => {
      hourListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
      minuteListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    });
    const timer = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
    };
  }, [open]);

  const now = new Date();
  const today = dayStart(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const weekdayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, index) => formatDate(new Date(2024, 0, 1 + index), { weekday: 'narrow' })),
    [],
  );

  const calendarDays = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const offset = (first.getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index) => new Date(viewYear, viewMonth, 1 - offset + index));
  }, [viewYear, viewMonth]);

  const canPrevMonth = viewYear > today.getFullYear() || (viewYear === today.getFullYear() && viewMonth > today.getMonth());
  const stepMonth = (delta: number) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const selectDate = (date: Date) => {
    const next = new Date(selected);
    next.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    setSelected(next);
    setViewYear(date.getFullYear());
    setViewMonth(date.getMonth());
  };

  const setHour = (hour: number) => {
    setSelected((current) => {
      const next = new Date(current);
      next.setHours(hour);
      next.setSeconds(0, 0);
      return next;
    });
  };

  const setMinute = (minute: number) => {
    setSelected((current) => {
      const next = new Date(current);
      next.setMinutes(minute, 0, 0);
      return next;
    });
  };

  const diffMs = selected.getTime() - now.getTime();
  const valid = diffMs > 0;
  const isTodaySelected = sameDay(selected, today);

  const relativeAhead = (() => {
    const totalMinutes = Math.max(1, Math.round(diffMs / 60_000));
    if (totalMinutes < 60) return t`${totalMinutes} 分钟后`;
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hours < 24) return mins === 0 ? t`${hours} 小时后` : t`${hours} 小时 ${mins} 分钟后`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours === 0 ? t`${days} 天后` : t`${days} 天 ${remHours} 小时后`;
  })();

  const submitIfValid = () => {
    if (!valid) return;
    onOpenChange(false);
    onPick(selected);
  };

  const monthTitle = formatDate(new Date(viewYear, viewMonth, 1), { year: 'numeric', month: 'long' });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form" mobileSheet aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle><Trans>选择时间</Trans></DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
            {/* Calendar */}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={t`上个月`}
                    disabled={!canPrevMonth}
                    onClick={() => stepMonth(-1)}
                    className="grid size-7 place-items-center rounded-md text-fg-2 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-35 no-hover:size-11"
                  >
                    <IconChevronRight className="size-4 rotate-180" />
                  </button>
                  <span className="min-w-24 text-center text-sm font-medium text-fg">{monthTitle}</span>
                  <button
                    type="button"
                    aria-label={t`下个月`}
                    onClick={() => stepMonth(1)}
                    className="grid size-7 place-items-center rounded-md text-fg-2 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus no-hover:size-11"
                  >
                    <IconChevronRight className="size-4" />
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => selectDate(today)}
                    className={cn(
                      'rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11 no-hover:px-3',
                      sameDay(selected, today) ? 'bg-accent/15 text-accent' : 'text-fg-3 hover:bg-hover hover:text-fg',
                    )}
                  >
                    <Trans>今天</Trans>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectDate(tomorrow)}
                    className={cn(
                      'rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11 no-hover:px-3',
                      sameDay(selected, tomorrow) ? 'bg-accent/15 text-accent' : 'text-fg-3 hover:bg-hover hover:text-fg',
                    )}
                  >
                    <Trans>明天</Trans>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-7 gap-0.5 text-center text-xs text-fg-4">
                {weekdayLabels.map((label, index) => (
                  <span key={index} className="py-1 font-medium">{label}</span>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-0.5">
                {calendarDays.map((cell) => {
                  const past = cell.getTime() < today.getTime();
                  const inMonth = cell.getMonth() === viewMonth;
                  const active = sameDay(cell, selected);
                  const isToday = sameDay(cell, today);
                  return (
                    <button
                      key={cell.getTime()}
                      type="button"
                      disabled={past}
                      aria-pressed={active}
                      onClick={() => selectDate(cell)}
                      className={cn(
                        'grid h-8 w-full place-items-center rounded-lg text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus no-hover:h-11',
                        past
                          ? 'cursor-not-allowed text-fg-4/35'
                          : active
                            ? 'bg-primary font-medium text-primary-fg'
                            : inMonth
                              ? 'text-fg hover:bg-hover'
                              : 'text-fg-4 hover:bg-hover hover:text-fg-2',
                        isToday && !active && 'ring-1 ring-inset ring-line-strong font-medium',
                      )}
                    >
                      {cell.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Time */}
            <div className="flex shrink-0 flex-col gap-2 sm:w-32">
              <div className="flex items-center justify-center gap-1 rounded-lg border border-line bg-surface px-2 py-1">
                <input
                  ref={hourInputRef}
                  type="text"
                  inputMode="numeric"
                  maxLength={2}
                  aria-label={t`小时`}
                  value={hourText}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => {
                    const digits = event.target.value.replace(/\D/g, '').slice(0, 2);
                    setHourText(digits);
                    if (!digits) return;
                    const clamped = Math.min(23, Number(digits));
                    if (clamped !== Number(digits)) setHourText(pad2(clamped));
                    setHour(clamped);
                    if (digits.length === 2) {
                      minuteInputRef.current?.focus();
                      minuteInputRef.current?.select();
                    }
                  }}
                  onBlur={() => setHourText(pad2(selected.getHours()))}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      const next = (selected.getHours() + 1) % 24;
                      setHour(next);
                      setHourText(pad2(next));
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      const next = (selected.getHours() + 23) % 24;
                      setHour(next);
                      setHourText(pad2(next));
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      submitIfValid();
                    }
                  }}
                  className="w-8 bg-transparent text-center text-sm font-medium tabular-nums text-fg outline-none"
                />
                <span aria-hidden="true" className="text-sm font-medium text-fg-4">:</span>
                <input
                  ref={minuteInputRef}
                  type="text"
                  inputMode="numeric"
                  maxLength={2}
                  aria-label={t`分钟`}
                  value={minuteText}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => {
                    const digits = event.target.value.replace(/\D/g, '').slice(0, 2);
                    setMinuteText(digits);
                    if (!digits) return;
                    const clamped = Math.min(59, Number(digits));
                    if (clamped !== Number(digits)) setMinuteText(pad2(clamped));
                    setMinute(clamped);
                  }}
                  onBlur={() => setMinuteText(pad2(selected.getMinutes()))}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      const next = (selected.getMinutes() + 1) % 60;
                      setMinute(next);
                      setMinuteText(pad2(next));
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      const next = (selected.getMinutes() + 59) % 60;
                      setMinute(next);
                      setMinuteText(pad2(next));
                    } else if (event.key === 'Backspace' && minuteText === '') {
                      hourInputRef.current?.focus();
                      hourInputRef.current?.select();
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      submitIfValid();
                    }
                  }}
                  className="w-8 bg-transparent text-center text-sm font-medium tabular-nums text-fg outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <div
                  ref={hourListRef}
                  role="listbox"
                  tabIndex={0}
                  aria-label={t`小时`}
                  aria-activedescendant={`${listId}-h-${selected.getHours()}`}
                  onKeyDown={(event) => {
                    const current = selected.getHours();
                    let next: number | undefined;
                    if (event.key === 'ArrowDown') next = (current + 1) % 24;
                    else if (event.key === 'ArrowUp') next = (current + 23) % 24;
                    else if (event.key === 'Home') next = 0;
                    else if (event.key === 'End') next = 23;
                    else if (event.key === 'Enter') { event.preventDefault(); submitIfValid(); return; }
                    if (next === undefined) return;
                    event.preventDefault();
                    setHour(next);
                    setHourText(pad2(next));
                    hourListRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-h-${next}`)}`)?.scrollIntoView({ block: 'nearest' });
                  }}
                  className="h-36 overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-1 outline-none focus-visible:ring-2 focus-visible:ring-focus sm:h-48"
                >
                  {Array.from({ length: 24 }, (_, hour) => {
                    const active = selected.getHours() === hour;
                    const pastHour = isTodaySelected && hour < now.getHours();
                    return (
                      <button
                        key={hour}
                        id={`${listId}-h-${hour}`}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={active}
                        onClick={() => { setHour(hour); setHourText(pad2(hour)); }}
                        className={cn(
                          'grid h-7 w-full place-items-center rounded-md text-xs tabular-nums transition-colors no-hover:h-10',
                          active
                            ? 'bg-primary font-medium text-primary-fg'
                            : pastHour
                              ? 'text-fg-4/60 hover:bg-hover hover:text-fg-2'
                              : 'text-fg-2 hover:bg-hover hover:text-fg',
                        )}
                      >
                        {pad2(hour)}
                      </button>
                    );
                  })}
                </div>

                <div
                  ref={minuteListRef}
                  role="listbox"
                  tabIndex={0}
                  aria-label={t`分钟`}
                  aria-activedescendant={`${listId}-m-${selected.getMinutes()}`}
                  onKeyDown={(event) => {
                    const current = selected.getMinutes();
                    let next: number | undefined;
                    if (event.key === 'ArrowDown') next = (current + 1) % 60;
                    else if (event.key === 'ArrowUp') next = (current + 59) % 60;
                    else if (event.key === 'Home') next = 0;
                    else if (event.key === 'End') next = 59;
                    else if (event.key === 'Enter') { event.preventDefault(); submitIfValid(); return; }
                    if (next === undefined) return;
                    event.preventDefault();
                    setMinute(next);
                    setMinuteText(pad2(next));
                    minuteListRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-m-${next}`)}`)?.scrollIntoView({ block: 'nearest' });
                  }}
                  className="h-36 overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-1 outline-none focus-visible:ring-2 focus-visible:ring-focus sm:h-48"
                >
                  {Array.from({ length: 60 }, (_, minute) => {
                    const active = selected.getMinutes() === minute;
                    const pastMinute = isTodaySelected && (selected.getHours() < now.getHours() || (selected.getHours() === now.getHours() && minute <= now.getMinutes()));
                    return (
                      <button
                        key={minute}
                        id={`${listId}-m-${minute}`}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={active}
                        onClick={() => { setMinute(minute); setMinuteText(pad2(minute)); }}
                        className={cn(
                          'grid h-7 w-full place-items-center rounded-md text-xs tabular-nums transition-colors no-hover:h-10',
                          active
                            ? 'bg-primary font-medium text-primary-fg'
                            : pastMinute
                              ? 'text-fg-4/60 hover:bg-hover hover:text-fg-2'
                              : 'text-fg-2 hover:bg-hover hover:text-fg',
                        )}
                      >
                        {pad2(minute)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className={cn('flex items-center gap-1.5 rounded-lg bg-surface px-3 py-2 text-xs', valid ? 'text-fg-2' : 'text-danger')}>
            <IconCalendarClock className={cn('size-3.5 shrink-0', valid ? 'text-fg-3' : 'text-danger')} />
            {valid ? (
              <span className="tabular-nums">
                {formatWhen(selected.toISOString())} · {relativeAhead}
              </span>
            ) : (
              <span><Trans>请选择晚于当前的时间</Trans></span>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}><Trans context="tasks-cancel-action">取消</Trans></Button>
          <Button variant="primary" disabled={!valid} onClick={submitIfValid}>{confirmLabel ?? t`设为发送时间`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The input box's "send later": a quiet clock beside the model picker with the same one-time presets as the tasks page. */
export function SendLaterMenu({
  disabled,
  scheduledAt,
  onPick,
  onClearSchedule,
}: {
  disabled?: boolean;
  scheduledAt?: Date | null;
  onPick: (at: Date) => void;
  onClearSchedule?: () => void;
}) {
  const { t } = useLingui();
  const [custom, setCustom] = useState(false);
  const scheduled = Boolean(scheduledAt);
  return (
    <>
      <DropdownMenu>
        {scheduled && scheduledAt ? (
          <div className="inline-flex shrink-0 items-center rounded-md bg-accent/10 text-accent">
            <Tip label={t`修改发送时间`}>
              <span className="inline-flex">
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t`修改发送时间`}
                    disabled={disabled}
                    className={cn(
                      'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-colors hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:h-7',
                      onClearSchedule && 'rounded-r-none pr-1.5',
                    )}
                  >
                    <IconCalendarClock className="size-4 shrink-0" />
                    <span className="max-w-28 truncate tabular-nums">{formatWhen(scheduledAt.toISOString())}</span>
                  </button>
                </DropdownMenuTrigger>
              </span>
            </Tip>
            {onClearSchedule && (
              <Tip label={t`取消定时`}>
                <button
                  type="button"
                  aria-label={t`取消定时`}
                  disabled={disabled}
                  onClick={onClearSchedule}
                  className="grid h-11 w-7 shrink-0 place-items-center rounded-r-md text-accent/70 outline-none transition-colors hover:bg-accent/15 hover:text-accent focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:h-7 md:w-6"
                >
                  <IconX className="size-3.5" />
                </button>
              </Tip>
            )}
          </div>
        ) : (
          <Tip label={t`稍后发送`}>
            <span className="inline-flex">
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t`稍后发送`}
                  disabled={disabled}
                  className="grid size-11 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent data-[state=open]:bg-hover md:size-7"
                >
                  <IconCalendarClock className="size-[18px]" />
                </button>
              </DropdownMenuTrigger>
            </span>
          </Tip>
        )}
        <DropdownMenuContent align="start" side="top" className="w-44">
          {ONCE_PRESETS.map((preset: OncePreset) => <DropdownMenuItem key={preset} onSelect={() => onPick(onceDate(preset))}>{onceLabel(preset)}</DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCustom(true)}><Trans>自定义时间…</Trans></DropdownMenuItem>
          {scheduled && onClearSchedule && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onClearSchedule}><Trans>取消定时</Trans></DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CustomTimeDialog open={custom} onOpenChange={setCustom} initialDate={scheduledAt} onPick={onPick} />
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
  const nextDue = items[0]?.nextRunAt;
  useEffect(() => {
    if (!nextDue) return;
    const delay = Math.max(200, Date.parse(nextDue) - Date.now() + 500);
    const timer = window.setTimeout(() => void refresh(), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [nextDue, refresh]);
  const cancel = useCallback(async (id: string): Promise<boolean> => {
    setItems((current) => current.filter((item) => item.id !== id));
    try {
      await api.deleteAutomation(id);
      return true;
    } catch (error) {
      toast.error(errorMessage(error, i18n._(msg`无法取消`)));
      void refresh();
      return false;
    }
  }, [refresh]);
  const reschedule = useCallback(async (id: string, at: Date): Promise<boolean> => {
    const nextIso = at.toISOString();
    setItems((current) =>
      current
        .map((item) => (item.id === id ? { ...item, nextRunAt: nextIso, triggers: [onceTrigger(at)] } : item))
        .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? '')),
    );
    try {
      const updated = await api.updateAutomation(id, { triggers: [onceTrigger(at)] });
      setItems((current) =>
        current
          .map((item) => (item.id === id ? updated : item))
          .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? '')),
      );
      return true;
    } catch (error) {
      toast.error(errorMessage(error, i18n._(msg`无法修改发送时间`)));
      void refresh();
      return false;
    }
  }, [refresh]);
  return { items, refresh, cancel, reschedule };
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
export function FollowUpList({ items, onCancel, onEdit, onReschedule }: { items: Automation[]; onCancel: (id: string) => void; onEdit?: (item: Automation) => void; onReschedule?: (id: string, at: Date) => Promise<boolean> | boolean | void }) {
  const { t } = useLingui();
  const [editing, setEditing] = useState<Automation | null>(null);
  const editingInitialDate = useMemo(() => (editing?.nextRunAt ? new Date(editing.nextRunAt) : undefined), [editing?.nextRunAt]);
  return (
    <>
      <ul className="flex flex-col rounded-2xl bg-elevated px-2 py-1 max-md:border max-md:border-line-strong md:shadow-composer" aria-label={t`稍后发送`}>
        {items.map((item) => (
          <li key={item.id} className="flex min-h-11 min-w-0 items-center gap-2 px-1.5 md:min-h-8">
            <IconCalendarClock className="size-3.5 shrink-0 text-fg-4" />
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-fg-2">
              {item.followUp?.by === 'user' && onReschedule ? (
                <Tip label={t`修改发送时间`}>
                  <button
                    type="button"
                    onClick={() => setEditing(item)}
                    className="shrink-0 rounded-md px-1.5 py-0.5 tabular-nums text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11"
                  >
                    {formatWhen(item.nextRunAt!)}
                  </button>
                </Tip>
              ) : (
                <span className="shrink-0 tabular-nums text-fg-3">{formatWhen(item.nextRunAt!)}</span>
              )}
              <span aria-hidden="true" className="shrink-0 text-fg-4">·</span>
              <span className="min-w-0 flex-1 truncate">{item.prompt.split('\n')[0]}</span>
            </div>
            {Boolean(item.input?.attachmentIds.length) && <span className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-fg-4"><IconPaperclip className="size-3.5" />{item.input!.attachmentIds.length > 1 ? item.input!.attachmentIds.length : null}</span>}
            {item.followUp?.by === 'user' && onEdit && (
              <Tip label={t`移回输入框编辑`}>
                <button type="button" aria-label={t`编辑`} onClick={() => onEdit(item)} className="grid size-11 shrink-0 place-items-center rounded-full text-fg-3 transition-colors hover:bg-hover hover:text-fg md:size-6.5"><IconPencilLine className="size-3.5" /></button>
              </Tip>
            )}
            <Tip label={t`取消`}>
              <button type="button" aria-label={t`取消`} onClick={() => onCancel(item.id)} className="grid size-11 shrink-0 place-items-center rounded-full text-fg-3 transition-colors hover:bg-hover hover:text-danger md:size-6.5"><IconX className="size-3.5" /></button>
            </Tip>
          </li>
        ))}
      </ul>
      <CustomTimeDialog
        open={Boolean(editing)}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        initialDate={editingInitialDate}
        confirmLabel={t`修改发送时间`}
        onPick={(at) => { if (editing) void onReschedule?.(editing.id, at); }}
      />
    </>
  );
}
