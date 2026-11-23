import { spawn } from 'node:child_process';

export interface ProcessResult { code: number | null; stdout: string; stderr: string; stdoutData: Buffer; stderrData: Buffer; timedOut: boolean; truncated: boolean; aborted?: boolean; }
export interface ProcessOptions { cwd: string; timeoutMs?: number; maxOutputBytes?: number; input?: Buffer; env?: NodeJS.ProcessEnv; /** Kills the process (group) when aborted; the result then has `aborted` set. */ signal?: AbortSignal; }

export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise(resolve => {
    // Chunks are joined once at the end: joining on every chunk copies all of the output so far each time, which turns megabytes of output into seconds.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let kept = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    let aborted = false;
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
      if (!killTimer) killTimer = setTimeout(() => kill('SIGKILL'), 500);
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
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks);
      const errorData = Buffer.from([Buffer.concat(stderrChunks).toString('utf8'), error.message].filter(Boolean).join('\n'));
      resolve({ code: null, stdout: stdout.toString('utf8'), stderr: errorData.toString('utf8'), stdoutData: stdout, stderrData: errorData, timedOut, truncated, ...(aborted ? { aborted } : {}) });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks), stderr = Buffer.concat(stderrChunks);
      resolve({ code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutData: stdout, stderrData: stderr, timedOut, truncated, ...(aborted ? { aborted } : {}) });
    });
    const onAbort = (): void => { aborted = true; stopWithEscalation(); };
    if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      stopWithEscalation();
    }, timeoutMs);
    child.stdin.end(options.input);
  });
}
