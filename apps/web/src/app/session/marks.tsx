import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { Mark, MarkAnchor, MarkAsset, MarkColor, MarkQuote, MarkUpdateRequest, NativeWorkbenchEvent, WorkbenchEvent } from '@contracts';
import { IconBookmark, IconBookmarkFilled, IconBookmarkMinus, IconFileText, IconImage } from '@/components/icons';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { cn, newId, relativeTime } from '@/lib/utils';
import { InfoMore, InfoSection, infoRow } from '../SessionInfo';
import { useStores } from '../state/stores';
import { useStore } from '@/lib/store';
import { nativeEventIds, timelineItemTime, type TimelineItem } from './model';
import type { Turn } from './TurnRail';

export const MARK_COLORS: readonly MarkColor[] = ['yellow', 'green', 'blue', 'red'];
export const markColorLabels: Record<MarkColor, MessageDescriptor> = { yellow: msg`黄色`, green: msg`绿色`, blue: msg`蓝色`, red: msg`红色` };
/** The swatch for a color (styles/index.css); the highlight itself is painted by `::highlight(mark-<color>)`. */
export const markSwatch: Record<MarkColor, string> = { yellow: 'mark-swatch-yellow', green: 'mark-swatch-green', blue: 'mark-swatch-blue', red: 'mark-swatch-red' };

/** An answer that can be marked, including emitted streaming text: where it is and what to keep. */
export interface MarkTarget {
  /** Every id the message is known by: each source event's `nativeId` and aliases. */
  ids: string[];
  anchor: MarkAnchor;
  /** The answer as text, kept as the mark's snapshot. */
  text: string;
  at: string;
}

/**
 * Streaming ids may change when a provider commits its answer. The owning run and the quote
 * snapshot let the existing mark relocation recover the final message.
 */
export function markTargetOf(item: TimelineItem, fallbackRunId?: string): MarkTarget | undefined {
  if (item.kind !== 'assistant') return undefined;
  const events = [item.event, ...item.event.sourceEvents] as Array<WorkbenchEvent & Partial<NativeWorkbenchEvent>>;
  const primary = events.find((event) => typeof event.nativeId === 'string' && event.nativeId);
  if (!primary?.nativeId) return undefined;
  const runId = primary.runId ?? fallbackRunId;
  if (primary.nativeId.includes(':run:') && !runId) return undefined;
  const ids = [...new Set(events.flatMap(nativeEventIds))];
  return {
    ids,
    anchor: {
      messageId: primary.nativeId,
      ...(primary.nativeAliases?.length ? { aliases: primary.nativeAliases } : {}),
      ...(runId ? { runId } : {}),
      ...(primary.nativeTurnId ? { nativeTurnId: primary.nativeTurnId } : {}),
      sequence: primary.sequence,
    },
    text: item.text,
    at: timelineItemTime(item),
  };
}

/** The ids a mark's anchor names, its current one first. */
export const anchorIds = (mark: Mark) => [mark.anchor.messageId, ...(mark.anchor.aliases ?? [])];

/**
 * The prompts whose turn holds a mark. A loaded turn is found by the marked message itself; one
 * outside the loaded rows by the native turn or run its anchor names.
 */
export function markedTurns(marks: readonly Mark[], turns: readonly Turn[], timeline: readonly TimelineItem[]): Set<string> {
  const marked = new Set<string>();
  if (!marks.length) return marked;
  const prompts = new Set(turns.map((turn) => turn.key));
  const turnOfId = new Map<string, string>();
  let current: string | undefined;
  for (const item of timeline) {
    if (item.kind === 'user' && prompts.has(item.key)) current = item.key;
    else if (current) for (const event of [item.event, ...item.event.sourceEvents]) for (const id of nativeEventIds(event)) turnOfId.set(id, current);
  }
  const turnOfRef = new Map<string, string>();
  for (const turn of turns) for (const ref of turn.refs ?? []) turnOfRef.set(ref, turn.key);
  for (const mark of marks) {
    if (mark.state !== 'ok') continue;
    const key = anchorIds(mark).map((id) => turnOfId.get(id)).find(Boolean)
      ?? [mark.anchor.nativeTurnId, mark.anchor.runId].map((ref) => ref && turnOfRef.get(ref)).find(Boolean);
    if (key) marked.add(key);
  }
  return marked;
}

