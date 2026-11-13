import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeInteraction, NativeInteractionResponse, NativeInteractionResult } from '@contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/controls';
import { api, HttpError } from '@/lib/api';
import { formatTime } from '@/lib/i18n/format';
import { toast } from '@/lib/toast';
import { useNow } from '@/lib/use-now';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { cn, errorMessage, newId } from '@/lib/utils';
import { Markdown } from './Markdown';
import { interactionSelectsOptions, parseNativeInteractionDraft, restoreNativeInteractionSubmission, serializeNativeInteractionSubmission } from './nativeInteractionDraft';
import {
  cardBusy, cardDraft, cardShown, cardStoredDraft, changeOtherText, interactionChanged, interactionFailed, interactionResponded, interactionSynced,
  interactionSyncFailed, interactionSyncStarted, restoreInteractionCard, retryInteraction, selectOption, submitInteraction, type InteractionCardState,
} from './nativeInteractionCardState';
import { dismissActionId, EXPIRY_WARNING_MS, formatRemaining, remainingMs, shortcutIndex } from './nativeInteractionShortcuts';
import { isComposingKey } from './composerKeyboard';

/** Its own component so the once-a-second tick re-renders only the label, not the whole card. */
function ExpiryCountdown({ sessionId, interaction }: { sessionId: string; interaction: NativeInteraction & { expiresAt: string } }) {
  const { t } = useLingui();
  const { expiresAt, extendableUntil } = interaction;
  const [extending, setExtending] = useState(false);
  const now = useNow();
  const remaining = remainingMs(expiresAt, now);
  if (remaining === undefined) return null;
  const extendable = remaining > 0 && extendableUntil !== undefined && Date.parse(extendableUntil) > Date.parse(expiresAt);
  const extend = () => {
    setExtending(true);
    void api.extendNativeInteraction(sessionId, interaction.id)
      .catch((error) => toast.error(errorMessage(error, t`无法延长等待时间`)))
      .finally(() => setExtending(false));
  };
  return (
    <>
      {/* A label rewritten every second would be read out every second; the reader gets the deadline once. */}
      <span aria-hidden className={cn('shrink-0 text-xs tabular-nums', remaining < EXPIRY_WARNING_MS ? 'text-warning' : 'text-fg-3')}>
        {remaining > 0 ? t`${formatRemaining(remaining)} 后自动拒绝` : t`已超时，自动拒绝`}
      </span>
      <span className="sr-only">{remaining > 0 ? t`${formatTime(expiresAt)} 自动拒绝` : t`已超时，自动拒绝`}</span>
      {extendable && <Button variant="quiet" size="xs" className="shrink-0" disabled={extending} onClick={extend} title={t`再等 10 分钟`}><Trans>延长</Trans></Button>}
    </>
  );
}

function draftKey(sessionId: string, interactionId: string) {
  return `riffet:native-interaction:${encodeURIComponent(sessionId)}:${encodeURIComponent(interactionId)}`;
}

/** The unconfirmed answer for this interaction, kept apart from its draft so each can be cleared alone. */
function submissionKey(sessionId: string, interactionId: string) {
  return `${draftKey(sessionId, interactionId)}:submission`;
}

