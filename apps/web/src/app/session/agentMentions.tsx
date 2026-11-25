import { Fragment, useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import { isAssistantBackend, type AgentMember, type AgentMention, type NativeBackendCatalogEntry, type NativeBackendId } from '@contracts';
import { api, isAgentReference, isFileReference, isSessionReference, type AgentContextReference, type PromptContextReference } from '@/lib/api';
import { backendLabel } from '@/lib/backends';
import { useAgentModelChoice, type AgentModelValue } from './agentModelChoice';
import { splitBareUrls } from './bareUrls';
import { ModelPicker } from './ModelPicker';

/*
 * The team members and Agents `@` offers (docs/AGENT-CALLS.md §6, docs/TEAM.md §4.3). A mention is written into
 * the message itself (`@ArchAgent 发版` or `@Claude`), drawn as a mark where it stands. Agent mentions open the
 * composer's model menu; team member mentions run on the member's own configured rules, memory, and model.
 */

/** One team member or Agent the `@` menu lists. */
export interface AgentMentionCandidate { backendId: NativeBackendId; label: string; member?: AgentMember }

/** What the composer needs to offer team members and Agents: the available backends, team members, and where. */
export interface AgentMentionSource {
  projectId: string;
  backends: readonly NativeBackendCatalogEntry[];
  members?: readonly AgentMember[];
  currentMemberId?: string;
}

/** The team members (first) and Agents `@` can name, quick chat and current self left out. */
export function agentMentionCandidates(
  backends: readonly NativeBackendCatalogEntry[],
  members: readonly AgentMember[] = [],
  currentMemberId?: string,
): AgentMentionCandidate[] {
  const available = backends.filter(entry => entry.backendId !== 'chat' && entry.available);
  const fallbackBackend: NativeBackendId = available.find(entry => isAssistantBackend(entry.backendId))?.backendId ?? available[0]?.backendId ?? 'claude';
  const memberItems: AgentMentionCandidate[] = members
    .filter(member => !member.archivedAt && member.id !== currentMemberId)
    .map(member => ({
      backendId: member.target?.backendId ?? fallbackBackend,
      label: member.name,
      member,
    }));
  const backendItems: AgentMentionCandidate[] = available.map(entry => ({ backendId: entry.backendId, label: backendLabel(entry.backendId) }));
  return [...memberItems, ...backendItems];
}

/** What a mention reads as in the message. */
export const mentionText = (label: string) => `@${label}`;

/** Characters immediately before `@` that indicate an email or ASCII identifier rather than a mention. */
const BEFORE_MENTION_REJECT = /[A-Za-z0-9._%+-]/;
/** Characters immediately after an ASCII mention label that continue the same ASCII identifier or path. */
const AFTER_MENTION_REJECT = /[A-Za-z0-9_.-]/;

/** Every place one of `labels` is written as a mention, in text order; `index` names the label. */
export function mentionRanges(text: string, labels: readonly string[]): Array<{ start: number; end: number; index: number }> {
  const candidates: Array<{ start: number; end: number; index: number; beforeBlocked: boolean }> = [];
  labels.forEach((label, index) => {
    if (!label) return;
    const token = mentionText(label);
    const endsWithAsciiIdent = AFTER_MENTION_REJECT.test(label[label.length - 1]!);
    for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + token.length)) {
      const before = at === 0 ? '' : text[at - 1]!;
      const after = text[at + token.length];
      if (endsWithAsciiIdent && after !== undefined && AFTER_MENTION_REJECT.test(after)) continue;
      candidates.push({ start: at, end: at + token.length, index, beforeBlocked: Boolean(before && BEFORE_MENTION_REJECT.test(before)) });
    }
  });
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const ranges: Array<{ start: number; end: number; index: number }> = [];
  const acceptedEnds = new Set<number>();
  let cursor = 0;
  for (const item of candidates) {
    if (item.start < cursor) continue;
    // Adjacent mentions like `@Claude@Codex` are valid when immediately following an accepted mention.
    if (item.beforeBlocked && !acceptedEnds.has(item.start)) continue;
    ranges.push({ start: item.start, end: item.end, index: item.index });
    acceptedEnds.add(item.end);
    cursor = item.end;
  }
  return ranges;
}

