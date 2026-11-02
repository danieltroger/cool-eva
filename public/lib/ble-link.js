// @ts-check

import {
  Direction,
  FrameAssembler,
  INFO_CHARACTERISTIC_UUID,
  MessageKind,
  PROTOCOL_VERSION,
  RX_CHARACTERISTIC_UUID,
  SERVICE_UUID,
  TX_CHARACTERISTIC_UUID,
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
} from "./ble-wire.js";

// The dashboard's end of the BLE link to the Pi (src/ble-server/): choosing the device,
// the handshake, and the two things the rest of the page uses it for — tunnelled HTTP
// requests (./transport.js) and the live stream (./store.js). One link per page.
// docs/ble-server.md has the protocol.

/** @typedef {import("./ble-wire.js").Bytes} Bytes */
/** @typedef {import("./ble-wire.js").DashboardMessage} DashboardMessage */
/** @typedef {import("./ble-wire.js").HelloInfo} HelloInfo */
/** @typedef {import("./ble-wire.js").RefusedHeader} RefusedHeader */
/** @typedef {import("./ble-wire.js").ResponseHeadHeader} ResponseHeadHeader */
/** @typedef {import("./ble-wire.js").ResponseEndHeader} ResponseEndHeader */

// The sliver of Web Bluetooth used here. TypeScript's DOM lib does not carry it at all.
/**
 * @typedef {object} BleCharacteristic
 * @property {DataView | undefined} value
 * @property {() => Promise<DataView>} readValue
 * @property {(value: Bytes) => Promise<void>} writeValueWithResponse
 * @property {() => Promise<BleCharacteristic>} startNotifications
 * @property {(type: "characteristicvaluechanged", listener: (event: Event) => void) => void} addEventListener
 */

/**
 * @typedef {object} BleService
 * @property {(uuid: string) => Promise<BleCharacteristic>} getCharacteristic
 */

/**
 * @typedef {object} BleGattServer
 * @property {boolean} connected
 * @property {() => Promise<BleGattServer>} connect
 * @property {() => void} disconnect
 * @property {(uuid: string) => Promise<BleService>} getPrimaryService
 */

/**
 * @typedef {object} BleDevice
 * @property {string | undefined} name
 * @property {BleGattServer | undefined} gatt
 * @property {(type: "gattserverdisconnected", listener: () => void) => void} addEventListener
 */

/**
 * @typedef {object} WebBluetooth
 * @property {(options: { filters: { services: string[] }[] }) => Promise<BleDevice>} requestDevice
 */

/**
 * "off": never connected · "connecting" · "connected": authenticated, carrying traffic ·
 * "refused": the Pi rejected the secret · "lost": was connected, the radio dropped it.
 * @typedef {"off" | "connecting" | "connected" | "refused" | "lost"} BleStatus
 */

/** @typedef {{ status: number, headers: Record<string, string>, body: Bytes }} TunnelResponse */

/**
 * @typedef {object} TunnelRequestInit
 * @property {string} [method]
 * @property {HeadersInit} [headers]
 * @property {string} [body]
 * @property {(receivedBytes: number, totalBytes: number | null) => void} [onProgress]
 */

/**
 * @typedef {object} StreamListener
 * @property {() => void} onOpen
 * @property {(message: DashboardMessage) => void} onMessage
 * @property {() => void} onClose
 */

const SECRET_STORAGE_KEY = "cool-eva.ble-secret";

/**
 * Phone → Pi frames. Under the 185-byte MTU iOS negotiates, so a write never needs the
 * long-write procedure; requests are small, so the extra frames cost nothing that shows.
 */
const WRITE_FRAME_BYTES = 180;

