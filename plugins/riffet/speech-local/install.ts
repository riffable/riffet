// What is on disk and what is being downloaded: the engine (sherpa-onnx's two npm packages and the voice activity model)
// and the models. Every download goes to a temporary directory, is checked against the pinned hash and is renamed into
// place whole, so a failed or cancelled one leaves nothing behind (docs/VOICE.md §5).

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { ENGINE_NODE, ENGINE_PLATFORMS, ENGINE_VERSION, MODELS, VAD_FILE, type EnginePackage, type ModelId, type ModelPin } from './pins.js';

const run = promisify(execFile);

export type InstallKind = 'engine' | ModelId;

export type InstallError =
  | { code: 'network'; host: string }
  | { code: 'checksum'; file: string }
  /** A model's download stopped because the engine it needs could not be installed. */
  | { code: 'engine' }
  | { code: 'other'; detail: string };

/** `waiting`: a model whose download starts once the engine it needs is installed. */
export interface InstallProgress { received: number; total: number; waiting: boolean }

class InstallFailure extends Error {
  constructor(readonly failure: InstallError) { super(failure.code); }
}

interface Task extends InstallProgress { controller: AbortController; done: Promise<boolean> }

/** The platform whose prebuilt engine exists, or what stops it. */
export function enginePlatform(): { key: string; pkg: EnginePackage } | { unsupported: string } {
  const key = `${platform()}-${arch()}`;
  const pkg = ENGINE_PLATFORMS[key];
  if (!pkg) return { unsupported: key };
  // The Linux builds link glibc; musl (Alpine) reports no glibc version.
  if (platform() === 'linux') {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    if (!header?.glibcVersionRuntime) return { unsupported: `${key} (musl)` };
  }
  return { key, pkg };
}

export class Installer {
  private readonly tasks = new Map<InstallKind, Task>();
  private readonly failures = new Map<InstallKind, InstallError>();

  constructor(private readonly root: string, private readonly changed: (removed: boolean) => void) {}

  /** Removes what an interrupted download left; nothing runs yet when the plugin starts. */
  async sweep(): Promise<void> {
    for (const dir of [this.engineRoot, this.modelsRoot]) {
      for (const name of await readdir(dir).catch(() => [])) if (name.startsWith('.tmp-')) await rm(join(dir, name), { recursive: true, force: true });
    }
  }

  private get engineRoot(): string { return join(this.root, 'engine'); }
  private get modelsRoot(): string { return join(this.root, 'models'); }

  engineDir(): string { return join(this.engineRoot, ENGINE_VERSION); }
  modelDir(pin: ModelPin): string { return join(this.modelsRoot, `${pin.id}-${pin.revision}`); }

  async engineInstalled(): Promise<boolean> { return exists(join(this.engineDir(), 'node_modules')); }
  async modelInstalled(id: ModelId): Promise<boolean> { return exists(this.modelDir(pinOf(id))); }

  progress(kind: InstallKind): InstallProgress | undefined { return this.tasks.get(kind); }
  failure(kind: InstallKind): InstallError | undefined { return this.failures.get(kind); }
  busy(): boolean { return this.tasks.size > 0; }

  async diskSize(kind: InstallKind): Promise<number> {
    return treeSize(kind === 'engine' ? this.engineRoot : this.modelDir(pinOf(kind)));
  }

  cancel(kind: InstallKind): void { this.tasks.get(kind)?.controller.abort(); }
  cancelAll(): void { for (const task of this.tasks.values()) task.controller.abort(); }

  async remove(kind: InstallKind): Promise<void> {
    this.cancel(kind);
    this.failures.delete(kind);
    if (kind === 'engine') await rm(this.engineRoot, { recursive: true, force: true });
    else await rm(this.modelDir(pinOf(kind)), { recursive: true, force: true });
    this.changed(true);
  }

  /**
   * Starts in the background; the page reads `progress` and `failure`. A model needs the engine: without one, the engine is
   * installed first and the model waits for it, so a user only ever chooses models.
   */
  start(kind: InstallKind): void {
    if (this.tasks.has(kind)) return;
    const controller = new AbortController();
    let settle!: (ok: boolean) => void;
    const task: Task = { received: 0, total: 0, waiting: kind !== 'engine', controller, done: new Promise<boolean>(resolve => { settle = resolve; }) };
    this.tasks.set(kind, task);
    this.failures.delete(kind);
    const work = kind === 'engine' ? this.installEngine(task) : this.afterEngine(task).then(() => this.installModel(pinOf(kind), task));
    void work.then(
      () => { settle(true); this.changed(false); },
      (error: unknown) => {
        settle(false);
        if (controller.signal.aborted) return;
        this.failures.set(kind, error instanceof InstallFailure ? error.failure : { code: 'other', detail: String((error as Error)?.message ?? error) });
      },
    ).finally(() => { this.tasks.delete(kind); });
  }

