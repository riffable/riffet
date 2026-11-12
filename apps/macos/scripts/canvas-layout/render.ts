// Turns the canvas's layout (`flow.ts`) into the model the native renderers draw. Everything the web
// cards derive with the canvas's own helpers is derived here with the same ones, so Swift only paints.
import type { Session, TurnOutlineV3 } from '@contracts';
import {
  LIVE_STATES, attachmentsOf, callLabel, formatDuration, outputTail, plainText, turnKey, unwrapShell,
  type Actor, type Artifact, type FileChange, type Step, type Track, type TurnDetail,
} from '../../../../plugins/riffet/canvas/web/detail';
import { ART, BAR, CHANGE, ROW, STRIP, trackLine, type Block, type FlowLayout, type FlowNode, type Level, type Mark, type TrackBand } from '../../../../plugins/riffet/canvas/web/flow';
import type { Messages } from '../../../../plugins/riffet/canvas/web/messages';
import { MEDIA_PREFIX } from './fold';

type Obj = Record<string, unknown>;
type Of<K extends FlowNode['kind']> = Extract<FlowNode, { kind: K }>;

/** Everything a render needs besides the layout itself. */
export interface RenderInput {
  layout: FlowLayout;
  level: Level;
  now: number;
  m: Messages;
  focus: string;
  /** Every conversation of the family has its outline. */
  ready: boolean;
  details: ReadonlyMap<string, TurnDetail>;
  lanes: ReadonlyMap<string, TurnDetail | null>;
  runs: ReadonlyMap<string, { state: string; outputTokens?: number }>;
  summaries: ReadonlyMap<string, string> | undefined;
  closedLanes: ReadonlySet<string>;
}

const r1 = (value: number) => Math.round(value * 10) / 10;
const box = (n: { w: number; h: number }) => ({ w: r1(n.w), h: r1(n.h) });
const q = JSON.stringify;
/** A card clamps its text to a few lines, so it never needs more than a screenful of characters; `detail` has the rest. */
const clip = (text: string, chars: number) => text.length > chars ? text.slice(0, chars) : text;

/** 32-bit FNV-1a, enough to tell whether a card's drawn content changed. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const GLYPH: Record<Track, string> = { shell: 'stroke', explore: 'ring', web: 'diamond', ask: 'pin', other: 'square' };
/** Mark flags: failed, running, and an explore read (a tick where other explore calls are rings). */
const FAILED = 1, RUNNING = 2, TICK = 4;
/** A mark's times are offsets from its node's `t`, which keeps the numbers short. */
const markOf = (track: Track, step: Step, mark: Mark, base: number) =>
  [r1(mark.x), r1(mark.x2), step.start - base, step.end - base, (step.failed ? FAILED : 0) | (step.running ? RUNNING : 0) | (track === 'explore' && step.kindName === 'read' ? TICK : 0)];

/** The label of a call as its strip names it. */
function labelOf(step: Step, track: Track) {
  const label = callLabel(step, track);
  return { text: label.text, ...(label.mono ? { mono: true } : {}), ...(label.aside ? { aside: label.aside } : {}) };
}

function blockOf(block: Block, m: Messages): Obj {
  switch (block.kind) {
    case 'thought': case 'commentary': return { kind: block.kind, text: clip(block.text, 140), h: block.h };
    case 'plan': {
      const entries = block.step.entries ?? [];
      return { kind: 'plan', title: m.plan, entries: entries.slice(0, entries.length - block.hidden), hidden: block.hidden, h: block.h };
    }
    case 'actor': return { kind: 'actor', background: block.step.kind === 'background', label: block.step.label, duration: formatDuration(block.step.end - block.step.start), h: block.h };
    case 'calls': {
      const counts = new Map<string, { kind: string; count: number }>();
      for (const step of block.steps) {
        const name = step.toolName ?? step.kindName ?? 'other';
        const held = counts.get(name);
        if (held) held.count += 1; else counts.set(name, { kind: step.kindName ?? 'other', count: 1 });
      }
      return { kind: 'calls', items: [...counts].map(([name, item]) => ({ name, tool: item.kind, count: item.count })), failed: block.steps.some((step) => step.failed), h: block.h };
    }
    case 'compaction': return { kind: 'compaction', text: `${m.compaction}${block.step.label ? ` ${block.step.label}` : ''}`, h: block.h };
    case 'status': return { kind: 'status', text: block.step.label, h: block.h };
    case 'answer': return { kind: 'answer', text: clip(block.text, 1000), lines: block.lines, h: block.h };
  }
}

