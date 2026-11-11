import { useLayoutEffect, useRef, type RefObject } from 'react';

const measurementProperties = [
  'box-sizing', 'width',
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch',
  'font-variant', 'font-feature-settings', 'font-variation-settings', 'font-optical-sizing',
  'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'text-transform',
  'text-rendering', 'text-size-adjust', '-webkit-text-size-adjust',
  'white-space', 'word-break', 'overflow-wrap', 'tab-size', 'direction',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'scrollbar-gutter',
] as const;

const RESIZE_ID = 'composer-resize';
/** `--duration-base`. */
const RESIZE_MS = 200;

interface ComposerAutosizeOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  placeholder: string;
  minimum: number;
  maximum: number;
  enabled: boolean;
}

/** Measure outside the layout so replacing or deleting text never collapses the live composer. */
export function useComposerAutosize(options: ComposerAutosizeOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const measureRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const element = options.textareaRef.current;
    const ownerDocument = element?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!element || !ownerDocument?.body || !ownerWindow) return;

    const mirror = ownerDocument.createElement('textarea');
    mirror.tabIndex = -1;
    mirror.setAttribute('aria-hidden', 'true');
    mirror.readOnly = true;
    mirror.rows = 1;
    Object.assign(mirror.style, {
      position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
      top: '0', left: '0', height: '0', minHeight: '0', maxHeight: 'none',
      minWidth: '0', maxWidth: 'none', margin: '0', overflow: 'hidden',
      resize: 'none', transform: 'translateZ(0)',
    });
    ownerDocument.body.append(mirror);
    const reducedMotion = ownerWindow.matchMedia('(prefers-reduced-motion: reduce)');

    const measure = () => {
      const { text, minimum, maximum, enabled } = optionsRef.current;
      if (!enabled) {
        // Fullscreen gives the live textarea its height through flex layout.
        if (element.style.height !== '') element.style.height = '';
        if (element.style.overflowY !== 'auto') element.style.overflowY = 'auto';
        return;
      }
      if (!element.isConnected || element.getClientRects().length === 0) return;
      const computed = ownerWindow.getComputedStyle(element);
      if (!(parseFloat(computed.width) > 0)) return;

      for (const property of measurementProperties) {
        mirror.style.setProperty(property, computed.getPropertyValue(property));
      }
      mirror.wrap = element.wrap;
      mirror.value = text || element.placeholder || 'x';
      // Some fonts report a smaller last line when it is empty (also used by MUI Autosize).
      if (mirror.value.endsWith('\n')) mirror.value += ' ';

      const padding = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom);
      const borders = parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);
      const measured = mirror.scrollHeight + (computed.boxSizing === 'border-box' ? borders : -padding);
      if (!(measured > 0)) return;
      const lower = Math.max(0, minimum);
      const upper = Math.max(lower, maximum);
      const height = `${Math.max(lower, Math.min(measured, upper))}px`;
      const overflow = measured > upper ? 'auto' : 'hidden';
      // Only final dimensions reach the live node; focus, selection and IME stay untouched.
      if (element.style.height !== height) {
        const previous = parseFloat(element.style.height);
        element.style.height = height;
        // Typing moves a line at a time and follows the caret at once; a jump of several lines
        // (the draft sent and cleared, a paste, a restored draft) slides to its new height.
        const step = parseFloat(height) - previous;
        const line = parseFloat(computed.lineHeight) || 24;
        if (Math.abs(step) > line * 1.5 && !reducedMotion.matches) {
          for (const animation of element.getAnimations()) if (animation.id === RESIZE_ID) animation.cancel();
          element.animate([{ height: `${previous}px` }, { height }], { id: RESIZE_ID, duration: RESIZE_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
        }
      }
      if (element.style.overflowY !== overflow) element.style.overflowY = overflow;
    };
    measureRef.current = measure;

    let observedWidth: number | undefined;
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === observedWidth) return;
      observedWidth = entry.contentRect.width;
      measure();
    });
    resizeObserver.observe(element);

    // Display settings apply --text-scale directly to the root, without a Composer render.
    // Ignore other theme mutations so they do not add layout reads while typing.
    const root = ownerDocument.documentElement;
    let textScale = root.style.getPropertyValue('--text-scale');
    const styleObserver = new MutationObserver(() => {
      const nextScale = root.style.getPropertyValue('--text-scale');
      if (nextScale === textScale) return;
      textScale = nextScale;
      measure();
    });
    styleObserver.observe(root, { attributes: true, attributeFilter: ['style'] });
    const fonts = ownerDocument.fonts;
    let disposed = false;
    const onFontsReady = () => { if (!disposed) measure(); };
    void fonts.ready.then(onFontsReady);
    fonts.addEventListener('loadingdone', onFontsReady);
    fonts.addEventListener('loadingerror', onFontsReady);
    ownerWindow.addEventListener('resize', measure);

    return () => {
      disposed = true;
      measureRef.current = null;
      resizeObserver.disconnect();
      styleObserver.disconnect();
      fonts.removeEventListener('loadingdone', onFontsReady);
      fonts.removeEventListener('loadingerror', onFontsReady);
      ownerWindow.removeEventListener('resize', measure);
      mirror.remove();
    };
  }, [options.textareaRef]);

  useLayoutEffect(() => { measureRef.current?.(); }, [
    options.textareaRef, options.text, options.placeholder, options.minimum, options.maximum, options.enabled,
  ]);
}
