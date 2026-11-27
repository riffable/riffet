import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DEFAULT_AGENT_MEMBER_ID, type AssistantRunSummary } from '@contracts';
import { Button } from '@/components/ui/button';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { plainMarkdownText } from '@/lib/markdown-preview';
import { useVisibleInterval } from '@/lib/use-visible-interval';
import { cn, readStored, relativeTime, writeStored } from '@/lib/utils';
import { Markdown } from './Markdown';

const RUN_LIMIT = 5;
const REPORT_DOCK_LIMIT = 3;
const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 30_000;
const DISMISSED_REPORTS_KEY = 'riffet.memberRuns.dismissedReports';
const MAX_DISMISSED_REPORTS = 200;

function readDismissedReports(): ReadonlySet<string> {
  try {
    const raw = readStored(DISMISSED_REPORTS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

function writeDismissedReports(ids: ReadonlySet<string>): void {
  writeStored(DISMISSED_REPORTS_KEY, ids.size ? JSON.stringify([...ids].slice(-MAX_DISMISSED_REPORTS)) : undefined);
}

export function runIsActive(run: AssistantRunSummary): boolean {
  return run.state === 'running' || run.state === 'queued';
}

export function runStatusTone(run: AssistantRunSummary): 'danger' | 'warning' | 'success' | 'idle' {
  if (run.state === 'failed') return 'danger';
  if (run.outcome === 'ask') return 'warning';
  if (run.outcome === 'tell') return 'success';
  return 'idle';
}

export function runTimestamp(run: AssistantRunSummary): string {
  return run.endedAt ?? run.startedAt ?? run.createdAt;
}

export function useRunStateLabel() {
  const { t } = useLingui();
  return useCallback((run: AssistantRunSummary): string => {
    if (run.state === 'running') return t`运行中`;
    if (run.state === 'queued') return t`排队中`;
    if (run.state === 'failed') return t`失败`;
    if (run.outcome === 'ask') return t`需确认`;
    if (run.outcome === 'tell') return t`已汇报`;
    if (run.outcome === 'silent') return t`静默`;
    return t`已完成`;
  }, [t]);
}

/**
 * Fetches recent background runs for the active team member or default assistant.
 * Polls faster while a run is active, slower while idle, and pauses when the tab is hidden.
 */
export function useMemberBackgroundRuns(memberId: string | undefined, enabled: boolean): readonly AssistantRunSummary[] {
  const [runs, setRuns] = useState<AssistantRunSummary[]>([]);
  const requestId = useRef(0);

  const load = useCallback(() => {
    if (!enabled || !memberId) return;
    const seq = ++requestId.current;
    const req = memberId === DEFAULT_AGENT_MEMBER_ID ? api.assistantRuns(20) : api.teamMemberRuns(memberId, 20);
    req.then(
      ({ runs: next }) => {
        if (requestId.current === seq) setRuns(next);
      },
      () => undefined,
    );
  }, [enabled, memberId]);

  useEffect(() => {
    if (!enabled || !memberId) {
      requestId.current += 1;
      setRuns([]);
      return;
    }
    load();
  }, [enabled, memberId, load]);

  const hasActive = runs.some(runIsActive);
  useVisibleInterval(load, hasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS, enabled && Boolean(memberId));

  return runs;
}

const foldButton = 'flex h-7 w-full items-center gap-2.5 rounded-lg px-2 text-left text-2xs text-fg-4 transition-colors hover:bg-hover hover:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

/** Member background runs shown in the wide session aside, including silent runs so none stay opaque. */
export const AsideMemberRuns = memo(function AsideMemberRuns({ runs, onOpenSession }: {
  runs: readonly AssistantRunSummary[];
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useLingui();
  const stateLabel = useRunStateLabel();
  const [expanded, setExpanded] = useState(false);
  if (runs.length === 0) return null;

  const active = runs.filter(runIsActive).length;
  const ordered = [...runs].sort((left, right) => {
    const activeDiff = Number(runIsActive(right)) - Number(runIsActive(left));
    if (activeDiff !== 0) return activeDiff;
    return Date.parse(runTimestamp(right)) - Date.parse(runTimestamp(left));
  });
  const shown = expanded ? ordered : ordered.slice(0, Math.max(active, RUN_LIMIT));
  const hidden = ordered.length - shown.length;

  return (
    <section aria-label={t`后台任务`}>
      <h2 className="mb-1.5 flex items-center px-2 text-2xs font-medium text-fg-4">
        {t`后台任务`}
        <span className="ml-auto tabular-nums">{active > 0 ? t`${active} 进行中` : runs.length}</span>
      </h2>
      <ul className="flex flex-col">
        {shown.map((run) => {
          const isRunning = runIsActive(run);
          const canOpen = Boolean(run.sessionId && onOpenSession);
          const detailRaw = run.error ?? run.text;
          const detail = detailRaw ? plainMarkdownText(detailRaw, { singleLine: true }) : undefined;
          const time = relativeTime(runTimestamp(run));
          const summary = detail ? `${run.title}\n${detail}` : run.title;
          const body = (
            <>
              <span className="flex h-5 shrink-0 items-center">
                <span className="grid size-3.5 place-items-center">
                  {isRunning ? <Spinner className="size-3.5 text-fg-3" /> : <StatusDot tone={runStatusTone(run)} />}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={cn('min-w-0 flex-1 truncate text-sm', isRunning ? 'text-fg' : 'text-fg-2')}>{run.title}</span>
                  <span className="shrink-0 text-2xs tabular-nums text-fg-4">{time}</span>
                </span>
                <span className="flex items-center gap-1.5 text-2xs text-fg-4">
                  <span className={cn('shrink-0', run.state === 'failed' && 'text-danger', run.outcome === 'ask' && 'text-warning')}>
                    {stateLabel(run)}
                  </span>
                  {detail && <span className="min-w-0 truncate">· {detail}</span>}
                </span>
              </span>
            </>
          );
          return (
            <li key={run.id}>
              {canOpen ? (
                <button
                  type="button"
                  title={summary}
                  onClick={() => run.sessionId && onOpenSession?.(run.sessionId)}
                  className="flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {body}
                </button>
              ) : (
                <div title={summary} className="flex w-full min-w-0 items-start gap-2.5 px-2 py-1">
                  {body}
                </div>
              )}
            </li>
          );
        })}
        {hidden > 0 && (
          <li>
            <button type="button" onClick={() => setExpanded(true)} className={cn(foldButton, 'pl-8')}>
              <Trans>还有 {hidden} 条记录</Trans>
            </button>
          </li>
        )}
        {expanded && ordered.length > RUN_LIMIT && (
          <li>
            <button type="button" onClick={() => setExpanded(false)} className={cn(foldButton, 'pl-8')}>
              <Trans>收起</Trans>
            </button>
          </li>
        )}
      </ul>
    </section>
  );
});

/**
 * Surfaces `tell` and `ask` background run summaries above the composer so foreground reporting
 * stays visible in the main conversation, while `silent` runs stay strictly in the side column.
 */
export const MemberRunReportsDock = memo(function MemberRunReportsDock({ runs, onOpenSession }: {
  runs: readonly AssistantRunSummary[];
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useLingui();
  const stateLabel = useRunStateLabel();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(readDismissedReports);
  const reports = useMemo(
    () => runs
      .filter((run) => (run.outcome === 'tell' || run.outcome === 'ask') && Boolean(run.text?.trim()) && !dismissed.has(run.id))
      .sort((left, right) => Date.parse(runTimestamp(right)) - Date.parse(runTimestamp(left)))
      .slice(0, REPORT_DOCK_LIMIT),
    [runs, dismissed],
  );
  if (reports.length === 0) return null;

  const dismiss = (id: string) => setDismissed((current) => {
    if (current.has(id)) return current;
    const next = new Set(current);
    next.add(id);
    writeDismissedReports(next);
    return next;
  });

  return (
    <ul className="flex flex-col divide-y divide-line rounded-2xl bg-elevated px-3 py-1.5 max-md:border max-md:border-line-strong md:shadow-composer" aria-label={t`后台任务汇报`}>
      {reports.map((run) => (
        <li key={run.id} className="flex flex-col gap-1.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot tone={runStatusTone(run)} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{run.title}</span>
            <span className={cn('shrink-0 text-2xs', run.outcome === 'ask' ? 'text-warning' : 'text-fg-4')}>
              {stateLabel(run)} · {relativeTime(runTimestamp(run))}
            </span>
          </div>
          {run.text && (
            <div className="max-h-44 min-w-0 overflow-y-auto overscroll-contain pl-4 select-text">
              <Markdown text={run.text} className="md-compact min-w-0" />
            </div>
          )}
          <div className="flex items-center justify-end gap-1.5">
            {run.sessionId && onOpenSession && (
              <Button size="xs" variant="secondary" onClick={() => run.sessionId && onOpenSession(run.sessionId)}>
                <Trans>查看记录</Trans>
              </Button>
            )}
            <Button size="xs" variant="secondary" onClick={() => dismiss(run.id)}>
              <Trans>标为已读</Trans>
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
});