/** A response or stream message bigger than this is a fault, not something to buffer. */
const MAX_INBOUND_MESSAGE_BYTES = 256 * 1024;

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} PendingRequest
 * @property {(response: TunnelResponse) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {number | null} status
 * @property {Record<string, string>} headers
 * @property {Bytes[]} parts
 * @property {number} receivedBytes
 * @property {TunnelRequestInit["onProgress"]} onProgress
 */

/**
 * @typedef {object} Session
 * @property {CryptoKey} key
 * @property {number} nextOutboundCounter
 * @property {number} lastInboundCounter
 * @property {BleCharacteristic} rx
 */

/**
 * @typedef {object} LinkState
 * @property {BleDevice | null} device
 * @property {Session | null} session
 * @property {Promise<Session> | null} connecting
 * @property {{ resolve: () => void, reject: (error: Error) => void } | null} handshake
 * @property {FrameAssembler} assembler
 * @property {Map<number, PendingRequest>} pending
 * @property {number} nextRequestId
 * @property {StreamListener | null} stream
 * @property {Promise<void>} writeChain
 * @property {Promise<void>} readChain
 * @property {BleStatus} status
 * @property {Set<(status: BleStatus, detail: string) => void>} statusListeners
 */

/** @type {LinkState} */
const link = {
  device: null,
  session: null,
  connecting: null,
  handshake: null,
  assembler: new FrameAssembler(MAX_INBOUND_MESSAGE_BYTES),
  pending: new Map(),
  nextRequestId: 1,
  stream: null,
  writeChain: Promise.resolve(),
  readChain: Promise.resolve(),
  status: "off",
  statusListeners: new Set(),
};

/**
 * The session whose WELCOME is awaited. Kept apart from `link.session` so nothing sends
 * on a session the Pi has not yet confirmed — WELCOME is sealed, which is the Pi proving
 * it knows the secret too.
 * @type {Session | null}
 */
let pendingSession = null;

/** Frame-layer message id for phone → Pi envelopes; only has to differ from its neighbour. */
let messageId = 0;

/**
 * The secret the Pi last refused. Retrying it would only be refused again — and keep the
 * Pi's failure cooldown permanently armed — so reconnects wait until the rider types a
 * different one.
 * @type {string | null}
 */
let refusedSecret = null;

/** The secret behind the HELLO in flight, so a refusal can be pinned on the right one. */
let attemptedSecret = "";

/**
 * Characteristics already carrying our listener. Chrome can hand back the SAME object on
 * a reconnect, and a second listener would feed every frame through twice.
 * @type {WeakSet<BleCharacteristic>}
 */
const listenedCharacteristics = new WeakSet();

/**
 * What the iOS app (ios/) installs before any module runs: Web Bluetooth over
 * CoreBluetooth, and a native share sheet for saved files. Absent in a browser.
 * @typedef {{ platform: "ios", saveFile: (name: string, bytes: Bytes, mimeType: string) => Promise<void> }} NativeShell
 */

/** @returns {NativeShell | undefined} */
export function nativeShell() {
  return /** @type {{ coolEvaNative?: NativeShell }} */ (/** @type {unknown} */ (globalThis)).coolEvaNative;
}

/**
 * Whether this page should talk to the Pi over BLE at all. Fixed by where the page came
 * from rather than switchable: served by the Pi (plain http, its own wifi) it uses HTTP
 * exactly as before; served over https — GitHub Pages — or from inside the iOS app,
 * there is no Pi behind the origin and BLE is the only way to one. `?transport=ble`
 * forces it, for localhost development.
 */
export const BLE_MODE =
  typeof location !== "undefined" &&
  (location.protocol === "https:" ||
    nativeShell() !== undefined ||
    new URLSearchParams(location.search).get("transport") === "ble");

/** @returns {WebBluetooth | undefined} */
function webBluetooth() {
  return /** @type {{ bluetooth?: WebBluetooth }} */ (/** @type {unknown} */ (navigator)).bluetooth;
}

export function bluetoothAvailable() {
  return typeof navigator !== "undefined" && webBluetooth() !== undefined && globalThis.isSecureContext === true;
}

export function storedSecret() {
  return localStorage.getItem(SECRET_STORAGE_KEY) ?? "";
}

/** @param {string} secret */
export function rememberSecret(secret) {
  localStorage.setItem(SECRET_STORAGE_KEY, secret);
}

/**
 * @param {(status: BleStatus, detail: string) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onBleStatus(listener) {
  link.statusListeners.add(listener);
  listener(link.status, "");
  return () => link.statusListeners.delete(listener);
}

/**
 * Asks the browser for the Pi and connects. Must be called from a user gesture — Web
 * Bluetooth refuses `requestDevice` otherwise. Later reconnects to the same device need
 * no gesture, so this is a once-per-page-load tap.
 */
export async function chooseAndConnect() {
  const bluetooth = webBluetooth();
  if (bluetooth === undefined) {
    throw new Error("This browser has no Web Bluetooth. On iPhone use the Cool Eva app or Bluefy; on Android, Chrome.");
  }
  const device = await bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] });
  if (link.device !== device) {
    link.device = device;
    device.addEventListener("gattserverdisconnected", () => linkLost("the radio link dropped"));
  }
  await ensureSession();
}

