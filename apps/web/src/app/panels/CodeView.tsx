import { useEffect, useRef } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Compartment, EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, search, searchKeymap, searchPanelOpen } from '@codemirror/search';
import { unifiedMergeView } from '@codemirror/merge';
import { bracketMatching, foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language';
import { openSearchPanel } from '@codemirror/search';
import type { FilePreview } from '@contracts';
import type { PromptContextReference } from '@/lib/api';
import { codeTokens } from '@/lib/code-tokens';
import { blameGutter, changeGutter, type BlameView } from './codeGutters';
import { codeFoldingExtension } from './codeFolding';
import { isApplePlatform } from '@/lib/platform';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/** An identifier in the shown file; `line` and `column` are 1-based. */
export interface SymbolAt { word: string; line: number; column: number }
/** What a right-click in the file was on: the line and column it moved the caret to, the identifier there, and the selection it fell inside. */
export interface CodeMenuAt { line: number; column: number; symbol?: SymbolAt; selection?: string; gutter?: boolean; blame?: string }
/** Commands a caller can run in the shown file, as its menus do; a new `token` runs one again. */
export type CodeCommandName = 'find' | 'fold' | 'unfold' | 'foldAll' | 'unfoldAll' | 'selectAll';
export interface CodeCommand { name: CodeCommandName; token: number }

/**
 * A place to show: the view scrolls it to the middle and marks its line for a moment, or with
 * `restore` puts it back at the top, as it was when the file was last left.
 */
export interface CodeTarget { line?: number | undefined; column?: number | undefined; restore?: boolean; token: number }

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const FLASH_MS = 1800;
/** Tokens are worked out again this long after the last keystroke; until then the old ones move with the text. */
const RETOKENIZE_MS = 250;
/** ⌘ on a Mac, Ctrl elsewhere: the key that turns an identifier into a link, as in IDEs. */
const modifier = (event: MouseEvent | KeyboardEvent) => (isApplePlatform ? event.metaKey : event.ctrlKey);

const setSyntax = StateEffect.define<DecorationSet>();
const syntax = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => tr.effects.reduce((current, effect) => (effect.is(setSyntax) ? effect.value : current), value.map(tr.changes)),
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
  return pos === null ? undefined : symbolAtPos(view, pos);
}

/** The identifier at a position of the text, the caret touching either end of it. */
function symbolAtPos(view: EditorView, pos: number): (SymbolAt & { from: number; to: number }) | undefined {
  const range = view.state.wordAt(pos) ?? (pos > 0 ? view.state.wordAt(pos - 1) : null);
  if (!range) return undefined;
  const word = view.state.sliceDoc(range.from, range.to);
  if (!IDENTIFIER.test(word)) return undefined;
  const line = view.state.doc.lineAt(range.from);
  return { word, line: line.number, column: range.from - line.from + 1, from: range.from, to: range.to };
}

/**
 * A text file in CodeMirror, which draws only its visible ranges, for long lines and long files alike.
 * Tokens come from VS Code's TextMate grammars, in a worker, coloured from the theme's `--code-*`
 * palette; while it is edited they move with the text and are worked out again after a pause, so
 * the colours are the same as when it is read. ⌘-click (Ctrl-click) on an identifier and the context
 * menu hand it to the caller, which resolves it; a click on a line number quotes the line.
 *
 * `text` is what to show, the caller's draft while one is kept; a different `text` from outside
 * replaces the document. `original` shows the document against it, change by change, each of which
 * can be kept or taken back.
 */
