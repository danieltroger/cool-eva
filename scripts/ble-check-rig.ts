import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { monotonicNow, since } from "../src/monotonic.ts";
import { startBleServer, type BleServer } from "../src/ble-server/server.ts";
import type { GattApplication, GattHandlers } from "../src/ble-server/gatt-app.ts";
import type { BleSession } from "../src/ble-server/session.ts";
import { createBleLink } from "../public/lib/ble-link.js";
import type { BleCharacteristic, BleDevice, BleEnvironment } from "../public/lib/ble-state.js";
import {
  MessageKind,
  PROTOCOL_VERSION,
  clearEnvelope,
  encodeMessage,
  decodeMessage,
  parseEnvelope,
  helloProof,
  randomNonce,
  deriveSessionKey,
  splitIntoFrames,
  type Bytes,
  type HelloInfo,
  type HelloHeader,
} from "../public/lib/ble-wire.js";
import { bleClock } from "./ble-check-clock.ts";

export async function createRig(options: RigOptions = {}) {
  const clock = bleClock();
  const stored = new Map([["cool-eva.ble-secret", KEY]]);
  const calls: string[] = [];
  const responses: ServerResponse[] = [];
  const bigBody = randomBytes(48_000);
  const loopback = createServer((request, response) => reply(request, response, calls, responses, bigBody));
  await new Promise<void>(resolve => loopback.listen(0, "127.0.0.1", resolve));
  const listeners = new Set<() => void>();
  let handlers: GattHandlers;
  let server: BleServer;
  let subscribed = false;
  let info: HelloInfo | null = null;
  let hello: HelloHeader | null = null;
  const frames: Bytes[] = [];
  const notifications: Bytes[] = [];
  const writes: Bytes[] = [];
  const reads: string[] = [];
  const mtu = options.mtu ?? 185;
  let connectedRead = async (_device: string) => true;
  let holdWrite = false;
  let neverWrite: (() => void) | null = null;
  let writeHook: ((frame: Bytes) => void) | null = null;
  const transmit = new Characteristic(
    async () => new DataView(new ArrayBuffer(0)),
    async () => undefined,
    async () => {
      subscribed = true;
      handlers.onSubscribed(true);
    }
  );
  const receive = new Characteristic(
    async () => new DataView(new ArrayBuffer(0)),
    async frame => {
      writes.push(frame);
      if (holdWrite) {
        holdWrite = false;
        await new Promise<void>(resolve => {
          neverWrite = resolve;
        });
      }
      if (frame[0] === 3 && frame[2] === 0) {
        const parsed = parseEnvelope(frame.subarray(2));
        if (!parsed.sealed) {
          hello = decodeMessage(parsed.message).header as HelloHeader;
        }
      }
      handlers.onWrite(frame, mtu, PHONE);
      writeHook?.(frame);
    },
    async () => undefined
  );
  const information = new Characteristic(
    async () => {
      const bytes = handlers.onRead();
      info = JSON.parse(new TextDecoder().decode(bytes)) as HelloInfo;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    async () => undefined,
    async () => undefined
  );
  const device: BleDevice = {
    name: "",
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    gatt: {
      connected: true,
      connect: async () => device.gatt!,
      disconnect: () => {
        for (const listener of listeners) {
          listener();
        }
      },
      getPrimaryService: async () => ({
        getCharacteristic: async uuid => {
          if (uuid.includes("0002-")) return receive;
          if (uuid.includes("0003-")) return transmit;
          return information;
        },
      }),
    },
  };
  const app: GattApplication = {
    notify: frame => {
      frames.push(frame);
      if (!subscribed) return;
      const limit = Math.min(mtu - (options.multiple === false ? 3 : 5), 512);
      const delivered = frame.slice(0, limit);
      if (options.holdNotifications) {
        notifications.push(delivered);
      } else {
        transmit.deliver(delivered);
      }
    },
    isDeviceConnected: async path => {
      reads.push(path);
      return connectedRead(path);
    },
    stop: async () => {
      /* The radio remains connected when the service alone restarts. */ subscribed = false;
    },
  };
  const environment: Partial<BleEnvironment> = {
    ...clock,
    url: new URL("https://danieltroger.github.io/cool-eva/"),
    bluetooth: () => ({ requestDevice: async () => device }),
    secure: () => true,
    shell: () => undefined,
    storage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
      removeItem: key => {
        stored.delete(key);
      },
    },
  };
  const client = createBleLink(environment);
  const start = async () =>
    startBleServer({
      secret: KEY,
      httpPort: (loopback.address() as AddressInfo).port,
      now: clock.now,
      timers: clock,
      session: options.session,
      startGatt: async given => {
        handlers = given;
        return app;
      },
    });
  server = await start();
  return {
    client,
    clock,
    environment,
    device,
    stored,
    calls,
    responses,
    frames,
    writes,
    reads,
    bigBody,
    get server() {
      return server;
    },
    get handlers() {
      return handlers;
    },
    get hello() {
      return hello;
    },
    get info() {
      return info;
    },
    subscribe: () => {
      subscribed = true;
      handlers.onSubscribed(true);
    },
    write: (frame: Bytes, path = PHONE, peerMtu = mtu) => handlers.onWrite(frame, peerMtu, path),
    notify: (frame: Bytes) => app.notify(frame),
    lookup: (read: (device: string) => Promise<boolean>) => {
      connectedRead = read;
    },
    hook: (hook: ((frame: Bytes) => void) | null) => {
      writeHook = hook;
    },
    stallNextWrite: () => {
      holdWrite = true;
    },
    releaseWrite: () => {
      neverWrite?.();
    },
    flush: () => {
      for (const frame of notifications.splice(0)) {
        transmit.deliver(frame);
      }
    },
    restart: async () => {
      await server.stop();
      server = await start();
    },
    close: async () => {
      device.gatt?.disconnect();
      neverWrite?.();
      await server.stop();
      for (const response of responses) {
        response.destroy();
      }
      loopback.closeAllConnections();
      await new Promise<void>(resolve => loopback.close(() => resolve()));
    },
  };
}
export type Rig = Awaited<ReturnType<typeof createRig>>;
interface RigOptions {
  mtu?: number;
  multiple?: boolean;
  session?: BleSession;
  holdNotifications?: boolean;
}
export const KEY = "0123456789abcdef".repeat(4);
export const PHONE = "/org/bluez/hci0/dev_PHONE";
export const OTHER = "/org/bluez/hci0/dev_OTHER";

