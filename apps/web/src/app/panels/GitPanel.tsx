import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import { IconChevronRight, IconGitCommitHorizontal, IconMessageSquareText, IconMinus, IconPlus, IconRefreshCw, IconRotateCcw, IconSave, IconSend, IconX } from '@/components/icons';
import type { Checkpoint, CheckpointChange, GitDiff, GitEntry, ReviewComment } from '@contracts';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { EmptyState, Input, Segmented, Spinner, Textarea } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tip } from '@/components/ui/tooltip';
import { api, type ProjectRecord } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { createStore, useStore } from '@/lib/store';
import { toast } from '@/lib/toast';
import { useTheme } from '@/lib/theme';
import { basename, cn, errorMessage, formatDateTime, newId, readSession, writeSession } from '@/lib/utils';
import { PublishSection } from './PublishSection';
import { WorktreeSection } from './WorktreeSection';
import { isComposingKey } from '../session/composerKeyboard';
import { refreshGitStatus, useGitStatus, watchGitStatus } from '../state/gitStatusStore';

const staged = (entry: GitEntry) => entry.index !== ' ' && entry.index !== '?';
const unstaged = (entry: GitEntry) => entry.worktree !== ' ' || entry.index === '?';

function statusLetter(entry: GitEntry): { letter: string; className: string } {
  const code = (entry.worktree !== ' ' ? entry.worktree : entry.index).trim() || ' ';
  if (code === '?' || code === 'A') return { letter: code === '?' ? 'U' : 'A', className: 'text-success' };
  if (code === 'D') return { letter: 'D', className: 'text-danger' };
  if (code === 'R') return { letter: 'R', className: 'text-accent' };
  return { letter: code, className: 'text-warning' };
}

type LineRange = { from: number; to: number };
type Marks = { commented: LineRange[]; selected?: LineRange };

/** Lines carrying a review remark, and the range being written about, painted onto the diff. */
const setMarks = StateEffect.define<Marks>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setMarks)) continue;
      const { doc } = transaction.state;
      const classes = new Map<number, string>();
      const paint = (range: LineRange, name: string) => {
        for (let line = Math.max(1, range.from); line <= Math.min(doc.lines, range.to); line += 1) classes.set(line, classes.has(line) ? `${classes.get(line)} ${name}` : name);
      };
      effect.value.commented.forEach((range) => paint(range, 'cm-review-commented'));
      if (effect.value.selected) paint(effect.value.selected, 'cm-review-selected');
      const builder = new RangeSetBuilder<Decoration>();
      [...classes.keys()].sort((a, b) => a - b).forEach((line) => builder.add(doc.line(line).from, doc.line(line).from, Decoration.line({ class: classes.get(line)! })));
      return builder.finish();
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function MergeDiff({ diff, marks, onLine }: { diff: GitDiff; marks?: Marks; onLine?: (line: number, text: string, extend: boolean) => void }) {
  const { t } = useLingui();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const themeCompartmentRef = useRef<Compartment | null>(null);
  if (themeCompartmentRef.current === null) themeCompartmentRef.current = new Compartment();
  const themeCompartment = themeCompartmentRef.current;
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const darkRef = useRef(dark);
  const appliedDark = useRef<boolean | undefined>(undefined);
  darkRef.current = dark;
  const lineRef = useRef(onLine);
  lineRef.current = onLine;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const commentable = Boolean(onLine);
  useEffect(() => {
    if (!host.current || diff.binary) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: diff.after,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          themeCompartment.of(EditorView.theme({}, { dark: darkRef.current })),
          unifiedMergeView({ original: diff.before, highlightChanges: true, gutter: true, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 5 } }),
          // Line numbers count the new file, which is where a remark has to point for the agent to find it.
          ...(commentable ? [
            lineNumbers({ domEventHandlers: { mousedown(target, block, event) {
              if (!(event instanceof MouseEvent) || event.button !== 0) return false;
              const line = target.state.doc.lineAt(block.from);
              lineRef.current?.(line.number, line.text, event.shiftKey);
              return true;
            } } }),
            marksField,
          ] : []),
        ],
      }),
      parent: host.current,
    });
    editor.current = view;
    appliedDark.current = darkRef.current;
    if (marksRef.current) view.dispatch({ effects: setMarks.of(marksRef.current) });
    return () => {
      editor.current = undefined;
      view.destroy();
    };
  }, [diff, commentable]);
  useEffect(() => {
    const view = editor.current;
    if (!view || appliedDark.current === dark) return;
    view.dispatch({ effects: themeCompartment.reconfigure(EditorView.theme({}, { dark })) });
    appliedDark.current = dark;
  }, [dark, themeCompartment]);
  useEffect(() => { if (marks && commentable) editor.current?.dispatch({ effects: setMarks.of(marks) }); }, [marks, commentable]);
  if (diff.binary) return <pre className="overflow-auto p-4 font-mono text-xs text-fg-2">{diff.patch || t`二进制文件`}</pre>;
  return <div ref={host} className={cn('cm-host min-h-0', commentable && 'cm-review')} />;
}

