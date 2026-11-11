import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  step: string;
  /** The step's checkpoint arrived, or the run ended: the store has, or is about to have, all of it. */
  sealed: boolean;
  /** Empty until the model's first output: the run is then only its prompt. */
  parts: Array<{ type: 'reasoning' | 'text'; text: string }>;
}

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
    || (value.prompt !== undefined && typeof value.prompt !== 'string')) return undefined;
  const parts = value.parts.filter((part): part is CursorLiveStep['parts'][number] =>
    isRecord(part) && (part.type === 'reasoning' || part.type === 'text') && typeof part.text === 'string' && part.text.length > 0);
  if (!parts.length && !(typeof value.prompt === 'string' && value.prompt)) return undefined;
  return {
    pid: value.pid as number, turn: value.turn, at: value.at, step: value.step, sealed: value.sealed, parts,
    ...(typeof value.prompt === 'string' && value.prompt ? { prompt: value.prompt } : {}),
  };
}

/** The directory the CLIs this server launches write their live steps to, one file per conversation. */
export class CursorLive {
  private watcher: FSWatcher | undefined;
  private readonly listeners = new Set<(chatId: string) => void>();

  constructor(readonly dir: string) {}

  /** What a Cursor terminal launch adds to the pane's environment so its CLI loads the tap; none without one. */
  launchEnv(): Record<string, string> {
    if (!CURSOR_LIVE_TAP) return {};
    try { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); } catch { return {}; }
    // NODE_OPTIONS quotes a path with spaces; the tap takes itself back out for the CLI's own children.
    return { RIFFET_CURSOR_LIVE: this.dir, NODE_OPTIONS: `--require "${CURSOR_LIVE_TAP.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` };
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
    this.listeners.clear();
    this.watcher?.close();
    this.watcher = undefined;
  }
}
