import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURSOR_USAGE_FILE, readCursorUsage } from './usage-observation.js';
export type { CursorUsageCapture } from './usage-observation.js';

/**
 * The step a Cursor CLI is streaming, as its live tap (`assets/live-tap.cjs`) writes it. The chat store
 * only gets a step at its checkpoint, after the model is done with it; the tap reads the deltas off the
 * CLI's agent stream in the meantime.
 */
export interface CursorLiveStep {
  /** The request id the store files the turn's prompt under. */
  turn: string;
  /** When the run began: the prompt's time until the store records its own. */
  at: string;
  /** The prompt that began the run; the store records it at the first checkpoint too. */
  prompt?: string;
  /** The native run id from `AgentRunRequest`, matching `CursorUsageCapture.nativeTurnId`. */
  run?: string;
  /** The model requested for this run, when known from the stream request. */
  requestedModel?: string;
  step: string;
  /** The step's checkpoint arrived, or the run ended: the store has, or is about to have, all of it. */
  sealed: boolean;
  /** Epoch ms of the first text/reasoning delta received for this step, when recorded by the tap. */
  firstDeltaAt?: number;
  /** Epoch ms of the latest text/reasoning delta received for this step, when recorded by the tap. */
  lastDeltaAt?: number;
  /** Empty until the model's first output: the run is then only its prompt. */
  parts: Array<{ type: 'reasoning' | 'text'; text: string }>;
  /** The tap reports the run's end: `ended` or `broken` is set once it is over. Absent from taps that predate it. */
  turnEnds?: boolean;
  /** Epoch ms the server ended the run's turn (`InteractionUpdate.turn_ended`, field 14). */
  ended?: number;
  /** Epoch ms the stream closed without that end: a stop, a network error, a retry. */
  broken?: number;
}

/** Whether the protocol stream says the run is still going: a tap that reports ends, and neither end yet. */
export const cursorLiveOpen = (step: CursorLiveStep | undefined): boolean =>
  Boolean(step?.turnEnds && step.ended === undefined && step.broken === undefined);

/**
 * The id a turn's prompt is known by across its draft and its committed copy, whatever place the store
 * gives it: the CLI's request id. A run's receipt names it, so the prompt row stays the run's.
 */
export const cursorPromptAlias = (requestId: string) => `request:${requestId}`;

const here = dirname(fileURLToPath(import.meta.url));
/** A checkout runs from `native/`; a build runs from `dist/`, where the plugin's `assets/` are copied whole. */
export const CURSOR_LIVE_TAP = [resolve(here, '../assets/live-tap.cjs'), resolve(here, 'plugins/riffet/cursor/assets/live-tap.cjs')].find(existsSync);

const CHAT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function parse(value: unknown): (CursorLiveStep & { pid: number }) | undefined {
  if (!isRecord(value) || value.v !== 1 || !Number.isSafeInteger(value.pid) || typeof value.turn !== 'string' || !value.turn
    || typeof value.at !== 'string' || typeof value.step !== 'string' || typeof value.sealed !== 'boolean' || !Array.isArray(value.parts)
    || (value.prompt !== undefined && typeof value.prompt !== 'string')
    || (value.run !== undefined && typeof value.run !== 'string')
    || (value.requestedModel !== undefined && typeof value.requestedModel !== 'string')) return undefined;
  const parts = value.parts.filter((part): part is CursorLiveStep['parts'][number] =>
    isRecord(part) && (part.type === 'reasoning' || part.type === 'text') && typeof part.text === 'string' && part.text.length > 0);
  if (!parts.length && !(typeof value.prompt === 'string' && value.prompt)) return undefined;
  const firstDeltaAt = typeof value.firstDeltaAt === 'number' && Number.isFinite(value.firstDeltaAt) && value.firstDeltaAt > 0 ? value.firstDeltaAt : undefined;
  const lastDeltaAt = typeof value.lastDeltaAt === 'number' && Number.isFinite(value.lastDeltaAt) && value.lastDeltaAt > 0 ? value.lastDeltaAt : undefined;
  const instant = (at: unknown) => typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : undefined;
  const ended = instant(value.ended), broken = instant(value.broken);
  return {
    pid: value.pid as number, turn: value.turn, at: value.at, step: value.step, sealed: value.sealed, parts,
    ...(typeof value.prompt === 'string' && value.prompt ? { prompt: value.prompt } : {}),
    ...(typeof value.run === 'string' && value.run ? { run: value.run } : {}),
    ...(typeof value.requestedModel === 'string' && value.requestedModel ? { requestedModel: value.requestedModel } : {}),
    ...(firstDeltaAt !== undefined ? { firstDeltaAt } : {}),
    ...(lastDeltaAt !== undefined ? { lastDeltaAt } : {}),
    ...(value.turnEnds === true ? { turnEnds: true } : {}),
    ...(ended !== undefined ? { ended } : {}),
    ...(broken !== undefined ? { broken } : {}),
  };
}

