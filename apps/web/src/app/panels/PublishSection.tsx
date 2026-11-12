import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { IconArrowDown, IconArrowUp, IconCheck, IconChevronRight, IconCircleDashed, IconExternalLink, IconGitBranch, IconGitMerge, IconGitPullRequest, IconRefreshCw, IconSparkles, IconUpload, IconX } from '@/components/icons';
import type { BranchInfo, CheckState, GitStatus, MergeResult, PullRequestInfo } from '@contracts';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Badge, Field, Input, Segmented, Spinner, StatusDot, Switch, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api, HttpError, type MergeOptions, type ProjectRecord } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn, errorMessage, newId } from '@/lib/utils';
import { refreshGitStatus } from '../state/gitStatusStore';

type PullState = { loading: boolean; pullRequest?: PullRequestInfo | null; unavailable?: string };
/** How often checks still running are re-read while someone watches them. */
const CHECKS_POLL_MS = 20_000;

const checkTone = (state: CheckState | 'none'): 'success' | 'danger' | 'warning' | 'idle' =>
  state === 'success' ? 'success' : state === 'failure' ? 'danger' : state === 'pending' ? 'warning' : 'idle';
/** gh being absent or signed out is a setup state, not an error worth a toast each time the panel opens. */
function ghProblem(error: unknown): string | undefined {
  if (!(error instanceof HttpError)) return undefined;
  if (error.code === 'GH_UNAVAILABLE') return i18n._(msg`Install the GitHub CLI (gh) to create PRs and see CI`);
  if (error.code === 'GH_OPERATION_FAILED' && /auth|login|token|not a git|no git remotes|none of the git remotes/i.test(error.message)) return i18n._(msg`Run gh auth login, or add a GitHub remote, to create PRs`);
  return undefined;
}

function CheckIcon({ state }: { state: CheckState }) {
  if (state === 'success') return <IconCheck className="size-3.5 text-success" />;
  if (state === 'failure') return <IconX className="size-3.5 text-danger" />;
  if (state === 'pending') return <Spinner className="size-3.5 text-warning" />;
  return <IconCircleDashed className="size-3.5 text-fg-4" />;
}

/**
 * The branch row of the changes view, which opens into where the work goes next: push, pull request
 * with its checks, and — in a worktree — merging back. Folded by default so reviewing the files stays
 * the first thing the panel is for; the folded row still carries the sync count and PR state.
 */