/** The text with the mentions in it drawn as marks; `plain` renders what lies between them. */
export function withMentionMarks(text: string, labels: readonly string[], mark: (text: string, index: number, key: number) => ReactNode, plain: (text: string) => ReactNode = value => value): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of mentionRanges(text, labels)) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push(<Fragment key={`t${cursor}`}>{plain(text.slice(cursor, range.start))}</Fragment>);
    parts.push(mark(text.slice(range.start, range.end), range.index, range.start));
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(<Fragment key={`t${cursor}`}>{plain(text.slice(cursor))}</Fragment>);
  return parts;
}

/** The label an Agent or team member mention is written by. */
export const mentionLabel = (mention: Pick<AgentMention, 'backendId' | 'memberId' | 'label'>) => mention.memberId ? (mention.label || mention.memberId) : backendLabel(mention.backendId);

/** The label an Agent or team member reference is written by. */
export const referenceLabel = (reference: AgentContextReference) => mentionLabel(reference);

/** The inline `@label` a reference is written by in the draft, or `undefined` if it cannot be inline (e.g. file with line number). */
export function inlineReferenceLabel(reference: PromptContextReference): string | undefined {
  if (isAgentReference(reference)) return referenceLabel(reference);
  if (isSessionReference(reference)) return reference.title || reference.sessionId;
  return reference.line === undefined ? reference.path : undefined;
}

/** Whether `reference` is currently represented inline in `text` (so it does not also need a top chip). */
export function isInlineReference(text: string, reference: PromptContextReference, allReferences?: readonly PromptContextReference[]): boolean {
  if (isAgentReference(reference)) return true;
  if (allReferences) {
    const idx = allReferences.indexOf(reference);
    if (idx >= 0) return inlineMentionRanges(text, allReferences).some(range => range.index === idx);
  }
  const label = inlineReferenceLabel(reference);
  return Boolean(label && mentionRanges(text, [label]).length > 0);
}

/** Whether a reference should be dropped if its inline `@label` is edited out of `text`. */
function isInlineOwnedReference(reference: PromptContextReference): boolean {
  return isAgentReference(reference) || (isSessionReference(reference) || isFileReference(reference)) && reference.inline === true;
}

/** Keep only references that are either non-inline chips or still written in `text` (using longest-first non-overlapping ranges). */
export function keepWrittenReferences(text: string, references: readonly PromptContextReference[]): PromptContextReference[] {
  const matched = new Set(inlineMentionRanges(text, references).map(range => range.index));
  return references.filter((reference, index) => !isInlineOwnedReference(reference) || matched.has(index));
}

/** Whether any inline-owned reference was edited out of `text`. */
export function droppedMentions(text: string, references: readonly PromptContextReference[]): boolean {
  return keepWrittenReferences(text, references).length !== references.length;
}

/** The composer's mark for a mention; a 2px halo gives breathing room without shifting textarea mirror layout. */
const MARK = 'rounded-sm bg-accent-soft ring-2 ring-accent-soft';
/** Matches `.md a` (`docs/design/DECISIONS.md` 2026-11-18): accent text with an always-visible subtle underline. */
const LINK = 'text-accent underline decoration-line-strong decoration-1 underline-offset-3 hover:decoration-accent';

function renderBareLinks(text: string): ReactNode {
  const parts = splitBareUrls(text);
  if (parts.length === 1 && !parts[0]!.href) return text;
  return parts.map((part, index) => (
    part.href
      ? <a key={index} href={part.href} target="_blank" rel="noreferrer noopener" className={LINK}>{part.text}</a>
      : <Fragment key={index}>{part.text}</Fragment>
  ));
}

/** A sent message's inline mentions (`@member`, `@Agent`, `@file`, `@session`) drawn where they were written; bare web links stay clickable while other formatting stays plain text. */
export function MessageWithMentions({ text, agents, files, sessions }: {
  text: string;
  agents?: readonly AgentMention[];
  files?: readonly { path: string; line?: number }[];
  sessions?: readonly { title?: string; sessionId: string }[];
}) {
  const labels = [
    ...(agents?.map(agent => mentionLabel(agent)) ?? []),
    ...(files?.flatMap(file => file.line === undefined ? [file.path] : []) ?? []),
    ...(sessions?.map(session => session.title || session.sessionId) ?? []),
  ];
  if (!labels.length) return <>{renderBareLinks(text)}</>;
  return <>{withMentionMarks(text, labels, (value, _index, key) => <mark key={key} className={`${MARK} text-fg`}>{value}</mark>, renderBareLinks)}</>;
}

