import { expect, it, vi } from 'vitest';
import { runProcess } from './exec.js';

it.skipIf(process.platform === 'win32')('reaps a helper that outlives its launcher on cancellation', async () => {
  const controller = new AbortController();
  let helperPid: number | undefined;
  const helper = `
    process.on('SIGTERM', () => {});
    process.send('ready');
    setInterval(() => {}, 1000);
  `;
  const launcher = `
    const { spawn } = require('node:child_process');
    const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    helper.once('message', () => console.log(helper.pid));
  `;
  try {
    const result = await runProcess(process.execPath, ['-e', launcher], {
      cwd: process.cwd(), signal: controller.signal, timeoutMs: null,
      onStdoutLine(line) { helperPid = Number(line); controller.abort(); },
    });
    expect(result.aborted).toBe(true);
    expect(helperPid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(() => process.kill(helperPid!, 0)).toThrow(/ESRCH/));
  } finally {
    if (helperPid) {
      try { process.kill(helperPid, 'SIGKILL'); } catch { /* already reaped */ }
    }
  }
});

it.skipIf(process.platform === 'win32')('releases pipes held by a detached helper after cancellation', async () => {
  const controller = new AbortController();
  let helperPid: number | undefined;
  const launcher = `
    const { spawn } = require('node:child_process');
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], {
      detached: true, stdio: ['ignore', 1, 2],
    });
    console.log(helper.pid);
  `;
  try {
    const result = await runProcess(process.execPath, ['-e', launcher], {
      cwd: process.cwd(), signal: controller.signal, timeoutMs: null,
      onStdoutLine(line) { helperPid = Number(line); controller.abort(); },
    });
    expect(result.aborted).toBe(true);
    expect(helperPid).toBeGreaterThan(0);
    // The unrelated process group is still alive when cancellation returns.
    expect(() => process.kill(helperPid!, 0)).not.toThrow();
  } finally {
    if (helperPid) {
      try { process.kill(helperPid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
});

it('keeps zero as a numeric timeout for existing process callers', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], {
    cwd: process.cwd(), timeoutMs: 0,
  });
  expect(result.timedOut).toBe(true);
});
