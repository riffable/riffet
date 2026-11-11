import { useRef } from 'react';

/** The previous value for as long as `same` finds nothing changed, so memoized consumers keep skipping. */
export function useStable<T>(value: T, same: (previous: T, next: T) => boolean): T {
  const ref = useRef(value);
  if (ref.current !== value && !same(ref.current, value)) ref.current = value;
  return ref.current;
}

export function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of right) if (!left.has(value)) return false;
  return true;
}

export function sameMap<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>, sameValue: (a: V, b: V) => boolean = Object.is): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of right) {
    if (!left.has(key) || !sameValue(left.get(key)!, value)) return false;
  }
  return true;
}
