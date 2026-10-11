/**
 * GMP wire framing:  [4 bytes payload length, uint32 BE][1 byte type][payload].
 * The 5-byte header is also the AES-GCM AAD for encrypted frames (session.ts),
 * so its encoding is part of the cryptographic contract.
 */

export const MESSAGETYPES = {
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  DATA: 0x03,
  PING: 0x04,
  PONG: 0x05,
  BINDING_REQUEST: 0x06,
  BINDING_RESPONSE: 0x07,
  TOPOLOGY_ANNOUNCE: 0x08,
  PEER_REQUEST: 0x09,
  PEER_RESPONSE: 0x0A,
  KEY_ROTATION: 0x0B,
  // Relay tier; see relay/relay-protocol.ts.
  RELAY_RESERVE: 0x0C,
  RELAY_RESERVATION: 0x0D,
  RELAY_CONNECT: 0x0E,
  RELAY_DATA: 0x0F,
  RELAY_STOP: 0x10,
  // Sealed store-and-forward; see storage/storage-protocol.ts.
  STORE_REQUEST: 0x11,
  STORE_ACK: 0x12,
  FETCH_REQUEST: 0x13,
  FETCH_RESPONSE: 0x14,
  /** Retired (formerly FETCH_DELETE). Ignored on receipt; never reuse. */
  RETIRED_0x15: 0x15,
} as const;

export const FRAME_HEADER_LEN = 5;

/** Largest payload length a peer may declare; enforced on receive only. */
export const MAX_MESSAGE_SIZE = 1024 * 1024;

/**
 * STORE_REQUEST and FETCH_RESPONSE carry one sealed blob (up to a 1 MiB
 * padding bucket), so they alone may declare up to this much.
 */
export const MAX_STORAGE_FRAME_SIZE = MAX_MESSAGE_SIZE + 64 * 1024;

/** The largest payload a frame of this type may declare. */
export function maxPayloadFor(type: number): number {
  return type === MESSAGETYPES.STORE_REQUEST || type === MESSAGETYPES.FETCH_RESPONSE
    ? MAX_STORAGE_FRAME_SIZE
    : MAX_MESSAGE_SIZE;
}

// Bitwise rather than writeUInt32BE: a truncated frame yields a negative AAD
// length, which must not throw here; decryption then fails on the short tag.
export function writeUint32BE(buffer: Uint8Array, value: number, offset: number): void {
  buffer[offset] = (value >> 24) & 0xff;
  buffer[offset + 1] = (value >> 16) & 0xff;
  buffer[offset + 2] = (value >> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

export function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] << 24) |
    (buffer[offset + 1] << 16) |
    (buffer[offset + 2] << 8) |
    buffer[offset + 3]
  ) >>> 0;
}

/** The 5-byte header for a frame of `type` whose payload is `payloadLen` long. */
export function frameHeader(payloadLen: number, type: number): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  writeUint32BE(header, payloadLen, 0);
  header[4] = type;
  return header;
}

export function encodeFrame(type: number, payload: Uint8Array): Buffer {
  return Buffer.concat([frameHeader(payload.length, type), payload]);
}

export class FrameTooLargeError extends Error {
  readonly declaredLength: number;

  constructor(declaredLength: number) {
    super('Message too large');
    this.name = 'FrameTooLargeError';
    this.declaredLength = declaredLength;
  }
}

export interface DecodedFrame {
  type: number;
  payload: Buffer;
}

/**
 * Reassembles frames from a chunked byte stream. next() returns a frame or
 * null. An oversized declared length throws FrameTooLargeError and the
 * connection must be dropped.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private expectedPayloadLen = 0;
  private currentMessageType: number | null = null;

  push(data: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, data]);
  }

  /** Everything received and not yet returned as a frame. */
  get buffered(): Buffer {
    return this.buffer;
  }

  next(): DecodedFrame | null {
    if (this.buffer.length < FRAME_HEADER_LEN) return null;

    if (this.expectedPayloadLen === 0) {
      this.expectedPayloadLen = readUint32BE(this.buffer, 0);
      this.currentMessageType = this.buffer[4];

      if (this.expectedPayloadLen > maxPayloadFor(this.currentMessageType)) {
        throw new FrameTooLargeError(this.expectedPayloadLen);
      }
    }

    const totalLen = FRAME_HEADER_LEN + this.expectedPayloadLen;
    if (this.buffer.length < totalLen) return null;

    const type = this.currentMessageType;
    const payload = this.buffer.slice(FRAME_HEADER_LEN, totalLen);
    this.buffer = this.buffer.slice(totalLen);
    this.expectedPayloadLen = 0;
    this.currentMessageType = null;
    return { type, payload };
  }
}
