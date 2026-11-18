import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo } from 'react';
import { createRoot } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { Trans, useLingui } from '@lingui/react/macro';
import { CODE_THEME_AUTO, isPluginAgentId, parseCodeThemeSelection, type NativeBackendId, type ShareModelInfo, type ShareSnapshot } from '@contracts';
// First, so the source catalog is active before any other module runs. The page follows the
// viewer's language once `startLocale` has loaded it below.
import { localeOptions, setLocale, startLocale, useLocale, type AppLocale } from '@/lib/i18n';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AgentMark } from '@/components/agent-marks';
import { BrandMark, GitHubMark } from '@/components/BrandMark';
import { IconBot, IconExternalLink, IconInfoOutline, IconPrinter, IconSwatchBook } from '@/components/icons';
import { ThemeSwatch } from '@/components/theme-swatch';
import { Button } from '@/components/ui/button';
import { Segmented, Select, Spinner } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip, TooltipProvider } from '@/components/ui/tooltip';
import { BackdropLayer } from '@/components/appearance-backdrop';
import { applyFont } from '@/lib/appearance';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { buildTimeline } from '@/app/session/buildTimeline';
import { ImageSourceContext } from '@/app/session/imageSource';
import type { TimelineItem } from '@/app/session/model';
import { PrintImage, PrintRenderingContext } from '@/app/session/printRendering';
import { projectEvents } from '@/app/session/projectEvents';
import { AssistantMessage, UserMessage } from '@/app/session/Timeline';
import { shareModelKey, shareModelLabel, TranscriptResourcesContext, type TranscriptResources } from '@/app/session/transcriptResources';
import { TranscriptView } from '@/app/session/TranscriptView';
import { agentMarkStyle, backendLabel } from '@/lib/backends';
import { BUILTIN_CODE_THEMES } from '@/lib/code-themes.generated';
import { setDisplaySettings, useDisplaySettings, type TextSize } from '@/lib/display-settings';
import { installFocusRingPolicy } from '@/lib/focus-ring';
import { resetShareAppearance, setThemeId, setThemeMode, useTheme, type ThemeMode } from '@/lib/theme';
import { useThemeOptions } from '@/lib/theme-library';
import { errorMessage, formatDateTime, isRecord } from '@/lib/utils';
import { fitPrintMath, preparePrint } from './print';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@/styles/index.css';
import './print.css';

installFocusRingPolicy();

const GITHUB_REPO_URL = 'https://github.com/riffable/riffet';
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

function AgentGlyph({ backend }: { backend: NativeBackendId }) {
  if (isPluginAgentId(backend)) return <IconBot aria-hidden className="size-3.5 shrink-0 text-fg-3" />;
  return <AgentMark backend={backend} size={14} className="shrink-0" style={agentMarkStyle(backend)} />;
}

