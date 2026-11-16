import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { StorageDatabasePart, StorageFolderKind, StorageProjectUsage, StorageReport, StorageScanStep } from '@contracts';
import { IconCircleAlert, IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Spinner } from '@/components/ui/controls';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { formatDuration } from '@/lib/stats-format';
import { toast } from '@/lib/toast';
import { errorMessage, formatBytes, timeAgo } from '@/lib/utils';
import { LegendItem } from '../stats/chart-shared';
import { SettingsGroup as Group, SettingsRow as Row } from './SettingsLayout';

/** Only while a scan runs: the figures otherwise change too slowly to be worth polling. */
const SCAN_POLL_MS = 2_000;

/** A string label is a term kept in English in every language (Checkpoints, Worktrees, as in the Git panel). */
interface Meta { label: MessageDescriptor | string; note?: MessageDescriptor }

const labelOf = (label: MessageDescriptor | string) => typeof label === 'string' ? label : i18n._(label);

/**
 * What the database's pages hold; `note` is how each is let go, which nothing on screen shows. They
 * share the database's colour: the colours on this page name what the overview bar is made of.
 */
const PARTS: Record<StorageDatabasePart, Meta> = {
  journal: { label: msg`会话记录`, note: msg`随会话删除` },
  timeline: { label: msg`时间线`, note: msg`7 天未活动的会话清空，打开时重建` },
  blobs: { label: msg`图片与长输出`, note: msg`不再引用时回收` },
  search: { label: msg`搜索索引` },
  records: { label: msg`运行与用量` },
  other: { label: msg`其他` },
};

const FOLDERS: Record<StorageFolderKind, Meta & { color: string }> = {
  checkpoints: { label: 'Checkpoints', color: 'var(--chart-2)', note: msg`每个项目保留最近 50 个回合` },
  worktrees: { label: 'Worktrees', color: 'var(--chart-3)' },
  attachments: { label: msg`附件`, color: 'var(--chart-4)', note: msg`30 天未用即清理` },
  tasks: { label: msg`后台任务`, color: 'var(--chart-5)' },
  plugins: { label: msg`插件`, color: 'var(--chart-6)' },
  logs: { label: msg`日志与诊断`, color: 'var(--chart-7)' },
  other: { label: msg`其他`, color: 'var(--chart-8)' },
};

const DATABASE_COLOR = 'var(--chart-1)';
const FREE_COLOR = 'var(--line-strong)';
/** Below this, an estimate of what compaction gives back says nothing worth reading. */
const RECLAIM_WORTH_NAMING = 1024 * 1024;

/** A step a first scan has not finished yet; a finished scan has none. */
const waiting = (data: StorageReport, step: StorageScanStep) => !data.scan || Boolean(data.scan.pending?.includes(step));

/** Largest first, with 其他 always last: it is what is left, not a thing of its own. */
const ranked = <T extends { bytes: number }>(items: T[], key: (item: T) => string) =>
  [...items].sort((a, b) => Number(key(a) === 'other') - Number(key(b) === 'other') || b.bytes - a.bytes);

