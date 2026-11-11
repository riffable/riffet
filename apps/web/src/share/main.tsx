import { StrictMode, useEffect, useMemo, useRef, useState, type ErrorInfo } from 'react';
import { createRoot } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ShareSnapshot, ShareModelInfo } from '@contracts';
// First, so the source catalog is active before any other module runs. The page follows the
// viewer's language once `startLocale` has loaded it below.
import { startLocale, useLocale } from '@/lib/i18n';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Spinner } from '@/components/ui/controls';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AssistantMessage, UserMessage } from '@/app/session/Timeline';
import { ImageViewer } from '@/app/session/ImageViewer';
import { buildTimeline } from '@/app/session/buildTimeline';
import { projectEvents } from '@/app/session/projectEvents';
import { ImageSourceContext } from '@/app/session/imageSource';
import { TranscriptResourcesContext } from '@/app/session/transcriptResources';
import { installFocusRingPolicy } from '@/lib/focus-ring';
import { errorMessage, formatDateTime } from '@/lib/utils';
import { applyFont } from '@/lib/appearance';
import { BackdropLayer } from '@/components/appearance-backdrop';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { useTheme, setThemeId, setThemeMode, resetShareAppearance } from '@/lib/theme';
import { useThemeOptions } from '@/lib/theme-library';
import { ChoiceMenu } from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { backendLabel } from '@/lib/backends';
import { PrintImage, PrintRenderingContext } from '@/app/session/printRendering';
import { fitPrintMath, preparePrint } from './print';
import '@/lib/display-settings';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@/styles/index.css';
import './print.css';

installFocusRingPolicy();

const printMode = new URLSearchParams(window.location.search).get('print') === '1';
const nativePrint = printMode && new URLSearchParams(window.location.search).get('nativePrint') === '1';
if (printMode) document.documentElement.dataset.riffetPrint = '';

declare global {
  interface Window { riffetPreparePrint?: () => Promise<void> }
}

type ReaderStatus = { type: 'riffet-share-ready' | 'riffet-share-error'; capturedAt?: string };
function notifyReaderStatus(status: ReaderStatus): void {
  if (window.parent !== window) window.parent.postMessage(status, window.location.origin);
  const bridge = (window as Window & { webkit?: { messageHandlers?: { riffetShare?: { postMessage: (value: ReaderStatus) => void } } } }).webkit?.messageHandlers?.riffetShare;
  bridge?.postMessage(status);
}

let capturedAt: string | undefined;
class ShareErrorBoundary extends ErrorBoundary {
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    super.componentDidCatch(error, info);
    notifyReaderStatus({ type: 'riffet-share-error', ...(capturedAt ? { capturedAt } : {}) });
  }
}

function modelLabel(info: ShareModelInfo): string {
  return [info.model, info.reasoningEffort, info.fast ? 'Fast' : undefined, info.serviceTier].filter(Boolean).join(' · ');
}
function modelKey(info: ShareModelInfo): string {
  return JSON.stringify([info.model, info.reasoningEffort ?? null, info.fast ?? null, info.serviceTier ?? null]);
}

function ReaderAppearance() {
  const { t } = useLingui();
  const { themeId, mode } = useTheme();
  const options = useThemeOptions();
  return <details className="relative text-xs text-fg-3">
    <summary className="cursor-pointer"><Trans>外观</Trans></summary>
    <div className="absolute right-0 top-full z-20 mt-2 flex w-52 flex-col gap-2 rounded-xl border border-line bg-popover p-3 shadow-lg">
      <ChoiceMenu label={t`主题`} value={themeId} onChange={setThemeId} options={options.map(theme => ({ value: theme.id, label: theme.name }))} />
      <ChoiceMenu label={t`明暗`} value={mode} onChange={setThemeMode} options={[{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }]} />
      <Button variant="quiet" size="sm" onClick={resetShareAppearance}><Trans>原主题</Trans></Button>
    </div>
  </details>;
}

