import { spawn } from 'node:child_process';

export interface ProcessResult { code: number | null; stdout: string; stderr: string; stdoutData: Buffer; stderrData: Buffer; timedOut: boolean; truncated: boolean; aborted?: boolean; spawnErrorCode?: string; }
export interface ProcessOptions {
  cwd: string;
  /** Null delegates the deadline to the caller's signal. Numeric values retain setTimeout semantics. */
  timeoutMs?: number | null;
  maxOutputBytes?: number; input?: Buffer; env?: NodeJS.ProcessEnv;
  /** Kills the process (group) when aborted; the result then has `aborted` set. */
  signal?: AbortSignal;
  /** Streams and discards stdout one UTF-8 line at a time, including a final line without LF. The
   * byte budget bounds each line and retained stderr. Throw to stop the process and reject. */
  onStdoutLine?(line: string): void;
}

export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs === undefined ? 15_000 : options.timeoutMs;
  if (timeoutMs === null && !options.signal) return Promise.reject(new TypeError('A signal is required when the process has no timeout'));
  return new Promise((resolve, reject) => {
    // Chunks are joined once at the end: joining on every chunk copies all of the output so far each time, which turns megabytes of output into seconds.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let kept = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    let aborted = false;
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;
    let lineFailure: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, signal); return; } catch { /* The group may have exited; fall back to the direct child. */ }
      }
      try { child.kill(signal); } catch { /* The child may already have exited. */ }
    };
    const stopWithEscalation = (): void => {
      kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => {
        kill('SIGKILL');
        // A helper outside the launcher's group may still hold the other end of these pipes.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, 500);
    };
    const finishStop = () => {
      if (!killTimer) return;
      clearTimeout(killTimer);
      // A launcher can exit on TERM while its helper ignores TERM and has closed its pipes.
      // The direct child has already exited. Address only the process group we created.
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group has already exited */ }
      }
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = Math.max(0, maxBytes - kept);
      const part = chunk.subarray(0, remaining);
      if (part.length) (target === 'stdout' ? stdoutChunks : stderrChunks).push(part);
      kept += part.length;
      if (chunk.length > part.length) {
        truncated = true;
        stopWithEscalation();
      }
    };
    const finishLine = () => {
      const line = Buffer.concat(lineChunks, lineBytes).toString('utf8');
      lineChunks = [];
      lineBytes = 0;
      try { options.onStdoutLine!(line.replace(/\r$/, '')); }
      catch (error) {
        lineFailure = error instanceof Error ? error : new Error(String(error));
        stopWithEscalation();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (!options.onStdoutLine) { append('stdout', chunk); return; }
      let start = 0;
      while (start < chunk.length && !aborted && !timedOut && !truncated && !lineFailure) {
        const lf = chunk.indexOf(10, start);
        const end = lf === -1 ? chunk.length : lf;
        lineBytes += end - start;
        if (lineBytes > maxBytes) { truncated = true; stopWithEscalation(); break; }
        if (end > start) lineChunks.push(chunk.subarray(start, end));
        if (lf !== -1) finishLine();
        start = end + 1;
      }
    });
    child.stdout.on('end', () => {
      if (lineBytes && !aborted && !timedOut && !truncated && !lineFailure) finishLine();
    });
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      finishStop();
      if (lineFailure) { reject(lineFailure); return; }
      const stdout = Buffer.concat(stdoutChunks);
      const errorData = Buffer.from([Buffer.concat(stderrChunks).toString('utf8'), error.message].filter(Boolean).join('\n'));
      const spawnErrorCode = (error as NodeJS.ErrnoException).code;
      resolve({ code: null, stdout: stdout.toString('utf8'), stderr: errorData.toString('utf8'), stdoutData: stdout, stderrData: errorData, timedOut, truncated, ...(aborted ? { aborted } : {}), ...(spawnErrorCode ? { spawnErrorCode } : {}) });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      finishStop();
      if (lineFailure) { reject(lineFailure); return; }
      const stdout = Buffer.concat(stdoutChunks), stderr = Buffer.concat(stderrChunks);
      resolve({ code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutData: stdout, stderrData: stderr, timedOut, truncated, ...(aborted ? { aborted } : {}) });
    });
    const onAbort = (): void => { aborted = true; stopWithEscalation(); };
    if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== null) timer = setTimeout(() => {
      timedOut = true;
      stopWithEscalation();
    }, timeoutMs);
    child.stdin.end(options.input);
  });
}
