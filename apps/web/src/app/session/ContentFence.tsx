import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { usePreviewTheme } from '@/lib/content-preview';
import { useTranscriptResources } from './transcriptResources';

/**
 * Source is supplied only to an opaque local document, never injected into the conversation DOM.
 *
 * The frame's box is held from the first render: off screen (`active` false) and during the
 * debounce it is the same 28rem the page will fill, so the preview arriving changes nothing around it.
 */
export function ContentFence({ code, language, active = true }: { code: string; language: string; active?: boolean }) {
  const { t } = useLingui();
  const theme = usePreviewTheme();
  const resources = useTranscriptResources();
  const page = resources ? resources.contentPage : '/content-preview';
  const key = JSON.stringify([code, language, theme]);
  const [request, setRequest] = useState<{ key: string; url: string }>();
  useEffect(() => {
    if (!page || !active) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(theme);
      params.set('source', code);
      params.set('language', language);
      setRequest({ key, url: `${page}#${params}` });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [code, language, theme, key, page, active]);
  if (request?.key === key) return <iframe title={t`${language} 预览`} src={request.url} sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" className="block h-[28rem] w-full border-0 bg-bg" />;
  return page
    ? <div aria-hidden className="h-[28rem] bg-bg" />
    : <pre className="overflow-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-(length:--text-code)"><code>{code}</code></pre>;
}
