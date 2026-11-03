import {
  FrameAssembler,
  type Bytes,
  MessageKind,
  type DashboardMessage,
  type RequestHeader,
} from "../../public/lib/ble-wire.js";
import { validBleSecret } from "../../public/lib/ble-secret.js";
import { setTimeout as delay } from "timers/promises";
import { monotonicNow } from "../monotonic.ts";
import { startGattApplication, type GattApplication, type GattHandlers } from "./gatt-app.ts";
import { Admission } from "./admission.ts";
import type { DeadlineTimers } from "./dbus-link.ts";
import { OutboundQueue, DEFAULT_ATT_MTU } from "./outbound.ts";
import { Owner } from "./owner.ts";
import { Rejections } from "./rejections.ts";
import { BleSession, refused, type ReceiveResult } from "./session.ts";
import { startTelemetryStream, type TelemetryStream } from "./stream.ts";
import { MAX_REQUEST_BODY_BYTES, forwardRequest } from "./tunnel.ts";

export async function startBleServer(options: BleServerOptions): Promise<BleServer> {
  if (!validBleSecret(options.secret)) {
    throw new Error("BLE_SECRET must be a generated 64-character lowercase-hex key (openssl rand -hex 32)");
  }
  let app: GattApplication | null = null;
  const context: ServerContext = {
    options,
    session: options.session ?? new BleSession(options.secret),
    owner: new Owner(options.timers),
    outbound: new OutboundQueue({ send: frame => app?.notify(frame) }),
    assembler: new FrameAssembler(MAX_INBOUND_MESSAGE_BYTES),
    inbound: new Admission(),
    hellos: new Admission(),
    rejections: new Rejections(options.timers, options.now),
    stream: null,
    requestsInFlight: 0,
    pendingSeals: 0,
    subscribed: false,
    stopped: false,
    inboundChain: Promise.resolve(),
    outboundChain: Promise.resolve(),
    app: null,
  };
  app = await (options.startGatt ?? startGattApplication)({
    onRead: () => new TextEncoder().encode(JSON.stringify(context.session.info())),
    onWrite: (frame, mtu, device) => receiveFrame(context, frame, mtu, device),
    onSubscribed: subscribed => {
      context.subscribed = subscribed;
      if (subscribed) {
        context.outbound.start();
      } else {
        endSession(context, "TX unsubscribed");
        context.outbound.stop();
      }
    },
    onDeviceDisconnected: device => {
      if (context.owner.device === device) {
        endSession(context, "owner disconnected");
      }
    },
    onReset: reason => endSession(context, reason),
  });
  context.app = app;
  return {
    stop: async () => {
      context.stopped = true;
      endSession(context, "service stopping");
      context.outbound.stop();
      context.rejections.flush();
      await app?.stop();
    },
    stats: () => ({
      inbound: context.inbound.count,
      inboundBytes: context.inbound.bytes,
      hellos: context.hellos.count,
      seals: context.pendingSeals,
      queuedBytes: context.outbound.bufferedBytes,
      owner: context.owner.device,
    }),
  };
}

export interface BleServerOptions {
  secret: string;
  httpPort: number;
  startGatt?: (handlers: GattHandlers) => Promise<GattApplication>;
  now?: () => number;
  /** Check clock for owner deadlines and rejection-summary flushes; native timers by default. */
  timers?: DeadlineTimers;
  /** Allows checks to stall or fail session work without a radio or unbounded heap assertions. */
  session?: BleSession;
}
export interface BleServer {
  stop: () => Promise<void>;
  stats: () => {
    inbound: number;
    inboundBytes: number;
    hellos: number;
    seals: number;
    queuedBytes: number;
    owner: string | null;
  };
}
interface ServerContext {
  options: BleServerOptions;
  session: BleSession;
  owner: Owner;
  outbound: OutboundQueue;
  assembler: FrameAssembler;
  inbound: Admission;
  hellos: Admission;
  rejections: Rejections;
  stream: TelemetryStream | null;
  requestsInFlight: number;
  pendingSeals: number;
  subscribed: boolean;
  stopped: boolean;
  // Both chains exist for ordering authenticated counters; see docs/ble-server.md §"Key and protocol".
  inboundChain: Promise<void>;
  outboundChain: Promise<void>;
  app: GattApplication | null;
}