function SharedSession({ snapshot }: { snapshot: ShareSnapshot }) {
  const { t } = useLingui();
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    // Freeze font setup along with the content before announcing print readiness.
    const fonts = snapshot.appearance?.fonts;
    const fontSetup = Promise.all([
      applyFont('--font-sans', fonts?.ui && { id: 'share-ui', ...fonts.ui }),
      applyFont('--font-mono', fonts?.mono && { id: 'share-mono', ...fonts.mono }),
    ]);
    if (!printMode) {
      notifyReaderStatus({ type: 'riffet-share-ready', capturedAt: snapshot.capturedAt });
      return () => controller.abort();
    }
    let preparing: Promise<void> | undefined;
    const prepare = () => {
      if (preparing) return preparing;
      preparing = (async () => {
        const timeout = new AbortController();
        const timer = window.setTimeout(() => timeout.abort(new Error(t`打印资源加载超时，请重新加载预览`)), 40_000);
        try {
          const signal = AbortSignal.any([controller.signal, timeout.signal]);
          // Wait for font installation, fonts later introduced by KaTeX, and asynchronous renderers.
          if (!root.current) throw new Error(t`无法加载预览`);
          await preparePrint(root.current, signal, fontSetup);
        } finally { window.clearTimeout(timer); }
      })();
      const current = preparing;
      const settled = () => { if (preparing === current) preparing = undefined; };
      void current.then(settled, settled);
      return current;
    };
    window.riffetPreparePrint = prepare;
    const beforePrint = () => { if (root.current) fitPrintMath(root.current); };
    window.addEventListener('beforeprint', beforePrint);
    void prepare().then(() => {
      if (!controller.signal.aborted) notifyReaderStatus({ type: 'riffet-share-ready', capturedAt: snapshot.capturedAt });
    }).catch(() => {
      if (!controller.signal.aborted) notifyReaderStatus({ type: 'riffet-share-error', capturedAt: snapshot.capturedAt });
    });
    return () => {
      controller.abort();
      window.removeEventListener('beforeprint', beforePrint);
      if (window.riffetPreparePrint === prepare) delete window.riffetPreparePrint;
    };
  }, [snapshot]);
  const background = snapshot.appearance?.background;
  const author = snapshot.author;
  const rows = useMemo(() => {
    const events = projectEvents(snapshot.events);
    const items = new Map(buildTimeline(events, []).map(item => [item.event, item]));
    return events.map(event => {
      const models = event.sourceEvents.map(source => {
        const nativeId = 'nativeId' in source && typeof source.nativeId === 'string' ? source.nativeId : undefined;
        return nativeId && snapshot.modelInfo && Object.hasOwn(snapshot.modelInfo, nativeId) ? snapshot.modelInfo[nativeId] : undefined;
      });
      return { event, item: items.get(event), models };
    });
  }, [snapshot]);
  const assistantModels = rows.filter(row => row.item?.kind === 'assistant').flatMap(row => row.models);
  const commonModel = assistantModels.length > 0 && assistantModels.every(model => model && modelKey(model) === modelKey(assistantModels[0]!)) ? assistantModels[0] : undefined;
  const preview = document.querySelector('meta[name="riffet-share-preview"]')?.getAttribute('content') === 'true';
  const imageSource = useMemo(() => (path: string) => snapshot.resources[path]?.url, [snapshot]);
  return (
    <PrintRenderingContext.Provider value={printMode}>
    <TranscriptResourcesContext.Provider value={snapshot}>
      <ImageSourceContext.Provider value={imageSource}>
        <main ref={root} className={`share-session relative flex h-dvh min-h-0 flex-col bg-bg text-fg${printMode ? ' share-print' : ''}`}>
          {nativePrint && <style>{'@page { size: auto; margin: auto; }'}</style>}
          {background && !printMode && <BackdropLayer url={background.url} opacity={background.opacity} fit={background.fit} />}
          <header className="share-session-header flex min-h-13 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 edge-b px-4 py-3 md:px-6">
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={snapshot.title}>{snapshot.title}</h1>
            {author && <span className="inline-flex items-center gap-1.5 text-xs text-fg-3"><OwnerAvatar owner={{ name: author.name, avatar: author.avatar ? { url: author.avatar } : undefined }} size={20} />{author.name}</span>}
            <span className="text-xs text-fg-3">{backendLabel(snapshot.backendId)}{commonModel ? ` · ${modelLabel(commonModel)}` : ''}</span>
            {!preview && !printMode && <ReaderAppearance />}
            {snapshot.scope && <span className="text-xs text-fg-3">{snapshot.scope.mode === 'recent' ? t`最近` : t`已选`} <Trans>{snapshot.scope.turnCount} 轮</Trans></span>}
            <time dateTime={snapshot.capturedAt} className="text-xs tabular-nums text-fg-3"><Trans>内容截至 {formatDateTime(snapshot.capturedAt)}</Trans></time>
            {snapshot.warnings.length > 0 && <details open={printMode || undefined} className="w-full text-xs text-warning"><summary className="cursor-pointer"><Trans>部分内容未包含</Trans></summary><ul className="mt-1 space-y-1">{snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
          </header>
          <div className="share-session-scroll min-h-0 flex-1 overflow-y-auto">
            <div className="share-session-content mx-auto flex w-full max-w-(--content-width) flex-col gap-8 px-3 pb-10 pt-6 sm:px-4 sm:pt-8 md:px-12">
              {rows.map(({ event, item, models }) => {
                if (item?.kind === 'user') return <UserMessage key={item.key} text={item.text} attachments={item.attachments} time={event.createdAt} />;
                if (item?.kind === 'assistant') {
                  const labels = [...new Map(models.filter((model): model is ShareModelInfo => Boolean(model)).map(model => [modelKey(model), modelLabel(model)])).values()];
                  return <div key={item.key} className="min-w-0 space-y-2">{!commonModel && labels.length > 0 && <p className="text-xs text-fg-3">{labels.join(' / ')}</p>}<AssistantMessage text={item.text} time={event.createdAt} showActions={!printMode} /></div>;
                }
                const content = event.data.content as { type?: string; path?: string; src?: string } | undefined;
                const resource = content?.type === 'image' ? snapshot.resources[content.path ?? content.src ?? ''] : undefined;
                const src = resource?.url ?? (item?.kind === 'image' ? item.src : undefined);
                return src ? printMode ? <PrintImage key={event.projectionKey} src={src} name={resource?.name ?? t({ message: '图片', context: 'share-image-name' })} /> : <ImageViewer key={event.projectionKey} src={src} name={resource?.name ?? t({ message: '图片', context: 'share-image-name' })}><button type="button" className="block max-w-full"><img src={src} alt={resource?.name ?? ''} loading="lazy" className="max-h-[80dvh] max-w-full rounded-xl object-contain" /></button></ImageViewer> : null;
              })}
              {!rows.length && <p className="py-12 text-sm text-fg-3"><Trans>这个会话没有消息。</Trans></p>}
            </div>
          </div>
        </main>
      </ImageSourceContext.Provider>
    </TranscriptResourcesContext.Provider>
    </PrintRenderingContext.Provider>
  );
}

function LoadingSession() {
  const { t } = useLingui();
  const [state, setState] = useState<{ snapshot?: ShareSnapshot; error?: string }>({});
  // A single static document supplies the whole reading model; there is no workbench bootstrap.
  useEffect(() => {
    let active = true;
    const target = document.querySelector<HTMLMetaElement>('meta[name="riffet-share-data"]')?.content;
    const fail = (message: string) => { if (active) { setState({ error: message }); notifyReaderStatus({ type: 'riffet-share-error' }); } };
    if (!target) { fail(t`会话数据不可用`); return; }
    const url = new URL(target, window.location.href);
    if (url.origin !== window.location.origin) { fail(t`会话数据地址无效`); return; }
    void fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error(t`会话数据不可用`);
      const snapshot = await response.json() as ShareSnapshot;
      if (snapshot.format !== 'riffet-share-v1' || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.warnings) || !Array.isArray(snapshot.runs) || !Array.isArray(snapshot.subagents) || !Array.isArray(snapshot.jobs) || !snapshot.resources || !snapshot.blobs || !snapshot.diagramPages) throw new Error(t`会话数据版本不兼容`);
      if (typeof snapshot.capturedAt !== 'string' || typeof snapshot.title !== 'string') throw new Error(t`会话数据版本不兼容`);
      capturedAt = snapshot.capturedAt;
      document.title = `${snapshot.title} · Riffet`;
      if (active) setState({ snapshot });
    }).catch(error => fail(errorMessage(error, t`会话数据不可用`)));
    return () => { active = false; };
  }, []);
  if (state.snapshot) return <SharedSession snapshot={state.snapshot} />;
  return <main className="grid h-dvh place-items-center bg-bg text-sm text-fg-3">{state.error ? <p role="alert">{state.error}</p> : <Spinner />}</main>;
}

/** Re-renders the page when a catalog finishes activating, so every message follows the viewer. */
function Root() {
  useLocale();
  return <StrictMode><I18nProvider i18n={i18n}><TooltipProvider delayDuration={400} skipDelayDuration={150}><ShareErrorBoundary variant="page"><LoadingSession /></ShareErrorBoundary></TooltipProvider></I18nProvider></StrictMode>;
}

createRoot(document.getElementById('root')!).render(<Root />);
/*
 * The source catalog is bundled and already active, so the first paint needs no wait. A viewer whose
 * language is English loads that catalog on demand; the provider re-renders when it arrives.
 */
void startLocale();