/** Added and removed lines over a turn's steps, as the answer card's head shows them. */
function diffOf(detail: TurnDetail | undefined): { added: number; removed: number } | undefined {
  let added = 0, removed = 0;
  for (const step of detail?.steps ?? []) { added += step.added ?? 0; removed += step.removed ?? 0; }
  return added || removed ? { added, removed } : undefined;
}

/** The silence between two turns, said as the ground says it. */
function silence(ms: number, m: Messages): string {
  const hours = ms / 3_600_000;
  if (hours >= 24) return m.daysLater(Math.round(hours / 24));
  if (hours >= 1) return m.hoursLater(Math.round(hours));
  return m.minutesLater(Math.round(ms / 60_000));
}

const LINE_TYPE = { add: 'a', del: 'd', same: 's', gap: 'g' } as const;

/** One written file as the ledger lists it: the part of the path below the track's directory, split into name and folder. */
function fileOf(change: FileChange, base: string, lines: number): Obj {
  const path = base && change.path.startsWith(`${base}/`) ? change.path.slice(base.length + 1) : change.path;
  const slash = path.lastIndexOf('/');
  return {
    path: change.path, name: path.slice(slash + 1), ...(slash > 0 ? { dir: path.slice(0, slash + 1) } : {}),
    added: change.added, removed: change.removed, ...(change.created ? { created: true } : {}), ...(change.deleted ? { deleted: true } : {}),
    ...(change.edits.length ? { edits: true } : {}),
    ...(lines > 0 ? { preview: change.preview.slice(0, lines).map((line) => [LINE_TYPE[line.type], line.text]) } : {}),
  };
}

/** An artifact as a card names it; an image the agent wrote inline keeps its data for `detail`. */
const artifactOf = (item: Artifact): Obj => ({ key: item.key, kind: item.kind, name: item.name, ...(item.path ? { path: item.path } : {}), ...(item.src && !item.src.startsWith(MEDIA_PREFIX) ? { inline: true } : {}) });

export interface Rendered { json: string; nodes: Map<string, FlowNode> }

