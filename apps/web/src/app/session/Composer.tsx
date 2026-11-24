import { flushSync } from 'react-dom';
import { memo, useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowUp, IconAtSign, IconChevronDown, IconKeyboard, IconMaximize, IconMic, IconMinimize, IconPaperclip, IconPlus, IconSlash, IconSparkles, IconSquare, IconX } from '@/components/icons';
import { REMOTE_SPEECH_RECOGNIZER, type Attachment } from '@contracts';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { Tip } from '@/components/ui/tooltip';
import { isAgentReference, isSessionReference, type PromptContextReference } from '@/lib/api';
import { usePlugins } from '@/lib/plugins';
import { isTextField, keepsComposerFocus, pressTarget } from '@/lib/tap-focus';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { formatWhen } from '../automations/automation';
import { SendLaterMenu } from '../automations/SendLater';
import { useSettings } from '../state/stores';
import { ComposerMentionLayer, droppedMentions, mentionAt, mentionRanges, referenceLabel } from './agentMentions';
import { ComposerAttachments } from './ComposerAttachments';
import { acknowledgeRecoveredCreationDraft, readDraft, readVoiceMode, unsavedDrafts, writeDraft, writeVoiceMode } from './composerDraft';
import { ComposerFullscreen } from './ComposerFullscreen';
import { shouldForwardWheel } from './composerFullscreenGeometry';
import { primaryEnterHint, readEnterKeyBehavior, type EnterKeyBehavior } from './composerKeyboard';
import { handleComposerKeyDown } from './composerKeyDown';
import { ComposerTriggerMenu } from './ComposerMenus';
import { compactTokens, ComposerMobileSettings, ContextMeter, ModePicker } from './ComposerPickers';
import type { ComposerProps } from './composerTypes';
import { DictationBar } from './DictationBar';
import { holdDocked, HoldToTalkBar, HoldToTalkOverlay, type HoldEnd, type HoldSession } from './HoldToTalk';
import { clipboardFiles } from './image-upload';
import type { SlashCommand } from './model';
import { ModelPicker } from './ModelPicker';
import { joinQuotes, splitQuotes } from './quotes';
import { useSwitchSettling } from './sessionFrame';
import { useHeld } from './sessionLayout';
import { removeSlashToken } from './slashMenu';
import { ToolsPickerInMenu } from './ToolsPicker';
import { useComposerAutosize } from './useComposerAutosize';
import { useComposerDraftSync } from './useComposerDraftSync';
import { useComposerTrigger } from './useComposerTrigger';
import { useComposerUploads } from './useComposerUploads';
import { followContentHeight, useComposerWindowDrop } from './useComposerWindowDrop';
import { useDictation } from './useDictation';

export { acknowledgeRecoveredCreationDraft, compactTokens, ModePicker, readDraft, writeDraft };
export type { ComposerProps };

const NO_COMMANDS: SlashCommand[] = [];

/**
 * Memoized: a streaming conversation renders its host on every frame, and a host that keeps its
 * props stable (callbacks, picker elements, the dock) lets the composer sit those frames out.
 */
