import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Run, Session, SyncLane, TurnOutlineV3 } from '@contracts';
import { Button, Spinner, Tip, ToolIcon, useMessages, usePluginHost, useProjects, useSessions, type ViewProps } from '@riffet/plugin-web';
import { Lightbox, Node, NextPrompt, Sparkline, copyText, type CardActions, type Pulse } from './cards';
import { cn } from './cn';
import { LIVE_STATES, byTurn, callLabel, useQueue, formatDuration, laneRows, outputTail, turnDetail, turnKey, unwrapShell, type Artifact, type FoldContext, type Step, type Track, type TurnDetail } from './detail';
import { BAR, STRIP, layoutFlow, trackLine, sessionFamily, type FlowEdge, type FlowLayout, type FlowNode, type Level, type TrackBand } from './flow';
import { ForkDraft, NextComposer } from './Drafts';
import { Frames, Gutter, Seams, Silences, TrackLines } from './ground';
import { IconCopy, IconFolder, IconGitFork, IconGlobe, IconImage, IconInfo, IconMessageCircleQuestion, IconPause, IconPlay, IconSearch, IconSparkles, IconSquareArrowOutUpRight, IconSquareTerminal, IconTarget, IconWrench, IconX } from './icons';
import { Inspector } from './Inspector';
import { catalogs } from './messages';
import { Surface, ZoomControls, intersects, useCamera, useCameraSelect, useViewWindow, type Bounds, type Camera, type CameraApi } from './Viewport';

/*
 * One conversation's canvas: the conversation and its forks as flows (`flow.ts`) over the ground
 * they happened in (`ground.tsx`). Zooming in past reading size opens every answer into its steps;
 * the card under the pointer stays where it was while the others glide to their new places. Live
 * work pulses at the rate the agent is writing, and the camera follows the newest turn until the
 * reader moves it; a finished conversation can be replayed.
 */

const FAR_K = 0.36;
/** Enter the detailed level at this zoom, and leave it below the lower one, so it does not flicker. */
const DETAIL_IN = 0.95, DETAIL_OUT = 0.8;
const FRESH_MS = 500;
const MORPH = { duration: 460, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' } as const;
const PULSE_SAMPLES = 24;
const LAYOUT_TICK = 10_000;
/** Opening the composer keeps the zoom unless it is below this, where the slot is too small to read. */
const WRITE_K = 0.5;
/** The composer's menus open upward and need this much of the plane above it; the composer itself about 130 below its top. */
const MENU_ROOM = 290, COMPOSER_H = 130;
/** A sent message stands as a pending question this long for its turn to appear. */
const PENDING_MS = 30_000;

type Replay = { index: number; playing: boolean };
/** What the reader is writing on the canvas: the next question, or where to continue an answer from. Only one at a time. */
type Draft = { kind: 'next' } | { kind: 'fork'; node: string };
type AgentNode = Extract<FlowNode, { kind: 'agent' }>;

const turnVersion = (turn: TurnOutlineV3) => `${turn.rows}|${turn.status}|${turn.endPos ?? ''}|${turn.endedAt ?? ''}`;
const STAMP = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const compact = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);

/** The canvas view. A new session or project is a new instance, so nothing of one conversation is drawn in another. */
export default function CanvasView({ context, composer }: ViewProps) {
  return context.sessionId ? <SessionCanvas sessionId={context.sessionId} signal={context.signal} composer={composer} /> : null;
}