export function CodeView({ preview, text = preview.content, editing = false, caret = false, folding = false, original, baseline, blame, onBlameCommit, target, command, onReference, onSymbol, onMenu, onTopLine, onViewport, onCaret, onChange, onSave, onEscape }: {
  preview: FilePreview;
  text?: string;
  editing?: boolean;
  /**
   * Read with a caret, as an IDE reads a file it will not let you change: arrows and selection move
   * through the text (no keyboard on a touch screen), the word at the caret is marked where else it
   * appears, brackets are paired, and F12 / ⌥F7 (⇧F12) hand the identifier at the caret to `onSymbol`.
   */
  caret?: boolean;
  /** Blocks fold at braces, block comments and runs of imports (`codeFolding.ts`). */
  folding?: boolean;
  original?: string | undefined;
  /** The file as committed: lines changed since are marked beside the line numbers. */
  baseline?: string | undefined;
  /** Who last changed the lines, as a column before the line numbers. */
  blame?: BlameView | undefined;
  /** A line's commit in the blame column was clicked. */
  onBlameCommit?: (hash: string) => void;
  target?: CodeTarget | undefined;
  command?: CodeCommand | undefined;
  onReference: (reference: PromptContextReference) => void;
  /**
   * With it, every right-click in the text or on the line numbers is the caller's (the browser's menu never
   * shows): the caret moves to the click unless it falls inside the selection, and `onSymbol`'s `menu` is
   * not called.
   */
  onMenu?: (at: CodeMenuAt, point: { x: number; y: number }) => void;
  /** `menu` carries where the pointer was, for a menu at it. */
  onSymbol?: (at: SymbolAt, intent: 'definition' | 'usages' | 'menu', point: { x: number; y: number }) => void;
  /** The first line in view, as the reader scrolls. */
  onTopLine?: (line: number) => void;
  /** The first and last line in view, as the reader scrolls. */
  onViewport?: (first: number, last: number) => void;
  /** Where the caret is, 1-based, as it moves (with `caret`). */
  onCaret?: (line: number, column: number) => void;
  /** The document after an edit. */
  onChange?: (text: string) => void;
  /** ⌘S (Ctrl-S) while editing. */
  onSave?: () => void;
  /** Escape while editing, with nothing of the editor's own (search) to close. */
  onEscape?: () => void;
}) {
  const { t } = useLingui();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const compartments = useRef<{ theme: Compartment; edit: Compartment; merge: Compartment; changes: Compartment; blame: Compartment; reading: Compartment; folding: Compartment } | null>(null);
  if (compartments.current === null) compartments.current = { theme: new Compartment(), edit: new Compartment(), merge: new Compartment(), changes: new Compartment(), blame: new Compartment(), reading: new Compartment(), folding: new Compartment() };
  const { theme: themeCompartment, edit: editCompartment, merge: mergeCompartment, changes: changesCompartment, blame: blameCompartment, reading: readingCompartment, folding: foldingCompartment } = compartments.current;
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
  const viewport = useRef(onViewport);
  viewport.current = onViewport;
  const menu = useRef(onMenu);
  menu.current = onMenu;
  const caretMoved = useRef(onCaret);
  caretMoved.current = onCaret;
  const reading = useRef({ caret, folding });
  reading.current = { caret, folding };
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const blameRef = useRef(blame);
  blameRef.current = blame;
  const blameCommit = useRef(onBlameCommit);
  blameCommit.current = onBlameCommit;
  const blameLabels = useRef({ uncommitted: '' });
  blameLabels.current = { uncommitted: t`未提交` };
  const blameExtension = (value: BlameView | undefined) => blameGutter(value, blameLabels.current, (hash) => blameCommit.current?.(hash), (hash, line, event) => {
    if (!menu.current) return false;
    event.preventDefault();
    menu.current({ line, column: 1, gutter: true, ...(hash ? { blame: hash } : {}) }, { x: event.clientX, y: event.clientY });
    return true;
  });
  const callbacks = useRef({ onChange, onSave, onEscape });
  callbacks.current = { onChange, onSave, onEscape };
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const originalRef = useRef(original);
  originalRef.current = original;
  /** Starts the document over from `text`, as a file read again; set while a view exists. */
  const rebuild = useRef<((text: string) => void) | undefined>(undefined);
  const mergeLabels = useRef({ accept: '', reject: '' });
  mergeLabels.current = { accept: t`保留这处修改`, reject: t`用磁盘上的` };

  /** The parts that follow the props, as they are now: a fresh state is built with these. */
  const editExtension = (on: boolean): Extension => on ? [
    history(),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { callbacks.current.onSave?.(); return true; } },
      // An open search panel takes Escape first.
      { key: 'Escape', run: (view) => { if (searchPanelOpen(view.state) || !callbacks.current.onEscape) return false; callbacks.current.onEscape(); return true; } },
      indentWithTab, ...historyKeymap, ...defaultKeymap,
    ]),
    EditorView.updateListener.of((update) => { if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString()); }),
  ] : reading.current.caret
    // Focusable with a caret but not writable; `inputmode` keeps a touch keyboard down.
    ? [EditorState.readOnly.of(true), EditorView.contentAttributes.of({ inputmode: 'none' })]
    : [EditorState.readOnly.of(true), EditorView.editable.of(false)];
  /** The IDE's reading aids, with `caret` and `folding`. */
  const readingExtension = (): Extension => {
    const withCaret = reading.current.caret;
    const atCaret = (intent: 'definition' | 'usages') => (view: EditorView) => {
      const at = symbolAtPos(view, view.state.selection.main.head);
      if (!at || !symbol.current) return false;
      const coords = view.coordsAtPos(at.from);
      symbol.current({ word: at.word, line: at.line, column: at.column }, intent, { x: coords?.left ?? 0, y: coords?.bottom ?? 0 });
      return true;
    };
    return [
      withCaret ? [
        EditorView.editorAttributes.of({ class: 'cm-caret-reading' }),
        highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 2 }),
        bracketMatching(),
        keymap.of([
          { key: 'F12', run: atCaret('definition'), preventDefault: true },
          { key: 'Alt-F7', run: atCaret('usages'), preventDefault: true },
          { key: 'Shift-F12', run: atCaret('usages'), preventDefault: true },
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.selectionSet && !update.docChanged) return;
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          caretMoved.current?.(line.number, head - line.from + 1);
        }),
      ] : highlightSelectionMatches(),
    ];
  };
  /** After the change marks, so the chevrons sit against the text as an IDE's do. */
  const foldingExtension = (): Extension => (reading.current.folding ? codeFoldingExtension({ unfold: foldLabel.current }) : []);
  const foldLabel = useRef('');
  foldLabel.current = t`展开`;
  const mergeExtension = (against: string | undefined): Extension => against === undefined ? [] : unifiedMergeView({
    original: against, gutter: true, highlightChanges: false, syntaxHighlightDeletions: false,
    mergeControls: (type, action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `cm-chunk-action cm-chunk-${type}`;
      button.textContent = mergeLabels.current[type];
      // On mouse down, so the editor keeps the selection; a key press arrives as a click.
      button.onmousedown = action;
      button.onclick = (event) => { if (event.detail === 0) action(event); };
      return button;
    },
  });

  useEffect(() => {
    if (!host.current) return;
    const clearLink = (view: EditorView) => { if (view.state.field(link).size) view.dispatch({ effects: setLink.of(null) }); };
    const extensions = (): Extension[] => [
        editCompartment.of(editExtension(editingRef.current)),
        mergeCompartment.of(mergeExtension(originalRef.current)),
        themeCompartment.of(EditorView.theme({}, { dark: darkRef.current })),
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': preview.path }),
        highlightActiveLine(), readingCompartment.of(readingExtension()), search({ top: true }), keymap.of(searchKeymap), syntax, link, flash,
        blameCompartment.of(blameExtension(blameRef.current)),
        lineNumbers({ domEventHandlers: {
          mousedown(view, block, event) {
            if (!(event instanceof MouseEvent) || event.button !== 0) return false;
            const line = view.state.doc.lineAt(block.from);
            reference.current({ path: preview.path, line: line.number, text: line.text });
            return true;
          },
          contextmenu(view, block, event) {
            if (!menu.current || !(event instanceof MouseEvent)) return false;
            event.preventDefault();
            const line = view.state.doc.lineAt(block.from);
            view.dispatch({ selection: { anchor: line.from } });
            menu.current({ line: line.number, column: 1, gutter: true }, { x: event.clientX, y: event.clientY });
            return true;
          },
        } }),
        changesCompartment.of(changeGutter(baselineRef.current)),
        foldingCompartment.of(foldingExtension()),
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
            if (menu.current) {
              event.preventDefault();
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
              const selection = view.state.selection.main;
              const inSelection = !selection.empty && selection.from <= pos && pos <= selection.to;
              const word = symbolAtPos(view, pos);
              if (!inSelection) view.dispatch({ selection: word ? { anchor: word.from, head: word.to } : { anchor: pos } });
              const head = inSelection ? selection.head : pos;
              const line = view.state.doc.lineAt(head);
              menu.current({
                line: line.number, column: head - line.from + 1,
                ...(word ? { symbol: { word: word.word, line: word.line, column: word.column } } : {}),
                ...(inSelection ? { selection: view.state.sliceDoc(selection.from, selection.to) } : {}),
              }, { x: event.clientX, y: event.clientY });
              return true;
            }
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
        EditorView.updateListener.of((update) => { if (update.docChanged) scheduleTokens(update.view); }),
        EditorView.theme({
          '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'transparent', fontSize: '12px' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '20px' },
          '.cm-gutters': { backgroundColor: 'var(--bg-card)', backdropFilter: 'blur(8px)', color: 'var(--fg-4)', border: 'none', cursor: 'pointer' },
          '.cm-lineNumbers .cm-gutterElement': { paddingLeft: '12px', paddingRight: '12px' },
          '.cm-lineNumbers .cm-gutterElement:hover': { color: 'var(--accent)' },
          '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
          '.cm-flash-line': { backgroundColor: 'var(--accent-soft)' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-soft) !important' },
          '.cm-selectionMatch': { backgroundColor: 'var(--bg-active)' },
          // The word at the caret is marked while the reader is in the file; a file just opened has its caret parked on the first word.
          '&.cm-caret-reading:not(.cm-focused) .cm-selectionMatch': { backgroundColor: 'transparent' },
          '.cm-cursor': { borderLeftColor: 'var(--accent)' },
          '.cm-symbol-link, .cm-symbol-link *': { color: 'var(--accent) !important', textDecoration: 'underline', cursor: 'pointer' },
          '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--bg-active)', outline: '1px solid var(--line-strong)' },
          '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: 'var(--danger)' },
          '.cm-foldGutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '16px', paddingRight: '4px', color: 'var(--fg-4)' },
          '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--fg)' },
          '.cm-foldGutter svg': { width: '12px', height: '12px' },
          '.cm-foldGutter .cm-fold-open': { display: 'flex', opacity: '0', transition: 'opacity var(--duration-fast) var(--ease-standard)' },
          '.cm-gutters:hover .cm-foldGutter .cm-fold-open': { opacity: '1' },
          '.cm-foldGutter .cm-fold-closed': { display: 'flex', color: 'var(--fg-2)' },
          '.cm-foldPlaceholder': { display: 'inline-block', margin: '0 2px', padding: '0 4px', border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--bg-active)', color: 'var(--fg-3)', cursor: 'pointer' },
          '&.cm-focused': { outline: 'none' },
        }),
    ];
    let active = true;
    let tokenTimer = 0;
    let tokenRun = 0;
    const tokenize = (view: EditorView) => {
      const run = ++tokenRun;
      const doc = view.state.doc.toString();
      void codeTokens(doc, preview.path).then((tokens) => {
        // An answer for text since edited would colour the wrong ranges; the next run follows.
        if (!active || !tokens || run !== tokenRun || view.state.doc.toString() !== doc) return;
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
    };
    function scheduleTokens(view: EditorView) {
      window.clearTimeout(tokenTimer);
      tokenTimer = window.setTimeout(() => tokenize(view), RETOKENIZE_MS);
    }
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: text, extensions: extensions() }) });
    editor.current = view;
    rebuild.current = (next) => { view.setState(EditorState.create({ doc: next, extensions: extensions() })); tokenize(view); };
    appliedDark.current = darkRef.current;
    let frame = 0;
    const scrolled = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        reportView();
      });
    };
    const reportView = () => {
      const { doc } = view.state;
      const top = view.scrollDOM.scrollTop;
      const first = doc.lineAt(view.lineBlockAtHeight(top).from).number;
      topLine.current?.(first);
      viewport.current?.(first, doc.lineAt(view.lineBlockAtHeight(top + view.scrollDOM.clientHeight).from).number);
    };
    requestAnimationFrame(() => { if (editor.current === view) reportView(); });
    view.scrollDOM.addEventListener('scroll', scrolled, { passive: true });
    // As on the small preview's line numbers: a click quotes the line.
    view.dom.querySelector('.cm-lineNumbers')?.setAttribute('title', t`引用这一行`);
    tokenize(view);
    return () => { active = false; window.clearTimeout(tokenTimer); cancelAnimationFrame(frame); view.scrollDOM.removeEventListener('scroll', scrolled); editor.current = undefined; rebuild.current = undefined; view.destroy(); };
  }, [preview.path]);

  useEffect(() => {
    const view = editor.current;
    if (!view || view.state.doc.toString() === text) return;
    // Text from outside (the file read again, a draft dropped): what was in view stays in view.
    const top = view.scrollDOM.scrollTop;
    rebuild.current?.(text);
    view.scrollDOM.scrollTop = top;
  }, [text]);

  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    view.dispatch({ effects: editCompartment.reconfigure(editExtension(editing)) });
    if (editing) view.focus();
  }, [editing]);

  useEffect(() => { editor.current?.dispatch({ effects: mergeCompartment.reconfigure(mergeExtension(original)) }); }, [original]);
  const readingSet = useRef({ caret, folding });
  useEffect(() => {
    const view = editor.current;
    if (!view || (readingSet.current.caret === caret && readingSet.current.folding === folding)) return;
    readingSet.current = { caret, folding };
    view.dispatch({ effects: [readingCompartment.reconfigure(readingExtension()), foldingCompartment.reconfigure(foldingExtension()), editCompartment.reconfigure(editExtension(editing))] });
  }, [caret, folding]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { editor.current?.dispatch({ effects: changesCompartment.reconfigure(changeGutter(baseline)) }); }, [baseline]);
  useEffect(() => { editor.current?.dispatch({ effects: blameCompartment.reconfigure(blameExtension(blame)) }); }, [blame]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const view = editor.current;
    if (!view || !target?.line) return;
    const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, target.line)));
    if (target.restore) { view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) }); return; }
    const anchor = Math.min(line.to, line.from + Math.max(0, (target.column ?? 1) - 1));
    view.dispatch({ selection: { anchor }, effects: [EditorView.scrollIntoView(anchor, { y: 'center' }), setFlash.of(line.from)] });
    const timer = window.setTimeout(() => { if (editor.current === view) view.dispatch({ effects: setFlash.of(null) }); }, FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [preview.path, target?.line, target?.column, target?.restore, target?.token]);

  useEffect(() => {
    const view = editor.current;
    if (!view || !command) return;
    const run = { find: openSearchPanel, fold: foldCode, unfold: unfoldCode, foldAll, unfoldAll, selectAll: (target: EditorView) => { target.dispatch({ selection: { anchor: 0, head: target.state.doc.length } }); return true; } }[command.name];
    run(view);
    view.focus();
  }, [command?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const view = editor.current;
    if (!view || appliedDark.current === dark) return;
    view.dispatch({ effects: themeCompartment.reconfigure(EditorView.theme({}, { dark })) });
    appliedDark.current = dark;
  }, [dark, themeCompartment]);

  return <div className="flex min-h-0 flex-1 flex-col">
    {/* The diff palette of `MergeDiff`, while the document is shown against another. */}
    <div ref={host} className={cn('min-h-0 flex-1 overflow-hidden', original !== undefined && 'cm-host')} />
  </div>;
}
