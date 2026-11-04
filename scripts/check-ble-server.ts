import { randomBytes } from "crypto";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { setTimeout as delay } from "timers/promises";
import {
  Direction,
  FrameAssembler,
  MessageKind,
  PROTOCOL_VERSION,
  clearEnvelope,
  concatenate,
  decodeMessage,
  deriveSessionKey,
  encodeMessage,
  helloProof,
  openEnvelope,
  parseEnvelope,
  randomNonce,
  sealEnvelope,
  splitIntoFrames,
  type Bytes,
  type HelloInfo,
  type WireMessage,
} from "../public/lib/ble-wire.js";
import { defineSignals, record } from "../src/can/signals.ts";
import type { GattApplication, GattHandlers } from "../src/ble-server/gatt-app.ts";
import { startBleServer } from "../src/ble-server/server.ts";

// The Pi's BLE server end to end, with a stand-in radio in place of BlueZ and a real HTTP
// server on loopback behind the tunnel. No D-Bus, no Bluetooth, no bike.
//
//   node --experimental-strip-types scripts/check-ble-server.ts
//
// Run by `npm test` via scripts/run-checks.ts. docs/ble-server.md has the protocol.

const SECRET = "0123456789abcdef".repeat(4);
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  if (!condition) {
    failures.push(description);
    console.error(`  ✗ ${description}`);
  }
}

// ------------------------------------------------------------------- the stand-in radio

interface Radio {
  handlers: GattHandlers;
  delivered: Bytes[];
  stopped: boolean;
}

function standInRadio(): { radio: Radio; startGatt: (handlers: GattHandlers) => Promise<GattApplication> } {
  const radio: Radio = { handlers: null as unknown as GattHandlers, delivered: [], stopped: false };
  return {
    radio,
    startGatt: async handlers => {
      radio.handlers = handlers;
      return {
        notify: frame => radio.delivered.push(frame),
        isDeviceConnected: async () => true,
        stop: async () => {
          radio.stopped = true;
        },
      };
    },
  };
}

// ------------------------------------------------------------------------ a fake phone

class Phone {
  #radio: Radio;
  #assembler = new FrameAssembler(1_000_000);
  #readOffset = 0;
  #key: CryptoKey | null = null;
  #nextCounter = 0;
  #lastInbound = -1;
  inbox: WireMessage[] = [];
  refusals: string[] = [];

  constructor(radio: Radio) {
    this.#radio = radio;
  }

  subscribe(): void {
    this.#radio.handlers.onSubscribed(true);
  }

