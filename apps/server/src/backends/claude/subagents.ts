import { open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const id = (value: unknown): string | undefined => typeof value === 'string' && /^[\w-]+$/.test(value) ? value : undefined;
const NO_TIME = new Date(0).toISOString();
const CHUNK = 1024 * 1024;
const PROBE = 64;

/** A successful Skill fork is a child; only an explicit background launch outlives its caller. */
export function forkedSkill(call: { name: string; input: Record<string, unknown> }, result: Record<string, unknown>): { agentId: string; background?: boolean; title: string } | undefined {
  const agentId = id(result.agentId);
  if (call.name !== 'Skill' || result.success !== true || result.status !== 'forked' || !agentId) return undefined;
  const name = text(result.commandName) ?? text(call.input.skill);
  return { agentId, title: name ? `/${name}` : 'Skill', ...(typeof result.background === 'boolean' ? { background: result.background } : {}) };
}

interface Fork {
  agentId: string;
  background?: boolean;
  title: string;
  toolUseId: string;
  resultUuid: string;
}

/** Both transcript readers use the same identity and metadata, independent of their read cursors. */
export interface ClaudeSubagentMeta {
  agentId: string;
  toolUseId: string;
  parentAgentId?: string;
  finished: boolean;
  stopped: boolean;
  background: boolean;
  at: string;
  file: string;
  info: { title?: string; subagentType?: string; model?: string };
  /** The structured result that supplies an identity missing from metadata. */
  fork?: Fork;
}

interface Scan {
  ino: number; size: number; mtimeMs: number; offset: number; probe: Buffer;
  valid: boolean;
  calls: Map<string, { name: string; input: Record<string, unknown> }>;
  forks: Map<string, Fork | null>;
}

async function range(handle: FileHandle, from: number, to: number): Promise<Buffer> {
  const bytes = Buffer.alloc(to - from);
  let filled = 0;
  while (filled < bytes.length) {
    const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, from + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return bytes.subarray(0, filled);
}

/**
 * Metadata normally names the spawning call. Forked Skills omit it, but their parent's tool result
 * names both ids. Scan each such owner once, then only its appended complete rows. This also repairs
 * sessions whose ordinary transcript cursor passed the result before this shape was understood.
 */
export class ClaudeSubagentDiscovery {
  private readonly metas = new Map<string, { stamp: string; value?: Record<string, unknown> }>();
  private readonly scans = new Map<string, Scan>();
  /** Only complete, readable evidence can retract a binding. Absence here means unknown. */
  private readonly bindings = new Map<string, string | null>();
  private file?: string;

  clear(): void { this.metas.clear(); this.scans.clear(); this.bindings.clear(); }

  invalidates(agentId: string, toolUseId: string): boolean {
    return this.bindings.has(agentId) && this.bindings.get(agentId) !== toolUseId;
  }

  async read(file: string, signal?: AbortSignal): Promise<ClaudeSubagentMeta[]> {
    if (this.file !== file) { this.clear(); this.file = file; }
    const root = join(dirname(file), basename(file).replace(/\.jsonl$/, ''), 'subagents');
    const entries = await readdir(root).catch(() => [] as string[]);
    const agents = new Set(entries.flatMap(entry => /^agent-([\w-]+)\.(?:meta\.json|jsonl)$/.exec(entry)?.[1] ?? []));
    const values: Array<{ agentId: string; value: Record<string, unknown>; at: string; metadata: boolean }> = [];
    for (const agentId of agents) {
      if (signal?.aborted) return [];
      const path = join(root, `agent-${agentId}.meta.json`);
      const info = await stat(path).catch(() => undefined);
      if (!info) { values.push({ agentId, value: {}, at: NO_TIME, metadata: false }); continue; }
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
      let held = this.metas.get(path);
      if (!held || held.stamp !== stamp) {
        const value = await readFile(path, 'utf8').then(bytes => { try { return record(JSON.parse(bytes)); } catch { return undefined; } }, () => undefined);
        this.metas.set(path, held = { stamp, value });
      }
      // A partial metadata file cannot tell us which parent owns a nested child yet.
      if (held.value) values.push({ agentId, value: held.value, at: new Date(info.mtimeMs).toISOString(), metadata: true });
    }
    const owners = new Map<string, string | undefined>();
    for (const { value } of values) {
      const parent = id(value.parentAgentId);
      if (value.parentAgentId !== undefined && !parent) continue;
      const owner = parent ? join(root, `agent-${parent}.jsonl`) : file;
      if (!text(value.toolUseId) || value.name !== undefined || this.scans.has(owner)) owners.set(owner, parent);
    }
    const complete = new Set<string>();
    for (const [owner, parent] of owners) {
      if (signal?.aborted) return [];
      if (await this.scan(owner, parent, signal)) complete.add(owner);
    }
    if (signal?.aborted) return [];
    const metas: ClaudeSubagentMeta[] = [];
    for (const { agentId, value, at, metadata } of values) {
      const parentAgentId = id(value.parentAgentId);
      if (value.parentAgentId !== undefined && !parentAgentId) continue;
      const owner = parentAgentId ? join(root, `agent-${parentAgentId}.jsonl`) : file;
      const candidate = this.scans.get(owner)?.forks.get(agentId);
      const toolUseId = text(value.toolUseId) ?? candidate?.toolUseId;
      // No metadata means even the owning parent may still be unknown. A partial owner scan
      // similarly cannot prove absence, but a readable explicit metadata id is authoritative.
      if (metadata && (text(value.toolUseId) || complete.has(owner))) this.bindings.set(agentId, toolUseId ?? null);
      if (!toolUseId) continue;
      const fork = candidate?.toolUseId === toolUseId ? candidate : undefined;
      if (this.invalidates(agentId, toolUseId)) continue;
      const title = text(value.description) ?? fork?.title, subagentType = text(value.agentType);
      const model = text(value.model) === 'inherit' ? undefined : text(value.model);
      metas.push({ agentId, toolUseId, at, file: join(root, `agent-${agentId}.jsonl`),
        finished: value.finished === true, stopped: value.stoppedByUser === true,
        background: fork?.background ?? (value.requestShape === 'background'),
        info: { ...(title ? { title } : {}), ...(subagentType ? { subagentType } : {}), ...(model ? { model } : {}) },
        ...(parentAgentId ? { parentAgentId } : {}), ...(fork ? { fork } : {}),
      });
    }
    const byAgent = new Map(metas.map(meta => [meta.agentId, meta]));
    const depth = (meta: ClaudeSubagentMeta, seen = new Set<string>()): number => {
      const parent = meta.parentAgentId ? byAgent.get(meta.parentAgentId) : undefined;
      if (!parent || seen.has(parent.agentId)) return 0;
      seen.add(parent.agentId);
      return 1 + depth(parent, seen);
    };
    return metas.map(meta => ({ meta, depth: depth(meta) }))
      .sort((a, b) => a.depth - b.depth || (a.meta.agentId < b.meta.agentId ? -1 : a.meta.agentId > b.meta.agentId ? 1 : 0)).map(({ meta }) => meta);
  }

  private async scan(file: string, parentAgentId: string | undefined, signal?: AbortSignal): Promise<boolean> {
    const handle = await open(file, 'r').catch(() => undefined);
    if (!handle) return false;
    try {
      const info = await handle.stat();
      let scan = this.scans.get(file);
      if (scan && scan.ino === info.ino && scan.size === info.size && scan.mtimeMs === info.mtimeMs) return scan.valid && scan.offset === info.size;
      if (scan && (scan.ino !== info.ino || info.size < scan.size
        || info.size === scan.size && info.mtimeMs !== scan.mtimeMs
        || !(await range(handle, Math.max(0, scan.offset - PROBE), scan.offset)).equals(scan.probe))) scan = undefined;
      if (!scan) {
        scan = { ino: info.ino, size: 0, mtimeMs: 0, offset: 0, probe: Buffer.alloc(0), valid: true, calls: new Map(), forks: new Map() };
        this.scans.set(file, scan);
      }
      let position = scan.offset, buffer: Buffer = Buffer.alloc(0), since = performance.now();
      while (position < info.size) {
        if (signal?.aborted) return false;
        const chunk = await range(handle, position, Math.min(info.size, position + CHUNK));
        if (!chunk.length) break;
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        position += chunk.length;
        let start = 0;
        for (let end = buffer.indexOf(0x0a); end >= 0; end = buffer.indexOf(0x0a, start)) {
          const line = buffer.subarray(start, end + 1);
          this.row(scan, line, parentAgentId);
          scan.offset += line.length;
          scan.probe = Buffer.from(Buffer.concat([scan.probe, line.subarray(-PROBE)]).subarray(-PROBE));
          start = end + 1;
          if (performance.now() - since >= 25) { await new Promise<void>(resolve => setImmediate(resolve)); since = performance.now(); }
          if (signal?.aborted) return false;
        }
        buffer = buffer.subarray(start);
      }
      scan.size = info.size;
      scan.mtimeMs = info.mtimeMs;
      return scan.valid && scan.offset === info.size;
    } catch { return false; } finally { await handle.close(); }
  }

  private row(scan: Scan, bytes: Buffer, parentAgentId: string | undefined): void {
    if (!bytes.includes('"tool_use"') && !bytes.includes('"tool_result"')) return;
    let row: Record<string, unknown> | undefined;
    try { row = record(JSON.parse(bytes.toString('utf8'))); } catch { scan.valid = false; return; }
    if (!row || row.type !== 'assistant' && row.type !== 'user') return;
    if (parentAgentId ? row.agentId !== undefined && row.agentId !== parentAgentId : row.isSidechain === true || row.agentId !== undefined) return;
    const content = record(row.message)?.content;
    if (!Array.isArray(content)) return;
    const parts = content.map(record).filter((part): part is Record<string, unknown> => part !== undefined);
    if (row.type === 'assistant') {
      for (const part of parts) if (part.type === 'tool_use' && part.name === 'Skill' && text(part.id)) {
        const input = record(part.input);
        scan.calls.set(part.id as string, { name: 'Skill', input: { skill: text(input?.skill)?.slice(0, 120) } });
        while (scan.calls.size > 256) scan.calls.delete(scan.calls.keys().next().value!);
      }
      return;
    }
    const results = parts.filter(part => part.type === 'tool_result');
    for (const part of results) {
      const toolUseId = text(part.tool_use_id);
      if (!toolUseId) continue;
      const call = scan.calls.get(toolUseId);
      scan.calls.delete(toolUseId);
      const fork = call && results.length === 1 && part.is_error !== true ? forkedSkill(call, record(row.toolUseResult) ?? {}) : undefined;
      if (!fork) continue;
      const previous = scan.forks.get(fork.agentId);
      scan.forks.set(fork.agentId, previous === null || previous && previous.toolUseId !== toolUseId ? null
        : { ...fork, toolUseId, resultUuid: text(row.uuid) ?? `line-${scan.offset}` });
    }
  }
}
