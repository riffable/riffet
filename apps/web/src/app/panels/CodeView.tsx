import { useEffect, useRef } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Compartment, EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, highlightActiveLine, lineNumbers, type DecorationSet } from '@codemirror/view';
import type { FilePreview } from '@contracts';
import type { PromptContextReference } from '@/lib/api';
import { codeTokens } from '@/lib/code-tokens';
import { isApplePlatform } from '@/lib/platform';
import { useTheme } from '@/lib/theme';

/** An identifier in the shown file; `line` and `column` are 1-based. */
export interface SymbolAt { word: string; line: number; column: number }
/**
 * A place to show: the view scrolls it to the middle and marks its line for a moment, or with
 * `restore` puts it back at the top, as it was when the file was last left.
 */
export interface CodeTarget { line?: number | undefined; column?: number | undefined; restore?: boolean; token: number }

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const FLASH_MS = 1800;
/** ⌘ on a Mac, Ctrl elsewhere: the key that turns an identifier into a link, as in IDEs. */
const modifier = (event: MouseEvent | KeyboardEvent) => (isApplePlatform ? event.metaKey : event.ctrlKey);

const setSyntax = StateEffect.define<DecorationSet>();
const syntax = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => tr.effects.reduce((current, effect) => (effect.is(setSyntax) ? effect.value : current), value),
  provide: (field) => EditorView.decorations.from(field),
});

const linkMark = Decoration.mark({ class: 'cm-symbol-link' });
const setLink = StateEffect.define<{ from: number; to: number } | null>();
const link = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setLink)) value = effect.value ? Decoration.set([linkMark.range(effect.value.from, effect.value.to)]) : Decoration.none;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const flashLine = Decoration.line({ class: 'cm-flash-line' });
const setFlash = StateEffect.define<number | null>();
const flash = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setFlash)) value = effect.value === null ? Decoration.none : Decoration.set([flashLine.range(effect.value)]);
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The identifier under a point, with its range; `undefined` off the text or on anything else. */
function symbolAt(view: EditorView, x: number, y: number): (SymbolAt & { from: number; to: number }) | undefined {
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return undefined;
  const range = view.state.wordAt(pos);
  if (!range) return undefined;
  const word = view.state.sliceDoc(range.from, range.to);
  if (!IDENTIFIER.test(word)) return undefined;
  const line = view.state.doc.lineAt(range.from);
  return { word, line: line.number, column: range.from - line.from + 1, from: range.from, to: range.to };
}

/**
 * A text file as a read-only CodeMirror, which draws only its visible ranges, for long lines and
 * long files alike. Tokens come from VS Code's TextMate grammars, in a worker, coloured from the
 * theme's `--code-*` palette. ⌘-click (Ctrl-click) on an identifier and the context menu hand it to the caller,
 * which resolves it; a click on a line number quotes the line.
 */
