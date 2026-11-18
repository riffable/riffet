import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { NativeBackendId, StatsBreakdownRow, StatsHeatmap, StatsKeyInfo, StatsPercentiles, StatsRunStates, StatsSeries, StatsSummary, StatsTokens } from '@contracts';
import { scaleLinear } from 'd3-scale';
import { curveBumpX, curveMonotoneX, area, line, pie, arc } from 'd3-shape';
import type { KpiFormat } from './stats-format';
import type { RankMetric } from './stats-query';

/** Shared sample count for consumers that explicitly need two arrays on one interpolation grid. */
export const TWEEN_SAMPLES = 48;
/** Weekday names, Monday-first to match the heatmap rows; translated where they are rendered. */
export const WEEKDAY_NAMES = [msg`周一`, msg`周二`, msg`周三`, msg`周四`, msg`周五`, msg`周六`, msg`周日`] as const;
export const HEAT_ALPHA = [0, 0.18, 0.38, 0.62, 0.9] as const;

export interface SeriesRef { key: string; backendId?: NativeBackendId }

export interface KpiModel {
  id: string;
  label: string;
  value: number | null;
  previous: number | null;
  format: KpiFormat;
  lowerIsBetter: boolean;
  estimated: boolean;
  note?: string;
  spark: Array<number | null> | null;
}

export interface StackLayer {
  key: string;
  label: string;
  backendId?: NativeBackendId;
  /** Null where the whole bucket reported nothing. A zero-height band is a real zero contribution. */
  bands: Array<{ y0: number; y1: number } | null>;
  /** Null when this series omitted the bucket. Absent is not drawn as a measured zero in the tooltip. */
  reported: Array<number | null>;
}

export interface StackedSeries {
  layers: StackLayer[];
  /** Epoch millis of each point, aligned with `bands`. */
  starts: number[];
  totals: Array<number | null>;
  max: number;
}

export interface TweenLayer {
  key: string;
  label: string;
  backendId?: NativeBackendId;
  /** Original bucket starts. Keeping these avoids inventing points between measurements. */
  starts: number[];
  y0: Array<number | null>;
  y1: Array<number | null>;
}

export interface DonutSlice {
  key: string;
  label: string;
  backendId?: NativeBackendId;
  value: number;
  share: number;
  startAngle: number;
  endAngle: number;
}

export interface CalendarCell {
  date: string;
  runs: number;
  totalTokens: number;
  inRange: boolean;
}

/** Sum of reported numbers. An empty record is unavailable, not zero. */
export function pointTotal(values: Record<string, number> | undefined): number | null {
  if (!values) return null;
  const nums = Object.values(values).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + Math.max(0, value), 0);
}

export function stackSeries(series: StatsSeries): StackedSeries {
  const layers: StackLayer[] = series.keys.map((key) => ({
    key: key.key,
    label: key.label,
    ...(key.backendId ? { backendId: key.backendId } : {}),
    bands: [],
    reported: [],
  }));
  const starts: number[] = [];
  const totals: Array<number | null> = [];
  let max = 0;
  for (const point of series.points) {
    const start = Date.parse(point.start);
    starts.push(Number.isFinite(start) ? start : 0);
    const reportedValues = layers.map((layer) => {
      const raw = point.values[layer.key];
      return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, raw) : null;
    });
    if (!reportedValues.some((value) => value != null)) {
      totals.push(null);
      for (const layer of layers) {
        layer.bands.push(null);
        layer.reported.push(null);
      }
      continue;
    }
    let y = 0;
    for (const [index, layer] of layers.entries()) {
      const reported = reportedValues[index] ?? null;
      const height = reported ?? 0;
      layer.bands.push({ y0: y, y1: y + height });
      layer.reported.push(reported);
      y += height;
    }
    totals.push(y);
    max = Math.max(max, y);
  }
  return { layers, starts, totals, max };
}

