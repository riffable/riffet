import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useLingui } from '@lingui/react/macro';
import type {
  Attachment,
  ModelChatPinnedDoc,
  ModelChatTokenBreakdown,
  ModelInfo,
  NativeBackendCatalogEntry,
  Session,
} from '@contracts';
import { MODEL_CHAT_BUDGET, MODEL_CHAT_DEFAULT_CONFIG } from '@contracts';
import type { HeaderSlots } from '@/app/Header';
import type { CustomPanelChrome } from '@/app/WorkbenchPanels';
import { useStores } from '@/app/state/stores';
import { ShareSessionContext, shareModelName, type ShareSession } from '@/app/marks/ShareImage';
import { Composer } from '@/app/session/Composer';
import { useComposerQuotes } from '@/app/session/composerQuotes';
import { SessionMarksContext, SessionMarksSection, useSessionMarks } from '@/app/session/marks';
import { MessageCommandsContext } from '@/app/session/messageCommands';
import type { Choice, ContextUsage } from '@/app/session/model';
import { ContentColumn } from '@/app/session/sessionLayout';
import {
  IconArrowUpRight,
  IconColumns2,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Notice } from '@/components/ui/notice';
import { Tip } from '@/components/ui/tooltip';
import { api, type PromptContextReference } from '@/lib/api';
import { parseSelection } from '@/lib/models';
import { cleanLabel, cn, errorMessage } from '@/lib/utils';
import { ModelChatInspector } from './ModelChatInspector';
import { ModelChatTranscript, type InspectorTab } from './ModelChatTranscript';
import {
  type ModelChatTurnView,
  type ModelChatUserNode,
  collectNonDefaultChips,
  inferModelProtocol,
  resolveModelChatTurns,
  resolveModelLabel,
} from './tree';
import { useModelChat } from './useModelChat';

export interface ModelChatSessionProps {
  session: Session;
  catalog?: NativeBackendCatalogEntry;
  catalogLoading?: boolean;
  catalogError?: string;
  onRetryCatalog?: () => void;
  onSessionChanged: (session: Session) => void;
  onPromoteToAgent: (draft: { prompt: string; title?: string; docs?: ModelChatPinnedDoc[] }) => void;
  onError: (message: string) => void;
  renderHeader: (slots: HeaderSlots) => ReactNode;
  enterBehavior?: string;
  panelSlot?: HTMLDivElement | null;
  panelChrome?: CustomPanelChrome;
}

function toModelChoices(models: readonly ModelInfo[] | undefined): Choice[] | undefined {
  if (!models?.length) return undefined;
  return models.map((item) => ({
    id: item.value,
    label: cleanLabel(item.name) || item.value,
  }));
}

