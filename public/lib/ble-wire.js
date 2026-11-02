// @ts-check

// The wire protocol between the dashboard and the Pi's BLE GATT server, in one file that
// BOTH ends import: the browser directly, the Pi from src/ble-server/. One copy means the
// two cannot drift, which a hand-ported TypeScript twin would. Pure: no I/O and no clock,
// only bytes in and bytes out (plus crypto.subtle, which is deterministic given its
// inputs), so scripts/check-ble-wire.ts round-trips all of it with no radio.
//
// Layers, outermost first: GATT values carry FRAMES (a 2-byte header, so a message can
// span several MTU-sized values); frames reassemble into ENVELOPES (clear or sealed);
// a sealed envelope opens into a MESSAGE (kind, JSON header, raw body). Why every message
// is sealed rather than only gated behind a login: docs/ble-server.md §"Why seal".

/** @typedef {Uint8Array<ArrayBuffer>} Bytes */

export const PROTOCOL_VERSION = 1;

export const SERVICE_UUID = "7c0e0001-5f3a-4c8e-9d2b-c00e7a000001";
/** Phone → Pi. Written with response, so a value may be up to 512 bytes whatever the MTU. */
export const RX_CHARACTERISTIC_UUID = "7c0e0002-5f3a-4c8e-9d2b-c00e7a000001";
/** Pi → phone, by notification. Values are at most MTU − 3 bytes. */
export const TX_CHARACTERISTIC_UUID = "7c0e0003-5f3a-4c8e-9d2b-c00e7a000001";
/** Read-only JSON: `{ version, serverNonce }`. See HelloInfo. */
export const INFO_CHARACTERISTIC_UUID = "7c0e0004-5f3a-4c8e-9d2b-c00e7a000001";

/** The ATT ceiling on a characteristic value, and so on a phone → Pi frame. */
export const MAX_WRITE_FRAME_BYTES = 512;

export const MessageKind = Object.freeze({
  // phone → Pi
  HELLO: 1,
  REQUEST: 2,
  SUBSCRIBE: 3,
  UNSUBSCRIBE: 4,
  // Pi → phone
  REFUSED: 16,
  WELCOME: 17,
  RESPONSE_HEAD: 18,
  RESPONSE_BODY: 19,
  RESPONSE_END: 20,
  STREAM: 21,
});

/** @typedef {{ version: number, serverNonce: string }} HelloInfo */
/** @typedef {{ version: number, clientNonce: string, proof: string }} HelloHeader */
/** @typedef {{ reason: string }} RefusedHeader */
/** @typedef {{ version: number }} WelcomeHeader */
/** @typedef {{ id: number, method: string, path: string, headers: Record<string, string> }} RequestHeader */
/** @typedef {{ id: number, status: number, headers: Record<string, string> }} ResponseHeadHeader */
/** @typedef {{ id: number }} ResponseBodyHeader */
/** @typedef {{ id: number, error?: string }} ResponseEndHeader */
/** @typedef {import("../../src/ws.ts").DashboardMessage} DashboardMessage */

/**
 * One decoded message. `header` is whatever JSON the kind carries; the per-kind typedefs
 * above are what each end narrows it to.
 * @typedef {{ kind: number, header: unknown, body: Bytes }} WireMessage
 */

// ---------------------------------------------------------------------------- frames

const FRAME_HEADER_BYTES = 2;
const FRAME_FIRST = 1;
const FRAME_LAST = 2;

/**
 * Splits one envelope into GATT-value-sized frames: `[flags][messageId][payload…]`.
 * `messageId` only has to differ from its neighbour's, so a lost LAST frame shows up as
 * the next message's FIRST instead of being glued onto it.
 * @param {Bytes} envelope
 * @param {number} messageId 0–255
 * @param {number} maxFrameBytes the largest value the link will carry
 * @returns {Bytes[]}
 */