const lineLabel = (comment: Pick<ReviewComment, 'line' | 'endLine'>) =>
  comment.line === undefined ? i18n._(msg`整个文件`) : comment.endLine && comment.endLine !== comment.line ? i18n._(msg`第 ${comment.line}–${comment.endLine} 行`) : i18n._(msg`第 ${comment.line} 行`);

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
              <button type="button" aria-label={t`删除这条意见`} className="flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-4 hover:bg-hover hover:text-fg-2" onClick={() => onRemove(comment)}><IconX className="size-3" /></button>
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
          <Textarea ref={input} className="min-h-16 text-sm" value={body} onChange={(event) => setBody(event.target.value)} placeholder={t`写下要 Agent 修改的地方（⌘↵ 添加）`} aria-label={t`审阅意见`}
            onKeyDown={(event) => {
              if (isComposingKey(event.nativeEvent)) return;
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); add(); }
              if (event.key === 'Escape') { event.stopPropagation(); onDraft(undefined); }
            }} />
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => onDraft(undefined)}><Trans context="panels-cancel-action">取消</Trans></Button>
            <Button size="xs" variant="primary" disabled={!body.trim()} onClick={add}><Trans>添加意见</Trans></Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-fg-4"><Trans>行号上可写审阅意见，Shift 选择多行；意见在改动列表下方统一发送。</Trans></p>
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
  const changeLabel: Record<CheckpointChange['kind'], string> = { added: t`新增`, modified: t`修改`, deleted: t({ message: '删除', context: 'panels-change-deleted' }) };
  const projectId = project.id;
  const [tab, setTab] = useState<'changes' | 'checkpoints' | 'worktrees'>('changes');
  const { status, error: statusError = '' } = useGitStatus(projectId) ?? {};
  const [diff, setDiff] = useState<GitDiff>();
  const [diffOpen, setDiffOpen] = useState(false);
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
  useEffect(() => { setDraft(undefined); }, [diff]);
  useEffect(() => (active && tab === 'changes' ? watchGitStatus(projectId) : undefined), [active, tab, projectId]);
  useEffect(() => {
    if (active && tab === 'checkpoints') void refreshCheckpoints().catch((error) => onError(errorMessage(error, t`无法读取检查点`)));
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
    void run(async () => { await api.commit(projectId, message.trim()); setMessage(''); toast.success(t`已提交`); await refreshStatus(); }, t`无法创建提交`);
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
      toast.success(t`已把 ${reviews.length} 条审阅意见发给 Agent`);
    }, t`无法发送审阅意见`);
  };

  const clearReviews = () => {
    const cleared = reviews;
    setReviews(() => []);
    toast.success(t`已清空审阅意见`, { action: { label: t`撤销`, onClick: () => updateDraft(projectId, (current) => ({ reviews: [...cleared, ...current.reviews] })) } });
  };

  const showDiff = async (entry: GitEntry) => {
    try { setDiff(await api.gitDiff(projectId, entry.path, staged(entry) && entry.worktree === ' ')); setDiffOpen(true); }
    catch (error) { onError(errorMessage(error, t`无法读取差异`)); }
  };

  const restore = async (checkpoint: Checkpoint) => {
    let list = changes[checkpoint.id];
    if (!list) {
      try { list = await api.checkpointChanges(projectId, checkpoint.id); setChanges((current) => ({ ...current, [checkpoint.id]: list! })); }
      catch (error) { onError(errorMessage(error, t`无法读取检查点内容`)); return; }
    }
    const detail = list.length
      ? list.map((change) => `${changeLabel[change.kind]}  ${change.path}\n      ${change.beforeHash?.slice(0, 12) ?? '—'} → ${change.afterHash?.slice(0, 12) ?? '—'}`).join('\n')
      : t`没有文件差异`;
    const ok = await confirmDialog({
      title: t`恢复到「${checkpoint.title}」？`,
      description: t`服务器会再次核对下列文件指纹（SHA-256 前 12 位），若文件在此期间被修改，恢复会被拒绝。`,
      detail,
      confirmLabel: t`恢复`,
      destructive: true,
    });
    if (!ok) return;
    if (await run(() => api.restoreCheckpoint(projectId, checkpoint.id, list!), t`检查点恢复被拒绝`)) {
      toast.success(t`已恢复到检查点`);
      setChanges((current) => { const next = { ...current }; delete next[checkpoint.id]; return next; });
      void refreshStatus(); void refreshCheckpoints();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <Segmented size="xs" className="max-md:[&_button]:h-8 max-md:[&_button]:px-3 max-md:[&_button]:text-sm" value={tab} onChange={setTab} ariaLabel={t`Git 视图`} options={[{ value: 'changes', label: t`改动` }, { value: 'checkpoints', label: t`检查点` }, ...(!project.system ? [{ value: 'worktrees' as const, label: t`Worktree` }] : [])]} />
        {tab === 'changes' && <Tip label={t`刷新`}><Button size="icon-xs" variant="quiet" className="ml-auto max-md:size-10" aria-label={t`刷新`} onClick={() => void refreshStatus()}><IconRefreshCw /></Button></Tip>}
      </div>

      {tab === 'changes' && (
        <>
          {statusError ? <div className="h-2 shrink-0" /> : <PublishSection project={project} status={status} sessionId={sessionId} active={active} onError={onError} onMerged={(result) => { void refreshStatus(); onMerged?.(result); }} />}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {!status && !statusError && <div className="flex justify-center py-10"><Spinner /></div>}
            {statusError && <EmptyState title={t`不是 Git 仓库`} description={statusError} />}
            {status && !status.entries.length && <EmptyState title={t`工作区是干净的`} />}
            {status && status.entries.length > 0 && (
              <div className="flex items-center gap-1 px-2 pb-1">
                <Button size="xs" variant="ghost" disabled={!unstagedCount || busy} onClick={() => void run(async () => { await api.stage(projectId, status.entries.map((entry) => entry.path)); await refreshStatus(); }, t`无法暂存改动`)}><Trans>全部暂存</Trans></Button>
                <Button size="xs" variant="ghost" disabled={!stagedCount || busy} onClick={() => void run(async () => { await api.unstage(projectId, status.entries.map((entry) => entry.path)); await refreshStatus(); }, t`无法取消暂存`)}><Trans>全部取消</Trans></Button>
              </div>
            )}
            {status?.entries.map((entry) => {
              const letter = statusLetter(entry);
              const directory = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
              return (
                <div key={`${entry.path}:${entry.index}${entry.worktree}`} className="group/git flex h-8 items-center gap-2 rounded-lg px-2 hover:bg-hover max-md:h-11 max-md:px-1 no-hover:h-11">
                  <button type="button" onClick={() => void showDiff(entry)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}>
                    <span className="min-w-0 shrink truncate text-fg">{basename(entry.path)}</span>
                    {directory && <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{directory}</span>}
                  </button>
                  <span className="flex shrink-0 items-center opacity-0 transition-opacity pointer-events-none group-hover/git:opacity-100 group-hover/git:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto no-hover:opacity-100 no-hover:pointer-events-auto">
                    {unstaged(entry) && <Tip label={t`暂存`}><Button size="icon-xs" variant="quiet" className="no-hover:size-10" aria-label={t`暂存`} disabled={busy} onClick={() => void run(async () => { await api.stage(projectId, [entry.path]); await refreshStatus(); }, t`无法暂存文件`)}><IconPlus /></Button></Tip>}
                    {staged(entry) && <Tip label={t`取消暂存`}><Button size="icon-xs" variant="quiet" className="no-hover:size-10" aria-label={t`取消暂存`} disabled={busy} onClick={() => void run(async () => { await api.unstage(projectId, [entry.path]); await refreshStatus(); }, t`无法取消暂存`)}><IconMinus /></Button></Tip>}
                  </span>
                  {(entry.added || entry.removed) ? <span className="flex shrink-0 items-center gap-1 text-2xs tabular-nums">{entry.added ? <span className="text-success">+{entry.added}</span> : null}{entry.removed ? <span className="text-danger">−{entry.removed}</span> : null}</span> : null}
                  {reviews.some((comment) => comment.path === entry.path) && <IconMessageSquareText className="size-3 shrink-0 text-accent" aria-label={t`有审阅意见`} />}
                  {staged(entry) && <span className="size-1.5 shrink-0 rounded-full bg-success" title={t`已暂存`} />}
                  <span className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', letter.className)}>{letter.letter}</span>
                </div>
              );
            })}
          </div>
          {reviews.length > 0 && (
            <div className="shrink-0 edge-t">
              <div className="flex h-10 items-center gap-2 px-3 text-xs">
                <button type="button" aria-expanded={reviewOpen} onClick={() => setReviewOpen((value) => !value)} className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-fg-2 hover:bg-hover">
                  <IconMessageSquareText className="size-3.5 text-accent" />
                  <span className="font-medium"><Trans>{reviews.length} 条审阅意见</Trans></span>
                  <IconChevronRight className={cn('size-3 text-fg-4 transition-transform', reviewOpen && 'rotate-90')} />
                </button>
                <Button size="xs" variant="quiet" className="ml-auto" disabled={busy} onClick={clearReviews}><Trans>清空</Trans></Button>
                <Tip label={sessionId ? t`作为一条消息发给当前会话` : t`打开一个会话后可发送`}>
                  <span><Button size="xs" variant="primary" disabled={!sessionId || busy} onClick={sendReviews}><IconSend /><Trans>发给 Agent</Trans></Button></span>
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
                      <Button size="icon-xs" variant="quiet" aria-label={t`删除这条意见`} className="opacity-0 group-hover/rv:opacity-100 no-hover:opacity-100" onClick={() => setReviews((current) => current.filter((item) => item !== comment))}><IconX /></Button>
                    </div>
                  ))}
                </div>
              </Collapse>
            </div>
          )}
          {status && status.entries.length > 0 && (
            <div className="flex shrink-0 flex-col gap-2 edge-t p-3">
              <Textarea className="min-h-16 text-sm" value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t`提交说明（⌘↵ 提交）`} aria-label={t`提交说明`}
                onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isComposingKey(event.nativeEvent)) { event.preventDefault(); commit(); } }} />
              <Button variant="primary" size="sm" className="max-md:h-11" disabled={!canCommit} onClick={commit}>
                <IconGitCommitHorizontal />{stagedCount ? t`提交 ${stagedCount} 个文件` : t({ message: '提交', context: 'panels-commit-action' })}
              </Button>
            </div>
          )}
        </>
      )}

      {tab === 'checkpoints' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 gap-2 px-3 pb-2">
            <Input value={checkpointTitle} onChange={(event) => setCheckpointTitle(event.target.value)} placeholder={t`检查点名称（可选）`} />
            <Button size="md" disabled={busy} onClick={() => void run(async () => { await api.createCheckpoint(projectId, { ...(sessionId ? { sessionId } : {}), ...(checkpointTitle.trim() ? { title: checkpointTitle.trim() } : {}) }); setCheckpointTitle(''); toast.success(t`检查点已保存`); await refreshCheckpoints(); }, t`无法创建检查点`)}><IconSave /><Trans>保存</Trans></Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {!checkpoints && <div className="flex justify-center py-10"><Spinner /></div>}
            {checkpoints && !checkpoints.length && <EmptyState title={t`还没有检查点`} />}
            {checkpoints?.map((checkpoint) => {
              const list = changes[checkpoint.id];
              return (
                <div key={checkpoint.id} className="group/cp flex flex-col rounded-lg px-2 py-2 hover:bg-hover">
                  <div className="flex items-center gap-2">
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => list ? setChanges((current) => { const next = { ...current }; delete next[checkpoint.id]; return next; }) : void api.checkpointChanges(projectId, checkpoint.id).then((value) => setChanges((current) => ({ ...current, [checkpoint.id]: value }))).catch((error) => onError(errorMessage(error, t`无法读取检查点内容`)))}>
                      <IconChevronRight className={cn('size-3.5 shrink-0 text-fg-4 transition-transform', list && 'rotate-90')} />
                      <span className="min-w-0 truncate text-sm font-medium text-fg">{checkpoint.title}</span>
                    </button>
                    <Button size="xs" variant="ghost" className="opacity-0 group-hover/cp:opacity-100 no-hover:h-10 no-hover:opacity-100" disabled={busy} onClick={() => void restore(checkpoint)}><IconRotateCcw /><Trans>恢复</Trans></Button>
                  </div>
                  <span className="pl-5 text-xs text-fg-3">{formatDateTime(checkpoint.createdAt)} · {checkpoint.excluded.length ? t`${checkpoint.files} 个文件 · 已排除 ${checkpoint.excluded.length}` : t`${checkpoint.files} 个文件`}</span>
                  {list && (
                    <div className="mt-1.5 flex flex-col gap-0.5 pl-5">
                      {list.length ? list.map((change) => (
                        <div key={change.path} className="flex items-center gap-2 text-xs">
                          <span className={cn('w-7 shrink-0', change.kind === 'added' ? 'text-success' : change.kind === 'deleted' ? 'text-danger' : 'text-warning')}>{changeLabel[change.kind]}</span>
                          <span className="min-w-0 truncate font-mono text-fg-2" title={change.path}>{change.path}</span>
                        </div>
                      )) : <span className="text-xs text-fg-3"><Trans>与当前工作区相同</Trans></span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'worktrees' && !project.system && <WorktreeSection key={projectId} project={project} active={active} onError={onError} onOpenWorktree={onOpenWorktree} />}

      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent mobileFullscreen className="h-[min(820px,calc(100dvh-32px))] max-w-5xl">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-base">{diff?.path}</DialogTitle>
            <DialogDescription>{diff?.binary ? t`二进制文件` : diff?.truncated ? t`内容过大，预览已截断` : t`工作区改动`}</DialogDescription>
          </DialogHeader>
          {/* A truncated preview would number lines that are not the file's, so remarks need the whole text. */}
          {(() => {
            const reviewable = Boolean(diff && !diff.binary && !diff.truncated);
            return (
              <>
                <div className={cn('mx-5 min-h-0 flex-1 overflow-auto rounded-xl border border-line max-md:mx-3', reviewable ? 'mb-3' : 'mb-5 max-md:mb-3')}>
                  {diff && <MergeDiff diff={diff} {...(reviewable ? { marks, onLine: pickLine } : {})} />}
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
