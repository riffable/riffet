import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, MutableRefObject, SetStateAction } from 'react';
import { isAgentReference, type PromptContextReference } from '@/lib/api';
import { mentionAt, mentionRanges, referenceLabel, type AgentMentionSource } from './agentMentions';
import { classifyEnterGesture, isComposingKey, resolveEnter, resolveEscapeLayer, type EnterKeyBehavior } from './composerKeyboard';
import type { Trigger } from './useComposerTrigger';

export function handleComposerKeyDown(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
  context: {
    dictating: boolean;
    dictationPhase: string;
    cancelDictation: () => void;
    finishDictation: () => void;
    browsing: string | undefined;
    trigger: Trigger | null;
    browseInto: (folderId?: string) => void;
    projectRowsCount: number;
    highlight: number;
    setHighlight: Dispatch<SetStateAction<number>>;
    filesCount: number;
    agentRowsCount: number;
    sessionFilesCount: number;
    menuLength: number;
    choose: (index: number) => void;
    agentMentions?: AgentMentionSource;
    referencesRef: MutableRefObject<PromptContextReference[]>;
    updateText: (next: string) => void;
    dropUnwrittenMentions: (value: string) => void;
    setMentionMenu: Dispatch<SetStateAction<number | undefined>>;
    menuOpen: boolean;
    dismissTrigger: (cursor: number) => void;
    textRef: MutableRefObject<string>;
    isMobile: boolean;
    keyBehavior: EnterKeyBehavior;
    submit: () => void;
  },
): void {
  // While dictating the draft is the recognizer's: Esc cancels and Enter finishes, nothing else edits it.
  if (context.dictating) {
    if (event.key === 'Escape') { event.preventDefault(); context.cancelDictation(); }
    else if (event.key === 'Enter' && context.dictationPhase === 'recording') { event.preventDefault(); context.finishDictation(); }
    return;
  }
  // Both composition signals once: the legacy one (229) is what some engines report
  // instead of `isComposing`, so checking only the standard flag ships a known IME bug.
  const composing = isComposingKey({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode });
  // The IME's Enter picks a candidate, and the menu keys below are ours: neither may be
  // adjudicated while a composition is open.
  if (composing) return;
  // Inside a project, ← or ⌫ on an empty query steps back out instead of leaving the `@`.
  if (context.browsing && !context.trigger?.query && (event.key === 'ArrowLeft' || event.key === 'Backspace') && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
    event.preventDefault(); context.browseInto(undefined); return;
  }
  if (context.projectRowsCount && event.key === 'ArrowRight' && context.highlight >= context.filesCount + context.agentRowsCount + context.sessionFilesCount && context.highlight < context.menuLength) {
    event.preventDefault(); context.choose(context.highlight); return;
  }
  // A written mention is deleted whole: a broken `@Claude Co` would read as text that names nothing.
  if ((event.key === 'Backspace' || event.key === 'Delete') && context.agentMentions && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
    const element = event.currentTarget;
    const probe = event.key === 'Backspace' ? element.selectionStart - 1 : element.selectionStart;
    const at = probe >= 0 ? mentionAt(element.value, context.referencesRef.current, probe) : undefined;
    const reference = at === undefined ? undefined : context.referencesRef.current[at];
    const range = reference && isAgentReference(reference) ? mentionRanges(element.value, [referenceLabel(reference)]).find(item => probe >= item.start && probe < item.end) : undefined;
    if (range) {
      event.preventDefault();
      // Through the browser's own edit, so ⌘Z brings it back.
      element.setSelectionRange(range.start, range.end);
      if (!document.execCommand('delete')) {
        const next = element.value.slice(0, range.start) + element.value.slice(range.end);
        context.updateText(next); context.dropUnwrittenMentions(next);
        requestAnimationFrame(() => element.setSelectionRange(range.start, range.start));
      }
      return;
    }
  }
  // ↓ with the caret in a written mention opens its model menu, as a click on it does.
  if (!context.menuOpen && event.key === 'ArrowDown' && context.agentMentions && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
    const at = mentionAt(event.currentTarget.value, context.referencesRef.current, event.currentTarget.selectionStart);
    if (at !== undefined) { event.preventDefault(); context.setMentionMenu(at); return; }
  }
  if (context.menuOpen && context.menuLength) {
    if (event.key === 'ArrowDown') { event.preventDefault(); context.setHighlight((value) => (value + 1) % context.menuLength); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); context.setHighlight((value) => (value - 1 + context.menuLength) % context.menuLength); return; }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); context.choose(context.highlight); return; }
  }
  /*
   * Escape closes the innermost layer and nothing else (`resolveEscapeLayer`). The menu is
   * this composer's own; the fullscreen panel is not — `ComposerFullscreen` owns that key,
   * because it also has to stand aside for a picker portalled above the panel and for the
   * lightbox, which this handler cannot see.
   */
  if (event.key === 'Escape' && resolveEscapeLayer({ menuOpen: context.menuOpen, fullscreen: false }) === 'menu') {
    event.preventDefault();
    context.dismissTrigger(event.currentTarget.selectionStart);
    return;
  }
  if (event.key !== 'Enter') return;
  /*
   * One policy for both the keyboard and the Send button (`resolveEnter`), so the button
   * can never do something the key it advertises would not.
   *
   * A phone keeps the behavior it has always had — a hardware Enter sends — because the
   * setting is described as applying to the desktop's physical keyboard, and a soft
   * keyboard's Return never reaches keydown at all. Anything else would make a paired
   * phone change behavior when the desktop user flips a switch.
   */
  const outcome = resolveEnter({
    kind: classifyEnterGesture({
      key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
      composing: false, repeat: event.repeat,
    }),
    composing: false,
    repeat: event.repeat,
    hasDraft: Boolean(context.textRef.current.trim()),
  }, context.isMobile ? 'send' : context.keyBehavior);
  if (outcome.preventDefault) event.preventDefault();
  if (outcome.action === 'send') context.submit();
}