/** Even resample. Nulls stay null so a gap is never filled with zero. */
export function resample(values: Array<number | null>, count: number): Array<number | null> {
  if (count <= 0) return [];
  if (!values.length) return Array.from({ length: count }, () => null);
  if (values.length === 1 || count === 1) return Array.from({ length: count }, () => values[0] ?? null);
  const out: Array<number | null> = [];
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * (values.length - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(values.length - 1, i0 + 1);
    const a = values[i0] ?? null;
    const b = values[i1] ?? null;
    if (a == null || b == null) out.push(null);
    else out.push(a + (b - a) * (t - i0));
  }
  return out;
}

/** Resample onto evenly spaced instants so a path lines up with a time axis. */
export function resampleTime(times: number[], values: Array<number | null>, count: number): Array<number | null> {
  if (count <= 0) return [];
  if (!times.length || times.length !== values.length) return resample(values, count);
  const start = times[0] ?? 0;
  const end = times[times.length - 1] ?? start;
  if (!(end > start)) return resample(values, count);
  const out: Array<number | null> = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? start : start + (i / (count - 1)) * (end - start);
    out.push(sampleAt(times, values, t));
  }
  return out;
}

function sampleAt(times: number[], values: Array<number | null>, t: number): number | null {
  const first = times[0] ?? 0;
  if (t <= first) return values[0] ?? null;
  for (let i = 1; i < times.length; i++) {
    const right = times[i] ?? 0;
    if (t > right) continue;
    if (t === right) return values[i] ?? null;
    const left = times[i - 1] ?? right;
    const a = values[i - 1] ?? null;
    const b = values[i] ?? null;
    if (a == null || b == null) return null;
    const span = right - left;
    const f = span === 0 ? 0 : (t - left) / span;
    return a + (b - a) * f;
  }
  return values[values.length - 1] ?? null;
}

/** Interpolate only where both sides were measured. A null never becomes a midpoint of zero. */
export function mixNullable(from: Array<number | null>, to: Array<number | null>, t: number): Array<number | null> {
  const count = Math.max(from.length, to.length);
  const out: Array<number | null> = [];
  for (let i = 0; i < count; i++) {
    const a = from[i] ?? null;
    const b = to[i] ?? null;
    if (a == null || b == null) out.push(null);
    else out.push(a + (b - a) * t);
  }
  return out;
}

export function alignSeries(from: Array<number | null>, to: Array<number | null>, samples = TWEEN_SAMPLES): { from: Array<number | null>; to: Array<number | null> } {
  return { from: resample(from, samples), to: resample(to, samples) };
}

export function tweenLayers(series: StatsSeries): TweenLayer[] {
  const stacked = stackSeries(series);
  return stacked.layers.map((layer) => ({
    key: layer.key,
    label: layer.label,
    ...(layer.backendId ? { backendId: layer.backendId } : {}),
    starts: stacked.starts,
    y0: layer.bands.map((band) => band?.y0 ?? null),
    y1: layer.bands.map((band) => band?.y1 ?? null),
  }));
}

export function linearTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max < min) return linearTicks(max, min, count);
  if (max === min) return [min];
  return scaleLinear().domain([min, max]).ticks(Math.max(1, count));
}

export function niceUpper(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const scale = scaleLinear().domain([0, max]).nice(4);
  const upper = scale.domain()[1];
  return typeof upper === 'number' && upper > 0 ? upper : max;
}

function yOf(value: number, height: number, yMax: number): number {
  const bounded = Math.max(0, Math.min(value, yMax));
  return height - (bounded / yMax) * height;
}

interface BandPoint { x: number; y0: number; y1: number }

const areaPath = area<BandPoint>()
  .x((point) => point.x)
  .y0((point) => point.y0)
  .y1((point) => point.y1)
  .curve(curveBumpX);

export function stackAreaPath(y0: Array<number | null>, y1: Array<number | null>, width: number, height: number, yMax: number, starts?: number[]): string {
  if (width <= 0 || height <= 0 || yMax <= 0) return '';
  return bandSegments(y0, y1, width, height, yMax, starts)
    .filter((segment) => segment.points.length > 1)
    .map((segment) => areaPath(segment.points) ?? '')
    .filter(Boolean)
    .join(' ');
}

export interface BandSegment {
  /** Actual lower and upper stack boundaries, in drawing order. */
  points: BandPoint[];
}

