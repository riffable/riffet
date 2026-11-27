import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type {
  ModelChatConfig,
  ModelChatNode,
  ModelChatTokenBreakdown,
  ModelInfo,
  UserAttachment,
} from '@contracts';
import {
  AssistantMessage,
  StatusRow,
  ThoughtRow,
  TopicDivider,
  UserMessage,
  WorkingIndicator,
} from '@/app/session/Timeline';
import { ContentColumn } from '@/app/session/sessionLayout';
import {
  COLUMN_GUTTER_TOTAL,
  ContentWidthHandle,
  WIDTH_HANDLE_GAP,
  WIDTH_HANDLE_WIDTH,
} from '@/app/session/ContentWidthHandle';
import { MarkLayer } from '@/app/session/MarkLayer';
import type { MarkTarget } from '@/app/session/marks';
import { compactTokens } from '@/app/session/ComposerPickers';
import { formatTokensPerSecond, tokensPerSecond } from '@/app/session/speed';
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconColumns2,
  IconFileCode2,
  IconPencilLine,
  IconPin,
  IconPinOff,
  IconRotateCw,
  IconSlash,
  IconSquare,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, Textarea } from '@/components/ui/controls';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import {
  DEFAULT_CONTENT_WIDTH,
  MAX_CONTENT_WIDTH,
  discardContentWidthPreview,
  previewContentWidth,
  resetContentWidth,
  setContentWidth,
} from '@/lib/content-width';
import { parseSelection } from '@/lib/models';
import { cn } from '@/lib/utils';
import {
  type ModelChatBranchAnswer,
  type ModelChatTurnView,
  type ModelChatUserNode,
  assistantRunMetrics,
  cacheHitPercent,
  latestLeafOf,
  resolveModelLabel,
} from './tree';

export type InspectorTab = 'params' | 'context' | 'wire';

export interface ModelChatTranscriptProps {
  title: string;
  nodes: readonly ModelChatNode[];
  turns: readonly ModelChatTurnView[];
  config: ModelChatConfig;
  summary: string;
  tokenBreakdown: ModelChatTokenBreakdown;
  models: readonly ModelInfo[] | undefined;
  connected: boolean;
  readOnly?: boolean;
  running?: boolean;
  starting?: boolean;
  onQuote?: (quote: string) => void;
  onSelectBranch: (leafId: string) => void;
  onForkUser: (userNode: ModelChatUserNode, nextText: string) => Promise<void> | void;
  onRegenerate: (userNode: ModelChatUserNode, modelSelection?: string) => Promise<void> | void;
  onCompareWithModel: (turn: ModelChatTurnView, modelSelection: string) => Promise<void> | void;
  onEditAssistant: (assistantId: string, text: string) => Promise<void> | void;
  onStopAssistant: (assistantId: string) => void;
  onSetTurnFlags: (userId: string, flags: { pinned?: boolean; muted?: boolean }) => void;
  onOpenInspector: (tab: InspectorTab, wireAssistantId?: string) => void;
}

function toUserAttachments(node: ModelChatUserNode): UserAttachment[] {
  if (!node.attachments?.length) return [];
  return node.attachments.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.mimeType.startsWith('image/') ? 'image' : 'file',
    mimeType: item.mimeType,
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
  }));
}

