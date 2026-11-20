import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { FILE_BUDGET, type FilePreview } from '@contracts';
import { Button } from '@/components/ui/button';
import { EmptyState, Spinner } from '@/components/ui/controls';
import { requestResponse } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';

const ROW_BYTES = 16;
const ROW_HEIGHT = 20;
const OVERSCAN = 20;

/** A byte range of a project file, and the file's size from `Content-Range` (`apps/server/src/routes/workspace.ts#sendFile`). */
async function readRange(url: string, from: number, to: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; size: number } | 'past-end'> {
  const response = await requestResponse(url, { headers: { Range: `bytes=${from}-${to}` }, signal });
  if (response.status === 416) return 'past-end';
  const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1];
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, size: total ? Number(total) : bytes.length };
}

const hex = (value: number) => value.toString(16).padStart(2, '0');
const printable = (value: number) => (value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : '·');

/**
 * Any file as bytes: offset, sixteen bytes in hex, the same as text. Rows are drawn only where the
 * reader looks, and the file is read a page (`FILE_BUDGET.hexPageBytes`) at a time as they come into
 * view, so its size does not matter; the pages read last are kept (`hexPagesKept`).
 */
export function HexView({ url, size }: { url: string; size: number }) {
  const { t } = useLingui();
  const scroller = useRef<HTMLDivElement>(null);
  const [window_, setWindow] = useState({ first: 0, count: 60 });
  const pages = useRef(new Map<number, Uint8Array>());
  const loading = useRef(new Set<number>());
  const [, setRevision] = useState(0);
  const [failed, setFailed] = useState(false);
  const rows = Math.ceil(size / ROW_BYTES);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const first = Math.max(0, Math.floor(element.scrollTop / ROW_HEIGHT) - OVERSCAN);
    setWindow({ first, count: Math.ceil(element.clientHeight / ROW_HEIGHT) + OVERSCAN * 2 });
  }, []);
  useLayoutEffect(measure, [measure]);

  /** Reads of this file; a new file or leaving the view aborts them, scrolling does not (a page cut off half way is never asked for again). */
  const reads = useRef(new AbortController());
  useEffect(() => {
    reads.current = new AbortController();
    return () => { reads.current.abort(); pages.current.clear(); loading.current.clear(); };
  }, [url]);
  useEffect(() => {
    const controller = reads.current;
    const firstByte = window_.first * ROW_BYTES;
    const lastByte = Math.min(size, (window_.first + window_.count) * ROW_BYTES) - 1;
    for (let page = Math.floor(firstByte / FILE_BUDGET.hexPageBytes); page <= Math.floor(Math.max(0, lastByte) / FILE_BUDGET.hexPageBytes); page += 1) {
      if (pages.current.has(page) || loading.current.has(page)) continue;
      loading.current.add(page);
      const from = page * FILE_BUDGET.hexPageBytes;
      void readRange(url, from, Math.min(size, from + FILE_BUDGET.hexPageBytes) - 1, controller.signal).then((read) => {
        if (read === 'past-end') return;
        pages.current.set(page, read.bytes);
        // The pages read longest ago go first.
        while (pages.current.size > FILE_BUDGET.hexPagesKept) pages.current.delete(pages.current.keys().next().value!);
        setRevision((value) => value + 1);
      }, (error: unknown) => { if ((error as Error).name !== 'AbortError') setFailed(true); }).finally(() => loading.current.delete(page));
    }
  }, [url, size, window_.first, window_.count]);

  if (failed) return <EmptyState title={t`无法读取文件`} />;
  const byteAt = (offset: number) => pages.current.get(Math.floor(offset / FILE_BUDGET.hexPageBytes))?.[offset % FILE_BUDGET.hexPageBytes];
  const shown = [];
  for (let row = window_.first; row < Math.min(rows, window_.first + window_.count); row += 1) {
    const offset = row * ROW_BYTES;
    const values = Array.from({ length: Math.min(ROW_BYTES, size - offset) }, (_, index) => byteAt(offset + index));
    shown.push(
      <div key={row} className="absolute inset-x-0 flex gap-4 whitespace-pre px-3" style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}>
        <span className="text-fg-4">{offset.toString(16).padStart(8, '0')}</span>
        <span className="text-fg-2">{values.map((value) => (value === undefined ? '  ' : hex(value))).join(' ').padEnd(ROW_BYTES * 3 - 1)}</span>
        <span className="text-fg-3">{values.map((value) => (value === undefined ? ' ' : printable(value))).join('')}</span>
      </div>,
    );
  }
  return (
    <div ref={scroller} onScroll={measure} className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-5" aria-label={t`十六进制`}>
      <div className="relative" style={{ height: rows * ROW_HEIGHT }}>{shown}</div>
    </div>
  );
}

