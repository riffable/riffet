import { withClientFeatures } from '@/lib/api';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconCopy, IconEye, IconFileCode2 } from '@/components/icons';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { copyWithToast } from '@/lib/files';
import { cn, errorMessage } from '@/lib/utils';
import { useFileAccess } from './fileAccess';
import type { VisualizationReference } from './visualizationReferences';

function fileName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/** Load theme state only when an iframe is opened; Markdown itself stays safe to render on the server. */
const ThemedFrame = lazy(async () => {
  const { useTheme } = await import('@/lib/theme');
  function Frame({ src, name, hidden, onError }: { src: string; name: string; hidden: boolean; onError: () => void }) {
    const { resolved } = useTheme();
    const { t } = useLingui();
    return (
      <iframe
        title={t`交互预览：${name}`}
        src={`${src}&scheme=${resolved}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        hidden={hidden}
        onError={onError}
        className="min-h-0 flex-1 rounded-lg border border-line bg-white"
      />
    );
  }
  return { default: Frame };
});

export function VisualizationPreview({ reference }: { reference: VisualizationReference }) {
  const { t } = useLingui();
  const files = useFileAccess();
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failure, setFailure] = useState('');
  const [previewContent, setPreviewContent] = useState('');
  const [sourceTruncated, setSourceTruncated] = useState(false);
  const name = reference.title?.trim() || fileName(reference.path);
  const projectId = files?.projectId;

  useEffect(() => {
    if (!open || !projectId) return;
    let current = true;
    setStatus('loading');
    setFailure('');
    setPreviewContent('');
    setSourceTruncated(false);
    setView('preview');
    void api.preview(projectId, reference.path)
      .then((result) => {
        if (!current) return;
        if (result.size > 1_000_000) throw new Error(t`文件超过 1 MB，无法载入交互预览`);
        if (result.binary) throw new Error(t`文件内容无法作为 HTML 读取`);
        setPreviewContent(result.content);
        setSourceTruncated(result.truncated);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!current) return;
        setFailure(errorMessage(error, t`无法读取交互预览文件`));
        setStatus('error');
      });
    return () => { current = false; };
  }, [open, projectId, reference.path, retry]);

  const sourceButton = status === 'ready' ? (
    <button
      type="button"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-fg-2 transition-colors hover:bg-hover hover:text-fg"
      onClick={() => setView((value) => value === 'source' ? 'preview' : 'source')}
    >{view === 'source' ? <><IconEye className="size-3.5" /><Trans>返回预览</Trans></> : <><IconFileCode2 className="size-3.5" /><Trans>查看源码</Trans></>}</button>
  ) : null;

  const copyButton = (
    <button
      type="button"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-fg-2 transition-colors hover:bg-hover hover:text-fg"
      onClick={() => void copyWithToast(reference.path, t`已复制文件路径`)}
    ><IconCopy className="size-3.5" /><Trans>复制路径</Trans></button>
  );

  const previewUrl = projectId
    ? withClientFeatures(`/api/projects/${encodeURIComponent(projectId)}/file/raw?path=${encodeURIComponent(reference.path)}&render=visualize`)
    : undefined;

  return (
    <span className="my-2 inline-flex w-full max-w-2xl flex-wrap items-stretch gap-2 align-middle">
      <button
        type="button"
        disabled={!projectId}
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-line bg-elevated px-3.5 py-3 text-left shadow-sm transition-colors',
          projectId ? 'hover:border-accent/40 hover:bg-hover' : 'cursor-default opacity-80',
        )}
        aria-label={projectId ? t`打开交互预览：${name}` : t`交互预览不可用：${reference.path}`}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-subtle text-accent"><IconEye className="size-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-fg-3"><Trans>交互预览</Trans></span>
          <span className="block truncate text-sm font-medium text-fg" title={name}>{name}</span>
          {!projectId && <span className="mt-0.5 block text-xs text-fg-3"><Trans>当前会话未关联项目，无法预览</Trans></span>}
        </span>
        <span className="hidden max-w-[45%] truncate font-mono text-2xs text-fg-4 sm:block" title={reference.path}>{reference.path}</span>
      </button>
      {!projectId && copyButton}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          mobileFullscreen
          aria-describedby={undefined}
          className={cn(
            'flex h-[min(88dvh,960px)] w-[min(1120px,calc(100vw-32px))] max-w-none flex-col overflow-hidden p-0',
            reference.mode === 'wide' && 'w-[min(1480px,calc(100vw-32px))]',
          )}
        >
          <DialogHeader className="edge-b gap-1.5 pr-14">
            <DialogTitle className="truncate text-base" title={name}>{name}</DialogTitle>
            <DialogDescription className="truncate font-mono text-xs" title={reference.path}>{reference.path}</DialogDescription>
            <div className="-ml-2 mt-1 flex flex-wrap items-center gap-1">
              {sourceButton}
              {copyButton}
            </div>
          </DialogHeader>
          <DialogBody className="flex flex-1 flex-col overflow-hidden px-3 pb-3 pt-3">
            {status === 'loading' && (
              <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-2 text-sm text-fg-3" role="status">
                <Spinner /><Trans>正在读取 HTML 文件…</Trans>
              </div>
            )}
            {status === 'error' && (
              <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-3 text-center" role="alert">
                <p className="text-sm text-fg-2">{failure}</p>
                <button
                  type="button"
                  className="inline-flex h-9 items-center rounded-lg bg-subtle px-3 text-sm text-fg transition-colors hover:bg-hover"
                  onClick={() => setRetry((value) => value + 1)}
                ><Trans>重试</Trans></button>
              </div>
            )}
            {status === 'ready' && previewUrl && (
              <>
                <Suspense fallback={<div hidden={view === 'source'} className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-3" role="status"><Spinner /><Trans>正在载入预览…</Trans></div>}>
                  <ThemedFrame
                    key={`${reference.path}:${retry}`}
                    src={previewUrl}
                    name={name}
                    hidden={view === 'source'}
                    onError={() => { setFailure(t`无法加载交互预览，请重试`); setStatus('error'); }}
                  />
                </Suspense>
                <div hidden={view !== 'source'} className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-subtle">
                  {sourceTruncated && <p className="edge-b px-3 py-2 text-xs text-fg-3"><Trans>文件较大，以下源码内容已截断。</Trans></p>}
                  <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-fg">{previewContent}</pre>
                </div>
              </>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </span>
  );
}
