/**
 * Per-subnet token bucket shared by relay reservations and storage deposits:
 * `burst` tokens per subnet (subnetKey), regaining `ratePerMinute`. A rate, not
 * a head count, because of CGNAT.
 *
 * Residual: an attacker in the victim's own /24 can spend the burst.
 */
export class SubnetTokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  /** `limits` and `clock` are read on every call, so they may be replaced live. */
  constructor(
    private readonly limits: () => { ratePerMinute: number; burst: number },
    private readonly clock: () => number,
  ) {}

  take(subnet: string): boolean {
    const now = this.clock();
    const { ratePerMinute, burst } = this.limits();
    const b = this.buckets.get(subnet) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + Math.max(0, now - b.at) * (ratePerMinute / 60000));
    b.at = now;
    this.buckets.set(subnet, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  refund(subnet: string): void {
    const b = this.buckets.get(subnet);
    if (b) b.tokens = Math.min(this.limits().burst, b.tokens + 1);
  }

  /** Forget subnets that have refilled completely; they hold no information. */
  sweep(): void {
    const now = this.clock();
    const { ratePerMinute, burst } = this.limits();
    for (const [subnet, b] of this.buckets) {
      if (b.tokens + (now - b.at) * (ratePerMinute / 60000) >= burst) this.buckets.delete(subnet);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
