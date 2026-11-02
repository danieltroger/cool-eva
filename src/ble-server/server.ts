import {
  FrameAssembler,
  MessageKind,
  type Bytes,
  type DashboardMessage,
  type RequestHeader,
} from "../../public/lib/ble-wire.js";
import { setTimeout as delay } from "timers/promises";
import { monotonicNow } from "../monotonic.ts";
import { startGattApplication, type GattApplication, type GattHandlers } from "./gatt-app.ts";
import { OutboundQueue } from "./outbound.ts";
import { BleSession } from "./session.ts";
import { startTelemetryStream, type TelemetryStream } from "./stream.ts";
import { MAX_REQUEST_BODY_BYTES, forwardRequest } from "./tunnel.ts";

// The BLE face of the service: the dashboard, over GATT, for a phone that shares no
// network with the Pi. Wires the layers together — gatt-app.ts (BlueZ), session.ts
// (who may talk), tunnel.ts (what they may ask), stream.ts (live telemetry) — and owns
// the two orderings they depend on. docs/ble-server.md.

/** The secret is typed into a phone once; below this it is guessable even rate-limited. */
export const MIN_SECRET_LENGTH = 12;

/** A request message is a header and a small body; this is a generous ceiling on both. */
const MAX_INBOUND_MESSAGE_BYTES = MAX_REQUEST_BODY_BYTES + 4 * 1024;

/**
 * Concurrent tunnelled requests. The dashboard fires a handful on open (status, faults,
 * fan); more than this at once is a stuck client, and each slot holds a loopback socket.
 */
const MAX_REQUESTS_IN_FLIGHT = 6;

/** A response body pauses while more than this is queued for the radio. */
const RESPONSE_HIGH_WATER_BYTES = 32 * 1024;
const DRAIN_POLL_MS = 25;

export interface BleServerOptions {
  secret: string;
  httpPort: number;
  /** BlueZ by default; scripts/check-ble-server.ts passes a stand-in radio. */
  startGatt?: (handlers: GattHandlers) => Promise<GattApplication>;
}

export interface BleServer {
  stop: () => Promise<void>;
}

interface ServerContext {
  options: BleServerOptions;
  session: BleSession;
  outbound: OutboundQueue;
  assembler: FrameAssembler;
  stream: TelemetryStream | null;
  requestsInFlight: number;
  /**
   * Both chains exist for ORDER. Inbound: a sealed envelope's counter must be checked
   * against the one before it, so envelopes open one at a time. Outbound: the phone drops
   * any counter not above the last, so seal-and-enqueue must happen in the order the
   * counters were taken — two concurrent seals could otherwise swap places in the queue.
   */
  inboundChain: Promise<void>;
  outboundChain: Promise<void>;
}

