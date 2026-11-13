import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ServiceMonitorSnapshot, ServiceProcess } from '@contracts';
import { AgentMark } from '@/components/agent-marks';
import { IconActivity, IconBot, IconCircleAlert, IconCpu, IconGauge, IconMemoryStick, IconMessagesSquare, IconOctagonX, IconRefreshCw, IconServer, IconSquareTerminal, IconTerminal, IconTimer, IconZap } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Spinner, StatusDot } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { backendLabel } from '@/lib/backends';
import { confirmDialog } from '@/lib/dialogs';
import { formatDuration as formatElapsed } from '@/lib/format-duration';
import { formatCount, formatDuration, formatExactTimestamp, formatPercent } from '@/lib/stats-format';
import { toast } from '@/lib/toast';
import { cn, errorMessage, formatBytes, formatClock } from '@/lib/utils';
import { Spark } from '../stats/KpiCards';
import { useAnimatedNumber, useReducedMotion } from '../stats/chart-shared';
import { RouteRank, StatusDonut, TimeSeriesChart } from './ServiceCharts';
import { SettingsGroup as Group } from './SettingsLayout';

const POLL_MS = 5_000;
/** Ten minutes of 10-second buckets: enough shape for a sparkline without flattening the last spike. */
const SPARK_SAMPLES = 60;

type Tone = 'accent' | 'success' | 'warning' | 'danger';
const TONE_CHIP: Record<Tone, string> = {
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};
const TONE_TEXT: Record<Tone, string> = { accent: 'text-accent', success: 'text-success', warning: 'text-warning', danger: 'text-danger' };
const TONE_FILL: Record<Tone, string> = { accent: 'var(--accent)', success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)' };

const KIND_META: Record<ServiceProcess['kind'], { label: MessageDescriptor | string; icon: typeof IconServer; tone: 'accent' | 'neutral' | 'success'; color: string; order: number }> = {
  server: { label: msg`服务器`, icon: IconServer, tone: 'accent', color: 'var(--chart-1)', order: 0 },
  tmux: { label: 'tmux', icon: IconSquareTerminal, tone: 'neutral', color: 'var(--chart-8)', order: 1 },
  agent: { label: 'Agent', icon: IconBot, tone: 'success', color: 'var(--chart-2)', order: 2 },
  child: { label: msg`子进程`, icon: IconTerminal, tone: 'neutral', color: 'var(--chart-3)', order: 3 },
};

/** Process kinds the platform names (`Agent`) stay as they are; only the words are localized. */
const kindLabel = (label: MessageDescriptor | string): string => typeof label === 'string' ? label : i18n._(label);

const formatCpu = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}%`;
const formatLoad = (value: number) => value.toFixed(2);

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days < 1) return formatElapsed(seconds * 1000);
  return `${days}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

/**
 * Polls while the section is on screen and the tab is visible; a hidden tab skips its ticks and
 * catches up the moment it is shown again. A failed poll keeps the last snapshot on screen.
 */
function useServiceMonitor() {
  const { t } = useLingui();
  const [data, setData] = useState<ServiceMonitorSnapshot>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);

  const refresh = useCallback(async (force = false) => {
    if (!force && (inFlight.current || document.visibilityState !== 'visible')) return;
    // A forced read (after ending a process) must not be answered by a poll that started before it.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const next = await api.serviceMonitor(controller.signal);
      if (mounted.current && !controller.signal.aborted) { setData(next); setError(''); }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(errorMessage(reason, t`无法读取服务器状态`));
    } finally {
      if (inFlight.current === controller) inFlight.current = undefined;
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      inFlight.current?.abort();
      inFlight.current = undefined;
    };
  }, [refresh]);

  return { data, error, loading, refresh };
}

