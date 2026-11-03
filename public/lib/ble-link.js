// @ts-check
import {
  Direction,
  MessageKind,
  SERVICE_UUID,
  decodeMessage,
  encodeMessage,
  openEnvelope,
  parseEnvelope,
  sealEnvelope,
  splitIntoFrames,
} from "./ble-wire.js";
import { createBleState, setBleStatus } from "./ble-state.js";
import { ensureBleSession } from "./ble-handshake.js";
import { SILENCE_LIMIT_MS } from "./connection.js";
import {
  bleOriginAllowed,
  purgeBleSecret,
  rememberBleSecret,
  requireBleOrigin,
  storedBleSecret,
} from "./ble-credentials.js";

/** @param {Partial<import("./ble-state.js").BleEnvironment>} [environment] */
export function createBleLink(environment = {}) {
  const state = createBleState(environment);
  state.receive = event => receiveNotification(state, event);
  state.writeHello = (rx, envelope, epoch) => writeFrames(state, rx, envelope, epoch);
  if (state.environment.url.protocol === "https:" && !bleOriginAllowed(state)) {
    purgeBleSecret(state);
  }
  return {
    storedSecret: () => storedBleSecret(state),
    /** @param {string} secret */
    rememberSecret: secret => rememberBleSecret(state, secret),
    originAllowed: () => bleOriginAllowed(state),
    bluetoothAvailable: () =>
      bleOriginAllowed(state) && state.environment.secure() && state.environment.bluetooth() !== undefined,
    nativeShell: () => state.environment.shell(),
    /** @param {(status: BleStatus, detail: string) => void} listener */
    onBleStatus(listener) {
      state.statusListeners.add(listener);
      listener(state.status, "");
      return () => state.statusListeners.delete(listener);
    },
    chooseAndConnect: () => chooseDevice(state),
    deviceChosen: () => state.device !== null,
    reconnect: async () => {
      await ensureBleSession(state);
    },
    /** @param {string} path @param {TunnelRequestInit} [init] */
    tunnelRequest: (path, init = {}) => requestThroughLink(state, path, init),
    /** @param {import("./ble-state.js").StreamListener} listener */
    openStream: listener => subscribeStream(state, listener),
    /** All authenticated messages count; a busy download must survive telemetry starvation. */
    abandonSilentSession: () => {
      if (state.lastAuthenticated !== null && state.environment.now() - state.lastAuthenticated <= SILENCE_LIMIT_MS) {
        return false;
      }
      linkLost(state, `no authenticated Bluetooth message for ${SILENCE_LIMIT_MS / 1000} s`);
      return true;
    },
    pendingRequests: () => state.requests.count(),
  };
}

/** @typedef {import("./ble-wire.js").Bytes} Bytes */
/** @typedef {import("./ble-state.js").BleStatus} BleStatus */
/** @typedef {import("./ble-state.js").TunnelRequestInit} TunnelRequestInit */
/** @typedef {import("./ble-state.js").BleState} BleState */
/** @typedef {import("./ble-state.js").Session} Session */
/** @typedef {import("./ble-state.js").BleCharacteristic} BleCharacteristic */
const client = createBleLink();
export const storedSecret = client.storedSecret;
export const rememberSecret = client.rememberSecret;
export const originAllowed = client.originAllowed;
export const bluetoothAvailable = client.bluetoothAvailable;
export const nativeShell = client.nativeShell;
export const onBleStatus = client.onBleStatus;
export const chooseAndConnect = client.chooseAndConnect;
export const deviceChosen = client.deviceChosen;
export const reconnect = client.reconnect;
export const tunnelRequest = client.tunnelRequest;
export const openStream = client.openStream;
export const abandonSilentSession = client.abandonSilentSession;
// HTTPS/native pages have no Pi at their origin; transport is fixed by the page's source.
// The exact-origin gate still applies; see docs/ble-server.md §"Where the page comes from".
export const BLE_MODE =
  typeof location !== "undefined" &&
  (location.protocol === "https:" ||
    nativeShell() !== undefined ||
    new URLSearchParams(location.search).get("transport") === "ble");

// Fits iOS's usual 185-byte MTU without a long write; smaller MTUs use BlueZ's long-write assembly.
const WRITE_FRAME_BYTES = 180;