export function PublishSection({ project, status, sessionId, active, onError, onMerged }: {
  project: ProjectRecord;
  status?: GitStatus;
  sessionId?: string;
  /** The panel is open; closed, nothing is read. */
  active: boolean;
  onError: (message: string) => void;
  onMerged?: (result: { originProjectId: string; removedWorktree: boolean }) => void;
}) {
  const { t } = useLingui();
  const reviewLabel: Record<string, { label: string; tone: 'success' | 'danger' | 'warning' }> = {
    APPROVED: { label: t`Approved`, tone: 'success' },
    CHANGES_REQUESTED: { label: t`Changes requested`, tone: 'danger' },
    REVIEW_REQUIRED: { label: t`Review required`, tone: 'warning' },
  };
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState<BranchInfo>();
  const [pull, setPull] = useState<PullState>({ loading: false });
  const [busy, setBusy] = useState<'push' | 'pull' | 'pr' | 'fix'>();
  const [checksOpen, setChecksOpen] = useState(false);
  const [prDialog, setPrDialog] = useState(false);
  const [mergeDialog, setMergeDialog] = useState(false);
  const [into, setInto] = useState<string>();
  const requested = useRef(0);
  const pulledAt = useRef(0);

  const refreshBranch = useCallback(async () => {
    try { setBranch(await api.gitBranch(project.id)); }
    catch { setBranch(undefined); }
  }, [project.id]);
  const refreshPull = useCallback(async () => {
    const ticket = ++requested.current;
    pulledAt.current = Date.now();
    setPull((current) => ({ ...current, loading: true }));
    try {
      const result = await api.pullRequest(project.id);
      if (ticket === requested.current) { setPull({ loading: false, pullRequest: result.pullRequest }); setBranch(result.branch); }
    } catch (error) {
      if (ticket !== requested.current) return;
      const unavailable = ghProblem(error);
      setPull({ loading: false, ...(unavailable ? { unavailable } : {}) });
      if (!unavailable && open) onError(errorMessage(error, t`Couldn't load the PR`));
    }
  }, [project.id, open, onError]);

  // Branch and sync count follow every status refresh while the panel is open, and its reopening; the
  // PR asks GitHub, so only once the branch is published.
  useEffect(() => { if (active) void refreshBranch(); }, [active, refreshBranch, status]);
  useEffect(() => { setPull({ loading: false }); setOpen(false); setInto(undefined); }, [project.id]);
  // Retry only on an explicit refresh or a branch change. A failed request leaves no PR data;
  // watching that absence would immediately retry forever during network or GitHub failures.
  useEffect(() => {
    if (branch?.upstream) void refreshPull();
    else setPull({ loading: false });
  }, [branch?.branch, branch?.upstream, refreshPull]);
  useEffect(() => () => { requested.current += 1; }, []);
  useEffect(() => {
    if (!open || !project.worktree || into) return;
    void api.gitBranch(project.worktree.originProjectId).then((info) => setInto(info.branch)).catch(() => setInto(''));
  }, [open, project.worktree, into]);
  // Checks still running are worth watching while someone has the section open and in view. Back
  // after longer than one interval away (panel closed, page hidden), they are read at once.
  const pending = pull.pullRequest?.checks.state === 'pending';
  useEffect(() => {
    if (!active || !open || !pending) return;
    const visible = () => document.visibilityState === 'visible';
    const resume = () => { if (visible() && Date.now() - pulledAt.current >= CHECKS_POLL_MS) void refreshPull(); };
    resume();
    const timer = window.setInterval(() => { if (visible()) void refreshPull(); }, CHECKS_POLL_MS);
    document.addEventListener('visibilitychange', resume);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', resume); };
  }, [active, open, pending, refreshPull]);

  if (!branch) {
    return (
      <div className="flex h-8 shrink-0 items-center gap-2 px-4 text-xs text-fg-3">
        <IconGitBranch className="size-3.5" />
        <span className="min-w-0 truncate font-mono text-fg-2">{status?.branch ?? '…'}</span>
        <FileTally status={status} />
      </div>
    );
  }

  const pr = pull.pullRequest ?? undefined;
  const noRemote = !branch.remotes.length;
  // Without an upstream git needs to be told where; `origin` or a lone remote is the obvious answer.
  const remoteChoice = !branch.upstream && branch.remotes.length > 1 && !branch.remotes.includes('origin');
  const synced = Boolean(branch.upstream) && !branch.ahead && !branch.behind;
  const mergeTarget = into || t`the original project`;

  const push = async (remote?: string) => {
    setBusy('push');
    try {
      const result = await api.gitPush(project.id, remote);
      setBranch(result.branch);
      const pushedTo = result.branch.upstream ?? remote ?? t({ message: 'Remote', context: 'panels-remote-default' });
      toast.success(t`Pushed to ${pushedTo}`);
      void refreshPull();
    } catch (error) {
      onError(error instanceof HttpError && /non-fast-forward|rejected|fetch first/i.test(error.message)
        ? t`The remote has commits you don't have. Pull first.`
        : errorMessage(error, t`Push failed`));
    } finally { setBusy(undefined); }
  };

  const pullBranch = async () => {
    setBusy('pull');
    try {
      setBranch((await api.gitPull(project.id)).branch);
      void refreshGitStatus(project.id, true);
    } catch (error) {
      onError(error instanceof HttpError && error.code === 'GIT_PULL_DIVERGED' ? t`Local and remote both have new commits. Merge or rebase first.` : errorMessage(error, t`Pull failed`));
    } finally { setBusy(undefined); }
  };

  const fixChecks = async () => {
    if (!sessionId || !pr) return;
    const failed = pr.checks.items.filter((item) => item.state === 'failure');
    // Sent to the Agent, not shown as interface text: keep it in one language.
    const text = [
      `PR #${pr.number} 的 CI 检查失败了，请定位原因并修复：`,
      ...failed.map((item) => `- ${item.name}${item.url ? `：${item.url}` : ''}`),
      '',
      "可以用 `gh pr checks` 和 `gh run view --log-failed` 读取失败日志。修好后在本地跑一遍相关检查，再告诉我结果。",
    ].join('\n');
    setBusy('fix');
    try { await api.nativeSend(sessionId, { commandId: newId(), text }); toast.success(t`Sent to the agent`); }
    catch (error) { onError(errorMessage(error, t`Couldn't send to the agent`)); }
    finally { setBusy(undefined); }
  };

  const passed = pr?.checks.items.filter((item) => item.state === 'success').length ?? 0;
  const failedCount = pr?.checks.items.filter((item) => item.state === 'failure').length ?? 0;
  const running = pr?.checks.items.filter((item) => item.state === 'pending').length ?? 0;
  const checksSummary = [
    t`${passed}/${pr?.checks.items.length ?? 0} checks passed`,
    running ? t`${running} running` : '',
    failedCount ? t`${failedCount} failed` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="shrink-0">
      <div className="flex h-8 items-center gap-2 px-4 text-xs text-fg-3">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="group/pub -ml-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-hover">
          <IconGitBranch className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono text-fg-2">{branch.branch}</span>
          {branch.ahead > 0 && <span className="flex shrink-0 items-center tabular-nums text-fg-2"><IconArrowUp className="size-3" />{branch.ahead}</span>}
          {branch.behind > 0 && <span className="flex shrink-0 items-center tabular-nums text-warning"><IconArrowDown className="size-3" />{branch.behind}</span>}
          {pr && (
            <span className="flex shrink-0 items-center gap-1 rounded-sm bg-muted px-1 text-2xs text-fg-2">
              {pr.state === 'MERGED' ? <IconGitMerge className="size-3 text-accent" /> : <StatusDot tone={checkTone(pr.checks.state)} pulse={pr.checks.state === 'pending'} />}
              #{pr.number}
            </span>
          )}
          <IconChevronRight className={cn('size-3 shrink-0 text-fg-4 transition-transform group-hover/pub:text-fg-3', open && 'rotate-90')} />
        </button>
        <FileTally status={status} />
      </div>

      <Collapse open={open}>
        <div className="mx-2 mb-2 flex flex-col gap-2.5 rounded-xl bg-subtle p-3">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="min-w-0 truncate font-mono text-fg-3">{branch.upstream ?? (noRemote ? t`No remote` : t`Not pushed yet`)}</span>
            <span className="ml-auto shrink-0 text-fg-3">
              {synced ? <span className="text-success"><Trans>Up to date</Trans></span> : branch.upstream ? [branch.ahead ? t`${branch.ahead} ahead` : '', branch.behind ? t`${branch.behind} behind` : ''].filter(Boolean).join(' · ') : ''}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {branch.behind > 0 && <Button size="xs" disabled={Boolean(busy)} onClick={() => void pullBranch()}>{busy === 'pull' ? <Spinner /> : <IconArrowDown />}Pull</Button>}
            {!noRemote && (remoteChoice ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="xs" disabled={Boolean(busy)}>{busy === 'push' ? <Spinner /> : <IconUpload />}<Trans>Push to…</Trans></Button></DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel><Trans>Remote</Trans></DropdownMenuLabel>
                  {branch.remotes.map((remote) => <DropdownMenuItem key={remote} onSelect={() => void push(remote)}>{remote}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button size="xs" disabled={Boolean(busy) || !branch.head || (Boolean(branch.upstream) && !branch.ahead)} onClick={() => void push()}>
                {busy === 'push' ? <Spinner /> : <IconUpload />}{branch.upstream ? <Trans>Push</Trans> : <Trans>Publish Branch</Trans>}
              </Button>
            ))}
            {!noRemote && !pull.unavailable && (pr ? (
              <Button size="xs" asChild><a href={pr.url} target="_blank" rel="noreferrer noopener"><IconExternalLink /><Trans>Open #{pr.number}</Trans></a></Button>
            ) : (
              <Button size="xs" disabled={Boolean(busy) || pull.loading || !branch.head} onClick={() => setPrDialog(true)}><IconGitPullRequest /><Trans>Create PR</Trans></Button>
            ))}
            {project.worktree && (
              <Button size="xs" disabled={Boolean(busy)} onClick={() => setMergeDialog(true)}><IconGitMerge /><Trans>Merge into {mergeTarget}</Trans></Button>
            )}
            {!noRemote && !pull.unavailable && (
              <Tip label={t`Refresh PR`}><Button size="icon-xs" variant="quiet" className="ml-auto" aria-label={t`Refresh PR`} disabled={pull.loading} onClick={() => void refreshPull()}>{pull.loading ? <Spinner /> : <IconRefreshCw />}</Button></Tip>
            )}
          </div>
          {pull.unavailable && <p className="text-xs text-fg-4">{pull.unavailable}</p>}

          {pr && (
            <div className="flex flex-col gap-2 rounded-lg bg-elevated p-2.5 shadow-xs">
              <a href={pr.url} target="_blank" rel="noreferrer noopener" className="line-clamp-2 text-sm font-medium text-fg hover:text-accent">{pr.title}</a>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={pr.state === 'OPEN' ? (pr.isDraft ? 'neutral' : 'success') : pr.state === 'MERGED' ? 'accent' : 'danger'}>
                  {pr.state === 'MERGED' ? <Trans context="panels-pr-state">Merged</Trans> : pr.state === 'CLOSED' ? <Trans>Closed</Trans> : pr.isDraft ? <Trans>Draft</Trans> : <Trans>Open</Trans>}
                </Badge>
                {pr.state === 'OPEN' && pr.reviewDecision && reviewLabel[pr.reviewDecision] && <Badge tone={reviewLabel[pr.reviewDecision]!.tone}>{reviewLabel[pr.reviewDecision]!.label}</Badge>}
                {pr.mergeable === 'CONFLICTING' && <Badge tone="danger"><Trans>Conflicts</Trans></Badge>}
                <span className="ml-auto min-w-0 truncate font-mono text-2xs text-fg-4">{pr.baseRefName} ← {pr.headRefName}</span>
              </div>
              {pr.checks.state !== 'none' && (
                <>
                  <button type="button" onClick={() => setChecksOpen((value) => !value)} className="-mx-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs text-fg-2 hover:bg-hover">
                    <StatusDot tone={checkTone(pr.checks.state)} pulse={pr.checks.state === 'pending'} />
                    <span>{checksSummary}</span>
                    <IconChevronRight className={cn('ml-auto size-3 text-fg-4 transition-transform', checksOpen && 'rotate-90')} />
                  </button>
                  <Collapse open={checksOpen}>
                    <div className="flex flex-col">
                      {pr.checks.items.map((item) => (
                        <div key={item.name} className="flex h-6 items-center gap-2 text-xs">
                          <CheckIcon state={item.state} />
                          {item.url ? <a href={item.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-fg-2 hover:text-accent">{item.name}</a> : <span className="min-w-0 truncate text-fg-2">{item.name}</span>}
                        </div>
                      ))}
                    </div>
                  </Collapse>
                </>
              )}
              {failedCount > 0 && pr.state === 'OPEN' && (
                <Tip label={sessionId ? t`Send the failed checks to this conversation` : t`Open a conversation first`}>
                  <span className="self-start"><Button size="xs" variant="ghost" disabled={!sessionId || Boolean(busy)} onClick={() => void fixChecks()}>{busy === 'fix' ? <Spinner /> : <IconSparkles />}<Trans>Ask Agent to Fix</Trans></Button></span>
                </Tip>
              )}
            </div>
          )}
        </div>
      </Collapse>

      <PullRequestDialog open={prDialog} onOpenChange={setPrDialog} projectId={project.id} branch={branch}
        onCreated={(result) => { setPull({ loading: false, pullRequest: result.pullRequest }); setBranch(result.branch); setOpen(true); }} onError={onError} />
      {project.worktree && (
        <MergeDialog open={mergeDialog} onOpenChange={setMergeDialog} branch={project.worktree.branch} into={into} dirty={Boolean(status?.entries.length)}
          merge={(options) => api.mergeWorktree(project.id, options)}
          onMerged={(removedWorktree) => { void refreshBranch(); onMerged?.({ originProjectId: project.worktree!.originProjectId, removedWorktree }); }} onError={onError} />
      )}
    </div>
  );
}

function FileTally({ status }: { status?: GitStatus }) {
  const { t } = useLingui();
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
      {status ? (status.entries.length ? plural(status.entries.length, { 1: '# file', other: '# files' }) : t`No changes`) : ''}
      {status && (status.added || status.removed) ? <><span className="text-success">+{status.added}</span><span className="text-danger">−{status.removed}</span></> : null}
    </span>
  );
}

function PullRequestDialog({ open, onOpenChange, projectId, branch, onCreated, onError }: {
  open: boolean; onOpenChange: (open: boolean) => void; projectId: string; branch: BranchInfo;
  onCreated: (result: { branch: BranchInfo; pullRequest: PullRequestInfo | null }) => void; onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTitle(''); setBody(''); setBase(''); setDraft(false); } }, [open]);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.createPullRequest(projectId, { ...(title.trim() ? { title: title.trim(), body } : {}), ...(base.trim() ? { base: base.trim() } : {}), draft });
      onCreated(result);
      onOpenChange(false);
      toast.success(result.pullRequest ? t`Created PR #${result.pullRequest.number}` : t`Created PR`);
    } catch (error) {
      onError(ghProblem(error) ?? errorMessage(error, t`Couldn't create the PR`));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle><Trans>Create Pull Request</Trans></DialogTitle>
          <DialogDescription>{!branch.upstream || branch.ahead ? <Trans>Pushes {branch.branch} first.</Trans> : <Trans>From {branch.branch}.</Trans>}{' '}<Trans>An empty title is filled in from the commits.</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Field label={t`Title`}><Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t`Automatic`} /></Field>
          <Field label={t`Description`}><Textarea value={body} disabled={!title.trim()} onChange={(event) => setBody(event.target.value)} placeholder={title.trim() ? t`Optional` : t`Add a title first`} className="min-h-28" /></Field>
          <div className="flex items-end gap-3">
            <Field label={t`Base Branch`} className="flex-1"><Input value={base} onChange={(event) => setBase(event.target.value)} placeholder={t`Default branch`} /></Field>
            <label className="flex min-h-8 shrink-0 items-center gap-2 text-sm text-fg-2"><Switch checked={draft} onCheckedChange={setDraft} aria-label={t`Draft`} /><Trans>Draft</Trans></label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}><Trans>Cancel</Trans></Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? <Spinner className="text-primary-fg" /> : <IconGitPullRequest />}<Trans>Create</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Merging a worktree back, whether from its changes panel or by adopting one of several attempts. */