/**
 * The end of a file too long to read whole, a log say: its last `FILE_BUDGET.tailBytes`, starting at
 * a whole line. Following asks every `followMs` for what was written since and appends it, keeping
 * only the last `tailBytes`; it stops while the view is hidden.
 */
export function TailView({ url, preview, active, render }: {
  url: string;
  preview: FilePreview;
  /** The view is on screen; following pauses otherwise. */
  active: boolean;
  /** Draws the text: the code view. */
  render: (preview: FilePreview) => React.ReactNode;
}) {
  const { t } = useLingui();
  const [text, setText] = useState<string>();
  const [size, setSize] = useState(preview.size);
  const [following, setFollowing] = useState(false);
  const [failed, setFailed] = useState(false);
  const end = useRef(0);
  const decoder = useRef(new TextDecoder());
  const body = useRef<HTMLDivElement>(null);
  // While following, what was just written stays in view.
  useEffect(() => {
    if (!following) return;
    const frame = requestAnimationFrame(() => { const scroller = body.current?.querySelector('.cm-scroller'); if (scroller) scroller.scrollTop = scroller.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [following, text]);

  useEffect(() => {
    const controller = new AbortController();
    setText(undefined); setFailed(false);
    decoder.current = new TextDecoder();
    const from = Math.max(0, preview.size - FILE_BUDGET.tailBytes);
    void readRange(url, from, Math.max(from, preview.size - 1), controller.signal).then((read) => {
      if (read === 'past-end') { setText(''); return; }
      const decoded = decoder.current.decode(read.bytes, { stream: true });
      // Cut to the first whole line unless the file starts here.
      setText(from > 0 ? decoded.slice(decoded.indexOf('\n') + 1) : decoded);
      end.current = from + read.bytes.length;
      setSize(read.size);
    }, (error: unknown) => { if ((error as Error).name !== 'AbortError') setFailed(true); });
    return () => controller.abort();
  }, [url, preview.size]);

  useEffect(() => {
    if (!following || !active || text === undefined) return;
    let stopped = false;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const read = await readRange(url, end.current, end.current + FILE_BUDGET.tailBytes - 1, controller.signal);
        if (stopped || read === 'past-end' || !read.bytes.length) return;
        end.current += read.bytes.length;
        setSize(read.size);
        const added = decoder.current.decode(read.bytes, { stream: true });
        setText((current) => {
          const next = (current ?? '') + added;
          return next.length > FILE_BUDGET.tailBytes ? next.slice(next.indexOf('\n', next.length - FILE_BUDGET.tailBytes) + 1) : next;
        });
      } catch { /* the next tick asks again */ }
    };
    const timer = window.setInterval(() => void poll(), FILE_BUDGET.followMs);
    void poll();
    return () => { stopped = true; controller.abort(); window.clearInterval(timer); };
  }, [following, active, url, text === undefined]);

  if (failed) return <EmptyState title={t`无法读取文件`} />;
  if (text === undefined) return <div className="flex flex-1 justify-center py-10"><Spinner /></div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 edge-b px-3 text-xs text-fg-3">
        <span className="min-w-0 flex-1 truncate"><Trans>末尾 {formatBytes(Math.min(size, FILE_BUDGET.tailBytes))}，共 {formatBytes(size)}</Trans></span>
        <Button size="xs" variant="ghost" className={cn(following && 'bg-active text-fg')} aria-pressed={following} onClick={() => setFollowing((value) => !value)}><Trans>跟随</Trans></Button>
      </div>
      <div ref={body} className="flex min-h-0 flex-1 flex-col">{render({ ...preview, content: text, size, truncated: false, editable: false })}</div>
    </div>
  );
}
