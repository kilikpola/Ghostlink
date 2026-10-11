/**
 * Link keepalive timing: an encrypted PING every intervalMs, and teardown if
 * no PONG arrives within timeoutMs. Sending and teardown are callbacks.
 *
 * A new PING re-arms the pong timer without clearing a pending one, so with
 * timeoutMs > intervalMs both timers check the shared lastPongReceived flag.
 */

export const DEFAULT_PING_INTERVAL_MS = 30000;
export const DEFAULT_PONG_TIMEOUT_MS = 10000;

export interface KeepaliveOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Called on each interval tick; should send a PING and call pingSent(). */
  onInterval: () => void;
  /** Called when a PONG timeout expires with no PONG received. */
  onTimeout: () => void;
}

export class Keepalive {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  private readonly onInterval: () => void;
  private readonly onTimeout: () => void;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  lastPongReceived = false;

  constructor(options: KeepaliveOptions) {
    this.intervalMs = options.intervalMs || DEFAULT_PING_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs || DEFAULT_PONG_TIMEOUT_MS;
    this.onInterval = options.onInterval;
    this.onTimeout = options.onTimeout;
  }

  start(): void {
    this.pingTimer = setInterval(this.onInterval, this.intervalMs);
  }

  /** A PING just went out: expect a PONG within timeoutMs. */
  pingSent(): void {
    this.lastPongReceived = false;
    this.pongTimer = setTimeout(() => {
      if (!this.lastPongReceived) {
        this.onTimeout();
      }
    }, this.timeoutMs);
  }

  pongReceived(): void {
    this.lastPongReceived = true;
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
  }
}