/**
 * Split a band into the runs of samples that were actually measured. A run of a single sample still
 * yields a segment for its edge dash, while the zero-width area itself is omitted.
 */
export function bandSegments(y0: Array<number | null>, y1: Array<number | null>, width: number, height: number, yMax: number, starts?: number[]): BandSegment[] {
  if (width <= 0 || height <= 0 || yMax <= 0) return [];
  const segments: BandSegment[] = [];
  let points: BandPoint[] = [];
  const flush = () => {
    if (points.length) segments.push({ points });
    points = [];
  };
  y1.forEach((value, index) => {
    const low = y0[index];
    if (value == null || low == null || !Number.isFinite(value) || !Number.isFinite(low)) {
      flush();
      return;
    }
    const base = Math.max(0, Math.min(low, yMax));
    const top = Math.max(base, Math.min(value, yMax));
    points.push({ x: xAtSample(index, y1.length, width, starts), y0: yOf(base, height, yMax), y1: yOf(top, height, yMax) });
  });
  flush();
  return segments;
}

export function stackLinePath(y1: Array<number | null>, width: number, height: number, yMax: number, starts?: number[]): string {
  if (width <= 0 || height <= 0 || yMax <= 0) return '';
  return joinSegments(y1, (top, index) => {
    if (top == null || !Number.isFinite(top)) return null;
    return { x: xAtSample(index, y1.length, width, starts), y: yOf(Math.max(0, top), height, yMax) };
  }, (segment) => line<{ x: number; y: number }>().x((d) => d.x).y((d) => d.y).curve(curveBumpX)(segment) ?? '');
}

/**
 * A dash between the last measured sample before a gap and the first one after it. A stack is drawn
 * as separate runs, so without this a hole in the data would silently close up and read as a
 * continuous measurement.
 */
export function gapPath(y0: Array<number | null>, y1: Array<number | null>, width: number, height: number, yMax: number, starts?: number[]): string {
  if (width <= 0 || height <= 0 || yMax <= 0) return '';
  const measured = (index: number) => y1[index] != null && y0[index] != null && Number.isFinite(y1[index]) && Number.isFinite(y0[index]);
  const point = (index: number) => ({ x: xAtSample(index, y1.length, width, starts), y: yOf(Math.max(0, y1[index] as number), height, yMax) });
  const parts: string[] = [];
  for (let index = 1; index < y1.length; index += 1) {
    // Only the edges of a hole: a measured neighbour on either side with something missing between.
    if (!measured(index) || measured(index - 1)) continue;
    if (!measured(index - 2)) continue;
    parts.push(line<{ x: number; y: number }>().x((d) => d.x).y((d) => d.y)([point(index - 2), point(index)]) ?? '');
  }
  return parts.filter(Boolean).join(' ');
}

/** A level horizontal dash: how a run with exactly one measured sample is drawn. */
export function flatDashPath(y1: Array<number | null>, width: number, height: number, yMax: number, radius = 6, starts?: number[]): string {
  if (width <= 0 || height <= 0 || yMax <= 0) return '';
  const parts: string[] = [];
  let runStart = -1;
  let runLength = 0;
  const flush = () => {
    if (runLength === 1 && runStart >= 0) {
      const point = { x: xAtSample(runStart, y1.length, width, starts), y: yOf(Math.max(0, y1[runStart] as number), height, yMax) };
      const half = Math.min(radius, Math.max(1, width / 2));
      parts.push(`M ${point.x - half} ${point.y} L ${point.x + half} ${point.y}`);
    }
    runStart = -1;
    runLength = 0;
  };
  y1.forEach((value, index) => {
    if (value == null || !Number.isFinite(value)) {
      flush();
      return;
    }
    if (runStart < 0) runStart = index;
    runLength += 1;
  });
  flush();
  return parts.join(' ');
}

function xOf(index: number, count: number, width: number): number {
  if (count <= 1) return width / 2;
  return (index / (count - 1)) * width;
}

