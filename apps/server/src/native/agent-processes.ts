import { readFile } from 'node:fs/promises';
import { exec } from '../exec.js';

/** One row of `ps`: enough to sum a process tree's resident memory. */
interface ProcessRow { pid: number; ppid: number; pgid: number; rssBytes: number }

/** The roots of one conversation's processes: its CLI's pane process, its app-server's process group. */
export interface AgentProcessRoots { panePid?: number; appServerPgid?: number }

/**
 * Resident memory of each conversation's processes, by the key `roots` gives them: the whole tree
 * under its pane process, plus every member of its app-server's process group and their trees. A
 * process counted under one key is not counted again. Empty when `ps` cannot be read.
 */
export async function agentMemory<K>(roots: ReadonlyMap<K, AgentProcessRoots>): Promise<Map<K, number>> {
  const result = new Map<K, number>();
  if (process.platform === 'win32' || !roots.size) return result;
  const listed = await exec('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss='], { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } }).catch(() => undefined);
  if (!listed) return result;
  const rows = new Map<number, ProcessRow>(), children = new Map<number, number[]>(), groups = new Map<number, number[]>();
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const row = { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), rssBytes: Number(match[4]) * 1024 };
    rows.set(row.pid, row);
    let siblings = children.get(row.ppid); if (!siblings) children.set(row.ppid, siblings = []); siblings.push(row.pid);
    let members = groups.get(row.pgid); if (!members) groups.set(row.pgid, members = []); members.push(row.pid);
  }
  const counted = new Set<number>();
  for (const [key, { panePid, appServerPgid }] of roots) {
    let total = 0;
    const pending = [...(panePid ? [panePid] : []), ...(appServerPgid ? groups.get(appServerPgid) ?? [] : [])];
    while (pending.length) {
      const pid = pending.pop()!;
      const row = rows.get(pid);
      if (!row || counted.has(pid)) continue;
      counted.add(pid);
      total += row.rssBytes;
      pending.push(...children.get(pid) ?? []);
    }
    result.set(key, total);
  }
  return result;
}

export type MemoryPressure = 'normal' | 'warning' | 'critical';

/**
 * The system's memory pressure as the kernel reports it: macOS's VM pressure level, Linux's PSI
 * (`/proc/pressure/memory`, the share of the last 10 s some or all tasks stalled on memory).
 * `normal` where neither can be read.
 */
export async function memoryPressure(): Promise<MemoryPressure> {
  if (process.platform === 'darwin') {
    const read = await exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000 }).catch(() => undefined);
    const level = Number(read?.stdout.trim());
    // 1 normal, 2 warn, 4 critical (`sys/kern_memorystatus.h`).
    return level >= 4 ? 'critical' : level >= 2 ? 'warning' : 'normal';
  }
  if (process.platform === 'linux') {
    const text = await readFile('/proc/pressure/memory', 'utf8').catch(() => '');
    const avg10 = (kind: string) => Number(new RegExp(`^${kind} avg10=([\\d.]+)`, 'm').exec(text)?.[1] ?? 0);
    return avg10('full') >= 5 ? 'critical' : avg10('some') >= 10 ? 'warning' : 'normal';
  }
  return 'normal';
}
