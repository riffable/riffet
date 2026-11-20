import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconDownload, IconFile, IconRefreshCw, IconTextQuote } from './icons';
import { Button } from './ui/button';
import { EmptyState, Spinner } from './ui/controls';
import { cn } from '@/lib/utils';

/** Validate with the host's auth scope, then load a separate document with its own response CSP. */
export function ContentPreview({ url, title, className, onDownload, onQuote }: {
  url: string; title: string; className?: string; onDownload: () => void;
  /** Offers to quote what the reader selects in the page, which reports it (`previews/document.ts`). */
  onQuote?: ((text: string) => void) | undefined;
}) {
  const { t } = useLingui();
  const frame = useRef<HTMLIFrameElement>(null);
  const [selection, setSelection] = useState<{ text: string; x: number; y: number }>();
  useEffect(() => {
    if (!onQuote) return;
    const listen = (event: MessageEvent) => {
      // Only this frame's page, which runs in an opaque origin: its window is the only proof.
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'riffet-preview-selection') return;
      const { text, rect } = event.data as { text?: unknown; rect?: { x: number; y: number; width: number; height: number } | null };
      setSelection(typeof text === 'string' && text && rect ? { text, x: rect.x + rect.width / 2, y: rect.y } : undefined);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [onQuote]);
  useEffect(() => setSelection(undefined), [url]);
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
  if (current?.ready) {
    const page = <iframe ref={frame} title={title} src={url} onError={() => setResult({ url, attempt, failed: true })} sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" className={cn('min-h-0 w-full flex-1 border-0 bg-bg', className)} />;
    if (!onQuote) return page;
    return (
      <div className="relative flex min-h-0 w-full flex-1 flex-col">
        {page}
        {selection && (
          // Above the selection, as the transcript's selection toolbar; under its top line when that is off the top.
          <div className="absolute z-10 -translate-x-1/2" style={{ left: selection.x, top: Math.max(4, selection.y - 36) }}>
            <Button size="xs" variant="secondary" className="shadow-pop" onMouseDown={(event) => event.preventDefault()} onClick={() => { onQuote(selection.text); setSelection(undefined); }}>
              <IconTextQuote /><Trans context="session-quote-action">引用</Trans>
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={cn('flex min-h-0 w-full flex-1 items-center justify-center', className)}>
      {current?.failed ? <EmptyState icon={<IconFile />} title={t`无法预览此文件`}><div className="flex gap-2"><Button onClick={onDownload}><IconDownload /><Trans>下载</Trans></Button><Button variant="quiet" onClick={() => setAttempt(value => value + 1)}><IconRefreshCw /><Trans>重试</Trans></Button></div></EmptyState> : <Spinner />}
    </div>
  );
}
