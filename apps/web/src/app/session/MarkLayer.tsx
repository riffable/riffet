import { createPortal } from 'react-dom';
import { useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import type { DiscussionSource, Mark, MarkColor } from '@contracts';
import { IconCopy, IconHighlighter, IconImageDown, IconMessagesSquare, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/controls';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { copyWithToast } from '@/lib/files';
import { cn } from '@/lib/utils';
import { anchorIds, MARK_COLORS, markBodies, markColorLabels, markSwatch, SessionMarksContext, type MarkTarget } from './marks';
import { findQuote, quoteAt, rangeAt, textOffset } from './textQuote';
import { ShareImageDialog, ShareSessionContext, type ShareSource } from '../marks/ShareImage';
import { isComposingKey } from './composerKeyboard';

/** A burst of DOM changes (a streamed frame, a window of rows mounting) re-resolves the highlights once. */
const REPAINT_MS = 100;

const highlightsSupported = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

interface Resolved { mark: Mark; range: Range }
interface Selected { target: MarkTarget; text: string; start: number; end: number; rect: DOMRect }

/** The markable answer body that holds [node], if any. */
function bodyOf(node: Node | null): HTMLElement | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('[data-mark-ids]') ?? undefined;
}

function ColorButtons({ current, onPick }: { current?: MarkColor; onPick: (color: MarkColor) => void }) {
  return (
    <span className="flex items-center gap-1">
      {MARK_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={i18n._(markColorLabels[color])}
          title={i18n._(markColorLabels[color])}
          aria-pressed={current === color}
          onClick={() => onPick(color)}
          className={cn('grid size-6 place-items-center rounded-full outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus no-hover:size-9', current === color && 'bg-active')}
        >
          <span className={cn('size-3.5 rounded-full', markSwatch[color])} />
        </button>
      ))}
    </span>
  );
}

/** Color, note and delete for one highlight, opened by clicking it. */
function HighlightEditor({ mark, onChange, onRemove }: { mark: Mark; onChange: (body: { note?: string | null; color?: MarkColor }) => void; onRemove: () => void }) {
  const { t } = useLingui();
  const [note, setNote] = useState(mark.note ?? '');
  const saveNote = () => { if (note.trim() !== (mark.note ?? '')) onChange({ note: note.trim() || null }); };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <ColorButtons current={mark.color ?? 'yellow'} onPick={(color) => onChange({ color })} />
        <Button size="xs" variant="quiet" className="text-fg-3 hover:text-danger" onClick={onRemove}><IconTrash2 /><Trans context="session-delete-action">删除</Trans></Button>
      </div>
      <Textarea
        value={note}
        rows={3}
        placeholder={t`添加备注…`}
        aria-label={t`备注`}
        onChange={(event) => setNote(event.target.value)}
        onBlur={saveNote}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isComposingKey(event.nativeEvent)) { event.preventDefault(); saveNote(); } }}
        className="min-h-16 resize-none py-1.5 text-sm"
      />
    </div>
  );
}

/**
 * Highlights (片段收藏) over the transcript: paints the conversation's highlights with the CSS Custom
 * Highlight API, offers 高亮 for a selection inside one finished answer, and opens a highlight's
 * editor when it is clicked. Rows are windowed and re-render on their own, so where each highlight
 * sits is resolved again after every change to the transcript's DOM rather than kept.
 */