export function render(input: RenderInput): Rendered {
  const { layout, level, now, m, details, lanes, runs, summaries } = input;
  const sessions: Session[] = [];
  const sessionIndex = new Map<string, number>();
  const si = (session: Session) => {
    let index = sessionIndex.get(session.id);
    if (index === undefined) { index = sessions.length; sessions.push(session); sessionIndex.set(session.id, index); }
    return index;
  };
  const turns: Obj[] = [];
  const turnIndex = new Map<string, number>();
  const ti = (session: Session, turn: TurnOutlineV3) => {
    const key = turnKey(session.id, turn.turn);
    let index = turnIndex.get(key);
    if (index === undefined) {
      index = turns.length;
      turnIndex.set(key, index);
      const nativeId = details.get(key)?.userNativeId;
      const tokens = turn.runId ? runs.get(turn.runId)?.outputTokens : undefined;
      turns.push({ si: si(session), id: turn.turn, status: turn.status, ...(turn.runId ? { runId: turn.runId } : {}), ...(nativeId ? { nativeId } : {}), ...(tokens ? { tokens } : {}) });
    }
    return index;
  };

  const byId = new Map<string, FlowNode>();
  const out: string[] = [];
  // Cards refer to one another by their place in `nodes`, which keeps the long ids out of every edge.
  const at = new Map(layout.nodes.map((node, index) => [node.id, index]));
  const push = (node: FlowNode, body: Obj, turn?: number) => {
    byId.set(node.id, node);
    const json = q({ ...box(node), ...body });
    // Position and time stay out of the hash: moving a card does not change its bitmap.
    out.push(`{"id":${q(node.id)},"kind":"${node.kind}","x":${r1(node.x)},"y":${r1(node.y)},"t":${node.t},${turn === undefined ? '' : `"ti":${turn},`}"v":"${hash(json)}",${json.slice(1)}`);
  };

  for (const node of layout.nodes) {
    switch (node.kind) {
      case 'header': {
        const { session } = node;
        push(node, {
          si: si(session), title: session.title, ...(LIVE_STATES.has(session.state) ? { live: true } : {}), ...(node.fork ? { fork: node.fork } : {}),
          ...(node.written ? { written: node.written } : {}),
        });
        break;
      }
      case 'user': {
        const { images, others } = attachmentsOf(node.detail?.attachments ?? []);
        const steers = node.detail?.steers ?? [];
        push(node, {
          variant: node.variant, ...(node.origin ? { origin: node.origin } : {}), text: clip(node.text, level === 'detail' ? 640 : 240), lines: node.lines,
          ...(images.length ? { images: images.slice(0, 6).map((image) => image.id) } : {}), ...(others ? { others } : {}),
          ...(steers.length ? { steers: steers.map((steer) => clip(steer.text, 300)) } : {}),
        }, ti(node.session, node.turn));
        break;
      }
      case 'signal': {
        const arrivals = node.detail?.arrivals ?? [];
        push(node, { ...(arrivals.length ? { arrivals: arrivals.map((a) => ({ id: a.id, title: a.title, status: a.status, at: a.at })) } : {}) }, ti(node.session, node.turn));
        break;
      }
      case 'fold': push(node, { tokens: node.tokens }, ti(node.session, node.turn)); break;
      case 'agent': {
        const { detail, turn } = node;
        const running = turn.status === 'running';
        const answer = detail?.answer ? plainText(detail.answer) : '';
        const counts = new Map<string, number>();
        for (const step of detail?.steps ?? []) if (step.kind === 'tool') counts.set(step.kindName ?? 'other', (counts.get(step.kindName ?? 'other') ?? 0) + 1);
        const subagents = detail?.actors.filter((actor) => actor.kind === 'subagent').length ?? 0;
        const background = (detail?.actors.length ?? 0) - subagents;
        const elapsed = node.end - node.t;
        const diff = diffOf(detail);
        push(node, {
          end: node.end, ...(detail ? {} : { pending: true }), ...(running ? { running: true } : {}),
          ...(!running && detail?.steps.some((step) => step.kind === 'status' && step.failed) ? { errored: true } : {}),
          ...(turn.status === 'failed' || turn.status === 'cancelled' ? { stopped: true } : {}),
          ...(elapsed > 0 ? { elapsed: formatDuration(elapsed) } : {}), ...(diff ? { diff } : {}),
          ...(node.blocks ? { blocks: node.blocks.map((block) => blockOf(block, m)) } : {
            previewLines: node.previewLines, ...(node.summary ? { summary: node.summary } : {}), ...(answer ? { preview: clip(answer, 220) } : {}),
            ...(detail && (detail.tools || detail.actors.length) ? { activity: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tool, count]) => ({ tool, count })), subagents, background } : {}),
          }),
          ...(detail?.answer ? { copy: true } : {}),
        }, ti(node.session, turn));
        break;
      }
      case 'actor': {
        const { actor } = node;
        const subagent = actor.kind === 'subagent';
        const elapsed = node.end - actor.start;
        push(node, {
          end: node.end, start: actor.start, subagent, name: subagent ? actor.label : actor.note ?? actor.label, ...(subagent && actor.note ? { note: actor.note } : {}),
          ...(actor.running ? { running: true } : {}), ...(actor.failed ? { failed: true } : {}), bar: r1(node.bar), ...(node.report !== undefined ? { report: r1(node.report) } : {}),
          marks: node.marks.map((mark) => markOf('other', node.steps[mark.index]!, mark, node.t)),
          ...(node.conclusion ? { conclusion: node.conclusion } : {}), ...(actor.lane ? { lane: actor.lane } : {}), ...(elapsed >= 1000 ? { elapsed: formatDuration(elapsed) } : {}),
        }, ti(node.session, node.turn));
        break;
      }
      case 'change': {
        const { changes, shown } = node;
        const added = changes.reduce((sum, change) => sum + change.added, 0);
        const removed = changes.reduce((sum, change) => sum + change.removed, 0);
        const anyEdits = changes.some((change) => change.edits.length > 0);
        push(node, {
          agent: at.get(node.agent) ?? -1, base: node.base, count: changes.length, added, removed, ...(anyEdits ? { edits: true } : {}),
          share: Math.round((added / Math.max(1, added + removed)) * 100), counted: anyEdits && added + removed > 0,
          files: changes.slice(0, shown).map((change, index) => fileOf(change, node.base, node.lines[index] ?? 0)),
          ...(changes.length > shown ? { hidden: changes.slice(shown).map((change) => change.path) } : {}),
        }, ti(node.session, node.turn));
        break;
      }
      case 'artifacts': {
        push(node, { agent: at.get(node.agent) ?? -1, items: node.items.slice(0, node.shown).map(artifactOf), more: node.items.length - node.shown }, ti(node.session, node.turn));
        break;
      }
      case 'tools': {
        push(node, {
          agent: at.get(node.agent) ?? -1, track: node.track, glyph: GLYPH[node.track], count: node.steps.length,
          marks: node.marks.map((mark) => markOf(node.track, node.steps[mark.index]!, mark, node.t)),
          callouts: node.callouts.map((callout) => {
            const step = node.steps[callout.index]!;
            return { i: callout.index, x: r1(callout.x), row: callout.row, side: callout.side, w: r1(callout.w), ...labelOf(step, node.track), ...(step.failed ? { failed: true } : {}) };
          }),
        }, ti(node.session, node.turn));
        break;
      }
    }
  }

  const trackName = (track: TrackBand) => {
    switch (track.kind) {
      case 'write': return track.label;
      case 'artifacts': return m.artifacts;
      case 'actors': return m.subtasksTrack;
      case 'shell': return m.commands;
      case 'explore': return m.explore;
      case 'web': return m.web;
      case 'ask': return m.askedYou;
      case 'other': return m.otherTools;
    }
  };

  const edges = layout.edges.map((edge) => {
    const numbers = edge.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    return {
      kind: edge.kind, from: at.get(edge.from) ?? -1, to: at.get(edge.to) ?? -1, t: edge.t, path: edge.path,
      x1: r1(numbers[0]!), y1: r1(numbers[1]!), x2: r1(numbers.at(-2)!), y2: r1(numbers.at(-1)!),
      ...(edge.gap && edge.mid ? { gap: silence(edge.gap, m), mid: [r1(edge.mid[0]), r1(edge.mid[1])] } : {}),
    };
  });

  // The column of the focus conversation's newest turn: where the camera follows.
  const lastAgent = layout.nodes.filter((node): node is Of<'agent'> => node.kind === 'agent' && node.session.id === input.focus).at(-1);
  let latest: Obj | undefined;
  if (lastAgent) {
    const column = layout.nodes.filter((node) => node.kind !== 'header' && node.session.id === input.focus && 'turn' in node && node.turn.turn === lastAgent.turn.turn);
    const top = Math.min(...column.map((node) => node.y)), bottom = Math.max(...column.map((node) => node.y + node.h));
    latest = { id: `${lastAgent.id}|${column.length}`, x: r1(lastAgent.x), y: r1(top), w: r1(lastAgent.w), h: r1(bottom - top) };
  }

  // What the host may fetch next: opened subagents whose steps are unread, finished answers without a summary.
  const wantLanes: Obj[] = [];
  const wantSummaries: Obj[] = [];
  for (const node of layout.nodes) {
    if (node.kind === 'actor' && node.actor.lane && level === 'detail') {
      const key = `${node.session.id}|${node.actor.lane}`;
      if (!lanes.has(key) && !input.closedLanes.has(key)) wantLanes.push({ id: node.id, sid: node.session.id, lane: node.actor.lane });
    }
    if (summaries && node.kind === 'agent' && node.turn.status !== 'running' && node.detail?.answer && !summaries.has(turnKey(node.session.id, node.turn.turn))) {
      wantSummaries.push({ id: node.id, sid: node.session.id, turn: node.turn.turn });
    }
  }

  const { bounds } = layout;
  const parts: string[] = [
    `"level":"${level}"`,
    `"ready":${input.ready}`,
    `"bounds":${q({ x: r1(bounds.x), y: r1(bounds.y), w: r1(bounds.w), h: r1(bounds.h) })}`,
    `"nodes":[${out.join(',')}]`,
    `"edges":${q(edges)}`,
    `"frames":${q(layout.frames.map((frame) => ({ si: si(frame.session), x: r1(frame.x), y: r1(frame.y), w: r1(frame.w), h: r1(frame.h), ...(frame.project ? { project: frame.project } : {}), ...(frame.branch ? { branch: frame.branch } : {}) })))}`,
    `"gutter":${q(layout.gutter.map((mark) => ({ ti: turnIndex.get(mark.id.slice('time|'.length)) ?? -1, x: r1(mark.x), y: r1(mark.y), t: mark.t, ...(mark.day ? { day: true } : {}) })))}`,
    `"tracks":${q(layout.tracks.map((track) => ({ id: track.id, si: sessionIndex.get(track.sessionId) ?? -1, kind: track.kind, name: trackName(track), ...(track.external ? { external: true } : {}), x: r1(track.x), w: r1(track.w), y: r1(track.y), h: r1(track.h), line: r1(track.y + trackLine(track)) })))}`,
    `"seams":${q(layout.seams.map((seam) => ({ id: seam.id, x: r1(seam.x), top: r1(seam.top), bottom: r1(seam.bottom), t: seam.t, ...(seam.tokens ? { tokens: seam.tokens } : {}) })))}`,
    ...(layout.next ? [`"next":${q({ id: layout.next.id, x: r1(layout.next.x), y: r1(layout.next.y), w: r1(layout.next.w), h: r1(layout.next.h) })}`] : []),
    ...(latest ? [`"latest":${q(latest)}`] : []),
    ...(wantLanes.length || wantSummaries.length ? [`"wants":${q({ lanes: wantLanes, summaries: wantSummaries })}`] : []),
    `"live":${layout.nodes.some((node) => node.kind === 'header' && LIVE_STATES.has(node.session.state))}`,
    `"metrics":${q({ row: ROW, change: { head: CHANGE.head, file: CHANGE.file, line: CHANGE.line, inset: CHANGE.inset, gap: CHANGE.gap, lines: CHANGE.lines }, art: ART, strip: STRIP, bar: BAR })}`,
  ];
  // Sessions and turns are filled while the pieces above are made, so they are written last.
  const tables = [`"sessions":${q(sessions.map(sessionOf))}`, `"turns":${q(turns)}`];
  return { json: `{${[...parts.slice(0, 3), ...tables, ...parts.slice(3)].join(',')}}`, nodes: byId };
}