/** Reader appearance & reading controls, reusing the app's Popover, Select and Segmented primitives. */
function ReaderAppearance({ customSyntaxTheme }: { customSyntaxTheme?: { id: string; name: string } }) {
  const { t } = useLingui();
  const { themeId, mode } = useTheme();
  const options = useThemeOptions();
  const display = useDisplaySettings();
  const locale = useLocale();
  const currentLocale: AppLocale = locale === 'en' ? 'en' : 'zh-Hans';
  const effectiveCodeTheme = display.codeTheme.startsWith('custom-') && display.codeTheme !== customSyntaxTheme?.id
    ? CODE_THEME_AUTO
    : display.codeTheme;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="quiet" size="sm" className="no-hover:h-11 no-hover:px-3" aria-label={t`外观`}>
          <IconSwatchBook />
          <span className="hidden sm:inline"><Trans>外观</Trans></span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" mobileSheet className="w-72 p-4 max-md:w-full">
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-3"><Trans>主题</Trans></span>
            <Select
              label={t`主题`}
              value={themeId}
              onChange={setThemeId}
              options={options.map(theme => ({
                value: theme.id,
                label: theme.name,
                icon: <ThemeSwatch id={theme.id} className="h-4 w-6 rounded-sm" />,
              }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-3"><Trans>明暗</Trans></span>
            <Segmented<ThemeMode>
              size="xs"
              className="w-full"
              ariaLabel={t`明暗`}
              value={mode}
              onChange={setThemeMode}
              options={[
                { value: 'system', label: t`跟随系统` },
                { value: 'light', label: t`浅色` },
                { value: 'dark', label: t`深色` },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-3"><Trans>代码高亮</Trans></span>
            <Select<string>
              label={t`代码高亮`}
              value={effectiveCodeTheme}
              onChange={value => setDisplaySettings({ codeTheme: parseCodeThemeSelection(value) })}
              options={[
                { value: CODE_THEME_AUTO, label: t`跟随界面主题` },
                ...BUILTIN_CODE_THEMES.map(item => ({
                  value: item.id,
                  label: item.id === 'monochrome' ? t`极简墨色` : item.name,
                })),
                ...(customSyntaxTheme ? [{ value: customSyntaxTheme.id, label: customSyntaxTheme.name }] : []),
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-3"><Trans>文字大小</Trans></span>
            <Segmented<TextSize>
              size="xs"
              className="w-full"
              ariaLabel={t`文字大小`}
              value={display.textSize}
              onChange={textSize => setDisplaySettings({ textSize })}
              options={[
                { value: 'small', label: t`小` },
                { value: 'standard', label: t`标准` },
                { value: 'large', label: t`大` },
                { value: 'extra-large', label: t`特大` },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-3"><Trans>语言</Trans></span>
            <Segmented<AppLocale>
              size="xs"
              className="w-full"
              ariaLabel={t`语言`}
              value={currentLocale}
              onChange={setLocale}
              options={localeOptions}
            />
          </div>
          <div className="flex justify-end edge-t pt-2.5">
            <Button variant="quiet" size="xs" onClick={resetShareAppearance}><Trans>原主题</Trans></Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Build the reading timeline, preserving standalone frozen image events whose inline `data` was replaced with `path`/`src`. */
function buildShareTimeline(snapshot: ShareSnapshot): TimelineItem[] {
  const projected = projectEvents(snapshot.events);
  const built = buildTimeline(projected, []);
  const byKey = new Map(built.map(item => [item.event.projectionKey, item]));
  const items: TimelineItem[] = [];
  for (const event of projected) {
    const existing = byKey.get(event.projectionKey);
    if (existing) {
      items.push(existing);
      continue;
    }
    const content = isRecord(event.data.content) ? event.data.content : undefined;
    if (content?.type === 'image') {
      const ref = typeof content.path === 'string' ? content.path : typeof content.src === 'string' ? content.src : '';
      const src = snapshot.resources[ref]?.url ?? ref;
      if (src) items.push({ kind: 'image', key: event.projectionKey, src, event });
    }
  }
  return items;
}

function SharedSession({ snapshot }: { snapshot: ShareSnapshot }) {
  const { t } = useLingui();
  const root = useRef<HTMLElement>(null);
  const [manualPrinting, setManualPrinting] = useState(false);
  const activePrint = printMode || manualPrinting;

  const fonts = snapshot.appearance?.fonts;
  const fontSetup = useMemo(() => Promise.all([
    applyFont('--font-sans', fonts?.ui && { id: 'share-ui', ...fonts.ui }),
    applyFont('--font-mono', fonts?.mono && { id: 'share-mono', ...fonts.mono }),
  ]), [fonts?.ui, fonts?.mono]);

  useEffect(() => {
    const controller = new AbortController();
    if (!printMode) {
      void fontSetup;
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
  }, [snapshot, fontSetup, t]);

  useEffect(() => {
    if (!manualPrinting) return;
    document.documentElement.dataset.riffetPrint = '';
    const controller = new AbortController();
    const cleanup = () => {
      delete document.documentElement.dataset.riffetPrint;
      setManualPrinting(false);
    };
    window.addEventListener('afterprint', cleanup, { once: true });
    void (async () => {
      try {
        if (root.current) await preparePrint(root.current, controller.signal, fontSetup);
        if (!controller.signal.aborted) window.print();
      } catch {
        if (!controller.signal.aborted) cleanup();
      }
    })();
    return () => {
      controller.abort();
      window.removeEventListener('afterprint', cleanup);
      delete document.documentElement.dataset.riffetPrint;
    };
  }, [manualPrinting, fontSetup]);

  const startManualPrint = useCallback(() => {
    setManualPrinting(true);
  }, []);

  const background = snapshot.appearance?.background;
  const author = snapshot.author;
  const timeline = useMemo(() => buildShareTimeline(snapshot), [snapshot]);
  const assistantModels = useMemo(() => timeline
    .filter((item): item is Extract<TimelineItem, { kind: 'assistant' }> => item.kind === 'assistant')
    .flatMap(item => item.event.sourceEvents.map(source => {
      const nativeId = 'nativeId' in source && typeof source.nativeId === 'string' ? source.nativeId : undefined;
      return nativeId && snapshot.modelInfo && Object.hasOwn(snapshot.modelInfo, nativeId) ? snapshot.modelInfo[nativeId] : undefined;
    })), [timeline, snapshot.modelInfo]);
  const commonModel = assistantModels.length > 0 && assistantModels.every(model => model && shareModelKey(model) === shareModelKey(assistantModels[0]!))
    ? assistantModels[0]
    : undefined;
  const commonModelKey = commonModel ? shareModelKey(commonModel) : undefined;
  const transcriptResources = useMemo<TranscriptResources>(() => ({
    resources: snapshot.resources,
    blobs: snapshot.blobs,
    diagramPages: snapshot.diagramPages,
    ...(snapshot.contentPage ? { contentPage: snapshot.contentPage } : {}),
    ...(snapshot.modelInfo ? { modelInfo: snapshot.modelInfo } : {}),
    ...(commonModelKey ? { commonModelKey } : {}),
  }), [snapshot.resources, snapshot.blobs, snapshot.diagramPages, snapshot.contentPage, snapshot.modelInfo, commonModelKey]);

  const preview = document.querySelector('meta[name="riffet-share-preview"]')?.getAttribute('content') === 'true';
  const imageSource = useMemo(() => (path: string) => snapshot.resources[path]?.url, [snapshot]);
  const agentName = backendLabel(snapshot.backendId);
  const agentSummary = commonModel ? `${agentName} · ${shareModelLabel(commonModel)}` : agentName;
  const customSyntaxTheme = snapshot.appearance?.customTheme?.syntax ? { id: snapshot.appearance.customTheme.id, name: snapshot.appearance.customTheme.name } : undefined;
  const scopeLabel = snapshot.scope ? `${snapshot.scope.mode === 'recent' ? t`最近` : t`已选`} ${t`${snapshot.scope.turnCount} 轮`}` : undefined;

  const warningsNotice = snapshot.warnings.length > 0 ? (
    <Notice tone="warning" className="mb-6">
      <details open={activePrint || undefined} className="text-xs">
        <summary className="cursor-pointer font-medium text-fg-2"><Trans>部分内容未包含</Trans></summary>
        <ul className="mt-1.5 space-y-1 text-fg-3">
          {snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
        </ul>
      </details>
    </Notice>
  ) : undefined;

  const shareFooter = !activePrint ? (
    <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 edge-t pt-5 pb-4 text-xs text-fg-3">
      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 text-fg-2 transition-colors hover:text-fg"
      >
        <BrandMark className="size-4 shrink-0 text-fg" />
        <span className="font-semibold tracking-tight text-fg">Riffet</span>
        <span aria-hidden className="text-fg-4">·</span>
        <span className="text-fg-3"><Trans>只读会话快照</Trans></span>
      </a>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-fg-4"><Trans>仅含对话正文</Trans></span>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-fg-3 transition-colors hover:text-fg"
        >
          <GitHubMark className="size-3.5 shrink-0" />
          <span>GitHub</span>
          <IconExternalLink aria-hidden className="size-3 text-fg-4" />
        </a>
      </div>
    </footer>
  ) : null;

  return (
    <PrintRenderingContext.Provider value={activePrint}>
      <TranscriptResourcesContext.Provider value={transcriptResources}>
        <ImageSourceContext.Provider value={imageSource}>
          <main ref={root} className={`share-session relative flex h-dvh min-h-0 flex-col bg-bg text-fg${activePrint ? ' share-print' : ''}`}>
            {nativePrint && <style>{'@page { size: auto; margin: auto; }'}</style>}
            {background && !activePrint && <BackdropLayer url={background.url} opacity={background.opacity} fit={background.fit} />}
            <header className="share-session-header workbench-header flex min-h-12 shrink-0 items-center gap-2 edge-b bg-bg px-3 md:h-13 md:pl-4 md:pr-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {!activePrint && (
                  <Tip label={t`在 GitHub 上查看 Riffet`}>
                    <a
                      href={GITHUB_REPO_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Riffet"
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1 py-1 text-fg transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <BrandMark className="size-5 shrink-0" />
                      <span className="hidden text-sm font-semibold tracking-tight sm:inline">Riffet</span>
                    </a>
                  </Tip>
                )}
                {!activePrint && <span aria-hidden className="shrink-0 text-fg-4">/</span>}
                <h1 className="min-w-0 truncate text-sm font-medium text-fg" title={snapshot.title}>{snapshot.title}</h1>
                <div className="hidden shrink-0 items-center gap-2 pl-1 text-xs text-fg-3 md:flex">
                  <Tip label={agentSummary}>
                    <span className="inline-flex items-center gap-1.5" tabIndex={0}>
                      <AgentGlyph backend={snapshot.backendId} />
                      <span className="max-w-52 truncate">{agentSummary}</span>
                    </span>
                  </Tip>
                  {author && (
                    <span className="inline-flex items-center gap-1.5">
                      <OwnerAvatar owner={{ name: author.name, avatar: author.avatar ? { url: author.avatar } : undefined }} size={18} />
                      {author.name && <span className="max-w-32 truncate">{author.name}</span>}
                    </span>
                  )}
                  {scopeLabel && <span>{scopeLabel}</span>}
                  <time dateTime={snapshot.capturedAt} className="tabular-nums"><Trans>内容截至 {formatDateTime(snapshot.capturedAt)}</Trans></time>
                </div>
              </div>
              {!activePrint && (
                <div className="share-session-actions flex shrink-0 items-center gap-1">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="quiet" size="icon-sm" className="no-hover:size-11 md:hidden" aria-label={t`会话信息`}>
                        <IconInfoOutline />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" mobileSheet className="p-4">
                      <div className="flex flex-col gap-3 text-sm">
                        <div className="font-medium text-fg">{snapshot.title}</div>
                        <div className="flex flex-col gap-2 text-xs text-fg-3">
                          <div className="flex items-center gap-2">
                            <AgentGlyph backend={snapshot.backendId} />
                            <span className="text-fg-2">{agentSummary}</span>
                          </div>
                          {author && (
                            <div className="flex items-center gap-2">
                              <OwnerAvatar owner={{ name: author.name, avatar: author.avatar ? { url: author.avatar } : undefined }} size={18} />
                              <span className="text-fg-2">{author.name}</span>
                            </div>
                          )}
                          {scopeLabel && <div>{scopeLabel}</div>}
                          <time dateTime={snapshot.capturedAt} className="tabular-nums"><Trans>内容截至 {formatDateTime(snapshot.capturedAt)}</Trans></time>
                        </div>
                        <a
                          href={GITHUB_REPO_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 edge-t pt-2.5 text-xs text-fg-2 hover:text-fg"
                        >
                          <GitHubMark className="size-3.5 shrink-0" />
                          <span>riffable/riffet</span>
                          <IconExternalLink aria-hidden className="size-3 text-fg-4" />
                        </a>
                      </div>
                    </PopoverContent>
                  </Popover>
                  {!preview && (
                    <>
                      <Tip label={t`导出为 PDF`}>
                        <Button variant="quiet" size="icon-sm" className="no-hover:size-11" aria-label={t`导出为 PDF`} onClick={startManualPrint}>
                          <IconPrinter />
                        </Button>
                      </Tip>
                      <Tip label="GitHub">
                        <Button asChild variant="quiet" size="icon-sm" className="hidden sm:inline-flex">
                          <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub">
                            <GitHubMark />
                          </a>
                        </Button>
                      </Tip>
                      <ReaderAppearance customSyntaxTheme={customSyntaxTheme} />
                    </>
                  )}
                </div>
              )}
              {activePrint && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
                  {author && <span className="inline-flex items-center gap-1.5"><OwnerAvatar owner={{ name: author.name, avatar: author.avatar ? { url: author.avatar } : undefined }} size={18} />{author.name}</span>}
                  <span>{agentSummary}</span>
                  {scopeLabel && <span>{scopeLabel}</span>}
                  <time dateTime={snapshot.capturedAt} className="tabular-nums"><Trans>内容截至 {formatDateTime(snapshot.capturedAt)}</Trans></time>
                </div>
              )}
            </header>
            {activePrint ? (
              <div className="share-session-scroll min-h-0 flex-1 overflow-y-auto">
                <div className="share-session-content mx-auto flex w-full max-w-(--content-width) flex-col gap-8 px-3 pb-10 pt-6 sm:px-4 sm:pt-8 md:px-12">
                  {warningsNotice}
                  {timeline.map(item => {
                    if (item.kind === 'user') return <UserMessage key={item.key} text={item.text} attachments={item.attachments} time={item.event.createdAt} />;
                    if (item.kind === 'assistant') {
                      const models = item.event.sourceEvents
                        .map(source => ('nativeId' in source && typeof source.nativeId === 'string' && snapshot.modelInfo && Object.hasOwn(snapshot.modelInfo, source.nativeId) ? snapshot.modelInfo[source.nativeId] : undefined))
                        .filter((info): info is ShareModelInfo => Boolean(info));
                      const showModels = models.length > 0 && (!commonModelKey || models.some(info => shareModelKey(info) !== commonModelKey));
                      const label = showModels ? [...new Map(models.map(info => [shareModelKey(info), shareModelLabel(info)])).values()].join(' / ') : undefined;
                      return <AssistantMessage key={item.key} text={item.text} time={item.event.createdAt} modelLabel={label} showActions={false} />;
                    }
                    if (item.kind === 'image') {
                      const resource = snapshot.resources[item.src];
                      const src = resource?.url ?? item.src;
                      const name = resource?.name ?? t({ message: '图片', context: 'share-image-name' });
                      return <PrintImage key={item.key} src={src} name={name} />;
                    }
                    return null;
                  })}
                  {!timeline.length && <p className="py-12 text-sm text-fg-3"><Trans>这个会话没有消息。</Trans></p>}
                </div>
              </div>
            ) : (
              <TranscriptView
                sessionId={snapshot.nativeChatId ?? snapshot.capturedAt}
                timeline={timeline}
                loaded
                running={false}
                lead={warningsNotice}
                empty={<p className="py-12 text-center text-sm text-fg-3"><Trans>这个会话没有消息。</Trans></p>}
              >
                {shareFooter}
              </TranscriptView>
            )}
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