function readStorage(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string | undefined) {
  try {
    if (value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* storage can be unavailable in private browsing */ }
}

/**
 * Restore this question's draft and unconfirmed submission when the conversation is reopened.
 */
function restoreCard(sessionId: string, interaction: NativeInteraction): InteractionCardState {
  return restoreInteractionCard(
    interaction,
    parseNativeInteractionDraft(readStorage(draftKey(sessionId, interaction.id))),
    restoreNativeInteractionSubmission(readStorage(submissionKey(sessionId, interaction.id))),
  );
}

export function NativeInteractionCard({
  sessionId,
  interaction,
  connected,
  onRespond,
  onSync,
  onOpenTerminal,
}: {
  sessionId: string;
  interaction: NativeInteraction;
  connected: boolean;
  onRespond: (interaction: NativeInteraction, response: NativeInteractionResponse) => Promise<NativeInteractionResult>;
  onSync: () => Promise<NativeInteraction | null>;
  onOpenTerminal?: () => void;
}) {
  const { t } = useLingui();
  const uncertainCopy = t`暂时无法确认回答是否已提交`;
  // The state machine every client shares (`nativeInteractionCardState.ts`); this component only renders it.
  const [state, setState] = useState(() => restoreCard(sessionId, interaction));
  const articleRef = useRef<HTMLElement>(null);
  /**
   * Whether the reader reached the card with the pointer. Escape denies only for a keyboard visit (the
   * CLI's own binding): after a click on the card, the same key belongs to the page around it.
   */
  const [pointerEntry, setPointerEntry] = useState(false);
  const key = draftKey(sessionId, interaction.id);
  const pendingKey = submissionKey(sessionId, interaction.id);

  useEffect(() => {
    setState((current) => current.interaction.id === interaction.id ? interactionChanged(current, interaction) : restoreCard(sessionId, interaction));
  }, [interaction, sessionId]);

  useEffect(() => {
    if (state.interaction.id !== interaction.id) return;
    const draft = cardStoredDraft(state);
    writeStorage(key, draft && JSON.stringify(draft));
    writeStorage(pendingKey, state.submission && serializeNativeInteractionSubmission(state.submission));
  }, [state, interaction.id, key, pendingKey]);

  const { submission, syncing } = state;
  const shown = cardShown(state);
  const currentDraft = cardDraft(state);
  const busy = cardBusy(state);
  const isQuestion = shown.kind === 'question';
  /**
   * A plan review is the one interaction whose message is the thing being decided rather than a
   * preview of it: the CLI prints the whole plan — headings, numbered steps, a few thousand
   * characters — and the reader cannot approve what they cannot read. So it renders as Markdown in
   * a scrollable body, where every other kind keeps the terse monospace preview.
   */
  const isPlan = shown.kind === 'plan';
  const focusedOptionId = shown.options.find((option) => option.selected)?.id;
  const selected = new Set(currentDraft.selectedIds);
  const hasOptions = shown.options.length > 0;
  /**
   * A question and a plan review both pick one of the options and submit them. They differ in where
   * the submit lives (`answer` versus a named `submit` action) and in what the text field means, so
   * the payload is built by `interactionSelection` and only the presentation branches on the kind.
   */
  const selectsOptions = interactionSelectsOptions(shown);
  const showsOptions = hasOptions && selectsOptions;
  const answerPresent = selected.size > 0 || Boolean(currentDraft.otherText.trim());
  const error = state.error && (state.error.message || (state.error.kind === 'submit' ? t`无法提交交互` : t`无法同步当前交互`));

  /**
   * Submitting disables the control that was pressed, and a disabled control drops focus to
   * `<body>` — where 1–9 and Escape no longer reach this card. The card itself keeps it instead.
   */
  const holdFocus = () => {
    const article = articleRef.current;
    if (article && article !== document.activeElement && article.contains(document.activeElement)) article.focus({ preventScroll: true });
  };

  /** Sends what a transition asked for, then feeds the outcome back; a remount picks the answer up as `unknown`. */
  const post = async (next: InteractionCardState | undefined) => {
    if (!next?.submission || !connected) return;
    holdFocus();
    const sent = next.submission;
    setState(next);
    try {
      const result = await onRespond(sent.interaction, sent.request);
      setState((current) => interactionResponded(current, sent.request.requestId, result.status, result.message));
    } catch (cause) {
      const status = cause instanceof HttpError ? cause.status : undefined;
      setState((current) => interactionFailed(current, sent.request.requestId, status, errorMessage(cause, t`无法提交交互`)));
    }
  };

  const submit = (action: string) => post(submitInteraction(state, action, newId()));

  const sync = async () => {
    if (syncing) return;
    holdFocus();
    setState(interactionSyncStarted);
    try {
      const fresh = await onSync();
      setState((current) => interactionSynced(current, fresh));
    } catch (cause) {
      setState((current) => interactionSyncFailed(current, errorMessage(cause, t`无法同步当前交互`)));
    }
  };

  const changeOption = (optionId: string) => setState((current) => selectOption(current, optionId));

  const changeOther = (value: string) => setState((current) => changeOtherText(current, value));

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || isComposingKey(event.nativeEvent) || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // A DSH question submits with the `submit` action instead of a terminal `answer`.
    const submitAction = shown.actions.find((action) => action.id === 'answer') ?? shown.actions.find((action) => action.id === 'submit');
    if (!submitAction || !connected || busy || !answerPresent) return;
    event.preventDefault();
    void submit(submitAction.id);
  };

  const actionRows = !isQuestion && !selectsOptions;
  const dismissId = dismissActionId(shown);
  const escapeDenies = Boolean(dismissId) && !pointerEntry;
  const shortcutCount = Math.min(9, showsOptions ? shown.options.length : actionRows ? shown.actions.length : 0);

  const onCardBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPointerEntry(false);
  };

  /*
   * A card that answers itself takes the focus with it. Measured before the DOM goes (layout cleanups
   * run ahead of the removal), applied after it, and only where focus would otherwise sit on `<body>`.
   * On a phone that focus would raise the keyboard, so it is left alone there.
   */
  useLayoutEffect(() => {
    const article = articleRef.current;
    return () => {
      if (!article?.contains(document.activeElement) || window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        document.querySelector<HTMLTextAreaElement>('textarea[data-composer-input]')?.focus({ preventScroll: true });
      });
    };
  }, []);

  const onCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || isComposingKey(event.nativeEvent) || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const typing = (target instanceof HTMLInputElement && target.type !== 'radio' && target.type !== 'checkbox') || target instanceof HTMLTextAreaElement || target.isContentEditable;
    if (typing || !connected || busy) return;
    if (event.key === 'Escape') {
      // Not consumed after a pointer visit, so the surrounding page can handle Escape.
      if (!escapeDenies || !dismissId) return;
      event.preventDefault();
      void submit(dismissId);
      return;
    }
    const index = shortcutIndex(event.key);
    if (index === undefined || index >= shortcutCount) return;
    event.preventDefault();
    if (showsOptions) changeOption(shown.options[index]!.id);
    else void submit(shown.actions[index]!.id);
  };

  const title = shown.title || (isQuestion ? t`需要回答` : isPlan ? t`需要批准计划` : t`需要选择`);
  const counter = isQuestion && shown.questionCount
    ? `${Math.max(1, shown.questionIndex ?? 1)} / ${shown.questionCount}`
    : '';
  const shortcutHint = [shortcutCount > 1 ? t`1–${shortcutCount} 选择` : shortcutCount === 1 ? t`1 选择` : '', escapeDenies ? t`Esc 拒绝` : ''].filter(Boolean).join(' · ');
  const keyShortcuts = [...Array.from({ length: shortcutCount }, (_, index) => String(index + 1)), ...(escapeDenies ? ['Escape'] : [])].join(' ');
  const actionLabel = (action: NativeInteraction['actions'][number]) => {
    switch (action.id) {
      case 'previous': return t`上一题`;
      case 'answer': return !shown.questionCount || (shown.questionIndex ?? 1) >= shown.questionCount
        ? t({ message: '提交', context: 'session-submit-action' })
        : t`下一题`;
      case 'submit': return t({ message: '提交', context: 'session-submit-action' });
      case 'skip': return t`跳过`;
      case 'cancel': return t`取消`;
      case 'next': return t`下一题`;
      default: return action.shortLabel ?? action.label;
    }
  };
  const reviewed = actionRows ? shown.actions.filter((action) => action.detail) : [];

  return (
    <article
      ref={articleRef}
      className="group mt-3 rounded-xl bg-subtle/45 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
      aria-keyshortcuts={keyShortcuts || undefined}
      tabIndex={0}
      onPointerDown={() => setPointerEntry(true)}
      onBlur={onCardBlur}
      onKeyDown={onCardKeyDown}
    >
      <header className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={title}>{title}</h3>
        {shortcutHint && <span className="hidden shrink-0 text-xs text-fg-3 md:group-focus-within:inline">{shortcutHint}</span>}
        {shown.expiresAt && submission?.phase !== 'success' && <ExpiryCountdown sessionId={sessionId} interaction={{ ...shown, expiresAt: shown.expiresAt }} />}
        {counter && <span className="shrink-0 text-xs text-fg-3">{counter}</span>}
      </header>

      <div className="mt-2 flex flex-col gap-2">
        {/* Every body scrolls within a bound so a long command or plan never pushes the actions out of view. */}
        {isPlan
          ? shown.message && <div className="max-h-80 overflow-y-auto overscroll-contain rounded-md bg-bg px-2.5 py-2"><Markdown text={shown.message} /></div>
          : actionRows
            ? (shown.message || reviewed.length > 0) && (
              // The request and the exact scope each choice grants are read in one place, in full; the buttons only name the choice.
              <div className="flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain rounded-md bg-bg px-2 py-1.5 font-mono text-xs leading-5 text-fg-2 whitespace-pre-wrap break-words">
                {shown.message && <p>{shown.message}</p>}
                {reviewed.map((action) => (
                  <section key={action.id} className="flex flex-col gap-0.5 border-t border-line-soft pt-2 first:border-t-0 first:pt-0">
                    <h4 className="font-sans font-medium text-fg">{actionLabel(action)}</h4>
                    <p className="text-fg-3">{action.detail}</p>
                  </section>
                ))}
              </div>
            )
            : shown.message && <p className="max-h-72 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-sm leading-5 text-fg-2">{shown.message}</p>}

        {showsOptions && (
          <fieldset className="flex min-w-0 flex-col gap-0.5" disabled={busy || !connected}>
            <legend className="sr-only">{title}</legend>
            {shown.options.map((option) => {
              const checked = selected.has(option.id);
              return (
                <label key={option.id} className={cn('flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-sm transition-colors md:min-h-8', checked ? 'bg-accent-soft/55 text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg', busy && 'cursor-not-allowed opacity-65')}>
                  <input className="size-4 shrink-0 accent-[var(--accent)]" type={shown.multiple ? 'checkbox' : 'radio'} name={`${shown.id}-answer`} checked={checked} disabled={busy || !connected} onChange={() => changeOption(option.id)} />
                  <span className="min-w-0 flex-1">{option.label}</span>
                </label>
              );
            })}
          </fieldset>
        )}

        {isQuestion && (shown.allowOther || !hasOptions) && <>
          <Input className="h-11 rounded-md border-transparent bg-bg px-3 text-base focus:border-accent md:h-8 md:px-2 md:text-sm" aria-label={hasOptions ? t`其他回答` : t`你的回答`} placeholder={hasOptions ? t`其他…` : t`输入回答`} maxLength={2000} value={currentDraft.otherText} disabled={busy || !connected} onChange={(event) => changeOther(event.target.value)} onKeyDown={submitOnEnter} />
          {shown.multiple && shown.otherSelected && <p className="text-xs text-fg-3"><Trans>其他回答暂不能清空。</Trans></p>}
        </>}

        {/* The live region holds only these notes, never the plan or the controls; it stays mounted
            (and visible) while empty so the first note is announced, and cancels its own gap. */}
        <div role="status" className="flex flex-col gap-2 empty:-mt-2">
          {state.notice && <p className="text-xs leading-4 text-warning">{state.notice === 'draft_stale' ? t`题目已更新，旧草稿未提交。` : t`暂时无法确认回答是否已提交`}</p>}
          {submission?.phase === 'uncertain' && <>
            {/* The provider's reason is diagnostic detail, often in English; the reader first needs what to do. */}
            <p className="text-xs leading-4 text-warning">{uncertainCopy}</p>
            {submission.message && submission.message !== uncertainCopy && <p className="break-words text-xs leading-4 text-fg-3">{submission.message}</p>}
          </>}
          {submission?.phase === 'unknown' && <p className="text-xs leading-4 text-warning">{t`暂时无法确认回答是否已提交`}</p>}
          {submission?.phase === 'stale' && <p className="text-xs leading-4 text-warning">{t`题目已更新，请检查状态`}</p>}
          {submission?.phase === 'success' && submission.message && (
            <p className="text-xs leading-4 text-success">{submission.message}</p>
          )}
        </div>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </div>

      {actionRows && (
        // One row per choice, in the CLI's own order. The row the CLI has focused leads as the
        // primary action, so the card never restates the choices as text the user cannot press.
        <div className="mt-2 flex flex-col gap-1.5">
          {shown.actions.map((action) => {
            const focused = Boolean(focusedOptionId) && action.id === `option:${focusedOptionId}`;
            return (
              <Button
                key={action.id}
                size="sm"
                variant={action.tone === 'danger' ? 'danger' : focused ? 'primary' : 'secondary'}
                className="h-auto min-h-11 w-full justify-start whitespace-normal px-3 py-2 text-left text-sm break-words md:min-h-9"
                disabled={!connected || busy}
                onClick={() => { void submit(action.id); }}
              >
                {actionLabel(action)}
              </Button>
            );
          })}
        </div>
      )}

      <footer className="mt-2 flex flex-wrap items-center gap-1 empty:hidden">
        {(isQuestion || selectsOptions) && shown.actions.filter((action) => action.id !== 'next').map((action) => {
          // `submit` is a protocol question's own submit (DSH sends it), `answer` is the terminal
          // one; both are the primary action and both wait for a selection, so they read the same.
          const submitsSelection = action.id === 'answer' || action.id === 'submit';
          return (
            <Button
              key={action.id}
              size="xs"
              variant={action.tone === 'danger' ? 'danger-ghost' : submitsSelection || action.tone === 'primary' ? 'primary' : 'secondary'}
              className="h-auto min-h-11 max-w-full whitespace-normal px-3 py-2 text-sm md:h-7 md:min-h-0 md:max-w-none md:whitespace-nowrap md:px-2.5 md:py-0 md:text-xs"
              disabled={!connected || busy || (submitsSelection && !answerPresent)}
              title={action.id === 'skip' ? t`跳过这组问题` : undefined}
              onClick={() => { void submit(action.id); }}
            >
              {actionLabel(action)}
            </Button>
          );
        })}
        {submission?.phase === 'posting' && <span className="ml-auto text-xs text-fg-3"><Trans>提交中…</Trans></span>}
        {submission?.phase === 'unknown' && <Button size="xs" variant="secondary" className="h-auto min-h-11 px-3 text-sm md:h-7 md:min-h-0 md:px-2.5 md:text-xs" disabled={!connected || syncing} onClick={() => { void post(retryInteraction(state)); }}><Trans>重试</Trans></Button>}
        {submission?.phase === 'unknown' && <Button size="xs" variant="secondary" className="h-auto min-h-11 px-3 text-sm md:h-7 md:min-h-0 md:px-2.5 md:text-xs" disabled={syncing} onClick={() => { void sync(); }}>{syncing ? <Trans>正在检查</Trans> : <Trans>检查状态</Trans>}</Button>}
        {onOpenTerminal && submission?.phase === 'unknown' && <Button size="xs" variant="secondary" className="h-auto min-h-11 px-3 text-sm md:h-7 md:min-h-0 md:px-2.5 md:text-xs" onClick={onOpenTerminal}><Trans>终端</Trans></Button>}
        {(submission?.phase === 'stale' || submission?.phase === 'uncertain') && <Button size="xs" variant="secondary" className="h-auto min-h-11 px-3 text-sm md:h-7 md:min-h-0 md:px-2.5 md:text-xs" disabled={syncing} onClick={() => { void sync(); }}>{syncing ? <Trans>正在检查</Trans> : <Trans>检查状态</Trans>}</Button>}
        {onOpenTerminal && (submission?.phase === 'stale' || submission?.phase === 'uncertain') && <Button size="xs" variant="secondary" className="h-auto min-h-11 px-3 text-sm md:h-7 md:min-h-0 md:px-2.5 md:text-xs" onClick={onOpenTerminal}><Trans>终端</Trans></Button>}
        {!connected && <span className="ml-auto text-xs text-fg-3"><Trans>重连后提交</Trans></span>}
      </footer>
    </article>
  );
}