function xAtSample(index: number, count: number, width: number, starts?: number[]): number {
  if (!starts || starts.length !== count || count <= 1) return xOf(index, count, width);
  const first = starts[0] ?? 0;
  const last = starts[count - 1] ?? first;
  const at = starts[index] ?? first;
  return last > first && Number.isFinite(at) ? ((at - first) / (last - first)) * width : xOf(index, count, width);
}

function joinSegments<T>(values: Array<number | null>, map: (value: number | null, index: number) => T | null, draw: (segment: T[]) => string): string {
  const segments: T[][] = [];
  let current: T[] = [];
  values.forEach((value, index) => {
    const point = map(value, index);
    if (!point) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push(point);
  });
  if (current.length) segments.push(current);
  return segments.filter((segment) => segment.length > 1).map(draw).join(' ');
}

/** The sparkline inside a KPI card. One measured sample is a dot; nothing measured is no line. */
export function sparkPath(values: Array<number | null>, width: number, height: number): string {
  const nums = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (nums.length < 1 || width <= 0 || height <= 0) return '';
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  return joinSegments(values, (value, index) => {
    if (value == null) return null;
    return { x: xOf(index, values.length, width), y: height - ((value - min) / span) * (height - 2) - 1 };
  }, (segment) => segment.length === 1
    ? `M ${segment[0]!.x - 1.5} ${segment[0]!.y} L ${segment[0]!.x + 1.5} ${segment[0]!.y}`
    : line<{ x: number; y: number }>().x((d) => d.x).y((d) => d.y).curve(curveMonotoneX)(segment) ?? '');
}

/** The built-in Agents' fixed chart slots. Any other Agent takes a slot from its id's hash, like a model or a project. */
const BACKEND_CHART_SLOT: Partial<Record<NativeBackendId, number>> = {
  cursor: 0,
  codex: 1,
  claude: 2,
  dsh: 3,
  droid: 4,
  traex: 5,
  chat: 6,
  pi: 7,
};

function backendSlot(key: SeriesRef): number | undefined {
  const id = key.backendId ?? key.key;
  return Object.hasOwn(BACKEND_CHART_SLOT, id) ? BACKEND_CHART_SLOT[id as NativeBackendId] : undefined;
}

/** Java String.hashCode over UTF-16 code units, used so category colors survive reordering. */
function stableKeyHash(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0;
  }
  return hash;
}

export function seriesColor(key: SeriesRef, _index?: number): string {
  const slot = backendSlot(key) ?? ((stableKeyHash(key.backendId ?? key.key) % 8) + 8) % 8;
  return `var(--chart-${slot + 1})`;
}

/** Allocate distinct slots for the visible categories, independent of their ranking order.
 * Agent keys reserve their fixed slots; model metadata must not collapse every model of one Agent
 * into the same colour. The server caps a trend at eight categories, matching this palette. */