export function splitIntoFrames(envelope, messageId, maxFrameBytes) {
  const payloadBytes = maxFrameBytes - FRAME_HEADER_BYTES;
  if (payloadBytes < 1) {
    throw new RangeError(`frame size ${maxFrameBytes} leaves no room for a payload`);
  }
  /** @type {Bytes[]} */
  const frames = [];
  for (let offset = 0; offset === 0 || offset < envelope.length; offset += payloadBytes) {
    const payload = envelope.subarray(offset, offset + payloadBytes);
    const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
    const isFirst = offset === 0;
    const isLast = offset + payloadBytes >= envelope.length;
    frame[0] = (isFirst ? FRAME_FIRST : 0) | (isLast ? FRAME_LAST : 0);
    frame[1] = messageId & 0xff;
    frame.set(payload, FRAME_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

/**
 * Glues frames back into envelopes. ATT delivers a link's writes and notifications in
 * order, so the only damage to detect is a message cut short — by a disconnect, or by a
 * notification BlueZ dropped from a full queue — which `push` reports rather than mends.
 */
export class FrameAssembler {
  /** @type {Bytes[]} */
  #parts = [];
  #partBytes = 0;
  /** @type {number | null} */
  #messageId = null;
  #maxMessageBytes;

  /** @param {number} maxMessageBytes a message larger than this is discarded, not buffered */
  constructor(maxMessageBytes) {
    this.#maxMessageBytes = maxMessageBytes;
  }

  /**
   * @param {Bytes} frame
   * @returns {{ envelope?: Bytes, problem?: string }}
   */
  push(frame) {
    if (frame.length < FRAME_HEADER_BYTES) {
      return { problem: `runt frame of ${frame.length} bytes` };
    }
    const flags = frame[0];
    const messageId = frame[1];
    const payload = frame.subarray(FRAME_HEADER_BYTES);
    /** @type {string | undefined} */
    let problem;

    if (flags & FRAME_FIRST) {
      if (this.#messageId !== null) {
        problem = `message ${this.#messageId} abandoned after ${this.#partBytes} bytes`;
      }
      this.#parts = [];
      this.#partBytes = 0;
      this.#messageId = messageId;
    } else if (this.#messageId !== messageId) {
      const expected = this.#messageId;
      this.reset();
      return { problem: `continuation of message ${messageId} while expecting ${expected ?? "a first frame"}` };
    }

    this.#partBytes += payload.length;
    if (this.#partBytes > this.#maxMessageBytes) {
      this.reset();
      return { problem: `message ${messageId} exceeds ${this.#maxMessageBytes} bytes` };
    }
    this.#parts.push(payload.slice());

    if (!(flags & FRAME_LAST)) {
      return problem === undefined ? {} : { problem };
    }
    const envelope = concatenate(this.#parts);
    this.reset();
    return problem === undefined ? { envelope } : { envelope, problem };
  }

  reset() {
    this.#parts = [];
    this.#partBytes = 0;
    this.#messageId = null;
  }
}

// -------------------------------------------------------------------------- messages

/**
 * `[kind][u32 headerLength][header JSON][body…]`.
 * @param {number} kind
 * @param {unknown} header
 * @param {Bytes} [body]
 * @returns {Bytes}
 */
export function encodeMessage(kind, header, body = new Uint8Array(0)) {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header ?? {}));
  const message = new Uint8Array(5 + headerBytes.length + body.length);
  const view = new DataView(message.buffer);
  message[0] = kind;
  view.setUint32(1, headerBytes.length);
  message.set(headerBytes, 5);
  message.set(body, 5 + headerBytes.length);
  return message;
}

/**
 * @param {Bytes} message
 * @returns {WireMessage}
 */
export function decodeMessage(message) {
  if (message.length < 5) {
    throw new RangeError(`message of ${message.length} bytes is shorter than its own header`);
  }
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const headerLength = view.getUint32(1);
  if (5 + headerLength > message.length) {
    throw new RangeError(`header claims ${headerLength} bytes, message has ${message.length - 5}`);
  }
  const headerText = new TextDecoder().decode(message.subarray(5, 5 + headerLength));
  return {
    kind: message[0],
    header: JSON.parse(headerText),
    body: message.slice(5 + headerLength),
  };
}

// ------------------------------------------------------------------------- envelopes

const ENVELOPE_CLEAR = 0;
const ENVELOPE_SEALED = 1;

/** Which way a sealed envelope travels. In the IV, so the two directions never share one. */
export const Direction = Object.freeze({ TO_PI: 1, TO_PHONE: 2 });

/**
 * Only HELLO and REFUSED travel clear: one is how a key gets agreed, the other is what a
 * phone without one is told.
 * @param {Bytes} message
 * @returns {Bytes}
 */
export function clearEnvelope(message) {
  const envelope = new Uint8Array(1 + message.length);
  envelope[0] = ENVELOPE_CLEAR;
  envelope.set(message, 1);
  return envelope;
}

/**
 * @param {Bytes} envelope
 * @returns {{ sealed: false, message: Bytes } | { sealed: true, counter: number, ciphertext: Bytes }}
 */
export function parseEnvelope(envelope) {
  if (envelope.length < 1) {
    throw new RangeError("empty envelope");
  }
  if (envelope[0] === ENVELOPE_CLEAR) {
    return { sealed: false, message: envelope.slice(1) };
  }
  if (envelope[0] !== ENVELOPE_SEALED || envelope.length < 9) {
    throw new RangeError(`envelope type ${envelope[0]} with ${envelope.length} bytes is not one this build reads`);
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const counter = view.getUint32(1) * 0x1_0000_0000 + view.getUint32(5);
  return { sealed: true, counter, ciphertext: envelope.slice(9) };
}

/**
 * Seals with AES-256-GCM over deflate-raw. Compressed first because telemetry JSON shrinks
 * several-fold and the radio is the bottleneck; GCM's tag authenticates the result.
 * @param {CryptoKey} key
 * @param {number} direction one of Direction
 * @param {number} counter strictly increasing per direction per session
 * @param {Bytes} message
 * @returns {Promise<Bytes>}
 */
export async function sealEnvelope(key, direction, counter, message) {
  const compressed = await deflate(message);
  const prefix = new Uint8Array(9);
  const view = new DataView(prefix.buffer);
  prefix[0] = ENVELOPE_SEALED;
  view.setUint32(1, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(5, counter >>> 0);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: ivFor(direction, counter), additionalData: prefix },
      key,
      compressed
    )
  );
  return concatenate([prefix, ciphertext]);
}

/**
 * @param {CryptoKey} key
 * @param {number} direction the direction the envelope was SENT in
 * @param {number} counter from parseEnvelope
 * @param {Bytes} ciphertext from parseEnvelope
 * @returns {Promise<Bytes>} rejects when the tag does not verify — wrong key, or tampering
 */
export async function openEnvelope(key, direction, counter, ciphertext) {
  const prefix = new Uint8Array(9);
  const view = new DataView(prefix.buffer);
  prefix[0] = ENVELOPE_SEALED;
  view.setUint32(1, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(5, counter >>> 0);
  const compressed = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivFor(direction, counter), additionalData: prefix },
      key,
      ciphertext
    )
  );
  return inflate(compressed);
}

