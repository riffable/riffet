import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { WorkbenchEvent } from '@contracts';
import { IconArrowLeft, IconBot, IconChevronRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { useNow } from '@/lib/use-now';
import { isRecord, str } from '@/lib/utils';
import { buildTimeline } from './buildTimeline';
import { activeToolStates, toolView } from './toolView';
import type { EarlierLoad } from './useEarlierHistory';
import { projectEvents } from './projectEvents';
import { formatDuration, promptFromTranscript, transcriptDuration } from './SessionWorkActions';
import { SubagentContext, SubagentStoreContext, specificSubagentLabel, useSubagentTranscript, type SubagentRenderer, type SubagentTarget } from './subagents';
import { ToolContents, WorkingIndicator } from './Timeline';
import { TranscriptView } from './TranscriptView';
import { useTranscriptResources } from './transcriptResources';
import { showsRunningCompaction } from './Activities';

/** Project the real spawning task before the current native window, without storing a fake event. */
export function subagentEvents(events: WorkbenchEvent[], toolCallId: string, prompt?: string, sessionId?: string): WorkbenchEvent[] {
  if (!prompt?.trim()) return events;
  const nativePrompt = events[0]?.type === 'user_message_chunk' ? events[0] : undefined;
  const content = nativePrompt && isRecord(nativePrompt.data.content) ? nativePrompt.data.content : undefined;
  if (nativePrompt && str(content?.text)?.trim() === prompt.trim()) return events;
  const first = events[0];
  return [{
    sequence: (first?.sequence ?? 1) - 1,
    sessionId: first?.sessionId ?? sessionId ?? toolCallId,
    ...(first?.runId ? { runId: first.runId } : {}),
    type: 'user_message_chunk',
    data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } },
    createdAt: first?.createdAt ?? '',
    nativeId: `subagent-prompt:${toolCallId}`,
  } as WorkbenchEvent, ...events];
}

/** What the spawning call asked for: the Task/subagent call's own description and prompt. */
function subagentCall(event: WorkbenchEvent | undefined, root?: string) {
  if (!event) return undefined;
  const view = toolView(event, root);
  const subagent = isRecord(event.data.subagent) ? event.data.subagent : undefined;
  const input = isRecord(view.rawInput) ? view.rawInput : undefined;
  return {
    view,
    title: str(subagent?.description)?.trim() || str(input?.description)?.trim() || view.title,
    prompt: str(input?.prompt)?.trim() || str(subagent?.prompt)?.trim(),
    type: str(subagent?.type) ?? str(input?.subagent_type),
    model: str(subagent?.model) ?? str(input?.model),
    running: activeToolStates.has(view.status),
  };
}

/**
 * A subagent's transcript, opened like a session page: the same transcript view as the main agent,
 * read-only, under a bar that leads back to the conversation (or the parent subagent) it came from.
 *
 * `stack` holds subagents opened from inside one another; a nested child's spawning call lives in
 * its parent's transcript, so the target carries it when the parent's page opened it.
 */