/** @param {BleState} state */
async function chooseDevice(state) {
  requireBleOrigin(state);
  const bluetooth = state.environment.bluetooth();
  if (!bluetooth) {
    throw new Error("This browser has no Web Bluetooth. On iPhone use the Cool Eva app or Bluefy; on Android, Chrome.");
  }
  const device = await bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] });
  if (state.device !== device) {
    linkLost(state, "another Pi selected");
    state.device = device;
    device.addEventListener("gattserverdisconnected", () => {
      if (state.device === device) {
        linkLost(state, "the radio link dropped");
      }
    });
  }
  await ensureBleSession(state);
}
/** @param {BleState} state @param {string} path @param {TunnelRequestInit} init */
async function requestThroughLink(state, path, init) {
  const session = await ensureBleSession(state);
  /** @type {Record<string, string>} */
  const headers = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const { id, answer } = state.requests.create(init.onProgress);
  send(
    state,
    session,
    MessageKind.REQUEST,
    { id, method: init.method ?? "GET", path, headers },
    init.body === undefined ? undefined : new TextEncoder().encode(init.body)
  );
  return answer;
}
/** @param {BleState} state @param {import("./ble-state.js").StreamListener} listener */
function subscribeStream(state, listener) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (state.stream === listener) {
      state.stream = null;
      if (state.session) {
        send(state, state.session, MessageKind.UNSUBSCRIBE, {});
      }
    }
    listener.onClose();
  };
  if (!state.device) {
    queueMicrotask(close);
    return { close };
  }
  ensureBleSession(state).then(
    session => {
      if (closed) return;
      if (state.stream && state.stream !== listener) {
        state.stream.onClose();
      }
      state.stream = listener;
      send(state, session, MessageKind.SUBSCRIBE, {});
      listener.onOpen();
    },
    error => {
      console.warn("ble: stream could not start", error);
      close();
    }
  );
  return { close };
}
/** @param {BleState} state @param {Event} event */
function receiveNotification(state, event) {
  const characteristic = /** @type {BleCharacteristic} */ (/** @type {unknown} */ (event.target));
  const view = characteristic.value;
  if (!view) return;
  const frame = new Uint8Array(view.byteLength);
  frame.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  const { envelope, problem } = state.assembler.push(frame);
  if (problem) {
    console.warn(`ble: inbound frame: ${problem}`);
  }
  if (!envelope) return;
  const epoch = state.epoch;
  // Opening is asynchronous, so counters must be checked in arrival order.
  state.readChain = state.readChain
    .then(() => receiveEnvelope(state, envelope, epoch))
    .catch(error => console.warn("ble: could not handle a message from the Pi", error));
}
/** @param {BleState} state @param {Bytes} envelope @param {number} epoch */
async function receiveEnvelope(state, envelope, epoch) {
  if (state.epoch !== epoch) return;
  const parsed = parseEnvelope(envelope);
  if (!parsed.sealed) {
    if (state.session !== null || state.handshake === null) return;
    const message = decodeMessage(parsed.message);
    const header = /** @type {import("./ble-wire.js").RefusedHeader} */ (message.header);
    if (
      message.kind === MessageKind.REFUSED &&
      header?.clientNonce === state.handshake.nonce &&
      typeof header.reason === "string"
    ) {
      setBleStatus(state, "refused", header.reason);
      state.handshake.reject(new Error(`the Pi refused this attempt: ${header.reason}`));
    }
    return;
  }
  const session = state.session ?? state.pendingSession;
  if (!session || parsed.counter <= session.lastInboundCounter) return;
  const plaintext = await openEnvelope(session.key, Direction.TO_PHONE, parsed.counter, parsed.ciphertext);
  if (state.epoch !== epoch || (state.session ?? state.pendingSession) !== session) return;
  const message = decodeMessage(plaintext);
  session.lastInboundCounter = parsed.counter;
  state.lastAuthenticated = state.environment.now();
  if (message.kind === MessageKind.WELCOME) {
    if (state.pendingSession === session) {
      state.pendingSession = null;
      state.handshake?.resolve();
    }
  } else if (message.kind === MessageKind.STREAM) {
    state.stream?.onMessage(/** @type {import("./ble-wire.js").DashboardMessage} */ (message.header));
  } else {
    state.requests.accept(message);
  }
}
/** @param {BleState} state @param {Session} session @param {number} kind @param {unknown} header @param {Bytes} [body] */
function send(state, session, kind, header, body) {
  const epoch = state.epoch;
  // Take counters inside the chain so asynchronous sealing cannot reorder the radio queue.
  state.writeChain = state.writeChain
    .then(async () => {
      if (state.epoch !== epoch || state.session !== session) return;
      const envelope = await sealEnvelope(
        session.key,
        Direction.TO_PI,
        session.nextOutboundCounter++,
        encodeMessage(kind, header, body)
      );
      if (state.epoch !== epoch || state.session !== session) return;
      await writeEach(state, session.rx, envelope, epoch);
    })
    .catch(error => {
      console.error(`ble: could not send message kind ${kind}`, error);
      if (state.epoch === epoch) {
        linkLost(state, `a write failed: ${/** @type {Error} */ (error).message}`);
      }
    });
}
/** @param {BleState} state @param {BleCharacteristic} rx @param {Bytes} envelope @param {number} epoch */
function writeFrames(state, rx, envelope, epoch) {
  const work = state.writeChain.then(() => writeEach(state, rx, envelope, epoch));
  state.writeChain = work.catch(error => {
    console.warn("ble: handshake write failed", error);
  });
  return work;
}
/** @param {BleState} state @param {BleCharacteristic} rx @param {Bytes} envelope @param {number} epoch */
async function writeEach(state, rx, envelope, epoch) {
  // Web Bluetooth rejects a second GATT write while one is pending; callers share writeChain.
  state.messageId = (state.messageId + 1) & 0xff;
  for (const frame of splitIntoFrames(envelope, state.messageId, WRITE_FRAME_BYTES)) {
    if (state.epoch !== epoch) return;
    await rx.writeValueWithResponse(frame);
  }
}
/** @param {BleState} state @param {string} reason */
function linkLost(state, reason) {
  const hadSession = state.session !== null;
  state.epoch++;
  state.session = null;
  state.pendingSession = null;
  state.connecting = null;
  if (state.handshake) {
    state.environment.clearTimer(state.handshake.timer);
    state.handshake.reject(new Error(reason));
    state.handshake = null;
  }
  state.writeChain = Promise.resolve();
  state.readChain = Promise.resolve();
  state.lastAuthenticated = null;
  state.assembler.reset();
  state.requests.failAll(`BLE link lost: ${reason}`);
  const stream = state.stream;
  state.stream = null;
  stream?.onClose();
  if (hadSession || state.status === "connecting") {
    setBleStatus(state, "lost", reason);
  }
}
