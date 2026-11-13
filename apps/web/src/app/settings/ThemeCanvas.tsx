import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { ThemeSeed, ThemeSeedPoint } from '@contracts';
import { IconMinus, IconPlus, IconRepeat } from '@/components/icons';
import { Button } from '@/components/ui/button';
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

const PRESETS: { name: MessageDescriptor; points: ThemeSeedPoint[] }[] = [
  { name: msg`石墨`, points: [{ hue: 258, radius: 0.13 }, { hue: 265, radius: 0.96 }] },
  { name: msg`纸张`, points: [{ hue: 80, radius: 0.45 }, { hue: 45, radius: 0.75 }] },
  { name: msg`沙丘`, points: [{ hue: 65, radius: 0.5 }, { hue: 200, radius: 0.6 }] },
  { name: msg`苔藓`, points: [{ hue: 140, radius: 0.35 }, { hue: 150, radius: 0.6 }] },
  { name: msg`海`, points: [{ hue: 230, radius: 0.4 }, { hue: 235, radius: 0.8 }] },
  { name: msg`暮色`, points: [{ hue: 300, radius: 0.35 }, { hue: 290, radius: 0.7 }] },
  { name: msg`玫瑰`, points: [{ hue: 10, radius: 0.35 }, { hue: 15, radius: 0.8 }] },
  { name: msg`素`, points: [{ hue: 0, radius: 0 }, { hue: 0, radius: 0 }] },
];

/**
 * Arc-style colour canvas. The angle around the centre is the hue and the distance from it is how
 * much colour: the first point tints the surfaces, the optional second one is the accent and the
 * third the sidebar. Moving the surface point carries the others round with it, so a pairing
 * survives a change of hue.
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
  const roleOf = (index: number) => [t`底色`, t`强调色`, t`侧栏色`][index]!;
  const removeLabel = count === 3 ? t`移除侧栏色` : t`移除强调色`;
  const addLabel = count === 1 ? t`添加强调色` : t`添加侧栏色`;

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

      <div className="flex items-center justify-between gap-1">
        {PRESETS.map((preset) => {
          const name = i18n._(preset.name);
          const [surface, tint] = preset.points.map(pointColor);
          return (
            <Tip key={name} label={name}>
              <button
                type="button"
                aria-label={name}
                onClick={() => commit({ ...seed, points: preset.points })}
                className="size-6 shrink-0 rounded-full border border-line outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus"
                style={{ background: `linear-gradient(135deg, ${surface} 50%, ${tint} 50%)` }}
              />
            </Tip>
          );
        })}
      </div>

      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={seed.softness}
        aria-label={t`柔和度`}
        className="w-full accent-[var(--accent)]"
        onChange={(event) => commit({ ...seed, softness: Number(event.target.value) })}
      />
    </div>
  );
}
