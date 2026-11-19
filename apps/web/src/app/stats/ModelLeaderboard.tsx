import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AuxiliaryModelOption, AuxiliaryModelRef, ModelLeaderboardCategory, ModelLeaderboardResponse, ModelLeaderboardRow, ModelLeaderboardSource } from '@contracts';
import { IconGauge, IconTriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, Segmented } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatDuration, formatPercent, formatSpeed } from '@/lib/stats-format';
import { ModelProbeDialog } from '../settings/ModelProbeDialog';
import { ChartCard, EmptyNote, ellipsizeMiddle, Unavailable, useRovingIndex } from './chart-shared';

function primaryValue(row: ModelLeaderboardRow, category: ModelLeaderboardCategory): number | null {
  if (category === 'short') return row.durationMs?.p50 ?? row.ttftMs?.p50 ?? null;
  return row.ttftMs?.p50 ?? row.durationMs?.p50 ?? null;
}

export function ModelLeaderboard({
  days = 30,
  refreshToken,
}: {
  days?: number;
  refreshToken?: string | number;
}) {
  const { t } = useLingui();
  const [category, setCategory] = useState<ModelLeaderboardCategory>('short');
  const [source, setSource] = useState<ModelLeaderboardSource>('all');
  const [data, setData] = useState<ModelLeaderboardResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [probeOpen, setProbeOpen] = useState(false);
  const [probeOptions, setProbeOptions] = useState<AuxiliaryModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<AuxiliaryModelRef>();
  const [reloadTick, setReloadTick] = useState(0);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading((prev) => !data && prev);
    setError('');
    void api.modelLeaderboard({ category, source: category === 'agent' ? 'live' : source, days }, signal)
      .then((res) => { if (!signal?.aborted) { setData(res); setLoading(false); } })
      .catch((cause) => { if (!signal?.aborted) { setError(cause instanceof Error ? cause.message : t`无法读取性能榜单`); setLoading(false); } });
  }, [category, days, source, t]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, refreshToken, reloadTick]);

  const openProbe = () => {
    setProbeOpen(true);
    void Promise.all([api.auxiliaryModels(), api.settings()]).then(([modelsRes, settingsRes]) => {
      setProbeOptions(modelsRes.models);
      setDefaultModel(settingsRes.auxiliaryModels?.default);
    }).catch(() => undefined);
  };

  const categories: Array<{ value: ModelLeaderboardCategory; label: string }> = [
    { value: 'short', label: t`极速短任务` },
    { value: 'stream', label: t`流式生成` },
    { value: 'long', label: t`长上下文` },
    { value: 'agent', label: t`Agent 对话` },
  ];
  const sources: Array<{ value: ModelLeaderboardSource; label: string }> = [
    { value: 'all', label: t`全部` },
    { value: 'live', label: t`真实调用` },
    { value: 'probe', label: t`接口测速` },
  ];

  const rows = data?.rows ?? [];
  const { index, setIndex, onKeyDown } = useRovingIndex(rows.length);
  const max = rows.reduce((best, row) => {
    const val = primaryValue(row, category);
    return val != null && val > best ? val : best;
  }, 0);

  return (
    <>
      <ChartCard
        title={t`模型性能榜单`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented size="xs" ariaLabel={t`榜单类型`} value={category} options={categories} onChange={setCategory} />
            {category !== 'agent' && (
              <Segmented size="xs" ariaLabel={t`数据来源`} value={source} options={sources} onChange={setSource} />
            )}
            <Button size="xs" variant="ghost" onClick={openProbe}>
              <IconGauge className="size-3.5" />
              <Trans>测速</Trans>
            </Button>
          </div>
        }
      >
        {loading && !data ? (
          <EmptyNote><Trans>榜单还在加载</Trans></EmptyNote>
        ) : error ? (
          <EmptyNote>{error}</EmptyNote>
        ) : rows.length === 0 ? (
          <EmptyNote>
            {category === 'agent'
              ? <Trans>还没有足够的对话延迟记录</Trans>
              : <Trans>还没有该类型的调用或测速记录，点右上角「测速」即可立刻生成对比榜单。</Trans>}
          </EmptyNote>
        ) : (
          <div role="listbox" aria-label={t`模型性能榜单`} tabIndex={0} className="stats-chart flex max-h-[260px] flex-col gap-1.5 overflow-y-auto outline-none" onKeyDown={onKeyDown}>
            {rows.map((row, rowIndex) => {
              const value = primaryValue(row, category);
              const width = value != null && max > 0 ? Math.max((value / max) * 100, 1.5) : 0;
              const thinkingLeak = (row.thinkingRate ?? 0) > 0.2;
              return (
                <div
                  key={row.key}
                  role="option"
                  aria-selected={index === rowIndex}
                  onMouseEnter={() => setIndex(rowIndex)}
                  onMouseLeave={() => setIndex(-1)}
                  className="grid grid-cols-[1.5rem_minmax(0,1.4fr)_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1 py-1 text-xs transition-colors hover:bg-hover/60"
                >
                  <span className="text-center font-medium tabular-nums text-fg-4">{rowIndex + 1}</span>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Tip label={row.label}><span className="truncate font-medium text-fg-2">{ellipsizeMiddle(row.label, 34)}</span></Tip>
                    {row.transport === 'cli-process' && <Badge tone="neutral">{t`CLI`}</Badge>}
                    {thinkingLeak && (
                      <Tip label={t`关闭思考未生效或网关忽略了参数`}>
                        <span className="inline-flex shrink-0 items-center gap-0.5 text-warning">
                          <IconTriangleAlert className="size-3" />
                        </span>
                      </Tip>
                    )}
                  </div>
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                      style={{ width: `${width}%`, background: 'var(--accent)' }}
                    />
                  </span>
                  <div className="flex shrink-0 items-center justify-end gap-3 tabular-nums text-fg-3">
                    {category === 'short' ? (
                      <>
                        <span className="font-medium text-fg">{value != null ? formatDuration(value) : <Unavailable />}</span>
                        <span className="max-sm:hidden">TTFT {formatDuration(row.ttftMs?.p50)}</span>
                        <span className="max-md:hidden"><Trans>鉴权 {formatDuration(row.authMs?.p50)}</Trans></span>
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-fg">TTFT {formatDuration(row.ttftMs?.p50)}</span>
                        <span>{formatSpeed(row.outputTokensPerSecond?.p50)}</span>
                        <span className="max-md:hidden">{formatDuration(row.durationMs?.p50)}</span>
                      </>
                    )}
                    <span className="text-2xs text-fg-4 max-sm:hidden">
                      {row.samples} · {formatPercent(row.successRate)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ChartCard>
      <ModelProbeDialog
        open={probeOpen}
        onOpenChange={setProbeOpen}
        options={probeOptions}
        {...(defaultModel ? { defaultModel } : {})}
        onSetDefault={async (ref) => {
          const saved = await api.updateSettings({ auxiliaryModels: { default: ref } });
          setDefaultModel(saved.auxiliaryModels?.default);
        }}
        onCompleted={() => setReloadTick((tick) => tick + 1)}
      />
    </>
  );
}