export function MarkLayer({ scrollRef, onDiscuss }: { scrollRef: RefObject<HTMLElement | null>; onDiscuss?: (source: DiscussionSource) => void }) {
  const { t } = useLingui();
  const marks = useContext(SessionMarksContext);
  const session = useContext(ShareSessionContext);
  const resolved = useRef<Resolved[]>([]);
  const [selected, setSelected] = useState<Selected>();
  const [sharing, setSharing] = useState<ShareSource>();
  const [sharingOpen, setSharingOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; x: number; y: number }>();
  const [editingOpen, setEditingOpen] = useState(false);
  const spans = marks?.marks.filter((mark) => mark.kind === 'span' && mark.quote);
  const spanKey = spans?.map((mark) => `${mark.id}:${mark.color ?? ''}:${mark.updatedAt}`).join('|') ?? '';

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !spans) return;
    const supported = highlightsSupported();
    let timer: number | undefined;
    const paint = () => {
      timer = undefined;
      const bodies = new Map<string, HTMLElement>();
      for (const element of scroller.querySelectorAll<HTMLElement>('[data-mark-ids]')) for (const id of element.dataset.markIds!.split(' ')) bodies.set(id, element);
      const texts = new Map<HTMLElement, string>();
      const next: Resolved[] = [];
      for (const mark of spans) {
        const body = anchorIds(mark).map((id) => bodies.get(id)).find(Boolean)
          ?? [...new Set(bodies.values())].find(element => {
            const target = markBodies.get(element);
            return target && ((mark.anchor.runId && target.anchor.runId === mark.anchor.runId) || (mark.anchor.nativeTurnId && target.anchor.nativeTurnId === mark.anchor.nativeTurnId))
              && findQuote(element.textContent ?? '', mark.quote!);
          });
        if (!body) continue;
        let text = texts.get(body);
        if (text === undefined) { text = body.textContent ?? ''; texts.set(body, text); }
        const at = findQuote(text, mark.quote!);
        const range = at && rangeAt(body, at.start, at.end);
        if (range) next.push({ mark, range });
      }
      resolved.current = next;
      if (supported) for (const color of MARK_COLORS) CSS.highlights.set(`mark-${color}`, new Highlight(...next.filter((entry) => (entry.mark.color ?? 'yellow') === color).map((entry) => entry.range)));
    };
    paint();
    const observer = new MutationObserver(() => { timer ??= window.setTimeout(paint, REPAINT_MS); });
    observer.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-mark-ids'] });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      resolved.current = [];
      if (supported) for (const color of MARK_COLORS) CSS.highlights.delete(`mark-${color}`);
    };
    // `spanKey` stands for `spans`, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef, spanKey, Boolean(marks)]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !marks) return;
    /** A selection inside one markable answer offers the toolbar; anything else hides it. */
    const readSelection = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { setSelected(undefined); return; }
      const range = selection.getRangeAt(0);
      const body = bodyOf(range.startContainer);
      const target = body && markBodies.get(body);
      if (!body || !target || bodyOf(range.endContainer) !== body || !scroller.contains(body)) { setSelected(undefined); return; }
      const text = body.textContent ?? '';
      const start = textOffset(body, range.startContainer, range.startOffset);
      const end = textOffset(body, range.endContainer, range.endOffset);
      if (!quoteAt(text, start, end)) { setSelected(undefined); return; }
      setSelected({ target, text, start, end, rect: range.getBoundingClientRect() });
    };
    // Shown once the pointer or the keyboard lets go, not while a drag is still extending it.
    const settled = (event: Event) => { if (!(event instanceof KeyboardEvent) || event.shiftKey || event.key === 'Shift') window.setTimeout(readSelection, 0); };
    const changed = () => { const selection = document.getSelection(); if (!selection || selection.isCollapsed) setSelected(undefined); };
    /**
     * The reader scrolling away puts the toolbar away. A scroll the transcript makes on its own
     * (rows settling above, a window of rows mounting) keeps it, beside the selection where it went.
     */
    const dismissed = () => setSelected(undefined);
    const keyed = (event: KeyboardEvent) => { if (!event.shiftKey && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) dismissed(); };
    const scrolled = () => setSelected((current) => {
      const selection = document.getSelection();
      return current && selection?.rangeCount && !selection.isCollapsed ? { ...current, rect: selection.getRangeAt(0).getBoundingClientRect() } : current;
    });
    /** A click on painted text opens that highlight; there is no element to listen on. */
    const clicked = (event: MouseEvent) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('a,button,input,textarea,[role="button"]'))) return;
      if (!document.getSelection()?.isCollapsed) return;
      const hit = resolved.current.find(({ range }) => [...range.getClientRects()].some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom));
      if (hit) { setEditing({ id: hit.mark.id, x: event.clientX, y: event.clientY }); setEditingOpen(true); }
    };
    scroller.addEventListener('mouseup', settled);
    scroller.addEventListener('keyup', settled);
    scroller.addEventListener('wheel', dismissed, { passive: true });
    scroller.addEventListener('touchmove', dismissed, { passive: true });
    scroller.addEventListener('keydown', keyed);
    scroller.addEventListener('scroll', scrolled, { passive: true });
    scroller.addEventListener('click', clicked);
    document.addEventListener('selectionchange', changed);
    return () => {
      scroller.removeEventListener('mouseup', settled);
      scroller.removeEventListener('keyup', settled);
      scroller.removeEventListener('wheel', dismissed);
      scroller.removeEventListener('touchmove', dismissed);
      scroller.removeEventListener('keydown', keyed);
      scroller.removeEventListener('scroll', scrolled);
      scroller.removeEventListener('click', clicked);
      document.removeEventListener('selectionchange', changed);
    };
  }, [scrollRef, Boolean(marks)]);

  useEffect(() => {
    if (!selected) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(undefined); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [selected]);

  if (!marks) return null;
  const editingMark = editing && marks.marks.find((mark) => mark.id === editing.id);
  const highlight = (color: MarkColor) => {
    if (!selected) return;
    const quote = quoteAt(selected.text, selected.start, selected.end);
    if (quote) marks.highlight(selected.target, quote, color);
    document.getSelection()?.removeAllRanges();
    setSelected(undefined);
  };
  const share = () => {
    if (!selected || !session) return;
    const text = document.getSelection()?.toString().trim() || selected.text.slice(selected.start, selected.end).trim();
    document.getSelection()?.removeAllRanges();
    setSelected(undefined);
    if (!text) return;
    setSharing({
      kind: 'span', text, title: session.title, at: selected.target.at,
      ...(session.backendId ? { backendId: session.backendId } : {}),
      ...(session.projectName ? { projectName: session.projectName } : {}),
    });
    setSharingOpen(true);
  };
  // Above the selection, or below it when that would leave the window.
  const above = selected ? selected.rect.top > 56 : true;
  return (
    <>
      {selected && createPortal(
        <div
          role="toolbar"
          aria-label={t`选中文字操作`}
          // Pressing a button must not collapse the selection it acts on.
          onMouseDown={(event) => event.preventDefault()}
          style={{ left: Math.min(Math.max(selected.rect.left + selected.rect.width / 2, Math.min(240, window.innerWidth / 2)), Math.max(window.innerWidth - 240, window.innerWidth / 2)), top: above ? selected.rect.top - 8 : selected.rect.bottom + 8 }}
          className={cn('fixed z-(--z-menu) flex max-w-[calc(100vw-16px)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl bg-popover p-1 text-fg shadow-pop animate-in fade-in-0 duration-[var(--duration-fast)]', above && '-translate-y-full')}
        >
          {onDiscuss && <Button size="xs" variant="quiet" onClick={() => {
            const quote = quoteAt(selected.text, selected.start, selected.end);
            if (!quote) return;
            onDiscuss({ anchor: selected.target.anchor, quote });
            document.getSelection()?.removeAllRanges();
            setSelected(undefined);
          }}><IconMessagesSquare /><Trans>侧边聊天</Trans></Button>}
          <span className="flex items-center gap-1 pl-1.5 pr-0.5 text-xs text-fg-3"><IconHighlighter className="size-3.5" /><Trans context="session-highlight-action">高亮</Trans></span>
          <ColorButtons onPick={highlight} />
          <span aria-hidden className="mx-0.5 h-4 w-px bg-line-strong" />
          <Button size="xs" variant="quiet" onClick={() => { void copyWithToast(document.getSelection()?.toString() ?? selected.text.slice(selected.start, selected.end)); setSelected(undefined); }}><IconCopy /><Trans>复制</Trans></Button>
          {session && <Button size="xs" variant="quiet" onClick={share}><IconImageDown /><Trans>导出图片</Trans></Button>}
        </div>,
        document.body,
      )}
      {sharing && <ShareImageDialog source={sharing} open={sharingOpen} onOpenChange={setSharingOpen} />}
      <Popover open={editingOpen && Boolean(editingMark)} onOpenChange={setEditingOpen}>
        {editing && createPortal(<PopoverAnchor asChild><span aria-hidden className="pointer-events-none fixed size-px" style={{ left: editing.x, top: editing.y }} /></PopoverAnchor>, document.body)}
        {editingMark && (
          <PopoverContent align="center" className="w-72 p-2.5">
            <HighlightEditor
              key={editingMark.id}
              mark={editingMark}
              onChange={(body) => marks.update(editingMark.id, body)}
              onRemove={() => { marks.remove(editingMark.id); setEditingOpen(false); }}
            />
          </PopoverContent>
        )}
      </Popover>
    </>
  );
}
