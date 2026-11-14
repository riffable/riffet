import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { IconChevronRight, IconGitCommitHorizontal, IconMessageSquareText, IconMinus, IconPlus, IconRefreshCw, IconRotateCcw, IconSave, IconSend, IconUndo2, IconX } from '@/components/icons';
import type { Checkpoint, CheckpointChange, GitDiff, GitEntry, GitLineChange, ReviewComment } from '@contracts';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { EmptyState, Input, Segmented, Spinner, Textarea } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tip } from '@/components/ui/tooltip';
import { api, HttpError, type ProjectRecord } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { createStore, useStore } from '@/lib/store';
import { toast } from '@/lib/toast';
import { basename, cn, errorMessage, newId, readSession, writeSession } from '@/lib/utils';
import { gitDateTime } from './gitFormat';
import MergeDiff, { type ChunkControls, type LineRange, type Marks } from './MergeDiff';
import { HistorySection } from './HistorySection';
import { PublishSection } from './PublishSection';
import { WorktreeSection } from './WorktreeSection';
import { isComposingKey } from '../session/composerKeyboard';
import { refreshGitStatus, useGitStatus, watchGitStatus } from '../state/gitStatusStore';

const staged = (entry: GitEntry) => entry.index !== ' ' && entry.index !== '?';
const unstaged = (entry: GitEntry) => entry.worktree !== ' ' || entry.index === '?';

function codeLetter(code: string): { letter: string; className: string } {
  if (code === '?' || code === 'A') return { letter: code === '?' ? 'U' : 'A', className: 'text-success' };
  if (code === 'D') return { letter: 'D', className: 'text-danger' };
  if (code === 'R') return { letter: 'R', className: 'text-accent' };
  return { letter: code, className: 'text-warning' };
}
const statusLetter = (entry: GitEntry) => codeLetter((entry.worktree !== ' ' ? entry.worktree : entry.index).trim() || ' ');
const KIND_CODE: Record<CheckpointChange['kind'], string> = { added: 'A', modified: 'M', deleted: 'D' };

const ROWS_SHOWN = 300;
/** What the list compares the working tree with: what is committed, where this turn started, or where the branch left the main line. */
type Scope = 'working' | 'turn' | 'branch';
/** The comparison a diff shows, kept so it can be read again once it has changed. */
interface DiffTarget { path: string; staged?: boolean; base?: string; /** The branch a commit `base` was found on, to name it by. */ ref?: string; /** What one commit changed; `from` is the path a renamed file had before it. */ commit?: string; from?: string }
interface ScopedFile { path: string; code: string; added?: number; removed?: number }

const lineLabel = (comment: Pick<ReviewComment, 'line' | 'endLine'>) =>
  comment.line === undefined ? i18n._(msg`Whole file`) : comment.endLine && comment.endLine !== comment.line ? i18n._(msg`Lines ${comment.line}–${comment.endLine}`) : i18n._(msg`Line ${comment.line}`);

/**
 * The remark box under a diff. Clicking a line number picks the line, shift-click stretches it into
 * a range; the remark is kept with the quoted lines so it still reads right after the file moves on.
 */
