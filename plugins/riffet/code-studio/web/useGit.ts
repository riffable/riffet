import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHead } from '@contracts';
import type { CodeBlameView } from '@riffet/plugin-web';
import type { CodeApi } from './data';

/** Lines of blame read at a time, around what is in view. */
const BLAME_BLOCK = 200;
/** Committed versions of files kept for the change marks. */
const BASELINES_KEPT = 20;

/**
 * Git for the page: HEAD (`null` when this is not a git checkout or git could not answer, and the page
 * then shows no git at all), the open file as committed for the change marks, and blame read block by
 * block as the reader scrolls (a whole file of a large repository takes minutes). Nothing runs while the
 * page is out of sight (`shown`); what was stopped is read again on coming back.
 */
export function useGit({ api, active, shown, onBlameError }: { api: CodeApi | undefined; active: string | undefined; shown: boolean; onBlameError(error: unknown): void }) {
  const [head, setHead] = useState<GitHead | null>();
  const headRequest = useRef<AbortController>(undefined);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  const readHead = useCallback(() => {
    if (!api || !shownNow.current) return;
    headRequest.current?.abort();
    const controller = headRequest.current = new AbortController();
    api.head(controller.signal).then(setHead, () => { if (!controller.signal.aborted) setHead(null); });
  }, [api]);
  useEffect(() => {
    setHead(undefined);
    readHead();
    // A commit or a checkout elsewhere moves HEAD: look again when the window comes back.
    window.addEventListener('focus', readHead);
    return () => { headRequest.current?.abort(); window.removeEventListener('focus', readHead); };
  }, [readHead]);
  useEffect(() => { if (shown) readHead(); else headRequest.current?.abort(); }, [shown, readHead]);
  const headHash = head?.head;

  // The open file as committed, for the change marks beside the line numbers; a few kept, so switching tabs does not read them again.
  const baselines = useRef(new Map<string, string | null>());
  const [baselineKey, setBaselineKey] = useState<string>();
  const fileKey = active && headHash ? `${headHash}:${active}` : undefined;
  useEffect(() => {
    if (!api || !active || !fileKey || !shown) return;
    if (baselines.current.has(fileKey)) { setBaselineKey(fileKey); return; }
    const controller = new AbortController();
    api.fileAtHead(active, controller.signal).then((file) => {
      // A new file is all added lines; a binary or cut-off one gets no marks.
      const text = file.missing ? '' : file.binary || file.truncated || file.text === undefined ? null : file.text;
      baselines.current.set(fileKey, text);
      while (baselines.current.size > BASELINES_KEPT) baselines.current.delete(baselines.current.keys().next().value!);
      setBaselineKey(fileKey);
    }, () => undefined);
    return () => controller.abort();
  }, [api, active, fileKey, shown]);
  const baseline = fileKey && baselineKey === fileKey ? baselines.current.get(fileKey) ?? undefined : undefined;

  const [annotate, setAnnotate] = useState(false);
  // Per file, as the IDE's annotations are: blame of a large repository is slow enough not to run on every tab opened.
  useEffect(() => setAnnotate(false), [active]);
  const [blocks, setBlocks] = useState<[number, number]>([0, 0]);
  const [blame, setBlame] = useState<{ key: string; view: CodeBlameView }>();
  const [blaming, setBlaming] = useState(false);
  const blameState = useRef<{ key: string; done: Set<number>; running?: AbortController; block?: number }>(undefined);
  const blameKey = annotate ? fileKey : undefined;
  const errorRef = useRef(onBlameError);
  errorRef.current = onBlameError;
  useEffect(() => {
    if (!api || !active || !blameKey) { blameState.current?.running?.abort(); blameState.current = undefined; setBlaming(false); return; }
    if (blameState.current?.key !== blameKey) {
      blameState.current?.running?.abort();
      blameState.current = { key: blameKey, done: new Set() };
      setBlame({ key: blameKey, view: { ranges: [], commits: {} } });
    }
    const state = blameState.current;
    // Leaving the page stops the block being read (git is killed); it is read again on coming back.
    if (!shown) {
      if (state.running) { state.running.abort(); state.running = undefined; state.done.delete(state.block!); setBlaming(false); }
      return;
    }
    if (state.running) return;
    let block = blocks[0];
    while (block <= blocks[1] && state.done.has(block)) block++;
    if (block > blocks[1]) return;
    const controller = state.running = new AbortController();
    state.block = block;
    state.done.add(block);
    setBlaming(true);
    const read = () => api.blame(active, block * BLAME_BLOCK + 1, (block + 1) * BLAME_BLOCK, controller.signal);
    // Once more on failure: a first blame on a cold repository can run out of time, and the run that was stopped leaves git's caches warm.
    read().catch((error: unknown) => { if (controller.signal.aborted) throw error; return read(); }).then((part) => {
      if (blameState.current !== state) return;
      state.running = undefined;
      setBlaming(false);
      setBlame((previous) => previous?.key === blameKey ? { key: blameKey, view: { ranges: [...previous.view.ranges, ...part.ranges], commits: { ...previous.view.commits, ...part.commits } } } : previous);
      // The next block in view, if any.
      setBlocks((value) => [value[0], value[1]]);
    }, (error: unknown) => {
      if (controller.signal.aborted || blameState.current !== state) return;
      state.running = undefined;
      setBlaming(false);
      setAnnotate(false);
      errorRef.current(error);
    });
  }, [api, active, blameKey, blocks, shown]);
  const onViewport = useCallback((first: number, last: number) => {
    const from = Math.floor((first - 1) / BLAME_BLOCK), to = Math.floor((last - 1) / BLAME_BLOCK);
    setBlocks((value) => (value[0] === from && value[1] === to ? value : [from, to]));
  }, []);
  const shownBlame = blameKey && blame?.key === blameKey ? blame.view : undefined;

  return { head, readHead, baseline, annotate, setAnnotate, blaming, blame: shownBlame, onViewport };
}