function useStorage() {
  const { t } = useLingui();
  const [data, setData] = useState<StorageReport>();
  const [error, setError] = useState('');
  const mounted = useRef(true);

  const apply = useCallback((next: StorageReport) => { if (mounted.current) { setData(next); setError(''); } }, []);
  const refresh = useCallback(async () => {
    try { apply(await api.storage()); }
    catch (reason) { if (mounted.current) setError(errorMessage(reason, t`无法读取存储空间`)); }
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const scanning = data?.scanning ?? false;
  useEffect(() => {
    if (!scanning) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, SCAN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [scanning, refresh]);

  return { data, error, refresh, apply };
}

export function StorageSection() {
  const { t } = useLingui();
  const { data, error, refresh, apply } = useStorage();

  if (!data) {
    if (!error) return <StorageSkeleton />;
    return (
      <EmptyState icon={<IconCircleAlert />} title={t`无法读取存储空间`} description={error}>
        <Button size="sm" onClick={() => void refresh()}><IconRefreshCw /><Trans>重试</Trans></Button>
      </EmptyState>
    );
  }

  const rescan = async () => {
    try { apply(await api.scanStorage()); }
    catch (reason) { toast.error(errorMessage(reason, t`无法开始统计`)); }
  };

  return (
    <div className="flex flex-col gap-6">
      <ScanBar data={data} error={error} onRescan={() => void rescan()} />
      <Overview data={data} />
      <DatabaseGroup data={data} onChange={apply} />
      {data.scan && !waiting(data, 'sessions') ? <>
        {data.scan.projects.length > 0 && <ProjectTable projects={data.scan.projects} />}
        {data.scan.sessions.length > 0 && <SessionTable data={data} />}
      </> : <Group title={t`按项目`} loading><span /></Group>}
      {data.scan && !waiting(data, 'folders') ? <FolderGroup data={data} /> : <Group title={t`文件`} loading><span /></Group>}
    </div>
  );
}

function StorageSkeleton() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-6" aria-busy aria-label={t`正在读取存储空间`}>
      <Skeleton className="h-5 w-56 rounded-md" />
      <Skeleton className="h-[132px] rounded-xl" />
      <Skeleton className="h-[280px] rounded-xl" />
      <Skeleton className="h-[220px] rounded-xl" />
    </div>
  );
}

function ScanBar({ data, error, onRescan }: { data: StorageReport; error: string; onRescan: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="inline-flex items-center gap-2 text-xs text-fg-4">
        {data.scanning ? <><Spinner className="size-3.5" /><Trans>正在统计</Trans></>
          : data.scan && !data.scan.pending && <span className="tabular-nums"><Trans>统计于 {timeAgo(data.scan.at)} · 用时 {formatDuration(data.scan.durationMs)}</Trans></span>}
      </span>
      {error && <span className="inline-flex min-w-0 items-center gap-1 text-xs text-danger"><IconCircleAlert className="size-3.5 shrink-0" /><span className="truncate">{error}</span></span>}
      <Button size="xs" variant="ghost" className="ml-auto" disabled={data.scanning} onClick={onRescan}><IconRefreshCw /><Trans>重新统计</Trans></Button>
    </div>
  );
}

/** One bar for the whole state directory: the database, then each kind of folder. */
function Overview({ data }: { data: StorageReport }) {
  const { t } = useLingui();
  const folders = data.scan?.folders ?? [];
  const total = data.database.bytes + folders.reduce((sum, folder) => sum + folder.bytes, 0);
  const segments = [
    { key: 'database', label: t`数据库`, color: DATABASE_COLOR, bytes: data.database.bytes },
    ...ranked(folders, (folder) => folder.kind).map((folder) => ({ key: folder.kind, label: labelOf(FOLDERS[folder.kind].label), color: FOLDERS[folder.kind].color, bytes: folder.bytes })),
  ].filter((segment) => segment.bytes > 0);
  return (
    <Group>
      <div className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-2xl font-semibold leading-7 tracking-tight text-fg tabular-nums">
              {!waiting(data, 'folders') ? formatBytes(total) : <Skeleton className="inline-block h-6 w-24 rounded-md align-middle" />}
            </p>
            <p className="truncate font-mono text-2xs text-fg-4" title={data.directory}>{data.directory}</p>
          </div>
          <p className="text-xs tabular-nums text-fg-3"><Trans>磁盘可用 {formatBytes(data.disk.freeBytes)} / {formatBytes(data.disk.totalBytes)}</Trans></p>
        </div>
        <StackedBar segments={segments} total={total} />
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {segments.map((segment) => (
            <LegendItem key={segment.key} color={segment.color}>{segment.label}<span className="tabular-nums text-fg-4">{formatBytes(segment.bytes)}</span></LegendItem>
          ))}
        </div>
      </div>
    </Group>
  );
}

function StackedBar({ segments, total }: { segments: Array<{ key: string; label: string; color: string; bytes: number }>; total: number }) {
  return (
    <span className="flex h-2 gap-px overflow-hidden rounded-full bg-muted">
      {total > 0 && segments.map((segment) => (
        <span key={segment.key} className="h-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]" style={{ width: `${(segment.bytes / total) * 100}%`, background: segment.color }} title={`${segment.label} ${formatBytes(segment.bytes)}`} />
      ))}
    </span>
  );
}

/** A ranked bar per part, against the file's size. */
function ShareRow({ label, note, bytes, of, color }: { label: string; note?: string; bytes: number; of: number; color: string }) {
  const width = of > 0 && bytes > 0 ? Math.max((bytes / of) * 100, 0.8) : 0;
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="shrink-0 text-fg-2">{label}</span>
        {note && <span className="min-w-0 truncate text-2xs text-fg-4">{note}</span>}
        <span className="ml-auto shrink-0 tabular-nums text-fg">{formatBytes(bytes)}</span>
      </div>
      <span className="h-1.5 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]" style={{ width: `${width}%`, background: color }} />
      </span>
    </li>
  );
}