export async function startBleServer(options: BleServerOptions): Promise<BleServer> {
  if (options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BLE_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  let app: GattApplication | null = null;
  const context: ServerContext = {
    options,
    session: new BleSession(options.secret),
    outbound: new OutboundQueue({ send: frame => app?.notify(frame) }),
    assembler: new FrameAssembler(MAX_INBOUND_MESSAGE_BYTES),
    stream: null,
    requestsInFlight: 0,
    inboundChain: Promise.resolve(),
    outboundChain: Promise.resolve(),
  };

  const startGatt = options.startGatt ?? startGattApplication;
  app = await startGatt({
    onRead: () => new TextEncoder().encode(JSON.stringify(context.session.info())),
    onWrite: (frame, mtu) => receiveFrame(context, frame, mtu),
    onSubscribed: subscribed => {
      if (subscribed) {
        context.outbound.start();
        return;
      }
      endSession(context, "phone unsubscribed or disconnected");
    },
  });

  return {
    stop: async () => {
      endSession(context, "service stopping");
      context.outbound.stop();
      await app?.stop();
    },
  };
}

function receiveFrame(context: ServerContext, frame: Bytes, mtu: number | undefined): void {
  if (mtu !== undefined) {
    context.outbound.mtu = mtu;
  }
  const { envelope, problem } = context.assembler.push(frame);
  if (problem) {
    console.log(`ble-server: inbound frame: ${problem}`);
  }
  if (!envelope) return;
  context.inboundChain = context.inboundChain
    .then(() => receiveEnvelope(context, envelope))
    .catch(error => {
      console.warn(`ble-server: inbound envelope handling failed: ${(error as Error).message}`);
    });
}

async function receiveEnvelope(context: ServerContext, envelope: Bytes): Promise<void> {
  const result = await context.session.receive(envelope, monotonicNow());
  if (result.problem) {
    console.log(`ble-server: ${result.problem}`);
  }
  if (result.startedSession) {
    // The old session's queued frames are sealed under a key the new phone does not
    // have, and its stream belongs to a subscription nobody now holds.
    stopStream(context);
    context.outbound.clear();
    context.assembler.reset();
    console.log("ble-server: phone authenticated, session started");
  }
  for (const reply of result.replies) {
    context.outbound.enqueue(reply);
  }
  for (const message of result.messages) {
    dispatch(context, message.kind, message.header, message.body);
  }
}

function dispatch(context: ServerContext, kind: number, header: unknown, body: Bytes): void {
  if (kind === MessageKind.REQUEST) {
    startRequest(context, header as RequestHeader, body);
    return;
  }
  if (kind === MessageKind.SUBSCRIBE) {
    if (context.stream !== null) return;
    context.stream = startTelemetryStream({
      send: message => sendSealed(context, MessageKind.STREAM, message satisfies DashboardMessage),
      bufferedBytes: () => context.outbound.bufferedBytes,
    });
    return;
  }
  if (kind === MessageKind.UNSUBSCRIBE) {
    stopStream(context);
    return;
  }
  console.log(`ble-server: ignoring message kind ${kind}`);
}

function startRequest(context: ServerContext, header: RequestHeader, body: Bytes): void {
  const id = header.id;
  if (context.requestsInFlight >= MAX_REQUESTS_IN_FLIGHT) {
    sendSealed(context, MessageKind.RESPONSE_HEAD, { id, status: 503, headers: {} });
    sendSealed(context, MessageKind.RESPONSE_END, {
      id,
      error: `${MAX_REQUESTS_IN_FLIGHT} requests already in flight`,
    });
    return;
  }
  context.requestsInFlight++;
  const generation = context.session.generation;
  console.log(`ble-server: ${header.method} ${header.path}`);
  void forwardRequest(context.options.httpPort, header, body, {
    head: async (status, headers) => sendSealed(context, MessageKind.RESPONSE_HEAD, { id, status, headers }),
    body: async chunk => {
      await waitForRoom(context, generation);
      sendSealed(context, MessageKind.RESPONSE_BODY, { id }, chunk);
    },
    end: async error => sendSealed(context, MessageKind.RESPONSE_END, error === undefined ? { id } : { id, error }),
  }).finally(() => {
    context.requestsInFlight--;
  });
}

/**
 * Holds a response body back until the queue has room, which is what makes the tunnel's
 * `for await` a real backpressure chain from the radio to the loopback socket. Throws
 * once the session it was sending for is gone, so the tunnel aborts its request instead
 * of draining a download into a queue nobody will read.
 */
async function waitForRoom(context: ServerContext, generation: number): Promise<void> {
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

function sendSealed(context: ServerContext, kind: number, header: unknown, body?: Bytes): void {
  const generation = context.session.generation;
  context.outboundChain = context.outboundChain
    .then(async () => {
      if (context.session.generation !== generation) return;
      const envelope = await context.session.seal(kind, header, body);
      if (envelope === null || context.session.generation !== generation) return;
      context.outbound.enqueue(envelope);
    })
    .catch(error => {
      console.warn(`ble-server: could not seal message kind ${kind}: ${(error as Error).message}`);
    });
}

function stopStream(context: ServerContext): void {
  context.stream?.stop();
  context.stream = null;
}

function endSession(context: ServerContext, reason: string): void {
  if (!context.session.authenticated && context.stream === null) return;
  stopStream(context);
  context.session.end();
  context.outbound.clear();
  context.assembler.reset();
  console.log(`ble-server: session ended (${reason})`);
}
