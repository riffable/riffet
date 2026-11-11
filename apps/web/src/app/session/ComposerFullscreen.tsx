import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import { IconX } from '@/components/icons';
import { cn } from '@/lib/utils';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { FULLSCREEN_GUTTER, FULLSCREEN_MAX_HEIGHT, fullscreenPanel } from './composerFullscreenGeometry';
import { isComposingKey } from './composerKeyboard';

/** The draft first: §4.2 puts the caret in the textarea when fullscreen opens, not on the chrome. */
const FIELD_SELECTOR = 'textarea:not([disabled]), input:not([disabled]), [contenteditable]:not([contenteditable="false"])';

/** What Tab would reach first, for a card with no field at all (a disabled or archived composer). */
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Layers that outrank the panel and answer Escape themselves: any Radix popper (the model menu, a
 * dock card's menu) or dialog (the image preview) is portalled to `<body>` at `--z-dialog` or above
 * (`styles/index.css`), while the panel is at `--z-fullscreen` — so "whoever opened last is on top"
 * also means "whoever opened last closes first" (§4.3).
 */
const ABOVE_PANEL_SELECTOR = '[role="menu"][data-state="open"], [data-radix-popper-content-wrapper] [data-state="open"]:not([role="tooltip"]), [role="dialog"][data-state="open"]';

/**
 * The composer's own slash/@ menu: §3.3's innermost layer. It is not a Radix layer and its open
 * state belongs to `Composer`, so the only way to see it from here is that it is the one listbox the
 * panel can contain (`Composer.tsx:561`); while it is open, Escape is its to close.
 */
const COMPOSER_MENU_SELECTOR = '[role="listbox"]';

/** The visual chrome of the panel while open. Nothing here translates or scales: centering is the
 *  positioner's job, so `prefers-reduced-motion` stays covered by the stylesheet's global rule. */
const PANEL_CLASS = 'pointer-events-auto flex flex-col rounded-2xl border border-line-strong bg-elevated shadow-pop animate-in fade-in-0 duration-[var(--duration-fast)]';

/** Editor state a DOM move can drop: the caret, the selection, and the field's own scroll offset. */
interface EditorState {
  selectionStart: number | null;
  selectionEnd: number | null;
  scrollTop: number;
}

function editorState(element: Element): EditorState {
  const field = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element : null;
  return {
    selectionStart: field?.selectionStart ?? null,
    selectionEnd: field?.selectionEnd ?? null,
    scrollTop: element instanceof HTMLElement ? element.scrollTop : 0,
  };
}

/**
 * Put an editor back the way it was after its subtree was re-attached.
 *
 * A browser drops focus when the focused element leaves the document, and relocating a subtree is a
 * removal followed by an insertion — so this runs on the *same* node that held focus before, never
 * on a replacement, which is the whole point of this component. Browsers disagree on whether they
 * keep the caret and the field's scroll offset across that detour, so both are restored explicitly.
 */
function restoreEditor(element: HTMLElement, state: EditorState): void {
  element.focus({ preventScroll: true });
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    // `setSelectionRange` throws on input types that have no selection (number, email, date).
    try {
      if (state.selectionStart !== null && state.selectionEnd !== null) element.setSelectionRange(state.selectionStart, state.selectionEnd);
    } catch {
      // A field without selection text: keeping focus is all it had to hold on to.
    }
  }
  element.scrollTop = state.scrollTop;
}

export interface ComposerFullscreenProps {
  open: boolean;
  /** The one line of chrome fullscreen adds: 「编辑消息」. */
  title: string;
  /** The dialog's accessible name, e.g. 「编辑消息」. */
  label: string;
  onExit: () => void;
  /** The composer card and its dock, unchanged and never re-created. */
  children: ReactNode;
}

/**
 * Fullscreen editing: the same composer card, expanded to fill the viewport.
 *
 * Why the card is not re-mounted
 * ------------------------------
 * Focus, caret, selection and the draft's own scroll all live in one `<textarea>`, and a mode that
 * loses them is worse than no mode (§7.2-1). React re-creates a subtree whenever its place in the
 * element tree changes — rendering `children` in place while closed and inside a portal while open
 * remounts the card (`updateElement` refuses a fiber whose `elementType` changed), and switching a
 * portal's container remounts it too (`updatePortal` compares `containerInfo`). So the portal here
 * is rendered once, into a container this component owns, and the container never changes: only its
 * *parent* moves — beside the anchor while closed, on `<body>` while open. The host is not one of
 * React's nodes, so no reference of React's ever goes stale when it travels, and `children` is
 * rendered once, never cloned: it only changes neighbours.
 *
 * While closed every node this component adds is `display: contents` (or `hidden`), so the session
 * column lays out exactly as it did before this component existed.
 *
 * Why a portal at all
 * -------------------
 * A panel rendered in place would be clipped or re-anchored by whatever ancestor the card happens to
 * sit in — transcript panes carry `overflow-hidden` and `content-visibility`, the terminal dock its
 * own boxes (§4.3). `<body>` has none of them.
 *
 * Why not Radix Dialog
 * --------------------
 * Its focus trap and its `--z-dialog` layering fight the two things this mode needs: the caret must be
 * free to stay in the textarea, the transcript behind must stay readable and scrollable, and a
 * picker opened from inside the panel must land above it (§4.3, §9-4).
 */
