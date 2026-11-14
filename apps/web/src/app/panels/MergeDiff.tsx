import { useEffect, useRef } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Text } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view';
import { getChunks, getOriginalDoc, unifiedMergeView } from '@codemirror/merge';
import type { GitDiff, GitLineChange } from '@contracts';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

export type LineRange = { from: number; to: number };
export type Marks = { commented: LineRange[]; selected?: LineRange };

/** Lines carrying a review remark, and the range being written about, painted onto the diff. */
const setMarks = StateEffect.define<Marks>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setMarks)) continue;
      const { doc } = transaction.state;
      const classes = new Map<number, string>();
      const paint = (range: LineRange, name: string) => {
        for (let line = Math.max(1, range.from); line <= Math.min(doc.lines, range.to); line += 1) classes.set(line, classes.has(line) ? `${classes.get(line)} ${name}` : name);
      };
      effect.value.commented.forEach((range) => paint(range, 'cm-review-commented'));
      if (effect.value.selected) paint(effect.value.selected, 'cm-review-selected');
      const builder = new RangeSetBuilder<Decoration>();
      [...classes.keys()].sort((a, b) => a - b).forEach((line) => builder.add(doc.line(line).from, doc.line(line).from, Decoration.line({ class: classes.get(line)! })));
      return builder.finish();
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** What the two buttons on each changed block do; a missing label leaves that button out. */
export interface ChunkControls { accept?: string; reject?: string; onChunk: (type: 'accept' | 'reject', change: GitLineChange) => void }

/** The line a position starts, counted from zero; a position past the end is the line after the last. */
const lineIndex = (doc: Text, position: number) => (position > doc.length ? doc.lines : doc.lineAt(position).number - 1);

export default function MergeDiff({ diff, marks, onLine, controls }: { diff: GitDiff; marks?: Marks; onLine?: (line: number, text: string, extend: boolean) => void; controls?: ChunkControls }) {
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
  const lineRef = useRef(onLine);
  lineRef.current = onLine;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const commentable = Boolean(onLine);
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const acceptLabel = controls?.accept;
  const rejectLabel = controls?.reject;
  /** Where the reader was in this file, so acting on one block does not send them back to the top. */
  const scrolled = useRef<{ path: string; top: number } | undefined>(undefined);
  useEffect(() => {
    if (!host.current || diff.binary) return;
    const scroller = host.current.parentElement;
    const chunkButton = (type: 'accept' | 'reject') => {
      const label = type === 'accept' ? acceptLabel : rejectLabel;
      const button = document.createElement('button');
      button.type = 'button';
      if (!label) { button.hidden = true; return button; }
      button.textContent = label;
      button.className = `cm-chunk-action cm-chunk-${type}`;
      button.onmousedown = (event) => {
        event.preventDefault();
        const view = editor.current;
        if (!view) return;
        const position = view.posAtDOM(button);
        const chunk = getChunks(view.state)?.chunks.find((item) => item.fromB <= position && item.endB >= position);
        if (!chunk) return;
        const before = getOriginalDoc(view.state);
        controlsRef.current?.onChunk(type, { before: [lineIndex(before, chunk.fromA), lineIndex(before, chunk.toA)], after: [lineIndex(view.state.doc, chunk.fromB), lineIndex(view.state.doc, chunk.toB)] });
      };
      return button;
    };
    const view = new EditorView({
      state: EditorState.create({
        doc: diff.after,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          themeCompartment.of(EditorView.theme({}, { dark: darkRef.current })),
          unifiedMergeView({ original: diff.before, highlightChanges: true, gutter: true, mergeControls: acceptLabel || rejectLabel ? chunkButton : false, collapseUnchanged: { margin: 3, minSize: 5 } }),
          // Line numbers count the new file, which is where a remark has to point for the agent to find it.
          ...(commentable ? [
            lineNumbers({ domEventHandlers: { mousedown(target, block, event) {
              if (!(event instanceof MouseEvent) || event.button !== 0) return false;
              const line = target.state.doc.lineAt(block.from);
              lineRef.current?.(line.number, line.text, event.shiftKey);
              return true;
            } } }),
            marksField,
          ] : []),
        ],
      }),
      parent: host.current,
    });
    editor.current = view;
    appliedDark.current = darkRef.current;
    if (marksRef.current) view.dispatch({ effects: setMarks.of(marksRef.current) });
    if (scroller && scrolled.current?.path === diff.path) scroller.scrollTop = scrolled.current.top;
    return () => {
      if (scroller) scrolled.current = { path: diff.path, top: scroller.scrollTop };
      editor.current = undefined;
      view.destroy();
    };
  }, [diff, commentable, acceptLabel, rejectLabel]);
  useEffect(() => {
    const view = editor.current;
    if (!view || appliedDark.current === dark) return;
    view.dispatch({ effects: themeCompartment.reconfigure(EditorView.theme({}, { dark })) });
    appliedDark.current = dark;
  }, [dark, themeCompartment]);
  useEffect(() => { if (marks && commentable) editor.current?.dispatch({ effects: setMarks.of(marks) }); }, [marks, commentable]);
  if (diff.binary) return <pre className="overflow-auto p-4 font-mono text-xs text-fg-2">{diff.patch || t`Binary file`}</pre>;
  return <div ref={host} className={cn('cm-host min-h-0', commentable && 'cm-review')} />;
}