export function ModelChatSession({
  session,
  catalog,
  catalogLoading,
  catalogError,
  onRetryCatalog,
  onSessionChanged,
  onPromoteToAgent,
  onError,
  renderHeader,
  enterBehavior,
  panelSlot,
  panelChrome,
}: ModelChatSessionProps) {
  const { t } = useLingui();
  const { ui } = useStores();
  const controller = useModelChat(session.id, onError);
  const { snapshot, loading, connected, loadError } = controller;
  const archived = Boolean(session.archivedAt);

  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('params');
  const [selectedWireId, setSelectedWireId] = useState<string>();
  const [references, setReferences] = useState<PromptContextReference[]>([]);
  const [primaryModel, setPrimaryModel] = useState(() => parseSelection(session.model).model || catalog?.models?.[0]?.value || '');
  const [compareModels, setCompareModels] = useState<string[]>([]);
  const [quote, setQuote] = useState<{ text: string; nonce: number }>();
  const quoteNonceRef = useRef(0);
  const primarySessionRef = useRef(session.id);

  const enqueueQuote = useCallback((text: string) => {
    quoteNonceRef.current += 1;
    setQuote({ text, nonce: quoteNonceRef.current });
  }, []);

  useComposerQuotes(session.id, enqueueQuote);

  useEffect(() => {
    setCompareModels([]);
    setSelectedWireId(undefined);
    setReferences([]);
    setQuote(undefined);
  }, [session.id]);

  useEffect(() => {
    if (primarySessionRef.current !== session.id) {
      primarySessionRef.current = session.id;
      setPrimaryModel(parseSelection(session.model).model || catalog?.models?.[0]?.value || '');
    }
  }, [session.id, session.model, catalog?.models]);

  useEffect(() => {
    const fallback = parseSelection(session.model).model || catalog?.models?.[0]?.value || '';
    if (!fallback) return;
    setPrimaryModel((current) => (current ? current : fallback));
  }, [session.model, catalog?.models]);

  const marks = useSessionMarks(session.id, undefined);

  const config = snapshot?.config ?? MODEL_CHAT_DEFAULT_CONFIG;
  const nodes = snapshot?.nodes ?? [];
  const pinnedDocs = snapshot?.pinnedDocs ?? [];
  const summary = snapshot?.summary ?? '';
  const liveStreams = snapshot?.liveStreams ?? [];
  const tokenBreakdown = useMemo<ModelChatTokenBreakdown>(() => (
    snapshot?.tokenBreakdown ?? {
      systemTokens: 0,
      pinnedDocsTokens: 0,
      summaryTokens: 0,
      historyTokens: 0,
      totalTokens: 0,
      budget: config.contextBudget,
      includedTurnIds: [],
      droppedTurnIds: [],
    }
  ), [snapshot?.tokenBreakdown, config.contextBudget]);

  const turns = useMemo(
    () => resolveModelChatTurns(nodes, snapshot?.activeLeafId, liveStreams),
    [nodes, snapshot?.activeLeafId, liveStreams],
  );

  const activeWireRecord = selectedWireId ? controller.wireCache[selectedWireId] : undefined;
  const activeWireAnswer = useMemo(() => {
    if (!selectedWireId) return undefined;
    for (const turn of turns) {
      const match = turn.assistantSiblings.find((item) => item.id === selectedWireId);
      if (match) return match;
    }
    return undefined;
  }, [selectedWireId, turns]);
  const protocol = useMemo(() => {
    const currentModel = parseSelection(primaryModel || session.model).model;
    const wireModel = activeWireAnswer
      ? parseSelection(activeWireAnswer.modelSelection ?? activeWireAnswer.model).model
      : '';
    const matchedProtocol = activeWireRecord?.protocol && wireModel && currentModel && wireModel === currentModel
      ? activeWireRecord.protocol
      : undefined;
    return inferModelProtocol(primaryModel || session.model, matchedProtocol);
  }, [primaryModel, session.model, activeWireRecord?.protocol, activeWireAnswer]);

  const modelChoices = useMemo(() => toModelChoices(catalog?.models), [catalog?.models]);
  const running = liveStreams.length > 0;
  const starting = session.state === 'starting' || session.state === 'running';

  const openInspector = useCallback((tab: InspectorTab, wireAssistantId?: string) => {
    if (wireAssistantId) setSelectedWireId(wireAssistantId);
    setInspectorTab(tab);
    ui.setPanelOpen(true);
  }, [ui]);

  const handlePrimaryModelChange = useCallback((nextModel: string) => {
    if (archived) return;
    setPrimaryModel(nextModel);
    setCompareModels((current) => (current.length > 0 && !current.includes(nextModel)
      ? [nextModel, ...current].slice(0, MODEL_CHAT_BUDGET.maxCompareModels)
      : current));
    if (nextModel && nextModel !== session.model) {
      void api.nativeSetModel(session.id, nextModel)
        .then((updated) => onSessionChanged(updated))
        .catch((error) => onError(errorMessage(error)));
    }
  }, [archived, session.id, session.model, onSessionChanged, onError]);

  const toggleCompareModel = useCallback((modelValue: string, checked: boolean) => {
    if (archived) return;
    setCompareModels((current) => {
      const base = current.length > 0 ? current : (primaryModel ? [primaryModel] : []);
      if (checked) {
        if (base.includes(modelValue)) return base;
        if (base.length >= MODEL_CHAT_BUDGET.maxCompareModels) return base;
        return [...base, modelValue];
      }
      const next = base.filter((item) => item !== modelValue);
      return next.length <= 1 ? [] : next;
    });
  }, [archived, primaryModel]);

  const effectiveSendModels = useMemo(() => {
    if (compareModels.length > 1) return compareModels;
    return primaryModel ? [primaryModel] : undefined;
  }, [compareModels, primaryModel]);

  const handleSubmit = useCallback(async (
    prompt: string,
    attachments: Attachment[],
  ): Promise<boolean> => {
    if (archived) return false;
    const trimmed = prompt.trim();
    if (!trimmed && attachments.length === 0) return false;
    const attachmentIds = attachments.map((item) => item.id).filter(Boolean);
    const result = await controller.send({
      text: trimmed,
      ...(snapshot?.activeLeafId ? { parentId: snapshot.activeLeafId } : {}),
      ...(effectiveSendModels ? { models: effectiveSendModels } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
    });
    return Boolean(result);
  }, [archived, controller, snapshot?.activeLeafId, effectiveSendModels]);

  const handleForkUser = useCallback(async (userNode: ModelChatUserNode, nextText: string) => {
    if (archived) return;
    await controller.send({
      text: nextText,
      ...(userNode.parentId ? { parentId: userNode.parentId } : {}),
      editedFrom: userNode.id,
      ...(effectiveSendModels ? { models: effectiveSendModels } : {}),
    });
  }, [archived, controller, effectiveSendModels]);

  const handleRegenerate = useCallback(async (userNode: ModelChatUserNode, modelSelection?: string) => {
    if (archived) return;
    const model = modelSelection || primaryModel;
    await controller.send({
      text: userNode.text,
      rerunUserId: userNode.id,
      ...(model ? { models: [model] } : {}),
    });
  }, [archived, controller, primaryModel]);

  const handleCompareWithModel = useCallback(async (turn: ModelChatTurnView, modelSelection: string) => {
    if (archived) return;
    await controller.send({
      text: turn.userNode.text,
      rerunUserId: turn.userNode.id,
      models: [modelSelection],
    });
  }, [archived, controller]);

  const handleSelectBranch = useCallback((leafId: string) => {
    void controller.selectBranch(leafId);
  }, [controller.selectBranch]);

  const handleStopAssistant = useCallback((assistantId: string) => {
    void controller.stop(assistantId);
  }, [controller.stop]);

  const handleStopAll = useCallback(() => {
    void controller.stop();
  }, [controller.stop]);

  const handleSetTurnFlags = useCallback((userId: string, flags: { pinned?: boolean; muted?: boolean }) => {
    void controller.setTurnFlags(userId, flags);
  }, [controller.setTurnFlags]);

  const handlePromote = useCallback(() => {
    const lines: string[] = [];
    if (summary.trim()) {
      lines.push(t`[历史摘要]`, summary.trim(), '');
    }
    for (const turn of turns) {
      if (turn.userNode.muted) continue;
      lines.push(`${t`用户`}: ${turn.userNode.text}`);
      if (turn.activeAssistant?.text) {
        lines.push(`${t`助手`}: ${turn.activeAssistant.text}`);
      }
      lines.push('');
    }
    const prompt = lines.join('\n').trim() || session.title;
    const enabledDocs = pinnedDocs.filter((doc) => doc.pinned);
    onPromoteToAgent({
      prompt,
      ...(session.title ? { title: session.title } : {}),
      ...(enabledDocs.length ? { docs: enabledDocs } : {}),
    });
  }, [summary, turns, pinnedDocs, session.title, onPromoteToAgent, t]);

  const usage = useMemo<ContextUsage | undefined>(() => {
    const size = tokenBreakdown.budget || config.contextBudget;
    if (!(size > 0)) return undefined;
    return {
      used: tokenBreakdown.totalTokens,
      size,
      breakdownEstimated: true,
      breakdown: [
        { id: 'system', label: t`System`, tokens: tokenBreakdown.systemTokens },
        { id: 'pinned', label: t`钉住材料`, tokens: tokenBreakdown.pinnedDocsTokens },
        { id: 'summary', label: t`摘要`, tokens: tokenBreakdown.summaryTokens },
        { id: 'turns', label: t`历史轮次`, tokens: tokenBreakdown.historyTokens },
      ].filter((item) => item.tokens > 0),
    };
  }, [tokenBreakdown, config.contextBudget, t]);

  const nonDefaultChips = useMemo(
    () => collectNonDefaultChips(config, protocol, {
      bareMode: 'Raw',
      stateless: 'Stateless',
      window: 'Window',
      full: 'Full',
      effortOff: 'Effort off',
      effortPrefix: 'Effort',
      webSearch: 'Web Search',
      fast: 'Fast',
      cacheOff: 'No Cache',
      jsonObject: 'JSON',
      jsonSchema: 'JSON Schema',
    }),
    [config, protocol],
  );

  const statusChips = useMemo(() => {
    const activeDocCount = pinnedDocs.filter((doc) => doc.pinned).length;
    if (nonDefaultChips.length === 0 && activeDocCount === 0) return undefined;
    return (
      <div className="flex flex-wrap items-center gap-1">
        {activeDocCount > 0 && (
          <button
            type="button"
            onClick={() => openInspector('context')}
            className="inline-flex h-6 items-center rounded-md bg-subtle px-2 text-2xs text-fg-2 transition-colors hover:bg-hover hover:text-fg"
          >
            {t`材料 ${activeDocCount}`}
          </button>
        )}
        {nonDefaultChips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            onClick={() => openInspector(chip.id === 'stateless' || chip.id === 'window' || chip.id === 'full' || chip.id === 'cache' ? 'context' : 'params')}
            className={cn(
              'inline-flex h-6 items-center rounded-md px-2 text-2xs transition-colors',
              chip.tone === 'warning'
                ? 'bg-warning-soft text-warning hover:opacity-90'
                : chip.tone === 'accent'
                  ? 'bg-accent-soft text-fg hover:opacity-90'
                  : 'bg-subtle text-fg-2 hover:bg-hover hover:text-fg',
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>
    );
  }, [nonDefaultChips, openInspector, pinnedDocs, t]);

  const primaryModelLabel = useMemo(
    () => resolveModelLabel(primaryModel || session.model, catalog?.models) || t`选择模型`,
    [primaryModel, session.model, catalog?.models, t],
  );

  const modelTrigger = useMemo(() => {
    const models = catalog?.models ?? [];
    const comparingCount = compareModels.length > 1 ? compareModels.length : 0;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-model-picker=""
            disabled={archived || (catalogLoading && models.length === 0)}
            className="inline-flex h-7 max-w-48 items-center gap-1.5 rounded-lg px-2 text-xs text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            {comparingCount > 0 ? (
              <>
                <IconColumns2 aria-hidden className="size-3.5 shrink-0 text-fg-3" />
                <span className="truncate">{t`对比 ${comparingCount} 个模型`}</span>
              </>
            ) : (
              <span className="truncate">{primaryModelLabel}</span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
          {catalogError && (
            <>
              <div className="flex flex-col gap-2 px-2 py-2 text-xs">
                <p className="break-words text-danger">{catalogError}</p>
                {onRetryCatalog && (
                  <Button variant="secondary" size="xs" onClick={onRetryCatalog} className="self-start">
                    <Trans>重试</Trans>
                  </Button>
                )}
              </div>
              {models.length > 0 && <DropdownMenuSeparator />}
            </>
          )}

          {models.length > 0 && (
            <>
              <DropdownMenuLabel>
                <Trans>模型</Trans>
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup value={primaryModel} onValueChange={handlePrimaryModelChange}>
                {models.map((model) => (
                  <DropdownMenuRadioItem key={model.value} value={model.value}>
                    <span className="truncate">{cleanLabel(model.name) || resolveModelLabel(model.value, models)}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          )}

          {models.length > 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                <Trans>并排对比（最多 {MODEL_CHAT_BUDGET.maxCompareModels} 个）</Trans>
              </DropdownMenuLabel>
              {models.map((model) => {
                const checked = compareModels.includes(model.value);
                const atLimit = !checked && compareModels.length >= MODEL_CHAT_BUDGET.maxCompareModels;
                return (
                  <DropdownMenuCheckboxItem
                    key={`cmp-${model.value}`}
                    checked={checked}
                    disabled={atLimit}
                    onCheckedChange={(next) => toggleCompareModel(model.value, Boolean(next))}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="truncate">{cleanLabel(model.name) || resolveModelLabel(model.value, models)}</span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }, [
    archived,
    catalog?.models,
    catalogError,
    catalogLoading,
    compareModels,
    handlePrimaryModelChange,
    onRetryCatalog,
    primaryModel,
    primaryModelLabel,
    t,
    toggleCompareModel,
  ]);

  const shareSession = useMemo<ShareSession>(() => ({
    title: session.title,
    turnBefore: (at) => {
      const matched = at
        ? [...turns].reverse().find((turn) => turn.userNode.at <= at)
        : turns[turns.length - 1];
      return {
        ...(matched ? { prompt: matched.userNode.text } : {}),
        model: shareModelName(matched?.activeAssistant?.modelSelection ?? primaryModel, catalog?.models),
      };
    },
  }), [session.title, turns, primaryModel, catalog?.models]);

  const messageCommands = useMemo(() => ({
    sessionId: session.id,
    openModelSettings: () => openInspector('params'),
  }), [session.id, openInspector]);

  const headerSlots = useMemo<HeaderSlots>(() => ({
    usage,
    info: <SessionMarksSection sessionId={session.id} />,
    status: running ? (
      <Tip label={t`运行中`}>
        <span role="status" aria-label={t`运行中`} className="flex">
          <Spinner className="size-3 text-accent" />
        </span>
      </Tip>
    ) : null,
    menu: [
      {
        id: 'promote-agent',
        icon: <IconArrowUpRight />,
        label: t`转为 Agent 任务`,
        onSelect: handlePromote,
      },
    ],
  }), [
    usage,
    session.id,
    running,
    handlePromote,
    t,
  ]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-x-clip">
      {renderHeader(headerSlots)}

      <SessionMarksContext.Provider value={marks}>
        <ShareSessionContext.Provider value={shareSession}>
          <MessageCommandsContext.Provider value={messageCommands}>
            {loading && !snapshot ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            ) : loadError && !snapshot ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <Notice
                  tone="danger"
                  action={(
                    <Button variant="secondary" size="xs" onClick={() => void controller.refresh()}>
                      <Trans>重试</Trans>
                    </Button>
                  )}
                >
                  <p className="font-medium"><Trans>无法加载模型对话</Trans></p>
                  <p className="mt-0.5 text-xs text-fg-2">{loadError}</p>
                </Notice>
              </div>
            ) : (
              <ModelChatTranscript
                title={session.title}
                nodes={nodes}
                turns={turns}
                config={config}
                summary={summary}
                tokenBreakdown={tokenBreakdown}
                models={catalog?.models}
                connected={connected}
                readOnly={archived}
                running={running}
                starting={starting}
                onQuote={enqueueQuote}
                onSelectBranch={handleSelectBranch}
                onForkUser={handleForkUser}
                onRegenerate={handleRegenerate}
                onCompareWithModel={handleCompareWithModel}
                onEditAssistant={controller.editAssistant}
                onStopAssistant={handleStopAssistant}
                onSetTurnFlags={handleSetTurnFlags}
                onOpenInspector={openInspector}
              />
            )}
          </MessageCommandsContext.Provider>
        </ShareSessionContext.Provider>
      </SessionMarksContext.Provider>

      <ContentColumn outside className="relative flex flex-col gap-2 pb-3 md:pb-5">
        <Composer
          projectId={session.projectId}
          draftKey={`model-chat:${session.id}`}
          disabled={archived}
          submitDisabled={running || archived}
          placeholder={archived ? t`会话已归档` : undefined}
          models={modelChoices}
          modelsLoading={catalogLoading}
          modelsError={catalogError}
          onRetryModels={onRetryCatalog}
          model={primaryModel}
          onModelChange={handlePrimaryModelChange}
          modelTrigger={modelTrigger}
          statusChips={statusChips}
          usage={usage}
          running={running}
          onStop={handleStopAll}
          onSubmit={handleSubmit}
          onError={onError}
          attachmentsAllowed
          references={references}
          onReferencesChange={setReferences}
          referencesEnabled={false}
          fileMentions={false}
          sessionMentions={false}
          enterBehavior={enterBehavior}
          quote={quote}
        />
      </ContentColumn>

      {panelSlot && createPortal(
        <ModelChatInspector
          tab={inspectorTab}
          onTabChange={setInspectorTab}
          chrome={panelChrome}
          readOnly={archived}
          config={config}
          protocol={protocol}
          pinnedDocs={pinnedDocs}
          summary={summary}
          tokenBreakdown={tokenBreakdown}
          turns={turns}
          nodes={nodes}
          models={catalog?.models}
          selectedWireId={selectedWireId}
          onSelectWireId={setSelectedWireId}
          wireCache={controller.wireCache}
          wireLoadingId={controller.wireLoadingId}
          onLoadWire={controller.loadWire}
          onUpdateConfig={controller.updateConfig}
          onSetTurnFlags={controller.setTurnFlags}
        />,
        panelSlot,
      )}
    </div>
  );
}