function DatabaseGroup({ data, onChange }: { data: StorageReport; onChange: (next: StorageReport) => void }) {
  const { t } = useLingui();
  const { database } = data;
  const parts = data.scan?.parts ?? [];
  return (
    <Group title={t`数据库 · ${formatBytes(database.bytes)}`}>
      <ol className="flex flex-col gap-3 py-4">
        {parts.length === 0 && <li className="flex justify-center py-4"><Spinner /></li>}
        {ranked(parts, (item) => item.part).map((item) => {
          const meta = PARTS[item.part];
          return <ShareRow key={item.part} label={labelOf(meta.label)} note={meta.note && i18n._(meta.note)} bytes={item.bytes} of={database.bytes} color={DATABASE_COLOR} />;
        })}
        <ShareRow label={t`可释放`} bytes={database.freeBytes} of={database.bytes} color={FREE_COLOR} />
      </ol>
      <CompactionRow data={data} onChange={onChange} />
    </Group>
  );
}

function CompactionRow({ data, onChange }: { data: StorageReport; onChange: (next: StorageReport) => void }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const { compaction, database, disk } = data;
  const short = disk.freeBytes < compaction.requiredBytes;
  const last = compaction.last;

  const schedule = async (scheduled: boolean) => {
    if (scheduled) {
      const confirmed = await confirmDialog({
        title: t`在服务下次启动时释放数据库空间？`,
        description: t`启动前先重建数据库文件，期间所有设备都连不上服务，可能持续几分钟。`,
        confirmLabel: t`下次启动时释放`,
      });
      if (!confirmed) return;
    }
    setBusy(true);
    try { onChange(await api.scheduleCompaction(scheduled)); }
    catch (reason) { toast.error(errorMessage(reason, scheduled ? t`无法安排释放空间` : t`无法取消释放空间`)); }
    finally { setBusy(false); }
  };

  const description = compaction.scheduledAt
    ? t`将在服务下次启动时释放`
    : short
      ? t`磁盘可用空间不足，需要 ${formatBytes(compaction.requiredBytes)}`
      : database.freeBytes >= RECLAIM_WORTH_NAMING
        ? t`可释放 ${formatBytes(database.freeBytes)}，在服务下次启动时进行，期间服务不可用`
        : t`在服务下次启动时进行，期间服务不可用`;

  return (
    <>
      <Row title={<Trans>释放空间</Trans>} description={description}>
        {compaction.scheduledAt
          ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void schedule(false)}><Trans>取消</Trans></Button>
          : <Button size="sm" variant="secondary" disabled={busy || short} onClick={() => void schedule(true)}><Trans>下次启动时释放</Trans></Button>}
      </Row>
      {last && (
        <p className="py-2.5 text-2xs tabular-nums text-fg-4">
          {last.error
            ? <span className="text-danger"><Trans>上次释放未完成（{timeAgo(last.at)}）：{last.error}</Trans></span>
            : <Trans>上次释放 {timeAgo(last.at)} · {formatBytes(last.beforeBytes)} → {formatBytes(last.afterBytes)} · 用时 {formatDuration(last.durationMs)}</Trans>}
        </p>
      )}
    </>
  );
}

const projectTotal = (item: StorageProjectUsage) => item.sessionBytes + item.checkpointBytes + item.worktreeBytes;

const PROJECT_PARTS = [
  { key: 'sessionBytes', label: msg`会话`, color: DATABASE_COLOR },
  { key: 'checkpointBytes', label: 'Checkpoints', color: FOLDERS.checkpoints.color },
  { key: 'worktreeBytes', label: 'Worktrees', color: FOLDERS.worktrees.color },
] as const;

