import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { MOTION_DURATION, type AgentMember, type PluginApproval, type RiffetNotice } from '@contracts';
import { IconShieldCheck, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { MIN_FEEDBACK_VISIBLE_MS } from '@/lib/feedback';
import { relativeTime } from '@/lib/i18n/format';
import { plainMarkdownText } from '@/lib/markdown-preview';
import { animationsOf, settled } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { MemberAvatar } from '../team/MemberAvatar';

export type InboxAlertItem =
  | {
      key: string;
      kind: 'notice';
      notice: RiffetNotice;
      member?: AgentMember;
    }
  | {
      key: string;
      kind: 'approval';
      approval: PluginApproval;
    };

const NOTICE_DURATION_MS = 8_000;
const APPROVAL_DURATION_MS = 10_000;

interface InboxAlertDockProps {
  items: readonly InboxAlertItem[];
  /** Total unread/pending items currently in the Inbox, used for the footer overflow cue. */
  inboxCount: number;
  desktop: boolean;
  /** Whether the desktop sidebar footer (with the bottom-left avatar) is visibly docked on screen. */
  sidebarFooterVisible: boolean;
  onDismiss: (key: string) => void;
  onOpenNotice: (notice: RiffetNotice) => void;
  onMarkNoticeRead: (notice: RiffetNotice) => void;
  onOpenInbox: () => void;
}

/**
 * Anchored above the bottom-left sidebar avatar on desktop (top-center on mobile) to deliver
 * async Inbox arrivals — team member messages (`notify_user`) and plugin write approvals —
 * without hijacking the top-center action toast or covering the reading column.
 */
export function InboxAlertDock({
  items,
  inboxCount,
  desktop,
  sidebarFooterVisible,
  onDismiss,
  onOpenNotice,
  onMarkNoticeRead,
  onOpenInbox,
}: InboxAlertDockProps) {
  const head = items[0];
  if (!head) return null;

  const stackDepth = Math.min(2, Math.max(0, items.length - 1));
  const extraCount = Math.max(items.length - 1, inboxCount - 1);

  return (
    <div
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed z-(--z-toast)',
        desktop
          ? sidebarFooterVisible
            ? 'bottom-14 left-2 w-[max(20rem,calc(var(--sidebar-w)-1rem))] max-w-[min(24rem,calc(100vw-1.5rem))]'
            : 'bottom-4 left-3 w-80 max-w-[calc(100vw-1.5rem)]'
          : 'inset-x-3 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] mx-auto max-w-sm',
      )}
    >
      <InboxAlertCard
        key={head.key}
        item={head}
        stackDepth={stackDepth}
        extraCount={extraCount}
        desktop={desktop}
        anchoredToAvatar={desktop && sidebarFooterVisible}
        onDismiss={() => onDismiss(head.key)}
        onOpen={() => {
          onDismiss(head.key);
          if (head.kind === 'notice') onOpenNotice(head.notice);
          else onOpenInbox();
        }}
        onMarkRead={head.kind === 'notice' ? () => {
          onDismiss(head.key);
          onMarkNoticeRead(head.notice);
        } : undefined}
        onOpenInbox={() => {
          onDismiss(head.key);
          onOpenInbox();
        }}
      />
    </div>
  );
}

