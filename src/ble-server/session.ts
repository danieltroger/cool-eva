import {
  Direction,
  MessageKind,
  PROTOCOL_VERSION,
  clearEnvelope,
  decodeMessage,
  deriveSessionKey,
  encodeMessage,
  helloProof,
  openEnvelope,
  parseEnvelope,
  proofsMatch,
  randomNonce,
  sealEnvelope,
  type Bytes,
  type HelloHeader,
  type HelloInfo,
  type WireMessage,
} from "../../public/lib/ble-wire.js";

// Who the Pi is talking to over BLE, and the keys that prove it. One session at a time:
// BlueZ fans a notification out to every subscribed device, so "per device" would be a
// fiction on the send side — the session key is what actually separates the phone that
// knows the secret from anything else in range. docs/ble-server.md §"Why seal".

/**
 * Failed HELLOs inside this window are refused without being checked. The secret is
 * typed by a person, so it may be short; this is what keeps it from being guessed at
 * radio speed.
 */
export const HELLO_FAILURE_COOLDOWN_MS = 2_000;

export interface ReceiveResult {
  /** Messages that opened under the current session, in order. */
  messages: WireMessage[];
  /** Envelopes to send straight back: WELCOME after a good HELLO, REFUSED after a bad one. */
  replies: Bytes[];
  /** Something worth a journal line. Never a reason to stop the server. */
  problem?: string;
  /** A HELLO just replaced whatever session there was. */
  startedSession?: true;
}

interface ActiveSession {
  key: CryptoKey;
  /** The highest counter accepted from the phone. Anything at or below it is a replay. */
  lastInboundCounter: number;
  nextOutboundCounter: number;
}

export class BleSession {
  #secret: string;
  #serverNonce = randomNonce();
  #active: ActiveSession | null = null;
  #lastHelloFailureMs = Number.NEGATIVE_INFINITY;
  #generation = 0;

  constructor(secret: string) {
    this.#secret = secret;
  }

  get authenticated(): boolean {
    return this.#active !== null;
  }

  /** Bumped by every new session and every end(), so work begun under one can tell it is stale. */
  get generation(): number {
    return this.#generation;
  }

  info(): HelloInfo {
    return { version: PROTOCOL_VERSION, serverNonce: this.#serverNonce };
  }

  end(): void {
    this.#active = null;
    this.#generation++;
  }

  /** @param nowMs monotonicNow(), passed in so a check can drive the cooldown */
  async receive(envelope: Bytes, nowMs: number): Promise<ReceiveResult> {
    let parsed: ReturnType<typeof parseEnvelope>;
    try {
      parsed = parseEnvelope(envelope);
    } catch (error) {
      return { messages: [], replies: [], problem: `unreadable envelope: ${(error as Error).message}` };
    }

    if (!parsed.sealed) {
      return this.#receiveHello(parsed.message, nowMs);
    }
    const active = this.#active;
    if (active === null) {
      return {
        messages: [],
        replies: [refusal("no session — send HELLO first")],
        problem: "sealed envelope with no session",
      };
    }
    if (parsed.counter <= active.lastInboundCounter) {
      return { messages: [], replies: [], problem: `replayed or reordered counter ${parsed.counter}` };
    }
    let plaintext: Bytes;
    try {
      plaintext = await openEnvelope(active.key, Direction.TO_PI, parsed.counter, parsed.ciphertext);
    } catch (error) {
      return { messages: [], replies: [], problem: `envelope did not open: ${(error as Error).message}` };
    }
    active.lastInboundCounter = parsed.counter;
    try {
      return { messages: [decodeMessage(plaintext)], replies: [] };
    } catch (error) {
      return { messages: [], replies: [], problem: `undecodable message: ${(error as Error).message}` };
    }
  }

  /** Seals a message for the phone; null when there is no session to seal it under. */
  async seal(kind: number, header: unknown, body?: Bytes): Promise<Bytes | null> {
    const active = this.#active;
    if (active === null) return null;
    const counter = active.nextOutboundCounter++;
    return sealEnvelope(active.key, Direction.TO_PHONE, counter, encodeMessage(kind, header, body));
  }

  async #receiveHello(message: Bytes, nowMs: number): Promise<ReceiveResult> {
    if (nowMs - this.#lastHelloFailureMs < HELLO_FAILURE_COOLDOWN_MS) {
      return { messages: [], replies: [refusal("too soon after a failed attempt")], problem: "HELLO inside cooldown" };
    }
    let hello: HelloHeader;
    try {
      const decoded = decodeMessage(message);
      if (decoded.kind !== MessageKind.HELLO) {
        return {
          messages: [],
          replies: [refusal("only HELLO may be sent clear")],
          problem: `clear kind ${decoded.kind}`,
        };
      }
      hello = decoded.header as HelloHeader;
    } catch (error) {
      return { messages: [], replies: [], problem: `undecodable HELLO: ${(error as Error).message}` };
    }
    if (hello.version !== PROTOCOL_VERSION) {
      return {
        messages: [],
        replies: [refusal(`protocol ${hello.version} unsupported; this Pi speaks ${PROTOCOL_VERSION}`)],
        problem: `HELLO with protocol ${hello.version}`,
      };
    }

    let expectedProof: string;
    try {
      expectedProof = await helloProof(this.#secret, this.#serverNonce, hello.clientNonce);
    } catch (error) {
      return {
        messages: [],
        replies: [refusal("malformed nonce")],
        problem: `HELLO nonce: ${(error as Error).message}`,
      };
    }
    if (typeof hello.proof !== "string" || !proofsMatch(hello.proof, expectedProof)) {
      this.#lastHelloFailureMs = nowMs;
      return { messages: [], replies: [refusal("wrong secret")], problem: "HELLO with a wrong secret" };
    }

    const key = await deriveSessionKey(this.#secret, this.#serverNonce, hello.clientNonce);
    // Rotated only on success: rotating on failure would let anyone in range knock the
    // real phone's HELLO off its nonce just by sending garbage first.
    this.#serverNonce = randomNonce();
    this.#active = { key, lastInboundCounter: -1, nextOutboundCounter: 0 };
    this.#generation++;
    const welcome = await this.seal(MessageKind.WELCOME, { version: PROTOCOL_VERSION });
    return { messages: [], replies: welcome === null ? [] : [welcome], startedSession: true };
  }
}

function refusal(reason: string): Bytes {
  return clearEnvelope(encodeMessage(MessageKind.REFUSED, { reason }));
}
