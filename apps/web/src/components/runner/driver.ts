import { RunnerEngine, type RunnerColors, type RunnerPhase } from './engine';

export type RunnerCommand =
  | { type: 'init'; canvas: OffscreenCanvas; colors: RunnerColors; width: number; height: number; dpr: number }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'colors'; colors: RunnerColors }
  /** `at`: when the key went down, on the shared clock (`timeOrigin` + `timeStamp`). */
  | { type: 'press'; at: number }
  | { type: 'release' | 'pause' | 'finish' };
export type RunnerReport = { type: 'phase'; phase: RunnerPhase; score: number } | { type: 'score'; score: number };

export interface RunnerDriver {
  resize: (width: number, height: number) => void;
  setColors: (colors: RunnerColors) => void;
  /** `timeStamp`: the input event's own, so a late key is judged from when it was pressed. */
  press: (timeStamp: number) => void;
  release: () => void;
  pause: () => void;
  finish: () => void;
  destroy: () => void;
}

/**
 * Starts 黑马跑酷 in `stage`. Where the browser can hand a canvas to a worker, the run steps and
 * draws there, so a page busy rendering a conversation does not stall it; keys still come through
 * the page, stamped with when they were pressed. A browser without that, or a worker that fails to
 * start, runs the same engine on the page.
 */
export function startRunner(stage: HTMLElement, colors: RunnerColors, onReport: (report: RunnerReport) => void): RunnerDriver {
  let canvas = makeCanvas(stage);
  let size = { width: stage.clientWidth, height: stage.clientHeight };
  let current = colors;
  let local: RunnerEngine | undefined;
  let worker: Worker | undefined;

  const runLocally = () => {
    worker?.terminate();
    worker = undefined;
    // A canvas handed to a worker cannot draw on the page again: a fresh one takes its place.
    if (canvas.dataset.offscreen) { const fresh = makeCanvas(stage); canvas.replaceWith(fresh); canvas = fresh; }
    local = new RunnerEngine(canvas, current, {
      phase: (phase) => onReport({ type: 'phase', phase, score: local?.score ?? 0 }),
      score: (score) => onReport({ type: 'score', score }),
    });
    local.resize(size.width, size.height, devicePixelRatio || 1);
  };

  const send = (command: RunnerCommand, transfer: Transferable[] = []) => worker?.postMessage(command, transfer);

  if (typeof Worker === 'function' && typeof canvas.transferControlToOffscreen === 'function') {
    try {
      const offscreen = canvas.transferControlToOffscreen();
      canvas.dataset.offscreen = 'true';
      worker = new Worker(new URL('./runner.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<RunnerReport>) => onReport(event.data);
      worker.onerror = (event) => { event.preventDefault(); runLocally(); };
      send({ type: 'init', canvas: offscreen, colors, ...size, dpr: devicePixelRatio || 1 }, [offscreen]);
    } catch {
      runLocally();
    }
  } else {
    runLocally();
  }

  return {
    resize: (width, height) => {
      size = { width, height };
      if (local) local.resize(width, height, devicePixelRatio || 1); else send({ type: 'resize', width, height, dpr: devicePixelRatio || 1 });
    },
    setColors: (next) => {
      current = next;
      if (local) local.setColors(next); else send({ type: 'colors', colors: next });
    },
    // On the page the engine stalls with the page, so there is no lag to make up.
    press: (timeStamp) => { if (local) local.press(); else send({ type: 'press', at: performance.timeOrigin + timeStamp }); },
    release: () => { if (local) local.release(); else send({ type: 'release' }); },
    pause: () => { if (local) local.pause(); else send({ type: 'pause' }); },
    finish: () => { if (local) local.finish(); else send({ type: 'finish' }); },
    destroy: () => {
      worker?.terminate();
      worker = undefined;
      local?.destroy();
      local = undefined;
      canvas.remove();
    },
  };
}

function makeCanvas(stage: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'block size-full';
  stage.append(canvas);
  return canvas;
}