export function ComposerFullscreen({ open, title, label, onExit, children }: ComposerFullscreenProps): ReactNode {
  const { t } = useLingui();
  // Created once for the component's whole life: React identifies a portal by its container, so a
  // new node here would re-create the card inside it — the one thing this component exists to avoid.
  // It is box-less like everything else this component adds, because while closed it is still a node
  // in the session column and the card has to lay out there as if nothing had been added.
  const [host] = useState(() => {
    const node = document.createElement('div');
    node.className = 'contents';
    return node;
  });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /*
   * One layer of the page's back stack, so the browser's Back leaves fullscreen like it closes any
   * other overlay. Escape stays this component's (below): its capture listener cancels the key, and
   * the stack's own Escape handler skips a cancelled key — the panel never closes twice, and a menu
   * opened inside it is a child layer that Back dismisses first.
   */
  const { scope } = useOverlayState({ open, onOpenChange: (next) => { if (!next) onExit(); } });
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const panel = fullscreenPanel(viewport);

  // The tokens are the policy; the CSS below re-clamps at runtime, against `--app-height` — the
  // visual viewport on a phone (`use-media-query.ts`), so a soft keyboard shrinks the panel instead
  // of hiding the send button behind it.
  const appHeight = 'var(--app-height, 100dvh)';
  const geometry: CSSProperties = {
    width: `min(${panel.maxWidth}px, 100%)`,
    height: `min(calc(${appHeight} * ${panel.heightRatio}), ${FULLSCREEN_MAX_HEIGHT}px, calc(${appHeight} - ${FULLSCREEN_GUTTER}px))`,
    minHeight: `min(${panel.minHeight}px, calc(${appHeight} - ${FULLSCREEN_GUTTER}px))`,
  };

  /**
   * Put the host where the card has to live: beside its anchor while closed, on `<body>` while open.
   *
   * Only a real move touches the DOM — re-inserting an attached node detaches the draft for an
   * instant, which blurs it — and this runs after every commit, so the settled case has to be free.
   * The move itself is a removal followed by an insertion, which is precisely what a browser blurs
   * on, so whatever held focus inside the card gets it back with its caret and scroll before the
   * next paint.
   */
  const placeHost = (): void => {
    const anchor = anchorRef.current;
    const parent = anchor?.parentNode;
    if (!anchor || !parent) return;
    const inPlace = host.parentNode === parent && host.previousSibling === anchor;
    if (open ? host.parentNode === document.body : inPlace) return;
    const editor = document.activeElement;
    const state = editor ? editorState(editor) : null;
    if (open) document.body.appendChild(host);
    else parent.insertBefore(host, anchor.nextSibling);
    if (editor instanceof HTMLElement && state && host.contains(editor) && document.activeElement !== editor) restoreEditor(editor, state);
  };

  /**
   * The anchor's ref doubles as the mount-time placement.
   *
   * Refs and layout effects share a commit and the anchor is the earlier sibling, so the host is
   * already attached when the card runs its own layout effects — `Composer` measures
   * `textarea.scrollHeight` in one of them, and a textarea inside a detached host has no layout box
   * to measure: it would report 0 and open with a collapsed draft. The callback is stable, so React
   * calls it at mount — where the first render's `open` is the current one — and every later change
   * goes through the effect below.
   */
  const attachAnchor = useCallback((node: HTMLSpanElement | null) => {
    anchorRef.current = node;
    if (node) placeHost();
  }, []);

  // No dependency list, deliberately: placement is re-checked after every commit, because a
  // re-parented anchor (StrictMode's simulated remount, a re-ordered list) can leave the host
  // behind, and the guard inside makes the settled case free.
  useLayoutEffect(() => { placeHost(); });

  // §4.2 wants the caret in the draft on entry, §7.2-1 forbids taking it from the textarea the user
  // was typing in. The card is the same node in both states, so the normal path is "focus is already
  // inside the panel" and does nothing.
  useLayoutEffect(() => {
    if (!open) return;
    const element = panelRef.current;
    if (!element || element.contains(document.activeElement)) return;
    const first = element.querySelector<HTMLElement>(FIELD_SELECTOR) ?? element.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? element).focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // An IME's Escape cancels its composition, not the panel.
      if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event)) return;
      // §3.3: Escape belongs to the innermost layer. An open menu inside the panel, or a picker
      // portalled above it, closes first; the next Escape exits fullscreen.
      if (panelRef.current?.querySelector(COMPOSER_MENU_SELECTOR)) return;
      if (document.querySelector(ABOVE_PANEL_SELECTOR)) return;
      onExit();
      // The key is spoken for: nothing else may act on the same Escape (§3.3's "only one thing").
      event.preventDefault();
    };
    // Capture, so the card's own handlers cannot swallow it first; the guards above are what keep
    // the inner layers in charge of their own Escape.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onExit]);

  // The page behind stays readable (§9-4) but must not scroll under the panel. The previous inline
  // value is captured and put back, so an overlay that set `overflow` before this opened keeps its
  // own value when this one closes.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  // Nothing this component owns is left in `<body>` when it unmounts while open. Unmounting while
  // closed needs no cleanup: the host sits inside the removed subtree and goes with it.
  useEffect(() => () => { if (host.parentNode === document.body) host.remove(); }, [host]);

  return (
    <>
      {/*
        The anchor holds the card's slot in the session column while the card itself is elsewhere. It
        is React's node and never moves, so React may keep inserting siblings around it; the host
        beside it is invisible to React and is the one that travels.
      */}
      <span ref={attachAnchor} hidden />
      {createPortal(
        <>
          {open && (
            // The scrim is a sibling of the panel, not its parent: a click that lands on the panel
            // must not exit, and equal z-indexes mean the later node paints on top.
            <div
              key="scrim"
              aria-hidden="true"
              onClick={onExit}
              onMouseDown={swallowPress}
              className="fixed inset-0 z-(--z-fullscreen) bg-black/25 backdrop-blur-[1.5px] animate-in fade-in-0 duration-[var(--duration-fast)] ease-[var(--ease-decelerate)]"
            />
          )}
          {/*
            The positioner is the fixed, visual-viewport-sized box (`--app-top`/`--app-height`, the
            same pair `ImageViewer` uses) and flex-centers the panel inside it. Centering by flex
            instead of a translate keeps every transform off this subtree; centering inside
            `--app-height` instead of `100vh` keeps the panel and its send button above a phone's
            soft keyboard.
          */}
          <div
            key="positioner"
            className={cn(
              'fixed left-0 top-[var(--app-top,0px)] z-(--z-fullscreen) w-full px-4',
              open ? 'pointer-events-none flex h-[var(--app-height,100dvh)] items-center justify-center' : 'contents',
            )}
          >
            <div
              ref={panelRef}
              role={open ? 'dialog' : undefined}
              aria-modal={open ? true : undefined}
              aria-label={open ? label : undefined}
              tabIndex={open ? -1 : undefined}
              style={open ? geometry : undefined}
              className={open ? PANEL_CLASS : 'contents'}
            >
              {open && (
                <div className="flex min-h-11 shrink-0 items-center gap-2 edge-b px-4 md:min-h-9">
                  <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</h2>
                  <button
                    type="button"
                    aria-label={t`退出全屏`}
                    onClick={onExit}
                    onMouseDown={swallowPress}
                    className="grid size-11 shrink-0 place-items-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg md:size-7"
                  >
                    <IconX className="size-4" />
                  </button>
                </div>
              )}
              {/*
                No `overflow-hidden` on this column: the slash/@ menu is positioned above the card
                (`Composer.tsx:558`) and a scroll box here would clip it. The draft's textarea stays
                the single scroll port, exactly as it is outside fullscreen (§4.0).
              */}
              <div className={open ? 'flex min-h-0 flex-1 flex-col' : 'contents'}><OverlayScopeContext.Provider value={scope}>{children}</OverlayScopeContext.Provider></div>
            </div>
          </div>
        </>,
        host,
      )}
    </>
  );
}

/**
 * A press on the panel's own chrome must not hand focus to `<body>`: that would drop the caret the
 * mode exists to keep, and on a phone it dismisses the keyboard (`lib/tap-focus.ts`). Running this
 * on `mousedown` leaves the click itself alone, so the button still fires.
 */
function swallowPress(event: ReactMouseEvent<HTMLElement>): void {
  event.preventDefault();
}