export const Composer = memo(function Composer(props: ComposerProps) {
  const { t } = useLingui();
  const { projectId, referenceProjectId = projectId, referencesEnabled = true, variant = 'dock', disabled, draftKey, references, onReferencesChange, persistReferences = true, running, commands = NO_COMMANDS, onError, fileMentions = true, sessionMentions = false } = props;
  const visibleReferences = referencesEnabled ? references : [];
  const storageKey = draftKey ? `riffet.draft.${draftKey}` : '';
  const draftWarningId = useId();
  const enterBehavior = readEnterKeyBehavior(props.enterBehavior);
  // A stored draft keeps its quotes as the block quotes its text starts with (quotes.ts).
  const [text, setText] = useState(() => splitQuotes(readDraft(storageKey).text).body);
  const [quotes, setQuotes] = useState<string[]>(() => splitQuotes(readDraft(storageKey).text).quotes);
  const [submitting, setSubmitting] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [dragging, setDragging] = useState(false);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  useEffect(() => {
    setMobileSettingsOpen(false);
  }, [projectId, fileMentions, sessionMentions]);
  const [viewportHeight, setViewportHeight] = useState(() => typeof window === 'undefined' ? 0 : window.visualViewport?.height ?? window.innerHeight);
  /**
   * Fullscreen editing (§4). The state only decides layout and the draft's cap — the card, the draft
   * and every listener below are the same objects in both modes, which is what keeps the caret.
   *
   * Never on a phone: the card already spans the screen there, and taking the composer out of the
   * column would cost the dock cards their place above the keyboard.
   */
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const fullscreenToggleRef = useRef<HTMLButtonElement>(null);
  /** `undefined` means the host does not offer fullscreen; `false` means it does and it is closed. */
  const fullscreenOffered = props.onFullscreenChange !== undefined;
  const fullscreenRequested = props.fullscreen ?? fullscreenOpen;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const transcriptWheelRef = useRef(props.onTranscriptWheel);
  transcriptWheelRef.current = props.onTranscriptWheel;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef(text);
  const textRevisionRef = useRef(0);
  const draftGenerationRef = useRef(0);
  const referencesRef = useRef(references);
  const referencesRevisionRef = useRef(0);
  const submittingRef = useRef(false);
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const coarsePointer = useMediaQuery('(pointer: coarse)');
  /*
   * Fullscreen is a desktop affordance: the card already spans a phone's screen, and lifting it out
   * of the column there would cost the dock cards their place above the keyboard. Gating on the
   * media query as well as the state also means a window resized down to phone width leaves
   * fullscreen instead of stranding the card in a panel sized for a desktop.
   */
  const fullscreen = fullscreenRequested && !isMobile;
  /** Fullscreen is for writing at length: Enter breaks the line there whatever the setting, ⌘/Ctrl+Enter sends. */
  const keyBehavior: EnterKeyBehavior = fullscreen ? 'newline' : enterBehavior;
  /** One setter for the toggle, the scrim and the close button, so the host never sees two owners. */
  const setFullscreen = (open: boolean) => {
    setFullscreenOpen(open);
    props.onFullscreenChange?.(open);
  };
  useEffect(() => {
    if (isMobile && fullscreenRequested) {
      setFullscreenOpen(false);
      props.onFullscreenChange?.(false);
    }
  }, [isMobile, fullscreenRequested, props.onFullscreenChange]);
  const wasMobileRef = useRef(isMobile);
  const cardRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const blurTimerRef = useRef<number | undefined>(undefined);

  const refocusDraft = () => requestAnimationFrame(() => {
    const active = document.activeElement;
    if ((!active || active === document.body) && !window.matchMedia(MOBILE_LAYOUT_QUERY).matches) textareaRef.current?.focus({ preventScroll: true });
  });

  const {
    attachments,
    attachmentsRef,
    pendingUploads,
    pendingUploadsRef,
    attachmentKeysRef,
    reselectUploadKeyRef,
    uploading,
    updateAttachments,
    updatePendingUploads,
    ingestFiles,
    retryUpload,
    removeUpload,
    removeAttachment,
    resetForDraft,
  } = useComposerUploads({
    projectId,
    initialAttachments: () => readDraft(storageKey).attachments,
    initialPendingUploads: () => readDraft(storageKey).pendingUploads ?? [],
    disabled,
    attachmentsAllowed: props.attachmentsAllowed,
    draftGenerationRef,
    fileInputRef,
    onError,
    refocusDraft,
  });

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const updateText = (next: string) => {
    textRef.current = next;
    textRevisionRef.current += 1;
    setText(next);
  };

  const quotesRef = useRef(quotes);
  /** Quotes are part of the text that is sent, so a change to them is a change to the text. */
  const updateQuotes = (next: string[]) => {
    quotesRef.current = next;
    textRevisionRef.current += 1;
    setQuotes(next);
  };

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const updateReferences = (next: PromptContextReference[]) => {
    referencesRef.current = next;
    referencesRevisionRef.current += 1;
    onReferencesChange(next);
  };

  const submitUnknownRef = useRef<() => void>(() => {});
  const {
    trigger,
    setTrigger,
    highlight,
    setHighlight,
    browsing,
    browsingName,
    searching,
    showSearching,
    files,
    agentCandidates,
    agentRows,
    sessionFiles,
    projectRows,
    slashGroups,
    slashItems,
    invokedItems,
    slashQuery,
    unknownSlashCommand,
    menuOpen,
    menuLength,
    menuListRef,
    menuId,
    optionId,
    syncTrigger,
    browseInto,
    choose,
    resetTrigger,
    dismissTrigger,
    clearBlurTimer,
    scheduleBlurClose,
  } = useComposerTrigger({
    projectId,
    text,
    textRef,
    textareaRef,
    disabled,
    commands,
    inlineSkills: props.inlineSkills,
    fileMentions,
    sessionMentions,
    agentMentions: props.agentMentions,
    referenceSessions: props.referenceSessions,
    referenceProjects: props.referenceProjects,
    recipientSessionId: props.recipientSessionId,
    referencesRef,
    onSlashMenuOpen: props.onSlashMenuOpen,
    updateText,
    updateReferences,
    onError,
    onSubmitUnknownSlash: () => submitUnknownRef.current(),
  });

  const {
    draftAtRisk,
    pendingDraftRef,
    draftTimerRef,
    saveDraft,
    currentDraft,
    openReferenceSession,
  } = useComposerDraftSync({
    storageKey,
    projectId,
    referenceProjectId,
    persistReferences,
    text,
    quotes,
    textRef,
    quotesRef,
    textRevisionRef,
    draftGenerationRef,
    references,
    referencesRef,
    referencesRevisionRef,
    attachments,
    attachmentsRef,
    pendingUploads,
    pendingUploadsRef,
    attachmentKeysRef,
    updateText,
    updateQuotes,
    updateReferences,
    updateAttachments,
    updatePendingUploads,
    resetForDraft,
    resetTrigger,
    setScheduledAt,
    textareaRef,
    restoreDraft: props.restoreDraft,
    quote: props.quote,
    onDraftChange: props.onDraftChange,
    onOpenReferenceSession: props.onOpenReferenceSession,
    onError,
  });

  /** 语音输入 (docs/VOICE.md §7): offered once a recognizer is chosen in settings, while it is still there to use. */
  const recognizer = useSettings((settings) => settings.voiceInput?.recognizer);
  const plugins = usePlugins();
  const voiceInput = Boolean(recognizer) && (recognizer === REMOTE_SPEECH_RECOGNIZER || !plugins || plugins.some((plugin) => plugin.id === recognizer && plugin.enabled));
  const dictation = useDictation({
    text: () => textRef.current,
    selection: () => {
      const element = textareaRef.current;
      return element && document.activeElement === element ? { start: element.selectionStart, end: element.selectionEnd } : { start: textRef.current.length, end: textRef.current.length };
    },
    replace: (next, caret) => { updateText(next); requestAnimationFrame(() => textareaRef.current?.setSelectionRange(caret, caret)); },
  });
  const dictating = dictation.view.phase !== 'idle';
  /**
   * On a touch screen the mic toggles a voice mode where holding a bar records (docs/design/system/surfaces.md「语音输入（触屏）」);
   * a pointer keeps the mic as a button that records until done.
   */
  const touchVoice = voiceInput && isMobile && coarsePointer;
  const [voiceMode, setVoiceModeState] = useState(readVoiceMode);
  const voice = touchVoice && voiceMode;
  const [hold, setHold] = useState<HoldSession | null>(null);
  /** The hold overlay has fully arrived over the composer. */
  const handsFree = dictating && !hold;
  // The draft as the press found it: sentences landing mid-hold must not move the bar from under the finger.
  const switchSettling = useSwitchSettling();
  const draftEmpty = hold ? hold.emptyDraft : !text;
  const holdInFooter = voice && !draftEmpty;
  const compact = isMobile && variant === 'dock' && !focused && !mobileSettingsOpen && !dragging && !dictating && !voice
    && !text && !quotes.length && !attachments.length && !references.length && !uploading && !draftAtRisk;
  /**
   * Entrance motion for the controls the compact/full toggle adds.
   *
   * The card cannot tween between the two states — it collapses from a row into a column, and a
   * content-sized height has nothing to interpolate — so the reflow itself stays instant. What is
   * worth softening is the controls teleporting into place: those are either mounted conditionally
   * or switched off with `hidden`, and both take the element out of the box tree, which restarts a
   * CSS animation on the way back. An entrance animation therefore works where a transition cannot,
   * and it is covered by the `prefers-reduced-motion` rule in the stylesheet.
   *
   * Scoped to the dock on mobile, which is the only place the toggle exists: everywhere else it
   * would fire once on first paint for no reason. A composer replacing another conversation's shows
   * its controls at once (`useSwitchSettling`).
   */
  const toggleEntrance = isMobile && variant === 'dock' && !compact ? cn('animate-in fade-in-0 ease-[var(--ease-decelerate)]', switchSettling ? 'duration-0' : 'duration-[var(--duration-base)]') : undefined;

  const heldFeedback = useHeld(props.feedback);
  const minimumHeight = variant === 'hero' ? 76 : compact ? 44 : 52;
  const maximumHeight = props.embedded ? 120 : variant === 'hero' ? 320 : 240;
  const composerPlaceholder = props.placeholder ?? t`输入消息…`;
  useComposerAutosize({
    textareaRef,
    text,
    placeholder: composerPlaceholder,
    minimum: minimumHeight,
    maximum: Math.min(maximumHeight, Math.max(minimumHeight, isMobile && viewportHeight ? Math.floor(viewportHeight * 0.32) : maximumHeight)),
    enabled: !fullscreen,
  });

  useEffect(() => () => { window.clearTimeout(blurTimerRef.current); }, []);

  /**
   * A wheel the draft cannot spend belongs to the transcript.
   *
   * The draft's scroll port is the only scrolling box in the composer, so once it is at an edge the
   * gesture would otherwise die there and the reader would have to move the pointer off the card to
   * keep reading (DeepSeek Harness learned the same thing — `docs/COMPOSER.md` §4.0).
   */
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      if (!shouldForwardWheel({ scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, deltaY: event.deltaY })) return;
      if (transcriptWheelRef.current?.(event.deltaY, event.deltaMode)) event.preventDefault();
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);
  const onCardFocus = () => {
    window.clearTimeout(blurTimerRef.current);
    setFocused(true);
  };
  // Collapse only once focus has settled outside the card: on iOS a tapped button does not take
  // focus, so collapsing on the textarea's blur would move the button before its click lands.
  const onCardBlur = () => {
    window.clearTimeout(blurTimerRef.current);
    blurTimerRef.current = window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || !cardRef.current?.contains(active)) setFocused(false);
    }, 150);
  };
  /**
   * A press on the composer's own chrome — the dock above it included — must not move focus to
   * `<body>`, which on a phone dismisses the keyboard mid-sentence. The card's inert surface is the
   * only thing swallowed, and only while a field here holds focus: a control keeps its own press
   * (the default is what fires it and places a caret), and an unfocused card is left alone so its
   * text stays drag-selectable. `pointerdown` covers touch, `mousedown` the mouse, where cancelling
   * the pointer event does not reliably suppress the focus default.
   */
  const holdComposerFocus = (event: ReactPointerEvent<HTMLDivElement> | ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const root = event.currentTarget;
    const active = root.ownerDocument.activeElement;
    const composerFocused = Boolean(active && active !== root && root.contains(active) && isTextField(active));
    if (keepsComposerFocus({ target: pressTarget(event.target as Element | null), composerFocused })) event.preventDefault();
  };

  useEffect(() => {
    const wasMobile = wasMobileRef.current;
    wasMobileRef.current = isMobile;
    if (props.autoFocus && !isMobile && !wasMobile) textareaRef.current?.focus();
  }, [props.autoFocus, storageKey, isMobile]);

  useEffect(() => { if (!isMobile) setMobileSettingsOpen(false); }, [isMobile]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      setViewportHeight(Math.round(viewport?.height ?? window.innerHeight));
    };
    resize();
    viewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      window.removeEventListener('resize', resize);
    };
  }, []);

  /**
   * Leaving fullscreen must not strand the focus that was in the draft.
   *
   * The card stays the same node and the textarea usually keeps focus by itself, but a click on the
   * scrim moves focus to `<body>` — so if focus is no longer inside the card, it goes to the toggle
   * that opened the mode, which is where a keyboard user will look for it.
   */
  useEffect(() => {
    if (fullscreen) return;
    const active = document.activeElement;
    if (!active || active === document.body) fullscreenToggleRef.current?.focus({ preventScroll: true });
  }, [fullscreen]);

  /**
   * Entering fullscreen puts the caret back in the draft, without stealing it from a control the
   * user just pressed.
   *
   * The card is the same node in both modes, so the usual case is that focus never left — this only
   * covers the paths that move it (a scrim click, the toggle itself on a touch device, a click on
   * the panel's chrome).
   */
  useEffect(() => {
    if (!fullscreen) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && cardRef.current?.contains(active) && isTextField(active)) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [fullscreen]);

  /** Voice and keyboard take turns: entering voice puts the keyboard away, leaving it brings the keyboard back. */
  const setVoiceMode = (on: boolean, focus = true) => {
    writeVoiceMode(on);
    if (on) { setVoiceModeState(true); textareaRef.current?.blur(); return; }
    // Rendered before focusing, inside the tap, or a phone will not raise its keyboard for a field that was hidden.
    flushSync(() => setVoiceModeState(false));
    if (focus) textareaRef.current?.focus();
  };
  const holdPress = () => {
    const anchor = cardRef.current?.getBoundingClientRect();
    if (!anchor) return;
    setHold({ anchor, emptyDraft: !textRef.current, docked: holdDocked(anchor), cancelling: false, released: false });
    void dictation.start();
  };
  const holdZone = (cancelling: boolean) => setHold((current) => current && { ...current, cancelling });
  const holdEnd = (end: HoldEnd) => {
    if (end === 'tap') { setHold(null); return; }
    if (end === 'cancel') { dictation.cancel(); setHold(null); return; }
    setHold((current) => current && { ...current, cancelling: false, released: true });
    dictation.finish();
  };
  // Over once the text has landed, or the recording was dropped or stopped at its longest.
  useEffect(() => { if (hold && dictation.view.phase === 'idle') setHold(null); }, [hold, dictation.view.phase]);
  const holdBar = (tall: boolean, className?: string) => (
    <HoldToTalkBar pressed={Boolean(hold && !hold.released)} disabled={disabled || (dictating && !hold) || Boolean(hold?.released)} busy={Boolean(hold?.released) && dictation.view.phase === 'finishing'} tall={tall} className={className}
      onPress={holdPress} onZone={holdZone} onEnd={holdEnd} />
  );

  const removeReference = (index: number) => {
    updateReferences(referencesRef.current.filter((_, itemIndex) => itemIndex !== index));
    refocusDraft();
  };
  const changeReference = (index: number, next: PromptContextReference) => {
    updateReferences(referencesRef.current.map((item, itemIndex) => itemIndex === index ? next : item));
  };
  /** Deleting a written mention takes the mention with it. */
  const dropUnwrittenMentions = (value: string) => {
    if (!droppedMentions(value, referencesRef.current)) return;
    updateReferences(referencesRef.current.filter(item => !isAgentReference(item) || mentionRanges(value, [referenceLabel(item)]).length > 0));
  };
  const [mentionMenu, setMentionMenu] = useState<number>();
  const removeQuote = (index: number) => {
    updateQuotes(quotesRef.current.filter((_, itemIndex) => itemIndex !== index));
    refocusDraft();
  };

  /*
   * The rail is memoized, so it gets callbacks that never change and forward to this render's
   * handlers — the ones above close over the host's latest props.
   */
  const railHandlersRef = useRef({ removeAttachment, removeReference, changeReference, removeQuote, ingestFiles });
  railHandlersRef.current = { removeAttachment, removeReference, changeReference, removeQuote, ingestFiles };
  const [railHandlers] = useState(() => ({
    onRemoveAttachment: (id: string) => railHandlersRef.current.removeAttachment(id),
    onRemoveReference: (index: number) => railHandlersRef.current.removeReference(index),
    onRemoveQuote: (index: number) => railHandlersRef.current.removeQuote(index),
    onDropFiles: (dropped: File[]) => { void railHandlersRef.current.ingestFiles(dropped); },
    onError: (message: string) => onErrorRef.current(message),
  }));

  const windowDragging = useComposerWindowDrop({
    cardRef,
    disabled,
    windowDrop: props.windowDrop,
    attachmentsAllowed: props.attachmentsAllowed,
    projectId,
    storageKey,
    ingestFiles,
  });

  // Not while dictating: the result still to come rewrites the draft, and would bring back what was just sent.
  const sendLaterDisabled = disabled || props.submitDisabled || submitting || uploading || dictating;
  const canSubmit = Boolean(text.trim()) && !sendLaterDisabled;
  const submit = async (later?: Date) => {
    const body = textRef.current;
    const prompt = joinQuotes(quotesRef.current, body);
    const targetLater = later ?? scheduledAt ?? undefined;
    if (!body.trim() || disabled || props.submitDisabled || submittingRef.current || pendingUploadsRef.current.length > 0 || dictating) return;
    if (targetLater && !props.onSendLater) return;
    if (targetLater && targetLater.getTime() <= Date.now()) {
      onError(t`定时发送时间已过，请重新选择`);
      return;
    }
    const submittedTextRevision = textRevisionRef.current;
    const submittedAttachments = [...attachmentsRef.current];
    const submittedReferences = referencesEnabled ? [...referencesRef.current] : [];
    if (submittedReferences.some(isSessionReference) && !sessionMentions) { onError(t`当前 Agent 无法读取会话引用`); return; }
    if (submittedReferences.some(isAgentReference) && !agentCandidates.length) { onError(t`当前 Agent 无法调用其他 Agent`); return; }
    const submittedReferencesRevision = referencesRevisionRef.current;
    let stored = false;
    let draftSaved = true;
    // A durable Outbox takes ownership before POST. HTTP latency must not keep a second sendable copy.
    const onStored = () => {
      if (stored) return draftSaved;
      stored = true;
      if (targetLater) setScheduledAt(null);
      if (textRevisionRef.current === submittedTextRevision) {
        updateText('');
        if (quotesRef.current.length) updateQuotes([]);
        setTrigger(null);
      }
      if (submittedAttachments.length) {
        const submittedIds = new Set(submittedAttachments.map((attachment) => attachment.id));
        updateAttachments((current) => current.filter((attachment) => !submittedIds.has(attachment.id)));
      }
      // Once this composer is gone the host's list belongs to whichever one replaced it (a
      // conversation opened while the send was on its way); only this draft's copy is cleared.
      if (referencesEnabled && referencesRevisionRef.current === submittedReferencesRevision) {
        if (mountedRef.current) updateReferences([]); else referencesRef.current = [];
      }
      // Store what is left here rather than leaving it to the debounced effect: a submit that
      // navigates away unmounts this composer first, its unmount flush already wrote the sent
      // draft, and that draft would come back under the same key.
      if (storageKey) {
        pendingDraftRef.current = null;
        window.clearTimeout(draftTimerRef.current);
        if (!mountedRef.current && props.onSubmitPersisted) {
          // Another home composer may now own this key. It acknowledges against the accepted
          // request and synchronizes its own fresh input before the old receipt is removed.
          props.onSubmitPersisted(true);
        } else {
          saveDraft(storageKey, currentDraft());
          if (!unsavedDrafts.has(storageKey)) props.onSubmitPersisted?.();
        }
      }
      // Tapping Send on a phone dismisses the keyboard; give the transcript its space back.
      const ownerDocument = textareaRef.current?.ownerDocument;
      if (isMobile && ownerDocument && ownerDocument.activeElement !== textareaRef.current) {
        (ownerDocument.activeElement as HTMLElement | null)?.blur();
        window.clearTimeout(blurTimerRef.current);
        setFocused(false);
      }
      draftSaved = !storageKey || !unsavedDrafts.has(storageKey);
      return draftSaved;
    };
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const ok = targetLater
        ? await props.onSendLater!(prompt, submittedAttachments, submittedReferences, targetLater)
        : await props.onSubmit(prompt, submittedAttachments, submittedReferences, onStored);
      // Hosts without an Outbox retain their existing acknowledgement-after-success behavior.
      if (ok && !stored) onStored();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  submitUnknownRef.current = () => { void submit(); };

  const hero = variant === 'hero';
  const currentModel = props.models?.find((item) => item.id === props.model)?.label ?? props.model ?? t`默认模型`;
  const settingsSummary = (props.mobileSettingsLabel ?? ([
    props.toolbar ? (props.toolbarLabel ?? t`权限`) : undefined,
    props.startPickersLabel,
    props.onModelChange ? currentModel : props.endPickers ? t`模型` : undefined,
  ].filter(Boolean).join(' · '))) || t`发送设置`;
  // The sheet hides the model picker, so its trigger carries what the picker would say: a catalog
  // still loading, one that failed, or an empty one, which is also why sending can be held.
  const modelsIssue = props.modelsLoading ? '' : props.modelsError?.trim() || (props.onModelChange && props.models && !props.models.length ? t`没有可用模型` : '');
  const attachable = props.attachmentsAllowed !== false;
  const toolsInMenu = !isMobile && Boolean(props.toolsPicker);
  const hasMobileSettings = Boolean(props.toolbar || props.toolsPicker || props.onModelChange || props.startPickers || props.endPickers || props.usage);
  const showStop = Boolean(props.onStop && (props.stopping || (running || props.backgroundCount) && !text.trim()));
  // A mention is part of the text, not an attachment.
  const referenceCount = visibleReferences.filter(item => !isAgentReference(item)).length + quotes.length;
  const attachedSummary = [
    referenceCount ? t`${referenceCount} 个引用` : '',
    attachments.length ? t`${attachments.length} 个附件` : '',
    uploading ? t`上传中` : '',
  ].filter(Boolean).join(' · ');
  /*
   * A button that also picks the agent (a new session) opens the row: the agent is the first choice,
   * and its menu reads left to right from it (agent, provider, model). Inside a session the agent is
   * fixed, so the button only tunes the model and stays by the send button.
   */
  const modelLeadsRow = !isMobile && Boolean(props.modelLeading);
  const renderModelPicker = () => props.onModelChange ? (
    <ModelPicker align={isMobile || modelLeadsRow ? 'start' : 'end'} models={props.models ?? []} value={props.model} params={props.modelParams} onChange={props.onModelChange} onParamChange={props.onModelParamChange} disabled={disabled || props.pickersDisabled} loading={props.modelsLoading} error={props.modelsError} onRetry={props.onRetryModels} side={hero && !fullscreen ? 'bottom' : 'top'} inlineParams={isMobile} loadUsage={props.loadModelUsage} refreshCatalog={props.refreshCatalog} usageScopeKey={props.usageScopeKey} providers={props.providers} activeProviderId={props.activeProviderId} onPreviewProvider={props.onPreviewModelProvider} onSelectProvider={props.onSelectModelProvider} onOpenChange={props.onModelPickerOpenChange} leading={props.modelLeading} sourceLabel={props.modelSourceLabel} />
  ) : null;
  const fullscreenToggle = !isMobile && fullscreenOffered && (text.trim() || fullscreen) ? (
    <Tip label={fullscreen ? t`退出全屏编辑` : t`全屏编辑`}>
      <button
        ref={fullscreenToggleRef}
        type="button"
        aria-label={fullscreen ? t`退出全屏编辑` : t`全屏编辑`}
        aria-pressed={fullscreen}
        disabled={disabled}
        onClick={() => setFullscreen(!fullscreen)}
        className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
      >
        {fullscreen ? <IconMinimize className="size-4" /> : <IconMaximize className="size-4" />}
      </button>
    </Tip>
  ) : null;
  const stripContent = (visibleReferences.length > 0 || quotes.length > 0 || attachments.length > 0 || uploading) ? <>
    {/*
      Desktop shows the rail outright; a phone keeps the one-line summary and its expand
      toggle it has always had, because the rail would push the textarea off a small screen.
      Both variants come from one component, so a draft can never look different on the two.
    */}
    {(!isMobile || attachmentsExpanded) && <ComposerAttachments
      variant="rail"
      attachments={attachments}
      references={visibleReferences}
      quotes={quotes}
      onOpenReferenceSession={props.onOpenReferenceSession ? openReferenceSession : undefined}
      pending={pendingUploads}
      onRetryUpload={retryUpload}
      onRemoveUpload={removeUpload}
      disabled={disabled}
      {...railHandlers}
    />}
    <button type="button" className="flex min-h-11 items-center gap-2 px-3 pt-2 text-left text-xs text-fg-3 md:hidden" aria-expanded={attachmentsExpanded} onClick={() => setAttachmentsExpanded((value) => !value)}>
      <IconPaperclip className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{attachedSummary}</span>
      <IconChevronDown className={cn('size-3.5 shrink-0 transition-transform', attachmentsExpanded && 'rotate-180')} />
    </button>
  </> : undefined;
  // Its last contents stay while it folds away.
  const heldStrip = useHeld(stripContent);

  return (
    <div className={cn('relative', fullscreen && 'flex min-h-0 flex-1 flex-col')} onPointerDown={holdComposerFocus} onMouseDown={holdComposerFocus}>
      {/* Keep the menus, dock and editor in the same stable portal in both layouts. */}
      <ComposerFullscreen
        open={fullscreen}
        title={t`编辑消息`}
        label={t`编辑消息`}
        onExit={() => setFullscreen(false)}
      >
        {/*
          The card stops growing where the panel's chrome begins: the draft is the part that
          stretches, so fullscreen spends its extra height on the text and never pushes the toolbar
          or the attachment rail past the panel's edge.
        */}
        <div className={cn('relative', fullscreen && 'flex min-h-0 flex-1 flex-col')}>
          {menuOpen && trigger && (
            <ComposerTriggerMenu
              trigger={trigger}
              fullscreen={fullscreen}
              isMobile={isMobile}
              hero={hero}
              browsing={browsing}
              browsingName={browsingName}
              sessionMentions={sessionMentions}
              showSearching={showSearching}
              searching={searching}
              menuListRef={menuListRef}
              menuId={menuId}
              optionId={optionId}
              slashGroups={slashGroups}
              slashItems={slashItems}
              slashQuery={slashQuery}
              unknownSlashCommand={unknownSlashCommand}
              unknownCommandHint={props.unknownCommandHint}
              highlight={highlight}
              setHighlight={setHighlight}
              choose={choose}
              browseInto={browseInto}
              files={files}
              agentRows={agentRows}
              sessionFiles={sessionFiles}
              projectRows={projectRows}
              references={references}
              referenceSessions={props.referenceSessions}
            />
          )}
        {/* Notices above the card come and go with the session's state; they grow in rather than
            pushing the card and the transcript's bottom edge in a single frame. */}
        <Collapse open={Boolean(props.feedback)} className={cn(fullscreen && 'max-h-[35%] min-h-0 shrink-0')}>
          <div ref={followContentHeight} className={cn(fullscreen && 'flex max-h-full flex-col')}>
            <div inert={!props.feedback} aria-hidden={!props.feedback || undefined} className={cn('flex flex-col gap-2 pb-2', fullscreen && 'min-h-0 overflow-y-auto overscroll-contain')}>
              {heldFeedback}
            </div>
          </div>
        </Collapse>
        {props.dock}

        <div
          ref={cardRef}
          data-composer-card
          onFocus={onCardFocus}
          onBlur={onCardBlur}
          className={cn(
            // `relative` keeps the card above the dock stack: a dock is a flex item, and a flex item's
            // box-shadow paints after a block-level box's background, so without this the dock's own
            // soft shadow lands *inside* the card as a dark band under the seam — worst on the phone's
            // bordered cards and in dark, where that shadow is black at 70%. Raised, only the card's
            // hairline and the dock's top half of the shadow survive: one stack, one shadow.
            'relative flex bg-elevated transition-[border-color,box-shadow] duration-[var(--duration-base)] ease-[var(--ease-standard)]',
            'max-md:rounded-3xl max-md:border max-md:border-line-strong max-md:shadow-soft max-md:focus-within:border-fg-4/55 max-md:focus-within:shadow-focus',
            'md:rounded-2xl md:shadow-composer md:focus-within:shadow-composer-focus',
            props.embedded && 'rounded-xl! border border-line bg-subtle shadow-none! focus-within:border-fg-4/55 focus-within:shadow-none!',
            compact ? 'flex-row items-center' : 'flex-col',
            fullscreen && 'min-h-0 flex-1 rounded-none! border-0! bg-transparent shadow-none!',
            props.dockAttached && 'rounded-t-none! border-t-0!',
            dragging && 'border-accent! ring-3 ring-accent/15',
            disabled && 'opacity-70',
          )}
          onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (!disabled) setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); void ingestFiles(event.dataTransfer.files); } }}
        >
          {/* Slides like the textarea and the dock above, so a draft handed back grows the stack in one motion. */}
          <Collapse open={Boolean(stripContent)} className={cn(compact && 'hidden')}><div inert={!stripContent}>{heldStrip}</div></Collapse>

          {props.agentMentions && <ComposerMentionLayer textareaRef={textareaRef} text={text} references={visibleReferences} source={props.agentMentions} openIndex={mentionMenu} onOpenIndex={setMentionMenu} onChangeReference={changeReference} />}
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            disabled={disabled}
            readOnly={dictating}
            data-composer-input
            aria-label={t`输入消息`}
            aria-describedby={draftAtRisk ? draftWarningId : undefined}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={menuOpen && highlight < menuLength ? optionId(highlight) : undefined}
            placeholder={composerPlaceholder}
            className={cn('relative w-full resize-none bg-transparent px-4 text-base leading-6 text-fg outline-none placeholder:text-fg-4', hero ? 'min-h-[76px] pt-4 pb-1' : compact ? 'min-h-[44px] min-w-0 flex-1 py-2.5' : 'min-h-[52px] pt-3.5 pb-1', fullscreen && 'min-h-0 flex-1 overflow-y-auto pt-3 pb-1', voice && draftEmpty && 'hidden')}
            onChange={(event) => { updateText(event.target.value); dropUnwrittenMentions(event.target.value); syncTrigger(event.target.value, event.target.selectionStart); }}
            onClick={(event) => {
              const element = event.currentTarget;
              if (!props.agentMentions || element.selectionStart !== element.selectionEnd) return;
              const at = mentionAt(element.value, referencesRef.current, element.selectionStart);
              if (at !== undefined) setMentionMenu(at);
            }}
            onSelect={(event) => syncTrigger(event.currentTarget.value, event.currentTarget.selectionStart)}
            onFocus={() => { clearBlurTimer(); if (voice && !dictating) setVoiceMode(false, false); }}
            onBlur={scheduleBlurClose}
            onPaste={(event) => {
              const pasted = clipboardFiles(event.clipboardData);
              if (!pasted.length || disabled || props.attachmentsAllowed === false) return;
              // Native text insertion preserves the selection and undo history for mixed pastes.
              if (!event.clipboardData.getData('text/plain')) event.preventDefault();
              void ingestFiles(pasted);
            }}
            onKeyDown={(event) => handleComposerKeyDown(event, {
              dictating,
              dictationPhase: dictation.view.phase,
              cancelDictation: dictation.cancel,
              finishDictation: dictation.finish,
              browsing,
              trigger,
              browseInto,
              projectRowsCount: projectRows.length,
              highlight,
              setHighlight,
              filesCount: files.length,
              agentRowsCount: agentRows.length,
              sessionFilesCount: sessionFiles.length,
              menuLength,
              choose,
              agentMentions: props.agentMentions,
              referencesRef,
              updateText,
              dropUnwrittenMentions,
              setMentionMenu,
              menuOpen,
              dismissTrigger,
              textRef,
              isMobile,
              keyBehavior,
              submit: () => { void submit(); },
            })}
          />

          {/* An empty draft in voice mode: the bar stands where the text would be. */}
          {voice && draftEmpty && <div className="pt-2 max-md:pl-4 max-md:pr-3 md:px-2">{holdBar(true, hero ? 'min-h-[68px]' : undefined)}</div>}
          <HoldToTalkOverlay session={hold && (!hold.released || dictation.view.phase === 'failed') ? hold : null} view={dictation.view} onRetry={dictation.retry} onDiscard={dictation.cancel} />

          {/* What the draft will invoke, read back from the text itself: the token is the reference,
              so removing a chip removes the token, and editing the token out drops the chip. */}
          {!compact && invokedItems.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 px-3 pt-1" aria-label={t`将调用`}>
              {invokedItems.map((item) => (
                <span key={item.name} title={item.description} className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-md bg-accent/10 pl-1.5 pr-0.5 text-xs text-accent md:min-h-6">
                  {item.kind === 'skill' ? <IconSparkles className="size-3 shrink-0" /> : <IconSlash className="size-3 shrink-0" />}
                  <span className="min-w-0 truncate font-mono">{item.name}</span>
                  <button type="button" aria-label={t`移除 /${item.name}`} disabled={disabled} onClick={() => { updateText(removeSlashToken(textRef.current, item.name)); refocusDraft(); }} className="grid size-11 shrink-0 place-items-center rounded text-accent/70 outline-none hover:bg-accent/15 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/35 md:size-5">
                    <IconX className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div id={draftWarningId}>
            <FeedbackNotice scope={storageKey ?? props.draftKey ?? draftWarningId} message={draftAtRisk && t`草稿无法保存到浏览器，刷新后会丢失`} recovered={!draftAtRisk}
              className="px-4 pt-1 pb-2" icon={null} noticeClassName={cn('bg-transparent! p-0! text-xs', draftAtRisk ? 'text-warning' : 'text-fg-3')} />
          </div>
          {handsFree && <DictationBar view={dictation.view} onFinish={dictation.finish} onCancel={() => { dictation.cancel(); refocusDraft(); }} onRetry={dictation.retry} />}
          <div className={cn('flex items-center gap-1', handsFree && 'hidden', compact ? cn('shrink-0 flex-nowrap py-0.5 pr-1', !running && !props.backgroundCount && 'hidden') : 'flex-wrap pb-2 pt-1 max-md:pl-1.25 max-md:pr-3 md:flex-nowrap md:px-2')}>
            {/* Skills and tools live in the + menu on a pointer device rather than as a button of their
                own on the row; the phone's settings sheet keeps its own section for them. */}
            <div className={cn('flex shrink-0 items-center empty:hidden', compact && 'hidden')}>
            {(attachable || toolsInMenu) && <>{attachable && <input ref={fileInputRef} className="sr-only" type="file" multiple tabIndex={-1} disabled={disabled} onChange={(event) => { const replaceKey = reselectUploadKeyRef.current; reselectUploadKeyRef.current = undefined; void ingestFiles(event.target.files, replaceKey); event.target.value = ''; }} />}
            {sessionMentions || toolsInMenu ? <DropdownMenu>
              <DropdownMenuTrigger aria-label={attachable ? t`添加附件` : t`技能与工具`} disabled={disabled || (uploading && !toolsInMenu)} className={cn('grid h-11 w-10 shrink-0 place-items-center rounded-md text-fg-3 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:size-7', compact ? 'hidden' : toggleEntrance)}><IconPlus className="size-[18px]" /></DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start">
                {attachable && <DropdownMenuItem disabled={uploading} onSelect={() => fileInputRef.current?.click()}><IconPaperclip /><Trans>添加图片或文件</Trans></DropdownMenuItem>}
                {sessionMentions && (
                  <DropdownMenuItem onSelect={() => { const caret = textareaRef.current?.selectionStart ?? textRef.current.length; const prefix = caret > 0 && !/\s/.test(textRef.current[caret - 1]!) ? ' @' : '@'; updateText(textRef.current.slice(0, caret) + prefix + textRef.current.slice(caret)); setTrigger({ type: 'mention', query: '', start: caret + prefix.length - 1 }); requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(caret + prefix.length, caret + prefix.length); }); }}><IconAtSign /><Trans>引用会话</Trans></DropdownMenuItem>
                )}
                {toolsInMenu && <>
                  {(attachable || sessionMentions) && <DropdownMenuSeparator />}
                  <ToolsPickerInMenu.Provider value>{props.toolsPicker}</ToolsPickerInMenu.Provider>
                </>}
              </DropdownMenuContent>
            </DropdownMenu> : <Tip label={t`添加图片或文件`}>
              <button type="button" aria-label={t`添加附件`} disabled={disabled || uploading} onClick={() => fileInputRef.current?.click()} className={cn('grid h-11 w-10 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:size-7', compact ? 'hidden' : toggleEntrance)}>
                <IconPlus className="size-[18px]" />
              </button>
            </Tip>}</>}
            {touchVoice && !compact && (
              <button type="button" aria-label={voice ? t`键盘` : t`语音输入`} disabled={disabled} onClick={() => setVoiceMode(!voice)}
                className={cn('grid h-11 w-10 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50', toggleEntrance)}>
                {voice ? <IconKeyboard className="size-[18px]" /> : <IconMic className="size-[18px]" />}
              </button>
            )}
            </div>
            {holdInFooter && holdBar(false, 'flex-1')}
            {voiceInput && !touchVoice && !compact && <Tip label={t`语音输入`}>
              <button type="button" aria-label={t`语音输入`} disabled={disabled} onClick={() => void dictation.start()}
                className={cn('grid size-11 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:size-7', toggleEntrance)}>
                <IconMic className="size-[18px]" />
              </button>
            </Tip>}
            {props.onSendLater && !compact && (
              <SendLaterMenu
                disabled={sendLaterDisabled}
                scheduledAt={scheduledAt}
                onClearSchedule={() => setScheduledAt(null)}
                onPick={(at) => {
                  if (scheduledAt || !textRef.current.trim()) {
                    setScheduledAt(at);
                    return;
                  }
                  void submit(at);
                }}
              />
            )}
            <ComposerMobileSettings
              open={mobileSettingsOpen}
              onOpenChange={setMobileSettingsOpen}
              isMobile={isMobile}
              compact={compact}
              holdInFooter={holdInFooter}
              toggleEntrance={toggleEntrance}
              disabled={disabled}
              pickersDisabled={props.pickersDisabled}
              pickersBlockedReason={props.pickersBlockedReason}
              modelsIssue={modelsIssue}
              modelsLoading={props.modelsLoading}
              settingsSummary={settingsSummary}
              mobileSettingsPrefix={props.mobileSettingsPrefix}
              usage={props.usage}
              onCompact={props.onCompact}
              compacting={props.compacting}
              compactDisabled={props.compactDisabled}
              toolbar={props.toolbar}
              toolsPicker={props.toolsPicker}
              startPickers={props.startPickers}
              hasModelPicker={Boolean(props.onModelChange)}
              renderModelPicker={renderModelPicker}
              endPickers={props.endPickers}
              hasMobileSettings={hasMobileSettings}
              modelLeadsRow={modelLeadsRow}
              fullscreenToggle={fullscreenToggle}
            />

            {/*
              Each slot renders only when it has content. The wrappers used to be unconditional, and
              an empty one is still a flex item — so two absent pickers between the context meter and
              the model added 12px of nothing to the row's own 6px gap, which is why the meter looked
              stranded from the model while the send button sat right against it.
            */}
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1 md:flex-nowrap">
              {!isMobile && props.usage && <span className="hidden md:inline-flex"><ContextMeter usage={props.usage} onCompact={props.onCompact} compacting={props.compacting} compactDisabled={props.compactDisabled} /></span>}
              {!isMobile && props.startPickers && <span className="hidden min-w-0 md:inline-flex">{props.startPickers}</span>}
              {!isMobile && !modelLeadsRow && props.onModelChange && <span className="hidden min-w-0 md:inline-flex">{renderModelPicker()}</span>}
              {!isMobile && props.endPickers && <span className="hidden min-w-0 md:inline-flex">{props.endPickers}</span>}
              {modelLeadsRow && fullscreenToggle}
              {(!compact || showStop) && (
                <Tip
                  label={showStop ? props.stopping ? t`正在停止` : running ? t`停止` : t`停止后台任务` : scheduledAt ? t`定时发送 (${formatWhen(scheduledAt.toISOString())})` : props.submitIntent === 'steer' ? t`补充到当前任务` : running ? t`加入队列` : t`发送`}
                  kbd={showStop ? undefined : primaryEnterHint(keyBehavior)}
                >
                  <button
                    type="button"
                    aria-label={showStop ? props.stopping ? t`正在停止` : running ? t`停止` : t`停止后台任务` : scheduledAt ? t`定时发送` : props.submitIntent === 'steer' ? t`补充到当前任务` : running ? t`排队发送` : t`发送`}
                    aria-busy={showStop && props.stopping || undefined}
                    disabled={showStop ? props.stopping || props.stopDisabled || submitting : !canSubmit}
                    onClick={showStop ? props.onStop : () => void submit()}
                    className={cn(
                      // The phone's circle is 36 like iOS; the tap area reaches 44 around it.
                      'relative grid size-9 shrink-0 place-items-center rounded-full transition-[background-color,color,transform] duration-[var(--duration-base)] ease-[var(--ease-standard)] before:absolute before:-inset-1 active:scale-90 disabled:active:scale-100 md:size-8 md:before:hidden',
                      showStop ? 'bg-primary text-primary-fg hover:bg-primary-hover disabled:opacity-50' : 'bg-primary text-primary-fg hover:bg-primary-hover disabled:bg-fg/[0.08] disabled:text-fg-4',
                    )}
                  >
                    {showStop ? props.stopping ? <Spinner className="size-4 text-current" /> : <IconSquare className="size-3 fill-current" /> : submitting ? <Spinner className="size-4 text-current" /> : <IconArrowUp className="size-4" strokeWidth={2.4} />}
                  </button>
                </Tip>
              )}
            </div>
          </div>
        </div>
        </div>
      </ComposerFullscreen>

      {/*
        A file is being dragged somewhere over the page. No dashed border and no backdrop: the point
        is to say where the file will land, not to dim the work behind it, and a translucent scrim
        over a transcript the user is reading mid-sentence costs more than the hint is worth.
      */}
      {windowDragging && !dragging && (
        <div className="pointer-events-none fixed inset-0 z-(--z-drop) p-3">
          <div className="flex h-full items-center justify-center rounded-2xl ring-2 ring-inset ring-accent/40">
            <span className="inline-flex items-center gap-2 rounded-full bg-elevated px-3 py-1.5 text-sm text-fg-2 shadow-soft">
              <IconPaperclip className="size-4 text-fg-3" />
              <Trans>添加为附件</Trans>
            </span>
          </div>
        </div>
      )}
    </div>
  );
});