/** The fields of a session a card draws; the host resolves the backend's name. */
function sessionOf(session: Session): Obj {
  return {
    id: session.id, title: session.title, ...(session.backendId ? { backend: session.backendId } : {}),
    ...(session.model ? { model: session.model.replace(/\[.*\]$/, '') } : {}), ...(LIVE_STATES.has(session.state) ? { live: true } : {}),
  };
}

/* ---------------------------------------------------------------------------------------------
 * Detail: what the inspector and the call tip show, asked for one node at a time.
 * ------------------------------------------------------------------------------------------- */

/** The steps on one time axis, each with its bar as percentages; opened subagents nest. */
function stepsOf(steps: readonly Step[], input: RenderInput, session: string, depth = 0): Obj {
  const start = Math.min(...steps.map((step) => step.start));
  const end = Math.max(...steps.map((step) => step.end), start + 1);
  const pct = (value: number) => Math.min(100, Math.max(0, ((value - start) / (end - start)) * 100));
  return {
    total: formatDuration(end - start),
    steps: steps.slice(0, 200).map((step) => {
      const key = step.lane ? `${session}|${step.lane}` : undefined;
      const open = key ? input.lanes.get(key) : undefined;
      return {
        key: step.key, label: step.label, kind: step.kind, ...(step.tool ? { tool: step.tool } : {}), ...(step.failed ? { failed: true } : {}), ...(step.running ? { running: true } : {}),
        duration: formatDuration(step.end - step.start), a: r1(pct(step.start)), b: r1(pct(step.end)),
        ...(step.lane ? { lane: step.lane } : {}),
        ...(key && input.lanes.has(key) ? { open: open === null || open === undefined ? { loading: true } : depth < 3 && open.steps.length ? stepsOf(open.steps, input, session, depth + 1) : { steps: [], total: '' } } : {}),
      };
    }),
  };
}

