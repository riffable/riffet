import { lazy, Suspense, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { FilePreview } from '@contracts';
import type { CodeFileProps, FileIconProps } from '@riffet/plugin-web';
import { IconDownload, IconFile, IconImage, IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Spinner } from '@/components/ui/controls';
import { api, HttpError, isFileReference, projectImageUrl } from '@/lib/api';
import { downloadProjectFile } from '@/lib/files';
import { errorMessage, formatBytes } from '@/lib/utils';
import { FileIcon as PanelFileIcon } from '../app/panels/fileVisuals';
import { ZoomPanImage } from '../app/session/ZoomPanImage';

const CodeView = lazy(() => import('../app/panels/CodeView').then((module) => ({ default: module.CodeView })));

type Loaded = { state: 'loading' } | { state: 'ready'; preview: FilePreview } | { state: 'missing' } | { state: 'failed'; message: string };

/**
 * `UiKit.CodeFile`: a project file read the way the files panel reads it, for a plugin view that
 * lays out its own reading surface (`plugins/riffet/studio`). Read only: editing stays in the files
 * panel, where drafts, conflicts and saves are handled.
 */
export function CodeFile({ projectId, path, target, onSymbol, onTopLine, onLine, onViewport, baseline, blame, onBlameCommit }: CodeFileProps) {
  const { t } = useLingui();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setLoaded({ state: 'loading' });
    setImageFailed(false);
    api.preview(projectId, path).then(
      (preview) => { if (live) setLoaded({ state: 'ready', preview }); },
      (error: unknown) => {
        if (!live) return;
        setLoaded(error instanceof HttpError && error.status === 404 ? { state: 'missing' } : { state: 'failed', message: errorMessage(error, t`无法打开文件`) });
      },
    );
    return () => { live = false; };
  }, [projectId, path, attempt, t]);

  if (loaded.state === 'loading') return <div className="flex flex-1 justify-center py-10"><Spinner /></div>;
  if (loaded.state === 'missing') return <EmptyState className="flex-1" title={t`文件不存在`} />;
  if (loaded.state === 'failed') {
    return <EmptyState className="flex-1" title={loaded.message}><Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}><IconRefreshCw /><Trans>重试</Trans></Button></EmptyState>;
  }
  const { preview } = loaded;
  if (preview.image) {
    if (imageFailed) return <EmptyState className="flex-1" icon={<IconImage />} title={t`图片无法加载`} />;
    const src = projectImageUrl(projectId, preview.path, preview.hash);
    return <ZoomPanImage src={src} alt={preview.path.split('/').at(-1) ?? preview.path} className="min-h-0 flex-1 bg-subtle/30" onError={() => setImageFailed(true)} />;
  }
  if (preview.binary) {
    return (
      <EmptyState className="flex-1" icon={<IconFile />} title={t`二进制文件`} description={formatBytes(preview.size)}>
        <Button variant="secondary" onClick={() => downloadProjectFile(projectId, preview.path)}><IconDownload /><Trans>下载</Trans></Button>
      </EmptyState>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<div className="flex flex-1 justify-center py-10"><Spinner /></div>}>
        <CodeView
          preview={preview}
          target={target}
          baseline={baseline}
          blame={blame}
          {...(onViewport ? { onViewport } : {})}
          {...(onBlameCommit ? { onBlameCommit } : {})}
          onReference={(reference) => { if (isFileReference(reference) && reference.line !== undefined) onLine?.({ path: reference.path, line: reference.line, text: reference.text ?? '' }); }}
          {...(onSymbol ? { onSymbol } : {})}
          {...(onTopLine ? { onTopLine } : {})}
        />
      </Suspense>
      {preview.truncated && <div className="shrink-0 edge-t px-4 py-1.5 text-xs text-fg-3"><Trans>文件过大，仅显示前一部分</Trans></div>}
    </div>
  );
}

export function FileIcon({ name, directory, className }: FileIconProps) {
  return <PanelFileIcon entry={{ name, kind: directory ? 'directory' : 'file' }} {...(className ? { className } : {})} />;
}
