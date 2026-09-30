/**
 * Leading + trailing throttle per key (e.g. per live): the first call in a
 * quiet window runs at once, and calls within the window collapse into
 * exactly one run when it ends - a burst can't flood a room, and the final
 * value is never lost.
 */
export class KeyedThrottle {
  private readonly lastRunAt = new Map<string, number>();
  private readonly trailing = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly windowMs: number,
    private readonly run: (key: string) => void,
  ) {}

  schedule(key: string): void {
    if (this.trailing.has(key)) return;
    const last = this.lastRunAt.get(key);
    const wait = last === undefined ? 0 : this.windowMs - (Date.now() - last);
    if (wait <= 0) {
      this.fire(key);
      return;
    }
    const timer = setTimeout(() => {
      this.trailing.delete(key);
      this.fire(key);
    }, wait);
    timer.unref();
    this.trailing.set(key, timer);
  }

  /** Drops a pending trailing run, e.g. once the live has ended. */
  cancel(key: string): void {
    clearTimeout(this.trailing.get(key));
    this.trailing.delete(key);
    this.lastRunAt.delete(key);
  }

  private fire(key: string): void {
    const ranAt = Date.now();
    this.lastRunAt.set(key, ranAt);
    // Only needed for one window - dropping it keeps the map from growing with every key ever seen.
    setTimeout(() => {
      if (this.lastRunAt.get(key) === ranAt) this.lastRunAt.delete(key);
    }, this.windowMs).unref();
    this.run(key);
  }
}
