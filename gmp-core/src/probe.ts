/**
 * `gmp probe <host> <port>`: is a GMP node really answering there, and is it
 * the one we think? A real handshake from a throwaway node (throwaway-node.ts)
 * over TCP, counting bytes and timing connect and handshake separately.
 */
import { TcpTransport } from './transport/tcp-transport.js';
import type { GMPConnection, GMPDialOptions, GMPListenOptions, GMPTransport } from './transport/transport.js';
import { createThrowawayNode } from './throwaway-node.js';
import { ghostAddressFromNodeId } from './ghost-address.js';

export type ProbeStage = 'connect' | 'handshake' | 'done';

export interface ProbeResult {
  host: string;
  port: number;
  /** Where the probe got: a failure names the stage that failed. */
  stage: ProbeStage;
  ok: boolean;
  remoteAddress: string | null;
  connectMs: number | null;
  handshakeMs: number | null;
  txBytes: number;
  rxBytes: number;
  nodeId: string | null;
  ghostAddress: string | null;
  error: string | null;
  /** Files the throwaway node wrote to its temporary dir (removed). */
  throwawayFiles: string[];
}

/** The real TCP transport, counting bytes and timing the connect. */
class CountingTransport implements GMPTransport {
  txBytes = 0;
  rxBytes = 0;
  connectMs: number | null = null;
  remoteAddress: string | null = null;
  dialError: Error | null = null;
  private readonly inner = new TcpTransport();

  listen(options: GMPListenOptions, onConnection: (c: GMPConnection) => void) {
    return this.inner.listen(options, onConnection);
  }

  async dial(options: GMPDialOptions): Promise<GMPConnection> {
    const t0 = performance.now();
    let conn: GMPConnection;
    try {
      conn = await this.inner.dial(options);
    } catch (e) {
      this.dialError = e as Error;
      throw e;
    }
    this.connectMs = Math.round(performance.now() - t0);
    this.remoteAddress = conn.remoteAddress;
    const write = conn.write.bind(conn);
    (conn as { write: GMPConnection['write'] }).write = (data, cb) => {
      this.txBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      return write(data, cb);
    };
    conn.on('data', (d: Uint8Array) => { this.rxBytes += d.length; });
    return conn;
  }

  close() {
    return this.inner.close();
  }
}

export async function probe(host: string, port: number, opts: { timeoutMs?: number; tls?: boolean } = {}): Promise<ProbeResult> {
  const transport = new CountingTransport();
  const t = await createThrowawayNode({ transport, prefix: 'gmp-probe' });
  const result: ProbeResult = {
    host, port, stage: 'connect', ok: false, remoteAddress: null, connectMs: null, handshakeMs: null,
    txBytes: 0, rxBytes: 0, nodeId: null, ghostAddress: null, error: null, throwawayFiles: [],
  };
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const t0 = performance.now();
  try {
    const dialing = t.node.dial(host, port, opts.tls ? { tls: true } : {}) as Promise<{ peerNodeId: Uint8Array }>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no completed handshake within ${timeoutMs} ms`)), timeoutMs);
    });
    const { peerNodeId } = await Promise.race([dialing, timeout]);
    result.handshakeMs = Math.round(performance.now() - t0);
    result.nodeId = Buffer.from(peerNodeId).toString('hex');
    result.ghostAddress = ghostAddressFromNodeId(result.nodeId);
    result.stage = 'done';
    result.ok = true;
  } catch (e) {
    result.error = (e as Error).message;
    result.stage = transport.connectMs === null ? 'connect' : 'handshake';
  } finally {
    if (timer) clearTimeout(timer);
    result.connectMs = transport.connectMs;
    result.remoteAddress = transport.remoteAddress;
    result.txBytes = transport.txBytes;
    result.rxBytes = transport.rxBytes;
    result.throwawayFiles = t.close().filesWritten;
  }
  return result;
}
