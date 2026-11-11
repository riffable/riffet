import type { ChildProcess } from 'node:child_process';

/** A child that never got a pid failed to spawn, so it counts as exited as well. */
export function childHasExited(child: ChildProcess): boolean {
  return child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true once the child has exited, or false when `timeoutMs` passes first. */
export async function waitForExit(child: ChildProcess, timeoutMs?: number): Promise<boolean> {
  if (childHasExited(child)) return true;
  return await new Promise<boolean>(resolvePromise => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolvePromise(exited || childHasExited(child));
    };
    const onExit = () => finish(true);
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}