function TableHead({ children }: { children: ReactNode }) {
  return <thead><tr className="[&>th]:border-t [&>th]:border-line-soft [&>th]:px-2 [&>th]:py-2 [&>th]:text-2xs [&>th]:font-medium [&>th]:text-fg-3 [&>th:first-child]:pl-4 [&>th:last-child]:pr-4">{children}</tr></thead>;
}

const ROW = 'hover:bg-hover [&>td]:border-t [&>td]:border-line-soft [&>td]:px-2 [&>td]:py-2.5 [&>td]:align-middle [&>td:first-child]:pl-4 [&>td:last-child]:pr-4';

/** Sessions, checkpoints and worktrees together, since a project is what someone would clear out. */
function ProjectTable({ projects }: { projects: StorageProjectUsage[] }) {
  const { t } = useLingui();
  const max = Math.max(...projects.map(projectTotal));
  return (
    <Group title={t`按项目`}>
      <div className="-mx-4 overflow-x-auto max-md:-mx-3">
        <table className="w-full min-w-[560px] border-separate border-spacing-0 text-left text-xs">
          <TableHead>
            <th scope="col"><Trans>项目</Trans></th>
            <th scope="col" className="w-48"><span className="sr-only"><Trans>构成</Trans></span></th>
            {PROJECT_PARTS.map((part) => <th key={part.key} scope="col" className="w-20 text-right">{labelOf(part.label)}</th>)}
            <th scope="col" className="w-20 text-right"><Trans>合计</Trans></th>
          </TableHead>
          <tbody>
            {projects.map((project) => {
              const total = projectTotal(project);
              return (
                <tr key={project.projectId ?? ''} className={ROW}>
                  <td className="max-w-[14rem]"><span className={project.projectId ? 'block truncate font-medium text-fg' : 'block truncate text-fg-3'}>{project.name ?? t`已删除的项目`}</span></td>
                  <td>
                    <span className="flex h-1.5 overflow-hidden rounded-full bg-muted" style={{ width: `${Math.max((total / max) * 100, 2)}%` }}>
                      {PROJECT_PARTS.map((part) => project[part.key] > 0 && <span key={part.key} className="h-full" style={{ width: `${(project[part.key] / total) * 100}%`, background: part.color }} />)}
                    </span>
                  </td>
                  {PROJECT_PARTS.map((part) => <td key={part.key} className="text-right tabular-nums text-fg-3">{project[part.key] > 0 ? formatBytes(project[part.key]) : '—'}</td>)}
                  <td className="text-right font-medium tabular-nums text-fg">{formatBytes(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Group>
  );
}

function SessionTable({ data }: { data: StorageReport }) {
  const { t } = useLingui();
  const sessions = data.scan!.sessions;
  return (
    <Group title={t`占用最多的会话`}>
      <div className="-mx-4 overflow-x-auto max-md:-mx-3">
        <table className="w-full min-w-[480px] border-separate border-spacing-0 text-left text-xs">
          <TableHead>
            <th scope="col"><Trans context="settings-session-label">会话</Trans></th>
            <th scope="col" className="w-28 text-right"><Trans>最近活动</Trans></th>
            <th scope="col" className="w-20 text-right"><Trans>大小</Trans></th>
          </TableHead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.sessionId} className={ROW}>
                <td className="max-w-[22rem]">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-fg" title={session.title}>{session.title}</span>
                    {session.projectName && <span className="truncate text-2xs text-fg-4">{session.projectName}</span>}
                  </span>
                </td>
                <td className="text-right text-fg-3">{session.lastActivityAt ? timeAgo(session.lastActivityAt) : '—'}</td>
                <td className="text-right tabular-nums text-fg">{formatBytes(session.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Group>
  );
}

function FolderGroup({ data }: { data: StorageReport }) {
  const { t } = useLingui();
  const folders = data.scan!.folders;
  const max = Math.max(...folders.map((folder) => folder.bytes), 1);
  return (
    <Group title={t`文件`}>
      <ol className="flex flex-col gap-3 py-4">
        {ranked(folders, (folder) => folder.kind).map((folder) => {
          const meta = FOLDERS[folder.kind];
          return <ShareRow key={folder.kind} label={labelOf(meta.label)} note={meta.note && i18n._(meta.note)} bytes={folder.bytes} of={max} color={meta.color} />;
        })}
      </ol>
    </Group>
  );
}
