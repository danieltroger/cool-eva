// @ts-check
import {
  INFO_CHARACTERISTIC_UUID,
  MessageKind,
  PROTOCOL_VERSION,
  RX_CHARACTERISTIC_UUID,
  SERVICE_UUID,
  TX_CHARACTERISTIC_UUID,
  clearEnvelope,
  deriveSessionKey,
  encodeMessage,
  helloProof,
  randomNonce,
} from "./ble-wire.js";
import { storedBleSecret } from "./ble-credentials.js";
import { setBleStatus } from "./ble-state.js";

/** @param {import("./ble-state.js").BleState} state @returns {Promise<import("./ble-state.js").Session>} */
export function ensureBleSession(state) {
  if (state.session !== null) return Promise.resolve(state.session);
  if (state.connecting === null) {
    const epoch = state.epoch;
    const work = handshake(state, epoch).finally(() => {
      if (state.epoch === epoch) {
        state.connecting = null;
      }
    });
    state.connecting = work;
  }
  return state.connecting;
}

/** @param {import("./ble-state.js").BleState} state @param {number} epoch */
async function handshake(state, epoch) {
  const device = state.device;
  if (!device?.gatt) {
    throw new Error("no Pi chosen — tap Connect first");
  }
  const secret = storedBleSecret(state);
  if (!secret) {
    setBleStatus(state, "off", "");
    throw new Error("no generated key entered");
  }
  setBleStatus(state, "connecting", "");
  try {
    const server = await device.gatt.connect();
    current(state, epoch);
    const service = await server.getPrimaryService(SERVICE_UUID);
    current(state, epoch);
    const rx = await service.getCharacteristic(RX_CHARACTERISTIC_UUID);
    const tx = await service.getCharacteristic(TX_CHARACTERISTIC_UUID);
    const infoCharacteristic = await service.getCharacteristic(INFO_CHARACTERISTIC_UUID);
    current(state, epoch);
    state.assembler.reset();
    // Chrome may return the same characteristic on reconnect; duplicate listeners duplicate every frame.
    if (!state.listened.has(tx)) {
      state.listened.add(tx);
      tx.addEventListener("characteristicvaluechanged", state.receive);
    }
    await tx.startNotifications();
    const view = await infoCharacteristic.readValue();
    current(state, epoch);
    const info = /** @type {import("./ble-wire.js").HelloInfo} */ (
      JSON.parse(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)))
    );
    if (info.version !== PROTOCOL_VERSION || !/^[0-9a-f]{32}$/.test(info.serverNonce)) {
      throw new Error(
        `Bluetooth protocol mismatch — update the Pi and this page/app together (expected ${PROTOCOL_VERSION})`
      );
    }
    const clientNonce = randomNonce();
    const key = await deriveSessionKey(secret, info.serverNonce, clientNonce);
    const proof = await helloProof(secret, info.serverNonce, clientNonce);
    current(state, epoch);
    /** @type {import("./ble-state.js").Session} */
    const session = { key, nextOutboundCounter: 0, lastInboundCounter: -1, rx };
    const welcomed = new Promise((resolve, reject) => {
      const timer = state.environment.setTimer(
        () => reject(new Error("no answer to HELLO in 10 s")),
        HANDSHAKE_TIMEOUT_MS
      );
      state.handshake = { nonce: clientNonce, resolve: () => resolve(undefined), reject, timer };
    });
    // WELCOME needs this key before it arrives, but requests must wait for the Pi to prove possession.
    state.pendingSession = session;
    // Attach the rejection handler before beginning a write, which may fail immediately.
    void state
      .writeHello(
        rx,
        clearEnvelope(encodeMessage(MessageKind.HELLO, { version: PROTOCOL_VERSION, clientNonce, proof })),
        epoch
      )
      .catch(error => {
        console.warn("ble: HELLO write failed", error);
        if (state.epoch === epoch) {
          state.handshake?.reject(/** @type {Error} */ (error));
        }
      });
    await welcomed;
    current(state, epoch);
    state.session = session;
    setBleStatus(state, "connected", device.name || "Unnamed Pi");
    return session;
  } catch (error) {
    if (state.epoch === epoch) {
      state.pendingSession = null;
      if (state.status !== "refused") {
        setBleStatus(state, "lost", /** @type {Error} */ (error).message);
      }
    }
    throw error;
  } finally {
    if (state.epoch === epoch && state.handshake) {
      state.environment.clearTimer(state.handshake.timer);
      state.handshake = null;
    }
  }
}

// A missing WELCOME must settle the attempt so the normal connection policy can retry it.
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** @param {import("./ble-state.js").BleState} state @param {number} epoch */
function current(state, epoch) {
  if (state.epoch !== epoch) {
    throw new Error("superseded Bluetooth connection");
  }
}
