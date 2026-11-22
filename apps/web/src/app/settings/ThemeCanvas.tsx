import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { DEFAULT_THEME_GRADIENT_BLEND, type ThemeSeed, type ThemeSeedPoint } from '@contracts';
import { IconMinus, IconPlus, IconRepeat } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tip } from '@/components/ui/tooltip';
import { addSeedPoint, nextHarmony, pointColor } from '@/lib/theme-seed';
import { cn } from '@/lib/utils';

/** The share of the canvas width between the centre and full colour. */
const REACH = 0.44;
/** A press this close to a point picks that point up instead of moving the surface point. */
const GRAB_PX = 24;

const WHEEL = [
  'radial-gradient(circle closest-side, oklch(0.74 0 0), oklch(0.74 0 0 / 0) 88%)',
  `conic-gradient(${Array.from({ length: 13 }, (_, index) => `oklch(0.74 0.15 ${index * 30})`).join(', ')})`,
].join(', ');

const DOTS = 'radial-gradient(circle, #000 1.2px, transparent 1.7px)';

type Preset = { name: MessageDescriptor; points: ThemeSeedPoint[] };

const PRESET_PAGES: { label: MessageDescriptor; presets: Preset[] }[] = [
  {
    label: msg`单色`,
    presets: [
      { name: msg`素`, points: [{ hue: 0, radius: 0 }] },
      { name: msg`纸张`, points: [{ hue: 75, radius: 0.45 }] },
      { name: msg`琥珀`, points: [{ hue: 45, radius: 0.72 }] },
      { name: msg`绯红`, points: [{ hue: 18, radius: 0.72 }] },
      { name: msg`蔷薇`, points: [{ hue: 345, radius: 0.68 }] },
      { name: msg`暮紫`, points: [{ hue: 295, radius: 0.68 }] },
      { name: msg`蔚蓝`, points: [{ hue: 240, radius: 0.72 }] },
      { name: msg`青苔`, points: [{ hue: 155, radius: 0.65 }] },
    ],
  },
  {
    label: msg`双色`,
    presets: [
      { name: msg`晴空`, points: [{ hue: 235, radius: 0.72 }, { hue: 280, radius: 0.78 }] },
      { name: msg`朝霞`, points: [{ hue: 48, radius: 0.75 }, { hue: 350, radius: 0.78 }] },
      { name: msg`苔原`, points: [{ hue: 145, radius: 0.62 }, { hue: 195, radius: 0.72 }] },
      { name: msg`晚风`, points: [{ hue: 205, radius: 0.72 }, { hue: 255, radius: 0.76 }] },
      { name: msg`绯樱`, points: [{ hue: 325, radius: 0.74 }, { hue: 20, radius: 0.76 }] },
      { name: msg`紫雾`, points: [{ hue: 275, radius: 0.74 }, { hue: 335, radius: 0.76 }] },
      { name: msg`柠檬`, points: [{ hue: 95, radius: 0.68 }, { hue: 155, radius: 0.7 }] },
      { name: msg`琥海`, points: [{ hue: 35, radius: 0.72 }, { hue: 225, radius: 0.74 }] },
    ],
  },
  {
    label: msg`三色`,
    presets: [
      { name: msg`暮光`, points: [{ hue: 265, radius: 0.8 }, { hue: 330, radius: 0.78 }, { hue: 215, radius: 0.76 }] },
      { name: msg`极光`, points: [{ hue: 165, radius: 0.72 }, { hue: 220, radius: 0.78 }, { hue: 290, radius: 0.74 }] },
      { name: msg`落日`, points: [{ hue: 55, radius: 0.76 }, { hue: 15, radius: 0.82 }, { hue: 315, radius: 0.74 }] },
      { name: msg`蜜桃`, points: [{ hue: 38, radius: 0.76 }, { hue: 355, radius: 0.78 }, { hue: 300, radius: 0.7 }] },
      { name: msg`霓虹`, points: [{ hue: 320, radius: 0.82 }, { hue: 245, radius: 0.8 }, { hue: 185, radius: 0.76 }] },
      { name: msg`春野`, points: [{ hue: 110, radius: 0.68 }, { hue: 170, radius: 0.72 }, { hue: 225, radius: 0.74 }] },
      { name: msg`深海`, points: [{ hue: 210, radius: 0.76 }, { hue: 175, radius: 0.74 }, { hue: 270, radius: 0.76 }] },
      { name: msg`星云`, points: [{ hue: 285, radius: 0.78 }, { hue: 20, radius: 0.76 }, { hue: 210, radius: 0.76 }] },
    ],
  },
];

