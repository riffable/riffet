import { useEffect, useRef } from 'react';
import { MAC_MOTION, MOBILE_EASING, MOBILE_SHARED_MOTION, MOTION_DURATION, MOTION_EASING } from '@contracts';
import { cn } from '@/lib/utils';
import { reducedMotion, Reveal, useInView } from '../specimen';

const bezier = (points: readonly number[]) => `cubic-bezier(${points.join(', ')})`;
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
/** SwiftUI's spring response for a Compose stiffness, as `gen:tokens` converts it. */
const response = (stiffness: number) => Math.round((2 * Math.PI / Math.sqrt(stiffness)) * 100) / 100;

/** Source lines and the lines `gen:tokens` writes from them, computed from the same constants. */
function useTargets() {
  const mac = (tier: 'fast' | 'standard') => `static let ${tier} = Animation.${MAC_MOTION[tier].spring}(duration: ${MOTION_DURATION[MAC_MOTION[tier].duration] / 1000})`;
  return {
    sources: [
      { file: 'design-tokens.ts', lines: [`standard: [${MOTION_EASING.standard.join(', ')}],`, `fast: ${MOTION_DURATION.fast},`, `spring: '${MAC_MOTION.fast.spring}', duration: 'fast',`] },
      { file: 'mobile-styles.ts', lines: [`standard: [${MOBILE_EASING.standard.join(', ')}],`, `spatialStiffness: ${MOBILE_SHARED_MOTION.spatialStiffness},`, `spatialDamping: ${MOBILE_SHARED_MOTION.spatialDamping},`] },
    ],
    targets: [
      { platform: 'Web', path: 'apps/web/src/styles/index.css', lines: [`--ease-standard: ${bezier(MOTION_EASING.standard)};`, `--duration-${kebab('fast')}: ${MOTION_DURATION.fast}ms;`] },
      { platform: 'macOS', path: 'apps/macos/Riffet/Theme/Controls.swift', lines: [mac('fast'), mac('standard')] },
      { platform: 'Android', path: 'apps/mobile/shared/…/MobileStyles.generated.kt', lines: [`val StandardMotionEasing = CubicBezierEasing(${MOBILE_EASING.standard.map((n) => `${n}f`).join(', ')})`] },
      { platform: 'iOS', path: 'apps/mobile/iosApp/Riffet/Design/RiffetDesign.swift', lines: [`static let spatial = Animation.spring(response: ${response(MOBILE_SHARED_MOTION.spatialStiffness)}, dampingFraction: ${MOBILE_SHARED_MOTION.spatialDamping})`] },
    ],
  };
}

/** Where each target card's middle falls in the connector column, % of its height. */
const TARGET_AT = [12.5, 37.5, 62.5, 87.5];
const FORK = 34;

/** The connectors from the generator to the four targets, a pulse running down each. */
function Connectors({ running }: { running: boolean }) {
  const pulses = useRef<SVGPathElement[]>([]);
  useEffect(() => {
    if (!running || reducedMotion()) return;
    // motion-loop: the pulse along each connector, only while the figure is on screen
    const runs = pulses.current.map((path, index) => path.animate([{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { duration: 2000, delay: index * 220, iterations: Infinity, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }));
    return () => runs.forEach((run) => run.cancel());
  }, [running]);
  const path = (y: number) => `M 0 50 L ${FORK} 50 C ${FORK + 30} 50, ${FORK + 22} ${y}, 100 ${y}`;
  return (
    <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-y-0 -left-6 -right-6 h-full w-[calc(100%+3rem)] overflow-visible">
      {TARGET_AT.map((y) => <path key={y} d={path(y)} fill="none" stroke="var(--paper)" strokeOpacity="0.22" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
      {TARGET_AT.map((y, index) => (
        <path
          key={`pulse-${y}`}
          ref={(element) => { if (element) pulses.current[index] = element; }}
          d={path(y)}
          pathLength={100}
          fill="none"
          stroke="var(--paper)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="16 84"
          strokeDashoffset={100}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/** A file's lines set on the ink: its name, then the code. */
function Listing({ title, caption, lines, className }: { title: string; caption?: string; lines: string[]; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2.5 rounded-xl border border-(--paper)/15 bg-(--paper)/[0.05] px-4 py-3.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-(--paper)">{title}</span>
        {caption && <span className="min-w-0 truncate font-mono text-2xs text-(--paper)/45">{caption}</span>}
      </div>
      <div className="flex flex-col gap-0.5 font-mono text-xs text-(--paper)/80">
        {lines.map((line) => <span key={line} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{line}</span>)}
      </div>
    </div>
  );
}

/** One definition, four platforms: the source constants, the generator and what it writes. Drawn on its own ink ground. */
export function Pipeline() {
  const { sources, targets } = useTargets();
  const [figure, running] = useInView<HTMLDivElement>({ margin: '0px' });
  return (
    <Reveal>
      <div className="overflow-hidden rounded-2xl bg-(--ink) p-8 text-(--paper) [--ink:var(--fg)] [--paper:var(--bg)] dark:[--ink:color-mix(in_srgb,var(--bg)_55%,black)] dark:[--paper:var(--fg)] max-md:p-4">
        <div ref={figure} className="grid items-center gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(120px,0.4fr)_minmax(0,1.5fr)]">
          <div className="flex flex-col gap-3">
            <span className="font-mono text-2xs text-(--paper)/45">packages/contracts/src/</span>
            {sources.map((source) => <Listing key={source.file} title={source.file} lines={source.lines} />)}
          </div>
          <div className="relative h-full min-h-24 max-lg:hidden">
            <Connectors running={running} />
            <span className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-(--paper) px-3 py-1 font-mono text-2xs text-(--ink)" style={{ left: `calc(${FORK / 100} * (100% + 3rem) - 1.5rem)` }}>gen:tokens</span>
          </div>
          <div className="grid grid-rows-4 gap-3">
            {targets.map((target) => <Listing key={target.platform} title={target.platform} caption={target.path} lines={target.lines} />)}
          </div>
        </div>
      </div>
    </Reveal>
  );
}
