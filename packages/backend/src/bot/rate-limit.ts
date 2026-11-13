/** In-memory token bucket: 20 interactions per user per 60 s (S03). */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly capacity = 20, private readonly windowMs = 60_000) {}

  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / this.windowMs) * this.capacity);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}
