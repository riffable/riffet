import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconChevronDown, IconCopy, IconDownload, IconGitBranch, IconPlus, IconTag, IconX } from '@/components/icons';
import type { GitCommit, GitCommitDetail, GitRefLabel, GitRefs, GitStatus } from '@contracts';
import { Button } from '@/components/ui/button';
import { EmptyState, Segmented, Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api, HttpError, type ProjectRecord } from '@/lib/api';
import { promptDialog } from '@/lib/dialogs';
import { copyText } from '@/lib/files';
import { gitDateTime, gitTimeAgo } from './gitFormat';
import { toast } from '@/lib/toast';
import { basename, cn, errorMessage } from '@/lib/utils';
import { layoutGraph, type GraphRow } from './gitGraph';

const LANE = 12;
const ROW = 28;
/** Lanes drawn before the graph is cut off, so a wide history still leaves room for the message. */
const MAX_LANES = 9;
const LANE_COLORS = 6;
const REMOTES_IN_MENU = 30;
/** Files of one commit drawn in its detail; a merge can bring in tens of thousands. */
const FILES_SHOWN = 300;
const laneX = (column: number) => column * LANE + LANE / 2 + 2;
const laneColor = (color: number) => `var(--lane-${color % LANE_COLORS})`;

/** One row of the graph: the lanes passing by, the lines meeting at the commit, and its dot. */
function GraphCell({ row, head, lanes }: { row: GraphRow; head: boolean; lanes: number }) {
  const mid = ROW / 2;
  const x = laneX(row.column);
  const bend = (fromX: number, fromY: number, toX: number, toY: number) =>
    fromX === toX ? `M${fromX} ${fromY}V${toY}` : `M${fromX} ${fromY}C${fromX} ${fromY + (toY - fromY) * 0.7} ${toX} ${fromY + (toY - fromY) * 0.3} ${toX} ${toY}`;
  return (
    <svg width={lanes * LANE + 4} height={ROW} className="shrink-0 overflow-hidden" fill="none" strokeWidth={1.5} aria-hidden>
      {row.through.map((lane) => <path key={`t${lane.column}`} d={`M${laneX(lane.column)} 0V${ROW}`} stroke={laneColor(lane.color)} />)}
      {row.from.map((lane) => <path key={`f${lane.column}`} d={bend(laneX(lane.column), 0, x, mid)} stroke={laneColor(lane.color)} />)}
      {row.to.map((lane, index) => <path key={`p${index}`} d={bend(x, mid, laneX(lane.column), ROW)} stroke={laneColor(lane.color)} />)}
      <circle cx={x} cy={mid} r={head ? 4 : 3.5} fill={head ? 'var(--bg)' : laneColor(row.color)} stroke={head ? laneColor(row.color) : 'var(--bg)'} strokeWidth={head ? 2 : 1} />
    </svg>
  );
}

