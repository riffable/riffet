import { useEffect, useRef, type Dispatch, type MouseEvent as ReactMouseEvent, type MutableRefObject, type SetStateAction, type SyntheticEvent } from 'react';
import { isAgentReference, type PromptContextReference } from '@/lib/api';
import {
  inlineMentionRangeAt,
  inlineMentionRanges,
  inlineReferenceLabel,
  keepWrittenReferences,
  mentionRanges,
  snapAtomicSelection,
  type AgentMentionSource,
} from './agentMentions';

/**
 * Keeps inline `@` mentions (`@member`, `@Agent`, `@file`, `@session`) atomic inside the composer's
 * `<textarea>`: prevents clicks/selections from resting inside a mention, opens the raw Agent model
 * picker on click, defers dropping references during IME composition, and restores dropped inline
 * references when `⌘Z` brings their `@label` text back.
 */
export function useComposerAtomicMentions({
  storageKey,
  referencesRef,
  updateReferences,
  agentMentions,
  setMentionMenu,
  syncTrigger,
}: {
  storageKey?: string;
  referencesRef: MutableRefObject<PromptContextReference[]>;
  updateReferences: (next: PromptContextReference[]) => void;
  agentMentions?: AgentMentionSource;
  setMentionMenu: Dispatch<SetStateAction<number | undefined>>;
  syncTrigger: (value: string, caret: number) => void;
}) {
  const composingRef = useRef(false);
  const pointerSelectingRef = useRef(false);
  const selectionBiasRef = useRef<'left' | 'right' | undefined>(undefined);
  const clickedAgentMentionRef = useRef<number | undefined>(undefined);
  const droppedInlineRefsRef = useRef<PromptContextReference[]>([]);

  useEffect(() => { droppedInlineRefsRef.current = []; }, [storageKey]);

  const dropUnwrittenMentions = (value: string) => {
    if (composingRef.current) return;
    const current = referencesRef.current;
    const kept = keepWrittenReferences(value, current);
    if (kept.length !== current.length) {
      const keptSet = new Set(kept);
      const dropped = current.filter(item => !keptSet.has(item));
      const existingLabels = new Set(dropped.map(inlineReferenceLabel).filter((item): item is string => Boolean(item)));
      droppedInlineRefsRef.current = [
        ...dropped,
        ...droppedInlineRefsRef.current.filter(item => {
          const label = inlineReferenceLabel(item);
          return !label || !existingLabels.has(label);
        }),
      ].slice(0, 16);
    }
    const keptLabels = new Set(kept.map(inlineReferenceLabel).filter((item): item is string => Boolean(item)));
    const occupied = inlineMentionRanges(value, kept);
    const restored: PromptContextReference[] = [];
    const remainingStash: PromptContextReference[] = [];
    for (const item of droppedInlineRefsRef.current) {
      const label = inlineReferenceLabel(item);
      const freeHit = label && !keptLabels.has(label)
        ? mentionRanges(value, [label]).find(hit => !occupied.some(occ => hit.start < occ.end && hit.end > occ.start))
        : undefined;
      if (freeHit) {
        restored.push(item);
        keptLabels.add(label!);
        occupied.push({ index: -1, start: freeHit.start, end: freeHit.end });
      } else {
        remainingStash.push(item);
      }
    }
    if (restored.length) droppedInlineRefsRef.current = remainingStash;
    if (kept.length !== current.length || restored.length > 0) {
      updateReferences([...kept, ...restored]);
    }
  };

  const resetDroppedMentions = () => { droppedInlineRefsRef.current = []; };
  const setSelectionBias = (bias: 'left' | 'right' | undefined) => { selectionBiasRef.current = bias; };
  const onCompositionStart = () => { composingRef.current = true; };
  const onCompositionEnd = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    dropUnwrittenMentions(event.currentTarget.value);
    syncTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
  };
  const onPointerDown = () => { pointerSelectingRef.current = true; clickedAgentMentionRef.current = undefined; };
  const onKeyDownStart = () => { pointerSelectingRef.current = false; clickedAgentMentionRef.current = undefined; };
  const onBlurReset = () => {
    composingRef.current = false;
    pointerSelectingRef.current = false;
    clickedAgentMentionRef.current = undefined;
  };

  const onClick = (event: ReactMouseEvent<HTMLTextAreaElement>) => {
    pointerSelectingRef.current = false;
    const pendingAgent = clickedAgentMentionRef.current;
    clickedAgentMentionRef.current = undefined;
    const element = event.currentTarget;
    if (element.selectionStart !== element.selectionEnd) return;
    if (pendingAgent !== undefined && agentMentions) {
      setMentionMenu(pendingAgent);
      return;
    }
    const pos = element.selectionStart;
    const hit = inlineMentionRangeAt(element.value, referencesRef.current, pos);
    if (!hit) return;
    const ref = referencesRef.current[hit.index];
    const isRawAgent = Boolean(agentMentions && ref && isAgentReference(ref) && !ref.memberId);
    if (isRawAgent) setMentionMenu(hit.index);
    if (pos > hit.start && pos < hit.end) {
      const edge = isRawAgent ? hit.end : ((pos - hit.start) <= (hit.end - pos) ? hit.start : hit.end);
      element.setSelectionRange(edge, edge);
    }
  };

  const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const bias = selectionBiasRef.current ?? 'nearest';
    selectionBiasRef.current = undefined;
    if (document.activeElement === element && !composingRef.current) {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      if (start === end && pointerSelectingRef.current && agentMentions) {
        const inside = inlineMentionRangeAt(element.value, referencesRef.current, start);
        const ref = inside ? referencesRef.current[inside.index] : undefined;
        if (inside && start > inside.start && start < inside.end && ref && isAgentReference(ref) && !ref.memberId) {
          clickedAgentMentionRef.current = inside.index;
          element.setSelectionRange(inside.end, inside.end);
          syncTrigger(element.value, inside.end);
          return;
        }
      }
      const snapped = snapAtomicSelection(element.value, referencesRef.current, start, end, bias);
      if (snapped.start !== start || snapped.end !== end) {
        element.setSelectionRange(snapped.start, snapped.end, element.selectionDirection ?? undefined);
        syncTrigger(element.value, snapped.start);
        return;
      }
    }
    syncTrigger(element.value, element.selectionStart);
  };

  return {
    dropUnwrittenMentions,
    resetDroppedMentions,
    setSelectionBias,
    onCompositionStart,
    onCompositionEnd,
    onPointerDown,
    onKeyDownStart,
    onBlurReset,
    onClick,
    onSelect,
  };
}
