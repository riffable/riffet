import { createRoot } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Session } from '@contracts';
import { startLocale } from '@/lib/i18n';
import '@/lib/theme';
import '@/lib/display-settings';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@/styles/index.css';
import { watchTranscript, type ReplayReport } from './measure';
import { ReplayView } from './ReplayView';
import { replayTransport, type RecordedFrame, type ReplayClock } from './transport';

/*
 * The transcript replay page (`replay.html`, dev server only). `scripts/replay-transcript.ts run`
 * hands it a recording through `window.__replay` and reads the report back; docs/WEB.md describes
 * what the report counts.
 */

interface Recording { session: Session; frames: RecordedFrame[] }

function parse(text: string): Recording {
  const lines = text.split('\n').filter((line) => line.trim());
  const meta = JSON.parse(lines[0]!) as { recording: number; sessionId: string };
  if (meta.recording !== 1) throw new Error('Not a transcript recording');
  const frames = lines.slice(1).map((line) => JSON.parse(line) as RecordedFrame);
  const hello = frames.find((frame) => frame.type === 'hello');
  const session = hello ? (JSON.parse(hello.data) as { session?: Omit<Session, 'id'> }).session : undefined;
  if (!session) throw new Error('The recording has no hello frame');
  // The real id, since frames name their session; the replay runs in a fresh browser profile with no cache.
  return { session: { ...session, id: meta.sessionId } as Session, frames };
}

const until = (test: () => HTMLElement | null) => new Promise<HTMLElement>((resolve) => {
  const poll = () => { const found = test(); if (found) resolve(found); else requestAnimationFrame(poll); };
  poll();
});
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

declare global {
  interface Window { __replay?: (text: string, clock?: Partial<ReplayClock>) => Promise<ReplayReport> }
}

window.__replay = async (text, clock) => {
  const recording = parse(text);
  let watcher: ReturnType<typeof watchTranscript> | undefined;
  let start!: () => void;
  const ready = new Promise<void>((resolve) => { start = resolve; });
  const { transport, done } = replayTransport(recording.frames, { maxGap: 1500, speed: 1, ...clock }, (index, frame) => watcher?.frame(index, frame.type), ready);
  await startLocale();
  createRoot(document.getElementById('root')!).render(<I18nProvider i18n={i18n}><ReplayView session={recording.session} transport={transport} /></I18nProvider>);
  watcher = watchTranscript(await until(() => document.querySelector<HTMLElement>('[data-transcript-scroll]')));
  start();
  const closedAt = await done;
  // The last frame's effects, an entrance and a fold included, settle before the report is read.
  await wait(1500);
  return { ...watcher.stop(recording.frames.length), ...(closedAt === undefined ? {} : { closedAt }) };
};
