/**
 * NullTransport — an in-memory transport with no Node dependency (only
 * Uint8Array, TextEncoder, setTimeout), proving the GMP stack runs without
 * Node's socket modules. Implements exactly GMPConnection / GMPTransport
 * (ARCHITECTURE_BASELINE.md §14), without adopt(). Writes are delivered in
 * order on a later timer turn.
 */

import type { GMPConnection, GMPDialOptions, GMPListener, GMPListenOptions, GMPTransport } from './transport.js';

type Handlers = { data: Array<(d: Uint8Array) => void>; close: Array<() => void>; error: Array<(e: Error) => void> };

/** Run queued callbacks in order on a later timer turn. */
class Mailbox {
  private queue: Array<() => void> = [];
  private scheduled = false;

  post(fn: () => void): void {
    this.queue.push(fn);
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      const run = this.queue;
      this.queue = [];
      for (const f of run) f();
    }, 0);
  }
}

export class NullConnection implements GMPConnection {
  readonly remoteAddress: string;
  readonly remotePort: number;
  private readonly handlers: Handlers = { data: [], close: [], error: [] };
  private peer: NullConnection | null = null;
  private closed = false;
  private readonly mailbox: Mailbox;

  private constructor(remoteAddress: string, remotePort: number, mailbox: Mailbox) {
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
    this.mailbox = mailbox;
  }

  static pair(clientPort: number, serverPort: number, mailbox: Mailbox): [NullConnection, NullConnection] {
    const client = new NullConnection('null.local', serverPort, mailbox);
    const server = new NullConnection('null.local', clientPort, mailbox);
    client.peer = server;
    server.peer = client;
    return [client, server];
  }

  on(event: 'data', handler: (data: Uint8Array) => void): this;
  on(event: 'close', handler: () => void): this;
  on(event: 'error', handler: (err: Error) => void): this;
  on(event: 'data' | 'close' | 'error', handler: ((d: Uint8Array) => void) | (() => void) | ((e: Error) => void)): this {
    (this.handlers[event] as Array<typeof handler>).push(handler);
    return this;
  }

  write(data: Uint8Array | string, callback?: (err?: Error | null) => void): void {
    const peer = this.peer;
    if (this.closed || !peer || peer.closed) {
      if (callback) this.mailbox.post(() => callback(new Error('Connection closed')));
      return;
    }
    // A copy, as a kernel would make: later mutation by the writer is not seen.
    const chunk = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    this.mailbox.post(() => {
      if (!peer.closed) for (const h of peer.handlers.data) h(chunk);
    });
    if (callback) this.mailbox.post(() => callback());
  }

  end(): void {
    this.destroy();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.peer = null;
    // Queued writes were posted first, so the peer sees the bytes, then the close.
    this.mailbox.post(() => {
      for (const h of this.handlers.close) h();
      if (peer && !peer.closed) {
        peer.closed = true;
        peer.peer = null;
        for (const h of peer.handlers.close) h();
      }
    });
  }
}

/** A shared in-memory "network": ports to listeners. */
export class NullNetwork {
  private readonly listeners = new Map<number, (c: GMPConnection) => void>();
  private nextPort = 40000;
  readonly mailbox = new Mailbox();

  register(port: number, onConnection: (c: GMPConnection) => void): number {
    const p = port === 0 ? this.nextPort++ : port;
    if (this.listeners.has(p)) throw new Error(`port ${p} in use`);
    this.listeners.set(p, onConnection);
    return p;
  }

  unregister(port: number): void {
    this.listeners.delete(port);
  }

  connect(port: number): Promise<GMPConnection> {
    const accept = this.listeners.get(port);
    if (!accept) return Promise.reject(Object.assign(new Error(`connect ECONNREFUSED null:${port}`), { code: 'ECONNREFUSED' }));
    const [client, server] = NullConnection.pair(this.nextPort++, port, this.mailbox);
    this.mailbox.post(() => accept(server));
    return Promise.resolve(client);
  }
}

export class NullTransport implements GMPTransport {
  readonly network: NullNetwork;

  constructor(network: NullNetwork = new NullNetwork()) {
    this.network = network;
  }

  listen(options: GMPListenOptions, onConnection: (connection: GMPConnection) => void): Promise<GMPListener> {
    try {
      const port = this.network.register(options.port, onConnection);
      const network = this.network;
      return Promise.resolve({ port, close: () => network.unregister(port) });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  dial(options: GMPDialOptions): Promise<GMPConnection> {
    if (options.signal && options.signal.aborted) return Promise.reject(new Error('Dial cancelled'));
    return this.network.connect(options.port);
  }

  close(): void {}
}