/** The Agents a message mentioned that its text does not name; older messages carried them beside the text. */
export function unwrittenMentions(text: string, agents?: readonly AgentMention[]): AgentMention[] {
  if (!agents?.length) return [];
  const matched = new Set(mentionRanges(text, agents.map(mentionLabel)).map(range => range.index));
  return agents.filter((_agent, index) => !matched.has(index));
}

/** The model menu of one mention, opened from where the mention is written. */
export function AgentMentionPicker({ reference, source, open, onOpenChange, onChange }: {
  reference: AgentContextReference;
  source: AgentMentionSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (next: AgentContextReference) => void;
}) {
  const { t } = useLingui();
  const choice: AgentModelValue = {
    backendId: reference.backendId,
    ...(reference.backendProfileId ? { profileId: reference.backendProfileId } : {}),
    ...(reference.model ? { model: reference.model } : {}),
  };
  const { picker, pick, params, withParam } = useAgentModelChoice({ projectId: source.projectId, backends: source.backends, choice });
  const profiles = source.backends.find(entry => entry.backendId === reference.backendId)?.profiles ?? [];
  const profileId = reference.backendProfileId ?? profiles.find(profile => profile.isDefault)?.id ?? profiles[0]?.id;
  const apply = (next: AgentModelValue | undefined) => {
    if (!next) return;
    onChange({
      kind: 'agent', backendId: next.backendId,
      ...(next.profileId ? { backendProfileId: next.profileId } : {}), ...(next.model ? { model: next.model } : {}),
      ...(reference.label ? { label: reference.label } : {}),
    });
  };
  return (
    <ModelPicker
      side="bottom"
      align="start"
      placeholder={t`自动`}
      {...picker}
      params={reference.model ? params : []}
      leading={null}
      open={open}
      onOpenChange={onOpenChange}
      // The trigger lies over the written mention, unseen: the mark is what is pointed at.
      className="pointer-events-none size-full p-0 opacity-0"
      onChange={id => apply(pick(id))}
      onParamChange={(id, value) => apply(withParam(id, value))}
      loadUsage={signal => api.backendUsage(reference.backendId, { ...(source.projectId ? { projectId: source.projectId } : {}), ...(profileId ? { profileId } : {}) }, signal)}
      usageScopeKey={`agent-mention|${reference.backendId}|${profileId ?? ''}|${source.projectId}`}
    />
  );
}

interface Box { top: number; left: number; width: number; height: number; style: Record<string, string> }

/** The textarea's box and the type that lays out its text, which the layer beneath it copies. */
function measure(textarea: HTMLTextAreaElement): Box {
  const computed = getComputedStyle(textarea);
  const style: Record<string, string> = {};
  for (const name of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'textIndent'] as const) style[name] = computed[name];
  return { top: textarea.offsetTop, left: textarea.offsetLeft, width: textarea.clientWidth, height: textarea.clientHeight, style };
}

/**
 * The layer under the composer's textarea that marks inline `@` references (`@member`, `@Agent`,
 * `@file`, `@session`) and invoked `/command` / `/skill` tokens, plus the model menu a raw Agent
 * mention opens. The textarea keeps the text, caret, selection, undo and input methods; this only
 * copies its layout, so each mark lies exactly under its words.
 */
