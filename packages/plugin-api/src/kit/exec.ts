import { spawn } from 'node:child_process';

export interface ProcessResult { code: number | null; stdout: string; stderr: string; stdoutData: Buffer; stderrData: Buffer; timedOut: boolean; truncated: boolean; }
export interface ProcessOptions { cwd: string; timeoutMs?: number; maxOutputBytes?: number; input?: Buffer; env?: NodeJS.ProcessEnv; }

export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let kept = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
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
      if (target === 'stdout') stdout = Buffer.concat([stdout, part]);
      else stderr = Buffer.concat([stderr, part]);
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
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const errorData = Buffer.from([stderr.toString('utf8'), error.message].filter(Boolean).join('\n'));
      resolve({ code: null, stdout: stdout.toString('utf8'), stderr: errorData.toString('utf8'), stdoutData: stdout, stderrData: errorData, timedOut, truncated });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutData: stdout, stderrData: stderr, timedOut, truncated });
    });
    timer = setTimeout(() => {
      timedOut = true;
      stopWithEscalation();
    }, timeoutMs);
    child.stdin.end(options.input);
  });
}