function formatTtft(ms: number | null | undefined): string | undefined {
  if (typeof ms !== 'number' || !(ms > 0)) return undefined;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function toStartedAtMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function BranchPager({
  index,
  total,
  onPrev,
  onNext,
}: {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useLingui();
  if (total <= 1) return null;
  return (
    <span className="inline-flex items-center gap-0.5 rounded-md bg-subtle px-1 py-0.5 text-2xs tabular-nums text-fg-2">
      <button
        type="button"
        disabled={index <= 0}
        onClick={onPrev}
        aria-label={t`上一个分支`}
        className="grid size-6 max-md:size-9 place-items-center rounded text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-35"
      >
        <IconArrowLeft aria-hidden className="size-3" />
      </button>
      <span className="px-1">{index + 1} / {total}</span>
      <button
        type="button"
        disabled={index >= total - 1}
        onClick={onNext}
        aria-label={t`下一个分支`}
        className="grid size-6 max-md:size-9 place-items-center rounded text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-35"
      >
        <IconArrowRight aria-hidden className="size-3" />
      </button>
    </span>
  );
}

function ContextBoundaryDivider({
  label,
  actionLabel,
  onAction,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-1 text-2xs text-fg-3 select-none">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <div className="inline-flex items-center gap-2 px-1">
        <span>{label}</span>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="text-accent underline decoration-line-strong underline-offset-3 transition-colors hover:decoration-accent"
          >
            {actionLabel}
          </button>
        )}
      </div>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

const CompareCard = memo(function CompareCard({
  answer,
  selected,
  modelLabel,
  connected,
  readOnly = false,
  onSelectAndCollapse,
  onStop,
  onOpenWire,
}: {
  answer: ModelChatBranchAnswer;
  selected: boolean;
  modelLabel: string;
  connected: boolean;
  readOnly?: boolean;
  onSelectAndCollapse: () => void;
  onStop: () => void;
  onOpenWire: () => void;
}) {
  const { t } = useLingui();
  const ttft = formatTtft(answer.metrics?.ttftMs);
  const runMetrics = useMemo(() => assistantRunMetrics(answer.metrics), [answer.metrics]);
  const rate = runMetrics ? tokensPerSecond(runMetrics) : undefined;
  const speed = rate !== undefined ? formatTokensPerSecond(rate) : undefined;
  const startedAtMs = useMemo(() => toStartedAtMs(answer.at), [answer.at]);
  const mark = useMemo<MarkTarget | undefined>(
    () => (answer.streaming
      ? undefined
      : {
          ids: [answer.id],
          anchor: {
            messageId: answer.id,
            ...(answer.runId ? { runId: answer.runId } : {}),
          },
          text: answer.text,
          at: answer.at,
        }),
    [answer.at, answer.id, answer.runId, answer.streaming, answer.text],
  );
  const isStopped = answer.status === 'cancelled' || answer.status === 'interrupted';

  return (
    <article
      className={cn(
        'flex min-w-0 flex-col rounded-xl transition-colors',
        selected ? 'bg-bg ring-1 ring-inset ring-primary' : 'bg-subtle',
      )}
    >
      <header className="flex items-center justify-between gap-2 edge-b px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium text-fg">{modelLabel || t`默认模型`}</span>
          {selected && (
            <Badge tone="accent">
              <Trans>当前主线</Trans>
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-2xs tabular-nums text-fg-3">
          {ttft && <span>TTFT {ttft}</span>}
          {speed && <span>{speed}</span>}
          {answer.streaming ? (
            <Tip label={t`停止此路输出`}>
              <Button
                variant="danger-ghost"
                size="icon-xs"
                aria-label={t`停止此路输出`}
                onClick={onStop}
              >
                <IconSquare aria-hidden className="size-3 fill-current" />
              </Button>
            </Tip>
          ) : answer.hasWire ? (
            <Tip label={t`查看 Wire 请求`}>
              <Button
                variant="quiet"
                size="icon-xs"
                aria-label={t`查看 Wire 请求`}
                onClick={onOpenWire}
              >
                <IconFileCode2 aria-hidden className="size-3.5" />
              </Button>
            </Tip>
          ) : null}
        </div>
      </header>

      <div className="flex min-w-0 flex-1 flex-col gap-3 px-4 py-3">
        {answer.reasoning && (
          <ThoughtRow
            text={answer.reasoning}
            channel="thinking"
            running={answer.streaming && !answer.text}
          />
        )}
        {answer.streaming && !answer.text && !answer.reasoning ? (
          <WorkingIndicator startedAt={startedAtMs} connected={connected} />
        ) : (
          <AssistantMessage
            text={answer.text}
            streaming={answer.streaming}
            stopped={isStopped}
            showActions={!answer.streaming}
            time={answer.streaming ? undefined : answer.at}
            modelLabel={modelLabel}
            metrics={runMetrics}
            runId={answer.runId}
            mark={mark}
            progress={answer.streaming ? <WorkingIndicator startedAt={startedAtMs} connected={connected} /> : undefined}
          />
        )}
        {answer.status === 'failed' && answer.error && (
          <StatusRow tone="danger" text={answer.error} />
        )}
      </div>

      {!readOnly && (
        <footer className="flex items-center justify-end gap-2 edge-t px-3.5 py-2">
          <Button
            variant={selected ? 'primary' : 'secondary'}
            size="xs"
            disabled={answer.streaming}
            onClick={onSelectAndCollapse}
          >
            <IconCheck aria-hidden className="size-3.5" />
            {selected ? <Trans>收束为此分支</Trans> : <Trans>沿此分支继续</Trans>}
          </Button>
        </footer>
      )}
    </article>
  );
});

const TurnRow = memo(function TurnRow({
  turn,
  nodes,
  models,
  connected,
  readOnly = false,
  running = false,
  compareExpanded,
  onToggleCompareExpanded,
  onSelectBranch,
  onForkUser,
  onRegenerate,
  onCompareWithModel,
  onEditAssistant,
  onStopAssistant,
  onSetTurnFlags,
  onOpenInspector,
}: {
  turn: ModelChatTurnView;
  nodes: readonly ModelChatNode[];
  models: readonly ModelInfo[] | undefined;
  connected: boolean;
  readOnly?: boolean;
  running?: boolean;
  compareExpanded: boolean;
  onToggleCompareExpanded: (groupId: string, expanded: boolean) => void;
  onSelectBranch: (leafId: string) => void;
  onForkUser: (userNode: ModelChatUserNode, nextText: string) => Promise<void> | void;
  onRegenerate: (userNode: ModelChatUserNode, modelSelection?: string) => Promise<void> | void;
  onCompareWithModel: (turn: ModelChatTurnView, modelSelection: string) => Promise<void> | void;
  onEditAssistant: (assistantId: string, text: string) => Promise<void> | void;
  onStopAssistant: (assistantId: string) => void;
  onSetTurnFlags: (userId: string, flags: { pinned?: boolean; muted?: boolean }) => void;
  onOpenInspector: (tab: InspectorTab, wireAssistantId?: string) => void;
}) {
  const { t } = useLingui();
  const [editingUser, setEditingUser] = useState(false);
  const [userDraft, setUserDraft] = useState(turn.userNode.text);
  const [submittingUser, setSubmittingUser] = useState(false);

  const [editingAssistantId, setEditingAssistantId] = useState<string>();
  const [assistantDraft, setAssistantDraft] = useState('');
  const [savingAssistant, setSavingAssistant] = useState(false);

  useEffect(() => {
    if (readOnly) {
      setEditingUser(false);
      setEditingAssistantId(undefined);
    }
  }, [readOnly]);

  const attachments = useMemo(() => toUserAttachments(turn.userNode), [turn.userNode]);
  const activeAnswer = turn.activeAssistant;
  const activeRunMetrics = useMemo(() => assistantRunMetrics(activeAnswer?.metrics), [activeAnswer?.metrics]);
  const activeModelLabel = useMemo(
    () => resolveModelLabel(activeAnswer?.modelSelection ?? activeAnswer?.model, models),
    [activeAnswer?.model, activeAnswer?.modelSelection, models],
  );
  const activeStartedAtMs = useMemo(
    () => (activeAnswer ? toStartedAtMs(activeAnswer.at) : Date.now()),
    [activeAnswer],
  );
  const activeMark = useMemo<MarkTarget | undefined>(
    () => (activeAnswer && !activeAnswer.streaming
      ? {
          ids: [activeAnswer.id],
          anchor: {
            messageId: activeAnswer.id,
            ...(activeAnswer.runId ? { runId: activeAnswer.runId } : {}),
          },
          text: activeAnswer.text,
          at: activeAnswer.at,
        }
      : undefined),
    [activeAnswer],
  );

  const startEditUser = () => {
    if (readOnly || running) return;
    setUserDraft(turn.userNode.text);
    setEditingUser(true);
  };

  const submitEditUser = async () => {
    const trimmed = userDraft.trim();
    if (!trimmed || readOnly || running) return;
    setSubmittingUser(true);
    try {
      await onForkUser(turn.userNode, trimmed);
      setEditingUser(false);
    } finally {
      setSubmittingUser(false);
    }
  };

  const startEditAssistant = (answer: ModelChatBranchAnswer) => {
    if (readOnly) return;
    setAssistantDraft(answer.text);
    setEditingAssistantId(answer.id);
  };

  const submitEditAssistant = async () => {
    if (!editingAssistantId || readOnly) return;
    setSavingAssistant(true);
    try {
      await onEditAssistant(editingAssistantId, assistantDraft);
      setEditingAssistantId(undefined);
    } finally {
      setSavingAssistant(false);
    }
  };

  const switchUserSibling = (delta: number) => {
    const next = turn.userSiblings[turn.userIndex + delta];
    if (next) onSelectBranch(latestLeafOf(next.id, nodes));
  };

  const switchAssistantSibling = (delta: number) => {
    const next = turn.assistantSiblings[turn.assistantIndex + delta];
    if (next) onSelectBranch(latestLeafOf(next.id, nodes));
  };

  const comparableModels = useMemo(() => {
    if (!models?.length) return [];
    const existing = new Set(
      turn.assistantSiblings
        .map((item) => parseSelection(item.modelSelection ?? item.model).model)
        .filter(Boolean),
    );
    return models.filter((item) => !existing.has(parseSelection(item.value).model)).slice(0, 12);
  }, [models, turn.assistantSiblings]);

  const userMetaSlot = (
    <span className="inline-flex items-center gap-1.5">
      <BranchPager
        index={turn.userIndex}
        total={turn.userSiblings.length}
        onPrev={() => switchUserSibling(-1)}
        onNext={() => switchUserSibling(1)}
      />
      {turn.userNode.pinned && (
        <Badge tone="accent">
          <Trans>已钉住</Trans>
        </Badge>
      )}
      {turn.userNode.muted && (
        <Badge tone="neutral">
          <Trans>不入上下文</Trans>
        </Badge>
      )}
      {!readOnly && (
        <Tip label={t`编辑并分叉`}>
          <button
            type="button"
            disabled={running}
            onClick={startEditUser}
            aria-label={t`编辑并分叉`}
            className="grid size-6 max-md:size-9 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-35"
          >
            <IconPencilLine aria-hidden className="size-3.5" />
          </button>
        </Tip>
      )}
    </span>
  );

  const ttft = formatTtft(activeAnswer?.metrics?.ttftMs);
  const cachePct = cacheHitPercent(activeAnswer?.metrics);
  const metricsExtra = (ttft || cachePct !== undefined) ? (
    <span className="inline-flex items-center gap-2 tabular-nums text-fg-3">
      {ttft && <span>TTFT {ttft}</span>}
      {cachePct !== undefined && <span>{t`缓存命中 ${cachePct}%`}</span>}
    </span>
  ) : undefined;

  const showCompareGrid = turn.isCompareCandidate && Boolean(turn.compareGroupId) && compareExpanded;
  const activeIsStopped = activeAnswer?.status === 'cancelled' || activeAnswer?.status === 'interrupted';

  const assistantLeadingSlot = activeAnswer ? (
    <span className="inline-flex items-center gap-1.5">
      <BranchPager
        index={turn.assistantIndex}
        total={turn.assistantSiblings.length}
        onPrev={() => switchAssistantSibling(-1)}
        onNext={() => switchAssistantSibling(1)}
      />
      {activeAnswer.edited && (
        <Badge tone="neutral">
          <Trans>已编辑</Trans>
        </Badge>
      )}
      {turn.isCompareCandidate && turn.compareGroupId && !compareExpanded && (
        <Button
          variant="quiet"
          size="xs"
          onClick={() => onToggleCompareExpanded(turn.compareGroupId!, true)}
        >
          <IconColumns2 aria-hidden className="size-3.5" />
          <Trans>展开对比 ({turn.compareAnswers.length})</Trans>
        </Button>
      )}
    </span>
  ) : undefined;

  const assistantExtraActions = activeAnswer && !activeAnswer.streaming ? (
    <>
      {!readOnly && (
        <>
          <Tip label={t`重新生成`}>
            <button
              type="button"
              disabled={running}
              aria-label={t`重新生成`}
              onClick={() => void onRegenerate(turn.userNode, activeAnswer.modelSelection ?? activeAnswer.model)}
              className="grid size-6 max-md:size-9 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-35"
            >
              <IconRotateCw aria-hidden className="size-3.5" />
            </button>
          </Tip>

          {comparableModels.length > 0 && (
            <DropdownMenu>
              <Tip label={t`换模型对比`}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={running}
                    aria-label={t`换模型对比`}
                    className="grid size-6 max-md:size-9 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-35"
                  >
                    <IconColumns2 aria-hidden className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                <DropdownMenuLabel>
                  <Trans>同轮新增模型对比</Trans>
                </DropdownMenuLabel>
                {comparableModels.map((model) => (
                  <DropdownMenuItem
                    key={model.value}
                    disabled={running}
                    onSelect={() => {
                      if (turn.compareGroupId) onToggleCompareExpanded(turn.compareGroupId, true);
                      void onCompareWithModel(turn, model.value);
                    }}
                  >
                    <span className="truncate">{resolveModelLabel(model.value, models)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Tip label={t`编辑回复`}>
            <button
              type="button"
              aria-label={t`编辑回复`}
              onClick={() => startEditAssistant(activeAnswer)}
              className="grid size-6 max-md:size-9 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg"
            >
              <IconPencilLine aria-hidden className="size-3.5" />
            </button>
          </Tip>

          <Tip label={turn.userNode.pinned ? t`取消钉住本轮` : t`钉住本轮`}>
            <button
              type="button"
              aria-label={turn.userNode.pinned ? t`取消钉住本轮` : t`钉住本轮`}
              onClick={() => onSetTurnFlags(turn.userNode.id, { pinned: !turn.userNode.pinned })}
              className={cn(
                'grid size-6 max-md:size-9 place-items-center rounded-md transition-colors hover:bg-hover',
                turn.userNode.pinned ? 'text-accent' : 'text-fg-3 hover:text-fg',
              )}
            >
              {turn.userNode.pinned
                ? <IconPinOff aria-hidden className="size-3.5" />
                : <IconPin aria-hidden className="size-3.5" />}
            </button>
          </Tip>

          <Tip label={turn.userNode.muted ? t`恢复纳入上下文` : t`移出上下文`}>
            <button
              type="button"
              aria-label={turn.userNode.muted ? t`恢复纳入上下文` : t`移出上下文`}
              onClick={() => onSetTurnFlags(turn.userNode.id, { muted: !turn.userNode.muted })}
              className={cn(
                'grid size-6 max-md:size-9 place-items-center rounded-md transition-colors hover:bg-hover',
                turn.userNode.muted ? 'text-warning' : 'text-fg-3 hover:text-fg',
              )}
            >
              <IconSlash aria-hidden className="size-3.5" />
            </button>
          </Tip>
        </>
      )}

      <Tip label={t`查看 Wire 报文`}>
        <button
          type="button"
          aria-label={t`查看 Wire 报文`}
          onClick={() => onOpenInspector('wire', activeAnswer.id)}
          className="grid size-6 max-md:size-9 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <IconFileCode2 aria-hidden className="size-3.5" />
        </button>
      </Tip>
    </>
  ) : undefined;

  return (
    <section className="flex flex-col gap-5">
      {turn.clearedBefore && <TopicDivider time={turn.clearedBefore.at} />}

      {editingUser ? (
        <div className="ml-auto flex w-full max-w-xl flex-col gap-2 rounded-xl border border-line bg-subtle p-3">
          <Textarea
            value={userDraft}
            onChange={(event) => setUserDraft(event.target.value)}
            rows={4}
            aria-label={t`编辑用户消息`}
            className="bg-bg"
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="xs"
              disabled={submittingUser}
              onClick={() => setEditingUser(false)}
            >
              <Trans>取消</Trans>
            </Button>
            <Button
              variant="primary"
              size="xs"
              busy={submittingUser}
              disabled={!userDraft.trim() || readOnly || running}
              onClick={() => void submitEditUser()}
            >
              <Trans>保存并分叉重跑</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <UserMessage
          text={turn.userNode.text}
          attachments={attachments}
          time={turn.userNode.at}
          dimmed={Boolean(turn.userNode.muted)}
          footerPinned={turn.userSiblings.length > 1 || Boolean(turn.userNode.pinned || turn.userNode.muted)}
          metaSlot={userMetaSlot}
        />
      )}

      {showCompareGrid ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2 text-xs text-fg-3">
            <span className="inline-flex items-center gap-1.5">
              <IconColumns2 aria-hidden className="size-3.5" />
              <Trans>多模型并排对比 · {turn.compareAnswers.length} 路回答</Trans>
            </span>
            {turn.compareGroupId && (
              <Button
                variant="quiet"
                size="xs"
                onClick={() => onToggleCompareExpanded(turn.compareGroupId!, false)}
              >
                <Trans>收起对比</Trans>
              </Button>
            )}
          </div>

          <div
            className={cn(
              'grid grid-cols-1 gap-3',
              turn.compareAnswers.length >= 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-2',
            )}
          >
            {turn.compareAnswers.map((answer) => (
              <CompareCard
                key={answer.id}
                answer={answer}
                selected={activeAnswer?.id === answer.id}
                modelLabel={resolveModelLabel(answer.modelSelection ?? answer.model, models)}
                connected={connected}
                readOnly={readOnly}
                onSelectAndCollapse={() => {
                  onSelectBranch(latestLeafOf(answer.id, nodes));
                  if (turn.compareGroupId) onToggleCompareExpanded(turn.compareGroupId, false);
                }}
                onStop={() => onStopAssistant(answer.id)}
                onOpenWire={() => onOpenInspector('wire', answer.id)}
              />
            ))}
          </div>
        </div>
      ) : activeAnswer ? (
        <div className={cn('flex flex-col gap-3', turn.userNode.muted && 'opacity-50 transition-opacity')}>
          {activeAnswer.reasoning && (
            <ThoughtRow
              text={activeAnswer.reasoning}
              channel="thinking"
              running={activeAnswer.streaming && !activeAnswer.text}
            />
          )}

          {editingAssistantId === activeAnswer.id ? (
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-subtle p-3">
              <Textarea
                value={assistantDraft}
                onChange={(event) => setAssistantDraft(event.target.value)}
                rows={6}
                aria-label={t`编辑助手回复`}
                className="bg-bg"
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={savingAssistant}
                  onClick={() => setEditingAssistantId(undefined)}
                >
                  <Trans>取消</Trans>
                </Button>
                <Button
                  variant="primary"
                  size="xs"
                  busy={savingAssistant}
                  onClick={() => void submitEditAssistant()}
                >
                  <Trans>保存修改</Trans>
                </Button>
              </div>
            </div>
          ) : activeAnswer.streaming && !activeAnswer.text && !activeAnswer.reasoning ? (
            <WorkingIndicator startedAt={activeStartedAtMs} connected={connected} />
          ) : (
            <AssistantMessage
              text={activeAnswer.text}
              streaming={activeAnswer.streaming}
              stopped={activeIsStopped}
              showActions={!activeAnswer.streaming}
              time={activeAnswer.streaming ? undefined : activeAnswer.at}
              modelLabel={activeModelLabel}
              metrics={activeRunMetrics}
              runId={activeAnswer.runId}
              mark={activeMark}
              footerPinned={turn.assistantSiblings.length > 1 || Boolean(activeAnswer.edited)}
              leadingSlot={assistantLeadingSlot}
              extraActions={assistantExtraActions}
              metricsExtra={metricsExtra}
              progress={activeAnswer.streaming ? <WorkingIndicator startedAt={activeStartedAtMs} connected={connected} /> : undefined}
            />
          )}

          {activeAnswer.status === 'failed' && activeAnswer.error && (
            <StatusRow tone="danger" text={activeAnswer.error} />
          )}
        </div>
      ) : null}
    </section>
  );
});

export function ModelChatTranscript({
  title,
  nodes,
  turns,
  config,
  summary,
  tokenBreakdown,
  models,
  connected,
  readOnly = false,
  running = false,
  starting = false,
  onQuote,
  onSelectBranch,
  onForkUser,
  onRegenerate,
  onCompareWithModel,
  onEditAssistant,
  onStopAssistant,
  onSetTurnFlags,
  onOpenInspector,
}: ModelChatTranscriptProps) {
  const { t } = useLingui();
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const columnWidthRef = useRef(DEFAULT_CONTENT_WIDTH);
  const stickToBottomRef = useRef(true);
  const [handleLeft, setHandleLeft] = useState<number | null>(null);

  // Track user-collapsed compare groups by groupId. Groups default to expanded.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const handleToggleCompare = useCallback((groupId: string, expanded: boolean) => {
    setCollapsedGroups((current) => ({ ...current, [groupId]: !expanded }));
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  const lastTurn = turns[turns.length - 1];
  const compareSignal = lastTurn?.compareAnswers.reduce(
    (sum, item) => sum + item.text.length + (item.reasoning?.length ?? 0),
    0,
  ) ?? 0;
  const scrollSignal = `${turns.length}:${lastTurn?.activeAssistant?.id ?? ''}:${lastTurn?.activeAssistant?.text.length ?? 0}:${lastTurn?.activeAssistant?.reasoning?.length ?? 0}:${compareSignal}`;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollSignal]);

  useEffect(() => {
    const frame = frameRef.current;
    const column = columnRef.current;
    if (!frame || !column) return;
    const measure = () => {
      const frameRect = frame.getBoundingClientRect();
      const colRect = column.getBoundingClientRect();
      columnWidthRef.current = Math.round(colRect.width);
      const left = Math.round(colRect.left - frameRect.left - WIDTH_HANDLE_GAP - WIDTH_HANDLE_WIDTH);
      setHandleLeft(left >= 0 ? left : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  const widthCeiling = () => {
    const frameWidth = frameRef.current?.clientWidth ?? MAX_CONTENT_WIDTH;
    return Math.min(MAX_CONTENT_WIDTH, Math.max(DEFAULT_CONTENT_WIDTH, frameWidth - COLUMN_GUTTER_TOTAL));
  };

  return (
    <div ref={frameRef} className="relative flex min-h-0 flex-1 flex-col bg-bg">
      <div ref={scrollRef} onScroll={handleScroll} className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <ContentColumn className="relative pb-4 pt-6 md:pt-8">
          <div ref={columnRef} className="relative flex flex-col gap-6">
            {config.contextStrategy === 'summary' && summary.trim().length > 0 && (
              <ContextBoundaryDivider
                label={t`已启用摘要 · ${compactTokens(tokenBreakdown.summaryTokens)} tok`}
                actionLabel={t`查看摘要`}
                onAction={() => onOpenInspector('context')}
              />
            )}

            <div className="relative flex flex-col gap-10">
              {turns.length === 0 ? (
                starting ? (
                  <div className="flex flex-col items-center gap-3 py-24 text-center">
                    <WorkingIndicator connected={connected} />
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-24 text-center">
                    <p className="text-xl font-medium text-fg">{title}</p>
                  </div>
                )
              ) : (
                turns.map((turn) => (
                  <div key={turn.id} className="flex flex-col gap-6">
                    <TurnRow
                      turn={turn}
                      nodes={nodes}
                      models={models}
                      connected={connected}
                      readOnly={readOnly}
                      running={running}
                      compareExpanded={turn.compareGroupId ? !collapsedGroups[turn.compareGroupId] : false}
                      onToggleCompareExpanded={handleToggleCompare}
                      onSelectBranch={onSelectBranch}
                      onForkUser={onForkUser}
                      onRegenerate={onRegenerate}
                      onCompareWithModel={onCompareWithModel}
                      onEditAssistant={onEditAssistant}
                      onStopAssistant={onStopAssistant}
                      onSetTurnFlags={onSetTurnFlags}
                      onOpenInspector={onOpenInspector}
                    />
                  </div>
                ))
              )}
              {turns.length > 0 && config.contextStrategy === 'stateless' && (
                <ContextBoundaryDivider label={t`Stateless · 下一轮不携带上文`} />
              )}
            </div>
          </div>
        </ContentColumn>
      </div>

      <ContentWidthHandle
        left={handleLeft}
        onStart={() => columnWidthRef.current}
        onDrag={(next) => previewContentWidth(Math.min(next, widthCeiling()))}
        onCommit={(next) => setContentWidth(Math.min(next, widthCeiling()))}
        onCancel={discardContentWidthPreview}
        onReset={resetContentWidth}
      />

      <MarkLayer scrollRef={scrollRef} onQuote={onQuote} />
    </div>
  );
}
