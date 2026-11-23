import { RangeSet, StateField, Text, type Extension, type Range } from '@codemirror/state';
import { gutter, GutterMarker, type EditorView } from '@codemirror/view';
import { Chunk } from '@codemirror/merge';

/** Who last changed some lines: consecutive lines of one commit, and the commits by hash (`GitBlame` in the contracts has this shape). */
export interface BlameView {
  ranges: ReadonlyArray<{ start: number; count: number; hash: string }>;
  commits: Readonly<Record<string, { author: string; date: string; summary: string }>>;
}

/** Lines changed against an earlier version of the file, as the IDE's gutter marks them; the diff gives up rather than stall on a huge file. */
const DIFF = { scanLimit: 2_000, timeout: 200 };

class ChangeMarker extends GutterMarker {
  override elementClass: string;
  constructor(readonly kind: 'added' | 'modified' | 'deleted') {
    super();
    this.elementClass = `cm-change-${kind}`;
  }
  override eq(other: GutterMarker) { return other instanceof ChangeMarker && other.kind === this.kind; }
}
const MARKERS = { added: new ChangeMarker('added'), modified: new ChangeMarker('modified'), deleted: new ChangeMarker('deleted') };

function changeMarkers(baseline: Text, doc: Text): RangeSet<GutterMarker> {
  const marks: Array<Range<GutterMarker>> = [];
  for (const chunk of Chunk.build(baseline, doc, DIFF)) {
    if (chunk.fromB === chunk.toB) {
      // Lines removed: a mark on the line that follows them.
      marks.push(MARKERS.deleted.range(doc.lineAt(Math.min(chunk.fromB, doc.length)).from));
      continue;
    }
    const marker = chunk.fromA === chunk.toA ? MARKERS.added : MARKERS.modified;
    const last = doc.lineAt(Math.min(chunk.endB, doc.length)).number;
    for (let number = doc.lineAt(chunk.fromB).number; number <= last; number++) marks.push(marker.range(doc.line(number).from));
  }
  return RangeSet.of(marks, true);
}

/** A gutter beside the line numbers marking lines added, changed or removed since `baseline` (the file as committed). */
export function changeGutter(baseline: string | undefined): Extension {
  if (baseline === undefined) return [];
  const before = Text.of(baseline.split('\n'));
  const field = StateField.define<RangeSet<GutterMarker>>({
    create: (state) => changeMarkers(before, state.doc),
    update: (value, transaction) => (transaction.docChanged ? changeMarkers(before, transaction.state.doc) : value),
  });
  return [field, gutter({ class: 'cm-change-gutter', markers: (view) => view.state.field(field) })];
}

class BlameMarker extends GutterMarker {
  constructor(readonly text: string, readonly title: string, readonly hash: string) { super(); }
  override eq(other: GutterMarker) { return other instanceof BlameMarker && other.text === this.text && other.hash === this.hash && other.title === this.title; }
  override toDOM() {
    const element = document.createElement('span');
    element.textContent = this.text;
    element.title = this.title;
    return element;
  }
}

const UNCOMMITTED = /^0+$/;

/**
 * Who last changed each line, as a column left of the line numbers: the date and author on the first
 * line of each run from one commit, the commit's summary on hover. Lines not committed yet are blank,
 * with `labels.uncommitted` on hover; a click hands the commit to `onCommit`.
 */
export function blameGutter(blame: BlameView | undefined, labels: { uncommitted: string }, onCommit?: (hash: string) => void): Extension {
  if (!blame) return [];
  const byLine = new Map<number, BlameMarker>();
  const hashOf = new Map<number, string>();
  for (const range of blame.ranges) {
    const commit = blame.commits[range.hash];
    const uncommitted = UNCOMMITTED.test(range.hash);
    // Lines not committed yet stay blank, as in the IDE; the hover says why.
    const text = uncommitted ? '' : commit ? `${commit.date.slice(0, 10)}  ${commit.author}` : range.hash.slice(0, 8);
    const title = uncommitted ? labels.uncommitted : !commit ? text : `${range.hash.slice(0, 10)} · ${commit.author} · ${commit.date.slice(0, 10)}\n${commit.summary}`;
    byLine.set(range.start, new BlameMarker(text, title, range.hash));
    for (let line = range.start; line < range.start + range.count; line++) hashOf.set(line, range.hash);
  }
  const starts = [...byLine].sort((a, b) => a[0] - b[0]);
  const markers = (view: EditorView) => {
    const { doc } = view.state;
    return RangeSet.of(starts.filter(([line]) => line <= doc.lines).map(([line, marker]) => marker.range(doc.line(line).from)));
  };
  return gutter({
    class: 'cm-blame-gutter',
    markers,
    domEventHandlers: {
      mousedown(view, block) {
        const hash = hashOf.get(view.state.doc.lineAt(block.from).number);
        if (!hash || UNCOMMITTED.test(hash) || !onCommit) return false;
        onCommit(hash);
        return true;
      },
    },
  });
}