/**
 * @param {number} direction
 * @param {number} counter
 * @returns {Bytes}
 */
function ivFor(direction, counter) {
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  iv[0] = direction;
  view.setUint32(4, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(8, counter >>> 0);
  return iv;
}

// ------------------------------------------------------------------------------ keys

/**
 * The proof a phone sends in HELLO, and that the Pi recomputes. Bound to the Pi's nonce,
 * so a recorded HELLO is useless once that nonce has rotated.
 * @param {string} secret
 * @param {string} serverNonce hex
 * @param {string} clientNonce hex
 * @returns {Promise<string>} hex
 */
export async function helloProof(secret, serverNonce, clientNonce) {
  return toHex(await hmac(secret, "cool-eva/hello", serverNonce, clientNonce));
}

/**
 * The session's AES key. Both nonces go in, so neither end alone picks it, and every
 * session gets a fresh key — which is what lets each counter start again at zero.
 * @param {string} secret
 * @param {string} serverNonce hex
 * @param {string} clientNonce hex
 * @returns {Promise<CryptoKey>}
 */
export async function deriveSessionKey(secret, serverNonce, clientNonce) {
  const raw = await hmac(secret, "cool-eva/session", serverNonce, clientNonce);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Compares two hex strings in time independent of where they first differ.
 * @param {string} left
 * @param {string} right
 */
export function proofsMatch(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * @param {string} secret
 * @param {string} label
 * @param {string} serverNonce
 * @param {string} clientNonce
 * @returns {Promise<Bytes>}
 */
async function hmac(secret, label, serverNonce, clientNonce) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const input = concatenate([encoder.encode(label), fromHex(serverNonce), fromHex(clientNonce)]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
}

/** @param {Bytes} bytes */
export function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} hex
 * @returns {Bytes}
 */
export function fromHex(hex) {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new RangeError(`not lower-case hex: ${hex.slice(0, 16)}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * @param {number} byteCount
 * @returns {string} hex
 */
export function randomNonce(byteCount = 16) {
  return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

// --------------------------------------------------------------------------- helpers

/**
 * @param {Bytes[]} parts
 * @returns {Bytes}
 */
export function concatenate(parts) {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * @param {Bytes} bytes
 * @returns {Promise<Bytes>}
 */
async function deflate(bytes) {
  return pipeThrough(bytes, new CompressionStream("deflate-raw"));
}

/**
 * @param {Bytes} bytes
 * @returns {Promise<Bytes>}
 */
async function inflate(bytes) {
  return pipeThrough(bytes, new DecompressionStream("deflate-raw"));
}

/**
 * @param {Bytes} bytes
 * @param {CompressionStream | DecompressionStream} transform
 * @returns {Promise<Bytes>}
 */
async function pipeThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
