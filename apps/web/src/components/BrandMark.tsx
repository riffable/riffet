import { useEffect, useId, useRef, useState, type ReactNode, type SVGProps } from 'react';
import { cn } from '@/lib/utils';
import { APP_ICON_TILE, BRAND_BODY, BRAND_EYE, BRAND_MANE, BRAND_TEETH, BRAND_TILE_TRANSFORM, BRAND_VIEWBOX } from '@/lib/app-icon';

/**
 * The Riffet mark: a solid horse head in `currentColor` with the eye cut out, over a three-tooth
 * mane in the theme accent. `scripts/gen-brand.ts` draws the favicon and app icons from the same
 * geometry.
 */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox={BRAND_VIEWBOX} strokeLinejoin="round" {...props}>
      <path d={BRAND_MANE} strokeWidth=".6" className="fill-accent stroke-accent" />
      <path d={`${BRAND_BODY}${BRAND_EYE}`} fill="currentColor" fillRule="evenodd" />
      <path d={BRAND_BODY} fill="none" stroke="currentColor" />
    </svg>
  );
}

/** Monochrome GitHub Octicon mark, inheriting `currentColor` from its parent. */
export function GitHubMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 1.27a11 11 0 0 0-3.48 21.46c.55.09.73-.24.73-.53v-1.85c-3.03.66-3.67-1.45-3.67-1.45-.5-1.26-1.21-1.6-1.21-1.6-.99-.68.07-.67.07-.67 1.09.08 1.67 1.13 1.67 1.13.97 1.66 2.54 1.18 3.16.9.1-.7.38-1.18.69-1.45-2.42-.27-4.96-1.21-4.96-5.38 0-1.19.42-2.16 1.12-2.92-.11-.28-.49-1.39.11-2.89 0 0 .92-.29 3 1.12a10.4 10.4 0 0 1 5.46 0c2.08-1.41 3-1.12 3-1.12.6 1.5.22 2.61.11 2.89.7.76 1.12 1.73 1.12 2.92 0 4.18-2.55 5.1-4.98 5.37.39.34.74 1.01.74 2.04v3.02c0 .29.19.63.74.52A11 11 0 0 0 12 1.27Z" />
    </svg>
  );
}

/** The app icon as a picker shows it: the mark on the dark tile, the mane in `accent`. */
export function AppIconTile({ accent, ...props }: SVGProps<SVGSVGElement> & { accent: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" {...props}>
      <rect width="32" height="32" rx="8" fill={APP_ICON_TILE.tile} />
      <g transform={BRAND_TILE_TRANSFORM} strokeLinejoin="round">
        <path d={BRAND_MANE} fill={accent} stroke={accent} strokeWidth=".6" />
        <path d={`${BRAND_BODY}${BRAND_EYE}`} fill={APP_ICON_TILE.front} fillRule="evenodd" />
        <path d={BRAND_BODY} fill="none" stroke={APP_ICON_TILE.front} />
      </g>
    </svg>
  );
}

const LIVE_STYLES = ['mane', 'mood', 'beat', 'draw', 'run', 'gaze'] as const;
type LiveStyle = (typeof LIVE_STYLES)[number];
const pickLiveStyle = (except?: LiveStyle) => {
  const pool = LIVE_STYLES.filter((style) => style !== except);
  return pool[Math.floor(Math.random() * pool.length)]!;
};
const LIVE_EAR = 'M8.8 5.8L9.4 2.6L11.2 5.4L10.6 7.2L9.2 7.2Z';

/** A part that moves about (x, y): the keyframes in `index.css` address it as `[data-part]` with the default origin. */
function LivePart({ x, y, part, children }: { x: number; y: number; part: string; children: ReactNode }) {
  return <g transform={`translate(${x} ${y})`}><g data-part={part}><g transform={`translate(${-x} ${-y})`}>{children}</g></g></g>;
}

