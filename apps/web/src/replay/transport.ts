import { SYNC_PROTOCOL, type StreamListener, type SyncTransport } from '@/sync/protocol';

/** One SSE frame as `scripts/replay-transcript.ts record` wrote it: [t] is milliseconds since the recording started. */
export interface RecordedFrame { t: number; type: string; data: string; id?: string }

export interface ReplayClock {
  /** Recorded gaps longer than this are cut to it: a tool that ran for minutes replays in a moment. */
  maxGap: number;
  /** 2 plays twice as fast. Gaps under a frame stay as they were, so frames that arrived together still do. */
  speed: number;
}

/**
 * A sync transport that plays a recording into the real sync engine. Once [ready], the main lane's
 * stream gets the frames on their recorded timing; a redial, a subagent lane and every page request
 * wait forever, so nothing the recording does not hold enters the transcript or moves it.
 */
export function replayTransport(frames: readonly RecordedFrame[], clock: ReplayClock, onFrame: (index: number, frame: RecordedFrame) => void, ready: Promise<void>) {
  let finish!: (closedAt?: number) => void;
  /** Resolves when the recording ran out, or with the frame at which the engine closed the stream (a gap it redials over). */
  const done = new Promise<number | undefined>((resolve) => { finish = resolve; });
  let started = false;
  const transport: SyncTransport = {
    stream(url: string, listener: StreamListener) {
      const main = new URLSearchParams(url.split('?')[1] ?? '').get('lane') === 'main';
      if (!main || started) return { close() {} };
      started = true;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let at = 0;
      const play = (index: number) => {
        if (stopped) return;
        at = index;
        if (index >= frames.length) { finish(); return; }
        const frame = frames[index]!;
        onFrame(index, frame);
        listener.frame(frame.type, frame.data, frame.id);
        const next = frames[index + 1];
        const gap = next ? Math.max(0, next.t - frame.t) : 0;
        const wait = gap < 16 ? gap : Math.min(clock.maxGap, gap) / clock.speed;
        // Frames that arrived in one chunk are handed over in one task, as `EventSource` does.
        if (next && wait === 0) play(index + 1);
        else timer = setTimeout(() => play(index + 1), wait);
      };
      // Held until the watcher is on the transcript, so the first frames are measured too.
      void ready.then(() => { if (!stopped) { listener.open(); play(0); } });
      return { close() { if (!stopped) finish(at); stopped = true; clearTimeout(timer); } };
    },
    get<T>(path: string): Promise<T> {
      if (path === '/health') return Promise.resolve({ protocol: { version: SYNC_PROTOCOL } } as T);
      return new Promise<T>(() => {});
    },
  };
  return { transport, done };
}
