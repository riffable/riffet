import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type {
  ModelChatConfig,
  ModelChatConfigPatch,
  ModelChatContextStrategy,
  ModelChatEffort,
  ModelChatNode,
  ModelChatPinnedDoc,
  ModelChatProtocol,
  ModelChatResponseFormat,
  ModelChatTokenBreakdown,
  ModelChatWireRecord,
  ModelInfo,
} from '@contracts';
import { MODEL_CHAT_BUDGET, MODEL_CHAT_DEFAULT_CONFIG } from '@contracts';
import { compactTokens } from '@/app/session/ComposerPickers';
import { formatTokensPerSecond, tokensPerSecond } from '@/app/session/speed';
import {
  IconCopy,
  IconFileCode2,
  IconMaximize,
  IconMinimize,
  IconPanelRight,
  IconPictureInPicture,
  IconPin,
  IconPinOff,
  IconPlus,
  IconRefreshCw,
  IconSlash,
  IconTerminal,
  IconTrash2,
  IconX,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Badge,
  EmptyState,
  Field,
  Input,
  Segmented,
  Select,
  Spinner,
  Switch,
  Textarea,
  UnderlineTabs,
} from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Slider } from '@/components/ui/slider';
import { Tip } from '@/components/ui/tooltip';
import { copyWithToast } from '@/lib/files';
import { formatNumber } from '@/lib/i18n/format';
import { cn, newId } from '@/lib/utils';
import type { CustomPanelChrome } from '@/app/WorkbenchPanels';
import type { InspectorTab } from './ModelChatTranscript';
import {
  type ModelChatBranchAnswer,
  type ModelChatTurnView,
  assistantRunMetrics,
  buildWireCurl,
  cacheHitPercent,
  estimateTextTokens,
  isSamplingLocked,
  protocolCapabilities,
  resolveModelLabel,
} from './tree';

const CONTEXT_BUDGET_OPTIONS = [
  { value: '32000', label: '32k' },
  { value: '48000', label: '48k' },
  { value: '128000', label: '128k' },
  { value: '200000', label: '200k' },
] as const;

export interface ModelChatInspectorProps {
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  chrome?: CustomPanelChrome;
  /** On the new-session home, Wire is hidden until the first turn has been sent. */
  hideWire?: boolean;
  /** Archived sessions keep inspector controls read-only while allowing Wire inspection. */
  readOnly?: boolean;
  config: ModelChatConfig;
  protocol: ModelChatProtocol;
  pinnedDocs: readonly ModelChatPinnedDoc[];
  summary: string;
  tokenBreakdown: ModelChatTokenBreakdown;
  turns: readonly ModelChatTurnView[];
  nodes: readonly ModelChatNode[];
  models: readonly ModelInfo[] | undefined;
  selectedWireId: string | undefined;
  onSelectWireId: (assistantId: string | undefined) => void;
  wireCache: Record<string, ModelChatWireRecord>;
  wireLoadingId: string | undefined;
  onLoadWire: (assistantId: string, force?: boolean) => Promise<ModelChatWireRecord | undefined>;
  onUpdateConfig: (patch: ModelChatConfigPatch) => Promise<void>;
  onSetTurnFlags: (userId: string, flags: { pinned?: boolean; muted?: boolean }) => Promise<void>;
}