/** The Markdown body each markable answer renders into, so a selection can be traced back to its answer. */
export const markBodies = new WeakMap<Element, MarkTarget>();

/** The conversation's marks and the writes the transcript makes, for the rows that show them. */
export interface SessionMarks {
  sessionId: string;
  marks: readonly Mark[];
  /** The whole-reply mark of [target], if it has one. */
  messageMark: (target: MarkTarget) => Mark | undefined;
  toggleMessage: (target: MarkTarget) => void;
  highlight: (target: MarkTarget, quote: MarkQuote, color: MarkColor) => void;
  update: (id: string, body: MarkUpdateRequest) => void;
  remove: (id: string) => void;
  /** The image or file mark of [asset] at [anchor], if it has one. */
  assetMark: (anchor: MarkAnchor, kind: 'image' | 'file', asset: Pick<MarkAsset, 'name' | 'path'>) => Mark | undefined;
  /** Saves [asset] at [anchor]; `data` is an image's bytes, base64. */
  saveAsset: (anchor: MarkAnchor, kind: 'image' | 'file', asset: Omit<MarkAsset, 'stored' | 'bytes'> & { data?: string }, at: string) => Promise<Mark | undefined>;
}

/** Absent outside a conversation's own transcript: a subagent's messages are not this conversation's. */
export const SessionMarksContext = createContext<SessionMarks | undefined>(undefined);

/**
 * Reads [sessionId]'s marks while the conversation is open. [generation] is the native history
 * generation, stored with new marks so the server can tell when positional ids may have shifted.
 */
export function useSessionMarks(sessionId: string, generation: string | undefined): SessionMarks {
  const { t } = useLingui();
  const { marks: store } = useStores();
  useEffect(() => store.watch(sessionId), [store, sessionId]);
  const marks = useStore(store, (state) => state.sessionId === sessionId ? state.marks : undefined);
  return useMemo<SessionMarks>(() => {
    const list = marks ?? [];
    const byId = new Map<string, Mark>();
    for (const mark of list) if (mark.kind === 'message') for (const id of anchorIds(mark)) byId.set(id, mark);
    const messageMark = (target: MarkTarget) => target.ids.map((id) => byId.get(id)).find(Boolean);
    const anchor = (target: MarkTarget): MarkAnchor => ({ ...target.anchor, ...(generation ? { generation } : {}) });
    return {
      sessionId, marks: list, messageMark,
      toggleMessage: (target) => {
        const existing = messageMark(target);
        if (existing) { void store.remove([existing.id]).then((ok) => { if (ok) toast.success(t`已取消收藏`); }); return; }
        void store.create({ id: newId(), sessionId, kind: 'message', anchor: anchor(target), snapshot: { text: target.text, at: target.at } })
          .then((mark) => { if (mark) toast.success(t`已收藏回复`); });
      },
      highlight: (target, quote, color) => {
        void store.create({ id: newId(), sessionId, kind: 'span', anchor: anchor(target), quote, color, snapshot: { text: target.text, at: target.at } });
      },
      update: (id, body) => { void store.update(id, body); },
      remove: (id) => { void store.remove([id]); },
      assetMark: (target, kind, asset) => list.find((mark) => mark.kind === kind && mark.asset?.name === asset.name && (mark.asset.path ?? '') === (asset.path ?? '')
        && anchorIds(mark).some((id) => id === target.messageId || target.aliases?.includes(id))),
      saveAsset: (target, kind, asset, at) => store.create({ id: newId(), sessionId, kind, anchor: { ...target, ...(generation ? { generation } : {}) }, asset, snapshot: { text: asset.path ?? asset.name, at } }),
    };
  }, [store, sessionId, marks, generation]);
}

