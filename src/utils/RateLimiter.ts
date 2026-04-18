/**
 * Sliding-window rate limiter per key (e.g. roomId).
 */
export class RateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  /** Returns true if the request is allowed, false if rate-limited. */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const times = (this.windows.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length >= this.maxRequests) return false;

    times.push(now);
    this.windows.set(key, times);
    return true;
  }
}
