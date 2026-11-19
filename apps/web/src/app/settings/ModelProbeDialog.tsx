import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AuxiliaryModelOption, AuxiliaryModelRef, ModelProbePreset, ModelProbeResult } from '@contracts';
import { IconCheck, IconCircleAlert, IconPlay, IconTriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge, Segmented, Spinner } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { formatDuration, formatSpeed } from '@/lib/stats-format';
import { errorMessage } from '@/lib/utils';

const keyOf = (ref: AuxiliaryModelRef) => `${ref.backendId}|${ref.profileId}|${ref.model}`;
const CONCURRENCY = 2;

type ProbeEntry =
  | { state: 'running' }
  | { state: 'done'; result: ModelProbeResult }
  | { state: 'failed'; error: string };

export function ModelProbeDialog({
  open,
  onOpenChange,
  options,
  initialSelected,
  defaultModel,
  onSetDefault,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: AuxiliaryModelOption[];
  initialSelected?: AuxiliaryModelRef[];
  defaultModel?: AuxiliaryModelRef;
  onSetDefault?: (ref: AuxiliaryModelRef) => Promise<void> | void;
  onCompleted?: () => void;
}) {
  const { t } = useLingui();
  const [preset, setPreset] = useState<ModelProbePreset>('stream');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, ProbeEntry>>({});
  const [running, setRunning] = useState(false);
  const [savingKey, setSavingKey] = useState<string>();
  const [shownOpen, setShownOpen] = useState(open);
  const abortRef = useRef<AbortController | undefined>(undefined);

  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      abortRef.current?.abort();
      abortRef.current = undefined;
      setRunning(false);
      setResults({});
      const preferred = new Set((initialSelected ?? []).map(keyOf));
      const initial = options
        .filter((option) => preferred.has(keyOf(option)))
        .map(keyOf);
      const fallback = options
        .filter((option) => option.transport !== 'cli-process')
        .slice(0, 6)
        .map(keyOf);
      setSelectedKeys(initial.length ? initial : fallback);
    }
  }

  useEffect(() => () => abortRef.current?.abort(), []);

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const optionByKey = useMemo(() => new Map(options.map((option) => [keyOf(option), option])), [options]);

  const toggle = (key: string) => {
    if (running) return;
    setSelectedKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = undefined;
    setRunning(false);
  };

  const runSelected = async () => {
    const queue = selectedKeys
      .map((key) => optionByKey.get(key))
      .filter((option): option is AuxiliaryModelOption => Boolean(option));
    if (!queue.length || running) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    const initialMap: Record<string, ProbeEntry> = {};
    for (const item of queue) initialMap[keyOf(item)] = { state: 'running' };
    setResults(initialMap);

    let cursor = 0;
    const worker = async () => {
      while (!controller.signal.aborted && cursor < queue.length) {
        const option = queue[cursor++];
        if (!option) break;
        const key = keyOf(option);
        try {
          const result = await api.probeAuxiliaryModel({
            backendId: option.backendId,
            profileId: option.profileId,
            model: option.model,
            preset,
          }, controller.signal);
          if (controller.signal.aborted) return;
          setResults((prev) => ({ ...prev, [key]: { state: 'done', result } }));
        } catch (error) {
          if (controller.signal.aborted) return;
          setResults((prev) => ({ ...prev, [key]: { state: 'failed', error: errorMessage(error) } }));
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      if (!controller.signal.aborted) onCompleted?.();
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        setRunning(false);
      }
    }
  };

  const sortedOptions = useMemo(() => {
    return [...options].sort((left, right) => {
      const a = results[keyOf(left)];
      const b = results[keyOf(right)];
      const rank = (entry: ProbeEntry | undefined) => {
        if (!entry) return 3;
        if (entry.state === 'running') return 2;
        if (entry.state === 'done' && entry.result.ok) return 0;
        return 1;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a?.state === 'done' && b?.state === 'done' && a.result.ok && b.result.ok) {
        const aMetric = preset === 'short' ? a.result.durationMs : (a.result.ttftMs ?? a.result.durationMs);
        const bMetric = preset === 'short' ? b.result.durationMs : (b.result.ttftMs ?? b.result.durationMs);
        return aMetric - bMetric;
      }
      return 0;
    });
  }, [options, preset, results]);

  const currentDefaultKey = defaultModel ? keyOf(defaultModel) : undefined;

  const setDefault = async (ref: AuxiliaryModelRef) => {
    if (!onSetDefault) return;
    const key = keyOf(ref);
    setSavingKey(key);
    try {
      await onSetDefault(ref);
    } finally {
      setSavingKey(undefined);
    }
  };

  const presets: Array<{ value: ModelProbePreset; label: string }> = [
    { value: 'short', label: t`短任务` },
    { value: 'stream', label: t`流式生成` },
    { value: 'long', label: t`长上下文` },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) stop(); onOpenChange(next); }}>
      <DialogContent size="content">
        <DialogHeader>
          <DialogTitle><Trans>模型接口测速</Trans></DialogTitle>
          <DialogDescription><Trans>发送真实测试请求，检测首字延迟、生成速度与是否已关闭思考。</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented size="sm" ariaLabel={t`测速类型`} value={preset} options={presets} onChange={(next) => { if (!running) setPreset(next); }} />
            <div className="flex items-center gap-2 text-xs text-fg-3">
              <Button
                size="xs"
                variant="ghost"
                disabled={running || options.length === 0}
                onClick={() => setSelectedKeys(options.filter((item) => item.transport !== 'cli-process').map(keyOf))}
              >
                <Trans>全选 HTTP</Trans>
              </Button>
              <Button size="xs" variant="ghost" disabled={running || selectedKeys.length === 0} onClick={() => setSelectedKeys([])}>
                <Trans>清空</Trans>
              </Button>
            </div>
          </div>

          <div className="max-h-96 divide-y divide-line overflow-y-auto rounded-xl border border-line bg-subtle/40">
            {sortedOptions.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-fg-3"><Trans>没有可用的辅助模型</Trans></p>
            )}
            {sortedOptions.map((option) => {
              const key = keyOf(option);
              const checked = selectedSet.has(key);
              const entry = results[key];
              const isDefault = currentDefaultKey === key;
              return (
                <div key={key} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                    <Checkbox checked={checked} disabled={running} onCheckedChange={() => toggle(key)} aria-label={`${option.profileName} · ${option.model}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium text-fg">{option.model}</span>
                        <span className="truncate text-xs text-fg-3">{option.profileName}</span>
                        {option.transport === 'cli-process' && <Badge tone="neutral">{t`CLI · 较慢`}</Badge>}
                        {isDefault && <Badge tone="accent">{t`默认`}</Badge>}
                      </div>
                      {entry?.state === 'done' && entry.result.ok && (
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-fg-3">
                          <span><Trans>鉴权 {formatDuration(entry.result.authMs)}</Trans></span>
                          <span>TTFT {formatDuration(entry.result.ttftMs)}</span>
                          <span><Trans>耗时 {formatDuration(entry.result.durationMs)}</Trans></span>
                          {entry.result.outputTokensPerSecond !== null && (
                            <span>{formatSpeed(entry.result.outputTokensPerSecond)}</span>
                          )}
                          {entry.result.thinkingDetected ? (
                            <span className="inline-flex items-center gap-1 text-warning">
                              <IconTriangleAlert className="size-3" />
                              <Trans>未关思考</Trans>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-success">
                              <IconCheck className="size-3" />
                              <Trans>已关思考</Trans>
                            </span>
                          )}
                          {!entry.result.streamingSupported && <span className="text-fg-4"><Trans>无流式分片</Trans></span>}
                        </div>
                      )}
                      {entry?.state === 'done' && !entry.result.ok && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-danger">
                          <IconCircleAlert className="size-3 shrink-0" />
                          <span className="truncate">{entry.result.error}</span>
                        </p>
                      )}
                      {entry?.state === 'failed' && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-danger">
                          <IconCircleAlert className="size-3 shrink-0" />
                          <span className="truncate">{entry.error}</span>
                        </p>
                      )}
                    </div>
                  </label>
                  <div className="flex shrink-0 items-center gap-2">
                    {entry?.state === 'running' && <Spinner className="size-4 text-fg-3" />}
                    {onSetDefault && entry?.state === 'done' && entry.result.ok && !isDefault && (
                      <Button
                        size="xs"
                        variant="ghost"
                        busy={savingKey === key}
                        disabled={Boolean(savingKey) && savingKey !== key}
                        onClick={() => void setDefault({ backendId: option.backendId, profileId: option.profileId, model: option.model })}
                      >
                        <Trans>设为默认</Trans>
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { stop(); onOpenChange(false); }}>{t`关闭`}</Button>
          {running ? (
            <Button variant="danger" onClick={stop}>{t`停止`}</Button>
          ) : (
            <Button variant="primary" disabled={selectedKeys.length === 0} onClick={() => void runSelected()}>
              <IconPlay className="size-3.5" />
              {t`开始测速 (${selectedKeys.length})`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