/** 收藏回复 / 取消收藏 in an answer's overflow menu. */
export function MarkMenuItem({ target }: { target?: MarkTarget }) {
  const { t } = useLingui();
  const marks = useContext(SessionMarksContext);
  if (!marks || !target) return null;
  const marked = Boolean(marks.messageMark(target));
  return (
    <DropdownMenuItem onSelect={() => marks.toggleMessage(target)}>
      {marked ? <IconBookmarkMinus /> : <IconBookmark />}{marked ? t`取消收藏` : t`收藏回复`}
    </DropdownMenuItem>
  );
}

/** The quiet sign under an answer that it is marked. */
export function MarkedIndicator({ target }: { target?: MarkTarget }) {
  const { t } = useLingui();
  const marks = useContext(SessionMarksContext);
  if (!marks || !target || !marks.messageMark(target)) return null;
  return <span role="img" aria-label={t`已收藏`} title={t`已收藏`} className="inline-flex px-1 text-accent"><IconBookmarkFilled className="size-3.5" /></span>;
}

/** What a mark shows in a list: the highlighted text, the saved file, or the start of the answer. */
export function markPreview(mark: Mark): string {
  const text = mark.quote?.exact ?? mark.asset?.path ?? mark.asset?.name ?? mark.snapshot.text;
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * The event a process item was drawn from, so image bookmarks stay on message content.
 * Absent elsewhere: an image outside a conversation's transcript has nowhere to lead back to.
 */
export const MarkSourceContext = createContext<WorkbenchEvent | undefined>(undefined);

/** Where an item is in its conversation, from its event's native ids; nothing for one still being written. */
export function sourceAnchor(event: WorkbenchEvent): MarkAnchor | undefined {
  const projected = event as WorkbenchEvent & { sourceEvents?: WorkbenchEvent[] };
  const events = [event, ...(projected.sourceEvents ?? [])] as Array<WorkbenchEvent & Partial<NativeWorkbenchEvent>>;
  const primary = events.find((candidate) => typeof candidate.nativeId === 'string' && candidate.nativeId);
  if (!primary?.nativeId || primary.nativeId.includes(':run:')) return undefined;
  return {
    messageId: primary.nativeId,
    ...(primary.nativeAliases?.length ? { aliases: primary.nativeAliases } : {}),
    ...(primary.runId ? { runId: primary.runId } : {}),
    ...(primary.nativeTurnId ? { nativeTurnId: primary.nativeTurnId } : {}),
    sequence: primary.sequence,
  };
}

/** A saved image travels whole, inline; past this the server refuses it. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function imageData(src: string): Promise<{ data: string; mimeType: string; bytes: number }> {
  const blob = await (await fetch(src)).blob();
  if (!blob.type.startsWith('image/') || blob.type.includes('svg')) throw new Error(i18n._(msg`只能收藏位图图片`));
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(i18n._(msg`图片超过 10 MB，无法收藏`));
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(i18n._(msg`读取图片失败`)));
    reader.readAsDataURL(blob);
  });
  return { data: url.slice(url.indexOf(',') + 1), mimeType: blob.type, bytes: blob.size };
}

/** A message image as a mark; tool results reuse the renderer without offering bookmarks. */
function useImageMark(asset: Pick<MarkAsset, 'name' | 'path'>) {
  const marks = useContext(SessionMarksContext);
  const event = useContext(MarkSourceContext);
  const anchor = useMemo(() => event ? sourceAnchor(event) : undefined, [event]);
  if (!marks || !event || !anchor) return undefined;
  if (event.type === 'tool_call' || event.type === 'tool_call_update') return undefined;
  const saved = marks.assetMark(anchor, 'image', asset);
  return { marks, anchor, saved, at: event.createdAt };
}

/**
 * The bookmark over a picture in the transcript, shown on hover and kept visible once saved.
 * Touch puts it below the picture so its 44px target cannot cover a small thumbnail.
 * The server keeps a copy, so the picture stays even when the file or the conversation is gone.
 */
export function SaveImageButton({ src, name, path }: { src: string; name: string; path?: string }) {
  const { t } = useLingui();
  const asset = { name, ...(path ? { path } : {}) };
  const state = useImageMark(asset);
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const { marks, anchor, saved, at } = state;
  const toggle = async () => {
    if (saved) { marks.remove(saved.id); toast.success(t`已取消收藏`); return; }
    setBusy(true);
    try {
      const image = await imageData(src);
      if (await marks.saveAsset(anchor, 'image', { ...asset, mimeType: image.mimeType, data: image.data }, at)) toast.success(t`已收藏图片`);
    } catch (error) { toast.error(error instanceof Error ? error.message : t`无法收藏图片`); }
    finally { setBusy(false); }
  };
  return (
    <Tip label={saved ? t`取消收藏` : t`收藏图片`}>
      <button
        type="button"
        aria-label={saved ? t`取消收藏` : t`收藏图片`}
        aria-pressed={Boolean(saved)}
        disabled={busy}
        onClick={(event) => { event.stopPropagation(); void toggle(); }}
        className={cn(
          'absolute right-2 top-2 grid size-7 place-items-center rounded-lg bg-elevated/90 text-fg-2 shadow-sm ring-1 ring-line backdrop-blur transition-opacity duration-150 hover:text-fg focus-visible:opacity-100 no-hover:static no-hover:mt-1 no-hover:ml-auto no-hover:size-11 no-hover:bg-transparent no-hover:shadow-none no-hover:ring-0 no-hover:backdrop-blur-none',
          saved ? 'text-accent opacity-100 hover:text-accent' : 'opacity-0 group-hover/image:opacity-100 no-hover:opacity-100',
        )}
      >
        <IconBookmark className="size-3.5" />
      </button>
    </Tip>
  );
}

function SessionMarkRow({ mark, onOpen }: { mark: Mark; onOpen: (mark: Mark) => void }) {
  return (
    <li>
      <button type="button" data-closes-overlay onClick={() => onOpen(mark)} className={infoRow}>
        <span className="grid size-3.5 place-items-center">
          {mark.kind === 'span' ? <span className={cn('size-2.5 rounded-full', markSwatch[mark.color ?? 'yellow'])} />
            : mark.kind === 'image' ? <IconImage className="size-3.5 text-fg-3" />
            : mark.kind === 'file' ? <IconFileText className="size-3.5 text-fg-3" />
            : <IconBookmark className="size-3.5 text-fg-3" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{markPreview(mark)}</span>
        <span className="text-xs tabular-nums text-fg-4">{relativeTime(mark.createdAt)}</span>
      </button>
    </li>
  );
}

/**
 * 本会话收藏: the session-info group listing this conversation's marks. It subscribes to the marks
 * store itself, so the header that hosts it is not rebuilt when a mark changes.
 */
export function SessionMarksSection({ sessionId }: { sessionId: string }) {
  const { t } = useLingui();
  const { marks: store, handlers } = useStores();
  const marks = useStore(store, (state) => state.sessionId === sessionId ? state.marks : undefined);
  const [expanded, setExpanded] = useState(false);
  if (!marks?.length) return null;
  const shown = expanded ? marks : marks.slice(0, 3);
  return (
    <InfoSection title={t`本会话收藏`} summary={marks.length}>
      <ul>{shown.map((mark) => <SessionMarkRow key={mark.id} mark={mark} onOpen={(item) => handlers.openMark(item.id)} />)}</ul>
      {marks.length > shown.length && <InfoMore hidden={marks.length - shown.length} onClick={() => setExpanded(true)} />}
    </InfoSection>
  );
}