function presetFill(points: readonly ThemeSeedPoint[]): string {
  const colors = points.map(pointColor);
  if (colors.length === 1) return colors[0]!;
  if (colors.length === 2) return `linear-gradient(135deg, ${colors[0]} 0%, ${colors[1]} 100%)`;
  return `radial-gradient(110% 110% at 88% 18%, ${colors[1]} 0%, ${colors[1]}00 72%), linear-gradient(135deg, ${colors[0]} 0%, ${colors[2]} 100%)`;
}

/**
 * Arc-style colour canvas. The angle around the centre is the hue and the distance from it is how
 * much colour: 1 point paints a solid frame, while 2 or 3 points blend into a canvas gradient whose
 * angle follows the points' layout. Moving the primary point rotates the rest with it so pairings
 * survive a change of hue.
 */
export function ThemeCanvas({ seed, onChange }: { seed: ThemeSeed; onChange: (seed: ThemeSeed) => void }) {
  const { t, i18n } = useLingui();
  const area = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  // Pointer events can outrun a render; the next move must build on the last one, not on props.
  const latest = useRef(seed);
  latest.current = seed;

  const commit = (next: ThemeSeed) => {
    latest.current = next;
    onChange(next);
  };

  const locate = (event: PointerEvent): ThemeSeedPoint & { x: number; y: number } => {
    const rect = area.current!.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    const hue = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
    return { hue, radius: Math.min(1, Math.hypot(x, y) / (rect.width * REACH)), x, y };
  };

  const move = (index: number, point: ThemeSeedPoint) => {
    const points = [...latest.current.points];
    const previous = points[index]!;
    const target = { hue: point.hue, radius: point.radius };
    if (index === 0) {
      for (let other = 1; other < points.length; other += 1) {
        points[other] = { ...points[other]!, hue: (points[other]!.hue + target.hue - previous.hue + 360) % 360 };
      }
    }
    points[index] = target;
    commit({ ...latest.current, points });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-canvas-control]')) return;
    const at = locate(event);
    const width = area.current!.getBoundingClientRect().width;
    const offset = (point: ThemeSeedPoint) => {
      const angle = (point.hue * Math.PI) / 180;
      const reach = point.radius * width * REACH;
      return Math.hypot(at.x - reach * Math.sin(angle), at.y + reach * Math.cos(angle));
    };
    const near = latest.current.points
      .map((point, index) => ({ index, distance: offset(point) }))
      .filter((entry) => entry.distance <= GRAB_PX)
      .sort((a, b) => a.distance - b.distance)[0];
    const index = near?.index ?? 0;
    dragging.current = index;
    event.currentTarget.setPointerCapture(event.pointerId);
    (event.currentTarget.querySelector(`[data-point="${index}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
    move(index, at);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== null) move(dragging.current, locate(event));
  };

  const release = () => { dragging.current = null; };

  const onKey = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const point = latest.current.points[index]!;
    const step = event.shiftKey ? 15 : 3;
    const nudge: Record<string, ThemeSeedPoint> = {
      ArrowLeft: { ...point, hue: (point.hue - step + 360) % 360 },
      ArrowRight: { ...point, hue: (point.hue + step) % 360 },
      ArrowUp: { ...point, radius: Math.min(1, point.radius + step / 100) },
      ArrowDown: { ...point, radius: Math.max(0, point.radius - step / 100) },
    };
    const next = nudge[event.key];
    if (!next) return;
    event.preventDefault();
    move(index, next);
  };

  const count = seed.points.length;
  const railRef = useRef<HTMLDivElement>(null);
  const initialPage = Math.min(2, Math.max(0, count - 1));
  const [presetPage, setPresetPage] = useState(initialPage);
  const syncedCount = useRef(count);

  const scrollToPage = (index: number, behavior?: ScrollBehavior) => {
    setPresetPage(index);
    const rail = railRef.current;
    if (!rail) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rail.scrollTo({ left: index * rail.clientWidth, behavior: behavior ?? (reduced ? 'instant' : 'smooth') });
  };

  // Land on the matching preset page on mount and follow point-count changes (+/- on the wheel).
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollTo({ left: initialPage * rail.clientWidth, behavior: 'instant' });
  }, []);

  useEffect(() => {
    if (syncedCount.current === count) return;
    syncedCount.current = count;
    scrollToPage(Math.min(2, Math.max(0, count - 1)));
  }, [count]);

  const onRailScroll = () => {
    const rail = railRef.current;
    if (!rail || rail.clientWidth <= 0) return;
    const next = Math.min(PRESET_PAGES.length - 1, Math.max(0, Math.round(rail.scrollLeft / rail.clientWidth)));
    if (next !== presetPage) setPresetPage(next);
  };

  const roleOf = (index: number) => [t`颜色 1`, t`颜色 2`, t`颜色 3`][index]!;
  const removeLabel = t`移除颜色`;
  const addLabel = t`添加颜色`;

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={area}
        className="relative aspect-square touch-none select-none overflow-hidden rounded-xl border border-line bg-subtle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <div
          aria-hidden
          className="absolute inset-0"
          style={{ backgroundImage: WHEEL, maskImage: DOTS, maskSize: '11px 11px', maskPosition: 'center', WebkitMaskImage: DOTS, WebkitMaskSize: '11px 11px', WebkitMaskPosition: 'center' }}
        />
        {seed.points.map((point, index) => {
          const angle = (point.hue * Math.PI) / 180;
          const reach = point.radius * REACH * 100;
          return (
            <button
              key={index}
              type="button"
              data-point={index}
              aria-label={roleOf(index)}
              onKeyDown={onKey(index)}
              className={cn(
                'absolute -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-white shadow-[0_1px_4px_rgb(0_0_0/0.25)] outline-none focus-visible:ring-2 focus-visible:ring-focus active:cursor-grabbing',
                index === 0 ? 'size-8 border-[3px]' : 'size-6 border-[2.5px]',
              )}
              style={{
                left: `${50 + reach * Math.sin(angle)}%`,
                top: `${50 - reach * Math.cos(angle)}%`,
                backgroundColor: pointColor(point),
              }}
            />
          );
        })}
        <div data-canvas-control className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-0.5 rounded-lg bg-elevated p-0.5 shadow-soft">
          <Tip label={removeLabel}>
            <Button size="icon-xs" variant="quiet" aria-label={removeLabel} disabled={count === 1} onClick={() => commit({ ...seed, points: seed.points.slice(0, -1) })}><IconMinus /></Button>
          </Tip>
          {count > 1 && (
            <Tip label={t`换一种搭配`}>
              <Button size="icon-xs" variant="quiet" aria-label={t`换一种搭配`} onClick={() => commit(nextHarmony(seed))}><IconRepeat /></Button>
            </Tip>
          )}
          <Tip label={addLabel}>
            <Button size="icon-xs" variant="quiet" aria-label={addLabel} disabled={count === 3} onClick={() => commit(addSeedPoint(seed))}><IconPlus /></Button>
          </Tip>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div
          ref={railRef}
          onScroll={onRailScroll}
          className="flex snap-x snap-mandatory overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {PRESET_PAGES.map((page, pageIndex) => (
            <div key={pageIndex} className="flex w-full shrink-0 snap-start items-center justify-between gap-1 px-0.5">
              {page.presets.map((preset) => {
                const name = i18n._(preset.name);
                return (
                  <Tip key={name} label={name}>
                    <button
                      type="button"
                      aria-label={name}
                      onClick={() => commit({
                        ...seed,
                        points: preset.points,
                        ...(preset.points.length > 1 ? { blend: seed.blend ?? DEFAULT_THEME_GRADIENT_BLEND } : {}),
                      })}
                      className="size-6 shrink-0 rounded-full border border-line outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus"
                      style={{ background: presetFill(preset.points) }}
                    />
                  </Tip>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-center gap-1.5">
          {PRESET_PAGES.map((page, index) => {
            const label = i18n._(page.label);
            const active = presetPage === index;
            return (
              <Tip key={label} label={label}>
                <button
                  type="button"
                  aria-label={label}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => scrollToPage(index)}
                  className={cn(
                    'h-1.5 rounded-full transition-all outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    active ? 'w-3.5 bg-fg-3' : 'w-1.5 bg-fg-4/50 hover:bg-fg-3',
                  )}
                />
              </Tip>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <span className="w-10 shrink-0 text-2xs text-fg-3">{t`柔和度`}</span>
          <Slider
            className="min-w-0 flex-1"
            min={0}
            max={1}
            step={0.01}
            value={seed.softness}
            aria-label={t`柔和度`}
            onValueChange={(softness) => commit({ ...seed, softness })}
          />
        </div>
        {count > 1 && (
          <div className="flex items-center gap-2.5">
            <span className="w-10 shrink-0 text-2xs text-fg-3">{t`透底`}</span>
            <Slider
              className="min-w-0 flex-1"
              min={0}
              max={1}
              step={0.01}
              value={seed.blend ?? DEFAULT_THEME_GRADIENT_BLEND}
              aria-label={t`透底`}
              onValueChange={(blend) => commit({ ...seed, blend })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
