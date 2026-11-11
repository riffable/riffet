import { createContext, useCallback, useContext, useState } from 'react';

/**
 * A long transcript unmounts the rows away from the reader and mounts them again on the way back,
 * so a row's own `useState` (a tool opened, an output shown whole) would start over each time. The
 * view keeps those values here instead: one map per conversation, keyed by the row (or the item
 * inside a folded block) and by what the component calls the value. Both contexts carry values that
 * stay the same for a row's life, so providing them never re-renders a memoized row.
 */
export const RememberedValues = createContext<Map<string, unknown> | undefined>(undefined);
/** The row or item the components under it belong to; a nested one replaces the outer. */
export const RememberedScope = createContext<string | undefined>(undefined);

/**
 * `useState` that a remounted row gets back: the last value set under [key] in the row it renders in.
 * Outside a transcript row it is plain state. A different [key] reads that key's value (or
 * [initial]), so a value that depends on something, like a failed task opening itself, can say so
 * in its key.
 */
export function useRemembered<T>(key: string, initial: T): [T, (next: T) => void] {
  const values = useContext(RememberedValues);
  const scope = useContext(RememberedScope);
  const id = values && scope !== undefined ? `${scope}\n${key}` : `\n${key}`;
  const read = () => (values && scope !== undefined && values.has(id) ? values.get(id) as T : initial);
  const [state, setState] = useState(() => ({ id, value: read() }));
  let current = state;
  if (state.id !== id) {
    current = { id, value: read() };
    setState(current);
  }
  const set = useCallback((next: T) => {
    if (values && scope !== undefined) values.set(id, next);
    setState((previous) => (previous.id === id && Object.is(previous.value, next) ? previous : { id, value: next }));
  }, [values, scope, id]);
  return [current.value, set];
}
