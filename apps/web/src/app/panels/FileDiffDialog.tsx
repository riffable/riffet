import { lazy, Suspense, useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { GitDiff } from '@contracts';
import { Button } from '@/components/ui/button';
import { EmptyState, Segmented, Spinner } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/utils';

const MergeDiff = lazy(() => import('./MergeDiff'));

/** A file reached from the conversation opens the same read-only comparison as the Git panel. */
export function FileDiffDialog({ projectId, path, onClose, onOpenPath }: { projectId: string; path?: string; onClose: () => void; onOpenPath?: (path: string) => void }) {
  const { t } = useLingui();
  const [side, setSide] = useState<{ path: string; staged: boolean }>();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ projectId: string; path: string; staged: boolean; bothSides?: boolean; diff?: GitDiff; error?: string }>();
  const requestedSide = side && side.path === path ? side.staged : undefined;
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setResult(undefined);
    void (async () => {
      try {
        const status = await api.gitStatus(projectId, true);
        if (cancelled) return;
        const entry = status.entries.find((entry) => entry.path === path);
        const hasStaged = Boolean(entry && entry.index !== ' ' && entry.index !== '?');
        const hasUnstaged = Boolean(entry && (entry.worktree !== ' ' || entry.index === '?'));
        const staged = hasStaged && hasUnstaged ? requestedSide ?? false : hasStaged && !hasUnstaged;
        const diff = await api.gitDiff(projectId, path, { staged });
        if (!cancelled) setResult({ projectId, path, staged, bothSides: hasStaged && hasUnstaged, diff });
      } catch (error) {
        if (!cancelled) setResult({ projectId, path, staged: requestedSide ?? false, error: errorMessage(error, t`Couldn't load the diff`) });
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, path, requestedSide, revision, t]);
  const current = result?.projectId === projectId && result.path === path && (!result.bothSides || requestedSide === undefined || result.staged === requestedSide) ? result : undefined;
  const diff = current?.diff;
  const loading = <div className="grid min-h-32 flex-1 place-items-center"><Spinner /></div>;
  const close = () => { setSide(undefined); setResult(undefined); onClose(); };
  return <Dialog open={Boolean(path)} onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent mobileFullscreen className="h-[min(820px,calc(100dvh-32px))] max-w-5xl">
      <DialogHeader>
        <DialogTitle className="truncate font-mono text-base">{path}</DialogTitle>
        <DialogDescription className={current?.bothSides && diff && !diff.binary && !diff.truncated ? 'sr-only' : undefined}>
          {diff?.binary ? t`Binary file` : diff?.truncated ? t`Preview truncated` : current?.staged ? t`Staged` : t`Working tree changes`}
        </DialogDescription>
        {current?.bothSides && path && <Segmented size="xs" value={current.staged ? 'staged' : 'unstaged'} onChange={(value) => setSide({ path, staged: value === 'staged' })} ariaLabel={t`Side`} options={[{ value: 'unstaged', label: t`Unstaged` }, { value: 'staged', label: t`Staged` }]} />}
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
