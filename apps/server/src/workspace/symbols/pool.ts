import { fork, type ChildProcess } from 'node:child_process';

interface Task { payload: Record<string, unknown>; resolve: (value: any) => void; reject: (error: Error) => void }
interface Slot { child: ChildProcess; task?: Task; handled: number }

/** How the child reads what every task shares (paths of the parser and grammars, limits). */
export const PARSE_DATA_ENV = 'RIFFET_PARSE_WORKER_DATA';

/**
 * Child processes that run `script`, started on demand up to `size` and owned by whoever created the
 * pool: `terminate()` stops them all and fails what is queued. Processes, not worker threads: the
 * parser's WebAssembly heap and SQLite's caches run to gigabytes over a monorepo, and memory a thread
 * freed stays in the server's own allocator (measured: 900 MB of resident memory left after a build
 * whose JavaScript heap was 130 MB), while a process that exits gives all of it back. A child that dies
 * fails its task only and is replaced when there is more to do; one that handled `recycleAfter` files is
 * replaced too. A child whose parent goes away exits with it (`parse-worker.mjs`).
 */
export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private closed = false;
  /** Tasks that came back with an answer; zero means the children never got to run, a different failure from one bad input. */
  completed = 0;

  constructor(private readonly script: string, private readonly size: number, private readonly data: Record<string, unknown>, private readonly recycleAfter = Infinity) {}

  get live(): number { return this.slots.length; }

  run<T>(payload: Record<string, unknown>, weight = 1): Promise<T> {
    if (this.closed) return Promise.reject(new Error('worker pool closed'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ payload: { ...payload, id: this.nextId++, weight }, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length && !this.closed) {
      let slot = this.slots.find(item => !item.task);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const task = this.queue.shift()!;
      slot.task = task;
      slot.handled += Number(task.payload.weight);
      slot.child.send(task.payload);
    }
  }

  private spawn(): Slot {
    // No `execArgv`: a server run through tsx would otherwise load its loader into every child for a plain `.mjs`.
    const child = fork(this.script, [], {
      execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { ...process.env, [PARSE_DATA_ENV]: JSON.stringify(this.data) },
    });
    const slot: Slot = { child, handled: 0 };
    this.slots.push(slot);
    child.on('message', (message: { id: number; error?: string }) => {
      const task = slot.task;
      if (!task || task.payload.id !== message.id) return;
      slot.task = undefined;
      if (message.error) task.reject(new Error(message.error)); else { this.completed++; task.resolve(message); }
      if (slot.handled >= this.recycleAfter) this.retire(slot);
      this.pump();
    });
    let ended = false;
    const gone = (error: Error) => {
      if (ended) return;
      ended = true;
      const task = slot.task;
      slot.task = undefined;
      this.drop(slot);
      task?.reject(error);
      this.pump();
    };
    child.on('error', gone);
    child.on('exit', (code, signal) => gone(new Error(`parse worker exited with ${signal ?? `code ${code}`}`)));
    return slot;
  }

  private drop(slot: Slot): void {
    const at = this.slots.indexOf(slot);
    if (at >= 0) this.slots.splice(at, 1);
  }

  private retire(slot: Slot): void {
    this.drop(slot);
    slot.child.kill();
  }

  async terminate(): Promise<void> {
    this.closed = true;
    for (const task of this.queue.splice(0)) task.reject(new Error('worker pool closed'));
    const slots = this.slots.splice(0);
    await Promise.all(slots.map(async (slot) => {
      const task = slot.task;
      slot.task = undefined;
      if (slot.child.exitCode === null && slot.child.signalCode === null) {
        const exited = new Promise(resolve => slot.child.once('exit', resolve));
        slot.child.kill();
        await exited;
      }
      task?.reject(new Error('worker pool closed'));
    }));
  }
}