export function ServiceStatusSection() {
  const { t } = useLingui();
  const { data, error, loading, refresh } = useServiceMonitor();
  const [terminating, setTerminating] = useState<number>();

  const terminate = async (process: ServiceProcess) => {
    const session = process.sessionTitle ? t`会话「${process.sessionTitle}」` : t`它所在的会话`;
    const confirmed = await confirmDialog({
      title: t`结束进程 ${process.name}（PID ${process.pid}）？`,
      description: process.kind === 'agent'
        ? t`将向该进程发送 SIGTERM。${session}正在进行的任务会中断。`
        : t`将向该进程发送 SIGTERM，依赖它的终端或会话可能随之退出。`,
      detail: process.command,
      confirmLabel: t`结束进程`,
      destructive: true,
    });
    if (!confirmed) return;
    setTerminating(process.pid);
    try {
      await api.terminateServiceProcess(process.pid);
      toast.success(t`已向 ${process.name}（PID ${process.pid}）发送结束信号`);
      await refresh(true);
    } catch (reason) {
      toast.error(errorMessage(reason, t`结束进程失败`));
    } finally {
      setTerminating(undefined);
    }
  };

  if (!data) {
    if (loading) return <ServiceSkeleton />;
    return (
      <EmptyState icon={<IconCircleAlert />} title={t`无法读取服务器状态`} description={error || t`服务器没有返回状态数据。`}>
        <Button size="sm" onClick={() => void refresh(true)}><IconRefreshCw /><Trans>重试</Trans></Button>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <LiveBar data={data} error={error} onRefresh={() => void refresh(true)} />
      <KpiTiles data={data} />
      <div className="flex flex-col gap-3">
        <TimeSeriesChart
          title={t`请求与延迟`}
          samples={data.series}
          primaryKind="bar"
          primary={{ label: t`请求数`, color: 'var(--accent)', values: data.series.map((sample) => sample.requests), format: formatCount }}
          overlay={{ label: '5xx', color: 'var(--danger)', values: data.series.map((sample) => sample.errors), format: formatCount }}
          secondary={{ label: t`平均延迟`, color: 'var(--chart-3)', values: data.series.map((sample) => sample.avgMs), format: formatDuration }}
          summary={<span className="text-2xs text-fg-4"><Trans>每 10 秒一格</Trans></span>}
        />
        <TimeSeriesChart
          title={t`CPU 与内存`}
          samples={data.series}
          primaryKind="area"
          primary={{ label: 'CPU', color: 'var(--chart-1)', values: data.series.map((sample) => sample.cpuPercent), format: formatCpu }}
          secondary={{ label: t`常驻内存`, color: 'var(--chart-2)', values: data.series.map((sample) => sample.rssBytes), format: (value) => formatBytes(Math.round(value)) }}
        />
        <div className="grid gap-3 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
          <StatusDonut byStatus={data.requests.byStatus} />
          <RouteRank routes={data.requests.topRoutes} />
        </div>
      </div>
      <ServerCard data={data} />
      <ProcessTable processes={data.processes} terminating={terminating} onTerminate={(process) => void terminate(process)} />
    </div>
  );
}

function Skel({ className }: { className: string }) {
  return <div className={`stats-skel ${className}`} />;
}

function ServiceSkeleton() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-6" aria-busy aria-label={t`正在读取服务器状态`}>
      <Skel className="h-5 w-56 rounded-md" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
        {Array.from({ length: 6 }, (_, index) => <Skel key={index} className="h-[124px] rounded-xl" />)}
      </div>
      <Skel className="h-[260px] rounded-xl" />
      <Skel className="h-[260px] rounded-xl" />
      <Skel className="h-[220px] rounded-xl" />
    </div>
  );
}

function LiveBar({ data, error, onRefresh }: { data: ServiceMonitorSnapshot; error: string; onRefresh: () => void }) {
  const { t } = useLingui();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* Live is the normal state and says nothing; a failed poll is what gets the dot. */}
      <span className="inline-flex items-center gap-2 text-xs text-fg-3">
        {error && <><StatusDot tone="warning" /><Trans>更新失败，显示的是上一次的数据</Trans></>}
        <span className="tabular-nums text-fg-4"><Trans>更新于 {formatClock(data.generatedAt)}</Trans></span>
      </span>
      {error && <span className="inline-flex min-w-0 items-center gap-1 text-xs text-danger"><IconCircleAlert className="size-3.5 shrink-0" /><span className="truncate">{error}</span></span>}
      <Button size="xs" variant="ghost" className="ml-auto" onClick={onRefresh}><IconRefreshCw /><Trans>刷新</Trans></Button>
    </div>
  );
}