function InboxAlertCard({
  item,
  stackDepth,
  extraCount,
  desktop,
  anchoredToAvatar,
  onDismiss,
  onOpen,
  onMarkRead,
  onOpenInbox,
}: {
  item: InboxAlertItem;
  stackDepth: number;
  extraCount: number;
  desktop: boolean;
  anchoredToAvatar: boolean;
  onDismiss: () => void;
  onOpen: () => void;
  onMarkRead?: () => void;
  onOpenInbox: () => void;
}) {
  const { t } = useLingui();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const duration = item.kind === 'approval' ? APPROVAL_DURATION_MS : NOTICE_DURATION_MS;
  const clockRef = useRef({
    timer: undefined as number | undefined,
    remaining: duration,
    startedAt: 0,
    entered: false,
    pauses: new Set<string>(),
  });

  const startLeaving = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    const clock = clockRef.current;
    if (clock.timer !== undefined) {
      window.clearTimeout(clock.timer);
      clock.timer = undefined;
    }
    setLeaving(true);
  };

  const stopTimer = () => {
    const clock = clockRef.current;
    if (clock.timer === undefined) return;
    window.clearTimeout(clock.timer);
    clock.timer = undefined;
    clock.remaining = Math.max(0, clock.remaining - (performance.now() - clock.startedAt));
  };

  const startTimer = () => {
    const clock = clockRef.current;
    if (leavingRef.current || clock.timer !== undefined || !clock.entered || clock.pauses.size > 0 || document.visibilityState === 'hidden') return;
    clock.startedAt = performance.now();
    clock.timer = window.setTimeout(() => {
      clock.timer = undefined;
      if (leavingRef.current || clock.pauses.size > 0 || document.visibilityState === 'hidden') return;
      clock.remaining = 0;
      startLeaving();
    }, clock.remaining);
  };

  const pause = (reason: string) => {
    const clock = clockRef.current;
    if (clock.pauses.has(reason)) return;
    clock.pauses.add(reason);
    stopTimer();
    clock.remaining = Math.max(MIN_FEEDBACK_VISIBLE_MS, clock.remaining);
  };

  const resume = (reason: string) => {
    clockRef.current.pauses.delete(reason);
    startTimer();
  };

  // Start reading countdown only after the entrance transition finishes.
  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    let active = true;
    void settled(animationsOf(element)).then(() => {
      if (!active) return;
      clockRef.current.entered = true;
      startTimer();
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopTimer();
      else startTimer();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      stopTimer();
    };
  }, []);

  // Remove the card once its exit animation finishes (with a fallback timer if animations are off).
  useEffect(() => {
    if (!leaving) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dismissRef.current();
    };
    const element = surfaceRef.current;
    const fallback = window.setTimeout(finish, MOTION_DURATION.exitBase + 40);
    if (element) {
      void settled(animationsOf(element)).then(finish);
    }
    return () => {
      done = true;
      window.clearTimeout(fallback);
    };
  }, [leaving]);

  const isApproval = item.kind === 'approval';
  const sender = isApproval
    ? item.approval.pluginName || t`插件审批`
    : item.member?.name || item.notice.senderName || (item.notice.source === 'wakeup' ? t`定时提醒` : t`成员消息`);
  const title = isApproval ? item.approval.title.trim() : item.notice.title?.trim();
  const rawBody = isApproval ? item.approval.body : item.notice.body;
  const preview = plainMarkdownText(rawBody);
  const createdAt = isApproval ? item.approval.createdAt : item.notice.createdAt;
  const hasSession = !isApproval && Boolean(item.notice.sessionId);

  return (
    <div className="relative">
      {stackDepth >= 2 && !leaving && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-4 h-6 rounded-2xl bg-elevated opacity-55 shadow-soft ring-1 ring-line',
            desktop ? '-top-2.5' : '-bottom-2.5',
          )}
        />
      )}
      {stackDepth >= 1 && !leaving && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-2 h-6 rounded-2xl bg-elevated opacity-80 shadow-soft ring-1 ring-line',
            desktop ? '-top-1.5' : '-bottom-1.5',
          )}
        />
      )}
      <div
        ref={surfaceRef}
        role={isApproval ? 'alert' : 'status'}
        onPointerEnter={() => pause('pointer')}
        onPointerLeave={() => resume('pointer')}
        onFocus={() => pause('focus')}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume('focus');
        }}
        className={cn(
          'pointer-events-auto relative rounded-2xl bg-elevated px-3.5 pt-3 pb-3 text-fg shadow-peek ring-1 ring-line-strong',
          desktop ? 'origin-bottom-left' : 'origin-top',
          leaving
            ? cn(
                'animate-out fade-out-0 zoom-out-95 duration-[var(--duration-exit-base)] ease-[var(--ease-accelerate)] fill-mode-forwards',
                desktop ? 'slide-out-to-bottom-3' : 'slide-out-to-top-2',
              )
            : cn(
                'animate-in fade-in-0 zoom-in-95 duration-[var(--duration-medium)] ease-[var(--ease-decelerate)]',
                desktop ? 'slide-in-from-bottom-4' : 'slide-in-from-top-3',
              ),
        )}
      >
        {anchoredToAvatar && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-1.5 left-2.5 size-2.5 rotate-45 rounded-xs border-r border-b border-line-strong bg-elevated"
          />
        )}
        <div className="flex min-w-0 items-center gap-2">
          {isApproval ? (
            <span className="grid size-5 shrink-0 place-items-center text-warning">
              <IconShieldCheck className="size-4" />
            </span>
          ) : item.member ? (
            <MemberAvatar member={item.member} size={22} className="shrink-0 ring-1 ring-line" />
          ) : (
            <span className="grid size-4 shrink-0 place-items-center">
              <StatusDot tone="accent" className="size-2" />
            </span>
          )}
          <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate text-xs font-medium text-fg">{sender}</span>
            <span aria-hidden="true" className="shrink-0 text-2xs text-fg-4">·</span>
            {isApproval ? (
              <span className="shrink-0 text-2xs font-medium text-warning"><Trans>待确认</Trans></span>
            ) : (
              <span className="shrink-0 text-2xs tabular-nums text-fg-3">{relativeTime(createdAt)}</span>
            )}
          </div>
          <Tip label={t`关闭通知`} side="top">
            <Button
              size="icon-xs"
              variant="quiet"
              aria-label={t`关闭通知`}
              onClick={startLeaving}
              className="-mr-1 -mt-0.5 shrink-0 text-fg-4 hover:text-fg"
            >
              <IconX className="size-3.5" />
            </Button>
          </Tip>
        </div>

        <button
          type="button"
          onClick={onOpen}
          className="mt-2 block w-full rounded-xl bg-subtle/75 px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {title ? (
            <>
              <span className={cn('block text-sm font-medium leading-snug text-fg wrap-anywhere', preview ? 'line-clamp-2' : 'line-clamp-3')}>{title}</span>
              {preview && (
                <span className="mt-0.5 line-clamp-3 block whitespace-pre-line text-xs leading-relaxed text-fg-2 wrap-anywhere">
                  {preview}
                </span>
              )}
            </>
          ) : (
            <span className="line-clamp-3 block whitespace-pre-line text-sm leading-snug text-fg wrap-anywhere">
              {preview}
            </span>
          )}
        </button>

        <div className="mt-2.5 flex items-center gap-2">
          {extraCount > 0 && (
            <button
              type="button"
              onClick={onOpenInbox}
              className="-ml-1 truncate rounded-md px-1.5 py-0.5 text-2xs font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Trans>还有 {extraCount} 条</Trans>
            </button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {onMarkRead && (
              <Button size="xs" variant="ghost" onClick={onMarkRead}>
                <Trans>标为已读</Trans>
              </Button>
            )}
            <Button size="xs" variant="primary" onClick={onOpen}>
              {isApproval ? <Trans>前往确认</Trans> : hasSession ? <Trans>打开会话</Trans> : <Trans>查看收件箱</Trans>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
