// Bundled into Riffet/Resources/canvas-layout.js by build-canvas-layout.sh; run by JavaScriptCore.
// The canvas's own fold and layout, unchanged, behind an incremental API that mirrors the state
// `CanvasView` keeps. Every call takes and returns JSON strings, which is what crosses the bridge
// cheaply. Swift owns the clock, the fetching and the drawing; this owns what the canvas knows.
import { i18n } from '@lingui/core';
import type { Run, Session, TimelineRow, TurnOutlineV3 } from '@contracts';
import { byTurn, turnDetail, turnKey, type TurnDetail } from '../../../../plugins/riffet/canvas/web/detail';
import { layoutFlow, sessionFamily, type FlowLayout, type FlowNode, type Level } from '../../../../plugins/riffet/canvas/web/flow';
import { catalogs, type Messages } from '../../../../plugins/riffet/canvas/web/messages';
import linguiCatalogs from 'canvas-lingui-catalogs';
import { foldContext } from './fold';
import { detailOf, render, tipOf, type RenderInput } from './render';

/** A running turn's column stretches its clock as it goes; the layout follows in steps, not every second. */
const LAYOUT_TICK = 10_000;

/** The fields of a session the canvas reads; the host need send no more. */
type SessionInput = Pick<Session, 'id' | 'projectId' | 'kind' | 'title' | 'state' | 'createdAt'> & Partial<Pick<Session, 'backendId' | 'model' | 'origin' | 'archivedAt'>>;
interface ProjectInput { id: string; cwd?: string; name?: string; branch?: string }

const turnVersion = (turn: TurnOutlineV3) => `${turn.rows}|${turn.status}|${turn.endPos ?? ''}|${turn.endedAt ?? ''}`;

let m: Messages = catalogs['zh-Hans']!;
let fold = foldContext(m);
let allSessions: Session[] = [];
let focus = '';
let family: Session[] = [];
let projects = new Map<string, ProjectInput>();
const outlines = new Map<string, TurnOutlineV3[]>();
const details = new Map<string, TurnDetail>();
const lanes = new Map<string, TurnDetail | null>();
const closedLanes = new Set<string>();
const runs = new Map<string, { state: string; outputTokens?: number }>();
const turnVersions = new Map<string, string>();
let summaries: Map<string, string> | undefined;
let broken = new Set<string>();
let last: { nodes: Map<string, FlowNode>; input: RenderInput } | undefined;

const root = (session: Session | undefined) => session ? projects.get(session.projectId)?.cwd : undefined;
const sessionById = (id: string) => allSessions.find((session) => session.id === id);

/** Picks the language. Returns the canvas's plain strings, which the native views draw as they are. */
function configure(locale: string): string {
  const key = locale in linguiCatalogs ? locale : 'zh-Hans';
  i18n.load(linguiCatalogs as never);
  i18n.activate(key);
  m = catalogs[locale] ?? catalogs['zh-Hans']!;
  fold = foldContext(m);
  const strings: Record<string, string> = {};
  for (const [name, value] of Object.entries(m)) {
    if (typeof value === 'string') { strings[name] = value; continue; }
    // A string with a count goes over as a template, `{n}` where the count stands; `name#one` is the form for exactly one.
    if (typeof value !== 'function' || value.length !== 1) continue;
    const many = String((value as (n: unknown) => string)('{n}'));
    if (!many.includes('{n}')) continue;
    strings[name] = many;
    const one = String((value as (n: unknown) => string)(1));
    if (one !== many.replace('{n}', '1')) strings[`${name}#one`] = one.replace('1', '{n}');
  }
  return JSON.stringify(strings);
}

/** All the conversations the host knows, and the one whose canvas this is; the family is derived from them. */
function setSessions(focusId: string, json: string): void {
  allSessions = JSON.parse(json) as SessionInput[] as Session[];
  focus = focusId;
  family = sessionFamily(focusId, allSessions);
  const ids = new Set(family.map((session) => session.id));
  for (const id of [...outlines.keys()]) if (!ids.has(id)) outlines.delete(id);
}

function setProjects(json: string): void {
  projects = new Map((JSON.parse(json) as ProjectInput[]).map((project) => [project.id, project]));
}

/**
 * Stores a conversation's outline and says which turns need their rows read: those whose version
 * changed since they were folded. They are then counted as in flight; `failTurns` hands them back.
 */