export function SubagentSession({ stack, onBack, onClose, onOpen, findEvent, sessionId, sessionTitle, pendingConfirmation, root, onOpenPath, onOpenInEditor }: {
  stack: readonly SubagentTarget[];
  /** One level up: the parent subagent, or the main conversation. */
  onBack: () => void;
  /** Straight back to the main conversation. */
  onClose: () => void;
  /** Opens a nested subagent on top of this one. */
  onOpen: (target: SubagentTarget) => void;
  findEvent: (toolCallId: string) => WorkbenchEvent | undefined;
  sessionId: string;
  sessionTitle: string;
  /** The main conversation needs a response; its form stays on that conversation's page. */
  pendingConfirmation?: boolean;
  root?: string;
  onOpenPath: (path: string, line?: number) => void;
  onOpenInEditor?: (path: string, line?: number) => void;
}) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const target = stack.at(-1)!;
  const parent = stack.length > 1 ? stack.at(-2) : undefined;
  const transcript = useSubagentTranscript(target.toolCallId);
  const parentTranscript = useSubagentTranscript(parent?.toolCallId ?? '');
  const store = useContext(SubagentStoreContext);
  const call = subagentCall(target.event ?? findEvent(target.toolCallId), root);
  const parentCall = parent ? subagentCall(parent.event ?? findEvent(parent.toolCallId), root) : undefined;
  const live = resources ? false : transcript?.running ?? call?.running ?? target.running;
  const type = specificSubagentLabel(transcript?.subagentType ?? call?.type);
  const title = specificSubagentLabel(call?.title) || specificSubagentLabel(transcript?.title) || (transcript ? specificSubagentLabel(promptFromTranscript(transcript.events)) : undefined) || type || t`子 Agent`;
  const parentTitle = parent ? parentCall?.title || (parentTranscript ? promptFromTranscript(parentTranscript.events) : '') || t`上一级子 Agent` : undefined;

  // A live conversation streams the child's lane only while this page shows it, its rows already folded;
  // a shared transcript carries the child's events, folded here.
  const lanes = store?.lanes;
  useEffect(() => lanes?.watch(target.toolCallId), [lanes, target.toolCallId]);
  const events = useMemo(() => (lanes ? transcript?.events ?? [] : subagentEvents(transcript?.events ?? [], target.toolCallId, call?.prompt || transcript?.prompt, sessionId)),
    [lanes, transcript, call?.prompt, sessionId, target.toolCallId]);
  const timeline = useMemo(() => transcript?.timeline ?? buildTimeline(projectEvents(events), []), [transcript?.timeline, events]);
  const loadEarlier = useCallback(async (): Promise<EarlierLoad> => (lanes && !resources ? lanes.loadEarlier(target.toolCallId) : 'none'), [lanes, resources, target.toolCallId]);

  const now = useNow(live === true);
  const started = transcript?.events.map((event) => Date.parse(event.createdAt)).find((at) => Number.isFinite(at));
  const duration = live === true && started ? formatDuration(now - started) : transcript ? transcriptDuration(transcript.events) : undefined;

  /*
   * The page takes focus when it opens and gives it back when it closes. The opener is read during
   * the first render, before this commit hides the transcript it sits in; the return waits for the
   * passive cleanup, by which point that transcript is shown again. Focus the reader has since put
   * somewhere real is left there.
   */
  const backRef = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body)) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  const nested = useMemo<SubagentRenderer>(() => ({ open: onOpen }), [onOpen]);
  const fallback = call && call.view.contents.length ? <ToolContents view={call.view} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} root={root} /> : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 edge-b bg-bg px-1.5 md:px-3">
        <Tip label={parent ? t`返回上一级子 Agent` : t`返回主会话`}>
          <Button ref={backRef} size="icon-sm" variant="quiet" aria-label={parent ? t`返回上一级子 Agent` : t`返回主会话`} className="shrink-0 max-md:size-11" onClick={onBack}><IconArrowLeft className="size-4" /></Button>
        </Tip>
        <button type="button" onClick={onClose} className="hidden min-w-0 max-w-[30%] shrink truncate rounded-md px-1 text-sm text-fg-3 hover:text-fg-2 sm:block">{sessionTitle}</button>
        {stack.length > 2 && <><IconChevronRight className="hidden size-3.5 shrink-0 text-fg-4 sm:block" /><span className="hidden text-sm text-fg-4 sm:block">…</span></>}
        {parentTitle && <><IconChevronRight className="hidden size-3.5 shrink-0 text-fg-4 sm:block" /><button type="button" onClick={onBack} className="hidden min-w-0 max-w-[25%] shrink truncate rounded-md px-1 text-sm text-fg-3 hover:text-fg-2 sm:block">{parentTitle}</button></>}
        <IconChevronRight className="hidden size-3.5 shrink-0 text-fg-4 sm:block" />
        <span className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <IconBot className="size-4 shrink-0 text-fg-3" />
          <span className="min-w-0 truncate text-sm font-medium text-fg">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 pl-2 text-xs text-fg-3">
          {type && <span className="hidden md:inline">{type}</span>}
          {(transcript?.model || call?.model) && <span className="hidden lg:inline">{transcript?.model || call?.model}</span>}
          {duration && <span className="tabular-nums">{duration}</span>}
          <span className="flex items-center gap-1.5"><StatusDot tone={live === true ? 'accent' : transcript?.status === 'failed' ? 'danger' : live === false ? 'success' : 'idle'} pulse={live === true} />{live === true ? <Trans>运行中</Trans> : transcript?.status === 'failed' ? <Trans>失败</Trans> : live === false ? <Trans>已结束</Trans> : <Trans>同步中</Trans>}</span>
        </span>
        {pendingConfirmation && <Tip label={t`返回主会话`}>
          <Button size="xs" variant="quiet" className="shrink-0 gap-1.5 text-warning" onClick={onClose}>
            <StatusDot tone="warning" /><Trans context="terminal-awaiting-confirmation">等待确认</Trans>
          </Button>
        </Tip>}
      </div>
      <SubagentContext.Provider value={nested}>
        <TranscriptView
          sessionId={`${sessionId}:subagent:${target.toolCallId}`}
          timeline={timeline}
          timelineVersion={events.length}
          resetVersion={transcript?.resetVersion ?? 0}
          loaded={lanes ? Boolean(transcript?.synced) : Boolean(transcript) || live === false}
          running={live === true}
          progress={live === true && timeline.length > 0 && !showsRunningCompaction(timeline) ? <WorkingIndicator /> : undefined}
          activeTurnId={transcript?.activeTurnId}
          root={root}
          onOpenPath={onOpenPath}
          onOpenInEditor={onOpenInEditor}
          hasMoreHistory={Boolean(lanes && transcript?.history?.hasMore)}
          completedProcessesOpen
          loadingEarlier={Boolean(transcript?.loadingEarlier)}
          onLoadEarlier={loadEarlier}
          empty={(
            <div className="flex flex-col gap-3 py-16">
              <p className="text-sm text-fg-3">{transcript?.loadingEarlier && transcript.history?.hasMore ? <Trans>正在补充子 Agent 历史…</Trans> : transcript ? (live === true ? <Trans>子 Agent 正在启动…</Trans> : <Trans>这个子 Agent 没有记录。</Trans>) : <Trans>没有读到这个子 Agent 的执行记录。</Trans>}</p>
              {!transcript && fallback}
            </div>
          )}
        />
      </SubagentContext.Provider>
    </div>
  );
}
