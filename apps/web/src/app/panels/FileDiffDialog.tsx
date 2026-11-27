import { lazy, Suspense, useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { GitDiff } from '@contracts';
import { IconArrowUpRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Segmented, Spinner } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/utils';

const MergeDiff = lazy(() => import('./MergeDiff'));

type DiffScope = 'session' | 'git';

/**
 * Compares a file reached from a conversation's outputs: prefers this conversation's own exact net
 * snapshot diff when available, and lets the reader switch to the project's current Git diff.
 */
export function FileDiffDialog({
  projectId,
  sessionId,
  path,
  preferSession = false,
  outsideProject = false,
  onClose,
  onOpenPath,
}: {
  projectId: string;
  sessionId?: string;
  path?: string;
  preferSession?: boolean;
  outsideProject?: boolean;
  onClose: () => void;
  onOpenPath?: (path: string) => void;
}) {
  const { t } = useLingui();
  const [scopeChoice, setScopeChoice] = useState<{ path: string; scope: DiffScope }>();
  const [side, setSide] = useState<{ path: string; staged: boolean }>();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    projectId: string;
    path: string;
    scope: DiffScope;
    staged: boolean;
    bothSides?: boolean;
    externalEdits?: boolean;
    hasSessionSnapshot?: boolean;
    diff?: GitDiff;
    error?: string;
  }>();

  const canUseSession = Boolean(sessionId && preferSession);
  const requestedScope: DiffScope = scopeChoice && scopeChoice.path === path
    ? scopeChoice.scope
    : canUseSession ? 'session' : 'git';
  const requestedSide = side && side.path === path ? side.staged : undefined;

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const controller = new AbortController();
    setResult(undefined);
    void (async () => {
      if (requestedScope === 'session' && sessionId) {
        try {
          const snapshot = await api.sessionOutputDiff(sessionId, path, controller.signal);
          if (cancelled) return;
          const diff: GitDiff = {
            path: snapshot.path,
            patch: '',
            before: snapshot.before,
            after: snapshot.after,
            binary: Boolean(snapshot.binary),
            truncated: Boolean(snapshot.truncated),
          };
          setResult({
            projectId,
            path,
            scope: 'session',
            staged: false,
            externalEdits: snapshot.externalEdits,
            hasSessionSnapshot: true,
            diff,
          });
          return;
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
          // Fall back to Git diff when no session snapshot is stored and the file lives inside the project.
          const code = (error as { code?: string; status?: number } | undefined)?.code;
          const status = (error as { status?: number } | undefined)?.status;
          if (outsideProject || (code !== 'OUTPUT_SNAPSHOT_UNAVAILABLE' && status !== 404)) {
            setResult({ projectId, path, scope: 'session', staged: false, error: errorMessage(error, t`Couldn't load the diff`) });
            return;
          }
        }
      }
      try {
        const status = await api.gitStatus(projectId, true);
        if (cancelled) return;
        const entry = status.entries.find((item) => item.path === path);
        const hasStaged = Boolean(entry && entry.index !== ' ' && entry.index !== '?');
        const hasUnstaged = Boolean(entry && (entry.worktree !== ' ' || entry.index === '?'));
        const staged = hasStaged && hasUnstaged ? requestedSide ?? false : hasStaged && !hasUnstaged;
        const diff = await api.gitDiff(projectId, path, { staged });
        if (!cancelled) {
          setResult({
            projectId,
            path,
            scope: 'git',
            staged,
            bothSides: hasStaged && hasUnstaged,
            hasSessionSnapshot: canUseSession,
            diff,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setResult({ projectId, path, scope: 'git', staged: requestedSide ?? false, hasSessionSnapshot: canUseSession, error: errorMessage(error, t`Couldn't load the diff`) });
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [projectId, sessionId, path, requestedScope, requestedSide, revision, canUseSession, outsideProject, t]);

  const current = result?.projectId === projectId && result.path === path
    && (result.scope === requestedScope || (requestedScope === 'session' && result.scope === 'git' && result.hasSessionSnapshot === false))
    && (result.scope === 'session' || !result.bothSides || requestedSide === undefined || result.staged === requestedSide)
    ? result
    : undefined;
  const diff = current?.diff;
  const loading = <div className="grid min-h-32 flex-1 place-items-center"><Spinner /></div>;
  const close = () => {
    setScopeChoice(undefined);
    setSide(undefined);
    setResult(undefined);
    onClose();
  };
  const showScopeToggle = Boolean(path && !outsideProject && canUseSession && current?.hasSessionSnapshot);
  const description = diff?.binary
    ? t`Binary file`
    : diff?.truncated
      ? t`Preview truncated`
      : current?.scope === 'session'
        ? current.externalEdits ? t`期间含外部改动` : t`本会话`
        : current?.staged ? t`Staged` : t`Working tree changes`;

  return <Dialog open={Boolean(path)} onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent mobileFullscreen className="h-[min(820px,calc(100dvh-32px))] max-w-5xl">
      <DialogHeader>
        <DialogTitle className="flex min-w-0 items-center gap-1.5 font-mono text-base">
          <span className="min-w-0 truncate text-left [direction:rtl]"><bdi>{path}</bdi></span>
          {path && onOpenPath && (
            <Tip label={t`文件预览`}>
              <Button
                size="icon-xs"
                variant="quiet"
                className="shrink-0 text-fg-3 hover:text-fg max-md:size-10 no-hover:size-11"
                aria-label={t`文件预览`}
                onClick={() => { close(); onOpenPath(path); }}
              >
                <IconArrowUpRight />
              </Button>
            </Tip>
          )}
        </DialogTitle>
        <DialogDescription className={(current?.bothSides || showScopeToggle) && diff && !diff.binary && !diff.truncated && !current?.externalEdits ? 'sr-only' : undefined}>
          {description}
        </DialogDescription>
        {(showScopeToggle || (current?.scope === 'git' && current.bothSides)) && path && (
          <div className="flex flex-wrap items-center gap-2">
            {showScopeToggle && (
              <Segmented
                size="xs"
                value={current?.scope ?? requestedScope}
                onChange={(value) => setScopeChoice({ path, scope: value as DiffScope })}
                ariaLabel={t`对比范围`}
                options={[{ value: 'session', label: t`本会话` }, { value: 'git', label: t`工作区` }]}
              />
            )}
            {current?.scope === 'git' && current.bothSides && (
              <Segmented
                size="xs"
                value={current.staged ? 'staged' : 'unstaged'}
                onChange={(value) => setSide({ path, staged: value === 'staged' })}
                ariaLabel={t`Side`}
                options={[{ value: 'unstaged', label: t`Unstaged` }, { value: 'staged', label: t`Staged` }]}
              />
            )}
          </div>
        )}
      </DialogHeader>
      {!current ? loading : current.error ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto px-5 pb-5">
        <p role="alert" className="text-sm text-fg-3 wrap-anywhere">{current.error}</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>{t`Refresh`}</Button>
          {path && onOpenPath && <Button variant="ghost" size="sm" onClick={() => { close(); onOpenPath(path); }}>{t`Open`}</Button>}
        </div>
      </div> : diff && !diff.binary && !diff.truncated && diff.before === diff.after ? <EmptyState title={t`No file differences`} /> : <div className="mx-5 mb-5 min-h-0 flex-1 overflow-auto rounded-xl border border-line max-md:mx-3 max-md:mb-3">
        <Suspense fallback={loading}>{diff && <MergeDiff diff={diff} />}</Suspense>
      </div>}
    </DialogContent>
  </Dialog>;
}