export function CodeView({ preview, target, onReference, onSymbol, onTopLine }: {
  preview: FilePreview;
  target?: CodeTarget | undefined;
  onReference: (reference: PromptContextReference) => void;
  /** `menu` carries where the pointer was, for a menu at it. */
  onSymbol?: (at: SymbolAt, intent: 'definition' | 'menu', point: { x: number; y: number }) => void;
  /** The first line in view, as the reader scrolls. */
  onTopLine?: (line: number) => void;
}) {
  const { t } = useLingui();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const themeCompartmentRef = useRef<Compartment | null>(null);
  if (themeCompartmentRef.current === null) themeCompartmentRef.current = new Compartment();
  const themeCompartment = themeCompartmentRef.current;
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const darkRef = useRef(dark);
  const appliedDark = useRef<boolean | undefined>(undefined);
  darkRef.current = dark;
  const reference = useRef(onReference);
  reference.current = onReference;
  const symbol = useRef(onSymbol);
  symbol.current = onSymbol;
  const topLine = useRef(onTopLine);
  topLine.current = onTopLine;

  useEffect(() => {
    if (!host.current) return;
    const clearLink = (view: EditorView) => { if (view.state.field(link).size) view.dispatch({ effects: setLink.of(null) }); };
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: preview.content, extensions: [
        EditorState.readOnly.of(true), EditorView.editable.of(false),
        themeCompartment.of(EditorView.theme({}, { dark: darkRef.current })),
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': preview.path }),
        highlightActiveLine(), syntax, link, flash,
        lineNumbers({ domEventHandlers: { mousedown(view, block, event) {
          if (!(event instanceof MouseEvent) || event.button !== 0) return false;
          const line = view.state.doc.lineAt(block.from);
          reference.current({ path: preview.path, line: line.number, text: line.text });
          return true;
        } } }),
        EditorView.domEventHandlers({
          mousemove(event, view) {
            const at = symbol.current && modifier(event) ? symbolAt(view, event.clientX, event.clientY) : undefined;
            const current = view.state.field(link).iter();
            if (at ? current.value && current.from === at.from && current.to === at.to : !current.value) return false;
            view.dispatch({ effects: setLink.of(at ? { from: at.from, to: at.to } : null) });
            return false;
          },
          mouseleave(_event, view) { clearLink(view); return false; },
          keyup(event, view) { if (!modifier(event)) clearLink(view); return false; },
          mousedown(event, view) {
            if (event.button !== 0 || !modifier(event) || !symbol.current) return false;
            const at = symbolAt(view, event.clientX, event.clientY);
            if (!at) return false;
            event.preventDefault();
            clearLink(view);
            symbol.current({ word: at.word, line: at.line, column: at.column }, 'definition', { x: event.clientX, y: event.clientY });
            return true;
          },
          contextmenu(event, view) {
            const at = symbol.current ? symbolAt(view, event.clientX, event.clientY) : undefined;
            if (!at) return false;
            // Inside a longer selection the browser's own menu stays, for Copy.
            const selection = view.state.selection.main;
            if (selection.from <= at.from && at.to <= selection.to && selection.to - selection.from > at.to - at.from) return false;
            event.preventDefault();
            view.dispatch({ selection: { anchor: at.from, head: at.to } });
            symbol.current?.({ word: at.word, line: at.line, column: at.column }, 'menu', { x: event.clientX, y: event.clientY });
            return true;
          },
        }),
        EditorView.theme({
          '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'transparent', fontSize: '12px' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '20px' },
          '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-4)', border: 'none', cursor: 'pointer' },
          '.cm-lineNumbers .cm-gutterElement': { paddingLeft: '12px', paddingRight: '12px' },
          '.cm-lineNumbers .cm-gutterElement:hover': { color: 'var(--accent)' },
          '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
          '.cm-flash-line': { backgroundColor: 'var(--accent-soft)' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-soft) !important' },
          '.cm-symbol-link, .cm-symbol-link *': { color: 'var(--accent) !important', textDecoration: 'underline', cursor: 'pointer' },
          '&.cm-focused': { outline: 'none' },
        }),
      ] }),
    });
    editor.current = view;
    appliedDark.current = darkRef.current;
    let frame = 0;
    const scrolled = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        topLine.current?.(view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number);
      });
    };
    view.scrollDOM.addEventListener('scroll', scrolled, { passive: true });
    // As on the small preview's line numbers: a click quotes the line.
    view.dom.querySelector('.cm-lineNumbers')?.setAttribute('title', t`引用这一行`);
    let active = true;
    void codeTokens(view.state.doc.toString(), preview.path).then((tokens) => {
      if (!active || !tokens) return;
      const styles = tokens.styles.map(({ color, italic }) => Decoration.mark({ attributes: { style: `${color ? `color:${color};` : ''}${italic ? 'font-style:italic;' : ''}` } }));
      const marks: Range<Decoration>[] = [];
      const { ranges } = tokens;
      const end = view.state.doc.length;
      for (let index = 0; index + 2 < ranges.length; index += 3) {
        const from = ranges[index]!, to = Math.min(ranges[index + 1]!, end);
        if (to > from) marks.push(styles[ranges[index + 2]!]!.range(from, to));
      }
      view.dispatch({ effects: setSyntax.of(Decoration.set(marks, true)) });
    });
    return () => { active = false; cancelAnimationFrame(frame); view.scrollDOM.removeEventListener('scroll', scrolled); editor.current = undefined; view.destroy(); };
  }, [preview.path, preview.content]);

  useEffect(() => {
    const view = editor.current;
    if (!view || !target?.line) return;
    const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, target.line)));
    if (target.restore) { view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) }); return; }
    const anchor = Math.min(line.to, line.from + Math.max(0, (target.column ?? 1) - 1));
    view.dispatch({ selection: { anchor }, effects: [EditorView.scrollIntoView(anchor, { y: 'center' }), setFlash.of(line.from)] });
    const timer = window.setTimeout(() => { if (editor.current === view) view.dispatch({ effects: setFlash.of(null) }); }, FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [preview.path, preview.content, target?.line, target?.column, target?.restore, target?.token]);

  useEffect(() => {
    const view = editor.current;
    if (!view || appliedDark.current === dark) return;
    view.dispatch({ effects: themeCompartment.reconfigure(EditorView.theme({}, { dark })) });
    appliedDark.current = dark;
  }, [dark, themeCompartment]);

  return <div className="flex min-h-0 flex-1 flex-col">
    <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
    {preview.truncated && <div className="px-4 py-2 text-xs text-fg-3"><Trans>文件过大，仅显示前一部分</Trans></div>}
  </div>;
}