export function seriesColors(keys: readonly SeriesRef[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<number>();
  const ordered = [...new Set(keys.map((key) => key.key))].sort();
  for (const key of ordered) {
    const slot = backendSlot({ key });
    if (slot !== undefined) { result.set(key, `var(--chart-${slot + 1})`); used.add(slot); }
  }
  for (const key of ordered) {
    if (result.has(key)) continue;
    const preferred = ((stableKeyHash(key) % 8) + 8) % 8;
    let slot = preferred;
    for (let probe = 0; probe < 8 && used.has(slot); probe += 1) slot = (slot + 1) % 8;
    used.add(slot);
    result.set(key, `var(--chart-${slot + 1})`);
  }
  return result;
}

export function isHighlighted(key: SeriesRef, highlight: SeriesRef | null): boolean {
  if (!highlight) return false;
  if (highlight.key === key.key) return true;
  return Boolean(highlight.backendId && (key.backendId === highlight.backendId || key.key === highlight.backendId));
}

export function seriesOpacity(key: SeriesRef, highlight: SeriesRef | null): number {
  if (!highlight) return 1;
  return isHighlighted(key, highlight) ? 1 : 0.16;
}

export function successRate(states: StatsRunStates | undefined): number | null {
  if (!states) return null;
  const total = states.completed + states.failed + states.cancelled + states.interrupted;
  if (total <= 0) return null;
  return states.completed / total;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildKpis(summary: StatsSummary, series: StatsSeries): KpiModel[] {
  const current = summary.current;
  const previous = summary.previous;
  const spark = (metric: StatsSeries['metric']): Array<number | null> | null => {
    if (series.metric !== metric) return null;
    const values = series.points.map((point) => pointTotal(point.values));
    return values.some((value) => value != null) ? values : null;
  };
  return [
    { id: 'tokens', label: i18n._(msg`总 token`), value: finite(current.totalTokens), previous: finite(previous.totalTokens), format: 'tokens', lowerIsBetter: false, estimated: (current.tokens?.estimatedOutput ?? 0) > 0, spark: spark('totalTokens') },
    { id: 'runs', label: i18n._(msg`轮次`), value: finite(current.runs), previous: finite(previous.runs), format: 'count', lowerIsBetter: false, estimated: false, spark: spark('runs') },
    { id: 'sessions', label: i18n._(msg({ message: '会话', context: 'common-metric-sessions' })), value: finite(current.sessions), previous: finite(previous.sessions), format: 'count', lowerIsBetter: false, estimated: false, spark: spark('sessions') },
    { id: 'days', label: i18n._(msg`活跃天数`), value: finite(current.activeDays), previous: finite(previous.activeDays), format: 'days', lowerIsBetter: false, estimated: false, note: i18n._(msg`连续 ${summary.streakDays} 天`), spark: null },
    { id: 'cache', label: i18n._(msg`缓存命中率`), value: current.cacheHitRate ?? null, previous: previous.cacheHitRate ?? null, format: 'percent', lowerIsBetter: false, estimated: false, spark: null },
    { id: 'ttft', label: i18n._(msg`首字延迟 p50`), value: current.ttftMs?.p50 ?? null, previous: previous.ttftMs?.p50 ?? null, format: 'duration', lowerIsBetter: true, estimated: false, spark: null },
    { id: 'speed', label: i18n._(msg`输出速度 p50`), value: current.outputTokensPerSecond?.p50 ?? null, previous: previous.outputTokensPerSecond?.p50 ?? null, format: 'speed', lowerIsBetter: false, estimated: false, spark: null },
    { id: 'success', label: i18n._(msg`成功率`), value: successRate(current.states), previous: successRate(previous.states), format: 'percent', lowerIsBetter: false, estimated: false, spark: null },
  ];
}

export function rowCacheHitRate(tokens: StatsTokens | undefined): number | null {
  if (!tokens || tokens.input == null || tokens.cacheRead == null) return null;
  const total = tokens.input + tokens.cacheRead;
  return total > 0 ? tokens.cacheRead / total : null;
}

export function rowTokensPerRun(row: StatsBreakdownRow): number | null {
  if (row.count <= 0 || row.totalTokens <= 0) return null;
  return row.totalTokens / row.count;
}

export function sortBreakdown(rows: StatsBreakdownRow[], rank: RankMetric): StatsBreakdownRow[] {
  const value = (row: StatsBreakdownRow) => {
    if (rank === 'runs') return row.count;
    if (rank === 'avgTokens') return rowTokensPerRun(row) ?? Number.NEGATIVE_INFINITY;
    if (rank === 'cache') return rowCacheHitRate(row.tokens) ?? Number.NEGATIVE_INFINITY;
    if (rank === 'speed') return row.outputTokensPerSecond?.p50 ?? Number.NEGATIVE_INFINITY;
    return row.totalTokens;
  };
  return [...rows].sort((a, b) => value(b) - value(a));
}

export function donutBasis(rows: StatsBreakdownRow[]): 'tokens' | 'runs' {
  return rows.some((row) => row.totalTokens > 0) ? 'tokens' : 'runs';
}

export function donutSlices(rows: Array<StatsKeyInfo & { value: number }>): DonutSlice[] {
  const usable = rows.filter((row) => row.value > 0 && Number.isFinite(row.value));
  const total = usable.reduce((sum, row) => sum + row.value, 0);
  if (total <= 0) return [];
  const layout = pie<StatsKeyInfo & { value: number }>().value((row) => row.value).sort(null).padAngle(usable.length > 1 ? 0.012 : 0);
  return layout(usable).map((slice) => ({
    key: slice.data.key,
    label: slice.data.label,
    ...(slice.data.backendId ? { backendId: slice.data.backendId } : {}),
    value: slice.data.value,
    share: slice.data.value / total,
    startAngle: slice.startAngle,
    endAngle: slice.endAngle,
  }));
}

export function donutPath(slice: Pick<DonutSlice, 'startAngle' | 'endAngle'>, inner: number, outer: number): string {
  return arc<Pick<DonutSlice, 'startAngle' | 'endAngle'>>()
    .innerRadius(inner)
    .outerRadius(outer)
    .startAngle((d) => d.startAngle)
    .endAngle((d) => d.endAngle)(slice) ?? '';
}

export function latencyOf(row: { ttftMs: StatsPercentiles | null; durationMs: StatsPercentiles | null; outputTokensPerSecond: StatsPercentiles | null }, kind: 'ttft' | 'duration' | 'speed'): StatsPercentiles | null {
  if (kind === 'ttft') return row.ttftMs;
  if (kind === 'duration') return row.durationMs;
  return row.outputTokensPerSecond;
}

export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
  const t = value / max;
  if (t <= 0.25) return 1;
  if (t <= 0.5) return 2;
  if (t <= 0.75) return 3;
  return 4;
}

export function weekGrid(weekHour: number[][] | undefined): number[][] | null {
  if (!Array.isArray(weekHour) || weekHour.length !== 7) return null;
  if (weekHour.some((row) => !Array.isArray(row) || row.length < 24)) return null;
  return weekHour.map((row) => row.slice(0, 24).map((value) => typeof value === 'number' && Number.isFinite(value) ? value : 0));
}

export function heatMax(values: number[]): number {
  const max = values.reduce((best, value) => value > best ? value : best, 0);
  return max > 0 ? max : 0;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Monday-first columns, 53 weeks ending the week of `now`. Days the server omitted are real zeros. */
export function calendarGrid(days: StatsHeatmap['calendar'], now: Date): CalendarCell[][] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const end = startOfDay(now);
  const endMonday = addDays(end, -((end.getDay() + 6) % 7));
  const start = addDays(endMonday, -52 * 7);
  const columns: CalendarCell[][] = [];
  for (let week = 0; week < 53; week++) {
    const column: CalendarCell[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = addDays(start, week * 7 + weekday);
      const inRange = date.getTime() <= end.getTime();
      const key = isoDate(date);
      const found = byDate.get(key);
      column.push({
        date: key,
        runs: inRange ? found?.runs ?? 0 : 0,
        totalTokens: inRange ? found?.totalTokens ?? 0 : 0,
        inRange,
      });
    }
    columns.push(column);
  }
  return columns;
}

/**
 * Map a drag on `[rangePx]` into an exclusive `[from, to)` inside `domain`.
 * A drag shorter than 4px is a click, not a selection.
 */
export function brushRange(domain: [number, number], rangePx: [number, number], startPx: number, endPx: number): { from: string; to: string } | null {
  const [d0, d1] = domain;
  const [r0, r1] = rangePx;
  const span = r1 - r0;
  if (!(span > 0) || !(d1 > d0)) return null;
  const lo = Math.max(r0, Math.min(startPx, endPx));
  const hi = Math.min(r1, Math.max(startPx, endPx));
  if (hi - lo < 4) return null;
  const from = d0 + ((lo - r0) / span) * (d1 - d0);
  let to = d0 + ((hi - r0) / span) * (d1 - d0);
  if (!(to > from)) return null;
  if (hi >= r1 - 0.5) to = d1 + 1;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function nearestIndex(starts: number[], time: number): number {
  if (!starts.length) return -1;
  let best = 0;
  let bestDist = Infinity;
  starts.forEach((start, index) => {
    const dist = Math.abs(start - time);
    if (dist < bestDist) {
      best = index;
      bestDist = dist;
    }
  });
  return best;
}