const copyOf = (node: FlowNode): string => {
  switch (node.kind) {
    case 'user': return node.text;
    case 'agent': return node.detail?.answer ?? '';
    case 'actor': return node.actor.note ?? node.actor.label;
    case 'fold': return '';
    case 'signal': return (node.detail?.arrivals ?? []).map((arrival) => arrival.title).join('\n');
    case 'header': return node.session.title;
    case 'change': return node.changes.map((change) => change.path).join('\n');
    case 'artifacts': return node.items.map((item) => item.path ?? item.name).join('\n');
    case 'tools': return node.steps.map((step) => step.arg ?? step.title ?? step.label).join('\n');
  }
};

/** The inspector's content for [node]. */
export function detailOf(node: FlowNode, input: RenderInput): Obj {
  const { m } = input;
  const base = { title: titleOf(node, m), copy: copyOf(node) };
  switch (node.kind) {
    case 'header': case 'fold': return base;
    case 'signal': return { ...base, arrivals: (node.detail?.arrivals ?? []).map((a) => ({ id: a.id, title: a.title, status: a.status, at: a.at })) };
    case 'user': {
      const { images, others } = attachmentsOf(node.detail?.attachments ?? []);
      return { ...base, text: node.text, images: images.map((image) => image.id), others, steers: (node.detail?.steers ?? []).map((steer) => steer.text) };
    }
    case 'agent': {
      const { detail } = node;
      const facts = [formatDuration(node.end - node.t), detail?.tools ? m.toolCalls(detail.tools) : '', detail?.actors.length ? m.subtasks(detail.actors.length) : ''].filter(Boolean);
      return {
        ...base, facts, ...(node.summary ? { summary: node.summary } : {}), ...(detail?.answer ? { answer: detail.answer } : {}),
        running: node.turn.status === 'running', ...(detail && detail.steps.length ? { timeline: stepsOf(detail.steps, input, node.session.id) } : {}),
      };
    }
    case 'change': return {
      ...base,
      edits: node.changes.flatMap((change) => change.edits.map((edit, index) => ({ path: change.path, index, before: edit.before, after: edit.after }))),
      commands: node.changes.filter((change) => change.commands.length).map((change) => ({ path: change.path, commands: change.commands })),
    };
    case 'artifacts': return { ...base, items: node.items.map((item) => ({ ...artifactOf(item), ...(item.src && !item.src.startsWith(MEDIA_PREFIX) ? { src: item.src } : {}) })) };
    case 'tools': return {
      ...base,
      steps: node.steps.map((step) => ({
        key: step.key, name: step.toolName ?? step.kindName, ...(step.title && step.title !== step.arg ? { title: step.title } : {}), duration: formatDuration(step.end - step.start),
        ...(step.arg ? { arg: step.arg } : {}), ...(step.output ? { output: step.output } : {}), ...(step.failed ? { failed: true } : {}),
      })),
    };
    case 'actor': {
      const { actor } = node;
      const key = actor.lane ? `${node.session.id}|${actor.lane}` : undefined;
      const lane = key ? input.lanes.get(key) : undefined;
      return {
        ...base, facts: [actor.kind === 'subagent' ? m.subagent : m.backgroundTask, actor.note ?? '', formatDuration(actor.end - actor.start), actor.running ? m.running : actor.failed ? m.failed : ''].filter(Boolean),
        ...(actor.kind === 'background' && actor.note ? { command: actor.note } : {}),
        ...(actor.lane ? { lane: actor.lane, laneState: lane === undefined ? (key && input.lanes.has(key) ? 'loading' : 'closed') : lane === null ? 'loading' : 'open' } : {}),
        ...(lane ? { ...(lane.answer ? { answer: lane.answer } : {}), timeline: stepsOf(lane.steps, input, node.session.id) } : {}),
      };
    }
  }
}

