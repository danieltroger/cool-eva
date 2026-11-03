// @ts-check
import { concatenate, MessageKind } from "./ble-wire.js";

/** @param {Pick<import("./ble-state.js").BleEnvironment, "setTimer" | "clearTimer">} timers */
export function createBleRequests(timers) {
  /** @type {Map<number, PendingRequest>} */
  const pending = new Map();
  let nextId = 1;
  return {
    /** @param {((received: number, total: number | null) => void) | undefined} progress */
    create(progress) {
      const id = nextId++;
      /** @type {Promise<TunnelResponse>} */
      const answer = new Promise((resolve, reject) => {
        const request = {
          resolve,
          reject,
          status: null,
          headers: {},
          parts: [],
          receivedBytes: 0,
          progress,
          timer: null,
        };
        pending.set(id, request);
        arm(pending, id, timers);
      });
      return { id, answer };
    },
    /** @param {import("./ble-wire.js").WireMessage} message */
    accept(message) {
      accept(pending, message, timers);
    },
    /** @param {string} reason */
    failAll(reason) {
      for (const request of pending.values()) {
        if (request.timer !== null) {
          timers.clearTimer(request.timer);
        }
        request.parts = [];
        request.reject(new Error(`${reason}; outcome unknown — check status before repeating a write`));
      }
      pending.clear();
    },
    count: () => pending.size,
  };
}

/** @typedef {import("./ble-wire.js").Bytes} Bytes */
/** @typedef {{ status: number, headers: Record<string, string>, body: Bytes }} TunnelResponse */
/**
 * @typedef {object} PendingRequest
 * @property {(response: TunnelResponse) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {number | null} status
 * @property {Record<string, string>} headers
 * @property {Bytes[]} parts
 * @property {number} receivedBytes
 * @property {((received: number, total: number | null) => void) | undefined} progress
 * @property {import("./ble-state.js").TimerHandle | null} timer
 */

/**
 * @param {Map<number, PendingRequest>} pending
 * @param {number} id
 * @param {Pick<import("./ble-state.js").BleEnvironment, "setTimer" | "clearTimer">} timers
 */
function arm(pending, id, timers) {
  const request = pending.get(id);
  if (!request) return;
  if (request.timer !== null) {
    timers.clearTimer(request.timer);
  }
  request.timer = timers.setTimer(() => {
    pending.delete(id);
    request.parts = [];
    request.reject(
      new Error("No Bluetooth response progress for 195 s; outcome unknown — check status before repeating a write")
    );
  }, 195_000);
}

/**
 * @param {Map<number, PendingRequest>} pending
 * @param {import("./ble-wire.js").WireMessage} message
 * @param {Pick<import("./ble-state.js").BleEnvironment, "setTimer" | "clearTimer">} timers
 */
function accept(pending, message, timers) {
  const header = /** @type {import("./ble-wire.js").ResponseHeadHeader & import("./ble-wire.js").ResponseEndHeader} */ (
    message.header
  );
  const request = pending.get(header.id);
  if (!request) return;
  if (message.kind === MessageKind.RESPONSE_HEAD) {
    request.status = header.status;
    request.headers = header.headers;
    arm(pending, header.id, timers);
  } else if (message.kind === MessageKind.RESPONSE_BODY) {
    request.parts.push(message.body);
    request.receivedBytes += message.body.length;
    const total = Number(request.headers["content-length"]);
    request.progress?.(request.receivedBytes, Number.isFinite(total) ? total : null);
    arm(pending, header.id, timers);
  } else if (message.kind === MessageKind.RESPONSE_END) {
    pending.delete(header.id);
    if (request.timer !== null) {
      timers.clearTimer(request.timer);
    }
    if (request.status === null || (header.error !== undefined && request.receivedBytes > 0)) {
      request.reject(new Error(header.error ?? "the Pi ended the response before answering"));
    } else {
      request.resolve({ status: request.status, headers: request.headers, body: concatenate(request.parts) });
    }
    request.parts = [];
  }
}
