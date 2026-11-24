import { Fragment, useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { AgentMention, NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import { api, isAgentReference, type AgentContextReference, type PromptContextReference } from '@/lib/api';
import { backendLabel } from '@/lib/backends';
import { useAgentModelChoice, type AgentModelValue } from './agentModelChoice';
import { splitBareUrls } from './bareUrls';
import { ModelPicker } from './ModelPicker';

/*
 * The Agents `@` offers (docs/AGENT-CALLS.md §6). A mention is written into the message itself (`@Claude`), drawn as a
 * mark where it stands, and leads to the composer's own model menu, which pins the provider, model and parameters the
 * call runs on. A mention left on 自动 lets the calling Agent choose.
 */

/** One Agent the `@` menu lists. */
export interface AgentMentionCandidate { backendId: NativeBackendId; label: string }

/** What the composer needs to offer Agents and their model menus: the Agents a conversation can be opened on, and where. */
export interface AgentMentionSource { projectId: string; backends: readonly NativeBackendCatalogEntry[] }

/** The Agents `@` can name, quick chat left out; their providers are picked on the mention. */
export function agentMentionCandidates(backends: readonly NativeBackendCatalogEntry[]): AgentMentionCandidate[] {
  // The name the rest of the interface calls it by, which a sent message's mention is found by too.
  return backends.filter(entry => entry.backendId !== 'chat' && entry.available).map(entry => ({ backendId: entry.backendId, label: backendLabel(entry.backendId) }));
}

/** What a mention reads as in the message. */
export const mentionText = (label: string) => `@${label}`;

/** Where a mention ends: the end of the text, a space or punctuation, so `@Claude` is not found inside `@Claudette`. */
const BOUNDARY = /[\s.,;:!?，。；：！？、)）\]】"'”’]/;

/** Every place one of `labels` is written as a mention, in text order; `index` names the label. */
export function mentionRanges(text: string, labels: readonly string[]): Array<{ start: number; end: number; index: number }> {
  const ranges: Array<{ start: number; end: number; index: number }> = [];
  labels.forEach((label, index) => {
    const token = mentionText(label);
    for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + token.length)) {
      const before = at === 0 ? '' : text[at - 1]!;
      const after = text[at + token.length];
      if ((before && !/\s/.test(before)) || (after !== undefined && !BOUNDARY.test(after))) continue;
      ranges.push({ start: at, end: at + token.length, index });
    }
  });
  return ranges.sort((a, b) => a.start - b.start);
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

/** The label an Agent reference is written by. */
export const referenceLabel = (reference: AgentContextReference) => backendLabel(reference.backendId);

/** The Agent references whose mention is no longer in the text: deleting `@Claude` takes the mention with it. */
export function droppedMentions(text: string, references: readonly PromptContextReference[]): boolean {
  const agents = references.filter(isAgentReference);
  return agents.some(reference => !mentionRanges(text, [referenceLabel(reference)]).length);
}

/** The composer's mark for a mention; the same as a search hit's (`SessionSearchDialog`). */
const MARK = 'rounded-sm bg-accent-soft';
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

/** A sent message's mentions drawn where they were written; bare web links stay clickable while other formatting stays plain text. */
export function MessageWithMentions({ text, agents }: { text: string; agents?: readonly AgentMention[] }) {
  if (!agents?.length) return <>{renderBareLinks(text)}</>;
  const labels = agents.map(agent => backendLabel(agent.backendId));
  return <>{withMentionMarks(text, labels, (value, _index, key) => <mark key={key} className={`${MARK} text-fg`}>{value}</mark>, renderBareLinks)}</>;
}

/** The Agents a message mentioned that its text does not name; older messages carried them beside the text. */
export function unwrittenMentions(text: string, agents?: readonly AgentMention[]): AgentMention[] {
  return (agents ?? []).filter(agent => !mentionRanges(text, [backendLabel(agent.backendId)]).length);
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
 * The layer under the composer's textarea that marks the mentions written in it, and the model menu a mention opens.
 * The textarea keeps the text, the caret, selection, undo and input methods; this only copies its layout, so each mark
 * lies exactly under its words. Clicking a mention, or ↓ with the caret in it, opens its menu there.
 */
export function ComposerMentionLayer({ textareaRef, text, references, source, openIndex, onOpenIndex, onChangeReference }: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  references: readonly PromptContextReference[];
  source: AgentMentionSource;
  /** The reference whose menu is open, by its index in `references`. */
  openIndex: number | undefined;
  onOpenIndex: (index: number | undefined) => void;
  onChangeReference: (index: number, next: PromptContextReference) => void;
}) {
  const agents = useMemo(() => references.flatMap((reference, index) => isAgentReference(reference) ? [{ reference, index }] : []), [references]);
  const labels = useMemo(() => agents.map(item => referenceLabel(item.reference)), [agents]);
  const [box, setBox] = useState<Box>();
  const [scrollTop, setScrollTop] = useState(0);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; height: number }>();
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !agents.length) { setBox(undefined); return; }
    const update = () => setBox(measure(textarea));
    const scrolled = () => setScrollTop(textarea.scrollTop);
    update(); scrolled();
    const observer = new ResizeObserver(update);
    observer.observe(textarea);
    textarea.addEventListener('scroll', scrolled, { passive: true });
    return () => { observer.disconnect(); textarea.removeEventListener('scroll', scrolled); };
  }, [textareaRef, agents.length]);
  // Scrolled with the textarea, so a mark stays under its words.
  useLayoutEffect(() => { if (layer) layer.scrollTop = scrollTop; }, [layer, scrollTop, text, box]);
  // The open menu hangs from its mention's first mark.
  const open = openIndex === undefined ? undefined : agents.find(item => item.index === openIndex);
  useLayoutEffect(() => {
    if (!open || !layer || !box) { setAnchor(undefined); return; }
    const mark = layer.querySelector<HTMLElement>(`[data-mention="${open.index}"]`);
    if (!mark) { setAnchor(undefined); return; }
    setAnchor({ top: box.top + mark.offsetTop - scrollTop, left: box.left + mark.offsetLeft, width: mark.offsetWidth, height: mark.offsetHeight });
  }, [open, layer, box, scrollTop, text]);
  if (!box || !agents.length) return null;
  return (
    <>
      <div
        ref={setLayer}
        aria-hidden
        className="pointer-events-none absolute overflow-hidden whitespace-pre-wrap break-words text-transparent"
        style={{ top: box.top, left: box.left, width: box.width, height: box.height, ...box.style }}
      >
        {withMentionMarks(text, labels, (value, index, key) => <mark key={key} data-mention={agents[index]!.index} className={`${MARK} text-transparent`}>{value}</mark>)}
        {/* A trailing newline still takes its line, as it does in the textarea. */}
        {'\u200b'}
      </div>
      {open && anchor && (
        <div className="pointer-events-none absolute" style={anchor}>
          <AgentMentionPicker
            reference={open.reference}
            source={source}
            open
            onOpenChange={next => { if (!next) { onOpenIndex(undefined); requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true })); } }}
            onChange={next => onChangeReference(open.index, next)}
          />
        </div>
      )}
    </>
  );
}

/** The Agent reference a caret position stands in, by its index in `references`. */
export function mentionAt(text: string, references: readonly PromptContextReference[], position: number): number | undefined {
  for (const [index, reference] of references.entries()) {
    if (!isAgentReference(reference)) continue;
    if (mentionRanges(text, [referenceLabel(reference)]).some(range => position >= range.start && position < range.end)) return index;
  }
  return undefined;
}