function Meter({ value, tone, label }: { value: number; tone: Tone; label: ReactNode }) {
  const share = Math.max(0, Math.min(1, value));
  return (
    <div className="flex flex-col gap-1">
      <span className="h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <span className="block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]" style={{ width: `${share * 100}%`, background: TONE_FILL[tone] }} />
      </span>
      <span className="truncate text-2xs tabular-nums text-fg-3">{label}</span>
    </div>
  );
}

function Tile({ icon, label, value, format, unit, tone = 'accent', spark, badge, footer }: {
  icon: ReactNode;
  label: string;
  value: number;
  format: (value: number) => string;
  unit?: string;
  tone?: Tone;
  spark: number[];
  badge?: ReactNode;
  footer: ReactNode;
}) {
  const reduced = useReducedMotion();
  const shown = useAnimatedNumber(value, reduced) ?? value;
  return (
    <article className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-elevated p-3.5">
      <div className="flex min-h-5 items-center gap-2">
        <span className={cn('grid size-6 shrink-0 place-items-center rounded-md [&_svg]:size-3.5', TONE_CHIP[tone])}>{icon}</span>
        <h3 className="truncate text-xs text-fg-3">{label}</h3>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className="min-w-0 truncate text-2xl font-semibold leading-7 tracking-tight text-fg tabular-nums">
          {format(shown)}
          {unit && <span className="ml-1 text-xs font-normal tracking-normal text-fg-3">{unit}</span>}
        </p>
        <Spark values={spark} width={76} height={28} className={cn('mb-0.5', TONE_TEXT[tone])} />
      </div>
      {footer}
    </article>
  );
}

