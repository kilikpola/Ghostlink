/**
 * Transport abstraction: the boundary between GMP protocol logic and how bytes
 * travel.
 *
 * - Connections are byte streams with 'data' / 'close' / 'error' events;
 *   GMPLink does its own framing.
 * - write() takes an optional completion callback.
 * - Every connection carries remoteAddress/remotePort.
 * - listen() hands inbound connections over synchronously so the node can veto.
 * - dial() resolves once connected (TLS: after the TLS handshake).
 * - adopt() wraps a foreign connected socket (TCP hole punching).
 *
 * No backpressure: write() return values are ignored.
 */

export interface GMPConnection {
  readonly remoteAddress: string | null;
  readonly remotePort: number | null;
  /** True for a relay circuit: no address, never announced or cached. */
  readonly isRelayed?: boolean;
  /** Relay circuits only: whether the relay is separated from hosts that know this identity (read by the manager). */
  readonly separation?: 'separated' | 'unseparated';

  /** Bytes arrive as a Uint8Array (TCP hands over Buffers, which are Uint8Arrays). */
  on(event: 'data', handler: (data: Uint8Array) => void): unknown;
  on(event: 'close', handler: () => void): unknown;
  on(event: 'error', handler: (err: Error) => void): unknown;

  write(data: Uint8Array | string, callback?: (err?: Error | null) => void): unknown;

  /** Half-close after flushing writes (used by the HTTP health-check shim). */
  end(): void;

  destroy(): void;
}

export interface GMPListenOptions {
  host: string;
  /** 0 asks the transport for a free port; the bound port is on the listener. */
  port: number;
  /**
   * Errors after a successful bind; transports do not log themselves.
   * `stillListening` says whether the listener survived.
   */
  onError?: (err: Error, stillListening: boolean) => void;
}

export interface GMPDialOptions {
  host: string;
  port: number;
  /** Unauthenticated TLS (obfuscation only); authentication is the GMP handshake's. */
  tls?: boolean;
  servername?: string;
  /** Abandon the dial, destroying a connect in progress. */
  signal?: AbortSignal;
}

export interface GMPListener {
  /** The actually bound port (differs from the request when 0 was passed). */
  readonly port: number;
  close(): void;
}

export interface GMPTransport {
  listen(
    options: GMPListenOptions,
    onConnection: (connection: GMPConnection) => void
  ): Promise<GMPListener>;

  dial(options: GMPDialOptions): Promise<GMPConnection>;

  /** Wrap a socket connected outside the transport (hole punching). Optional. */
  adopt?(socket: unknown): GMPConnection;

  close(): Promise<void> | void;
}