export function ComposerMentionLayer({ textareaRef, text, references, slashRanges = [], source, openIndex, onOpenIndex, onChangeReference }: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  references: readonly PromptContextReference[];
  slashRanges?: readonly { start: number; end: number }[];
  source?: AgentMentionSource;
  /** The reference whose menu is open, by its index in `references`. */
  openIndex: number | undefined;
  onOpenIndex: (index: number | undefined) => void;
  onChangeReference: (index: number, next: PromptContextReference) => void;
}) {
  const inlineRefs = useMemo(
    () => references.flatMap((reference, index) => {
      const label = inlineReferenceLabel(reference);
      return label ? [{ reference, index, label }] : [];
    }),
    [references],
  );
  const marks = useMemo(() => {
    const items: Array<{ start: number; end: number; mentionIndex?: number }> = [];
    const refLabels = inlineRefs.map((entry) => entry.label);
    for (const range of mentionRanges(text, refLabels)) {
      items.push({ start: range.start, end: range.end, mentionIndex: inlineRefs[range.index]!.index });
    }
    for (const range of slashRanges) {
      items.push({ start: range.start, end: range.end });
    }
    items.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: typeof items = [];
    let cursor = 0;
    for (const item of items) {
      if (item.start < cursor) continue;
      merged.push(item);
      cursor = item.end;
    }
    return merged;
  }, [text, inlineRefs, slashRanges]);
  const [box, setBox] = useState<Box>();
  const [scrollTop, setScrollTop] = useState(0);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; height: number }>();
  const hasMarks = marks.length > 0;
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !hasMarks) { setBox(undefined); return; }
    const update = () => setBox(measure(textarea));
    const scrolled = () => setScrollTop(textarea.scrollTop);
    update(); scrolled();
    const observer = new ResizeObserver(update);
    observer.observe(textarea);
    textarea.addEventListener('scroll', scrolled, { passive: true });
    return () => { observer.disconnect(); textarea.removeEventListener('scroll', scrolled); };
  }, [textareaRef, hasMarks]);
  // Scrolled with the textarea, so a mark stays under its words.
  useLayoutEffect(() => { if (layer) layer.scrollTop = scrollTop; }, [layer, scrollTop, text, box]);
  // The open menu hangs from its mention's first mark.
  const openAgent = useMemo(() => {
    const openRef = openIndex === undefined ? undefined : references[openIndex];
    return openRef && isAgentReference(openRef) && !openRef.memberId ? { reference: openRef, index: openIndex! } : undefined;
  }, [openIndex, references]);
  const openAgentIndex = openAgent?.index;
  useLayoutEffect(() => {
    if (openAgentIndex === undefined || !layer || !box) {
      setAnchor(prev => (prev === undefined ? prev : undefined));
      return;
    }
    const mark = layer.querySelector<HTMLElement>(`[data-mention="${openAgentIndex}"]`);
    if (!mark) {
      setAnchor(prev => (prev === undefined ? prev : undefined));
      return;
    }
    const next = { top: box.top + mark.offsetTop - scrollTop, left: box.left + mark.offsetLeft, width: mark.offsetWidth, height: mark.offsetHeight };
    setAnchor(prev => (prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.height === next.height ? prev : next));
  }, [openAgentIndex, layer, box, scrollTop, text]);
  if (!box || !hasMarks) return null;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const item of marks) {
    if (item.start > cursor) parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor, item.start)}</Fragment>);
    parts.push(
      <mark key={`m${item.start}`} data-mention={item.mentionIndex} className={`${MARK} text-transparent`}>
        {text.slice(item.start, item.end)}
      </mark>,
    );
    cursor = item.end;
  }
  if (cursor < text.length) parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor)}</Fragment>);
  return (
    <>
      <div
        ref={setLayer}
        aria-hidden
        className="pointer-events-none absolute overflow-hidden whitespace-pre-wrap break-words text-transparent"
        style={{ top: box.top, left: box.left, width: box.width, height: box.height, ...box.style }}
      >
        {parts}
        {/* A trailing newline still takes its line, as it does in the textarea. */}
        {'\u200b'}
      </div>
      {source && openAgent && anchor && (
        <div className="pointer-events-none absolute" style={anchor}>
          <AgentMentionPicker
            reference={openAgent.reference}
            source={source}
            open
            onOpenChange={next => { if (!next) { onOpenIndex(undefined); requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true })); } }}
            onChange={next => onChangeReference(openAgent.index, next)}
          />
        </div>
      )}
    </>
  );
}

/** One non-overlapping inline `@` reference range in the draft, with its index in `references`. */
export interface InlineMentionRange { index: number; start: number; end: number }

/** Every non-overlapping inline `@` reference (`@member`, `@Agent`, `@file`, `@session`) in text order. */
export function inlineMentionRanges(text: string, references: readonly PromptContextReference[]): InlineMentionRange[] {
  const inlineRefs = references.flatMap((reference, index) => {
    const label = inlineReferenceLabel(reference);
    return label ? [{ index, label }] : [];
  });
  if (!inlineRefs.length) return [];
  const merged: InlineMentionRange[] = [];
  let cursor = 0;
  for (const range of mentionRanges(text, inlineRefs.map(entry => entry.label))) {
    if (range.start < cursor) continue;
    merged.push({ index: inlineRefs[range.index]!.index, start: range.start, end: range.end });
    cursor = range.end;
  }
  return merged;
}