function ReviewComposer({ path, draft, comments, onDraft, onAdd, onRemove }: {
  path: string;
  draft?: { range: LineRange; lines: string[] };
  comments: ReviewComment[];
  onDraft: (draft: undefined) => void;
  onAdd: (comment: ReviewComment) => void;
  onRemove: (comment: ReviewComment) => void;
}) {
  const { t } = useLingui();
  const [body, setBody] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (draft) input.current?.focus(); }, [draft]);
  const add = () => {
    if (!draft || !body.trim()) return;
    onAdd({ path, line: draft.range.from, ...(draft.range.to !== draft.range.from ? { endLine: draft.range.to } : {}), body: body.trim(), quote: draft.lines.join('\n') });
    setBody('');
  };
  return (
    <div className="flex shrink-0 flex-col gap-2 px-5 pb-4 max-md:px-3 max-md:pb-3">
      {comments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {comments.map((comment) => (
            <span key={`${comment.line}:${comment.body}`} className="group/rc flex h-6 max-w-72 items-center gap-1.5 rounded-md bg-accent-soft pl-2 pr-1 text-xs text-fg-2" title={comment.body}>
              <span className="shrink-0 font-medium tabular-nums text-accent">{comment.line ?? '—'}{comment.endLine && comment.endLine !== comment.line ? `–${comment.endLine}` : ''}</span>
              <span className="min-w-0 truncate">{comment.body}</span>
              <button type="button" aria-label={t`Delete comment`} className="flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-4 hover:bg-hover hover:text-fg-2" onClick={() => onRemove(comment)}><IconX className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
      {draft ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-elevated p-2.5 shadow-xs">
          <div className="flex items-center gap-2 text-xs text-fg-3">
            <IconMessageSquareText className="size-3.5 text-accent" />
            <span className="text-fg-2">{lineLabel({ line: draft.range.from, endLine: draft.range.to })}</span>
            <span className="min-w-0 truncate font-mono text-fg-4">{draft.lines[0]?.trim()}</span>
          </div>
          <Textarea ref={input} className="min-h-16 text-sm" value={body} onChange={(event) => setBody(event.target.value)} placeholder={t`What should the agent change? (⌘↵ to add)`} aria-label={t`Review comment`}
            onKeyDown={(event) => {
              if (isComposingKey(event.nativeEvent)) return;
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); add(); }
              if (event.key === 'Escape') { event.stopPropagation(); onDraft(undefined); }
            }} />
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => onDraft(undefined)}><Trans>Cancel</Trans></Button>
            <Button size="xs" variant="primary" disabled={!body.trim()} onClick={add}><Trans>Add Comment</Trans></Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-fg-4"><Trans>Comment on a line number; Shift selects a range. Comments are sent together below the list.</Trans></p>
      )}
    </div>
  );
}

/**
 * Review remarks and the commit message, per project. They outlive the panel (a phone's sheet
 * unmounts it on close), and this tab's sessionStorage carries them over a reload.
 */
interface GitDraft { reviews: ReviewComment[]; message: string }
const NO_DRAFT: GitDraft = { reviews: [], message: '' };
const drafts = createStore<Record<string, GitDraft>>({});
const draftKey = (projectId: string) => `riffet.git-draft.${projectId}`;

function storedDraft(projectId: string): GitDraft {
  const value = readSession(draftKey(projectId)) as Partial<GitDraft> | null | undefined;
  return { reviews: Array.isArray(value?.reviews) ? value.reviews : [], message: typeof value?.message === 'string' ? value.message : '' };
}

function updateDraft(projectId: string, update: (draft: GitDraft) => Partial<GitDraft>): void {
  const current = drafts.get()[projectId] ?? storedDraft(projectId);
  const next = { ...current, ...update(current) };
  drafts.set({ [projectId]: next });
  writeSession(draftKey(projectId), next.reviews.length || next.message ? next : undefined);
}

function useGitDraft(projectId: string): GitDraft {
  // Before paint, so a reload does not show the panel without its remarks first.
  useLayoutEffect(() => { if (!drafts.get()[projectId]) drafts.set({ [projectId]: storedDraft(projectId) }); }, [projectId]);
  return useStore(drafts, (state) => state[projectId] ?? NO_DRAFT);
}