export function MergeDialog({ open, onOpenChange, branch, into, dirty, directory, merge, title, description, defaultMessage, onMerged, onError, extra }: {
  open: boolean; onOpenChange: (open: boolean) => void; branch: string; into?: string; dirty: boolean;
  /**
   * The origin is a plain directory with a private history of Riffet's own snapshots, so commits,
   * their messages and how they are folded mean nothing to the person merging; only the result does.
   */
  directory?: boolean;
  merge: (options: MergeOptions) => Promise<MergeResult>;
  title?: string; description?: ReactNode;
  /** What the server writes when the message is left empty, shown as the placeholder. */
  defaultMessage?: string;
  /** Extra controls under the worktree switch, for callers merging on behalf of a group. */
  extra?: ReactNode;
  onMerged: (removedWorktree: boolean) => void; onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const [strategy, setStrategy] = useState<'merge' | 'squash'>('squash');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState('');
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>();
  useEffect(() => { if (open) { setMessage(''); setPending(''); setRemove(false); setConflicts(undefined); } }, [open]);
  const target = into || (directory ? t`the original folder` : t`the original project's branch`);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setConflicts(undefined);
    try {
      const result = await merge({ strategy, ...(message.trim() ? { message: message.trim() } : {}), ...(dirty ? { commitPending: pending.trim() || `WIP on ${branch}` } : {}), removeWorktree: remove });
      onOpenChange(false);
      
      toast.success(directory ? (result.merged ? t`Merged into the original folder` : t`The original folder already has these changes`)
        : result.merged ? result.strategy === 'squash' ? t`Squashed into ${result.into}` : t`Merged into ${result.into}` : t`${result.into} already has every commit of this branch`);
      onMerged(Boolean(result.removedWorktree));
    } catch (error) {
      if (error instanceof HttpError && error.code === 'MERGE_CONFLICT') {
        const paths = (error.details as { paths?: string[] } | undefined)?.paths ?? [];
        setConflicts(paths);
      } else if (error instanceof HttpError && error.code === 'MERGE_TARGET_DIRTY') {
        onError(t`${target} has uncommitted changes. Commit or stash them there first.`);
      } else onError(errorMessage(error, t`Merge failed`));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? t`Merge into ${target}`}</DialogTitle>
          <DialogDescription>{description ?? <Trans>Merges <span className="font-mono text-fg-2">{branch}</span> into the original project.</Trans>}{' '}<Trans>A conflict abandons the whole merge, leaving no half-merged files.</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {!directory && <>
            <Segmented value={strategy} onChange={setStrategy} ariaLabel={t`Merge strategy`} options={[{ value: 'squash', label: t`Squash into One Commit` }, { value: 'merge', label: t`Keep All Commits` }]} />
            <Field label={t`Commit message`}><Input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={defaultMessage ?? (strategy === 'squash' ? `Squash ${branch}` : `Merge ${branch} into ${into || '…'}`)} /></Field>
          </>}
          {dirty && !directory && <Field label={t`Uncommitted changes`} hint={t`They're committed first with this message.`}><Input value={pending} onChange={(event) => setPending(event.target.value)} placeholder={`WIP on ${branch}`} /></Field>}
          <label className="flex items-center justify-between gap-3 text-sm text-fg-2">
            <span className="flex flex-col"><span className="text-fg"><Trans>Remove Worktree After Merging</Trans></span><span className="text-xs text-fg-3"><Trans>The branch is kept; this folder's project is archived.</Trans></span></span>
            <Switch checked={remove} onCheckedChange={setRemove} aria-label={t`Remove Worktree After Merging`} />
          </label>
          {extra}
          {conflicts && (
            <div className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-sm text-fg-2">
              <p className="font-medium text-danger"><Trans>Conflicts; merge abandoned</Trans></p>
              {!directory && <p className="mt-1 text-xs text-fg-3"><Trans>Ask the agent to merge {target} into the worktree and resolve the conflicts, then merge again.</Trans></p>}
              {conflicts.length > 0 && <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-xs text-fg-2">{conflicts.slice(0, 8).map((path) => <li key={path} className="truncate">{path}</li>)}{conflicts.length > 8 && <li className="text-fg-4"><Plural value={conflicts.length - 8} _1="# more file" other="# more files" /></li>}</ul>}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}><Trans>Cancel</Trans></Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? <Spinner className="text-primary-fg" /> : <IconGitMerge />}<Trans>Merge</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