// A request includes a small header as well as the tunnel's capped upload body.
const MAX_INBOUND_MESSAGE_BYTES = MAX_REQUEST_BODY_BYTES + 4 * 1024;
// Each concurrent request holds a loopback socket; six covers the dashboard's opening burst.
const MAX_REQUESTS_IN_FLIGHT = 6;
// Awaiting the radio above this backlog keeps a download out of the Pi's heap.
const RESPONSE_HIGH_WATER_BYTES = 32 * 1024;
// The paced queue drains on ticks; polling must yield to its timer without busy-waiting.
const DRAIN_POLL_MS = 25;

function receiveFrame(context: ServerContext, frame: Bytes, mtu: number | undefined, device: string | undefined): void {
  if (context.stopped) return;
  if (!device || frame.length < 2 || frame.length > 512) {
    reject(context, "invalid frame or missing device");
    return;
  }
  const complete = frame[0] === 3;
  if (complete && frame[2] === 0) {
    if (!context.hellos.take(frame.length)) {
      reject(context, "HELLO admission full");
      return;
    }
    // A complete HELLO needs no assembler. Its crypto/liveness work cannot stall owner RX.
    void receiveHello(context, frame.subarray(2), device, mtu)
      .catch(error => console.warn(`ble-server: HELLO failed (device ${device})`, error))
      .finally(() => context.hellos.release(frame.length));
    return;
  }
  if (context.owner.device !== device) {
    reject(context, "only a complete HELLO may precede authentication");
    return;
  }
  const { envelope, problem } = context.assembler.push(frame);
  if (problem) {
    reject(context, problem);
  }
  if (!envelope) return;
  if (!context.inbound.take(envelope.length)) {
    reject(context, "owner admission full");
    return;
  }
  const epoch = context.owner.epoch;
  context.inboundChain = context.inboundChain
    .then(async () => {
      if (context.stopped || context.owner.epoch !== epoch) return;
      const result = await context.session.receive(envelope, () => !context.stopped && context.owner.epoch === epoch);
      if (context.owner.epoch !== epoch || context.stopped) return;
      report(context, result);
      for (const message of result.messages) {
        dispatch(context, message.kind, message.header, message.body);
      }
    })
    .catch(error => console.warn(`ble-server: inbound message failed (owner ${device}, epoch ${epoch})`, error))
    .finally(() => context.inbound.release(envelope.length));
}

async function receiveHello(
  context: ServerContext,
  envelope: Bytes,
  device: string,
  mtu: number | undefined
): Promise<void> {
  let epoch = context.owner.epoch;
  let result = await context.session.verifyHello(envelope);
  if (context.stopped || context.owner.epoch !== epoch) return;
  if (!result.hello) {
    report(context, result);
    return;
  }
  // A keyless writer must never initiate a read whose failure can release the rider.
  if (context.owner.device !== null && context.owner.device !== device) {
    const connected = await context.owner.connected(owner => {
      if (!context.app) {
        throw new Error("GATT application unavailable");
      }
      return context.app.isDeviceConnected(owner);
    });
    if (context.stopped || context.owner.epoch !== epoch) return;
    if (connected !== false) {
      report(context, refused(result.hello.clientNonce, "another phone is connected"));
      return;
    }
    endSession(context, "previous owner is no longer connected");
    epoch = context.owner.epoch;
    result = await context.session.verifyHello(envelope);
    if (!result.hello || context.stopped || context.owner.epoch !== epoch) return;
  }
  const committed = await context.session.commitHello(
    result.hello,
    () => !context.stopped && context.owner.epoch === epoch
  );
  if (!committed.startedSession) {
    report(context, committed);
    return;
  }
  stopStream(context);
  context.outbound.clear();
  context.assembler.reset();
  context.owner.claim(device);
  context.outbound.mtu = DEFAULT_ATT_MTU;
  if (mtu !== undefined) {
    context.outbound.mtu = mtu;
  }
  for (const welcome of committed.replies) {
    if (context.subscribed && !context.outbound.enqueue(welcome)) {
      endSession(context, "WELCOME output overflow");
    }
  }
  console.log("ble-server: phone authenticated, session started");
}

