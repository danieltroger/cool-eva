// @ts-check
import { FrameAssembler } from "./ble-wire.js";
import { createBleRequests } from "./ble-requests.js";
import { monotonicNow } from "./clock.js";

/** @param {Partial<BleEnvironment>} options */
export function createBleState(options) {
  /** @type {BleEnvironment} */
  const environment = {
    now: monotonicNow,
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: timer => clearTimeout(timer),
    storage: {
      getItem: key => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: key => localStorage.removeItem(key),
    },
    bluetooth: () => /** @type {{ bluetooth?: WebBluetooth }} */ (/** @type {unknown} */ (navigator)).bluetooth,
    secure: () => globalThis.isSecureContext === true,
    shell: () => /** @type {{ coolEvaNative?: NativeShell }} */ (/** @type {unknown} */ (globalThis)).coolEvaNative,
    ...options,
  };
  /** @type {BleState} */
  const state = {
    environment,
    device: null,
    session: null,
    pendingSession: null,
    connecting: null,
    handshake: null,
    assembler: new FrameAssembler(MAX_INBOUND_MESSAGE_BYTES),
    requests: createBleRequests(environment),
    stream: null,
    writeChain: Promise.resolve(),
    readChain: Promise.resolve(),
    epoch: 0,
    messageId: 0,
    lastAuthenticated: null,
    status: "off",
    statusListeners: new Set(),
    // Chrome reuses characteristic objects; retain one listener per object across reconnects.
    listened: new WeakSet(),
    receive: () => {
      throw new Error("BLE receiver not installed");
    },
    writeHello: async () => {
      throw new Error("BLE writer not installed");
    },
  };
  return state;
}

// Responses are chunked; an individual inbound envelope above this size is a fault, not a download.
const MAX_INBOUND_MESSAGE_BYTES = 256 * 1024;

/** @typedef {import("./ble-wire.js").Bytes} Bytes */

/** @typedef {ReturnType<typeof setTimeout> | number} TimerHandle */

/** @typedef {"off" | "connecting" | "connected" | "refused" | "lost"} BleStatus */

/** @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void }} BleStorage */

/** @typedef {{ platform: "ios", saveFile: (name: string, bytes: Bytes, mimeType: string) => Promise<void> }} NativeShell */

/**
 * @typedef {object} BleCharacteristic
 * @property {DataView | undefined} value
 * @property {() => Promise<DataView>} readValue
 * @property {(value: Bytes) => Promise<void>} writeValueWithResponse
 * @property {() => Promise<BleCharacteristic>} startNotifications
 * @property {(type: "characteristicvaluechanged", listener: (event: Event) => void) => void} addEventListener
 */

/** @typedef {{ getCharacteristic: (uuid: string) => Promise<BleCharacteristic> }} BleService */

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

/** @typedef {{ requestDevice: (options: { filters: { services: string[] }[] }) => Promise<BleDevice> }} WebBluetooth */

/**
 * @typedef {object} BleEnvironment
 * @property {() => number} now
 * @property {(callback: () => void, milliseconds: number) => TimerHandle} setTimer
 * @property {(timer: TimerHandle) => void} clearTimer
 * @property {BleStorage} storage
 * @property {() => WebBluetooth | undefined} bluetooth
 * @property {() => boolean} secure
 * @property {() => NativeShell | undefined} shell
 */

/** @typedef {{ key: CryptoKey, nextOutboundCounter: number, lastInboundCounter: number, rx: BleCharacteristic }} Session */

/** @typedef {{ method?: string, headers?: HeadersInit, body?: string, onProgress?: (received: number, total: number | null) => void }} TunnelRequestInit */

/** @typedef {{ onOpen: () => void, onMessage: (message: import("./ble-wire.js").DashboardMessage) => void, onClose: () => void }} StreamListener */

/**
 * @typedef {object} BleTransportState
 * @property {BleEnvironment} environment
 * @property {BleDevice | null} device
 * @property {Session | null} session
 * @property {Session | null} pendingSession
 * @property {Promise<Session> | null} connecting
 * @property {{ nonce: string, resolve: () => void, reject: (error: Error) => void, timer: TimerHandle } | null} handshake
 * @property {FrameAssembler} assembler
 * @property {ReturnType<typeof createBleRequests>} requests
 * @property {StreamListener | null} stream
 */

/**
 * @typedef {object} BleWorkState
 * @property {Promise<void>} writeChain
 * @property {Promise<void>} readChain
 * @property {number} epoch
 * @property {number} messageId
 * @property {number | null} lastAuthenticated
 * @property {BleStatus} status
 * @property {Set<(status: BleStatus, detail: string) => void>} statusListeners
 * @property {WeakSet<BleCharacteristic>} listened
 */

/**
 * @typedef {object} BleCallbacks
 * @property {(event: Event) => void} receive
 * @property {(rx: BleCharacteristic, envelope: Bytes, epoch: number) => Promise<void>} writeHello
 */

/** @typedef {BleTransportState & BleWorkState & BleCallbacks} BleState */

/** @param {BleState} state @param {BleStatus} status @param {string} detail */
export function setBleStatus(state, status, detail) {
  state.status = status;
  for (const listener of state.statusListeners) {
    listener(status, detail);
  }
}