export function GitPanel({ project, sessionId, active, onError, onOpenWorktree, onMerged }: {
  project: ProjectRecord;
  sessionId?: string;
  /** The panel is open. Closed (still mounted on a wide screen), it reads nothing. */
  active: boolean;
  onError: (message: string) => void;
  onOpenWorktree?: (path: string) => void;
  /** A worktree's branch landed in the project it was cut from. */
  onMerged?: (result: { originProjectId: string; removedWorktree: boolean }) => void;
}) {
  const { t } = useLingui();
  const changeLabel: Record<CheckpointChange['kind'], string> = { added: t`Added`, modified: t`Modified`, deleted: t`Deleted` };
  const projectId = project.id;
  const [tab, setTab] = useState<'changes' | 'history' | 'checkpoints' | 'worktrees'>('changes');
  const { status, error: statusError = '' } = useGitStatus(projectId) ?? {};
  const [diff, setDiff] = useState<GitDiff>();
  const [target, setTarget] = useState<DiffTarget>();
  const [diffOpen, setDiffOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('working');
  const [turn, setTurn] = useState<Checkpoint>();
  // Whether there is a main line to compare with comes with the status; the comparison itself is read only when asked for.
  const comparable = Boolean(status?.base);
  const [scoped, setScoped] = useState<{ scope: Scope; files?: ScopedFile[]; total?: number; base?: string; ref?: string; error?: string }>();
  /** Rows drawn at once: a refactor across thousands of files should not cost the panel its frame rate. */
  const [shownRows, setShownRows] = useState(ROWS_SHOWN);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>();
  const [changes, setChanges] = useState<Record<string, CheckpointChange[]>>({});
  const [checkpointTitle, setCheckpointTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const { reviews, message } = useGitDraft(projectId);
  const setReviews = (update: (current: ReviewComment[]) => ReviewComment[]) => updateDraft(projectId, (current) => ({ reviews: update(current.reviews) }));
  const setMessage = (value: string) => updateDraft(projectId, () => ({ message: value }));
  const [draft, setDraft] = useState<{ range: LineRange; lines: string[] }>();
  const [reviewOpen, setReviewOpen] = useState(false);

  /** After a write here: an answer already on its way may predate it. */
  const refreshStatus = useCallback(() => refreshGitStatus(projectId, true), [projectId]);
  const refreshCheckpoints = useCallback(async () => setCheckpoints(await api.checkpoints(projectId)), [projectId]);

  useEffect(() => { setCheckpoints(undefined); setChanges({}); }, [projectId]);
  useEffect(() => { setScope('working'); setTurn(undefined); setScoped(undefined); }, [projectId, sessionId]);
  useEffect(() => { setShownRows(ROWS_SHOWN); }, [projectId, scope]);
  const reading = active && tab === 'changes';
  // The turn this conversation is in, or has just finished, started from its newest checkpoint.
  useEffect(() => {
    if (!reading || !sessionId) return;
    let stale = false;
    void api.sessionCheckpoints(sessionId).then((list) => list[0], () => undefined).then((value) => { if (!stale) setTurn(value); });
    return () => { stale = true; };
  }, [reading, sessionId, status]);
  const shownScope: Scope = (scope === 'turn' && !turn) || (scope === 'branch' && !comparable) ? 'working' : scope;
  const turnId = turn?.id;
  useEffect(() => {
    if (!reading || shownScope === 'working') return;
    let stale = false;
    const read = shownScope === 'turn'
      ? api.checkpointChanges(projectId, turnId!).then((list) => ({ files: list.map((change) => ({ path: change.path, code: KIND_CODE[change.kind] })) }))
      : api.gitCompare(projectId).then((result) => ({ base: result.base, ...(result.filesTotal ? { total: result.filesTotal } : {}), ...(result.ref ? { ref: result.ref } : {}), files: result.files.map((file) => ({ path: file.path, code: file.status, ...(file.added ? { added: file.added } : {}), ...(file.removed ? { removed: file.removed } : {}) })) }));
    void read.then(
      (value) => { if (!stale) setScoped({ scope: shownScope, ...value }); },
      (error) => { if (!stale) setScoped({ scope: shownScope, error: errorMessage(error, t`Couldn't load changes`) }); },
    );
    return () => { stale = true; };
  }, [reading, shownScope, turnId, projectId, status]);
  const scopedList = scoped?.scope === shownScope ? scoped : undefined;
  useEffect(() => { setDraft(undefined); }, [diff]);
  useEffect(() => (active && (tab === 'changes' || tab === 'history') ? watchGitStatus(projectId) : undefined), [active, tab, projectId]);
  useEffect(() => {
    if (active && tab === 'checkpoints') void refreshCheckpoints().catch((error) => onError(errorMessage(error, t`Couldn't load checkpoints`)));
  }, [active, tab, refreshCheckpoints, onError]);

  const stagedCount = useMemo(() => status?.entries.filter(staged).length ?? 0, [status]);
  const unstagedCount = useMemo(() => status?.entries.filter(unstaged).length ?? 0, [status]);

  const run = async (task: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try { await task(); return true; }
    catch (error) { onError(errorMessage(error, failure)); return false; }
    finally { setBusy(false); }
  };

  const canCommit = Boolean(message.trim()) && stagedCount > 0 && !busy;
  const commit = () => {
    if (!canCommit) return;
    void run(async () => { await api.commit(projectId, message.trim()); setMessage(''); toast.success(t`Committed`); await refreshStatus(); }, t`Commit failed`);
  };

  const marks = useMemo<Marks | undefined>(() => diff && {
    commented: reviews.filter((comment) => comment.path === diff.path && comment.line !== undefined).map((comment) => ({ from: comment.line!, to: comment.endLine ?? comment.line! })),
    ...(draft ? { selected: draft.range } : {}),
  }, [diff, reviews, draft]);
  const pickLine = useCallback((line: number, _text: string, extend: boolean) => {
    if (!diff) return;
    setDraft((current) => {
      const range = extend && current ? { from: Math.min(current.range.from, line), to: Math.max(current.range.to, line) } : { from: line, to: line };
      return { range, lines: diff.after.split('\n').slice(range.from - 1, range.to) };
    });
  }, [diff]);
  const sendReviews = () => {
    if (!sessionId || !reviews.length) return;
    void run(async () => {
      await api.sendReview(sessionId, { commandId: newId(), comments: reviews });
      setReviews((current) => current.filter((comment) => !reviews.includes(comment)));
      setReviewOpen(false);
      toast.success(plural(reviews.length, { 1: 'Sent # comment to the agent', other: 'Sent # comments to the agent' }));
    }, t`Couldn't send the comments`);
  };

  const clearReviews = () => {
    const cleared = reviews;
    setReviews(() => []);
    toast.success(t`Comments cleared`, { action: { label: t`Undo`, onClick: () => updateDraft(projectId, (current) => ({ reviews: [...cleared, ...current.reviews] })) } });
  };

  const showDiff = async (next: DiffTarget) => {
    try { setDiff(await api.gitDiff(projectId, next.path, next)); setTarget(next); setDiffOpen(true); }
    catch (error) { onError(errorMessage(error, t`Couldn't load the diff`)); }
  };
  /** After a change to the file on show: reads it again, and closes the diff when nothing is left to see. */
  const reloadDiff = async () => {
    if (!target) return;
    const next = await api.gitDiff(projectId, target.path, target);
    if (!next.binary && next.before === next.after) setDiffOpen(false);
    else setDiff(next);
  };

  const undoDiscard = (backup: Checkpoint) => void run(async () => {
    await api.restoreCheckpoint(projectId, backup.id, await api.checkpointChanges(projectId, backup.id));
    await Promise.all([refreshStatus(), reloadDiff()]);
  }, t`Couldn't undo`);
  const discarded = (backup?: Checkpoint) => toast.success(t`Discarded`, backup ? { action: { label: t`Undo`, onClick: () => undoDiscard(backup) } } : undefined);
  const discardFile = (entry: GitEntry) => void run(async () => {
    try { discarded((await api.gitDiscard(projectId, [entry.path])).backup); }
    catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'DISCARD_UNRECOVERABLE') throw error;
      if (!(await confirmDialog({ title: t`Discard "${basename(entry.path)}"?`, description: t`This file can't be backed up first, so this can't be undone.`, confirmLabel: t`Discard`, destructive: true }))) return;
      await api.gitDiscard(projectId, [entry.path], true);
      discarded();
    }
    await refreshStatus();
  }, t`Discard failed`);

  /** One changed block of the diff on show: staged, taken out of the index, or taken back in the working tree. */
  const applyChunk = (type: 'accept' | 'reject', change: GitLineChange) => {
    if (!diff?.version || !target || busy) return;
    const action = target.staged ? 'unstage' : type === 'accept' ? 'stage' : 'discard';
    void run(async () => {
      try {
        const result = await api.gitLines(projectId, { path: target.path, action, changes: [change], version: diff.version!, ...(target.base ? { base: target.base } : {}) });
        if (action === 'discard') discarded(result.backup);
      } catch (error) {
        // The agent, or another window, got to the file first: show what is there now instead.
        if (!(error instanceof HttpError) || error.code !== 'GIT_DIFF_STALE') throw error;
        toast.info(t`File changed, reloaded`);
      }
      await Promise.all([refreshStatus(), reloadDiff()]);
    }, t`Couldn't apply this change`);
  };
  const controls = useMemo<ChunkControls | undefined>(() => {
    if (!diff?.version || !target) return undefined;
    if (target.commit) return undefined;
    if (target.staged) return { reject: t`Unstage`, onChunk: () => {} };
    // Against a commit the diff is for reading; against this turn's start a block can be put back as it was.
    if (target.base) return target.base.startsWith('checkpoint:') ? { reject: t`Revert`, onChunk: () => {} } : undefined;
    return { accept: t`Stage`, reject: t`Discard`, onChunk: () => {} };
  }, [diff?.version, target, t]);
  const shownEntry = target && !target.base && !target.commit ? status?.entries.find((entry) => entry.path === target.path) : undefined;
  const bothSides = Boolean(shownEntry && staged(shownEntry) && shownEntry.worktree !== ' ');

  const restore = async (checkpoint: Checkpoint) => {
    let list = changes[checkpoint.id];
    if (!list) {
      try { list = await api.checkpointChanges(projectId, checkpoint.id); setChanges((current) => ({ ...current, [checkpoint.id]: list! })); }
      catch (error) { onError(errorMessage(error, t`Couldn't load the checkpoint`)); return; }
    }
    const detail = list.length
      ? list.map((change) => `${changeLabel[change.kind]}  ${change.path}\n      ${change.beforeHash?.slice(0, 12) ?? '—'} → ${change.afterHash?.slice(0, 12) ?? '—'}`).join('\n')
      : t`No file differences`;
    const ok = await confirmDialog({
      title: t`Restore "${checkpoint.title}"?`,
      description: t`If any of these files changes before the restore, it is refused.`,
      detail,
      confirmLabel: t`Restore`,
      destructive: true,
    });
    if (!ok) return;
    if (await run(() => api.restoreCheckpoint(projectId, checkpoint.id, list!), t`Restore refused`)) {
      toast.success(t`Restored`);
      setChanges((current) => { const next = { ...current }; delete next[checkpoint.id]; return next; });
      void refreshStatus(); void refreshCheckpoints();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <Segmented size="xs" className="max-md:[&_button]:h-8 max-md:[&_button]:px-3 max-md:[&_button]:text-sm" value={tab} onChange={setTab} ariaLabel={t`Git view`} options={[{ value: 'changes', label: t`Changes` }, ...(status ? [{ value: 'history' as const, label: t`History` }] : []), { value: 'checkpoints', label: t`Checkpoints` }, ...(!project.system ? [{ value: 'worktrees' as const, label: t`Worktrees` }] : [])]} />
        {(tab === 'changes' || tab === 'history') && <Tip label={t`Refresh`}><Button size="icon-xs" variant="quiet" className="ml-auto max-md:size-10" aria-label={t`Refresh`} onClick={() => void refreshStatus()}><IconRefreshCw /></Button></Tip>}
      </div>

      {tab === 'changes' && (
        <>
          {statusError ? <div className="h-2 shrink-0" /> : <PublishSection project={project} status={status} sessionId={sessionId} active={active} onError={onError} onMerged={(result) => { void refreshStatus(); onMerged?.(result); }} />}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {!status && !statusError && <div className="flex justify-center py-10"><Spinner /></div>}
            {statusError && <EmptyState title={t`Not a Git repository`} description={statusError} />}
            {status && (turn || comparable || status.entries.length > 0) && (
              <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
                {(turn || comparable) && <Segmented size="xs" className="shrink-0" value={shownScope} onChange={setScope} ariaLabel={t`Compare with`} options={[{ value: 'working', label: 'Uncommitted' }, ...(turn ? [{ value: 'turn' as const, label: t`This Turn` }] : []), ...(comparable ? [{ value: 'branch' as const, label: t`Branch` }] : [])]} />}
                {shownScope === 'working' && status.entries.length > 0 && (
                  <>
                    <Button size="xs" variant="ghost" className="ml-auto shrink-0" disabled={!unstagedCount || busy} onClick={() => void run(async () => { await api.stage(projectId, status.entries.map((entry) => entry.path)); await refreshStatus(); }, t`Couldn't stage`)}><Trans>Stage All</Trans></Button>
                    <Button size="xs" variant="ghost" className="shrink-0" disabled={!stagedCount || busy} onClick={() => void run(async () => { await api.unstage(projectId, status.entries.map((entry) => entry.path)); await refreshStatus(); }, t`Couldn't unstage`)}><Trans>Unstage All</Trans></Button>
                  </>
                )}
              </div>
            )}
            {status && shownScope === 'working' && !status.entries.length && <EmptyState title={t`Working tree clean`} />}
            {shownScope === 'working' && status?.entries.slice(0, shownRows).map((entry) => {
              const letter = statusLetter(entry);
              // An untracked directory too large to list is one row, named with its trailing slash.
              const folder = entry.path.endsWith('/');
              const shownPath = folder ? entry.path.slice(0, -1) : entry.path;
              const directory = shownPath.includes('/') ? shownPath.slice(0, shownPath.lastIndexOf('/')) : '';
              return (
                <div key={`${entry.path}:${entry.index}${entry.worktree}`} className="group/git flex h-8 items-center gap-2 rounded-lg px-2 hover:bg-hover max-md:h-11 max-md:px-1 no-hover:h-11">
                  <button type="button" disabled={folder} onClick={() => void showDiff({ path: entry.path, staged: staged(entry) && entry.worktree === ' ' })} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}>
                    <span className="min-w-0 shrink truncate text-fg">{basename(shownPath)}{folder ? '/' : ''}</span>
                    {directory && <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{directory}</span>}
                  </button>
                  <span className="flex shrink-0 items-center opacity-0 transition-opacity pointer-events-none group-hover/git:opacity-100 group-hover/git:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto no-hover:opacity-100 no-hover:pointer-events-auto">
                    {unstaged(entry) && <Tip label={t`Discard`}><Button size="icon-xs" variant="quiet" className="no-hover:size-10" aria-label={t`Discard`} disabled={busy} onClick={() => discardFile(entry)}><IconUndo2 /></Button></Tip>}
                    {unstaged(entry) && <Tip label={t`Stage`}><Button size="icon-xs" variant="quiet" className="no-hover:size-10" aria-label={t`Stage`} disabled={busy} onClick={() => void run(async () => { await api.stage(projectId, [entry.path]); await refreshStatus(); }, t`Couldn't stage`)}><IconPlus /></Button></Tip>}
                    {staged(entry) && <Tip label={t`Unstage`}><Button size="icon-xs" variant="quiet" className="no-hover:size-10" aria-label={t`Unstage`} disabled={busy} onClick={() => void run(async () => { await api.unstage(projectId, [entry.path]); await refreshStatus(); }, t`Couldn't unstage`)}><IconMinus /></Button></Tip>}
                  </span>
                  {(entry.added || entry.removed) ? <span className="flex shrink-0 items-center gap-1 text-2xs tabular-nums">{entry.added ? <span className="text-success">+{entry.added}</span> : null}{entry.removed ? <span className="text-danger">−{entry.removed}</span> : null}</span> : null}
                  {reviews.some((comment) => comment.path === entry.path) && <IconMessageSquareText className="size-3 shrink-0 text-accent" aria-label={t`Has comments`} />}
                  {staged(entry) && <span className="size-1.5 shrink-0 rounded-full bg-success" title={t`Staged`} />}
                  <span className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', letter.className)}>{letter.letter}</span>
                </div>
              );
            })}
            {(() => {
              const count = shownScope === 'working' ? status?.entries.length ?? 0 : scopedList?.files?.length ?? 0;
              const total = shownScope === 'working' ? count : scopedList?.total ?? count;
              if (count > shownRows) return <button type="button" className="mx-2 my-1 h-8 rounded-lg px-2 text-left text-xs text-fg-3 hover:bg-hover" onClick={() => setShownRows((value) => value + 1000)}><Plural value={total - shownRows} _1="# more file" other="# more files" /></button>;
              return total > count ? <p className="px-4 py-2 text-xs text-fg-4"><Trans>Showing the first {count} of {total} files</Trans></p> : null;
            })()}
            {status && shownScope !== 'working' && !scopedList && <div className="flex justify-center py-10"><Spinner /></div>}
            {status && scopedList?.error && <EmptyState title={scopedList.error} />}
            {status && scopedList?.files && !scopedList.files.length && <EmptyState title={shownScope === 'turn' ? t`No changes this turn` : t`No differences from ${scopedList.ref ?? ''}`} />}
            {status && scopedList?.files?.slice(0, shownRows).map((file) => {
              const letter = codeLetter(file.code);
              const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
              return (
                <button key={file.path} type="button" onClick={() => void showDiff(shownScope === 'turn' ? { path: file.path, base: `checkpoint:${turnId}` } : { path: file.path, base: scopedList.base, ...(scopedList.ref ? { ref: scopedList.ref } : {}) })} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-hover max-md:h-11 max-md:px-1 no-hover:h-11" title={file.path}>
                  <span className="min-w-0 shrink truncate text-fg">{basename(file.path)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{directory}</span>
                  {(file.added || file.removed) ? <span className="flex shrink-0 items-center gap-1 text-2xs tabular-nums">{file.added ? <span className="text-success">+{file.added}</span> : null}{file.removed ? <span className="text-danger">−{file.removed}</span> : null}</span> : null}
                  {reviews.some((comment) => comment.path === file.path) && <IconMessageSquareText className="size-3 shrink-0 text-accent" aria-label={t`Has comments`} />}
                  <span className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', letter.className)}>{letter.letter}</span>
                </button>
              );
            })}
          </div>
          {reviews.length > 0 && (
            <div className="shrink-0 edge-t">
              <div className="flex h-10 items-center gap-2 px-3 text-xs">
                <button type="button" aria-expanded={reviewOpen} onClick={() => setReviewOpen((value) => !value)} className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-fg-2 hover:bg-hover">
                  <IconMessageSquareText className="size-3.5 text-accent" />
                  <span className="font-medium"><Plural value={reviews.length} _1="# comment" other="# comments" /></span>
                  <IconChevronRight className={cn('size-3 text-fg-4 transition-transform', reviewOpen && 'rotate-90')} />
                </button>
                <Button size="xs" variant="quiet" className="ml-auto" disabled={busy} onClick={clearReviews}><Trans>Clear</Trans></Button>
                <Tip label={sessionId ? t`Send as one message to this conversation` : t`Open a conversation first`}>
                  <span><Button size="xs" variant="primary" disabled={!sessionId || busy} onClick={sendReviews}><IconSend /><Trans>Send to Agent</Trans></Button></span>
                </Tip>
              </div>
              <Collapse open={reviewOpen}>
                <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
                  {reviews.map((comment) => (
                    <div key={`${comment.path}:${comment.line}:${comment.body}`} className="group/rv flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate font-mono text-2xs text-fg-3">{basename(comment.path)} · {lineLabel(comment)}</span>
                        <span className="line-clamp-2 text-xs text-fg">{comment.body}</span>
                      </div>
                      <Button size="icon-xs" variant="quiet" aria-label={t`Delete comment`} className="opacity-0 group-hover/rv:opacity-100 no-hover:opacity-100" onClick={() => setReviews((current) => current.filter((item) => item !== comment))}><IconX /></Button>
                    </div>
                  ))}
                </div>
              </Collapse>
            </div>
          )}
          {status && status.entries.length > 0 && (
            <div className="flex shrink-0 flex-col gap-2 edge-t p-3">
              <Textarea className="min-h-16 text-sm" value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t`Commit message (⌘↵)`} aria-label={t`Commit message`}
                onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isComposingKey(event.nativeEvent)) { event.preventDefault(); commit(); } }} />
              <Button variant="primary" size="sm" className="max-md:h-11" disabled={!canCommit} onClick={commit}>
                <IconGitCommitHorizontal />{stagedCount ? plural(stagedCount, { 1: 'Commit # File', other: 'Commit # Files' }) : t({ message: 'Commit', context: 'panels-commit-action' })}
              </Button>
            </div>
          )}
        </>
      )}

      {tab === 'checkpoints' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 gap-2 px-3 pb-2">
            <Input value={checkpointTitle} onChange={(event) => setCheckpointTitle(event.target.value)} placeholder={t`Checkpoint name (optional)`} />
            <Button size="md" disabled={busy} onClick={() => void run(async () => { await api.createCheckpoint(projectId, { ...(sessionId ? { sessionId } : {}), ...(checkpointTitle.trim() ? { title: checkpointTitle.trim() } : {}) }); setCheckpointTitle(''); toast.success(t`Checkpoint saved`); await refreshCheckpoints(); }, t`Couldn't create the checkpoint`)}><IconSave /><Trans>Save</Trans></Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {!checkpoints && <div className="flex justify-center py-10"><Spinner /></div>}
            {checkpoints && !checkpoints.length && <EmptyState title={t`No checkpoints yet`} />}
            {checkpoints?.map((checkpoint) => {
              const list = changes[checkpoint.id];
              return (
                <div key={checkpoint.id} className="group/cp flex flex-col rounded-lg px-2 py-2 hover:bg-hover">
                  <div className="flex items-center gap-2">
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => list ? setChanges((current) => { const next = { ...current }; delete next[checkpoint.id]; return next; }) : void api.checkpointChanges(projectId, checkpoint.id).then((value) => setChanges((current) => ({ ...current, [checkpoint.id]: value }))).catch((error) => onError(errorMessage(error, t`Couldn't load the checkpoint`)))}>
                      <IconChevronRight className={cn('size-3.5 shrink-0 text-fg-4 transition-transform', list && 'rotate-90')} />
                      <span className="min-w-0 truncate text-sm font-medium text-fg">{checkpoint.title}</span>
                    </button>
                    <Button size="xs" variant="ghost" className="opacity-0 group-hover/cp:opacity-100 no-hover:h-10 no-hover:opacity-100" disabled={busy} onClick={() => void restore(checkpoint)}><IconRotateCcw /><Trans>Restore</Trans></Button>
                  </div>
                  <span className="pl-5 text-xs text-fg-3">{gitDateTime(checkpoint.createdAt)} · {checkpoint.excluded.length ? `${plural(checkpoint.files, { 1: '# file', other: '# files' })} · ${t`${checkpoint.excluded.length} excluded`}` : plural(checkpoint.files, { 1: '# file', other: '# files' })}</span>
                  {list && (
                    <div className="mt-1.5 flex flex-col gap-0.5 pl-5">
                      {list.length ? list.map((change) => (
                        <div key={change.path} className="flex items-center gap-2 text-xs">
                          <span className={cn('w-7 shrink-0', change.kind === 'added' ? 'text-success' : change.kind === 'deleted' ? 'text-danger' : 'text-warning')}>{changeLabel[change.kind]}</span>
                          <span className="min-w-0 truncate font-mono text-fg-2" title={change.path}>{change.path}</span>
                        </div>
                      )) : <span className="text-xs text-fg-3"><Trans>Same as the working tree</Trans></span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'history' && status && <HistorySection project={project} status={status} active={active} onError={onError} onShowFile={(file) => void showDiff(file)} onChanged={() => void refreshStatus()} />}

      {tab === 'worktrees' && !project.system && <WorktreeSection key={projectId} project={project} active={active} onError={onError} onOpenWorktree={onOpenWorktree} />}

      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent mobileFullscreen className="h-[min(820px,calc(100dvh-32px))] max-w-5xl">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-base">{diff?.path}</DialogTitle>
            {/* The switch below already says which side is on show. */}
            <DialogDescription className={bothSides && diff && !diff.binary && !diff.truncated ? 'sr-only' : undefined}>{diff?.binary ? t`Binary file` : diff?.truncated ? t`Preview truncated` : target?.commit ? target.commit.slice(0, 8) : target?.base ? (target.base.startsWith('checkpoint:') ? t`Changes this turn` : t`Changes since ${target.ref ?? target.base.slice(0, 8)}`) : target?.staged ? t`Staged` : t`Working tree changes`}</DialogDescription>
            {bothSides && target && <Segmented size="xs" value={target.staged ? 'staged' : 'unstaged'} onChange={(value) => void showDiff({ path: target.path, staged: value === 'staged' })} ariaLabel={t`Side`} options={[{ value: 'unstaged', label: t`Unstaged` }, { value: 'staged', label: t`Staged` }]} />}
          </DialogHeader>
          {/* A truncated preview would number lines that are not the file's, so remarks need the whole text. */}
          {(() => {
            // A commit's lines are numbered as the file was then, so a remark on them would point the agent at the wrong place.
            const reviewable = Boolean(diff && !diff.binary && !diff.truncated && !target?.commit);
            return (
              <>
                <div className={cn('mx-5 min-h-0 flex-1 overflow-auto rounded-xl border border-line max-md:mx-3', reviewable ? 'mb-3' : 'mb-5 max-md:mb-3')}>
                  {diff && <MergeDiff diff={diff} {...(reviewable ? { marks, onLine: pickLine } : {})} {...(controls ? { controls: { ...controls, onChunk: applyChunk } } : {})} />}
                </div>
                {reviewable && diff && (
                  <ReviewComposer path={diff.path} draft={draft} comments={reviews.filter((comment) => comment.path === diff.path)} onDraft={setDraft}
                    onAdd={(comment) => { setReviews((current) => [...current, comment]); setDraft(undefined); }}
                    onRemove={(comment) => setReviews((current) => current.filter((item) => item !== comment))} />
                )}
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
