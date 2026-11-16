import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { boundedCache } from '@/lib/bounded-cache';
import { useTheme } from '@/lib/theme';
import { newId } from '@/lib/utils';
import { fitWidth, ImageViewer, type PixelSize } from './ImageViewer';
import { useTranscriptResources } from './transcriptResources';
import { PrintImage, PrintRenderingContext } from './printRendering';
import { registerBounded } from '@/lib/cache-registry';

interface Request { key: string; id: string; url: string }
interface Result { key: string; image?: string; size?: PixelSize }

/**
 * Rendered graphs by the key a result is pinned to, so a row the transcript window unmounts and
 * mounts again shows its graph at once instead of rebuilding the frame. The cache owns the object
 * URLs; bounded by count and by total SVG length. An evicted URL a mounted graph still shows is
 * revoked only once nothing shows it, since the viewer opens it again to zoom or save.
 */
const imageUsers = new Map<string, number>();
const evictedInUse = new Set<string>();
const imageCache = boundedCache<string, { image: string; size: number; pixels?: PixelSize }>({
  limit: 32,
  maxWeight: 16_000_000,
  weigh: (_, entry) => entry.size,
  onEvict: (_, { image }) => { if (imageUsers.has(image)) evictedInUse.add(image); else URL.revokeObjectURL(image); },
});
registerBounded('mermaid-images', { get size() { return imageCache.size; }, get weight() { return imageCache.weight; }, clear: () => imageCache.clear() }, 32, 16_000_000);

function useImage(image: string | undefined) {
  useEffect(() => {
    if (!image) return;
    imageUsers.set(image, (imageUsers.get(image) ?? 0) + 1);
    return () => {
      const users = (imageUsers.get(image) ?? 1) - 1;
      if (users) { imageUsers.set(image, users); return; }
      imageUsers.delete(image);
      if (evictedInUse.delete(image)) URL.revokeObjectURL(image);
    };
  }, [image]);
}

/**
 * Graph sizes by source, which outlive the images: a graph whose image was evicted (or that a theme
 * change is re-rendering) holds its box while it renders again instead of showing the source.
 */
const graphSizes = boundedCache<string, PixelSize>({ limit: 500, maxWeight: 4_000_000, weigh: (key) => key.length });
registerBounded('mermaid-graph-sizes', graphSizes, 500, 4_000_000);

/** The pixel size the render page writes on the root `<svg>`, which is the image's own size. */
function svgSize(svg: string): PixelSize | undefined {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const width = Number.parseFloat(/\swidth="([\d.]+)"/.exec(root)?.[1] ?? '');
  const height = Number.parseFloat(/\sheight="([\d.]+)"/.exec(root)?.[1] ?? '');
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Caches a fresh render and returns what to show: an earlier one for the same key wins, since it may be on screen. */
function rememberImage(key: string, sizeKey: string, svg: string): { image: string; size?: PixelSize } {
  const previous = imageCache.get(key);
  if (previous) return { image: previous.image, ...(previous.pixels ? { size: previous.pixels } : {}) };
  const image = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const pixels = svgSize(svg);
  imageCache.set(key, { image, size: svg.length, ...(pixels ? { pixels } : {}) });
  if (pixels) graphSizes.set(sizeKey, pixels);
  return { image, ...(pixels ? { size: pixels } : {}) };
}

/** Render in an opaque frame, then keep only an inert SVG image and the existing image viewer. */
export default function MermaidDiagram({ code, fallback, language = 'mermaid' }: { code: string; fallback: ReactNode; language?: string }) {
  const { t } = useLingui();
  const printing = useContext(PrintRenderingContext);
  const { resolved, themeId, revision } = useTheme();
  const resources = useTranscriptResources();
  const page = resources ? resources.diagramPages[language] : language === 'mermaid' ? '/mermaid' : `/diagram?engine=${encodeURIComponent(language)}`;
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [request, setRequest] = useState<Request>();
  const [result, setResult] = useState<Result>();
  const key = useMemo(() => JSON.stringify([code, language, resolved, themeId, revision]), [code, language, resolved, themeId, revision]);
  const sizeKey = useMemo(() => JSON.stringify([code, language]), [code, language]);
  const cachedEntry = useMemo(() => imageCache.get(key), [key]);
  const cached = cachedEntry?.image;

  useEffect(() => {
    if (!page || cached) return;
    // Streaming answers may rewrite a fence on every frame. Never show an older graph for new text.
    const timer = window.setTimeout(() => {
      const styles = getComputedStyle(root.current ?? document.documentElement);
      const id = newId();
      const params = new URLSearchParams({ source: code, language, scheme: resolved, id, fontSize: '14' });
      for (const [name, token] of [['color', '--fg'], ['background', '--bg-subtle'], ['line', '--fg-3'], ['accent', '--accent']]) {
        params.set(name, styles.getPropertyValue(token).trim());
      }
      setRequest({ key, id, url: `${page}#${params}` });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [code, language, key, resolved, page, cached]);

  useEffect(() => {
    if (!request) return;
    let settled = false;
    const failed = () => { settled = true; setResult({ key: request.key }); };
    const timer = window.setTimeout(failed, language === 'mermaid' ? 12_000 : 30_000);
    const receive = (event: MessageEvent) => {
      if (settled || event.source !== frame.current?.contentWindow) return;
      const value: unknown = event.data;
      if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'riffet-mermaid'
        || !('id' in value) || value.id !== request.id || !('status' in value)) return;
      window.clearTimeout(timer);
      if (value.status !== 'ready' || !('svg' in value) || typeof value.svg !== 'string' || value.svg.length > 10_000_000) { failed(); return; }
      settled = true;
      setResult({ key: request.key, ...rememberImage(request.key, sizeKey, value.svg) });
    };
    window.addEventListener('message', receive);
    return () => {
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
  }, [request, language, sizeKey]);

  const fresh = result?.key === key ? result : undefined;
  const image = fresh ? fresh.image : cached;
  const size = (fresh ? fresh.size : cachedEntry?.pixels) ?? (fresh ? undefined : graphSizes.get(sizeKey));
  useImage(image);
  return (
    <div ref={root} data-print-pending={printing && page && !fresh && !cached ? '' : undefined} className="relative share-diagram">
      {image ? (
        <div className="px-3.5 py-3">
          {printing ? <PrintImage key={image} src={image} name={`${language}.svg`} /> : <ImageViewer src={image} name={`${language}.svg`}>
            <button type="button" aria-label={t`预览图片`} className="block max-w-full cursor-zoom-in">
              <img
                src={image}
                alt={t`${language} 图表`}
                className="block h-auto max-h-[28rem] max-w-full object-contain"
                {...(size ? { width: size.width, height: size.height, style: { width: fitWidth(size, 448) } } : {})}
                onError={() => setResult({ key })}
              />
            </button>
          </ImageViewer>}
        </div>
      ) : size ? (
        <div className="px-3.5 py-3">
          <div aria-hidden className="max-w-full" style={{ width: fitWidth(size, 448), aspectRatio: `${size.width} / ${size.height}` }} />
        </div>
      ) : <>{printing && (fresh || !page) && <p className="share-print-missing">{t`图表无法渲染，已保留源码`}</p>}{fallback}</>}
      {!cached && request?.key === key && result?.key !== key && (
        <iframe
          key={request.id}
          ref={frame}
          title={language}
          aria-hidden="true"
          tabIndex={-1}
          src={request.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onError={() => setResult({ key: request.key })}
          className="pointer-events-none absolute inset-x-0 top-0 h-px w-full border-0 opacity-0"
        />
      )}
    </div>
  );
}