function SessionCanvas({ sessionId, signal, composer }: { sessionId: string; signal: AbortSignal; composer: ViewProps['composer'] }) {
  const m = useMessages(catalogs);
  const host = usePluginHost();
  const { sessions, navigation, notify, timeline, ui } = host;
  const fold = useMemo<FoldContext>(() => ({ timeline, media: (id, path) => sessions.mediaUrl(id, path), words: { think: m.think, plan: m.plan, subagent: m.subagent, backgroundTask: m.backgroundTask, toolCall: m.toolCall } }), [timeline, sessions, m]);
  const allSessions = useSessions();
  const projects = useProjects();
  const roots = useMemo(() => new Map(projects.map((item) => [item.id, item.cwd])), [projects]);
  const projectOf = useCallback((session: Session) => {
    const project = projects.find((item) => item.id === session.projectId);
    return { ...(project?.name ? { name: project.name } : {}), ...(project?.worktree?.branch ? { branch: project.worktree.branch } : {}) };
  }, [projects]);
  const family = useMemo(() => sessionFamily(sessionId, allSessions), [sessionId, allSessions]);
  const live = family.some((session) => LIVE_STATES.has(session.state));

  const [outlines, setOutlines] = useState<ReadonlyMap<string, TurnOutlineV3[]>>(new Map());
  const [details, setDetails] = useState<ReadonlyMap<string, TurnDetail>>(new Map());
  const [lanes, setLanes] = useState<ReadonlyMap<string, TurnDetail | null>>(new Map());
  const [runs, setRuns] = useState<ReadonlyMap<string, Run>>(new Map());
  const [pulses, setPulses] = useState<ReadonlyMap<string, Pulse>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const enqueue = useQueue(signal);
  // Summaries are written by a model and can take a while: a queue of their own, so they never hold up the data above.
  const enqueueSummary = useQueue(signal, 2);
  const summariesOn = useSyncExternalStore(sessions.subscribe, sessions.turnSummaries);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, string>>(new Map());
  /** Artifacts whose image would not load (a file since removed): they leave the track. */
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const markBroken = useCallback((key: string) => setBroken((current) => current.has(key) ? current : new Set(current).add(key)), []);
  const [lightbox, setLightbox] = useState<Artifact | undefined>(undefined);
  const closeLightbox = useCallback(() => setLightbox(undefined), []);

  /* ---------------------------------------------------------------- data */
  const outlineVersions = useRef(new Map<string, string>());
  const loadOutline = useCallback((session: Session, version: string) => {
    outlineVersions.current.set(session.id, version);
    enqueue(async () => {
      try {
        const turns = await sessions.outline(session.id, { lane: 'main', signal });
        setOutlines((current) => new Map(current).set(session.id, turns));
      } catch {
        if (!signal.aborted) setOutlines((current) => current.has(session.id) ? current : new Map(current).set(session.id, []));
      }
    }, `outline|${session.id}`);
  }, [enqueue, sessions, signal]);
  // A turn's run carries what it cost: output tokens and the time spent writing them. Sampled while
  // it runs, the tokens' growth is the turn's pulse.
  const samples = useRef(new Map<string, Array<{ at: number; tokens: number }>>());
  const loadRuns = useCallback((session: Session) => {
    enqueue(async () => {
      try {
        const list = await sessions.runs(session.id, { signal });
        const at = Date.now();
        setRuns((current) => { const next = new Map(current); for (const run of list) next.set(run.id, run); return next; });
        const beats = new Map<string, Pulse>();
        for (const run of list) {
          const tokens = run.native?.metrics?.outputTokens;
          if (run.state !== 'running' || tokens === undefined) continue;
          const history = [...(samples.current.get(run.id) ?? []), { at, tokens }].slice(-PULSE_SAMPLES - 1);
          samples.current.set(run.id, history);
          const series = history.slice(1).map((sample, index) => Math.max(0, (sample.tokens - history[index]!.tokens) / Math.max(0.5, (sample.at - history[index]!.at) / 1000)));
          if (series.length) beats.set(run.id, { rate: series.at(-1)!, series });
        }
        setPulses((current) => {
          const next = new Map([...current].filter(([id]) => !list.some((run) => run.id === id)));
          for (const [id, beat] of beats) next.set(id, beat);
          return next;
        });
      } catch { /* A run list that cannot be read only leaves the cards without their metrics. */ }
    }, `runs|${session.id}`);
  }, [enqueue, sessions, signal]);
  useEffect(() => {
    for (const session of family) {
      const version = `${session.updatedAt}|${session.state}`;
      if (outlineVersions.current.get(session.id) === version) continue;
      loadOutline(session, version);
      loadRuns(session);
    }
  }, [family, loadOutline, loadRuns]);
  const beat = useRef(0);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      beat.current += 1;
      for (const session of family) {
        if (!LIVE_STATES.has(session.state)) continue;
        if (beat.current % 2 === 0) loadRuns(session);
        if (beat.current % 3 === 0) loadOutline(session, `${session.updatedAt}|${session.state}|${Date.now()}`);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [live, family, loadOutline, loadRuns]);

  // A conversation's turns are read in one pass over its lane; after that only the turns that changed.
  const turnVersions = useRef(new Map<string, string>());
  useEffect(() => {
    for (const session of family) {
      const turns = outlines.get(session.id);
      if (!turns?.length) continue;
      const changed = turns.filter((turn) => turnVersions.current.get(turnKey(session.id, turn.turn)) !== turnVersion(turn));
      if (!changed.length) continue;
      for (const turn of changed) turnVersions.current.set(turnKey(session.id, turn.turn), turnVersion(turn));
      enqueue(async () => {
        try {
          const ids = new Set(changed.map((turn) => turn.turn));
          const rows = byTurn(await laneRows(sessions, session.id, 'main', Math.min(...changed.map((turn) => turn.startPos)), { turns: ids, signal }));
          const at = Date.now();
          setDetails((current) => {
            const next = new Map(current);
            for (const turn of changed) next.set(turnKey(session.id, turn.turn), turnDetail(session.id, rows.get(turn.turn) ?? [], roots.get(session.projectId), at, fold));
            return next;
          });
        } catch {
          for (const turn of changed) turnVersions.current.delete(turnKey(session.id, turn.turn));
        }
      });
    }
  }, [family, outlines, enqueue, roots, sessions, signal, fold]);

  const loadLane = useCallback((session: Session, lane: SyncLane) => {
    const key = `${session.id}|${lane}`;
    setLanes((current) => current.has(key) ? current : new Map(current).set(key, null));
    enqueue(async () => {
      try {
        const rows = await laneRows(sessions, session.id, lane, 0, { pages: 6, signal });
        setLanes((current) => new Map(current).set(key, turnDetail(session.id, rows, roots.get(session.projectId), Date.now(), fold)));
      } catch (error) {
        if (signal.aborted) return;
        setLanes((current) => { const next = new Map(current); next.delete(key); return next; });
        notify.error(error, m.laneFailed);
      }
    });
  }, [enqueue, roots, sessions, signal, notify, m, fold]);
  const requested = useRef(new Set<string>());
  const toggleLane = useCallback((session: Session, lane: SyncLane) => {
    const key = `${session.id}|${lane}`;
    if (lanes.get(key)) { setLanes((current) => { const next = new Map(current); next.delete(key); return next; }); requested.current.add(key); return; }
    if (!lanes.has(key)) loadLane(session, lane);
  }, [lanes, loadLane]);

  /* ---------------------------------------------------------------- camera and level */
  const camera = useCamera({ x: 40, y: 40, k: 0.8 });
  const { size } = camera;
  /** Which side of the far, summary and detail thresholds the zoom is on; the rest of a zoom re-renders nothing. */
  const band = useCameraSelect(camera, ({ k }) => k < FAR_K ? 0 : k < DETAIL_OUT ? 1 : k < DETAIL_IN ? 2 : 3);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  /** The call of a strip under the pointer. */
  const [tip, setTip] = useState<{ id: string; index: number } | undefined>(undefined);
  // A card that moves out from under a still pointer never hears it leave.
  camera.onMove.current = () => { setHovered(undefined); setTip(undefined); };
  const [level, setLevel] = useState<Level>('summary');
  /** Set while the camera flies to a card the reader opened, so the level is not changed under it. */
  const flying = useRef<{ id: string; until: number } | undefined>(undefined);
  useEffect(() => {
    if (flying.current && performance.now() < flying.current.until) return;
    if (level === 'summary' && band === 3) setLevel('detail');
    else if (level === 'detail' && band < 2) setLevel('summary');
  }, [band, level]);

  // A running turn's column stretches its clock as it goes; the layout follows in steps, not every second.
  const layoutNow = Math.floor(now / LAYOUT_TICK) * LAYOUT_TICK;
  const writable = composer !== undefined;
  // A question sent from the slot, standing until its turn arrives.
  const [pending, setPending] = useState<{ text: string; turns: number } | undefined>(undefined);
  const layout = useMemo(() => layoutFlow(family, outlines, details, lanes, layoutNow, level, projectOf, { ...(summariesOn ? { summaries } : {}), broken, ...(writable ? { next: sessionId, sending: Boolean(pending) } : {}) }), [family, outlines, details, lanes, layoutNow, level, projectOf, summariesOn, summaries, broken, writable, sessionId, pending]);
  const ready = family.length > 0 && family.every((session) => outlines.has(session.id));

  // Whenever cards re-form — a level change, a subagent's steps arriving, a turn growing — the card the
  // reader is looking at (under the pointer, or in the middle of the view) stays where it was, and on a
  // level change every other card glides from where it stood to its new place.
  const world = useRef<HTMLDivElement>(null);
  const previous = useRef<{ layout: FlowLayout; level: Level } | undefined>(undefined);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { layout, level };
    if (!before || before.layout === layout || !size.w) return;
    const c0 = camera.read();
    const flight = flying.current && performance.now() < flying.current.until ? flying.current : undefined;
    let c1: Camera = c0;
    if (flight) {
      const target = layout.nodes.find((node) => node.id === flight.id);
      if (target) camera.animateTo(camera.centering(target.x + target.w / 2, target.y + Math.min(target.h, 360) / 2, Math.max(1.05, DETAIL_IN + 0.05), 0.45, 0.42), 560);
    } else {
      const screen = camera.pointer.current ?? { x: size.w / 2, y: size.h / 2 };
      const wx = (screen.x - c0.x) / c0.k, wy = (screen.y - c0.y) / c0.k;
      let anchor: FlowNode | undefined, best = Infinity;
      // Within a level, marks and bars move along their running column's clock on their own; only cards hold the view.
      const steady = before.level === level;
      for (const node of before.layout.nodes) {
        if (steady && (node.kind === 'tools' || node.kind === 'actor')) continue;
        const distance = Math.hypot(Math.max(node.x - wx, 0, wx - node.x - node.w), Math.max(node.y - wy, 0, wy - node.y - node.h));
        if (distance < best) { best = distance; anchor = node; }
      }
      const after = anchor && layout.nodes.find((node) => node.id === anchor!.id);
      if (anchor && after && (after.x !== anchor.x || after.y !== anchor.y || after.w !== anchor.w || after.h !== anchor.h)) {
        // Under the pointer, the very point it is on stays put; otherwise the card's corner does.
        const inside = best === 0;
        const fx = inside ? (wx - anchor.x) / anchor.w : 0, fy = inside ? (wy - anchor.y) / anchor.h : 0;
        const ax = anchor.x + fx * anchor.w, ay = anchor.y + fy * anchor.h;
        const bx = after.x + fx * after.w, by = after.y + fy * after.h;
        c1 = { k: c0.k, x: c0.x + (ax - bx) * c0.k, y: c0.y + (ay - by) * c0.k };
        camera.slide(bx - ax, by - ay);
      }
    }
    if (before.level === level || !world.current) return;
    setHovered(undefined);
    const old = new Map(before.layout.nodes.map((node) => [node.id, node]));
    const now = new Map(layout.nodes.map((node) => [node.id, node]));
    for (const element of world.current.querySelectorAll<HTMLElement>('[data-node]')) {
      const node = now.get(element.dataset.node ?? '');
      const was = node && old.get(node.id);
      if (!node || !was) continue;
      const dx = was.x + (c0.x - c1.x) / c0.k - node.x, dy = was.y + (c0.y - c1.y) / c0.k - node.y;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], MORPH);
    }
  }, [layout, level, size.w, size.h, camera]);

  /* ---------------------------------------------------------------- replay */
  const moments = useMemo(() => [...new Set([...layout.nodes, ...layout.edges].map((item) => item.t).filter((value) => value > 0))].sort((a, b) => a - b), [layout]);
  const [replay, setReplay] = useState<Replay | undefined>(undefined);
  const cutoff = replay ? moments[Math.min(replay.index, moments.length - 1)] ?? Infinity : Infinity;
  useEffect(() => {
    if (!replay?.playing) return;
    const timer = window.setInterval(() => setReplay((current) => {
      if (!current) return current;
      if (current.index >= moments.length - 1) return { ...current, playing: false };
      return { ...current, index: current.index + 1 };
    }), Math.min(600, Math.max(60, 14_000 / Math.max(moments.length, 1))));
    return () => window.clearInterval(timer);
  }, [replay?.playing, moments.length]);

  /* ---------------------------------------------------------------- following */
  const latest = useMemo(() => {
    const agent = layout.nodes.filter((node): node is AgentNode => node.kind === 'agent' && node.session.id === sessionId).at(-1);
    if (!agent) return undefined;
    // The latest turn's whole column: its question, the answer, and what hangs from it.
    const column = layout.nodes.filter((node) => node.kind !== 'header' && node.session.id === sessionId && 'turn' in node && node.turn.turn === agent.turn.turn);
    const top = Math.min(...column.map((node) => node.y)), bottom = Math.max(...column.map((node) => node.y + node.h));
    return { id: `${agent.id}|${column.length}`, x: agent.x, y: top, w: agent.w, h: bottom - top };
  }, [layout, sessionId]);
  const showLatest = useCallback((animate: boolean) => {
    if (!latest || !size.w) return;
    // The column's top half, right of centre, so the turns before it lead in from the left.
    const k = Math.min(0.9, Math.max(0.5, camera.framing({ ...latest, h: Math.min(latest.h, 560) }, 0.9, 120).k));
    // Right of centre, with the slot for the next question beyond it in view.
    const target = camera.centering(latest.x + latest.w / 2, latest.y + Math.min(latest.h, 560) / 2, k, layout.next ? 0.5 : 0.62, 0.5);
    if (animate) camera.animateTo(target, 520); else camera.setCamera(target);
  }, [latest, size.w, camera, layout.next]);
  const placed = useRef(false);
  const followed = useRef('');
  const awaiting = useRef(false);
  useEffect(() => {
    if (!latest || !size.w || replay) return;
    if (!placed.current) {
      if (!ready) return;
      placed.current = true;
      followed.current = latest.id;
      showLatest(false);
      return;
    }
    // A message just sent follows its turn in whether or not the conversation has been seen to run yet.
    if (latest.id !== followed.current && (live || awaiting.current) && !camera.moved.current) { followed.current = latest.id; awaiting.current = false; showLatest(true); }
  }, [latest, size.w, ready, live, replay, showLatest, camera.moved]);
  const fit = useCallback(() => { camera.userMoved(); camera.animateTo(camera.framing(layout.bounds, 1), 520); }, [camera, layout.bounds]);

  /* ---------------------------------------------------------------- what is on screen */
  const far = band === 0;
  const view = useViewWindow(camera);
  const nodes = layout.nodes.filter((node) => node.t <= cutoff && intersects(view, node));
  // The spine's last stretch leads to the slot for the next question, which only a conversation still going has.
  const edges = useMemo(() => layout.edges.filter((edge) => edge.t <= cutoff && !((replay || far) && edge.to === layout.next?.id)), [layout.edges, layout.next, cutoff, replay, far]);

  // Opened answers show their subagents' own steps: read those lanes as they come into view.
  useEffect(() => {
    if (level !== 'detail') return;
    for (const node of nodes) {
      if (node.kind !== 'actor' || !node.actor.lane) continue;
      const key = `${node.session.id}|${node.actor.lane}`;
      if (!lanes.has(key) && !requested.current.has(key)) { requested.current.add(key); loadLane(node.session, node.actor.lane); }
    }
  });

  // The turns in view that have finished are summarised, a couple at a time; a turn that has no summary to give is not asked again.
  const asked = useRef(new Set<string>());
  useEffect(() => { asked.current.clear(); }, [summariesOn]);
  useEffect(() => {
    if (!summariesOn) return;
    for (const node of nodes) {
      if (node.kind !== 'agent' || node.turn.status === 'running' || !node.detail?.answer) continue;
      const key = turnKey(node.session.id, node.turn.turn);
      if (summaries.has(key) || asked.current.has(key)) continue;
      asked.current.add(key);
      enqueueSummary(async () => {
        try {
          const text = await sessions.turnSummary(node.session.id, node.turn.turn, { signal });
          if (text) setSummaries((current) => new Map(current).set(key, text));
        } catch { /* Without a summary the card keeps its preview. */ }
      }, `summary|${key}`);
    }
  });

  // A node animates in the first time it is drawn, not each time it scrolls back into view.
  const firstSeen = useRef(new Map<string, number>());
  const stamp = performance.now();
  const fresh = (id: string) => {
    const seen = firstSeen.current.get(id);
    if (seen === undefined) { firstSeen.current.set(id, stamp); return true; }
    return stamp - seen < FRESH_MS;
  };

  /* ---------------------------------------------------------------- hover: lineage and actions */
  // Lineage lights up after a short rest, so sweeping across the canvas does not flicker it.
  const hoverTimer = useRef(0);
  const lineage = useCallback((id: string | undefined) => {
    window.clearTimeout(hoverTimer.current);
    if (!id) { setHovered(undefined); return; }
    hoverTimer.current = window.setTimeout(() => setHovered(id), 220);
  }, []);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const related = useMemo(() => {
    if (!hovered) return undefined;
    const set = new Set([hovered]);
    // A file: every sheet that wrote it, and the answers they hang from.
    if (hovered.startsWith('file|')) {
      const path = hovered.slice('file|'.length);
      for (const node of layout.nodes) if (node.kind === 'change' && node.changes.some((change) => change.path === path)) { set.add(node.id); set.add(node.agent); }
      return set;
    }
    // A turn's card: its whole column, down through every track.
    const card = layout.nodes.find((node) => node.id === hovered);
    if (card && card.kind !== 'header') for (const node of layout.nodes) if (node.kind !== 'header' && node.session.id === card.session.id && node.turn.turn === card.turn.turn) set.add(node.id);
    for (const edge of layout.edges) if (set.has(edge.from) && set.has(edge.to) || edge.from === hovered || edge.to === hovered) { set.add(edge.id); set.add(edge.from); set.add(edge.to); }
    return set;
  }, [hovered, layout.nodes, layout.edges]);
  const focusPath = hovered?.startsWith('file|') ? hovered.slice('file|'.length) : undefined;
  // The action bar follows the pointer without delay, and stays while the pointer is on it.
  const [pointed, setPointed] = useState<string | undefined>(undefined);
  const leaveTimer = useRef(0);
  const point = useCallback((id: string | undefined) => {
    window.clearTimeout(leaveTimer.current);
    if (id) setPointed(id); else leaveTimer.current = window.setTimeout(() => setPointed(undefined), 160);
  }, []);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  /* ---------------------------------------------------------------- selection and actions */
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  /** The call a click on a strip landed on, for the inspector to bring into view. */
  const [focusStep, setFocusStep] = useState<string | undefined>(undefined);
  const tipAt = useRef(tip);
  tipAt.current = tip;
  const selected = selectedId ? layout.nodes.find((node) => node.id === selectedId) : undefined;
  /** The inspector takes the right of the plane; a card it would cover slides into the space left. */
  const select = useCallback((node: FlowNode | undefined) => {
    setSelectedId(node?.id);
    if (!node) return;
    const current = camera.read();
    const open = size.w - 424;
    const left = node.x * current.k + current.x, right = left + node.w * current.k;
    if (right > open - 24 || left < 24) camera.animateTo({ ...current, x: current.x + (open / 2 - (left + right) / 2) }, 380);
  }, [camera, size.w]);
  /* The reader's drafts: the next question written in the conversation's own composer, a fork's first line under an answer. */
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  /** What was typed under each answer, kept while the view lives so closing a draft loses nothing. */
  const forkTexts = useRef(new Map<string, string>());
  const [forking, setForking] = useState<ReadonlySet<string>>(new Set());
  const inset = selected && selected.kind !== 'header' ? 424 : 0;
  const own = family.find((session) => session.id === sessionId);
  const ownRef = useRef(own);
  ownRef.current = own;
  const turnCount = outlines.get(sessionId)?.length ?? 0;
  /** The turn count when the composer opened: the outline may already hold the new turn by the time the send is reported. */
  const turnsRef = useRef(turnCount);
  turnsRef.current = turnCount;
  const turnsAtOpen = useRef(turnCount);
  useEffect(() => { if (!writable) setDraft((current) => current?.kind === 'next' ? undefined : current); }, [writable]);

  /** Moves the camera, not the zoom unless it is under [minK], so [box] sits with [top] pixels free above it and [bottom] below its edge. */
  const reveal = useCallback((box: Bounds, { top, bottom }: { top: number; bottom: number }, minK = 0) => {
    const c = camera.read();
    const k = Math.max(c.k, minK);
    const open = size.w - inset;
    const w = box.w * k, h = box.h * k;
    const left = box.x * c.k + c.x, edge = box.y * c.k + c.y;
    const hi = Math.max(16, size.h - 16 - bottom - h), lo = Math.min(top, hi);
    const settled = k === c.k && left >= 16 && left + w <= open - 16 && edge >= lo && edge <= hi;
    if (settled) return;
    const wantLeft = k === c.k && left >= 16 && left + w <= open - 16 ? left : Math.max(16, (open - w) / 2);
    const wantTop = Math.min(Math.max(k === c.k ? edge : size.h * 0.4, lo), hi);
    camera.userMoved();
    camera.animateTo({ k, x: wantLeft - box.x * k, y: wantTop - box.y * k }, 380);
  }, [camera, size.w, size.h, inset]);

  const openNext = useCallback(() => {
    if (!layout.next) return;
    reveal(layout.next, { top: MENU_ROOM, bottom: COMPOSER_H }, WRITE_K);
    turnsAtOpen.current = turnsRef.current;
    setDraft({ kind: 'next' });
  }, [layout.next, reveal]);
  const closeNext = useCallback(() => {
    setDraft(undefined);
    // Back to the slot, so a keyboard reader is not left on nothing.
    requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) world.current?.querySelector<HTMLElement>('[data-next]')?.focus({ preventScroll: true }); });
  }, []);
  const sent = useCallback((text: string) => {
    setDraft(undefined);
    // A slash command may start no turn: nothing to wait for.
    const command = text.trimStart().startsWith('/');
    if (!command) awaiting.current = true;
    camera.moved.current = false;
    // Into a running turn the composer steers or queues: no new question comes of it yet.
    if (!command && !(ownRef.current && LIVE_STATES.has(ownRef.current.state))) setPending({ text, turns: turnsAtOpen.current });
    if (ownRef.current) loadOutline(ownRef.current, `sent|${Date.now()}`);
  }, [camera.moved, loadOutline]);
  // Until the turn shows in the outline the question stands as pending, and the outline is asked for each second; after a while it is given up.
  useEffect(() => { if (pending && turnCount > pending.turns) setPending(undefined); }, [pending, turnCount]);
  useEffect(() => {
    if (!pending) return;
    const poll = window.setInterval(() => { if (ownRef.current) loadOutline(ownRef.current, `pending|${Date.now()}`); }, 1000);
    const giveUp = window.setTimeout(() => { awaiting.current = false; setPending(undefined); }, PENDING_MS);
    return () => { window.clearInterval(poll); window.clearTimeout(giveUp); };
  }, [pending, loadOutline]);

  const openFork = useCallback((node: AgentNode) => {
    // The card's lower edge, with room under it for the field.
    reveal({ x: node.x, y: node.y + Math.max(0, node.h - 48), w: node.w, h: Math.min(node.h, 48) }, { top: 56, bottom: 96 });
    setDraft({ kind: 'fork', node: node.id });
  }, [reveal]);
  const sendFork = useCallback(async (session: Session, runId: string, text: string) => {
    const key = `${session.id}|${runId}`;
    setDraft(undefined);
    forkTexts.current.delete(key);
    setForking((current) => new Set(current).add(key));
    try { await sessions.fork(session.id, runId, text ? { note: text } : undefined); }
    catch (error) { if (text) forkTexts.current.set(key, text); notify.error(error, m.forkFailed); }
    finally { setForking((current) => { const next = new Set(current); next.delete(key); return next; }); }
  }, [sessions, notify, m]);
  const forkNode = draft?.kind === 'fork' ? layout.nodes.find((node): node is AgentNode => node.id === draft.node && node.kind === 'agent') : undefined;
  const isForking = (node: FlowNode) => node.kind === 'agent' && node.turn.runId !== undefined && forking.has(`${node.session.id}|${node.turn.runId}`);
  const openNode = useCallback((node: FlowNode) => {
    if (node.kind === 'header') { navigation.openTurn(node.session); return; }
    const detail = node.kind === 'actor' || node.kind === 'change' || node.kind === 'artifacts' || node.kind === 'tools' || node.kind === 'fold' ? details.get(turnKey(node.session.id, node.turn.turn)) : node.detail ?? details.get(turnKey(node.session.id, node.turn.turn));
    navigation.openTurn(node.session, { ...(node.turn.runId ? { runId: node.turn.runId } : {}), ...(detail?.userNativeId ? { nativeId: detail.userNativeId } : {}) });
  }, [details, navigation]);
  /** Double-click brings a card to reading size, which opens it: switch level first, then fly to the opened card. */
  const zoomInto = (node: FlowNode) => {
    camera.userMoved();
    setHovered(undefined);
    if (level === 'summary') {
      flying.current = { id: node.id, until: performance.now() + 1200 };
      setLevel('detail');
      return;
    }
    camera.animateTo(camera.centering(node.x + node.w / 2, node.y + Math.min(node.h, 360) / 2, Math.max(1.05, camera.read().k), 0.45, 0.42), 560);
  };
  // A double-click opens the card in place, so a single click waits a beat before opening the inspector.
  const clickTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(clickTimer.current), []);
  // Cards get one stable set of actions, so they re-render only when what they show changes.
  const handlers = useRef({ select: (_: FlowNode) => {}, open: (_: FlowNode) => {} });
  handlers.current = {
    select: (node) => {
      if (node.kind === 'header' || node.kind === 'fold') return;
      window.clearTimeout(clickTimer.current);
      // A click on one call of a strip opens the strip at that call, rather than toggling it shut.
      const call = node.kind === 'tools' && tipAt.current?.id === node.id ? node.steps[tipAt.current.index]?.key : undefined;
      clickTimer.current = window.setTimeout(() => { setFocusStep(call); select(node.id === selectedId && !call ? undefined : node); }, 230);
    },
    open: (node) => { window.clearTimeout(clickTimer.current); if (node.kind === 'header' || node.kind === 'fold') openNode(node); else zoomInto(node); },
  };
  const actions = useMemo<CardActions>(() => ({
    hover: (node, on) => { lineage(on ? node.id : undefined); point(on && node.kind !== 'header' && node.kind !== 'fold' ? node.id : undefined); },
    file: (node, path) => lineage(path ? `file|${path}` : node.id),
    mark: (node, index) => setTip(index === undefined ? undefined : { id: node.id, index }),
    select: (node) => handlers.current.select(node),
    open: (node) => handlers.current.open(node),
    view: setLightbox,
    broken: markBroken,
  }), [lineage, point, markBroken]);

  const focusPulse = useMemo(() => {
    const running = [...runs.values()].find((run) => run.sessionId === sessionId && run.state === 'running');
    return running ? pulses.get(running.id) : undefined;
  }, [runs, pulses, sessionId]);
  const pointedNode = pointed ? layout.nodes.find((node) => node.id === pointed) : undefined;
  // The call under the pointer, and the moment it ran at, down through every track of its row.
  const tipped = useMemo(() => {
    const node = tip && layout.nodes.find((item) => item.id === tip.id);
    if (!node || (node.kind !== 'tools' && node.kind !== 'actor')) return undefined;
    // A strip's marks are its steps' by index; a bar's, its subagent's own calls.
    const mark = node.marks.find((item) => item.index === tip!.index);
    const step = node.steps[tip!.index];
    if (!mark || !step) return undefined;
    const rows = layout.tracks.filter((track) => track.sessionId === node.session.id);
    const top = Math.min(...rows.map((track) => track.y)), bottom = Math.max(...rows.map((track) => track.y + track.h));
    return { node, step, track: node.kind === 'tools' ? node.track : step.track ?? 'other', x: node.x + mark.x, y: node.y + (node.kind === 'tools' ? STRIP.pad : BAR.pad + BAR.label), top, bottom };
  }, [tip, layout]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Surface
        api={camera}
        world={(
          <div ref={world}>
            <div key={`ground|${level}`} className="canvas-fade">
              <Frames frames={layout.frames} far={far} />
              <Gutter marks={layout.gutter} cutoff={cutoff} />
              <TrackLines tracks={layout.tracks} />
              <Seams seams={layout.seams} cutoff={cutoff} far={far} />
            </div>
            {tipped && <div className="pointer-events-none absolute w-px bg-fg/20" style={{ left: tipped.x, top: tipped.top, height: tipped.bottom - tipped.top }} />}
            <Edges key={`edges|${level}`} edges={edges} related={related} />
            {!far && <Silences edges={edges} />}
            {nodes.map((node) => (
              <Node
                key={node.id}
                node={node}
                far={far}
                cutoff={cutoff}
                now={node.kind === 'agent' && node.turn.status === 'running' ? now : 0}
                pulse={node.kind === 'agent' && node.turn.runId && node.turn.status === 'running' ? pulses.get(node.turn.runId) : undefined}
                fresh={fresh(node.id)}
                dim={related !== undefined && !related.has(node.id)}
                lit={related?.has(node.id) === true && hovered !== node.id}
                selected={node.id === selectedId}
                focusPath={node.kind === 'change' ? focusPath : undefined}
                marked={tip?.id === node.id ? tip.index : undefined}
                actions={actions}
              />
            ))}
            {layout.next && !far && !replay && intersects(view, layout.next) && <NextPrompt node={layout.next} pending={pending?.text} fresh={fresh(layout.next.id)} onOpen={openNext} />}
          </div>
        )}
        overlay={(
          <>
            {pointedNode && !tipped && !replay && !far && pointedNode.id !== selectedId && (
              <ActionBar
                node={pointedNode}
                camera={camera}
                run={pointedNode.kind === 'agent' && pointedNode.turn.runId ? runs.get(pointedNode.turn.runId) : undefined}
                onPoint={point}
                onCopy={() => void ui.copy(copyText(pointedNode))}
                onOpen={() => openNode(pointedNode)}
                onDetails={() => { window.clearTimeout(clickTimer.current); select(pointedNode); }}
                forking={isForking(pointedNode)}
                {...(pointedNode.kind === 'agent' && pointedNode.turn.runId && pointedNode.turn.status !== 'running' ? { onFork: () => openFork(pointedNode) } : {})}
              />
            )}
            {tipped && !far && <CallTip track={tipped.track} step={tipped.step} x={tipped.x} y={tipped.y} camera={camera} />}
            {selected && selected.kind !== 'header' && (
              <Inspector
                key={selected.id}
                node={selected}
                detail={selected.kind === 'agent' || selected.kind === 'user' || selected.kind === 'signal' ? selected.detail : undefined}
                lanes={(lane) => lanes.get(`${selected.session.id}|${lane}`)}
                onToggleLane={(lane) => toggleLane(selected.session, lane)}
                onOpen={() => openNode(selected)}
                {...(selected.kind === 'tools' && focusStep ? { focus: focusStep } : {})}
                onOpenPath={navigation.openPath}
                onView={setLightbox}
                onBroken={markBroken}
                forking={isForking(selected)}
                {...(selected.kind === 'agent' && selected.turn.runId && selected.turn.status !== 'running' ? { onFork: () => openFork(selected) } : {})}
                onClose={() => select(undefined)}
              />
            )}
            {replay && moments.length > 0 && (
              <div className="absolute bottom-4 left-4 flex w-[min(520px,calc(100%-460px))] items-center gap-2 rounded-xl border border-line bg-elevated/95 px-2 py-1 shadow-soft backdrop-blur">
                <Button size="icon-sm" variant="quiet" aria-label={replay.playing ? m.pause : m.play} onClick={() => setReplay((current) => current && ({ index: current.index >= moments.length - 1 ? 0 : current.index, playing: !current.playing }))}>
                  {replay.playing ? <IconPause className="size-3.5" /> : <IconPlay className="size-3.5" />}
                </Button>
                <input
                  type="range"
                  min={0}
                  max={moments.length - 1}
                  value={Math.min(replay.index, moments.length - 1)}
                  aria-label={m.replayPosition}
                  className="min-w-0 flex-1 accent-[var(--accent)]"
                  onChange={(event) => setReplay({ index: Number(event.target.value), playing: false })}
                />
                <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-fg-3">{STAMP.format(cutoff)}</span>
                <Button size="icon-sm" variant="quiet" aria-label={m.endReplay} onClick={() => setReplay(undefined)}><IconX className="size-3.5" /></Button>
              </div>
            )}
            {!far && <TrackLabels api={camera} tracks={layout.tracks} />}
            {focusPulse && focusPulse.rate >= 1 && !replay && (
              <span className="pointer-events-none absolute bottom-4 left-4 flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] tabular-nums text-accent">
                <Sparkline series={focusPulse.series} />{Math.round(focusPulse.rate)} t/s
              </span>
            )}
            {!ready && <Spinner className="absolute left-1/2 top-1/2 size-4" />}
            <ZoomControls api={camera} onFit={fit} {...(selected && selected.kind !== 'header' ? { className: 'right-[424px]' } : {})}>
              {!replay && <Tip label={m.replay}><Button size="icon-sm" variant="quiet" aria-label={m.replay} disabled={!moments.length} onClick={() => { setDraft(undefined); setReplay({ index: 0, playing: true }); camera.userMoved(); camera.animateTo(camera.framing(layout.bounds, 0.8), 520); }}><IconPlay className="size-3.5" /></Button></Tip>}
              <Tip label={m.latest}><Button size="icon-sm" variant="quiet" aria-label={m.latest} disabled={!latest} onClick={() => { camera.moved.current = false; showLatest(true); }}><IconTarget className="size-3.5" /></Button></Tip>
            </ZoomControls>
            {draft?.kind === 'next' && composer && layout.next && !replay && (
              <NextComposer composer={composer} camera={camera} box={layout.next} inset={inset} onSent={sent} onClose={closeNext} />
            )}
            {forkNode?.turn.runId && !replay && (
              <ForkDraft
                key={forkNode.id}
                camera={camera}
                box={forkNode}
                inset={inset}
                initial={forkTexts.current.get(`${forkNode.session.id}|${forkNode.turn.runId}`) ?? ''}
                onChange={(text) => forkTexts.current.set(`${forkNode.session.id}|${forkNode.turn.runId}`, text)}
                onSend={(text) => void sendFork(forkNode.session, forkNode.turn.runId!, text)}
                onClose={() => setDraft(undefined)}
              />
            )}
            {lightbox && <Lightbox item={lightbox} onClose={closeLightbox} />}
          </>
        )}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ overlays */

/**
 * Each track's name at the start of its row, held at the plane's left edge once the row's start has
 * scrolled past, so a track is named wherever the reader is along it.
 */
function TrackLabels({ api, tracks }: { api: CameraApi; tracks: TrackBand[] }) {
  const m = useMessages(catalogs);
  const [, redraw] = useState(0);
  useEffect(() => api.subscribe(() => redraw((value) => value + 1)), [api]);
  const camera = api.read();
  const names: Record<Exclude<TrackBand['kind'], 'write'>, string> = { artifacts: m.artifacts, actors: m.subtasksTrack, shell: m.commands, explore: m.explore, web: m.web, ask: m.askedYou, other: m.otherTools };
  const icons: Record<TrackBand['kind'], typeof IconFolder> = { write: IconFolder, artifacts: IconImage, actors: IconSparkles, shell: IconSquareTerminal, explore: IconSearch, web: IconGlobe, ask: IconMessageCircleQuestion, other: IconWrench };
  return tracks.map((track) => {
    const y = (track.y + trackLine(track)) * camera.k + camera.y;
    const start = track.x * camera.k + camera.x, end = (track.x + track.w) * camera.k + camera.x;
    if (y < 40 || y > api.size.h - 20 || end < 160 || start > api.size.w) return null;
    const Icon = icons[track.kind];
    return (
      <span key={track.id} className="pointer-events-none absolute flex max-w-[180px] -translate-y-1/2 items-center gap-1.5 rounded-full border border-line-soft bg-[var(--canvas-paper)]/90 px-2 py-0.5 text-[11px] text-fg-3 backdrop-blur" style={{ left: Math.max(12, start), top: y }} title={track.label}>
        <Icon className="size-3 shrink-0 text-fg-4" />
        <span className={cn('truncate', track.kind === 'write' && track.external && 'font-mono text-[10.5px] text-fg-2')} dir={track.external ? 'rtl' : undefined}><bdi>{track.kind === 'write' ? track.label : names[track.kind]}</bdi></span>
      </span>
    );
  });
}

/** What can be done at a card, above its top-right corner: when it was, what it cost, and the actions. */
function ActionBar({ node, camera, run, forking, onPoint, onCopy, onOpen, onDetails, onFork }: {
  node: FlowNode;
  camera: CameraApi;
  run: Run | undefined;
  /** The fork this answer started is still being made. */
  forking: boolean;
  onPoint: (id: string | undefined) => void;
  onCopy: () => void;
  onOpen: () => void;
  onDetails: () => void;
  onFork?: () => void;
}) {
  const m = useMessages(catalogs);
  // Pinned to a card on screen, so it follows the camera on its own.
  const left = useCameraSelect(camera, (view) => (node.x + node.w) * view.k + view.x);
  const top = useCameraSelect(camera, (view) => Math.max(40, node.y * view.k + view.y - 6));
  const metrics = run?.native?.metrics;
  // When it was is on the time row already, and a finished turn's rate says nothing: how long it took, and how much it wrote.
  const facts = [
    node.kind === 'agent' || node.kind === 'actor' ? formatDuration(node.end - node.t) : '',
    metrics?.outputTokens ? `${compact(metrics.outputTokens)} tokens` : '',
  ].filter(Boolean);
  const text = copyText(node);
  return (
    <div
      className="canvas-pop absolute z-10 flex -translate-x-full -translate-y-full items-center gap-0.5 rounded-lg border border-line bg-elevated/95 py-0.5 pl-2.5 pr-0.5 shadow-soft backdrop-blur"
      style={{ left, top }}
      onPointerEnter={() => onPoint(node.id)}
      onPointerLeave={() => onPoint(undefined)}
    >
      <span className="mr-1 flex items-center gap-2 whitespace-nowrap text-[11px] tabular-nums text-fg-3">{facts.map((fact, index) => <span key={index}>{fact}</span>)}</span>
      {text && <Tip label={m.copy}><Button size="icon-sm" variant="quiet" className="size-6" aria-label={m.copy} onClick={onCopy}><IconCopy className="size-3.5" /></Button></Tip>}
      {node.kind !== 'actor' && <Tip label={m.openInChat}><Button size="icon-sm" variant="quiet" className="size-6" aria-label={m.openInChat} onClick={onOpen}><IconSquareArrowOutUpRight className="size-3.5" /></Button></Tip>}
      {onFork && <Tip label={m.forkFromHere}><Button size="icon-sm" variant="quiet" className="size-6" aria-label={m.forkFromHere} disabled={forking} onClick={onFork}>{forking ? <Spinner className="size-3.5" /> : <IconGitFork className="size-3.5" />}</Button></Tip>}
      <Tip label={m.details}><Button size="icon-sm" variant="quiet" className="size-6" aria-label={m.details} onClick={onDetails}><IconInfo className="size-3.5" /></Button></Tip>
    </div>
  );
}

/** One call of a strip, above its mark: what it was, how long it took, and the last of what it printed. */
function CallTip({ track, step, x, y, camera }: { track: Track; step: Step; x: number; y: number; camera: CameraApi }) {
  const m = useMessages(catalogs);
  const left = useCameraSelect(camera, (view) => x * view.k + view.x);
  const top = useCameraSelect(camera, (view) => y * view.k + view.y - 8);
  const label = callLabel(step, track);
  const iconKind = track === 'explore' && step.kindName === 'other' ? 'search' : step.kindName ?? '';
  const words = step.title && step.title !== step.arg && step.title !== step.toolName ? step.title : undefined;
  const command = step.arg ? unwrapShell(step.arg) : undefined;
  const code = command && command !== label.text ? command : label.mono ? label.text : undefined;
  const tail = outputTail(step.output, track === 'ask' ? 2 : 5);
  return (
    <div className="canvas-pop pointer-events-none absolute z-10 flex w-max max-w-[380px] -translate-x-1/2 -translate-y-full flex-col gap-1.5 rounded-lg border border-line bg-elevated/95 px-2.5 py-2 shadow-soft backdrop-blur" style={{ left, top }}>
      <p className="flex items-center gap-1.5 text-[11px] text-fg-3">
        <ToolIcon kind={iconKind} className={cn('size-3 shrink-0', step.failed ? 'text-danger' : 'text-fg-4')} />
        <span className="font-medium text-fg-2">{step.toolName ?? step.kindName}</span>
        <span className="ml-auto pl-3 tabular-nums text-fg-4">{step.running ? m.running : step.failed ? m.failed : formatDuration(step.end - step.start)}</span>
      </p>
      {words && <p className="line-clamp-2 text-xs text-fg">{words}</p>}
      {code && <p className="line-clamp-3 break-all font-mono text-[11px] leading-4 text-fg-2">{code}</p>}
      {tail.length > 0 && <pre className={cn('overflow-hidden whitespace-pre rounded-md bg-subtle px-2 py-1 font-mono text-[10.5px] leading-[15px]', step.failed ? 'text-danger/80' : 'text-fg-3')}>{tail.join('\n')}</pre>}
    </div>
  );
}

/* ------------------------------------------------------------------ edges */

/** The two ends of an SVG path written as `M x y … x y`. */
function endsOf(path: string): [[number, number], [number, number]] {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return [[numbers[0]!, numbers[1]!], [numbers.at(-2)!, numbers.at(-1)!]];
}

/** Drawn in as they first appear (and again after a level change re-forms them). */
const Edges = memo(function Edges({ edges, related }: { edges: FlowEdge[]; related: Set<string> | undefined }) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
      {edges.map((edge) => {
        const lit = related?.has(edge.id);
        const faded = related !== undefined && !lit;
        const [start, end] = endsOf(edge.path);
        const ink = edge.kind === 'fork' ? 'var(--accent)' : 'var(--fg)';
        const opacity = faded ? 0.06 : lit ? 0.55 : edge.kind === 'fork' ? 0.5 : 0.2;
        return (
          <g key={edge.id} className="transition-opacity duration-200" style={{ opacity: faded ? 0.35 : 1 }}>
            <path
              d={edge.path}
              fill="none"
              stroke={ink}
              strokeOpacity={opacity}
              strokeWidth={lit ? 1.6 : 1.2}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              {...(edge.kind === 'fork' ? { strokeDasharray: '6 5' } : { pathLength: 100, className: 'canvas-draw' })}
              style={{ transition: 'stroke-opacity 200ms' }}
            />
            {edge.kind !== 'reply' && (
              <>
                <circle cx={start[0]} cy={start[1]} r={2.5} fill="var(--bg-elevated)" stroke={ink} strokeOpacity={Math.max(opacity, 0.3)} vectorEffect="non-scaling-stroke" />
                <circle cx={end[0]} cy={end[1]} r={2.5} fill="var(--bg-elevated)" stroke={ink} strokeOpacity={Math.max(opacity, 0.3)} vectorEffect="non-scaling-stroke" />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
});
