import { useCallback, useEffect, useRef, useState } from 'react';
import { DICTATION_BUDGET } from '@contracts';
import { CaptureError, startCapture, type Capture, type CaptureProblem } from '@/lib/dictation/capture';
import { DictationStream, joinTranscript, needsSpace, type DictationProblem } from '@/lib/dictation/stream';

export type DictationPhase = 'idle' | 'recording' | 'finishing' | 'failed';

/** What went wrong: the microphone (`capture`) or the recognizer and its connection (`server`). */
export type DictationFailure = { kind: 'capture'; problem: CaptureProblem } | { kind: 'server'; problem: DictationProblem };

export interface DictationView {
  phase: DictationPhase;
  elapsedMs: number;
  /** Loudness of the recent frames, oldest first, each 0–1. */
  levels: number[];
  /** The sentence still being recognized; settled sentences are already in the draft. */
  live: string;
  /** What this dictation has written into the draft so far. */
  written: string;
  failure?: DictationFailure;
}

export interface DictationTarget {
  text(): string;
  selection(): { start: number; end: number };
  /** Replaces the draft and puts the caret at `caret`. */
  replace(text: string, caret: number): void;
}

/** Bars the recording bar draws. */
export const DICTATION_LEVELS = 28;
const MAX_FRAMES = DICTATION_BUDGET.maxDurationMs / 100;
const IDLE: DictationView = { phase: 'idle', elapsedMs: 0, levels: [], live: '', written: '' };

/** Hold to talk (docs/design/system/surfaces.md「语音输入（触屏）」): a release sooner than this was a tap, and this far up cancels. */
export const HOLD_TAP_MS = 300;
export const HOLD_CANCEL_PX = 80;
/** From here the clock warns that the recording is about to stop. */
export const DICTATION_WARN_MS = DICTATION_BUDGET.maxDurationMs - 10_000;

/**
 * One dictation into the composer (docs/VOICE.md §7). The draft around the caret is kept as it was; settled sentences are
 * written between the two halves as they arrive and the final text replaces them. The recording is kept until the dictation
 * ends, so a failed one can be sent again.
 */
export function useDictation(target: DictationTarget) {
  const [view, setView] = useState<DictationView>(IDLE);
  const targetRef = useRef(target);
  targetRef.current = target;
  const anchor = useRef<{ before: string; after: string } | null>(null);
  const capture = useRef<Capture | null>(null);
  const stream = useRef<DictationStream | null>(null);
  const frames = useRef<ArrayBuffer[]>([]);
  const phase = useRef<DictationPhase>('idle');
  const started = useRef(0);
  /** Which dictation is current: one cancelled while its microphone was opening must not take over the next one. */
  const generation = useRef(0);

  const setPhase = useCallback((next: DictationPhase, patch: Partial<DictationView> = {}) => {
    phase.current = next;
    setView((current) => ({ ...current, ...patch, phase: next }));
  }, []);

  /** Writes `inserted` between the halves of the draft the dictation started in. */
  const write = useCallback((inserted: string) => {
    const halves = anchor.current;
    if (!halves) return;
    const lead = inserted && halves.before && !/\s$/.test(halves.before) && needsSpace(halves.before, inserted) ? ' ' : '';
    const trail = inserted && halves.after && !/^\s/.test(halves.after) && needsSpace(inserted, halves.after) ? ' ' : '';
    const middle = lead + inserted + trail;
    targetRef.current.replace(halves.before + middle + halves.after, halves.before.length + lead.length + inserted.length);
    setView((current) => current.written === inserted ? current : { ...current, written: inserted });
  }, []);

  const stopCapture = useCallback(() => { capture.current?.stop(); capture.current = null; }, []);

  const release = useCallback(() => {
    stopCapture();
    stream.current?.cancel();
    stream.current = null;
    frames.current = [];
    anchor.current = null;
  }, [stopCapture]);

  const connect = useCallback(() => {
    const next = new DictationStream({
      ready: () => {},
      partial: (segments) => {
        if (stream.current !== next) return;
        write(joinTranscript(segments.filter((segment) => segment.final).map((segment) => segment.text)));
        setView((current) => ({ ...current, live: joinTranscript(segments.filter((segment) => !segment.final).map((segment) => segment.text)) }));
      },
      final: (text) => {
        if (stream.current !== next) return;
        write(text);
        stream.current = null;
        release();
        setPhase('idle', { ...IDLE });
      },
      error: (problem) => {
        if (stream.current !== next) return;
        stream.current = null;
        stopCapture();
        // Nothing recorded, nothing to retry: the dictation simply ends with the reason.
        setPhase('failed', { live: '', failure: { kind: 'server', problem: frames.current.length ? problem : { ...problem, retryable: false } } });
      },
    });
    stream.current = next;
    return next;
  }, [release, setPhase, stopCapture, write]);

  const finish = useCallback(() => {
    if (phase.current !== 'recording') return;
    stopCapture();
    setPhase('finishing');
    stream.current?.finish();
  }, [setPhase, stopCapture]);

  const start = useCallback(async () => {
    if (phase.current !== 'idle') return;
    const mine = ++generation.current;
    const draft = targetRef.current.text();
    const { start: from, end: to } = targetRef.current.selection();
    anchor.current = { before: draft.slice(0, from), after: draft.slice(to) };
    frames.current = [];
    started.current = performance.now();
    setPhase('recording', { elapsedMs: 0, levels: [], live: '', written: '', failure: undefined });
    // A selection is replaced by what is said, as typing would.
    if (from !== to) write('');
    const live = connect();
    try {
      const opened = await startCapture((pcm, level) => {
        if (generation.current !== mine || phase.current !== 'recording') return;
        frames.current.push(pcm);
        live.push(pcm);
        setView((current) => ({ ...current, elapsedMs: performance.now() - started.current, levels: [...current.levels.slice(1 - DICTATION_LEVELS), level] }));
        if (frames.current.length >= MAX_FRAMES) finish();
      });
      // Cancelled or failed while the microphone was being opened.
      if (generation.current !== mine || (phase.current as DictationPhase) !== 'recording') { opened.stop(); return; }
      capture.current = opened;
    } catch (error) {
      live.cancel();
      if (generation.current !== mine) return;
      stream.current = null;
      write('');
      setPhase('failed', { failure: { kind: 'capture', problem: error instanceof CaptureError ? error.problem : 'failed' } });
    }
  }, [connect, finish, setPhase, write]);

  /** Back to the draft as it was before this dictation. */
  const cancel = useCallback(() => {
    if (phase.current === 'idle') return;
    write('');
    release();
    setPhase('idle', { ...IDLE });
  }, [release, setPhase, write]);

  /** The same recording, sent again as a whole. */
  const retry = useCallback(() => {
    if (phase.current !== 'failed' || !frames.current.length) return;
    setPhase('finishing', { failure: undefined, live: '' });
    const again = connect();
    for (const frame of frames.current) again.push(frame);
    again.finish();
  }, [connect, setPhase]);

  // A phone that locks or switches away finishes what was said rather than recording into the dark.
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') finish(); };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [finish]);

  useEffect(() => release, [release]);

  return { view, start, finish, cancel, retry };
}
