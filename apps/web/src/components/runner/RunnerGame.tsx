import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn, readStored, writeStored } from '@/lib/utils';
import { startRunner, type RunnerDriver } from './driver';
import type { RunnerColors, RunnerPhase } from './engine';

const BEST_KEY = 'riffet.runner-best';
const pad = (value: number) => String(value).padStart(5, '0');
const isJump = (code: string) => code === 'Space' || code === 'ArrowUp' || code === 'KeyW';
const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName));

function readColors(element: Element): RunnerColors {
  const style = getComputedStyle(element);
  const role = (name: string) => style.getPropertyValue(name).trim();
  return { ink: role('--fg'), mane: role('--accent'), line: role('--line-strong') || role('--line'), muted: role('--fg-3'), faint: role('--fg-4') };
}

/**
 * 黑马跑酷 in a strip: Space, ↑ or a tap jumps, holding goes higher. Without `globalKeys` it plays
 * only while it has focus and pauses when focus leaves, so the composer next to it keeps its keys.
 */
export function RunnerGame({ className, height = 200, globalKeys, hold, finished = 0, onClose }: {
  className?: string;
  height?: number;
  /** Keys anywhere outside a field play: for a page with nothing else to type into. */
  globalKeys?: boolean;
  /** The agent is waiting for an answer: the run stops and does not restart until this clears. */
  hold?: boolean;
  /** Raised when the agent's turn ends: a finish post comes up ahead. */
  finished?: number;
  onClose?: () => void;
}) {
  const { t } = useLingui();
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<RunnerDriver | null>(null);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const [phase, setPhase] = useState<RunnerPhase>('ready');
  const [best, setBest] = useState(() => Number(readStored(BEST_KEY)) || 0);
  const [coarse] = useState(() => window.matchMedia('(pointer: coarse)').matches);

  useEffect(() => {
    const wrap = wrapRef.current, stage = stageRef.current;
    if (!wrap || !stage) return;
    // The canvas is made here, not rendered: one handed to a worker cannot be handed over twice.
    const engine = startRunner(stage, readColors(wrap), (report) => {
      if (report.type === 'score') { if (scoreRef.current) scoreRef.current.textContent = pad(report.score); return; }
      setPhase(report.phase);
      if (report.phase === 'over' || report.phase === 'done') {
        setBest((current) => {
          if (report.score <= current) return current;
          writeStored(BEST_KEY, String(report.score));
          return report.score;
        });
      }
    });
    engineRef.current = engine;
    const resize = new ResizeObserver(() => engine.resize(stage.clientWidth, stage.clientHeight));
    resize.observe(stage);
    // Theme, palette and light/dark all land on the root element's class and style.
    const theme = new MutationObserver(() => engine.setColors(readColors(wrap)));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-style'] });
    const hidden = () => { if (document.hidden) engine.pause(); };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      resize.disconnect();
      theme.disconnect();
      document.removeEventListener('visibilitychange', hidden);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => { if (hold) engineRef.current?.pause(); }, [hold]);
  const seenFinish = useRef(finished);
  useEffect(() => {
    if (finished === seenFinish.current) return;
    seenFinish.current = finished;
    engineRef.current?.finish();
  }, [finished]);

  const press = (timeStamp: number) => {
    if (holdRef.current) return;
    engineRef.current?.press(timeStamp);
  };
  const release = () => engineRef.current?.release();

  useEffect(() => {
    if (!globalKeys) return;
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || !isJump(event.code) || editable(event.target)) return;
      event.preventDefault();
      if (!event.repeat) press(event.timeStamp);
    };
    const up = (event: globalThis.KeyboardEvent) => { if (isJump(event.code)) release(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [globalKeys]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape' && onClose) { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (globalKeys || !isJump(event.code) || event.target !== event.currentTarget) return;
    event.preventDefault();
    if (!event.repeat) press(event.timeStamp);
  };

  const hint = hold ? ''
    : phase === 'ready' ? (coarse ? t`轻点开始` : t`空格开始`)
    : phase === 'paused' ? (coarse ? t`轻点继续` : t`空格继续`)
    : phase === 'over' || phase === 'done' ? (coarse ? t`轻点再来` : t`空格再来`)
    : '';
  const resting = phase === 'ready' || phase === 'over' || phase === 'done';

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      data-runner
      role="application"
      aria-label={t`黑马跑酷`}
      className={cn('relative w-full select-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus', hold && 'opacity-40', className)}
      style={{ height }}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => { if (isJump(event.code)) release(); }}
      onBlur={(event) => { if (!globalKeys && !event.currentTarget.contains(event.relatedTarget)) engineRef.current?.pause(); }}
    >
      <div
        ref={stageRef}
        className="size-full touch-manipulation"
        onPointerDown={(event) => { event.preventDefault(); wrapRef.current?.focus({ preventScroll: true }); press(event.timeStamp); }}
        onPointerUp={release}
        onPointerCancel={release}
      />
      <div className="absolute right-1 top-1 flex items-center gap-2 font-mono text-xs tabular-nums text-fg-3">
        {resting && best > 0 && <span>{t`最高 ${pad(best)}`}</span>}
        <span ref={scoreRef} className="text-fg">{pad(0)}</span>
        {onClose && <Button variant="ghost" size="icon-xs" aria-label={t`关闭`} onClick={onClose}><IconX /></Button>}
      </div>
      {hint && <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-xs text-fg-3">{hint}</p>}
    </div>
  );
}