function titleOf(node: FlowNode, m: Messages): string {
  switch (node.kind) {
    case 'user': return m.prompt;
    case 'agent': return m.answer;
    case 'change': return m.outputs;
    case 'artifacts': return m.artifacts;
    case 'tools': return m.calls(node.steps.length);
    case 'actor': return node.actor.label;
    default: return node.session.title;
  }
}

/** The tooltip of one call of a strip or bar. */
export function tipOf(node: FlowNode, index: number, m: Messages): Obj | undefined {
  if (node.kind !== 'tools' && node.kind !== 'actor') return undefined;
  const step = node.steps[index];
  if (!step) return undefined;
  const track: Track = node.kind === 'tools' ? node.track : step.track ?? 'other';
  const label = callLabel(step, track);
  const words = step.title && step.title !== step.arg && step.title !== step.toolName ? step.title : undefined;
  const command = step.arg ? unwrapShell(step.arg) : undefined;
  const code = command && command !== label.text ? command : label.mono ? label.text : undefined;
  return {
    name: step.toolName ?? step.kindName ?? '',
    // The transcript's icon: an explore call that is neither read nor search is drawn as a search.
    tool: track === 'explore' && step.kindName === 'other' ? 'search' : step.kindName ?? '',
    time: step.running ? m.running : step.failed ? m.failed : formatDuration(step.end - step.start),
    ...(step.failed ? { failed: true } : {}), ...(words ? { words } : {}), ...(code ? { code } : {}),
    tail: outputTail(step.output, track === 'ask' ? 2 : 5),
  };
}
