/**
 * Values that take seconds to read (a CLI spawn, a gateway listing). Each is trusted while fresh and,
 * once stale, still answered at once while a refresh runs behind it; a failed refresh keeps the last
 * value read, and concurrent reads join one request. Past `limit` keys the least recently used goes.
 */
export class FreshCache<T> {
  private readonly entries = new Map<string, { value?: T; freshUntil: number; request?: Promise<T> }>();

  constructor(private readonly freshMs: number, private readonly limit: number) {}

  /** `refresh` waits for a new read instead of answering with what is held. */
  get(key: string, load: () => Promise<T>, options: { refresh?: boolean } = {}): Promise<T> {
    const entry = this.entries.get(key) ?? { freshUntil: 0 };
    this.entries.delete(key);
    this.entries.set(key, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
    if (!options.refresh && entry.value !== undefined && entry.freshUntil > Date.now()) return Promise.resolve(entry.value);
    entry.request ??= load()
      .then(value => { entry.value = value; entry.freshUntil = Date.now() + this.freshMs; return value; })
      .finally(() => { entry.request = undefined; });
    if (entry.value === undefined || options.refresh) return entry.request;
    entry.request.catch(() => undefined);
    return Promise.resolve(entry.value);
  }

  clear(): void { this.entries.clear(); }
}