/**
 * One HTTP request through the Pi's tunnel. The answer is whatever the Pi's own HTTP
 * server said, status and all; a rejection means the link failed, never the endpoint.
 * @param {string} path
 * @param {TunnelRequestInit} [init]
 * @returns {Promise<TunnelResponse>}
 */
export async function tunnelRequest(path, init = {}) {
  const session = await ensureSession();
  const id = link.nextRequestId++;
  /** @type {Record<string, string>} */
  const headers = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const body = init.body === undefined ? undefined : new TextEncoder().encode(init.body);
  const answer = new Promise((resolve, reject) => {
    link.pending.set(id, {
      resolve,
      reject,
      status: null,
      headers: {},
      parts: [],
      receivedBytes: 0,
      onProgress: init.onProgress,
    });
  });
  send(session, MessageKind.REQUEST, { id, method: init.method ?? "GET", path, headers }, body);
  return /** @type {Promise<TunnelResponse>} */ (answer);
}

/**
 * Subscribes to the live telemetry. Returns at once; `onOpen` fires when the link is up
 * and the subscription sent, `onClose` when it ends for any reason — including never
 * getting started, so the caller has one path for both.
 * @param {StreamListener} listener
 * @returns {{ close: () => void }}
 */
export function openStream(listener) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (link.stream === listener) {
      link.stream = null;
      if (link.session !== null) {
        send(link.session, MessageKind.UNSUBSCRIBE, {});
      }
    }
    listener.onClose();
  };
  if (link.device === null) {
    // Nothing chosen yet. Closing asynchronously, like a WebSocket that failed to
    // connect, so the caller's retry loop sees the order of events it expects.
    queueMicrotask(close);
    return { close };
  }
  ensureSession().then(
    session => {
      if (closed) return;
      if (link.stream !== null && link.stream !== listener) {
        link.stream.onClose();
      }
      link.stream = listener;
      send(session, MessageKind.SUBSCRIBE, {});
      listener.onOpen();
    },
    error => {
      console.warn("ble: stream could not start:", error);
      close();
    }
  );
  return { close };
}

/** @returns {Promise<Session>} */
function ensureSession() {
  if (link.session !== null) {
    return Promise.resolve(link.session);
  }
  if (link.connecting === null) {
    link.connecting = handshake().finally(() => {
      link.connecting = null;
    });
  }
  return link.connecting;
}

