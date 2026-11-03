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

export class BleSession {
  #secret: string;
  #serverNonce = randomNonce();
  #active: ActiveSession | null = null;
  #generation = 0;

  constructor(secret: string) {
    this.#secret = secret;
  }
  get authenticated(): boolean {
    return this.#active !== null;
  }
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

  /** Verification must not mutate the rider's session or initiate a D-Bus liveness read. */
  async verifyHello(envelope: Bytes): Promise<HelloResult> {
    let header: HelloHeader;
    try {
      const parsed = parseEnvelope(envelope);
      if (parsed.sealed) return problem("sealed envelope without an owner");
      const message = decodeMessage(parsed.message);
      if (message.kind !== MessageKind.HELLO) return problem("only HELLO may be sent clear");
      if (typeof message.header !== "object" || message.header === null) return problem("malformed HELLO header");
      header = message.header as HelloHeader;
    } catch (error) {
      return problem(`unreadable HELLO: ${(error as Error).message}`);
    }
    if (typeof header.clientNonce !== "string" || !/^[0-9a-f]{32}$/.test(header.clientNonce)) {
      return problem("HELLO requires a 16-byte lowercase-hex nonce");
    }
    if (header.version !== PROTOCOL_VERSION) {
      return refused(header.clientNonce, `protocol unsupported; this Pi speaks ${PROTOCOL_VERSION}`);
    }
    const serverNonce = this.#serverNonce;
    const generation = this.#generation;
    const expected = await helloProof(this.#secret, serverNonce, header.clientNonce);
    if (typeof header.proof !== "string" || !proofsMatch(header.proof, expected)) {
      return refused(header.clientNonce, "wrong secret");
    }
    return { messages: [], replies: [], hello: { clientNonce: header.clientNonce, serverNonce, generation } };
  }

  async commitHello(hello: VerifiedHello, current: () => boolean = () => true): Promise<ReceiveResult> {
    if (!this.#currentHello(hello, current)) return problem("stale HELLO");
    const key = await deriveSessionKey(this.#secret, hello.serverNonce, hello.clientNonce);
    const welcome = await sealEnvelope(
      key,
      Direction.TO_PHONE,
      0,
      encodeMessage(MessageKind.WELCOME, { version: PROTOCOL_VERSION })
    );
    if (!this.#currentHello(hello, current)) return problem("stale HELLO");
    this.#active = { key, lastInboundCounter: -1, nextOutboundCounter: 1 };
    // A stranger could invalidate an in-flight proof if failures rotated it; docs/ble-server.md §"Why seal".
    this.#serverNonce = randomNonce();
    this.#generation++;
    return { messages: [], replies: [welcome], startedSession: true };
  }

  async receive(envelope: Bytes, current: () => boolean = () => true): Promise<ReceiveResult> {
    let parsed: ReturnType<typeof parseEnvelope>;
    try {
      parsed = parseEnvelope(envelope);
    } catch (error) {
      return problem(`unreadable envelope: ${(error as Error).message}`);
    }
    if (!parsed.sealed) {
      return problem("HELLO requires the server's complete-frame authentication path");
    }
    const active = this.#active;
    if (active === null) return problem("sealed envelope with no session");
    if (parsed.counter <= active.lastInboundCounter) return problem("replayed or reordered counter");
    try {
      const plaintext = await openEnvelope(active.key, Direction.TO_PI, parsed.counter, parsed.ciphertext);
      if (!current() || this.#active !== active) return problem("stale encrypted message");
      active.lastInboundCounter = parsed.counter;
      return { messages: [decodeMessage(plaintext)], replies: [] };
    } catch (error) {
      return problem(`envelope did not open: ${(error as Error).message}`);
    }
  }

  async seal(kind: number, header: unknown, body?: Bytes): Promise<Bytes | null> {
    const active = this.#active;
    if (active === null) return null;
    return sealEnvelope(
      active.key,
      Direction.TO_PHONE,
      active.nextOutboundCounter++,
      encodeMessage(kind, header, body)
    );
  }

  #currentHello(hello: VerifiedHello, current: () => boolean): boolean {
    return current() && hello.generation === this.#generation && hello.serverNonce === this.#serverNonce;
  }
}

export interface ReceiveResult {
  messages: WireMessage[];
  replies: Bytes[];
  problem?: string;
  startedSession?: true;
}
export interface VerifiedHello {
  clientNonce: string;
  serverNonce: string;
  generation: number;
}
export interface HelloResult extends ReceiveResult {
  hello?: VerifiedHello;
}
interface ActiveSession {
  key: CryptoKey;
  lastInboundCounter: number;
  nextOutboundCounter: number;
}

export function refused(clientNonce: string, reason: string): ReceiveResult {
  return {
    messages: [],
    replies: [clearEnvelope(encodeMessage(MessageKind.REFUSED, { reason, clientNonce }))],
    problem: reason,
  };
}
function problem(reason: string): ReceiveResult {
  return { messages: [], replies: [], problem: reason };
}
