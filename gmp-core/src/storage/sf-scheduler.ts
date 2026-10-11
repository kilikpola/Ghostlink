/**
 * Mailbox poll scheduling: on trigger() (app foreground, network change) and
 * on a jittered interval, uniform in [0.5, 1.5] x interval from the end of the
 * previous poll. It only ever calls poll(); message state never changes on a
 * clock.
 */

import crypto from 'crypto';

export class SfPollScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  readonly intervalMs: number;
  private readonly poll: (reason: string) => Promise<unknown>;

  constructor(intervalMs: number, poll: (reason: string) => Promise<unknown>) {
    this.intervalMs = intervalMs;
    this.poll = poll;
  }

  /** Next wait, uniform in [0.5, 1.5] x interval. */
  nextDelay(): number {
    return Math.round(this.intervalMs * (0.5 + crypto.randomInt(1_000_000) / 1_000_000));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this._arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** An event the app reports ('foreground', 'network'): poll now, then re-arm. */
  trigger(reason: string): Promise<unknown> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.poll(reason).finally(() => this._arm());
  }

  private _arm(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.poll('interval').catch(() => {}).finally(() => this._arm());
    }, this.nextDelay());
    if (this.timer.unref) this.timer.unref();
  }
}
