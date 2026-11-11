import { useRef, useSyncExternalStore } from 'react';

/**
 * A small external store, in the same shape the subagent store uses: a snapshot that is replaced,
 * never mutated, and a subscription React reads through `useSyncExternalStore`. Components pick
 * what they need with a selector, so a change elsewhere in the slice does not render them.
 */
export interface Store<T> {
  get: () => T;
  /** Shallow-merges a patch, or applies an updater. Returning the same object (or `{}`) is a no-op. */
  set: (update: Partial<T> | ((current: T) => Partial<T> | T)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (update) => {
      const patch = typeof update === 'function' ? update(state) : update;
      if (patch === state) return;
      const next = { ...state, ...patch };
      if ((Object.keys(patch) as Array<keyof T>).every((key) => Object.is(state[key], next[key]))) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/**
 * Subscribes to one derived value. The selector must return something stable for an unchanged
 * state (a field, an element, a primitive); `isEqual` covers a selector that builds a new array.
 */
export function useStore<T extends object, S>(store: Store<T>, selector: (state: T) => S, isEqual: (a: S, b: S) => boolean = Object.is): S {
  const last = useRef<{ value: S } | undefined>(undefined);
  const read = () => {
    const value = selector(store.get());
    if (last.current && isEqual(last.current.value, value)) return last.current.value;
    last.current = { value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Resolves a `setState`-style argument against the current value. */
export function resolve<V>(next: V | ((value: V) => V), current: V): V {
  return typeof next === 'function' ? (next as (value: V) => V)(current) : next;
}
