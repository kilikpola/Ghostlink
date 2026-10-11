/**
 * TCP transport — the production transport.
 *
 * - listen hands each accepted socket over synchronously so the node can veto
 *   it by remoteAddress before wiring up a link.
 * - dial uses plain TCP or unauthenticated TLS, resolving on connect (TLS: on
 *   secureConnect) and rejecting on pre-connect error.
 * - adopt() wraps an already-connected socket for TCP hole punching.
 */

import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import type {
  GMPConnection,
  GMPDialOptions,
  GMPListenOptions,
  GMPListener,
  GMPTransport,
} from './transport.js';

export class TcpConnection extends EventEmitter implements GMPConnection {
  private readonly socket: net.Socket;

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    socket.on('data', (data: Buffer) => this.emit('data', data));
    socket.on('close', () => this.emit('close'));
    socket.on('error', (err: Error) => this.emit('error', err));
  }

  get remoteAddress(): string | null {
    return this.socket.remoteAddress ?? null;
  }

  get remotePort(): number | null {
    return this.socket.remotePort ?? null;
  }

  write(data: Uint8Array | string, callback?: (err?: Error | null) => void): void {
    this.socket.write(data, callback);
  }

  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export class TcpListener implements GMPListener {
  private readonly server: net.Server;

  constructor(server: net.Server) {
    this.server = server;
  }

  get port(): number {
    const address = this.server.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  close(): void {
    this.server.close();
  }
}

export class TcpTransport implements GMPTransport {
  private readonly servers = new Set<net.Server>();

  listen(
    options: GMPListenOptions,
    onConnection: (connection: GMPConnection) => void
  ): Promise<GMPListener> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        onConnection(new TcpConnection(socket));
      });
      // Before bind, errors fail listen(); afterwards a reporting handler takes
      // over, so post-listen errors are never swallowed or uncaught.
      server.once('error', reject);
      server.listen({ host: options.host, port: options.port }, () => {
        server.off('error', reject);
        server.on('error', (err: Error) => {
          if (options.onError) options.onError(err, server.listening);
        });
        this.servers.add(server);
        resolve(new TcpListener(server));
      });
    });
  }

  dial(options: GMPDialOptions): Promise<GMPConnection> {
    const { host, port } = options;
    const useTls = options.tls === true;

    const signal = options.signal;
    if (signal && signal.aborted) return Promise.reject(new Error('Dial cancelled'));

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        socket.removeListener('error', onError);
        socket.destroy();
        reject(new Error('Dial cancelled'));
      };
      const onConnect = () => {
        socket.removeListener('error', onError);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(new TcpConnection(socket));
      };
      const onError = (err: Error) => {
        socket.removeListener('error', onError);
        if (signal) signal.removeEventListener('abort', onAbort);
        socket.destroy();
        reject(err);
      };

      let socket: net.Socket;
      if (useTls) {
        socket = tls.connect({
          host,
          port,
          servername: options.servername ?? host,
          rejectUnauthorized: false, // verified cryptographically in protocol layer
        }, onConnect);
      } else {
        socket = net.connect({ host, port }, onConnect);
      }
      socket.once('error', onError);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  adopt(socket: unknown): GMPConnection {
    if (socket instanceof TcpConnection) return socket;
    return new TcpConnection(socket as net.Socket);
  }

  close(): void {
    for (const server of this.servers) {
      server.close();
    }
    this.servers.clear();
  }
}