function KpiTiles({ data }: { data: ServiceMonitorSnapshot }) {
  const { t } = useLingui();
  const recent = data.series.slice(-SPARK_SAMPLES);
  const { process, host, eventLoop, requests } = data;
  const errors = requests.byStatus['5xx'];
  const loadShare = host.cpuCount > 0 ? host.loadAvg[0] / host.cpuCount : 0;
  const usedMem = host.totalMemBytes - host.freeMemBytes;
  const memShare = host.totalMemBytes > 0 ? usedMem / host.totalMemBytes : 0;
  const heapShare = process.heapTotalBytes > 0 ? process.heapUsedBytes / process.heapTotalBytes : 0;
  const lagTone: Tone = eventLoop.recentLagMs >= 200 ? 'danger' : eventLoop.recentLagMs >= 50 ? 'warning' : 'accent';
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
      <Tile
        icon={<IconCpu />}
        label="CPU"
        value={process.cpuPercent}
        format={formatCpu}
        tone={process.cpuPercent >= 80 ? 'warning' : 'accent'}
        spark={recent.map((sample) => sample.cpuPercent)}
        footer={<Meter value={process.cpuPercent / 100} tone={process.cpuPercent >= 80 ? 'warning' : 'accent'} label={t`单核占比 · 主机 ${host.cpuCount} 核`} />}
      />
      <Tile
        icon={<IconMemoryStick />}
        label={t`内存`}
        value={process.rssBytes}
        format={(value) => formatBytes(Math.round(value))}
        spark={recent.map((sample) => sample.rssBytes)}
        footer={<Meter value={heapShare} tone={heapShare >= 0.9 ? 'warning' : 'accent'} label={t`堆 ${formatBytes(process.heapUsedBytes)} / ${formatBytes(process.heapTotalBytes)}`} />}
      />
      <Tile
        icon={<IconActivity />}
        label={t`请求速率`}
        value={requests.perMinute}
        format={formatCount}
        unit={t`次/分`}
        spark={recent.map((sample) => sample.requests)}
        badge={requests.inFlight > 0 ? <Badge tone="accent"><Trans>进行中 {requests.inFlight}</Trans></Badge> : undefined}
        footer={<p className="truncate text-2xs tabular-nums text-fg-3"><Trans>启动以来共 {formatCount(requests.total)} 次</Trans></p>}
      />
      <Tile
        icon={<IconTimer />}
        label={t`延迟`}
        value={requests.avgMs}
        format={formatDuration}
        tone={errors > 0 ? 'danger' : 'success'}
        spark={recent.map((sample) => sample.avgMs)}
        badge={errors > 0 ? <Badge tone="danger">{t`5xx ${formatCount(errors)}`}</Badge> : undefined}
        footer={<p className="truncate text-2xs tabular-nums text-fg-3"><Trans>平均 · p95 {formatDuration(requests.p95Ms)}</Trans></p>}
      />
      <Tile
        icon={<IconZap />}
        label={t`事件循环延迟`}
        value={eventLoop.recentLagMs}
        format={formatDuration}
        tone={lagTone}
        spark={recent.map((sample) => sample.loopLagMs)}
        badge={eventLoop.stalls > 0 ? (
          <Tip label={eventLoop.lastStallAt ? t`最近一次：${formatExactTimestamp(eventLoop.lastStallAt)}` : t`事件循环曾长时间阻塞`}>
            <span className="cursor-help"><Badge tone="warning"><Trans>卡顿 {formatCount(eventLoop.stalls)}</Trans></Badge></span>
          </Tip>
        ) : undefined}
        footer={<Meter value={eventLoop.utilization} tone={eventLoop.utilization >= 0.8 ? 'warning' : 'accent'} label={t`利用率 ${formatPercent(eventLoop.utilization)} · p99 ${formatDuration(eventLoop.p99Ms)}`} />}
      />
      <Tile
        icon={<IconGauge />}
        label={t`系统负载`}
        value={host.loadAvg[0]}
        format={formatLoad}
        unit={t`/ ${host.cpuCount} 核`}
        tone={loadShare >= 1 ? 'danger' : loadShare >= 0.7 ? 'warning' : 'accent'}
        spark={recent.map((sample) => sample.load1)}
        footer={(
          <div className="flex flex-col gap-1.5">
            <p className="truncate text-2xs tabular-nums text-fg-3"><Trans>5 分钟 {formatLoad(host.loadAvg[1])} · 15 分钟 {formatLoad(host.loadAvg[2])}</Trans></p>
            <Meter value={memShare} tone={memShare >= 0.9 ? 'warning' : 'accent'} label={t`主机内存 ${formatBytes(usedMem)} / ${formatBytes(host.totalMemBytes)}`} />
          </div>
        )}
      />
    </div>
  );
}

function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs text-fg-4">{label}</dt>
      <dd className={cn('truncate text-sm text-fg tabular-nums', mono && 'font-mono text-xs leading-5')}>{children}</dd>
    </div>
  );
}

