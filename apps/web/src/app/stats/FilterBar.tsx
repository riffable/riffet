import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { isNativeBackendId, type StatsKeyInfo } from '@contracts';
import { IconChevronDown, IconDownload } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { dateInputValue, resolveWindow, type StatsRangePreset, type StatsUiState } from '@/lib/stats-query';
import { seriesColor } from '@/lib/stats-series';
import { cn } from '@/lib/utils';

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function inclusiveEnd(iso: string): string {
  const date = new Date(iso);
  date.setMilliseconds(date.getMilliseconds() - 1);
  return dateInputValue(date.toISOString());
}

/** A measured height, so a sticky sibling can sit exactly below a bar that wraps to any number of rows. */
function useMeasuredHeight(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const apply = () => setHeight(node.offsetHeight);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, height];
}

export function FilterBar({ state, options, onChange, onExport }: {
  state: StatsUiState;
  options?: { backends: StatsKeyInfo[]; models: StatsKeyInfo[]; projects: StatsKeyInfo[] };
  onChange: (state: StatsUiState) => void;
  onExport: (format: 'csv' | 'json') => void;
}) {
  const { t } = useLingui();
  const ranges: Array<{ value: StatsRangePreset; label: string }> = [
    { value: 'today', label: t`今天` },
    { value: '7d', label: t`7 天` },
    { value: '30d', label: t`30 天` },
    { value: '90d', label: t`90 天` },
    { value: '1y', label: t`1 年` },
    { value: 'all', label: t`全部` },
    { value: 'custom', label: t`自定义` },
  ];
  const agents = options?.backends ?? [];
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Published so the detail table's header can stick directly beneath this bar when the filters open.
  const [barRef, barHeight] = useMeasuredHeight();
  const activeFilterCount = state.backends.length + state.models.length + state.projects.length + Number(!state.includeEstimated);
  const rangeLabel = state.preset === 'custom'
    ? t`自定义`
    : ranges.find((range) => range.value === state.preset)?.label ?? t`时间范围`;
  const choose = (preset: StatsRangePreset) => {
    if (preset !== 'custom') {
      onChange({ ...state, preset, from: undefined, to: undefined });
      return;
    }
    const window = resolveWindow(state.preset === 'custom' ? state : { ...state, preset: '30d' }, new Date());
    onChange({ ...state, preset: 'custom', from: dateInputValue(window.from), to: inclusiveEnd(window.to) });
  };
  return (
    <div
      ref={barRef}
      style={{ '--stats-filter-height': `${barHeight}px` } as CSSProperties}
      className="sticky top-0 z-10 flex flex-col gap-2 bg-bg/95 pb-3 pt-3 backdrop-blur-sm"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="secondary" className="max-w-[min(14rem,45vw)] px-2.5" aria-label={t`时间范围：${rangeLabel}`}>
              <span className="truncate">{rangeLabel}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel><Trans>时间范围</Trans></DropdownMenuLabel>
            <DropdownMenuRadioGroup value={state.preset} onValueChange={(value) => choose(value as StatsRangePreset)}>
              {ranges.map((range) => <DropdownMenuRadioItem key={range.value} value={range.value}>{range.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {state.preset === 'custom' && (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="secondary" className="px-2.5" aria-label={t`编辑自定义日期：${dateInputValue(state.from)} 至 ${dateInputValue(state.to)}`}>
                <Trans>日期</Trans>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(22rem,calc(100vw-1rem))] p-3">
              <p className="mb-2 text-xs font-medium text-fg-2"><Trans>自定义日期范围</Trans></p>
              <div className="flex items-center gap-2">
                <input aria-label={t`开始日期`} type="date" value={dateInputValue(state.from)} onChange={(event) => onChange({ ...state, from: event.target.value })} className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-elevated px-2 text-xs text-fg" />
                <span aria-hidden className="text-fg-4">–</span>
                <input aria-label={t`结束日期`} type="date" value={dateInputValue(state.to)} onChange={(event) => onChange({ ...state, to: event.target.value })} className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-elevated px-2 text-xs text-fg" />
              </div>
            </PopoverContent>
          </Popover>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={filtersOpen}
            aria-controls={filtersOpen ? 'stats-advanced-filters' : undefined}
            aria-label={activeFilterCount ? t`筛选，${activeFilterCount} 项已启用` : t({ message: '筛选', context: 'stats-filters-label' })}
            onClick={() => setFiltersOpen((open) => !open)}
            className={cn('px-2 md:px-2.5', activeFilterCount > 0 && 'border-line-strong text-fg')}
          >
            <Trans context="stats-filters-label">筛选</Trans>{activeFilterCount > 0 && <span className="ml-0.5 rounded-full bg-accent-soft px-1.5 text-2xs leading-4 text-accent">{activeFilterCount}</span>}
            <IconChevronDown className={cn('size-3.5 text-fg-4 transition-transform', filtersOpen && 'rotate-180')} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="secondary" className="px-2 md:px-2.5" aria-label={t`导出数据`}><IconDownload /><span className="max-md:hidden"><Trans>导出</Trans></span></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onExport('csv')}><Trans>导出 CSV</Trans></DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport('json')}><Trans>导出 JSON</Trans></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {filtersOpen && (
        <div id="stats-advanced-filters" className="flex flex-wrap items-center gap-1.5 border-t border-line/70 pt-2">
          <MultiSelect
            label="Agent"
            options={agents}
            colors={agents.map((agent) => seriesColor(agent, 0))}
            selected={state.backends}
            onChange={(backends) => onChange({ ...state, backends: backends.filter(isNativeBackendId) })}
          />
          <MultiSelect label={t`模型`} options={options?.models ?? []} selected={state.models} onChange={(models) => onChange({ ...state, models })} />
          <MultiSelect label={t`项目`} options={options?.projects ?? []} selected={state.projects} onChange={(projects) => onChange({ ...state, projects })} />
          <button
            type="button"
            aria-pressed={state.includeEstimated}
            onClick={() => onChange({ ...state, includeEstimated: !state.includeEstimated })}
            className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors', state.includeEstimated ? 'border-line-strong bg-active text-fg' : 'border-line text-fg-3 hover:bg-hover hover:text-fg')}
          >
            <span className="size-1.5 rounded-full bg-warning" aria-hidden />
            <Trans>含估算</Trans>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * One dropdown per dimension. Agents used to be loose colour pills on their own line, which made the
 * bar three rows tall on a phone and said nothing a checked item cannot say.
 */
function MultiSelect({ label, options, selected, onChange, colors }: { label: string; options: StatsKeyInfo[]; selected: string[]; onChange: (next: string[]) => void; colors?: string[] }) {
  const single = options.find((option) => option.key === selected[0])?.label;
  const text = selected.length === 0
    ? label
    : selected.length === 1
      ? single ?? selected[0]
      : `${label} · ${selected.length}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" className={cn('max-w-40', selected.length > 0 && 'border-line-strong text-fg')} aria-label={label}>
          <span className="truncate">{text}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="start">
        {options.length === 0 ? <DropdownMenuLabel><Trans>暂无选项</Trans></DropdownMenuLabel> : options.map((option, index) => (
          <DropdownMenuCheckboxItem
            key={option.key}
            checked={selected.includes(option.key)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onChange(toggle(selected, option.key))}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              {colors?.[index] && <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: colors[index] }} />}
              <span className="truncate">{option.label}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
