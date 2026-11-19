import { RunnerEngine } from './engine';
import type { RunnerCommand, RunnerReport } from './driver';

/** 黑马跑酷 off the page's thread: the engine draws on the canvas the page handed over. */
let engine: RunnerEngine | undefined;
const report = (message: RunnerReport) => self.postMessage(message);

self.onmessage = (event: MessageEvent<RunnerCommand>) => {
  const command = event.data;
  if (command.type === 'init') {
    engine = new RunnerEngine(command.canvas, command.colors, {
      phase: (phase) => report({ type: 'phase', phase, score: engine?.score ?? 0 }),
      score: (score) => report({ type: 'score', score }),
    });
    engine.resize(command.width, command.height, command.dpr);
    return;
  }
  if (!engine) return;
  switch (command.type) {
    case 'resize': engine.resize(command.width, command.height, command.dpr); break;
    case 'colors': engine.setColors(command.colors); break;
    // The page's clock and this one share an origin only through `timeOrigin`.
    case 'press': engine.press((performance.timeOrigin + performance.now() - command.at) / 1000); break;
    case 'release': engine.release(); break;
    case 'pause': engine.pause(); break;
    case 'finish': engine.finish(); break;
  }
};
