import { createPortal } from 'react-dom';
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import type { CommandSelection, DiscussionSource, Mark, MarkColor } from '@contracts';
import { IconCopy, IconHighlighter, IconImageDown, IconMessagesSquare, IconTextQuote, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/controls';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { copyWithToast } from '@/lib/files';
import { cn } from '@/lib/utils';
import { anchorIds, MARK_COLORS, markBodies, markColorLabels, markSwatch, SessionMarksContext, type MarkTarget } from './marks';
import { findQuote, quoteAt, rangeAt, textOffset } from './textQuote';
import { ShareImageDialog, ShareSessionContext, type ShareSource } from '../marks/ShareImage';
import { isComposingKey } from './composerKeyboard';
import { commandIcon, MessageCommandBlock, useSelectionCommands } from './messageCommands';
import type { PluginCommand } from '@/plugins/commands';

/** A burst of DOM changes (a streamed frame, a window of rows mounting) re-resolves the highlights once. */
const REPAINT_MS = 100;

const highlightsSupported = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

interface Resolved { mark: Mark; range: Range }
interface Selected {
  /** The answer the text is in; absent for narration, which has no anchor to keep a highlight or a side chat against. */
  target?: MarkTarget;
  text: string; start: number; end: number; range: Range;
  /** Chosen when it shows, by the room there was: the toolbar keeps its side while the text scrolls. */
  above: boolean;
}
/** A plugin command's answer about a selection, beside it; `text` and `error` are absent while the command runs. */
interface Card {
  command: PluginCommand; selection: CommandSelection; range: Range;
  running?: boolean;
  text?: string; title?: string;
  error?: string; chooseModel?: 'auxiliary' | 'quickchat';
  /** Chosen when it opens, by the room there was: the card keeps its side while the text scrolls. */
  above: boolean; room: number;
  /** Playing its way out; removed when that ends. */
  closing?: boolean;
}

/** The colour 高亮 applies on a plain click: the one last picked, in this tab. */
let lastColor: MarkColor = 'yellow';

/**
 * Keeps [element] beside [range] (above it or below it, centred, inside the host's width), in the coordinates of
 * [host]: a box at the top of the transcript's scrolled content. A plain scroll moves the text and the element
 * together on the compositor and changes nothing here; this runs again only for what moves the text inside the
 * content (rows above settling, a stream, a resize). [onShown] hears whether the text is in the transcript's view.
 */
function useBesideRange(scrollRef: RefObject<HTMLElement | null>, host: HTMLElement | undefined, elementRef: RefObject<HTMLElement | null>, range: Range | undefined, above: boolean | undefined, onShown: (shown: boolean) => void) {
  const shownRef = useRef(onShown);
  shownRef.current = onShown;
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const element = elementRef.current;
    if (!scroller || !host || !element || !range) return;
    let frame = 0;
    let shown: boolean | undefined;
    const place = () => {
      frame = 0;
      const rect = range.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      const visible = Boolean(rect.width || rect.height) && rect.bottom > view.top && rect.top < view.bottom;
      if (visible !== shown) { shown = visible; shownRef.current(visible); }
      if (!visible) return;
      const origin = host.getBoundingClientRect();
      const width = element.offsetWidth;
      const centre = rect.left + rect.width / 2 - origin.left;
      element.style.left = `${Math.min(Math.max(centre, width / 2 + 8), origin.width - width / 2 - 8)}px`;
      element.style.top = `${(above ? rect.top - 8 : rect.bottom + 8) - origin.top}px`;
    };
    const schedule = () => { frame ||= requestAnimationFrame(place); };
    place();
    const observer = new MutationObserver(schedule);
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [scrollRef, host, elementRef, range, above]);
}

