/**
 * In-memory transport for deterministic tests. Delivery is asynchronous
 * (setImmediate) and ordered, like a TCP byte stream.
 *
 * - The network is keyed by port alone; hosts are ignored.
 * - remoteAddress is always 'memory.local'.
 * - No TLS and no adopt().
 */

import { EventEmitter } from 'events';
import type {
  GMPConnection,
  GMPDialOptions,
  GMPListenOptions,
  GMPListener,
  GMPTransport,
} from './transport.js';

export class MemoryConnection extends EventEmitter implements GMPConnection {
  readonly remoteAddress: string;
  readonly remotePort: number;
  private peer: MemoryConnection | null = null;
  private closed = false;

  private constructor(remoteAddress: string, remotePort: number) {
    super();
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
  }

  static createPair(clientPort: number, serverPort: number): [MemoryConnection, MemoryConnection] {
    const client = new MemoryConnection('memory.local', serverPort);
    const server = new MemoryConnection('memory.local', clientPort);
    client.peer = server;
    server.peer = client;
    return [client, server];
  }

  write(data: Uint8Array | string, callback?: (err?: Error | null) => void): void {
    const peer = this.peer;
    if (this.closed || !peer || peer.closed) {
      if (callback) setImmediate(() => callback(new Error('Connection closed')));
      return;
    }
    // Copy, like the kernel would: later mutation of the caller's buffer must
    // not change what the peer receives.
    const chunk = Buffer.from(data);
    setImmediate(() => {
      if (!peer.closed) peer.emit('data', chunk);
    });
    if (callback) setImmediate(() => callback());
  }

  end(): void {
    this.destroy();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.peer = null;
    // Queued writes were setImmediate'd before this close, so the peer still
    // sees the bytes before the close — the ordering TCP would give.
    setImmediate(() => {
      this.emit('close');
      if (peer && !peer.closed) {
        peer.closed = true;
        peer.peer = null;
        peer.emit('close');
      }
    });
  }
}

class MemoryListener implements GMPListener {
  private readonly network: MemoryNetwork;
  readonly port: number;

  constructor(network: MemoryNetwork, port: number) {
    this.network = network;
    this.port = port;
  }

  close(): void {
    this.network.unregister(this.port);
  }
}

export class MemoryNetwork {
  private listeners = new Map<number, (connection: GMPConnection) => void>();
  private nextEphemeralPort = 49152;
  private nextClientPort = 1024;

  register(requestedPort: number, handler: (connection: GMPConnection) => void): number {
    let port = requestedPort;
    if (port === 0) {
      do {
        port = this.nextEphemeralPort++;
      } while (this.listeners.has(port));
    }
    if (this.listeners.has(port)) {
      const err = new Error(`listen EADDRINUSE: memory port ${port} already in use`) as NodeJS.ErrnoException;
      err.code = 'EADDRINUSE';
      throw err;
    }
    this.listeners.set(port, handler);
    return port;
  }

  unregister(port: number): void {
    this.listeners.delete(port);
  }

  connect(port: number): Promise<GMPConnection> {
    return new Promise((resolve, reject) => {
      const handler = this.listeners.get(port);
      if (!handler) {
        const err = new Error(`connect ECONNREFUSED: no memory listener on port ${port}`) as NodeJS.ErrnoException;
        err.code = 'ECONNREFUSED';
        reject(err);
        return;
      }
      const [client, server] = MemoryConnection.createPair(this.nextClientPort++, port);
      setImmediate(() => {
        handler(server);
        resolve(client);
      });
    });
  }
}

export class MemoryTransport implements GMPTransport {
  readonly network: MemoryNetwork;

  constructor(network: MemoryNetwork = new MemoryNetwork()) {
    this.network = network;
  }

  listen(
    options: GMPListenOptions,
    onConnection: (connection: GMPConnection) => void
  ): Promise<GMPListener> {
    try {
      const port = this.network.register(options.port, onConnection);
      return Promise.resolve(new MemoryListener(this.network, port));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  dial(options: GMPDialOptions): Promise<GMPConnection> {
    return this.network.connect(options.port);
  }

  adopt(): GMPConnection {
    throw new Error('MemoryTransport cannot adopt raw sockets; there are none');
  }

  close(): void {}
}