function report(context: ServerContext, result: ReceiveResult): void {
  if (result.problem) {
    reject(context, result.problem);
  }
  if (!context.subscribed) return;
  for (const reply of result.replies) {
    if (context.rejections.allowRefusal(now(context))) {
      context.outbound.enqueue(reply, DEFAULT_ATT_MTU);
    }
  }
}
function reject(context: ServerContext, reason: string): void {
  context.rejections.problem(reason, now(context));
}
function now(context: ServerContext): number {
  return (context.options.now ?? monotonicNow)();
}

function dispatch(context: ServerContext, kind: number, header: unknown, body: Bytes): void {
  if (kind === MessageKind.REQUEST) {
    startRequest(context, header as RequestHeader, body);
    return;
  }
  if (kind === MessageKind.SUBSCRIBE) {
    if (context.stream !== null) return;
    context.stream = startTelemetryStream({
      send: message => {
        void sendSealed(context, MessageKind.STREAM, message satisfies DashboardMessage);
      },
      bufferedBytes: () => context.outbound.bufferedBytes,
    });
  } else if (kind === MessageKind.UNSUBSCRIBE) {
    stopStream(context);
  } else {
    reject(context, `unknown message kind ${kind}`);
  }
}
function startRequest(context: ServerContext, header: RequestHeader, body: Bytes): void {
  const id = header.id;
  const generation = context.session.generation;
  if (context.requestsInFlight >= MAX_REQUESTS_IN_FLIGHT) {
    void sendSealed(context, MessageKind.RESPONSE_HEAD, { id, status: 503, headers: {} });
    void sendSealed(context, MessageKind.RESPONSE_END, {
      id,
      error: `${MAX_REQUESTS_IN_FLIGHT} requests already in flight`,
    });
    return;
  }
  context.requestsInFlight++;
  void forwardRequest(context.options.httpPort, header, body, {
    head: async (status, headers) => {
      await sendSealed(context, MessageKind.RESPONSE_HEAD, { id, status, headers }, undefined, generation);
    },
    body: async chunk => {
      await waitForRoom(context, generation);
      await sendSealed(context, MessageKind.RESPONSE_BODY, { id }, chunk, generation);
    },
    end: async error => {
      await sendSealed(
        context,
        MessageKind.RESPONSE_END,
        error === undefined ? { id } : { id, error },
        undefined,
        generation
      );
    },
  })
    .catch(error => console.warn(`ble-server: tunnel failed (request ${id}, generation ${generation})`, error))
    .finally(() => {
      context.requestsInFlight--;
    });
}
async function waitForRoom(context: ServerContext, generation: number): Promise<void> {
  // This backpressures the loopback socket; see docs/ble-server.md §"Pacing".
  while (context.outbound.bufferedBytes > RESPONSE_HIGH_WATER_BYTES) {
    if (context.session.generation !== generation) {
      throw new Error("session ended");
    }
    await delay(DRAIN_POLL_MS);
  }
  if (context.session.generation !== generation) {
    throw new Error("session ended");
  }
}
function sendSealed(
  context: ServerContext,
  kind: number,
  header: unknown,
  body?: Bytes,
  generation = context.session.generation
): Promise<void> {
  if (context.stopped || context.session.generation !== generation || !context.subscribed) return Promise.resolve();
  if (context.pendingSeals >= 32) {
    reject(context, "pending seal overflow");
    endSession(context, "pending seal overflow");
    return Promise.resolve();
  }
  context.pendingSeals++;
  const work = context.outboundChain
    .then(async () => {
      if (context.stopped || context.session.generation !== generation) return;
      const envelope = await context.session.seal(kind, header, body);
      if (!envelope || context.stopped || context.session.generation !== generation) return;
      if (!context.outbound.enqueue(envelope)) {
        reject(context, "output overflow");
        endSession(context, "output overflow");
      }
    })
    .catch(error => console.warn(`ble-server: seal failed (kind ${kind}, generation ${generation})`, error))
    .finally(() => {
      context.pendingSeals--;
    });
  context.outboundChain = work;
  return work;
}
function stopStream(context: ServerContext): void {
  context.stream?.stop();
  context.stream = null;
}
function endSession(context: ServerContext, reason: string): void {
  const hadOwner = context.owner.device !== null;
  stopStream(context);
  context.owner.clear();
  context.session.end();
  context.outbound.clear();
  context.assembler.reset();
  context.inboundChain = Promise.resolve();
  context.outboundChain = Promise.resolve();
  if (hadOwner) {
    console.log(`ble-server: session ended (${reason})`);
  }
}
