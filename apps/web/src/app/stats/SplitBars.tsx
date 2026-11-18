import { useState } from 'react';
import type { StatsAutonomy, StatsBreakdown, StatsStepBucket, StatsSummary } from '@contracts';
import { Trans, useLingui } from '@lingui/react/macro';
import { Segmented } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { formatCount, formatPercent, formatTokens } from '@/lib/stats-format';
import { rowCacheHitRate, seriesOpacity } from '@/lib/stats-series';
import { ChartCard, EmptyNote, LegendSwatch, Unavailable, ellipsizeMiddle, useHighlight, useRovingIndex } from './chart-shared';

type EffortMetric = 'runs' | 'tokens';
type ProjectMetric = 'tokens' | 'runs' | 'sessions';

const EFFORT_RANK_ORDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'thinking', 'none'];

export function EffortChart({ efforts, summary }: { efforts?: StatsBreakdown; summary: StatsSummary }) {
  const { t } = useLingui();
  const [metric, setMetric] = useState<EffortMetric>('runs');
  const effortLabel = (key: string, fallback: string): string => {
    switch (key) {
      case 'max': return t`最大 (max)`;
      case 'xhigh': return t`超高 (xhigh)`;
      case 'high': return t`高 (high)`;
      case 'medium': return t`中 (medium)`;
      case 'low': return t`低 (low)`;
      case 'minimal': return t`极低 (minimal)`;
      case 'thinking': return t`思考 (默认)`;
      case 'none': return t`未开启思考`;
      default: return fallback;
    }
  };
  const rawRows = efforts?.rows ?? [];
  const rows = [...rawRows].sort((a, b) => {
    const val = (row: (typeof rawRows)[number]) => metric === 'tokens' ? row.totalTokens : row.count;
    const diff = val(b) - val(a);
    if (diff !== 0) return diff;
    return EFFORT_RANK_ORDER.indexOf(a.key) - EFFORT_RANK_ORDER.indexOf(b.key);
  });
  const { index, setIndex, onKeyDown } = useRovingIndex(rows.length);

  const totalRuns = rows.reduce((sum, row) => sum + row.count, 0);
  const thinkingRows = rows.filter((row) => row.key !== 'none');
  const thinkingRuns = thinkingRows.reduce((sum, row) => sum + row.count, 0);
  const thinkingShare = totalRuns > 0 ? thinkingRuns / totalRuns : null;
  const reasoningTokens = summary.current.tokens.reasoning;
  const outputTokens = summary.current.tokens.output;
  const reasoningShare = reasoningTokens != null && outputTokens != null && outputTokens > 0
    ? reasoningTokens / outputTokens
    : null;

  const maxVal = rows.reduce((best, row) => {
    const value = metric === 'tokens' ? row.totalTokens : row.count;
    return value > best ? value : best;
  }, 0);
  const totalMetric = rows.reduce((sum, row) => sum + (metric === 'tokens' ? row.totalTokens : row.count), 0);

  const options: Array<{ value: EffortMetric; label: string }> = [
    { value: 'runs', label: t`次数` },
    { value: 'tokens', label: 'Token' },
  ];

  return (
    <ChartCard
      title={t`思考统计`}
      actions={<Segmented size="xs" ariaLabel={t`思考统计维度`} value={metric} options={options} onChange={setMetric} />}
    >
      <div className="grid grid-cols-3 gap-3 rounded-lg bg-subtle px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs text-fg-3"><Trans>思考次数</Trans></span>
          <div className="flex items-baseline gap-1.5 truncate tabular-nums">
            <span className="text-sm font-medium text-fg">{totalRuns > 0 ? formatCount(thinkingRuns) : <Unavailable />}</span>
            {thinkingShare != null && <span className="text-2xs text-fg-3">{formatPercent(thinkingShare)}</span>}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs text-fg-3"><Trans>思考输出</Trans></span>
          <div className="flex items-baseline gap-1.5 truncate tabular-nums">
            <span className="text-sm font-medium text-fg">{reasoningTokens != null ? formatTokens(reasoningTokens) : <Unavailable />}</span>
            {reasoningShare != null && <span className="text-2xs text-fg-3">{formatPercent(reasoningShare)}</span>}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs text-fg-3"><Trans>最高频档位</Trans></span>
          <span className="truncate text-sm font-medium text-fg">
            {thinkingRows[0] ? effortLabel(thinkingRows[0].key, thinkingRows[0].label) : <Unavailable />}
          </span>
        </div>
      </div>
      {rows.length === 0 ? <EmptyNote><Trans>还没有思考档位记录</Trans></EmptyNote> : (
        <div role="listbox" aria-label={t`思考档位分布`} tabIndex={0} className="stats-chart flex flex-col gap-2.5 outline-none" onKeyDown={onKeyDown}>
          {rows.map((row, rowIndex) => {
            const value = metric === 'tokens' ? row.totalTokens : row.count;
            const width = maxVal > 0 ? Math.max((value / maxVal) * 100, value > 0 ? 1.2 : 0) : 0;
            const share = totalMetric > 0 ? value / totalMetric : 0;
            const label = effortLabel(row.key, row.label);
            const isNone = row.key === 'none';
            return (
              <div
                key={row.key}
                role="option"
                aria-selected={index === rowIndex}
                className="grid grid-cols-[minmax(0,7rem)_1fr_4.25rem_3.25rem] items-center gap-2"
                onMouseEnter={() => setIndex(rowIndex)}
              >
                <span className="truncate text-xs text-fg-2">{label}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                    style={{ width: `${width}%`, background: isNone ? 'var(--fg-4)' : 'var(--accent)' }}
                  />
                </span>
                <span className="text-right text-xs tabular-nums text-fg">
                  {metric === 'tokens' ? formatTokens(value) : formatCount(value)}
                </span>
                <span className="text-right text-xs tabular-nums text-fg-3">
                  {formatPercent(share)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}

export function TokenCompositionChart({ summary, models }: { summary: StatsSummary; models: StatsBreakdown }) {
  const { t } = useLingui();
  const tokens = summary.current.tokens;
  const cacheRead = tokens.cacheRead ?? 0;
  const uncachedInput = tokens.input ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const reasoning = tokens.reasoning ?? 0;
  const regularOutput = Math.max(0, (tokens.output ?? 0) - reasoning);

  const segments = [
    { key: 'cacheRead', label: t`缓存读`, value: cacheRead, reported: tokens.cacheRead != null, color: 'var(--chart-2)' },
    { key: 'input', label: t`未缓存输入`, value: uncachedInput, reported: tokens.input != null, color: 'var(--chart-1)' },
    { key: 'cacheWrite', label: t`缓存写`, value: cacheWrite, reported: tokens.cacheWrite != null, color: 'var(--chart-4)' },
    { key: 'output', label: t`常规输出`, value: regularOutput, reported: tokens.output != null, color: 'var(--chart-3)' },
    { key: 'reasoning', label: t`思考输出`, value: reasoning, reported: tokens.reasoning != null && reasoning > 0, color: 'var(--chart-5)' },
  ].filter((item) => item.reported && item.value > 0);

  const total = segments.reduce((sum, item) => sum + item.value, 0);

  const modelCacheRows = models.rows
    .map((row) => ({ row, hitRate: rowCacheHitRate(row.tokens) }))
    .filter((entry): entry is { row: (typeof models.rows)[number]; hitRate: number } => entry.hitRate != null)
    .sort((a, b) => b.row.totalTokens - a.row.totalTokens)
    .slice(0, 5);

  return (
    <ChartCard title={t`Token 构成与缓存`}>
      {total <= 0 ? <EmptyNote><Trans>还没有可拆解的 Token 数据</Trans></EmptyNote> : (
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-2.5">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
              {segments.map((segment) => (
                <Tip key={segment.key} label={`${segment.label} · ${formatTokens(segment.value)} (${formatPercent(segment.value / total)})`}>
                  <span
                    className="h-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                    style={{ width: `${Math.max((segment.value / total) * 100, 1)}%`, background: segment.color }}
                  />
                </Tip>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
              {segments.map((segment) => (
                <div key={segment.key} className="grid grid-cols-[auto_1fr_auto_2.75rem] items-center gap-1.5 text-2xs">
                  <LegendSwatch color={segment.color} />
                  <span className="truncate text-fg-3">{segment.label}</span>
                  <span className="text-right tabular-nums text-fg-2">{formatTokens(segment.value)}</span>
                  <span className="text-right tabular-nums text-fg-4">{formatPercent(segment.value / total)}</span>
                </div>
              ))}
            </div>
          </div>
          {modelCacheRows.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
              <div className="grid grid-cols-[minmax(0,9rem)_1fr_3.5rem_4rem] items-center gap-2 text-2xs text-fg-3">
                <span><Trans>各模型缓存命中率</Trans></span>
                <span />
                <span className="text-right"><Trans>命中率</Trans></span>
                <span className="text-right"><Trans>缓存读</Trans></span>
              </div>
              {modelCacheRows.map(({ row, hitRate }) => (
                <div key={row.key} className="grid grid-cols-[minmax(0,9rem)_1fr_3.5rem_4rem] items-center gap-2">
                  <Tip label={row.label}><span className="truncate text-xs text-fg-2">{ellipsizeMiddle(row.label)}</span></Tip>
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                      style={{ width: `${Math.max(hitRate * 100, hitRate > 0 ? 1 : 0)}%`, background: 'var(--chart-2)' }}
                    />
                  </span>
                  <span className="text-right text-xs tabular-nums text-fg">{formatPercent(hitRate)}</span>
                  <span className="text-right text-xs tabular-nums text-fg-3">{formatTokens(row.tokens.cacheRead)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </ChartCard>
  );
}

export function ProjectChart({ breakdown }: { breakdown?: StatsBreakdown }) {
  const { t } = useLingui();
  const [metric, setMetric] = useState<ProjectMetric>('tokens');
  const { highlight, setHighlight } = useHighlight();
  const rawRows = breakdown?.rows ?? [];
  const valueOf = (row: (typeof rawRows)[number]) => {
    if (metric === 'runs') return row.count;
    if (metric === 'sessions') return row.sessions;
    return row.totalTokens;
  };
  const rows = [...rawRows].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 8);
  const { index, setIndex, onKeyDown } = useRovingIndex(rows.length);
  const max = rows.reduce((best, row) => Math.max(best, valueOf(row)), 0);
  const total = rows.reduce((sum, row) => sum + valueOf(row), 0);

  const options: Array<{ value: ProjectMetric; label: string }> = [
    { value: 'tokens', label: 'Token' },
    { value: 'runs', label: t`轮次` },
    { value: 'sessions', label: t({ message: '会话', context: 'common-metric-sessions' }) },
  ];

  return (
    <ChartCard
      title={t`项目分布`}
      actions={<Segmented size="xs" ariaLabel={t`项目排序`} value={metric} options={options} onChange={setMetric} />}
    >
      {rows.length === 0 ? <EmptyNote><Trans>还没有项目数据</Trans></EmptyNote> : (
        <div role="listbox" aria-label={t`项目分布`} tabIndex={0} className="stats-chart flex flex-col gap-2.5 outline-none" onKeyDown={onKeyDown}>
          {rows.map((row, rowIndex) => {
            const value = valueOf(row);
            const width = max > 0 ? Math.max((value / max) * 100, value > 0 ? 1 : 0) : 0;
            const share = total > 0 ? value / total : 0;
            return (
              <div
                key={row.key}
                role="option"
                aria-selected={index === rowIndex}
                className="grid grid-cols-[minmax(0,9rem)_1fr_4.25rem_3.25rem] items-center gap-2"
                style={{ opacity: seriesOpacity(row, highlight) }}
                onMouseEnter={() => { setIndex(rowIndex); setHighlight(row); }}
                onMouseLeave={() => setHighlight(null)}
              >
                <Tip label={row.label}><span className="truncate text-xs text-fg-2">{row.label}</span></Tip>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                    style={{ width: `${width}%`, background: 'var(--accent)' }}
                  />
                </span>
                <span className="text-right text-xs tabular-nums text-fg">
                  {metric === 'tokens' ? formatTokens(value) : formatCount(value)}
                </span>
                <span className="text-right text-xs tabular-nums text-fg-3">
                  {formatPercent(share)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}

export function AutonomyChart({ autonomy, summary }: { autonomy?: StatsAutonomy; summary: StatsSummary }) {
  const { t } = useLingui();
  const bucketLabel = (key: StatsStepBucket['key']): string => {
    switch (key) {
      case '1': return t`1 步`;
      case '2-4': return t`2–4 步`;
      case '5-9': return t`5–9 步`;
      case '10+': return t`10+ 步`;
    }
  };

  const avgSteps = autonomy?.averageStepsPerRun ?? null;
  const runsPerSession = autonomy?.runsPerSession ?? (summary.current.sessions > 0 ? summary.current.runs / summary.current.sessions : null);
  const subagentSteps = autonomy?.subagentSteps ?? summary.current.subagents;
  const mainTokens = autonomy?.mainTokens ?? summary.current.totalTokens;
  const subagentTokens = autonomy?.subagentTokens ?? 0;
  const totalAgentTokens = mainTokens + subagentTokens;
  const subagentTokenShare = totalAgentTokens > 0 ? subagentTokens / totalAgentTokens : null;

  const buckets = autonomy?.stepBuckets ?? [];
  const maxBucketRuns = buckets.reduce((best, bucket) => Math.max(best, bucket.runs), 0);
  const hasBuckets = maxBucketRuns > 0;

  return (
    <ChartCard title={t`自主度与子 Agent`}>
      <div className="grid grid-cols-3 gap-3 rounded-lg bg-subtle px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs text-fg-3"><Trans>单轮平均步数</Trans></span>
          <span className="truncate text-sm font-medium tabular-nums text-fg">
            {avgSteps != null ? (
              <Tip label={autonomy?.stepsPerRun ? t`p50 ${Math.round(autonomy.stepsPerRun.p50)} 步 · p90 ${Math.round(autonomy.stepsPerRun.p90)} 步` : t`单轮模型请求步数均值`}>
                <span className="cursor-help">{Math.round(avgSteps * 10) / 10}</span>
              </Tip>
            ) : <Unavailable />}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs text-fg-3"><Trans>单会话轮次</Trans></span>
          <span className="truncate text-sm font-medium tabular-nums text-fg">
            {runsPerSession != null ? Math.round(runsPerSession * 10) / 10 : <Unavailable />}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs text-fg-3"><Trans>子 Agent 步数</Trans></span>
          <div className="flex items-baseline gap-1.5 truncate tabular-nums">
            <span className="text-sm font-medium text-fg">{formatCount(subagentSteps)}</span>
            {subagentTokenShare != null && subagentTokenShare > 0 && (
              <span className="text-2xs text-fg-3">{formatPercent(subagentTokenShare)}</span>
            )}
          </div>
        </div>
      </div>

      {!hasBuckets ? <EmptyNote><Trans>还没有轮次步数分布</Trans></EmptyNote> : (
        <div className="flex flex-col gap-2.5">
          {buckets.map((bucket) => {
            const width = maxBucketRuns > 0 ? Math.max((bucket.runs / maxBucketRuns) * 100, bucket.runs > 0 ? 1 : 0) : 0;
            return (
              <div key={bucket.key} className="grid grid-cols-[minmax(0,5.5rem)_1fr_4.25rem_3.25rem] items-center gap-2">
                <span className="truncate text-xs text-fg-2">{bucketLabel(bucket.key)}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                    style={{ width: `${width}%`, background: 'var(--accent)' }}
                  />
                </span>
                <span className="text-right text-xs tabular-nums text-fg">{formatCount(bucket.runs)}</span>
                <span className="text-right text-xs tabular-nums text-fg-3">{formatPercent(bucket.share)}</span>
              </div>
            );
          })}
        </div>
      )}

      {totalAgentTokens > 0 && (
        <div className="mt-auto flex flex-col gap-2 border-t border-line-soft pt-3">
          <div className="flex items-center justify-between text-2xs text-fg-3">
            <span><Trans>主 / 子 Agent 用量分担</Trans></span>
            <span className="tabular-nums">
              <Trans>主 {formatTokens(mainTokens)} · 子 {formatTokens(subagentTokens)}</Trans>
            </span>
          </div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
            <span
              className="h-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
              style={{ width: `${(mainTokens / totalAgentTokens) * 100}%`, background: 'var(--chart-1)' }}
            />
            {subagentTokens > 0 && (
              <span
                className="h-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                style={{ width: `${(subagentTokens / totalAgentTokens) * 100}%`, background: 'var(--chart-5)' }}
              />
            )}
          </div>
          {autonomy?.subagentTypes && autonomy.subagentTypes.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {autonomy.subagentTypes.map((item) => (
                <span key={item.key} className="inline-flex items-center gap-1 rounded-md bg-subtle px-2 py-0.5 text-2xs text-fg-2 tabular-nums">
                  <span>{item.key}</span>
                  <span className="text-fg-4">·</span>
                  <span>{formatCount(item.count)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </ChartCard>
  );
}

