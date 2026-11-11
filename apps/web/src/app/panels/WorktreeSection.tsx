import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { WorktreeInfo } from '@contracts';
import { IconChevronRight, IconCopy, IconEllipsis, IconGitBranch, IconPlus, IconRefreshCw, IconSearch, IconTrash2, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Input, Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api, type ProjectRecord } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { copyWithToast } from '@/lib/files';
import { toast } from '@/lib/toast';
import { cn, errorMessage } from '@/lib/utils';
import { useLists } from '../state/stores';

const trimSlash = (path: string) => path.replace(/\/+$/, '');

export function WorktreeSection({ project, active, onError, onOpenWorktree }: {
  project: ProjectRecord;
  /** The panel is open; closed, nothing is read, and reopening reads once. */
  active: boolean;
  onError: (message: string) => void;
  onOpenWorktree?: (path: string) => void;
}) {
  const { t } = useLingui();
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>();
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [managedOpen, setManagedOpen] = useState(true);
  const [othersOpen, setOthersOpen] = useState<boolean>();
  const [revealPath, setRevealPath] = useState('');
  const rows = useRef(new Map<string, HTMLDivElement>());
  const mounted = useRef(false);
  const request = useRef(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  // Project registrations change when another entry point creates or removes an isolated copy.
  // Session activity does not trigger a worktree read; project writes also cover raw worktree operations.
  const projectSignature = useLists((state) => JSON.stringify(state.projects.map((item) => [item.id, item.cwd, item.worktree, item.updatedAt])));

  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    setRefreshing(true);
    try {
      const incoming = await api.worktrees(project.id);
      if (!mounted.current || sequence !== request.current) return;
      setWorktrees(incoming);
      setLoadError('');
    } catch (error) {
      if (!mounted.current || sequence !== request.current) return;
      const message = errorMessage(error, t`无法读取 Worktree`);
      setLoadError(message);
      errorHandler.current(message);
    } finally {
      if (mounted.current && sequence === request.current) setRefreshing(false);
    }
  }, [project.id]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);
  useEffect(() => { if (active) void refresh(); }, [active, refresh, projectSignature]);
  useEffect(() => {
    if (!active) return;
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [active, refresh]);

  const groups = useMemo(() => {
    const unique = [...new Map((worktrees ?? []).map((item) => [trimSlash(item.path), item])).values()];
    const current = unique.find((item) => item.current ?? trimSlash(item.path) === trimSlash(project.cwd));
    const rest = unique.filter((item) => item !== current);
    return { current, managed: rest.filter((item) => item.managed), others: rest.filter((item) => !item.managed) };
  }, [worktrees, project.cwd]);
  const search = query.trim().toLocaleLowerCase();
  const matches = (item: WorktreeInfo) => !search || `${item.branch ?? ''}\n${item.path}`.toLocaleLowerCase().includes(search);
  const found = (groups.current && matches(groups.current) ? 1 : 0) + groups.managed.filter(matches).length + groups.others.filter(matches).length;

  useEffect(() => {
    if (!revealPath || !worktrees) return;
    const created = worktrees.find((item) => item.path === revealPath);
    if (!created) return;
    if (created.managed) setManagedOpen(true); else setOthersOpen(true);
    // Scroll only after the target's group is mounted, including an old server's unclassified row.
    const frame = requestAnimationFrame(() => {
      const row = rows.current.get(revealPath);
      if (!row) return;
      row.scrollIntoView({ block: 'nearest' });
      setRevealPath('');
    });
    return () => cancelAnimationFrame(frame);
  }, [revealPath, worktrees, managedOpen, othersOpen]);

  const create = async () => {
    if (busy || !branch.trim()) return;
    setBusy(true);
    try {
      const created = await api.createWorktree(project.id, { branch: branch.trim(), ...(base.trim() ? { base: base.trim() } : {}) });
      if (!mounted.current) return;
      setBranch(''); setBase(''); setCreating(false); setQuery(''); setRevealPath(created.path);
      toast.success(t`Worktree 已创建`);
      await refresh();
    } catch (error) {
      if (mounted.current) errorHandler.current(errorMessage(error, t({ message: '无法创建 Worktree', context: 'panels-worktree-create-failed' })));
    } finally { if (mounted.current) setBusy(false); }
  };
  const remove = async (worktree: WorktreeInfo) => {
    const ok = await confirmDialog({ title: t`移除 Worktree？`, description: t`有未提交改动时 Git 会拒绝移除。`, detail: worktree.path, confirmLabel: t`移除`, destructive: true });
    if (!ok || !mounted.current) return;
    setBusy(true);
    try { await api.removeWorktree(project.id, worktree.path); if (mounted.current) await refresh(); }
    catch (error) { if (mounted.current) errorHandler.current(errorMessage(error, t`无法移除 Worktree`)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const row = (worktree: WorktreeInfo, current = false) => {
    const name = worktree.branch?.replace(/^refs\/heads\//, '') ?? t`分离 HEAD`;
    const canOpen = !current && !worktree.bare && Boolean(onOpenWorktree);
    return (
      <div key={worktree.path} ref={(element) => { if (element) rows.current.set(worktree.path, element); else rows.current.delete(worktree.path); }} className={cn('group/wt flex items-start gap-1 rounded-lg hover:bg-hover', current && 'bg-muted')}>
        <button type="button" disabled={!canOpen || busy} onClick={() => onOpenWorktree?.(worktree.path)} title={`${name}\n${worktree.path}\n${worktree.head}`} className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default">
          <IconGitBranch className={cn('mt-0.5 size-4 shrink-0', worktree.managed ? 'text-accent' : 'text-fg-3')} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-start gap-2">
              <span className="line-clamp-2 min-w-0 break-all text-sm font-medium text-fg">{name}</span>
              {current && <span className="shrink-0 rounded bg-accent-soft px-1 text-2xs font-medium text-accent"><Trans>当前</Trans></span>}
            </span>
            {!worktree.branch && <span className="font-mono text-2xs text-fg-3">{worktree.head.slice(0, 8)}</span>}
            <span className="block truncate text-left font-mono text-2xs text-fg-3 [direction:rtl]"><bdi>{worktree.path}</bdi></span>
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon-xs" variant="quiet" aria-label={t`更多操作`} className="mr-1 mt-1.5 shrink-0 max-md:size-10" disabled={busy}><IconEllipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void copyWithToast(worktree.path, t`已复制路径`)}><IconCopy /><Trans>复制路径</Trans></DropdownMenuItem>
            {!worktree.bare && !current && <DropdownMenuItem variant="danger" onSelect={() => void remove(worktree)}><IconTrash2 /><Trans>移除 Worktree</Trans></DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };
  const group = (label: string, items: WorktreeInfo[], open: boolean, onToggle: () => void) => {
    const visible = items.filter(matches);
    if (!items.length || (search && !visible.length)) return null;
    return (
      <div className="mt-2">
        <button type="button" className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-fg-3 hover:bg-hover" aria-expanded={Boolean(search) || open} onClick={onToggle}>
          <IconChevronRight className={cn('size-3.5 transition-transform', (search || open) && 'rotate-90')} />
          {label}<span className="ml-auto font-normal tabular-nums text-fg-4">{search ? visible.length : items.length}</span>
        </button>
        {(search || open) && visible.map((item) => row(item))}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-2">
        <div className="relative min-w-0 flex-1">
          <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t`搜索 Worktree`} aria-label={t`搜索 Worktree`} className="pl-8 max-md:h-10" />
        </div>
        <Tip label={creating ? t`收起创建` : t`创建 Worktree`}><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={creating ? t`收起创建` : t`创建 Worktree`} aria-expanded={creating} onClick={() => setCreating((value) => !value)}>{creating ? <IconX /> : <IconPlus />}</Button></Tip>
        <Tip label={t`刷新`}><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={t`刷新`} disabled={refreshing || busy} onClick={() => void refresh()}><IconRefreshCw className={cn(refreshing && 'animate-spin')} /></Button></Tip>
      </div>
      {creating && (
        <form className="flex shrink-0 flex-col gap-2 px-3 pb-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <Input autoFocus value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={t`新分支名`} aria-label={t`新分支名`} disabled={busy} />
          <div className="flex gap-2">
            <Input value={base} onChange={(event) => setBase(event.target.value)} placeholder={t`基于（可选）`} aria-label={t`基于（可选）`} disabled={busy} />
            <Button type="submit" disabled={!branch.trim() || busy}>{busy ? <Spinner /> : <IconPlus />}<Trans context="panels-create-action">创建</Trans></Button>
          </div>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!worktrees && !loadError && <div className="flex justify-center py-10"><Spinner /></div>}
        {!worktrees && loadError && <EmptyState title={loadError} />}
        {worktrees && !found && <EmptyState title={search ? t`没有匹配的 Worktree` : t`没有 Worktree`} />}
        {groups.current && matches(groups.current) && row(groups.current, true)}
        {group('Riffet', groups.managed, managedOpen, () => setManagedOpen((value) => !value))}
        {group(t`其他`, groups.others, othersOpen ?? groups.managed.length === 0, () => setOthersOpen((value) => !(value ?? groups.managed.length === 0)))}
      </div>
    </div>
  );
}