  /** Waits for the engine, installing it when it is missing; a model download that waits counts nothing until then. */
  private async afterEngine(task: Task): Promise<void> {
    if (!this.tasks.has('engine') && await this.engineInstalled()) { task.waiting = false; return; }
    this.start('engine');
    const installed = await this.tasks.get('engine')?.done ?? await this.engineInstalled();
    task.controller.signal.throwIfAborted();
    if (!installed) throw new InstallFailure({ code: 'engine' });
    task.waiting = false;
  }

  private async installEngine(task: Task): Promise<void> {
    const target = enginePlatform();
    if ('unsupported' in target) throw new InstallFailure({ code: 'other', detail: target.unsupported });
    const temp = join(this.engineRoot, `.tmp-${randomBytes(6).toString('hex')}`);
    task.total = ENGINE_NODE.bytes + target.pkg.bytes + VAD_FILE.bytes;
    try {
      const built = join(temp, ENGINE_VERSION);
      await mkdir(join(built, 'node_modules'), { recursive: true });
      for (const pkg of [ENGINE_NODE, target.pkg]) {
        const archive = join(temp, `${pkg.name}.tgz`);
        await download(pkg.url, archive, { algorithm: 'sha512', encoding: 'base64', expected: pkg.integrity.replace(/^sha512-/, '') }, task);
        const into = join(built, 'node_modules', pkg.name);
        await mkdir(into);
        await run('tar', ['-xzf', archive, '-C', into, '--strip-components=1'], { signal: task.controller.signal });
        await rm(archive, { force: true });
      }
      await download(VAD_FILE.url, join(built, VAD_FILE.name), { algorithm: 'sha256', encoding: 'hex', expected: VAD_FILE.sha256 }, task);
      await this.dropOldEngines();
      await rename(built, this.engineDir());
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  private async dropOldEngines(): Promise<void> {
    for (const name of await readdir(this.engineRoot).catch(() => [])) {
      if (!name.startsWith('.tmp-')) await rm(join(this.engineRoot, name), { recursive: true, force: true });
    }
  }

  private async installModel(pin: ModelPin, task: Task): Promise<void> {
    const temp = join(this.modelsRoot, `.tmp-${pin.id}-${randomBytes(6).toString('hex')}`);
    try {
      await mkdir(temp, { recursive: true });
      task.total = pin.files.reduce((sum, file) => sum + file.bytes, 0);
      for (const file of pin.files) await download(file.url, join(temp, file.name), { algorithm: 'sha256', encoding: 'hex', expected: file.sha256 }, task);
      for (const name of await readdir(this.modelsRoot)) {
        if (name.startsWith(`${pin.id}-`)) await rm(join(this.modelsRoot, name), { recursive: true, force: true });
      }
      await rename(temp, this.modelDir(pin));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

function pinOf(id: ModelId): ModelPin {
  const pin = MODELS.find(model => model.id === id);
  if (!pin) throw new Error(`unknown model ${id}`);
  return pin;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function treeSize(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let sum = 0;
  for (const name of await readdir(path)) sum += await treeSize(join(path, name));
  return sum;
}

interface Check { algorithm: 'sha256' | 'sha512'; encoding: 'hex' | 'base64'; expected: string }

/** Streams `url` to `file`, counting into `task`, whose `total` the caller set from the pins; a hash that differs from the pin throws and the caller removes the directory. */
async function download(url: string, file: string, check: Check, task: Task): Promise<void> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, { signal: task.controller.signal, redirect: 'follow' });
  } catch (error) {
    if (task.controller.signal.aborted) throw error;
    throw new InstallFailure({ code: 'network', host });
  }
  if (!response.ok || !response.body) throw new InstallFailure({ code: 'network', host });
  const hash = createHash(check.algorithm);
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) { hash.update(chunk); task.received += chunk.length; done(null, chunk); },
  });
  try {
    await mkdir(dirname(file), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), measure, createWriteStream(file), { signal: task.controller.signal });
  } catch (error) {
    if (task.controller.signal.aborted) throw error;
    throw new InstallFailure({ code: 'network', host });
  }
  if (hash.digest(check.encoding) !== check.expected) throw new InstallFailure({ code: 'checksum', file: file.split('/').pop() ?? file });
}
