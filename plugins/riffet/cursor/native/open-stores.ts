import { execFile } from 'node:child_process';
import { readdir, readlink } from 'node:fs/promises';

/** Runs a command for information only: a missing binary is an answer, not a failure. */
export function tryExec(command: string, args: string[], timeoutMs = 3000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}

/** The files a process has open: `/proc` where it exists, `lsof` otherwise (~50ms). */
export async function openPaths(pid: number): Promise<string[]> {
  try {
    const names = await readdir(`/proc/${pid}/fd`);
    const paths = await Promise.all(names.map((name) => readlink(`/proc/${pid}/fd/${name}`).catch(() => undefined)));
    return paths.filter((path): path is string => typeof path === 'string');
  } catch { /* Not Linux. */ }
  const output = await tryExec('lsof', ['-Fn', '-p', String(pid)]);
  return output ? output.split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1)) : [];
}

export const CHAT_STORE = /^(.+)\/([0-9a-f-]{36})\/store\.db$/i;

/**
 * The top-level chat a pane's open stores identify. A CLI can hold a subagent's store open at the
 * same time, so only chats already known to be top-level count; when several qualify the most
 * recently written one is the chat being worked in.
 */
export function workingChat(open: string[], topLevel: Array<{ id: string; mtime: number }>): { id: string; mtime: number } | undefined {
  return open.flatMap((id) => topLevel.filter((item) => item.id === id)).sort((a, b) => b.mtime - a.mtime)[0];
}