const ParamsTab = memo(function ParamsTab({
  config,
  protocol,
  readOnly = false,
  onUpdateConfig,
}: {
  config: ModelChatConfig;
  protocol: ModelChatProtocol;
  readOnly?: boolean;
  onUpdateConfig: (patch: ModelChatConfigPatch) => Promise<void>;
}) {
  const { t } = useLingui();
  const caps = useMemo(() => protocolCapabilities(protocol), [protocol]);
  const samplingLocked = isSamplingLocked(protocol, config.effort);
  const stopList = config.stop ?? [];
  const stopKey = stopList.join('\n');
  const formatKey = JSON.stringify(config.responseFormat);
  const defaultMaxOutput = config.maxOutputTokens || MODEL_CHAT_DEFAULT_CONFIG.maxOutputTokens;

  const [systemDraft, setSystemDraft] = useState(config.systemPrompt);
  const [temperatureDraft, setTemperatureDraft] = useState<number | undefined>(config.temperature);
  const [topPDraft, setTopPDraft] = useState<number | undefined>(config.topP);
  const [maxOutputDraft, setMaxOutputDraft] = useState(defaultMaxOutput);
  const [seedDraft, setSeedDraft] = useState(
    config.seed !== undefined && config.seed !== null ? String(config.seed) : '',
  );
  const [stopDraft, setStopDraft] = useState(stopList.join(', '));
  const [schemaNameDraft, setSchemaNameDraft] = useState(
    config.responseFormat.type === 'json_schema' ? config.responseFormat.name : 'response',
  );
  const [schemaJsonDraft, setSchemaJsonDraft] = useState(
    config.responseFormat.type === 'json_schema'
      ? JSON.stringify(config.responseFormat.schema, null, 2)
      : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
  );
  const [schemaError, setSchemaError] = useState<string>();

  useEffect(() => {
    setSystemDraft(config.systemPrompt);
  }, [config.systemPrompt]);

  useEffect(() => {
    setTemperatureDraft(config.temperature);
  }, [config.temperature]);

  useEffect(() => {
    setTopPDraft(config.topP);
  }, [config.topP]);

  useEffect(() => {
    setMaxOutputDraft(defaultMaxOutput);
  }, [defaultMaxOutput]);

  useEffect(() => {
    setSeedDraft(config.seed !== undefined && config.seed !== null ? String(config.seed) : '');
  }, [config.seed]);

  useEffect(() => {
    setStopDraft(stopKey ? stopKey.split('\n').join(', ') : '');
  }, [stopKey]);

  useEffect(() => {
    if (config.responseFormat.type === 'json_schema') {
      setSchemaNameDraft(config.responseFormat.name);
      setSchemaJsonDraft(JSON.stringify(config.responseFormat.schema, null, 2));
      setSchemaError(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- synced by stable serialized formatKey
  }, [formatKey]);

  const systemFlushRef = useRef({
    draft: systemDraft,
    saved: config.systemPrompt,
    readOnly,
    onUpdateConfig,
  });
  systemFlushRef.current = {
    draft: systemDraft,
    saved: config.systemPrompt,
    readOnly,
    onUpdateConfig,
  };
  useEffect(() => () => {
    const current = systemFlushRef.current;
    if (!current.readOnly && current.draft !== current.saved) {
      void current.onUpdateConfig({ systemPrompt: current.draft });
    }
  }, []);

  const commitSystem = () => {
    if (readOnly) return;
    if (systemDraft !== config.systemPrompt) {
      void onUpdateConfig({ systemPrompt: systemDraft });
    }
  };

  const effortOptions = useMemo(() => {
    const labelOf = (value: ModelChatEffort): string => {
      switch (value) {
        case 'default': return 'Default';
        case 'off': return 'Off';
        case 'minimal': return 'Minimal';
        case 'low': return 'Low';
        case 'medium': return 'Medium';
        case 'high': return 'High';
        case 'xhigh': return 'XHigh';
        case 'max': return 'Max';
        case 'adaptive': return 'Adaptive';
      }
    };
    return caps.effortOptions.map((value) => ({
      value,
      label: labelOf(value),
      ...(readOnly ? { disabled: true } : {}),
    }));
  }, [caps.effortOptions, readOnly]);

  const currentEffort = caps.effortOptions.includes(config.effort)
    ? config.effort
    : caps.effortOptions[0]!;

  const commitSeed = () => {
    if (readOnly) return;
    const trimmed = seedDraft.trim();
    if (!trimmed) {
      if (config.seed !== undefined && config.seed !== null) void onUpdateConfig({ seed: null });
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed) && parsed !== config.seed) {
      void onUpdateConfig({ seed: parsed });
    }
  };

  const commitStop = () => {
    if (readOnly) return;
    const next = stopDraft
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (next.join('\n') !== stopKey) {
      void onUpdateConfig({ stop: next });
    }
  };

  const handleFormatTypeChange = (nextType: string) => {
    if (readOnly) return;
    if (nextType === 'text') {
      void onUpdateConfig({ responseFormat: { type: 'text' } });
      return;
    }
    if (nextType === 'json_object') {
      void onUpdateConfig({ responseFormat: { type: 'json_object' } });
      return;
    }
    try {
      const parsed = JSON.parse(schemaJsonDraft) as Record<string, unknown>;
      setSchemaError(undefined);
      const nextFormat: ModelChatResponseFormat = {
        type: 'json_schema',
        name: schemaNameDraft.trim() || 'response',
        schema: parsed,
        strict: true,
      };
      void onUpdateConfig({ responseFormat: nextFormat });
    } catch {
      const fallback: Record<string, unknown> = { type: 'object', properties: {}, required: [] };
      setSchemaJsonDraft(JSON.stringify(fallback, null, 2));
      setSchemaError(undefined);
      void onUpdateConfig({
        responseFormat: {
          type: 'json_schema',
          name: schemaNameDraft.trim() || 'response',
          schema: fallback,
          strict: true,
        },
      });
    }
  };

  const commitSchema = (nextName = schemaNameDraft, nextJson = schemaJsonDraft) => {
    if (readOnly) return;
    try {
      const parsed = JSON.parse(nextJson) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setSchemaError(t`JSON Schema 顶层必须是对象`);
        return;
      }
      setSchemaError(undefined);
      void onUpdateConfig({
        responseFormat: {
          type: 'json_schema',
          name: nextName.trim() || 'response',
          schema: parsed as Record<string, unknown>,
          strict: true,
        },
      });
    } catch {
      setSchemaError(t`JSON 语法无效，请检查括号与引号`);
    }
  };

  const temperatureValue = temperatureDraft ?? 1;
  const topPValue = topPDraft ?? 1;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-fg">
            System Prompt
          </span>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-2">
            <span>Raw</span>
            <Switch
              checked={config.bareMode}
              disabled={readOnly}
              onCheckedChange={(checked) => { if (!readOnly) void onUpdateConfig({ bareMode: checked }); }}
              aria-label={t`Raw（不发送系统提示）`}
            />
          </label>
        </div>

        <Textarea
          value={systemDraft}
          disabled={readOnly || config.bareMode}
          onChange={(event) => setSystemDraft(event.target.value)}
          onBlur={commitSystem}
          rows={4}
          placeholder={config.bareMode ? t`Raw 模式不发送 System Prompt` : t`输入 System Prompt`}
          aria-label="System Prompt"
        />
      </section>

      <section className="flex flex-col gap-4 edge-t pt-5">
        <Field label="Reasoning Effort">
          {effortOptions.length <= 4 ? (
            <Segmented
              fill
              value={currentEffort}
              onChange={(value) => { if (!readOnly) void onUpdateConfig({ effort: value }); }}
              options={effortOptions}
              ariaLabel="Reasoning Effort"
            />
          ) : (
            <Select
              label="Reasoning Effort"
              value={currentEffort}
              disabled={readOnly}
              onChange={(value) => { if (!readOnly) void onUpdateConfig({ effort: value as ModelChatEffort }); }}
              options={effortOptions}
            />
          )}
        </Field>

        <div className="flex flex-col gap-3">
          <div className={cn('flex flex-col gap-1.5', samplingLocked && 'opacity-45')}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-2">
                <Trans>Temperature</Trans>
              </span>
              <span className="inline-flex items-center gap-1.5">
                {temperatureDraft !== undefined && !readOnly && !samplingLocked && (
                  <button
                    type="button"
                    onClick={() => {
                      setTemperatureDraft(undefined);
                      void onUpdateConfig({ temperature: null });
                    }}
                    className="rounded text-2xs text-fg-3 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <Trans>重置</Trans>
                  </button>
                )}
                <span className="font-mono text-2xs tabular-nums text-fg-3">
                  {temperatureDraft !== undefined ? temperatureDraft.toFixed(2) : t`默认`}
                </span>
              </span>
            </div>
            <Slider
              aria-label={t`Temperature`}
              min={0}
              max={2}
              step={0.05}
              value={temperatureValue}
              disabled={readOnly || samplingLocked}
              onValueChange={(value) => setTemperatureDraft(Number(value.toFixed(2)))}
              onValueCommit={(value) => {
                if (readOnly || samplingLocked) return;
                const next = Number(value.toFixed(2));
                setTemperatureDraft(next);
                if (next !== config.temperature) void onUpdateConfig({ temperature: next });
              }}
            />
          </div>

          <div className={cn('flex flex-col gap-1.5', samplingLocked && 'opacity-45')}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-2">
                <Trans>Top P</Trans>
              </span>
              <span className="inline-flex items-center gap-1.5">
                {topPDraft !== undefined && !readOnly && !samplingLocked && (
                  <button
                    type="button"
                    onClick={() => {
                      setTopPDraft(undefined);
                      void onUpdateConfig({ topP: null });
                    }}
                    className="rounded text-2xs text-fg-3 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <Trans>重置</Trans>
                  </button>
                )}
                <span className="font-mono text-2xs tabular-nums text-fg-3">
                  {topPDraft !== undefined ? topPDraft.toFixed(2) : t`默认`}
                </span>
              </span>
            </div>
            <Slider
              aria-label={t`Top P`}
              min={0.05}
              max={1}
              step={0.05}
              value={topPValue}
              disabled={readOnly || samplingLocked}
              onValueChange={(value) => setTopPDraft(Number(value.toFixed(2)))}
              onValueCommit={(value) => {
                if (readOnly || samplingLocked) return;
                const next = Number(value.toFixed(2));
                setTopPDraft(next);
                if (next !== config.topP) void onUpdateConfig({ topP: next });
              }}
            />
          </div>

          {samplingLocked && (
            <p className="text-2xs text-fg-3">
              {t`开启推理时不可调采样`}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-fg-2"><Trans>Max Output Tokens</Trans></span>
            <span className="font-mono text-2xs tabular-nums text-fg-3">
              {formatNumber(maxOutputDraft)}
            </span>
          </div>
          <Slider
            aria-label={t`Max Output Tokens`}
            min={256}
            max={32768}
            step={256}
            value={maxOutputDraft}
            disabled={readOnly}
            onValueChange={(value) => setMaxOutputDraft(Math.round(value))}
            onValueCommit={(value) => {
              if (readOnly) return;
              const next = Math.round(value);
              setMaxOutputDraft(next);
              if (next !== config.maxOutputTokens) void onUpdateConfig({ maxOutputTokens: next });
            }}
          />
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <Field label={t`Seed`}>
            <Input
              value={seedDraft}
              disabled={readOnly || !caps.supportsSeed}
              onChange={(event) => setSeedDraft(event.target.value)}
              onBlur={commitSeed}
              inputMode="numeric"
              placeholder={caps.supportsSeed ? t`留空随机` : t`当前协议不支持`}
            />
          </Field>
          <Field label={t`Stop 序列`}>
            <Input
              value={stopDraft}
              disabled={readOnly}
              onChange={(event) => setStopDraft(event.target.value)}
              onBlur={commitStop}
              placeholder={t`逗号分隔`}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3 edge-t pt-5">
        <Field label={t`Response Format`}>
          <Select
            label={t`Response Format`}
            value={config.responseFormat.type}
            disabled={readOnly}
            onChange={handleFormatTypeChange}
            options={[
              { value: 'text', label: t`纯文本` },
              { value: 'json_object', label: 'JSON Object' },
              { value: 'json_schema', label: 'JSON Schema' },
            ]}
          />
        </Field>

        {config.responseFormat.type === 'json_schema' && (
          <div className="flex flex-col gap-2">
            <Field label={t`Schema 名称`}>
              <Input
                value={schemaNameDraft}
                disabled={readOnly}
                onChange={(event) => setSchemaNameDraft(event.target.value)}
                onBlur={() => commitSchema(schemaNameDraft, schemaJsonDraft)}
              />
            </Field>
            <Field label={t`JSON Schema`} error={schemaError}>
              <Textarea
                value={schemaJsonDraft}
                disabled={readOnly}
                onChange={(event) => setSchemaJsonDraft(event.target.value)}
                onBlur={() => commitSchema(schemaNameDraft, schemaJsonDraft)}
                rows={6}
                className="font-mono text-xs"
              />
            </Field>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex flex-col">
            <span className="text-xs font-medium text-fg"><Trans>Web Search</Trans></span>
            {!caps.supportsWebSearch && (
              <span className="text-2xs text-fg-3"><Trans>当前协议不支持联网检索</Trans></span>
            )}
          </div>
          <Switch
            checked={config.webSearch && caps.supportsWebSearch}
            disabled={readOnly || !caps.supportsWebSearch}
            onCheckedChange={(checked) => { if (!readOnly) void onUpdateConfig({ webSearch: checked }); }}
            aria-label={t`Web Search`}
          />
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex flex-col">
            <span className="text-xs font-medium text-fg"><Trans>Fast 模式</Trans></span>
            {!caps.supportsFast && (
              <span className="text-2xs text-fg-3"><Trans>仅 Responses 协议支持</Trans></span>
            )}
          </div>
          <Switch
            checked={config.fast && caps.supportsFast}
            disabled={readOnly || !caps.supportsFast}
            onCheckedChange={(checked) => { if (!readOnly) void onUpdateConfig({ fast: checked }); }}
            aria-label={t`Fast 模式`}
          />
        </div>
      </section>
    </div>
  );
});

const ContextTab = memo(function ContextTab({
  config,
  pinnedDocs,
  summary,
  tokenBreakdown,
  turns,
  readOnly = false,
  onUpdateConfig,
  onSetTurnFlags,
}: {
  config: ModelChatConfig;
  pinnedDocs: readonly ModelChatPinnedDoc[];
  summary: string;
  tokenBreakdown: ModelChatTokenBreakdown;
  turns: readonly ModelChatTurnView[];
  readOnly?: boolean;
  onUpdateConfig: (patch: ModelChatConfigPatch) => Promise<void>;
  onSetTurnFlags: (userId: string, flags: { pinned?: boolean; muted?: boolean }) => Promise<void>;
}) {
  const { t } = useLingui();
  const [addingDoc, setAddingDoc] = useState(false);
  const [docName, setDocName] = useState('');
  const [docText, setDocText] = useState('');
  const [summaryDraft, setSummaryDraft] = useState(summary);

  useEffect(() => {
    setSummaryDraft(summary);
  }, [summary]);

  useEffect(() => {
    if (readOnly) setAddingDoc(false);
  }, [readOnly]);

  const summaryFlushRef = useRef({
    draft: summaryDraft,
    saved: summary,
    readOnly,
    onUpdateConfig,
  });
  summaryFlushRef.current = {
    draft: summaryDraft,
    saved: summary,
    readOnly,
    onUpdateConfig,
  };
  useEffect(() => () => {
    const current = summaryFlushRef.current;
    if (current.readOnly) return;
    const clipped = current.draft.slice(0, MODEL_CHAT_BUDGET.maxSummaryChars);
    if (clipped !== current.saved) {
      void current.onUpdateConfig({ summary: clipped });
    }
  }, []);

  const budget = Math.max(1, tokenBreakdown.budget || config.contextBudget);
  const pct = (value: number) => `${Math.min(100, (value / budget) * 100).toFixed(2)}%`;

  const budgetValue = String(config.contextBudget);
  const budgetOptions = useMemo(() => {
    const exists = CONTEXT_BUDGET_OPTIONS.some((item) => item.value === budgetValue);
    if (exists) return [...CONTEXT_BUDGET_OPTIONS];
    return [...CONTEXT_BUDGET_OPTIONS, { value: budgetValue, label: compactTokens(config.contextBudget) }];
  }, [config.contextBudget, budgetValue]);

  const strategyOptions = useMemo(() => (
    [
      { value: 'summary' as const, label: 'Summary' },
      { value: 'window' as const, label: 'Window' },
      { value: 'full' as const, label: 'Full' },
      { value: 'stateless' as const, label: 'Stateless' },
    ].map((option) => (readOnly ? { ...option, disabled: true } : option))
  ), [readOnly]);

  const handleAddDoc = () => {
    if (readOnly) return;
    const name = docName.trim();
    const text = docText.trim().slice(0, MODEL_CHAT_BUDGET.maxPinnedDocChars);
    if (!name || !text) return;
    const nextDoc: ModelChatPinnedDoc = {
      id: newId(),
      name,
      text,
      pinned: true,
      tokens: estimateTextTokens(text),
    };
    const nextDocs = [...pinnedDocs, nextDoc].slice(0, MODEL_CHAT_BUDGET.maxPinnedDocs);
    void onUpdateConfig({ pinnedDocs: nextDocs });
    setDocName('');
    setDocText('');
    setAddingDoc(false);
  };

  const toggleDoc = (id: string, pinned: boolean) => {
    if (readOnly) return;
    void onUpdateConfig({
      pinnedDocs: pinnedDocs.map((doc) => (doc.id === id ? { ...doc, pinned } : doc)),
    });
  };

  const removeDoc = (id: string) => {
    if (readOnly) return;
    void onUpdateConfig({
      pinnedDocs: pinnedDocs.filter((doc) => doc.id !== id),
    });
  };

  const commitSummary = () => {
    if (readOnly) return;
    const clipped = summaryDraft.slice(0, MODEL_CHAT_BUDGET.maxSummaryChars);
    if (clipped !== summary) {
      void onUpdateConfig({ summary: clipped });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-fg"><Trans>Token 构成</Trans></span>
          <span className="font-mono text-2xs tabular-nums text-fg-3">
            {compactTokens(tokenBreakdown.totalTokens)} / {compactTokens(budget)}
          </span>
        </div>

        <div className="flex h-2 w-full overflow-hidden rounded-full bg-subtle">
          {tokenBreakdown.systemTokens > 0 && (
            <span
              className="h-full"
              style={{ width: pct(tokenBreakdown.systemTokens), background: 'var(--chart-1)' }}
            />
          )}
          {tokenBreakdown.pinnedDocsTokens > 0 && (
            <span
              className="h-full"
              style={{ width: pct(tokenBreakdown.pinnedDocsTokens), background: 'var(--chart-2)' }}
            />
          )}
          {tokenBreakdown.summaryTokens > 0 && (
            <span
              className="h-full"
              style={{ width: pct(tokenBreakdown.summaryTokens), background: 'var(--chart-3)' }}
            />
          )}
          {tokenBreakdown.historyTokens > 0 && (
            <span
              className="h-full"
              style={{ width: pct(tokenBreakdown.historyTokens), background: 'var(--chart-4)' }}
            />
          )}
        </div>

        <div className="grid grid-cols-2 gap-1.5 text-2xs text-fg-2">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: 'var(--chart-1)' }} />
              <Trans>System</Trans>
            </span>
            <span className="tabular-nums text-fg-3">{compactTokens(tokenBreakdown.systemTokens)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: 'var(--chart-2)' }} />
              <Trans>钉住材料</Trans>
            </span>
            <span className="tabular-nums text-fg-3">{compactTokens(tokenBreakdown.pinnedDocsTokens)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: 'var(--chart-3)' }} />
              <Trans>摘要</Trans>
            </span>
            <span className="tabular-nums text-fg-3">{compactTokens(tokenBreakdown.summaryTokens)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: 'var(--chart-4)' }} />
              <Trans>历史轮次</Trans>
            </span>
            <span className="tabular-nums text-fg-3">{compactTokens(tokenBreakdown.historyTokens)}</span>
          </div>
        </div>

        <Field label={t`上下文上限`}>
          <Select
            label={t`上下文上限`}
            value={budgetValue}
            disabled={readOnly}
            onChange={(value) => { if (!readOnly) void onUpdateConfig({ contextBudget: Number.parseInt(value, 10) }); }}
            options={budgetOptions}
          />
        </Field>

        <Field label={t`上下文策略`}>
          <Segmented
            fill
            value={config.contextStrategy}
            onChange={(value) => { if (!readOnly) void onUpdateConfig({ contextStrategy: value as ModelChatContextStrategy }); }}
            options={strategyOptions}
            ariaLabel={t`上下文策略`}
          />
        </Field>

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs font-medium text-fg"><Trans>Prompt Caching</Trans></span>
          <Switch
            checked={config.promptCaching}
            disabled={readOnly}
            onCheckedChange={(checked) => { if (!readOnly) void onUpdateConfig({ promptCaching: checked }); }}
            aria-label={t`Prompt Caching`}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3 edge-t pt-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-fg">
            <Trans>钉住材料 ({pinnedDocs.length}/{MODEL_CHAT_BUDGET.maxPinnedDocs})</Trans>
          </span>
          <Button
            variant="secondary"
            size="xs"
            disabled={readOnly || pinnedDocs.length >= MODEL_CHAT_BUDGET.maxPinnedDocs}
            onClick={() => setAddingDoc((open) => !open)}
          >
            <IconPlus aria-hidden className="size-3.5" />
            <Trans>添加</Trans>
          </Button>
        </div>

        {addingDoc && !readOnly && (
          <div className="flex flex-col gap-2 rounded-lg bg-subtle p-2.5">
            <Input
              value={docName}
              onChange={(event) => setDocName(event.target.value)}
              placeholder={t`材料名称`}
              aria-label={t`材料名称`}
            />
            <Textarea
              value={docText}
              onChange={(event) => setDocText(event.target.value)}
              rows={4}
              placeholder={t`粘贴只读参考片段`}
              aria-label={t`材料正文`}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs tabular-nums text-fg-3">
                {t`约 ${compactTokens(estimateTextTokens(docText))} tok`}
              </span>
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="xs" onClick={() => setAddingDoc(false)}>
                  <Trans>取消</Trans>
                </Button>
                <Button
                  variant="primary"
                  size="xs"
                  disabled={!docName.trim() || !docText.trim()}
                  onClick={handleAddDoc}
                >
                  <Trans>钉住</Trans>
                </Button>
              </div>
            </div>
          </div>
        )}

        {pinnedDocs.length === 0 ? (
          <p className="text-xs text-fg-3"><Trans>暂无常驻参考材料。</Trans></p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pinnedDocs.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-subtle px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate text-xs font-medium text-fg', !doc.pinned && 'opacity-50')}>
                    {doc.name}
                  </p>
                  <p className="text-2xs tabular-nums text-fg-3">
                    {compactTokens(doc.tokens || estimateTextTokens(doc.text))} tok
                  </p>
                </div>
                <Switch
                  checked={doc.pinned}
                  disabled={readOnly}
                  onCheckedChange={(checked) => toggleDoc(doc.id, checked)}
                  aria-label={t`切换材料 ${doc.name}`}
                />
                <Tip label={t`移除材料`}>
                  <Button
                    variant="danger-ghost"
                    size="icon-xs"
                    disabled={readOnly}
                    aria-label={t`移除材料 ${doc.name}`}
                    onClick={() => removeDoc(doc.id)}
                  >
                    <IconTrash2 aria-hidden className="size-3.5" />
                  </Button>
                </Tip>
              </li>
            ))}
          </ul>
        )}
      </section>

      {turns.length > 0 && config.contextStrategy !== 'stateless' && (
        <section className="flex flex-col gap-2.5 edge-t pt-5">
          <span className="text-xs font-medium text-fg"><Trans>逐轮编排</Trans></span>
          <ul className="flex flex-col gap-1.5">
            {turns.map((turn) => (
              <li
                key={turn.id}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg bg-subtle px-2.5 py-1.5',
                  turn.userNode.muted && 'opacity-60',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-fg">
                    <span className="mr-1.5 font-mono text-2xs text-fg-3">#{turn.turnNumber}</span>
                    {turn.userNode.text}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tip label={turn.userNode.pinned ? t`取消钉住` : t`钉住本轮`}>
                    <Button
                      variant="quiet"
                      size="icon-xs"
                      disabled={readOnly}
                      aria-label={turn.userNode.pinned ? t`取消钉住第 ${turn.turnNumber} 轮` : t`钉住第 ${turn.turnNumber} 轮`}
                      onClick={() => { if (!readOnly) void onSetTurnFlags(turn.userNode.id, { pinned: !turn.userNode.pinned }); }}
                      className={cn(turn.userNode.pinned && 'text-accent')}
                    >
                      {turn.userNode.pinned
                        ? <IconPinOff aria-hidden className="size-3.5" />
                        : <IconPin aria-hidden className="size-3.5" />}
                    </Button>
                  </Tip>
                  <Tip label={turn.userNode.muted ? t`恢复纳入上下文` : t`移出上下文`}>
                    <Button
                      variant="quiet"
                      size="icon-xs"
                      disabled={readOnly}
                      aria-label={turn.userNode.muted ? t`恢复第 ${turn.turnNumber} 轮上下文` : t`移出第 ${turn.turnNumber} 轮上下文`}
                      onClick={() => { if (!readOnly) void onSetTurnFlags(turn.userNode.id, { muted: !turn.userNode.muted }); }}
                      className={cn(turn.userNode.muted && 'text-warning')}
                    >
                      <IconSlash aria-hidden className="size-3.5" />
                    </Button>
                  </Tip>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {config.contextStrategy === 'summary' && (
        <section className="flex flex-col gap-2 edge-t pt-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg"><Trans>历史摘要</Trans></span>
            <span className="text-2xs tabular-nums text-fg-3">
              {compactTokens(estimateTextTokens(summaryDraft))} tok
            </span>
          </div>
          <Textarea
            value={summaryDraft}
            disabled={readOnly}
            onChange={(event) => setSummaryDraft(event.target.value)}
            onBlur={commitSummary}
            rows={5}
            placeholder={t`超出窗口的历史会自动压缩到此，也可直接改写。`}
            aria-label={t`历史摘要`}
          />
        </section>
      )}
    </div>
  );
});

const WireTab = memo(function WireTab({
  turns,
  models,
  selectedWireId,
  onSelectWireId,
  wireCache,
  wireLoadingId,
  onLoadWire,
}: {
  turns: readonly ModelChatTurnView[];
  models: readonly ModelInfo[] | undefined;
  selectedWireId: string | undefined;
  onSelectWireId: (assistantId: string | undefined) => void;
  wireCache: Record<string, ModelChatWireRecord>;
  wireLoadingId: string | undefined;
  onLoadWire: (assistantId: string, force?: boolean) => Promise<ModelChatWireRecord | undefined>;
}) {
  const { t } = useLingui();

  const wireChoices = useMemo(() => {
    const items: Array<{ id: string; label: string; answer: ModelChatBranchAnswer }> = [];
    for (const turn of turns) {
      for (const answer of turn.assistantSiblings) {
        if (answer.streaming) continue;
        const modelLabel = resolveModelLabel(answer.modelSelection ?? answer.model, models) || t`默认模型`;
        items.push({
          id: answer.id,
          label: `#${turn.turnNumber} · ${modelLabel}`,
          answer,
        });
      }
    }
    return items.reverse();
  }, [turns, models, t]);

  const effectiveId = useMemo(() => {
    if (selectedWireId && wireChoices.some((item) => item.id === selectedWireId)) {
      return selectedWireId;
    }
    return wireChoices[0]?.id;
  }, [selectedWireId, wireChoices]);

  const activeChoice = useMemo(
    () => wireChoices.find((item) => item.id === effectiveId),
    [wireChoices, effectiveId],
  );
  const hasWire = activeChoice?.answer.hasWire;

  useEffect(() => {
    if (effectiveId && hasWire !== false && !wireCache[effectiveId]) {
      void onLoadWire(effectiveId);
    }
  }, [effectiveId, hasWire, wireCache, onLoadWire]);

  const wire = effectiveId ? wireCache[effectiveId] : undefined;
  const loading = Boolean(effectiveId && wireLoadingId === effectiveId && !wire);

  const metrics = wire?.metrics ?? activeChoice?.answer.metrics;
  const runMetrics = useMemo(() => assistantRunMetrics(metrics), [metrics]);
  const rate = runMetrics ? tokensPerSecond(runMetrics) : undefined;
  const speed = rate !== undefined ? formatTokensPerSecond(rate) : '—';
  const ttft = typeof metrics?.ttftMs === 'number' && metrics.ttftMs > 0
    ? (metrics.ttftMs >= 1000 ? `${(metrics.ttftMs / 1000).toFixed(2)}s` : `${Math.round(metrics.ttftMs)}ms`)
    : '—';
  const authLabel = typeof metrics?.authMs === 'number' && metrics.authMs >= 0
    ? `Auth ${Math.round(metrics.authMs)}ms`
    : '—';
  const cachePct = cacheHitPercent(metrics);
  const formattedJson = useMemo(() => (wire ? JSON.stringify(wire.body, null, 2) : ''), [wire]);

  if (wireChoices.length === 0) {
    return (
      <EmptyState
        icon={<IconFileCode2 aria-hidden className="size-5" />}
        title={t`暂无 Wire 报文`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Select
            label={t`选择要检查的回复轮次`}
            value={effectiveId ?? ''}
            onChange={(value) => onSelectWireId(value)}
            options={wireChoices.map((item) => ({ value: item.id, label: item.label }))}
          />
        </div>
        {effectiveId && (
          <Tip label={t`重新拉取报文`}>
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={t`重新拉取报文`}
              onClick={() => void onLoadWire(effectiveId, true)}
            >
              <IconRefreshCw aria-hidden className="size-3.5" />
            </Button>
          </Tip>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-0.5 rounded-lg bg-subtle p-3">
          <span className="text-2xs text-fg-3"><Trans>TTFT / Auth</Trans></span>
          <span className="font-mono text-sm font-medium tabular-nums text-fg">{ttft}</span>
          <span className="truncate text-2xs tabular-nums text-fg-3">{authLabel}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg bg-subtle p-3">
          <span className="text-2xs text-fg-3"><Trans>吞吐速度</Trans></span>
          <span className="font-mono text-sm font-medium tabular-nums text-fg">{speed}</span>
          <span className="truncate text-2xs text-fg-3">{wire?.protocol ?? metrics?.protocol ?? '—'}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg bg-subtle p-3">
          <span className="text-2xs text-fg-3"><Trans>Input / Cache Read</Trans></span>
          <span className="font-mono text-sm font-medium tabular-nums text-fg">
            {metrics?.inputTokens !== undefined ? compactTokens(metrics.inputTokens) : '—'}
          </span>
          <span className="truncate text-2xs tabular-nums text-fg-3">
            {cachePct !== undefined ? t`缓存命中 ${cachePct}%` : t`无缓存命中`}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg bg-subtle p-3">
          <span className="text-2xs text-fg-3"><Trans>Output / Stop</Trans></span>
          <span className="font-mono text-sm font-medium tabular-nums text-fg">
            {metrics?.outputTokens !== undefined ? compactTokens(metrics.outputTokens) : '—'}
          </span>
          <span className="truncate text-2xs text-fg-3">{metrics?.stopReason ?? '—'}</span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-fg-3">
          <Spinner />
          <Trans>加载脱敏报文…</Trans>
        </div>
      ) : wire ? (
        <div className="flex flex-col gap-2.5 edge-t pt-4">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-2xs text-fg-2">{wire.endpoint}</span>
            <Badge tone="neutral">{wire.protocol}</Badge>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="xs"
              onClick={() => void copyWithToast(formattedJson, t`已复制 JSON`)}
            >
              <IconCopy aria-hidden className="size-3.5" />
              <Trans>复制 JSON</Trans>
            </Button>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => void copyWithToast(buildWireCurl(wire), t`已复制 cURL`)}
            >
              <IconTerminal aria-hidden className="size-3.5" />
              <Trans>复制 cURL</Trans>
            </Button>
          </div>

          <pre className="max-h-96 overflow-auto rounded-lg bg-subtle p-3 font-mono text-xs leading-relaxed text-fg-2">
            {formattedJson}
          </pre>
        </div>
      ) : (
        <Notice tone="neutral">
          <Trans>该回复未保留 Wire 快照。仅记录当前服务内发出的脱敏请求报文。</Trans>
        </Notice>
      )}
    </div>
  );
});

export function ModelChatInspector({
  tab,
  onTabChange,
  chrome,
  hideWire = false,
  readOnly = false,
  config,
  protocol,
  pinnedDocs,
  summary,
  tokenBreakdown,
  turns,
  models,
  selectedWireId,
  onSelectWireId,
  wireCache,
  wireLoadingId,
  onLoadWire,
  onUpdateConfig,
  onSetTurnFlags,
}: ModelChatInspectorProps) {
  const { t } = useLingui();
  const activeTab: InspectorTab = hideWire && tab === 'wire' ? 'params' : tab;

  return (
    <aside className="flex h-full min-h-0 min-w-0 w-full flex-col bg-transparent" aria-label={t`参数、上下文与 Wire`}>
      <div data-panel-drag className="flex h-12 shrink-0 items-stretch gap-2 edge-b px-1.5">
        <UnderlineTabs
          value={activeTab}
          onChange={onTabChange}
          ariaLabel={t`模型对话面板`}
          className="shrink-0"
          options={[
            { value: 'params', label: t`参数` },
            { value: 'context', label: t`上下文` },
            ...(!hideWire ? [{ value: 'wire' as const, label: 'Wire' }] : []),
          ]}
        />
        <div className="ml-auto flex shrink-0 items-center pr-1.5">
          {chrome?.onToggleFloating && (
            <Tip label={chrome.floating ? t`停靠到侧边` : t`悬浮`}>
              <Button
                size="icon-xs"
                variant="quiet"
                aria-label={chrome.floating ? t`停靠到侧边` : t`悬浮`}
                aria-pressed={chrome.floating}
                onClick={chrome.onToggleFloating}
              >
                {chrome.floating ? <IconPanelRight /> : <IconPictureInPicture />}
              </Button>
            </Tip>
          )}
          {chrome?.onToggleFullscreen && (
            <Tip label={chrome.fullscreen ? t`退出全屏` : t`全屏`}>
              <Button
                size="icon-xs"
                variant="quiet"
                className="max-md:size-10"
                aria-label={chrome.fullscreen ? t`退出全屏` : t`全屏`}
                aria-pressed={chrome.fullscreen}
                onClick={chrome.onToggleFullscreen}
              >
                {chrome.fullscreen ? <IconMinimize /> : <IconMaximize />}
              </Button>
            </Tip>
          )}
          {chrome?.onClose && (
            <Tip label={t`关闭`}>
              <Button
                size="icon-xs"
                variant="quiet"
                className="max-md:size-10"
                aria-label={t`关闭面板`}
                onClick={chrome.onClose}
              >
                <IconX />
              </Button>
            </Tip>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {activeTab === 'params' && (
          <ParamsTab
            config={config}
            protocol={protocol}
            readOnly={readOnly}
            onUpdateConfig={onUpdateConfig}
          />
        )}
        {activeTab === 'context' && (
          <ContextTab
            config={config}
            pinnedDocs={pinnedDocs}
            summary={summary}
            tokenBreakdown={tokenBreakdown}
            turns={turns}
            readOnly={readOnly}
            onUpdateConfig={onUpdateConfig}
            onSetTurnFlags={onSetTurnFlags}
          />
        )}
        {activeTab === 'wire' && !hideWire && (
          <WireTab
            turns={turns}
            models={models}
            selectedWireId={selectedWireId}
            onSelectWireId={onSelectWireId}
            wireCache={wireCache}
            wireLoadingId={wireLoadingId}
            onLoadWire={onLoadWire}
          />
        )}
      </div>
    </aside>
  );
}
