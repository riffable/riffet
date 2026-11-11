/**
 * A map that forgets its least recently used entries past [limit] of them or, weighed by [weigh],
 * past [maxWeight] in total; an entry that alone outweighs that is let go at once. A hit counts as
 * a use. [onEvict] sees each entry the bounds push out, not one `set` replaces. Values are never
 * `undefined`, so a miss is told from a hit with one lookup.
 */
export interface BoundedCache<K, V> {
  get: (key: K) => V | undefined;
  has: (key: K) => boolean;
  set: (key: K, value: V) => void;
}

export function boundedCache<K, V extends {} | null>({ limit, maxWeight = Infinity, weigh, onEvict }: {
  limit: number;
  maxWeight?: number;
  weigh?: (key: K, value: V) => number;
  onEvict?: (key: K, value: V) => void;
}): BoundedCache<K, V> {
  const entries = new Map<K, V>();
  let weight = 0;
  const weightOf = (key: K, value: V) => weigh?.(key, value) ?? 0;
  return {
    get: (key) => {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      // Re-inserted so the map's insertion order doubles as recency.
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    has: (key) => entries.has(key),
    set: (key, value) => {
      const previous = entries.get(key);
      if (previous !== undefined) {
        entries.delete(key);
        weight -= weightOf(key, previous);
      }
      entries.set(key, value);
      weight += weightOf(key, value);
      while (entries.size > limit || weight > maxWeight) {
        const [oldest, evicted] = entries.entries().next().value!;
        entries.delete(oldest);
        weight -= weightOf(oldest, evicted);
        onEvict?.(oldest, evicted);
      }
    },
  };
}
