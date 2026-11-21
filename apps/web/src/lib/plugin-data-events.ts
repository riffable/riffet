export interface PluginDataEvent {
  pluginId: string;
  topic?: string;
}

const listeners = new Set<(event: PluginDataEvent | undefined) => void>();

/** Notifies mounted isolated views that a plugin's query data changed (`undefined` after stream reconnect). */
export function emitPluginData(event: PluginDataEvent | undefined): void {
  for (const listener of [...listeners]) listener(event);
}

export function onPluginData(listener: (event: PluginDataEvent | undefined) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