/** @returns {Promise<Session>} */
async function handshake() {
  const device = link.device;
  if (device === null || device.gatt === undefined) {
    throw new Error("no Pi chosen — tap Connect first");
  }
  const secret = storedSecret();
  if (secret === "") {
    setStatus("refused", "enter the Pi's BLE secret");
    throw new Error("no secret entered");
  }
  if (secret === refusedSecret) {
    throw new Error("the Pi refused this secret; enter the right one");
  }
  setStatus("connecting", "");
  try {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const rx = await service.getCharacteristic(RX_CHARACTERISTIC_UUID);
    const tx = await service.getCharacteristic(TX_CHARACTERISTIC_UUID);
    const infoCharacteristic = await service.getCharacteristic(INFO_CHARACTERISTIC_UUID);
    link.assembler.reset();
    if (!listenedCharacteristics.has(tx)) {
      listenedCharacteristics.add(tx);
      tx.addEventListener("characteristicvaluechanged", receiveNotification);
    }
    await tx.startNotifications();

    const infoView = await infoCharacteristic.readValue();
    const info = /** @type {HelloInfo} */ (
      JSON.parse(new TextDecoder().decode(new Uint8Array(infoView.buffer, infoView.byteOffset, infoView.byteLength)))
    );
    if (info.version !== PROTOCOL_VERSION) {
      throw new Error(`the Pi speaks protocol ${info.version}, this page ${PROTOCOL_VERSION} — update one of them`);
    }
    const clientNonce = randomNonce();
    const key = await deriveSessionKey(secret, info.serverNonce, clientNonce);
    /** @type {Session} */
    const session = { key, nextOutboundCounter: 0, lastInboundCounter: -1, rx };
    const proof = await helloProof(secret, info.serverNonce, clientNonce);

    const welcomed = new Promise((resolve, reject) => {
      link.handshake = { resolve: () => resolve(undefined), reject };
      setTimeout(
        () => reject(new Error(`no answer to HELLO in ${HANDSHAKE_TIMEOUT_MS / 1000} s`)),
        HANDSHAKE_TIMEOUT_MS
      );
    });
    // The session must exist BEFORE the Pi's WELCOME arrives, since opening it needs the key.
    pendingSession = session;
    attemptedSecret = secret;
    writeFrames(rx, clearEnvelope(encodeMessage(MessageKind.HELLO, { version: PROTOCOL_VERSION, clientNonce, proof })));
    await welcomed;
    link.session = session;
    setStatus("connected", device.name ?? "");
    return session;
  } catch (error) {
    pendingSession = null;
    link.handshake = null;
    if (link.status !== "refused") {
      setStatus("lost", /** @type {Error} */ (error).message);
    }
    throw error;
  }
}

/** @param {Event} event */
function receiveNotification(event) {
  const characteristic = /** @type {BleCharacteristic} */ (/** @type {unknown} */ (event.target));
  const view = characteristic.value;
  if (view === undefined) return;
  const frame = new Uint8Array(view.byteLength);
  frame.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  const { envelope, problem } = link.assembler.push(frame);
  if (problem) {
    console.warn(`ble: inbound frame: ${problem}`);
  }
  if (!envelope) return;
  // Serialised: counters must be checked in arrival order, and openEnvelope is async.
  link.readChain = link.readChain
    .then(() => receiveEnvelope(envelope))
    .catch(error => console.error("ble: could not handle a message from the Pi", error));
}

/** @param {Bytes} envelope */
async function receiveEnvelope(envelope) {
  const parsed = parseEnvelope(envelope);
  if (!parsed.sealed) {
    const message = decodeMessage(parsed.message);
    if (message.kind === MessageKind.REFUSED) {
      const reason = /** @type {RefusedHeader} */ (message.header).reason;
      // Only a wrong secret is sticky; a cooldown or version refusal is worth retrying.
      if (reason === "wrong secret") {
        refusedSecret = attemptedSecret;
      }
      setStatus("refused", reason);
      link.handshake?.reject(new Error(`the Pi refused the connection: ${reason}`));
      link.handshake = null;
      if (link.session !== null) {
        linkLost(`the Pi ended the session: ${reason}`);
      }
    }
    return;
  }
  const session = link.session ?? pendingSession;
  if (session === null) return;
  if (parsed.counter <= session.lastInboundCounter) {
    console.warn(`ble: dropping replayed or reordered counter ${parsed.counter}`);
    return;
  }
  const plaintext = await openEnvelope(session.key, Direction.TO_PHONE, parsed.counter, parsed.ciphertext);
  session.lastInboundCounter = parsed.counter;
  dispatch(decodeMessage(plaintext));
}

