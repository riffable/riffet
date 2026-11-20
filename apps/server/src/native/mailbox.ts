/**
 * A serial mailbox: messages are handled one at a time, in arrival order, and no handler runs inside
 * another. A message posted from outside any handler is handled before `post` returns, and what it
 * throws reaches its caller, as a direct call would. One posted from inside a handler waits behind it;
 * its caller has returned by then, so a failure goes to `onDeferredError` instead of being thrown.
 */
export class Mailbox<M extends { type: string }> {
  private readonly queue: M[] = [];
  private processing = false;

  constructor(
    private readonly receive: (message: M) => void,
    /** Whether `next` adds nothing behind `last`, the newest message still waiting. */
    private readonly redundant: (last: M, next: M) => boolean,
    private readonly onDeferredError: (message: M, error: unknown) => void,
  ) {}

  /** Messages waiting behind the one being handled. */
  get pending(): number { return this.queue.length; }

  post(message: M): void {
    if (this.processing) {
      const last = this.queue.at(-1);
      if (!last || !this.redundant(last, message)) this.queue.push(message);
      return;
    }
    this.processing = true;
    try {
      this.receive(message);
    } finally {
      try {
        for (let next = this.queue.shift(); next; next = this.queue.shift()) {
          try { this.receive(next); }
          catch (error) { this.onDeferredError(next, error); }
        }
      } finally { this.processing = false; }
    }
  }

  clear(): void { this.queue.length = 0; }
}
