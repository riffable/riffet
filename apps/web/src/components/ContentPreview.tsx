import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconDownload, IconFile, IconRefreshCw } from './icons';
import { Button } from './ui/button';
import { EmptyState, Spinner } from './ui/controls';
import { cn } from '@/lib/utils';

/** Validate with the host's auth scope, then load a separate document with its own response CSP. */
export function ContentPreview({ url, title, className, onDownload }: { url: string; title: string; className?: string; onDownload: () => void }) {
  const { t } = useLingui();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ url: string; attempt: number; ready?: boolean; failed?: boolean }>();
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Preview unavailable');
      }
      // srcdoc and Blob documents inherit the host's CSP. The checked URL is a separate HTTP
      // document, so its inline engine keeps its own policy without relaxing the workbench's.
      void response.body?.cancel().catch(() => {});
      if (!controller.signal.aborted) setResult({ url, attempt, ready: true });
    })().catch(() => { if (!controller.signal.aborted) setResult({ url, attempt, failed: true }); });
    return () => controller.abort();
  }, [url, attempt]);
  const current = result?.url === url && result.attempt === attempt ? result : undefined;
  if (current?.ready) return <iframe title={title} src={url} onError={() => setResult({ url, attempt, failed: true })} sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" className={cn('min-h-0 w-full flex-1 border-0 bg-bg', className)} />;
  return (
    <div className={cn('flex min-h-0 w-full flex-1 items-center justify-center', className)}>
      {current?.failed ? <EmptyState icon={<IconFile />} title={t`无法预览此文件`}><div className="flex gap-2"><Button onClick={onDownload}><IconDownload /><Trans>下载</Trans></Button><Button variant="quiet" onClick={() => setAttempt(value => value + 1)}><IconRefreshCw /><Trans>重试</Trans></Button></div></EmptyState> : <Spinner />}
    </div>
  );
}