/** @param {import("./ble-wire.js").WireMessage} message */
function dispatch(message) {
  switch (message.kind) {
    case MessageKind.WELCOME: {
      pendingSession = null;
      link.handshake?.resolve();
      link.handshake = null;
      return;
    }
    case MessageKind.STREAM: {
      link.stream?.onMessage(/** @type {DashboardMessage} */ (message.header));
      return;
    }
    case MessageKind.RESPONSE_HEAD: {
      const header = /** @type {ResponseHeadHeader} */ (message.header);
      const pending = link.pending.get(header.id);
      if (pending === undefined) return;
      pending.status = header.status;
      pending.headers = header.headers;
      return;
    }
    case MessageKind.RESPONSE_BODY: {
      const pending = link.pending.get(/** @type {{ id: number }} */ (message.header).id);
      if (pending === undefined) return;
      pending.parts.push(message.body);
      pending.receivedBytes += message.body.length;
      const declared = Number(pending.headers["content-length"]);
      pending.onProgress?.(pending.receivedBytes, Number.isFinite(declared) ? declared : null);
      return;
    }
    case MessageKind.RESPONSE_END: {
      const header = /** @type {ResponseEndHeader} */ (message.header);
      const pending = link.pending.get(header.id);
      if (pending === undefined) return;
      link.pending.delete(header.id);
      // A head with no body yet is still an answer (a 502 from loopback, say); an error
      // after some body is a truncated file, which must never be handed over as whole.
      if (pending.status === null || (header.error !== undefined && pending.receivedBytes > 0)) {
        pending.reject(new Error(header.error ?? "the Pi ended the response before answering"));
        return;
      }
      pending.resolve({ status: pending.status, headers: pending.headers, body: concatenate(pending.parts) });
      return;
    }
    default:
      console.warn(`ble: ignoring message kind ${message.kind}`);
  }
}

/**
 * @param {Session} session
 * @param {number} kind
 * @param {unknown} header
 * @param {Bytes} [body]
 */
function send(session, kind, header, body) {
  // The counter is taken inside the chain, so envelopes reach the radio in counter order.
  link.writeChain = link.writeChain
    .then(async () => {
      if (link.session !== session) return;
      const counter = session.nextOutboundCounter++;
      const envelope = await sealEnvelope(session.key, Direction.TO_PI, counter, encodeMessage(kind, header, body));
      await writeEach(session.rx, envelope);
    })
    .catch(error => {
      console.error(`ble: could not send message kind ${kind}`, error);
      linkLost(`a write failed: ${/** @type {Error} */ (error).message}`);
    });
}

/**
 * @param {BleCharacteristic} rx
 * @param {Bytes} envelope
 */
function writeFrames(rx, envelope) {
  link.writeChain = link.writeChain
    .then(() => writeEach(rx, envelope))
    .catch(error => {
      link.handshake?.reject(/** @type {Error} */ (error));
      link.handshake = null;
    });
}

/**
 * One GATT write at a time: Web Bluetooth rejects a second while one is pending.
 * @param {BleCharacteristic} rx
 * @param {Bytes} envelope
 */
async function writeEach(rx, envelope) {
  messageId = (messageId + 1) & 0xff;
  for (const frame of splitIntoFrames(envelope, messageId, WRITE_FRAME_BYTES)) {
    await rx.writeValueWithResponse(frame);
  }
}

/** @param {string} reason */
function linkLost(reason) {
  const hadSession = link.session !== null;
  link.session = null;
  pendingSession = null;
  link.assembler.reset();
  for (const pending of link.pending.values()) {
    pending.reject(new Error(`BLE link lost: ${reason}`));
  }
  link.pending.clear();
  const stream = link.stream;
  link.stream = null;
  stream?.onClose();
  if (hadSession || link.status === "connecting") {
    setStatus("lost", reason);
  }
}

/**
 * @param {BleStatus} status
 * @param {string} detail
 */
function setStatus(status, detail) {
  link.status = status;
  for (const listener of link.statusListeners) {
    listener(status, detail);
  }
}