/** The selection as one quote for the composer: a code fence when it lies inside one code block, its words otherwise. */
function quoteOf(range: Range, text: string): string {
  const common = range.commonAncestorContainer;
  const element = common instanceof Element ? common : common.parentElement;
  if (element?.closest('pre')) {
    const code = text.replace(/^\n+|\s+$/g, '');
    const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}\n${code}\n${fence}`;
  }
  return text.trim().replace(/\n{3,}/g, '\n\n');
}

/** The answer body or the narration (`ThoughtRow`) that holds [node]: the text the selection toolbar acts on. */
function selectableOf(node: Node | null): HTMLElement | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('[data-mark-ids], [data-narration]') ?? undefined;
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

/**
 * 高亮 in the selection toolbar: a click applies the last colour; the colours show beside it, away from the text, while
 * the pointer rests on it or focus is inside (a tap shows them where there is no hover).
 */
function HighlightButton({ above, onPick }: { above: boolean; onPick: (color: MarkColor) => void }) {
  const { t } = useLingui();
  const [colorsShown, setColorsShown] = useState(false);
  return (
    <span className="group/highlight relative flex">
      <Button
        size="icon-sm"
        variant="quiet"
        aria-label={t({ context: 'session-highlight-action', message: '高亮' })}
        aria-expanded={colorsShown}
        className="no-hover:size-9"
        onClick={() => { if (window.matchMedia('(hover: none)').matches && !colorsShown) setColorsShown(true); else onPick(lastColor); }}
      ><IconHighlighter /></Button>
      <span className={cn('absolute left-1/2 hidden -translate-x-1/2 group-hover/highlight:flex group-focus-within/highlight:flex', above ? 'bottom-full pb-2.5' : 'top-full pt-2.5', colorsShown && 'flex')}>
        <span className="flex rounded-full bg-popover p-1 shadow-pop animate-in fade-in-0 duration-[var(--duration-fast)]"><ColorButtons onPick={onPick} /></span>
      </span>
    </span>
  );
}

/** An icon-only toolbar item, named by its tooltip. */
function ToolbarIcon({ label, side, onClick, children }: { label: string; side: 'top' | 'bottom'; onClick: () => void; children: ReactNode }) {
  return <Tip label={label} side={side}><Button size="icon-sm" variant="quiet" aria-label={label} className="no-hover:size-9" onClick={onClick}>{children}</Button></Tip>;
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
 * Highlights (片段收藏) and the selection toolbar over the transcript: paints the conversation's highlights with
 * the CSS Custom Highlight API, offers the toolbar for a selection inside one answer or one narration, and opens a
 * highlight's editor when it is clicked. Rows are windowed and re-render on their own, so where each highlight sits
 * is resolved again after every change to the transcript's DOM rather than kept.
 */
export function MarkLayer({ scrollRef, onDiscuss, onQuote }: { scrollRef: RefObject<HTMLElement | null>; onDiscuss?: (source: DiscussionSource) => void; onQuote?: (quote: string) => void }) {
  const { t } = useLingui();
  const selectionCommands = useSelectionCommands();
  const [card, setCard] = useState<Card>();
  const cardRef = useRef<HTMLElement>(null);
  const cardAbortRef = useRef<AbortController | undefined>(undefined);
  const toolbarRef = useRef<HTMLDivElement>(null);
  /** Out of the transcript's view the toolbar fades and waits; it shows again when the selection scrolls back. */
  const [toolbarShown, setToolbarShown] = useState(true);
  /**
   * Where the toolbar and the card live: a zero-height box at the top of the transcript's scrolled content, so they
   * scroll with the text natively, on the compositor, instead of being moved after each scroll.
   */
  const [floatHost, setFloatHost] = useState<HTMLDivElement>();
  const closeCard = () => {
    cardAbortRef.current?.abort();
    cardAbortRef.current = undefined;
    setCard((current) => (current && !current.closing ? { ...current, closing: true } : current));
  };
  useEffect(() => () => cardAbortRef.current?.abort(), []);
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
    /** A selection inside one answer or one narration offers the toolbar; anything else hides it. */
    const readSelection = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { setSelected(undefined); return; }
      const range = selection.getRangeAt(0);
      const body = selectableOf(range.startContainer);
      // Narration has no anchor: it offers what needs none (引用, the plugin items, 复制).
      const target = body?.hasAttribute('data-narration') ? undefined : body && markBodies.get(body);
      if (!body || (!target && !body.hasAttribute('data-narration')) || selectableOf(range.endContainer) !== body || !scroller.contains(body)) { setSelected(undefined); return; }
      const text = body.textContent ?? '';
      const start = textOffset(body, range.startContainer, range.startOffset);
      const end = textOffset(body, range.endContainer, range.endOffset);
      if (!quoteAt(text, start, end)) { setSelected(undefined); return; }
      const rect = range.getBoundingClientRect();
      setSelected({ target, text, start, end, range: range.cloneRange(), above: rect.top - scroller.getBoundingClientRect().top > 56 });
      setToolbarShown(true);
      closeCard();
    };
    /** The toolbar and the card sit inside the transcript; what happens in them is not the reader selecting text. */
    const floating = (event: Event) => event.target instanceof Node && Boolean(toolbarRef.current?.contains(event.target) || cardRef.current?.contains(event.target));
    // Shown once the pointer or the keyboard lets go, not while a drag is still extending it.
    const settled = (event: Event) => {
      if (floating(event)) return;
      if (!(event instanceof KeyboardEvent) || event.shiftKey || event.key === 'Shift') window.setTimeout(readSelection, 0);
    };
    const changed = () => { const selection = document.getSelection(); if (!selection || selection.isCollapsed) setSelected(undefined); };
    /** A click on painted text opens that highlight; there is no element to listen on. */
    const clicked = (event: MouseEvent) => {
      if (floating(event)) return;
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('a,button,input,textarea,[role="button"]'))) return;
      if (!document.getSelection()?.isCollapsed) return;
      const hit = resolved.current.find(({ range }) => [...range.getClientRects()].some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom));
      if (hit) { setEditing({ id: hit.mark.id, x: event.clientX, y: event.clientY }); setEditingOpen(true); }
    };
    scroller.addEventListener('mouseup', settled);
    scroller.addEventListener('keyup', settled);
    scroller.addEventListener('click', clicked);
    document.addEventListener('selectionchange', changed);
    return () => {
      scroller.removeEventListener('mouseup', settled);
      scroller.removeEventListener('keyup', settled);
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

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !marks) return;
    const host = document.createElement('div');
    host.style.position = 'relative';
    host.style.height = '0';
    scroller.prepend(host);
    setFloatHost(host);
    return () => { host.remove(); setFloatHost(undefined); };
  }, [scrollRef, Boolean(marks)]);

  useBesideRange(scrollRef, floatHost, toolbarRef, selected?.range, selected?.above, setToolbarShown);
  // The card does not come back: it was one answer, and asking again is one click.
  useBesideRange(scrollRef, floatHost, cardRef, card?.range, card?.above, (shown) => { if (!shown) closeCard(); });

  const cardOpen = Boolean(card);
  useEffect(() => {
    if (!cardOpen) return;
    const inModal = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('[role="dialog"], [role="listbox"], [role="menu"]'));
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) closeCard(); };
    // A click, not a press: a finger that scrolls the transcript presses outside too.
    const outside = (event: MouseEvent) => { if (!(event.target instanceof Node && cardRef.current?.contains(event.target)) && !inModal(event.target)) closeCard(); };
    window.addEventListener('keydown', escape);
    document.addEventListener('click', outside, true);
    return () => {
      window.removeEventListener('keydown', escape);
      document.removeEventListener('click', outside, true);
    };
  }, [cardOpen]);

  if (!marks) return null;
  const editingMark = editing && marks.marks.find((mark) => mark.id === editing.id);
  const highlight = (color: MarkColor) => {
    if (!selected?.target) return;
    lastColor = color;
    const quote = quoteAt(selected.text, selected.start, selected.end);
    if (quote) marks.highlight(selected.target, quote, color);
    document.getSelection()?.removeAllRanges();
    setSelected(undefined);
  };
  const share = () => {
    if (!selected?.target || !session) return;
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
  const quote = () => {
    const selection = document.getSelection();
    if (!selected || !onQuote || !selection?.rangeCount) return;
    const text = selection.toString() || selected.text.slice(selected.start, selected.end);
    if (text.trim()) onQuote(quoteOf(selection.getRangeAt(0), text));
    selection.removeAllRanges();
    setSelected(undefined);
  };
  const executeSelectionCommand = async (command: PluginCommand, range: Range, selectionInput: CommandSelection) => {
    cardAbortRef.current?.abort();
    const controller = new AbortController();
    cardAbortRef.current = controller;
    const outcome = await selectionCommands.run(command, selectionInput, controller.signal, (text, title) => {
      if (controller.signal.aborted) return;
      setCard((current) => {
        if (current?.range !== range || current.closing) return current;
        return { ...current, running: true, text, ...(title ? { title } : {}) };
      });
    });
    if (controller.signal.aborted) return;
    // Closed, or replaced by another, meanwhile: the answer is not wanted.
    setCard((current) => {
      if (current?.range !== range || current.closing) return current;
      if (outcome.kind === 'text') {
        const { error: _error, chooseModel: _chooseModel, ...rest } = current;
        return { ...rest, running: false, text: outcome.text, ...(outcome.title ? { title: outcome.title } : {}) };
      }
      if (outcome.kind === 'failed') {
        const { text: _text, ...rest } = current;
        return { ...rest, running: false, error: outcome.error, ...(outcome.chooseModel ? { chooseModel: outcome.chooseModel } : { chooseModel: undefined }) };
      }
      return { ...current, closing: true };
    });
  };
  const runCommand = async (command: PluginCommand) => {
    const selection = document.getSelection();
    if (!selected || !selection?.rangeCount) return;
    const text = (selection.toString() || selected.text.slice(selected.start, selected.end)).trim();
    if (!text) return;
    const range = selection.getRangeAt(0).cloneRange();
    const runId = selected.target?.anchor.runId;
    const selectionInput: CommandSelection = { text, ...(runId ? { runId } : {}) };
    // The selection stays painted while the card is open, so the reader still sees what it is about.
    setSelected(undefined);
    const rect = range.getBoundingClientRect();
    const view = scrollRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const roomAbove = rect.top - view.top;
    const roomBelow = view.bottom - rect.bottom;
    const above = roomAbove > roomBelow;
    setCard({ command, range, selection: selectionInput, running: true, above, room: Math.max(160, Math.min(400, (above ? roomAbove : roomBelow) - 16)) });
    await executeSelectionCommand(command, range, selectionInput);
  };
  const retryCard = () => {
    if (!card || card.closing) return;
    const { command, range, selection: selectionInput, above, room } = card;
    setCard({ command, range, selection: selectionInput, running: true, above, room });
    void executeSelectionCommand(command, range, selectionInput);
  };
  // Above the selection, or below it when there was no room above.
  const above = selected?.above ?? true;
  const tipSide = above ? 'top' : 'bottom';
  const lead = Boolean(onQuote || (onDiscuss && selected?.target));
  const cardWidth = Math.min(448, (floatHost?.clientWidth ?? window.innerWidth) - 16);
  return (
    <>
      {selected && floatHost && createPortal(
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={t`选中文字操作`}
          inert={!toolbarShown}
          // Pressing a button must not collapse the selection it acts on.
          onMouseDown={(event) => event.preventDefault()}
          className={cn(
            'absolute z-(--z-menu) flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-0.5 rounded-xl bg-popover p-1 text-fg shadow-pop animate-in fade-in-0 transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
            above && '-translate-y-full',
            !toolbarShown && 'pointer-events-none opacity-0',
          )}
        >
          {onQuote && <Button size="sm" variant="quiet" className="no-hover:h-9" onClick={quote}><IconTextQuote /><Trans context="session-quote-action">引用</Trans></Button>}
          {onDiscuss && selected.target && <Button size="sm" variant="quiet" className="no-hover:h-9" onClick={() => {
            const quoted = quoteAt(selected.text, selected.start, selected.end);
            if (!quoted || !selected.target) return;
            onDiscuss({ anchor: selected.target.anchor, quote: quoted });
            document.getSelection()?.removeAllRanges();
            setSelected(undefined);
          }}><IconMessagesSquare /><Trans>侧边聊天</Trans></Button>}
          {lead && <span aria-hidden className="mx-1 h-4 w-px bg-line-strong" />}
          {selected.target && <HighlightButton above={above} onPick={highlight} />}
          {selectionCommands.commands.map((command) => {
            const Icon = commandIcon(command.icon);
            return <ToolbarIcon key={command.id} label={command.title} side={tipSide} onClick={() => void runCommand(command)}><Icon /></ToolbarIcon>;
          })}
          <ToolbarIcon label={t`复制`} side={tipSide} onClick={() => { void copyWithToast(document.getSelection()?.toString() ?? selected.text.slice(selected.start, selected.end)); setSelected(undefined); }}><IconCopy /></ToolbarIcon>
          {session && selected.target && <ToolbarIcon label={t`导出图片`} side={tipSide} onClick={share}><IconImageDown /></ToolbarIcon>}
        </div>,
        floatHost,
      )}
      {card && floatHost && createPortal(
        <MessageCommandBlock
          ref={cardRef}
          icon={card.command.icon}
          title={card.title ?? card.command.title}
          running={card.running ?? (card.text === undefined && card.error === undefined)}
          {...(card.text !== undefined ? { text: card.text } : {})}
          {...(card.error !== undefined ? {
            error: card.error,
            onRetry: retryCard,
            ...(card.chooseModel && selectionCommands.openModelSettings ? {
              action: { label: t`选择模型`, onClick: () => selectionCommands.openModelSettings!(card.chooseModel!) },
            } : {}),
          } : {})}
          onClose={closeCard}
          onAnimationEnd={(event) => { if (card.closing && event.target === event.currentTarget) setCard(undefined); }}
          className={cn(
            'absolute z-(--z-menu) -translate-x-1/2 bg-popover shadow-pop',
            card.above ? '-translate-y-full origin-bottom' : 'origin-top',
            card.closing
              ? 'pointer-events-none animate-out fill-mode-forwards fade-out-0 zoom-out-[var(--enter-scale)] duration-[var(--duration-exit-fast)] ease-[var(--ease-accelerate)]'
              : 'animate-in fade-in-0 zoom-in-[var(--enter-scale)] duration-[var(--duration-fast)] ease-[var(--ease-decelerate)]',
          )}
          style={{ width: cardWidth, maxHeight: card.room }}
        />,
        floatHost,
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
