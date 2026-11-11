/**
 * Commands the workbench chrome (the palette) sends to whichever conversation is mounted. The
 * conversation owns the guards — in-flight sends, a stop already pending, a session switch — so the
 * palette only names the session and the command.
 */
type Command = 'stop';
type Listener = (command: Command) => void;

const listeners = new Map<string, Set<Listener>>();

export function onSessionCommand(sessionId: string, listener: Listener): () => void {
  let group = listeners.get(sessionId);
  if (!group) listeners.set(sessionId, group = new Set());
  group.add(listener);
  return () => { group!.delete(listener); if (!group!.size) listeners.delete(sessionId); };
}

/** Returns whether a mounted conversation received it. */
export function sendSessionCommand(sessionId: string, command: Command): boolean {
  const group = listeners.get(sessionId);
  for (const listener of group ?? []) listener(command);
  return Boolean(group?.size);
}