function Counter({ icon, label, value, detail }: { icon: ReactNode; label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg bg-subtle px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-elevated text-fg-3 shadow-soft [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-2xs text-fg-3">{label}</span>
        <span className="truncate text-sm font-medium tabular-nums text-fg">{value}{detail && <span className="ml-1 text-xs font-normal text-fg-3">{detail}</span>}</span>
      </span>
    </div>
  );
}

function ServerCard({ data }: { data: ServiceMonitorSnapshot }) {
  const { t } = useLingui();
  const { process, host, connections, terminals, sessions } = data;
  return (
    <Group title={t`服务器进程`}>
      <div className="flex flex-col gap-4 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent [&_svg]:size-5"><IconServer /></span>
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2 text-sm font-medium text-fg">Riffet {process.version}</span>
            <span className="truncate text-xs text-fg-3" title={host.cpuModel}>{host.hostname} · {host.cpuModel}</span>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Fact label="PID" mono>{process.pid}</Fact>
          <Fact label="Node.js" mono>{process.nodeVersion}</Fact>
          <Fact label={t`平台`} mono>{process.platform}/{process.arch}</Fact>
          <Fact label={t({ message: '已运行', context: 'settings-process-uptime' })}>{formatUptime(process.uptimeSec)}</Fact>
          <Fact label={t`启动于`}>{formatExactTimestamp(process.startedAt)}</Fact>
          <Fact label={t`主机已运行`}>{formatUptime(host.uptimeSec)}</Fact>
        </dl>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          <Counter icon={<IconActivity />} label={t`事件流连接`} value={formatCount(connections.eventStreams)} />
          <Counter icon={<IconSquareTerminal />} label={t`终端连接`} value={formatCount(connections.terminalSockets)} />
          <Counter icon={<IconTerminal />} label={t`终端`} value={formatCount(terminals.live)} detail={t`/ ${formatCount(terminals.total)} 存活`} />
          <Counter icon={<IconMessagesSquare />} label={t({ message: '会话', context: 'settings-session-label' })} value={formatCount(sessions.running)} detail={t`运行 · ${formatCount(sessions.waiting)} 等待`} />
        </div>
      </div>
    </Group>
  );
}

interface ProcessRow { process: ServiceProcess; depth: number }

/** Parent before children, siblings by kind then pid. A process whose parent is not listed is a root. */
function processTree(processes: ServiceProcess[]): ProcessRow[] {
  const pids = new Set(processes.map((process) => process.pid));
  const children = new Map<number, ServiceProcess[]>();
  for (const process of processes) {
    const parent = process.ppid !== process.pid && pids.has(process.ppid) ? process.ppid : -1;
    children.set(parent, [...(children.get(parent) ?? []), process]);
  }
  const rows: ProcessRow[] = [];
  const seen = new Set<number>();
  const walk = (parent: number, depth: number) => {
    const list = [...(children.get(parent) ?? [])].sort((a, b) => KIND_META[a.kind].order - KIND_META[b.kind].order || a.pid - b.pid);
    for (const process of list) {
      if (seen.has(process.pid)) continue;
      seen.add(process.pid);
      rows.push({ process, depth });
      walk(process.pid, depth + 1);
    }
  };
  walk(-1, 0);
  return rows;
}

function MemoryShare({ processes }: { processes: ServiceProcess[] }) {
  const { t } = useLingui();
  const total = processes.reduce((sum, process) => sum + process.rssBytes, 0);
  if (total <= 0) return null;
  const kinds = (Object.keys(KIND_META) as Array<ServiceProcess['kind']>)
    .map((kind) => ({ kind, bytes: processes.filter((process) => process.kind === kind).reduce((sum, process) => sum + process.rssBytes, 0), count: processes.filter((process) => process.kind === kind).length }))
    .filter((item) => item.count > 0);
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-fg-3"><Trans>内存占用分布</Trans></span>
        <span className="tabular-nums text-fg">{formatBytes(total)}</span>
      </div>
      <span className="flex h-2 overflow-hidden rounded-full bg-muted">
        {kinds.map((item) => <span key={item.kind} className="h-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]" style={{ width: `${(item.bytes / total) * 100}%`, background: KIND_META[item.kind].color }} title={t`${kindLabel(KIND_META[item.kind].label)} ${formatBytes(item.bytes)}`} />)}
      </span>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {kinds.map((item) => (
          <span key={item.kind} className="inline-flex items-center gap-1.5 text-2xs text-fg-3">
            <span aria-hidden className="size-2 rounded-full" style={{ background: KIND_META[item.kind].color }} />
            <Trans>{kindLabel(KIND_META[item.kind].label)} × {item.count}</Trans>
            <span className="tabular-nums text-fg-4">{formatBytes(item.bytes)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ProcessTable({ processes, terminating, onTerminate }: { processes: ServiceProcess[]; terminating?: number; onTerminate: (process: ServiceProcess) => void }) {
  const { t } = useLingui();
  const rows = processTree(processes);
  const agents = processes.filter((process) => process.kind === 'agent').length;
  const title = agents ? t`进程 · ${processes.length} 个，其中 Agent ${agents} 个` : t`进程 · ${processes.length} 个`;
  return (
    <Group title={title}>
      <MemoryShare processes={processes} />
      {rows.length === 0 ? <p className="py-6 text-center text-xs text-fg-3"><Trans>没有读取到进程信息</Trans></p> : (
        <div className="-mx-4 overflow-x-auto max-md:-mx-3">
          <table className="w-full min-w-[680px] border-separate border-spacing-0 text-left text-xs">
            <thead>
              <tr className="[&>th]:border-t [&>th]:border-line-soft [&>th]:px-2 [&>th]:py-2 [&>th]:text-2xs [&>th]:font-medium [&>th]:text-fg-3 [&>th:first-child]:pl-4 [&>th:last-child]:pr-4">
                <th scope="col"><Trans>进程</Trans></th>
                <th scope="col"><Trans context="settings-session-label">会话</Trans></th>
                <th scope="col" className="w-32">CPU</th>
                <th scope="col" className="w-20 text-right"><Trans>内存</Trans></th>
                <th scope="col" className="w-20 text-right"><Trans>运行时长</Trans></th>
                <th scope="col" className="w-24"><span className="sr-only"><Trans>操作</Trans></span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ process, depth }) => {
                const meta = KIND_META[process.kind];
                const Icon = meta.icon;
                const cpuShare = Math.min(1, process.cpuPercent / 100);
                return (
                  <tr key={process.pid} className="hover:bg-hover [&>td]:border-t [&>td]:border-line-soft [&>td]:px-2 [&>td]:py-2.5 [&>td]:align-middle [&>td:first-child]:pl-4 [&>td:last-child]:pr-4">
                    <td className="max-w-[18rem]">
                      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 16 }}>
                        {depth > 0 && <span aria-hidden className="-ml-2 shrink-0 text-fg-4">└</span>}
                        <span className="grid size-6 shrink-0 place-items-center rounded-md text-fg-2 [&_svg]:size-3.5" style={{ background: `color-mix(in srgb, ${meta.color} 16%, transparent)`, color: meta.color }}><Icon /></span>
                        <span className="flex min-w-0 flex-col">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium text-fg">{process.name}</span>
                            <Badge tone={meta.tone}>{kindLabel(meta.label)}</Badge>
                            <span className="shrink-0 font-mono text-2xs text-fg-4">{process.pid}</span>
                          </span>
                          <span className="truncate font-mono text-2xs text-fg-4" title={process.command}>{process.command}</span>
                        </span>
                      </div>
                    </td>
                    <td className="max-w-[12rem]">
                      {process.sessionTitle || process.backendId ? (
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-fg-2" title={process.sessionTitle}>{process.sessionTitle || t`未命名会话`}</span>
                          {process.backendId && (
                            <span className="inline-flex min-w-0 items-center gap-1.5 text-2xs text-fg-4">
                              <AgentMark backend={process.backendId} size={14} className="shrink-0" />
                              <span className="truncate">{backendLabel(process.backendId)}</span>
                            </span>
                          )}
                        </span>
                      ) : <span className="text-fg-4">—</span>}
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted">
                          <span className="block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]" style={{ width: `${Math.max(cpuShare * 100, process.cpuPercent > 0 ? 3 : 0)}%`, background: process.cpuPercent >= 80 ? 'var(--warning)' : 'var(--accent)' }} />
                        </span>
                        <span className="tabular-nums text-fg-2">{formatCpu(process.cpuPercent)}</span>
                      </div>
                    </td>
                    <td className="text-right tabular-nums text-fg-2">{formatBytes(process.rssBytes)}</td>
                    <td className="text-right tabular-nums text-fg-3">{formatUptime(process.elapsedSec)}</td>
                    <td className="text-right">
                      {process.canTerminate && (
                        <Button size="xs" variant="danger-ghost" disabled={terminating !== undefined} onClick={() => onTerminate(process)}>
                          {terminating === process.pid ? <Spinner className="text-current" /> : <IconOctagonX />}<Trans>结束进程</Trans>
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Group>
  );
}
