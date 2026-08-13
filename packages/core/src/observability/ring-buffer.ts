/**
 * Fixed-capacity circular buffer.
 *
 * The Logs pane needs the recent tail of log history immediately on open, but
 * reading and parsing a rotated 5MB NDJSON file on every UI mount is wasteful
 * and slow. Keeping a bounded in-memory ring gives O(1) writes, a hard memory
 * ceiling (spec §90: low idle overhead), and an instant `tail`.
 *
 * Overwrites oldest-first once full — losing old lines in memory is fine
 * because the file on disk remains the durable record.
 */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  /** Index of the next write. */
  private cursor = 0;
  private count = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.items[this.cursor] = item;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  get size(): number {
    return this.count;
  }

  /** Oldest to newest. */
  toArray(): T[] {
    const out: T[] = [];
    const start = this.count < this.capacity ? 0 : this.cursor;
    for (let i = 0; i < this.count; i += 1) {
      const item = this.items[(start + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  /** The `n` most recent entries, oldest to newest. */
  tail(n: number): T[] {
    if (n <= 0) return [];
    const all = this.toArray();
    return n >= all.length ? all : all.slice(all.length - n);
  }

  clear(): void {
    this.items.fill(undefined);
    this.cursor = 0;
    this.count = 0;
  }
}