  async hello(secret: string): Promise<void> {
    const info = JSON.parse(new TextDecoder().decode(this.#radio.handlers.onRead())) as HelloInfo;
    const clientNonce = randomNonce();
    this.#key = await deriveSessionKey(secret, info.serverNonce, clientNonce);
    this.#nextCounter = 0;
    this.#lastInbound = -1;
    const proof = await helloProof(secret, info.serverNonce, clientNonce);
    this.#write(clearEnvelope(encodeMessage(MessageKind.HELLO, { version: PROTOCOL_VERSION, clientNonce, proof })));
  }

  async send(kind: number, header: unknown, body?: Bytes, counter?: number): Promise<void> {
    if (this.#key === null) throw new Error("no key");
    const useCounter = counter ?? this.#nextCounter++;
    this.#write(await sealEnvelope(this.#key, Direction.TO_PI, useCounter, encodeMessage(kind, header, body)));
  }

  /** Reads everything the server has notified since last time. */
  async drain(): Promise<void> {
    const frames = this.#radio.delivered.slice(this.#readOffset);
    this.#readOffset = this.#radio.delivered.length;
    for (const frame of frames) {
      const { envelope, problem } = this.#assembler.push(frame);
      if (problem) failures.push(`phone saw a frame problem: ${problem}`);
      if (!envelope) continue;
      const parsed = parseEnvelope(envelope);
      if (!parsed.sealed) {
        const message = decodeMessage(parsed.message);
        this.refusals.push((message.header as { reason: string }).reason);
        continue;
      }
      if (this.#key === null) continue;
      if (parsed.counter <= this.#lastInbound) {
        failures.push(`phone saw counter ${parsed.counter} after ${this.#lastInbound}`);
        continue;
      }
      this.#lastInbound = parsed.counter;
      const plaintext = await openEnvelope(this.#key, Direction.TO_PHONE, parsed.counter, parsed.ciphertext);
      this.inbox.push(decodeMessage(plaintext));
    }
  }

  /** Waits — on the queue's pacing, which is real time — until `until` holds. */
  async waitFor(until: () => boolean, what: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      await this.drain();
      if (until()) return true;
      await delay(20);
    }
    failures.push(`timed out waiting for ${what}`);
    console.error(`  ✗ timed out waiting for ${what}`);
    return false;
  }

  takeKind(kind: number): WireMessage[] {
    return this.inbox.filter(message => message.kind === kind);
  }

  #write(envelope: Bytes): void {
    for (const frame of splitIntoFrames(envelope, 1, 180)) {
      this.#radio.handlers.onWrite(frame, 247, "/org/bluez/hci0/dev_PHONE");
    }
  }
}

// ---------------------------------------------------------------- the server behind it

// Random, so it is as incompressible as the sealed ride log /dl serves: a compressible
// body would shrink to a few frames and never exercise the pacing or the backpressure.
const BIG_BODY_BYTES = 150_000;
const BIG_BODY = randomBytes(BIG_BODY_BYTES);

function startLoopback(): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": BIG_BODY.length });
        res.end(BIG_BODY);
        return;
      }
      res.writeHead(201, { "content-type": "application/json", "x-answer": "42" });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          gate: req.headers["x-cool-eva"] ?? null,
          host: req.headers.host,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const loopback = await startLoopback();
const port = (loopback.address() as AddressInfo).port;
const { radio, startGatt } = standInRadio();
const bleServer = await startBleServer({ secret: SECRET, httpPort: port, startGatt });

try {
  // §1 A short secret is refused at startup rather than advertised.
  {
    const outcome = await startBleServer({ secret: "short", httpPort: port, startGatt: standInRadio().startGatt }).then(
      () => "started",
      () => "refused"
    );
    expect(outcome === "refused", "§1 a 5-character secret was accepted");
  }

  // A refused attempt cannot lock the valid phone out of a fresh handshake.
  const phone = new Phone(radio);
  phone.subscribe();
  await phone.hello("synthetic wrong key");
  await phone.waitFor(() => phone.refusals.length === 1, "wrong-key refusal");
  expect(phone.refusals[0] === "wrong secret", "wrong key was not refused");
  await phone.send(MessageKind.REQUEST, { id: 99, method: "GET", path: "/x", headers: {} });
  await delay(100);
  await phone.drain();
  expect(phone.takeKind(MessageKind.RESPONSE_HEAD).length === 0, "a request was answered without an owner");
  await phone.hello(SECRET);
  await phone.waitFor(() => phone.takeKind(MessageKind.WELCOME).length === 1, "WELCOME immediately after refusal");

  // §4 A request goes through the tunnel with its method, path, gate header and body; the
  // answer comes back with status and headers; hop-by-hop headers are the tunnel's own.
  {
    await phone.send(
      MessageKind.REQUEST,
      {
        id: 1,
        method: "POST",
        path: "/vcu-write?kind=demo",
        headers: { "X-Cool-Eva": "service-write", Host: "evil.example", "Content-Length": "999999" },
      },
      new TextEncoder().encode("hello pi")
    );
    await phone.waitFor(
      () => phone.takeKind(MessageKind.RESPONSE_END).some(message => (message.header as { id: number }).id === 1),
      "§4 end of response 1"
    );
    const head = phone.takeKind(MessageKind.RESPONSE_HEAD).find(message => (message.header as { id: number }).id === 1);
    const headHeader = head?.header as { status: number; headers: Record<string, string> } | undefined;
    expect(headHeader?.status === 201, `§4 status ${headHeader?.status}`);
    expect(headHeader?.headers["x-answer"] === "42", "§4 a response header was lost");
    const bodies = phone
      .takeKind(MessageKind.RESPONSE_BODY)
      .filter(message => (message.header as { id: number }).id === 1);
    const echoed = JSON.parse(new TextDecoder().decode(concatenate(bodies.map(message => message.body))));
    expect(echoed.method === "POST", `§4 method arrived as ${echoed.method}`);
    expect(echoed.url === "/vcu-write?kind=demo", `§4 path arrived as ${echoed.url}`);
    expect(echoed.gate === "service-write", "§4 the X-Cool-Eva gate header did not reach the endpoint");
    expect(echoed.body === "hello pi", `§4 body arrived as ${JSON.stringify(echoed.body)}`);
    expect(echoed.host !== "evil.example", "§4 the phone was allowed to set Host");
  }

  // §5 A large body arrives whole and in order, through the paced, backpressured queue.
  {
    await phone.send(MessageKind.REQUEST, { id: 2, method: "GET", path: "/big", headers: {} });
    await phone.waitFor(
      () => phone.takeKind(MessageKind.RESPONSE_END).some(message => (message.header as { id: number }).id === 2),
      "§5 end of the large response",
      30_000
    );
    const body = concatenate(
      phone
        .takeKind(MessageKind.RESPONSE_BODY)
        .filter(message => (message.header as { id: number }).id === 2)
        .map(message => message.body)
    );
    expect(body.length === BIG_BODY_BYTES, `§5 large body arrived as ${body.length} bytes`);
    expect(
      body.every((byte, index) => byte === BIG_BODY[index]),
      "§5 large body was corrupted or reordered"
    );
  }

  // §6 A replayed envelope is dropped, not executed twice.
  {
    const answeredBefore = phone.takeKind(MessageKind.RESPONSE_END).length;
    await phone.send(MessageKind.REQUEST, { id: 3, method: "GET", path: "/replayed", headers: {} }, undefined, 0);
    await delay(300);
    await phone.drain();
    expect(phone.takeKind(MessageKind.RESPONSE_END).length === answeredBefore, "§6 a replayed counter was answered");
  }

  // §7 SUBSCRIBE gets a snapshot at once and coalesced patches after; UNSUBSCRIBE stops them.
  {
    defineSignals([{ key: "ble_check_signal", unit: "", group: "check", source: "stream" }]);
    await phone.send(MessageKind.SUBSCRIBE, {});
    await phone.waitFor(() => phone.takeKind(MessageKind.STREAM).length >= 1, "§7 the first snapshot");
    const first = phone.takeKind(MessageKind.STREAM)[0].header as { type: string };
    expect(first.type === "snapshot", `§7 the first stream message was a ${first.type}`);
    for (let value = 1; value <= 10; value++) {
      record("ble_check_signal", value);
      await delay(5);
    }
    await phone.waitFor(
      () =>
        phone
          .takeKind(MessageKind.STREAM)
          .some(
            message =>
              (message.header as { signals: Record<string, { value: number }> }).signals.ble_check_signal?.value === 10
          ),
      "§7 a patch carrying the last value"
    );
    const patches = phone
      .takeKind(MessageKind.STREAM)
      .filter(message => (message.header as { type: string }).type === "patch");
    expect(patches.length < 10, `§7 ten changes inside a window produced ${patches.length} patches`);

    await phone.send(MessageKind.UNSUBSCRIBE, {});
    await delay(200);
    await phone.drain();
    const countAfterUnsubscribe = phone.takeKind(MessageKind.STREAM).length;
    record("ble_check_signal", 11);
    await delay(300);
    await phone.drain();
    expect(phone.takeKind(MessageKind.STREAM).length === countAfterUnsubscribe, "§7 a patch arrived after UNSUBSCRIBE");
  }

  // TX cleanup also discards refusals, even though no drain timer remains.
  radio.handlers.onSubscribed(false);
  await phone.send(MessageKind.REQUEST, { id: 4, method: "GET", path: "/after-end", headers: {} });
  await delay(100);
  expect(bleServer.stats().owner === null, "unsubscribe retained the owner");
  expect(bleServer.stats().queuedBytes === 0, "unsubscribe retained outbound frames");
} finally {
  await bleServer.stop();
  loopback.close();
}

if (failures.length > 0) {
  console.error(`check-ble-server: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("check-ble-server: all checks passed");
// The paced queue's interval and the signal store keep nothing alive after stop(), but a
// regression there would hang `npm test` until its timeout instead of failing — be loud.
process.exit(0);