export async function helloFrame(rig: Rig, secret = KEY, nonce = randomNonce(), flags = 3): Promise<Bytes> {
  const info = JSON.parse(new TextDecoder().decode(rig.handlers.onRead())) as HelloInfo;
  const proof = await helloProof(secret, info.serverNonce, nonce);
  const frame = splitIntoFrames(
    clearEnvelope(encodeMessage(MessageKind.HELLO, { version: PROTOCOL_VERSION, clientNonce: nonce, proof })),
    77,
    512
  )[0];
  frame[0] = flags;
  return frame;
}
export async function capturedKey(rig: Rig): Promise<CryptoKey> {
  if (!rig.info || !rig.hello) {
    throw new Error("no captured handshake");
  }
  return deriveSessionKey(KEY, rig.info.serverNonce, rig.hello.clientNonce);
}
export async function until(predicate: () => boolean, description: string, timeout = 3_000): Promise<void> {
  const started = monotonicNow();
  while (!predicate()) {
    if (since(started) > timeout) {
      throw new Error(`timed out: ${description}`);
    }
    await delay(10);
  }
}
export async function settle(): Promise<void> {
  await delay(60);
}
export async function within<Result>(promise: Promise<Result>, description: string, timeout = 3_000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${description}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class Characteristic extends EventTarget implements BleCharacteristic {
  value: DataView | undefined;
  constructor(read: () => Promise<DataView>, write: (frame: Bytes) => Promise<void>, subscribe: () => Promise<void>) {
    super();
    this.readValue = read;
    this.writeValueWithResponse = write;
    this.subscribe = subscribe;
  }
  readValue: () => Promise<DataView>;
  writeValueWithResponse: (frame: Bytes) => Promise<void>;
  subscribe: () => Promise<void>;
  async startNotifications(): Promise<this> {
    await this.subscribe();
    return this;
  }
  deliver(frame: Bytes): void {
    this.value = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}
function reply(
  request: IncomingMessage,
  response: ServerResponse,
  calls: string[],
  responses: ServerResponse[],
  bigBody: Buffer
): void {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    calls.push(request.url ?? "");
    if (request.url === "/held") {
      responses.push(response);
      return;
    }
    if (request.url === "/big") {
      response.writeHead(200, { "content-length": bigBody.length });
      response.end(bigBody);
      return;
    }
    response.writeHead(201, { "content-type": "text/plain" });
    response.end(Buffer.concat(chunks).length ? Buffer.concat(chunks) : "synthetic reply");
  });
}
