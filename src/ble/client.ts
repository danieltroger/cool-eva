import { createBluetooth } from "node-ble";
import {
  BleTelemetryDecoder,
  FrameReassembler,
  buildAddressMatch,
  buildKeyReply,
  computeSessionKey,
  isSeedFrame,
  isSessionConfirmed,
  readSeed,
  type DecodedValue,
} from "./protocol.ts";

// BLE link to the Energica Connectivity Hub ("Energica BT"), which owns the
// bike's GPS receiver. GPS is NOT on the OBD/VDB CAN bus — see
// obd-garage/CAN_MAP.md §"GPS: NOT on the VDB bus" — so this is the only way to
// get position, and it also yields motor torque/power and the odometer, none of
// which exist on CAN either.

const SERVICE_UUID = "14839ac5-7d7f-415d-9a43-167340cf233a";
const NOTIFY_CHARACTERISTIC_UUID = "0734594b-a8e8-4b1b-a6b2-cd5243059a58";
const WRITE_CHARACTERISTIC_UUID = "8b00ace8-eb0c-49b1-bbea-9aee0a26e1a4";

// The hub re-seeds continuously until authorised; one reply per seed is plenty.
const ADDRESS_MATCH_DELAY_MS = 15;

// GPS (type 26) is pushed unsolicited, but vehicle status (2) and odometer (4)
// are only sent on request — these are the app's own read-only getters. The
// commands that ACT on the bike (20/22/23/24/27/29) are deliberately absent.
const REQUEST_VEHICLE_INFO = Buffer.from([4, 17, 2, 0xff, 0, 0, 0, 0, 0, 0]);
const REQUEST_ODOMETER = Buffer.from([4, 17, 4, 0xff, 0, 0, 0, 0, 0, 0]);
const TELEMETRY_REQUEST_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 5_000;
const SILENCE_TIMEOUT_MS = 30_000;
const UNAUTHORISED_HINT_AFTER_MS = 20_000;

export interface BleClientOptions {
  /** Address of the bike's hub, e.g. "F8:8A:5E:09:D3:B4". */
  macAddress: string;
  onValues: (values: DecodedValue[]) => void;
}

export interface BleClient {
  stop: () => Promise<void>;
}

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

export function startBleClient(options: BleClientOptions): BleClient {
  let stopped = false;
  let disconnectCurrent: (() => Promise<void>) | null = null;

  async function runSession(): Promise<void> {
    const { bluetooth, destroy } = createBluetooth();
    let device: Awaited<ReturnType<Awaited<ReturnType<typeof bluetooth.defaultAdapter>>["waitDevice"]>> | null = null;
    let requestTimer: ReturnType<typeof setInterval> | undefined;

    try {
      const adapter = await bluetooth.defaultAdapter();
      if (!(await adapter.isDiscovering())) {
        await adapter.startDiscovery();
      }

      device = await adapter.waitDevice(options.macAddress);
      await device.connect();

      const ourAddress = await adapter.getAddress();
      const gattServer = await device.gatt();
      const service = await gattServer.getPrimaryService(SERVICE_UUID);
      const notifyCharacteristic = await service.getCharacteristic(NOTIFY_CHARACTERISTIC_UUID);
      const writeCharacteristic = await service.getCharacteristic(WRITE_CHARACTERISTIC_UUID);
      console.log(`ble: connected to ${options.macAddress}, our address ${ourAddress}`);

      const reassembler = new FrameReassembler();
      const decoder = new BleTelemetryDecoder();
      let authorised = false;
      let handshakeInFlight = false;
      let warnedUnauthorised = false;
      const startedAt = Date.now();
      let lastFrameAt = Date.now();

      // Measured 5-7 ms with write-without-response vs ~35 ms with response, and
      // the hub answers the seed it stored, so the cheap write is the right one.
      async function sendHandshake(seed: number): Promise<void> {
        const key = computeSessionKey(seed);
        await writeCharacteristic.writeValue(buildKeyReply(key), { type: "command" });
        await delay(ADDRESS_MATCH_DELAY_MS);
        await writeCharacteristic.writeValue(buildAddressMatch(ourAddress), { type: "command" });
      }

      await notifyCharacteristic.startNotifications();
      notifyCharacteristic.on("valuechanged", (chunk: Buffer) => {
        lastFrameAt = Date.now();
        for (const frame of reassembler.push(chunk)) {
          if (isSessionConfirmed(frame)) {
            if (!authorised) {
              console.log("ble: session confirmed — telemetry streaming");
            }
            authorised = true;
            continue;
          }

          if (!isSeedFrame(frame)) {
            const values = decoder.decode(frame);
            if (values.length > 0) {
              options.onValues(values);
            }
            continue;
          }

          if (authorised || handshakeInFlight) {
            continue;
          }
          if (!warnedUnauthorised && Date.now() - startedAt > UNAUTHORISED_HINT_AFTER_MS) {
            warnedUnauthorised = true;
            console.warn(
              "ble: hub keeps re-seeding and never confirms the session. It only accepts ONE " +
                "authorised device address at a time — clear the stored device from the bike's " +
                "dashboard, then restart this service so it can enrol."
            );
          }
          handshakeInFlight = true;
          sendHandshake(readSeed(frame))
            .catch(error => {
              console.warn("ble: handshake write failed:", (error as Error).message);
            })
            .finally(() => {
              handshakeInFlight = false;
            });
        }
      });

      // Poll the two getters. Serialised behind one flag because BlueZ rejects
      // overlapping GATT writes with org.bluez.Error.InProgress.
      let requestInFlight = false;
      requestTimer = setInterval(() => {
        if (requestInFlight) {
          return;
        }
        requestInFlight = true;
        void (async () => {
          try {
            await writeCharacteristic.writeValue(REQUEST_VEHICLE_INFO, { type: "command" });
            await delay(50);
            await writeCharacteristic.writeValue(REQUEST_ODOMETER, { type: "command" });
          } catch (error) {
            console.warn("ble: telemetry request failed:", (error as Error).message);
          } finally {
            requestInFlight = false;
          }
        })();
      }, TELEMETRY_REQUEST_INTERVAL_MS);

      disconnectCurrent = async () => {
        clearInterval(requestTimer);
        try {
          await notifyCharacteristic.stopNotifications();
        } catch {
          // already gone
        }
      };

      // Hold the session open until the link goes quiet or we're shutting down.
      while (!stopped && Date.now() - lastFrameAt < SILENCE_TIMEOUT_MS) {
        await delay(1_000);
      }
      if (!stopped) {
        console.warn("ble: no frames for 30 s — reconnecting");
      }
    } finally {
      clearInterval(requestTimer);
      disconnectCurrent = null;
      try {
        await device?.disconnect();
      } catch {
        // ignore
      }
      destroy();
    }
  }

  void (async () => {
    while (!stopped) {
      try {
        await runSession();
      } catch (error) {
        console.warn("ble: session failed:", (error as Error).message);
      }
      if (!stopped) {
        await delay(RECONNECT_DELAY_MS);
      }
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      await disconnectCurrent?.();
    },
  };
}