/** The directory the CLIs this server launches write their live steps to, one file per conversation. */
export class CursorLive {
  private watcher: FSWatcher | undefined;
  private readonly listeners = new Set<(chatId: string) => void>();
  private usageWatcher: FSWatcher | undefined;
  private readonly usageListeners = new Set<() => void>();
  readonly usageDir: string;

  constructor(readonly dir: string) { this.usageDir = join(dirname(resolve(dir)), 'cursor-usage'); }

  /** What a Cursor terminal launch adds to the pane's environment so its CLI loads the tap; none without one. */
  launchEnv(): Record<string, string> {
    if (!CURSOR_LIVE_TAP) return {};
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      mkdirSync(this.usageDir, { recursive: true, mode: 0o700 });
    } catch { return {}; }
    // NODE_OPTIONS quotes a path with spaces; the tap takes itself back out for the CLI's own children.
    return { RIFFET_CURSOR_LIVE: this.dir, RIFFET_CURSOR_USAGE: this.usageDir, NODE_OPTIONS: `--require "${CURSOR_LIVE_TAP.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` };
  }

  /** Unacknowledged terminal observations, including records left by CLIs that already exited. */
  readUsage(): ReturnType<typeof readCursorUsage> { return readCursorUsage(this.usageDir); }

  /** Only acknowledge this queue's metadata files, never a path supplied by an observation. */
  ackUsage(file: string): void {
    const name = basename(file);
    if (!CURSOR_USAGE_FILE.test(name) || resolve(file) !== join(this.usageDir, name)) return;
    try { if (lstatSync(file).isFile()) unlinkSync(file); } catch { /* already acknowledged */ }
  }

  /** A change hint; readers also sweep at startup and periodically to recover missed watch events. */
  watchUsage(listener: () => void): () => void {
    this.usageListeners.add(listener);
    if (!this.usageWatcher) {
      try {
        mkdirSync(this.usageDir, { recursive: true, mode: 0o700 });
        this.usageWatcher = watch(this.usageDir, (_event, file) => {
          if (!file || !CURSOR_USAGE_FILE.test(file)) return;
          for (const each of [...this.usageListeners]) try { each(); } catch { /* independent consumers */ }
        });
        this.usageWatcher.on('error', () => { this.usageWatcher?.close(); this.usageWatcher = undefined; });
        this.usageWatcher.unref();
      } catch { this.usageWatcher = undefined; }
    }
    return () => {
      this.usageListeners.delete(listener);
      if (!this.usageListeners.size) { this.usageWatcher?.close(); this.usageWatcher = undefined; }
    };
  }

  /** The step chat `chatId` is streaming, while the CLI writing it still runs. */
  read(chatId: string): CursorLiveStep | undefined {
    if (!CHAT_ID.test(chatId)) return undefined;
    const file = join(this.dir, `${chatId}.json`);
    let step: ReturnType<typeof parse>;
    try { step = parse(JSON.parse(readFileSync(file, 'utf8'))); }
    catch { return undefined; }
    if (!step) return undefined;
    if (!alive(step.pid)) {
      // The CLI exited without its own cleanup; nothing else will remove the file.
      try { unlinkSync(file); } catch { /* already gone */ }
      return undefined;
    }
    const { pid: _pid, ...live } = step;
    return live;
  }

  /** Calls `listener` with the chat whose live step changed; one directory watch serves every listener. */
  watch(listener: (chatId: string) => void): () => void {
    this.listeners.add(listener);
    if (!this.watcher) {
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.watcher = watch(this.dir, (_event, file) => {
          // `.<chat>.<pid>.tmp` is the tap's write in progress; its rename onto `<chat>.json` is the change.
          if (!file?.endsWith('.json') || file.startsWith('.')) return;
          const chatId = file.slice(0, -5);
          for (const each of [...this.listeners]) try { each(chatId); } catch { /* one reader must not stop the others */ }
        });
        this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
        this.watcher.unref();
      } catch { this.watcher = undefined; }
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { this.watcher?.close(); this.watcher = undefined; }
    };
  }

  close(): void {
    this.usageListeners.clear();
    this.usageWatcher?.close();
    this.usageWatcher = undefined;
    this.listeners.clear();
    this.watcher?.close();
    this.watcher = undefined;
  }
}