function RefChip({ label }: { label: GitRefLabel }) {
  return (
    <span className={cn('flex h-4 max-w-28 shrink-0 items-center gap-0.5 rounded-sm px-1 font-mono text-2xs', label.current ? 'bg-accent-soft text-accent' : label.kind === 'remote' ? 'bg-muted text-fg-3' : 'bg-muted text-fg-2')}>
      {label.kind === 'tag' && <IconTag className="size-2.5 shrink-0" />}
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** A branch and the remote branch it is level with say the same thing twice; the remote one is dropped. */
function shownRefs(refs: GitRefLabel[]): GitRefLabel[] {
  const local = new Set(refs.filter((label) => label.kind === 'branch').map((label) => label.name));
  return refs.filter((label) => label.kind !== 'remote' || !local.has(label.name.slice(label.name.indexOf('/') + 1)));
}

const refsKey = (refs: GitRefs) => JSON.stringify([refs.head, refs.branches.map((item) => item.hash), refs.remoteCount, refs.tags.length]);

/** A file of a commit, for the diff the panel opens. */
export interface CommitFile { path: string; commit: string; from?: string }

/**
 * The history tab: the commit graph, the branch that is checked out and the ones it can switch to,
 * and what a chosen commit changed.
 */
export function HistorySection({ project, status, active, onError, onShowFile, onChanged }: {
  project: ProjectRecord;
  /** Read again whenever the working tree's status is, since a commit or a switch moves the history. */
  status?: GitStatus;
  active: boolean;
  onError: (message: string) => void;
  onShowFile: (file: CommitFile) => void;
  /** The checkout moved (a switch, a pull), so what the other tabs show is out of date. */
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const projectId = project.id;
  const [all, setAll] = useState(false);
  const [refs, setRefs] = useState<GitRefs>();
  const [log, setLog] = useState<{ key: string; commits: GitCommit[]; more: boolean }>();
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState<'fetch' | 'switch' | 'more'>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<GitCommitDetail>();
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => { setRefs(undefined); setLog(undefined); setSelected(undefined); setFailed(''); }, [projectId]);
  useEffect(() => {
    if (!active) return;
    let stale = false;
    void api.gitRefs(projectId).then((value) => { if (!stale) setRefs(value); }, (error) => { if (!stale) setFailed(errorMessage(error, t`Couldn't load branches`)); });
    return () => { stale = true; };
  }, [active, projectId, status]);

  // The first page is read again only when a ref has moved; pages already loaded below it are dropped
  // then, since their rows would no longer line up with the new ones.
  const key = refs ? `${all}:${refsKey(refs)}` : undefined;
  useEffect(() => {
    if (!active || !key || log?.key === key) return;
    let stale = false;
    void api.gitLog(projectId, { all }).then(
      (page) => { if (!stale) { setLog({ key, ...page }); setFailed(''); } },
      (error) => { if (!stale) setFailed(errorMessage(error, t`Couldn't load history`)); },
    );
    return () => { stale = true; };
  }, [active, key, projectId, all, log?.key]);

  const loadMore = useCallback(async () => {
    if (!log?.more || busy) return;
    setBusy('more');
    try {
      const page = await api.gitLog(projectId, { all, skip: log.commits.length });
      setLog((current) => (current?.key === log.key ? { key: current.key, commits: [...current.commits, ...page.commits], more: page.more } : current));
    } catch (error) { onError(errorMessage(error, t`Couldn't load history`)); }
    finally { setBusy(undefined); }
  }, [log, busy, projectId, all, onError]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !log?.more) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadMore(); }, { rootMargin: '400px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [log?.more, loadMore]);

  useEffect(() => {
    setDetail(undefined);
    if (!selected) return;
    let stale = false;
    void api.gitCommit(projectId, selected).then((value) => { if (!stale) setDetail(value); }, (error) => { if (!stale) { setSelected(undefined); onError(errorMessage(error, t`Couldn't load this commit`)); } });
    return () => { stale = true; };
  }, [selected, projectId, onError]);

  const rows = useMemo(() => layoutGraph(log?.commits ?? []), [log?.commits]);
  // One width for every row, so the subjects line up.
  const lanes = useMemo(() => Math.min(MAX_LANES, rows.reduce((widest, row) => Math.max(widest, row.width), 1)), [rows]);
  // A fetch can move remote branches without moving any local one, so the history is read again regardless.
  const moved = (next: GitRefs) => { setLog(undefined); setRefs(next); onChanged(); };
  const act = async (kind: 'fetch' | 'switch', task: () => Promise<GitRefs>, failure: string) => {
    if (busy) return;
    setBusy(kind);
    try { moved(await task()); }
    catch (error) { onError(error instanceof HttpError && error.code === 'GIT_SWITCH_BLOCKED' ? t`Uncommitted changes would be overwritten. Commit or discard them first.` : errorMessage(error, failure)); }
    finally { setBusy(undefined); }
  };
  const createBranch = async (base?: string) => {
    const name = await promptDialog({ title: t`New Branch`, ...(base ? { description: base.slice(0, 8) } : {}), placeholder: 'feature/name', confirmLabel: t`Create and Switch` });
    if (name?.trim()) void act('switch', () => api.gitSwitch(projectId, { branch: name.trim(), create: true, ...(base ? { base } : {}) }), t`Couldn't create the branch`);
  };

  // A repository can have tens of thousands of remote branches: a handful are listed, the rest are found by name.
  const remoteOnly = refs && refs.remoteCount <= REMOTES_IN_MENU ? refs.remotes : [];
  const checkoutRemote = async () => {
    const name = await promptDialog({ title: t`Check Out Remote Branch`, placeholder: 'origin/feature/name', confirmLabel: t`Check Out` });
    if (name?.trim()) void act('switch', () => api.gitSwitch(projectId, { remote: name.trim() }), t`Couldn't switch branches`);
  };

  return (
    <div className="git-graph flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2.5 pb-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" disabled={!refs || Boolean(busy)} className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-fg-2 hover:bg-hover disabled:opacity-60">
              {busy === 'switch' ? <Spinner className="size-3.5" /> : <IconGitBranch className="size-3.5 shrink-0 text-fg-3" />}
              <span className="min-w-0 truncate font-mono">{refs ? refs.head ?? 'HEAD' : status?.branch ?? '…'}</span>
              <IconChevronDown className="size-3 shrink-0 text-fg-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-96 max-w-80 overflow-y-auto">
            <DropdownMenuRadioGroup value={refs?.head ?? ''} onValueChange={(name) => { if (name !== refs?.head) void act('switch', () => api.gitSwitch(projectId, { branch: name }), t`Couldn't switch branches`); }}>
              {refs?.branches.map((branch) => (
                <DropdownMenuRadioItem key={branch.name} value={branch.name} disabled={branch.elsewhere} title={branch.elsewhere ? t`Checked out in another worktree` : branch.name}>
                  <span className="min-w-0 truncate font-mono text-xs">{branch.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {remoteOnly.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Remote</DropdownMenuLabel>
                {remoteOnly.map((remote) => (
                  <DropdownMenuItem key={remote.name} onSelect={() => void act('switch', () => api.gitSwitch(projectId, { remote: remote.name }), t`Couldn't switch branches`)}>
                    <span className="min-w-0 truncate font-mono text-xs text-fg-2">{remote.name}</span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            {refs && refs.remoteCount > REMOTES_IN_MENU && <DropdownMenuItem onSelect={() => void checkoutRemote()}><IconDownload /><Trans>Check Out Remote Branch…</Trans></DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => void createBranch()}><IconPlus /><Trans>New Branch…</Trans></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Segmented size="xs" className="ml-auto" value={all ? 'all' : 'head'} onChange={(value) => setAll(value === 'all')} ariaLabel={t`History scope`} options={[{ value: 'head', label: t`Current` }, { value: 'all', label: t`All` }]} />
        <Tip label="Fetch"><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label="Fetch" disabled={Boolean(busy)} onClick={() => void act('fetch', () => api.gitFetch(projectId), t`Fetch failed`)}>{busy === 'fetch' ? <Spinner /> : <IconDownload />}</Button></Tip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!log && !failed && <div className="flex justify-center py-10"><Spinner /></div>}
        {failed && !log && <EmptyState title={failed} />}
        {log && !log.commits.length && <EmptyState title={t`No commits yet`} />}
        {log?.commits.map((commit, index) => {
          const labels = shownRefs(commit.refs);
          const head = commit.refs.some((label) => label.current || label.kind === 'head');
          return (
            <button key={commit.hash} type="button" aria-pressed={selected === commit.hash} onClick={() => setSelected((current) => (current === commit.hash ? undefined : commit.hash))}
              className={cn('flex w-full items-center gap-1.5 pl-2 pr-3 text-left hover:bg-hover', selected === commit.hash && 'bg-active hover:bg-active')} style={{ height: ROW }} title={`${commit.author} · ${gitDateTime(commit.date)}`}>
              <GraphCell row={rows[index]!} head={head} lanes={lanes} />
              {labels.slice(0, 2).map((label) => <RefChip key={`${label.kind}:${label.name}`} label={label} />)}
              {labels.length > 2 && <span className="shrink-0 text-2xs text-fg-4">+{labels.length - 2}</span>}
              <span className={cn('min-w-0 flex-1 truncate text-sm', commit.parents.length > 1 ? 'text-fg-3' : 'text-fg')}>{commit.subject}</span>
              <span className="shrink-0 text-2xs tabular-nums text-fg-4">{gitTimeAgo(commit.date)}</span>
            </button>
          );
        })}
        {log?.more && <div ref={sentinel} className="flex h-10 items-center justify-center">{busy === 'more' && <Spinner />}</div>}
      </div>

      {selected && (
        <div className="flex max-h-[55%] shrink-0 flex-col edge-t">
          <div className="flex items-start gap-2 px-3 pt-2.5">
            <p className="min-w-0 flex-1 text-sm font-medium text-fg">{detail?.subject ?? log?.commits.find((commit) => commit.hash === selected)?.subject}</p>
            <Tip label={t`New Branch from Here`}><Button size="icon-xs" variant="quiet" aria-label={t`New Branch from Here`} disabled={Boolean(busy)} onClick={() => void createBranch(selected)}><IconGitBranch /></Button></Tip>
            <Button size="icon-xs" variant="quiet" aria-label={t`Close`} onClick={() => setSelected(undefined)}><IconX /></Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {!detail ? <div className="flex justify-center py-6"><Spinner /></div> : (
              <>
                <div className="flex flex-col gap-1.5 px-2 pb-2">
                  {detail.body && <p className="whitespace-pre-wrap break-words text-xs text-fg-2">{detail.body}</p>}
                  <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
                    <span className="min-w-0 truncate">{detail.author}</span>
                    <span className="shrink-0">{gitDateTime(detail.date)}</span>
                    <button type="button" className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 font-mono text-fg-2 hover:bg-hover" onClick={() => void copyText(detail.hash).then((copied) => { if (copied) toast.success(t`Copied`); })}>
                      {detail.hash.slice(0, 8)}<IconCopy className="size-3 text-fg-4" />
                    </button>
                  </div>
                </div>
                {(detail.filesTotal ?? detail.files.length) > FILES_SHOWN ? <p className="px-2 pb-1 text-xs text-fg-4"><Trans>Showing the first {FILES_SHOWN} of {detail.filesTotal ?? detail.files.length} files</Trans></p> : null}
                {detail.files.slice(0, FILES_SHOWN).map((file) => {
                  const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
                  const tone = file.status === 'A' ? 'text-success' : file.status === 'D' ? 'text-danger' : file.status === 'R' ? 'text-accent' : 'text-warning';
                  return (
                    <button key={file.path} type="button" onClick={() => onShowFile({ path: file.path, commit: detail.hash, ...(file.originalPath ? { from: file.originalPath } : {}) })}
                      className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-hover max-md:h-11 no-hover:h-11" title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}>
                      <span className="min-w-0 shrink truncate text-fg">{basename(file.path)}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{directory}</span>
                      {(file.added || file.removed) ? <span className="flex shrink-0 items-center gap-1 text-2xs tabular-nums">{file.added ? <span className="text-success">+{file.added}</span> : null}{file.removed ? <span className="text-danger">−{file.removed}</span> : null}</span> : null}
                      <span className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', tone)}>{file.status}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