function setOutline(sessionId: string, json: string): string {
  const turns = JSON.parse(json) as TurnOutlineV3[];
  outlines.set(sessionId, turns);
  const changed = turns.filter((turn) => turnVersions.get(turnKey(sessionId, turn.turn)) !== turnVersion(turn));
  for (const turn of changed) turnVersions.set(turnKey(sessionId, turn.turn), turnVersion(turn));
  return JSON.stringify({ turns: changed.map((turn) => turn.turn), from: changed.length ? Math.min(...changed.map((turn) => turn.startPos)) : 0 });
}

/** A read of rows failed: those turns are asked for again with the next outline. */
function failTurns(sessionId: string, json: string): void {
  for (const turn of JSON.parse(json) as string[]) turnVersions.delete(turnKey(sessionId, turn));
}

/** Folds [turns] from the rows read for them; a turn with no rows folds to nothing, as on the web. */
function setTurnRows(sessionId: string, turnsJson: string, rowsJson: string, now: number): void {
  const rows = byTurn(JSON.parse(rowsJson) as TimelineRow[]);
  const session = sessionById(sessionId);
  for (const turn of JSON.parse(turnsJson) as string[]) details.set(turnKey(sessionId, turn), turnDetail(sessionId, rows.get(turn) ?? [], root(session), now, fold));
}

/** A subagent's lane: its rows folded whole; `null` marks it as being read. */
function setLane(sessionId: string, lane: string, rowsJson: string | null, now: number): void {
  const key = `${sessionId}|${lane}`;
  closedLanes.delete(key);
  lanes.set(key, rowsJson === null ? null : turnDetail(sessionId, JSON.parse(rowsJson) as TimelineRow[], root(sessionById(sessionId)), now, fold));
}

/** A lane that failed to read, or that the reader closed: it is not asked for again until `setLane`. */
function dropLane(sessionId: string, lane: string): void {
  const key = `${sessionId}|${lane}`;
  lanes.delete(key);
  closedLanes.add(key);
}

function setRuns(json: string): void {
  for (const run of JSON.parse(json) as Run[]) runs.set(run.id, { state: run.state, ...(run.native?.metrics?.outputTokens !== undefined ? { outputTokens: run.native.metrics.outputTokens } : {}) });
}

/** One-sentence answers by `session|turn`; `null` when summaries are off. */
function setSummaries(json: string | null): void {
  summaries = json === null ? undefined : new Map(Object.entries(JSON.parse(json) as Record<string, string>));
}

/** Artifacts whose image would not load leave the track. */
function setBroken(json: string): void {
  broken = new Set(JSON.parse(json) as string[]);
}

function layout(level: Level, now: number, optionsJson: string): string {
  const { next, sending = false } = JSON.parse(optionsJson) as { next?: boolean; sending?: boolean };
  const at = Math.floor(now / LAYOUT_TICK) * LAYOUT_TICK;
  const projectOf = (session: Session) => {
    const project = projects.get(session.projectId);
    return { ...(project?.name ? { name: project.name } : {}), ...(project?.branch ? { branch: project.branch } : {}) };
  };
  const flow: FlowLayout = layoutFlow(family, outlines, details, lanes, at, level, projectOf, { ...(summaries ? { summaries } : {}), broken, ...(next ? { next: focus, sending } : {}) });
  const input: RenderInput = {
    layout: flow, level, now: at, m, focus, details, lanes, runs, summaries, closedLanes,
    ready: family.length > 0 && family.every((session) => outlines.has(session.id)),
  };
  const rendered = render(input);
  last = { nodes: rendered.nodes, input };
  return rendered.json;
}

/** The inspector's content for a node of the last layout. */
function detail(nodeId: string): string {
  const node = last?.nodes.get(nodeId);
  return JSON.stringify(node && last ? detailOf(node, last.input) : null);
}

/** The tooltip of one call of a strip or bar of the last layout. */
function tip(nodeId: string, index: number): string {
  const node = last?.nodes.get(nodeId);
  return JSON.stringify(node ? tipOf(node, index, m) ?? null : null);
}

(globalThis as Record<string, unknown>).CanvasLayout = { configure, setSessions, setProjects, setOutline, failTurns, setTurnRows, setLane, dropLane, setRuns, setSummaries, setBroken, layout, detail, tip };