/**
 * The mark as a living logo: it plays one of six loops, a random one each time it appears, and a
 * click swaps it for another. With `fixed` it keeps that one loop and takes no clicks: a loading
 * screen shows it running. Decoration only; it reports nothing else.
 */
export function LiveBrandMark({ fixed, ...props }: SVGProps<SVGSVGElement> & { fixed?: LiveStyle }) {
  const [picked, setStyle] = useState(pickLiveStyle);
  const style = fixed ?? picked;
  const svgRef = useRef<SVGSVGElement>(null);
  const lookRef = useRef<SVGGElement>(null);
  const maskId = useId();

  // In `gaze` the eye follows the pointer, and goes back to looking around by itself once the pointer rests.
  useEffect(() => {
    const svg = svgRef.current;
    const look = lookRef.current;
    if (style !== 'gaze' || !svg || !look || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0, rest = 0, x = 0, y = 0, pointerX = 0, pointerY = 0, tracking = false;
    const step = () => {
      let targetX = 0, targetY = 0;
      if (tracking) {
        const box = svg.getBoundingClientRect();
        const unit = box.width / 24;
        const dx = pointerX - (box.left + 11.9 * unit), dy = pointerY - (box.top + 8.4 * unit);
        const distance = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, distance / 140) * 0.6;
        targetX = dx / distance * reach; targetY = dy / distance * reach;
      }
      x += (targetX - x) * 0.16; y += (targetY - y) * 0.16;
      const settled = !tracking && Math.abs(x) + Math.abs(y) < 0.005;
      look.setAttribute('transform', settled ? '' : `translate(${x.toFixed(3)} ${y.toFixed(3)})`);
      frame = settled ? 0 : requestAnimationFrame(step);
    };
    const release = () => { tracking = false; delete svg.dataset.tracking; };
    const onMove = (event: PointerEvent) => {
      pointerX = event.clientX; pointerY = event.clientY; tracking = true; svg.dataset.tracking = '';
      window.clearTimeout(rest); rest = window.setTimeout(release, 4000);
      if (!frame) frame = requestAnimationFrame(step);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.clearTimeout(rest); cancelAnimationFrame(frame);
      release(); look.removeAttribute('transform');
    };
  }, [style]);

  const swap = () => {
    setStyle((current) => pickLiveStyle(current));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    svgRef.current?.animate(
      [{ transform: 'scale(.86) rotate(-4deg)' }, { transform: 'scale(1.07) rotate(2deg)', offset: 0.55 }, { transform: 'none' }],
      { duration: 360, easing: 'cubic-bezier(.2,.8,.3,1)' },
    );
  };

  return (
    <svg ref={svgRef} aria-hidden="true" viewBox={BRAND_VIEWBOX} strokeLinejoin="round" overflow="visible" {...props} className={cn('brand-live', !fixed && 'cursor-pointer', props.className)} data-style={style} onClick={fixed ? undefined : swap}>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32">
        <rect x="-4" y="-4" width="32" height="32" fill="#fff" />
        <LivePart x={12.5} y={8.2} part="eye"><g ref={lookRef}><circle cx="12.5" cy="8.2" r="1" /></g></LivePart>
      </mask>
      <g className="stroke-accent" strokeWidth=".7" strokeLinecap="round">
        <path data-part="speed" d="M1 9h3.2" /><path data-part="speed" d="M0 13.5h4" /><path data-part="speed" d="M2 17.5h2.6" />
      </g>
      <LivePart x={9} y={21} part="whole">
        {BRAND_TEETH.map(([d, x, y]) => <LivePart key={d} x={x} y={y} part="tooth"><path d={d} strokeWidth=".6" className="fill-accent stroke-accent" /></LivePart>)}
        <g mask={`url(#${maskId})`} fill="currentColor" stroke="currentColor">
          <path data-part="head" pathLength={1} d={BRAND_BODY} />
          <LivePart x={10} y={5.9} part="ear"><path d={LIVE_EAR} /></LivePart>
        </g>
      </LivePart>
    </svg>
  );
}