/** The inline reference range (`@member`, `@Agent`, `@file`, `@session`) a caret position stands in. */
export function inlineMentionRangeAt(text: string, references: readonly PromptContextReference[], position: number): InlineMentionRange | undefined {
  return inlineMentionRanges(text, references).find(range => position >= range.start && position < range.end);
}

/** The inline reference a caret position stands in, by its index in `references`. */
export function mentionAt(text: string, references: readonly PromptContextReference[], position: number): number | undefined {
  return inlineMentionRangeAt(text, references, position)?.index;
}

/**
 * Keeps a textarea selection strictly outside the interior of atomic `@` mentions:
 * - A collapsed caret inside `(start, end)` snaps to `start` or `end` (by travel direction or nearest edge).
 * - A non-collapsed selection that starts or ends inside a mention expands to encompass the full mention.
 */
export function snapAtomicSelection(
  text: string,
  references: readonly PromptContextReference[],
  start: number,
  end: number,
  bias: 'left' | 'right' | 'nearest' = 'nearest',
): { start: number; end: number } {
  const ranges = inlineMentionRanges(text, references);
  if (!ranges.length) return { start, end };
  if (start === end) {
    const inside = ranges.find(range => start > range.start && start < range.end);
    if (!inside) return { start, end };
    const edge = bias === 'left'
      ? inside.start
      : bias === 'right'
        ? inside.end
        : (start - inside.start) <= (inside.end - start) ? inside.start : inside.end;
    return { start: edge, end: edge };
  }
  let nextStart = start;
  let nextEnd = end;
  for (const range of ranges) {
    if (nextStart > range.start && nextStart < range.end) nextStart = range.start;
    if (nextEnd > range.start && nextEnd < range.end) nextEnd = range.end;
  }
  return { start: nextStart, end: nextEnd };
}

/**
 * Computes the next selection when pressing ArrowLeft / ArrowRight across an atomic `@` mention.
 * Returns `undefined` when the browser's default caret movement stays outside every mention.
 */
export function stepAtomicArrow(
  text: string,
  references: readonly PromptContextReference[],
  start: number,
  end: number,
  direction: 'forward' | 'backward' | 'none' | null,
  key: 'ArrowLeft' | 'ArrowRight',
  shift: boolean,
): { start: number; end: number; direction?: 'forward' | 'backward' | 'none' } | undefined {
  const ranges = inlineMentionRanges(text, references);
  if (!ranges.length) return undefined;
  if (!shift) {
    if (start !== end) return undefined;
    if (key === 'ArrowLeft') {
      const hit = ranges.find(range => start > range.start && start <= range.end);
      return hit ? { start: hit.start, end: hit.start } : undefined;
    }
    const hit = ranges.find(range => start >= range.start && start < range.end);
    return hit ? { start: hit.end, end: hit.end } : undefined;
  }
  const anchor = start === end ? start : (direction === 'backward' ? end : start);
  const focus = start === end ? start : (direction === 'backward' ? start : end);
  let nextFocus: number | undefined;
  if (key === 'ArrowLeft') {
    const hit = ranges.find(range => focus > range.start && focus <= range.end);
    if (hit) nextFocus = hit.start;
  } else {
    const hit = ranges.find(range => focus >= range.start && focus < range.end);
    if (hit) nextFocus = hit.end;
  }
  if (nextFocus === undefined) return undefined;
  return {
    start: Math.min(anchor, nextFocus),
    end: Math.max(anchor, nextFocus),
    direction: nextFocus < anchor ? 'backward' : 'forward',
  };
}

/**
 * Returns the exact `[start, end]` span to delete when pressing Backspace / Delete against an atomic
 * `@` mention (either collapsed at its edge/interior, or a selection that partially intersects a mention).
 */
export function atomicDeleteRange(
  text: string,
  references: readonly PromptContextReference[],
  start: number,
  end: number,
  key: 'Backspace' | 'Delete',
): { start: number; end: number } | undefined {
  if (start === end) {
    const probe = key === 'Backspace' ? start - 1 : start;
    if (probe < 0) return undefined;
    const hit = inlineMentionRangeAt(text, references, probe);
    return hit ? { start: hit.start, end: hit.end } : undefined;
  }
  const snapped = snapAtomicSelection(text, references, start, end);
  if (snapped.start !== start || snapped.end !== end) return snapped;
  return undefined;
}
