import { createBluetooth, type Adapter } from "node-ble";
import { ensureBluetoothAdapterUp } from "./adapter.ts";
import { syncSystemClockFromGps } from "./clock.ts";
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

// Every Energica hub advertises under this name, so an unconfigured install can
// find its own bike rather than needing a hard-coded address.
const HUB_NAME_PATTERN = /energica/i;
const DISCOVERY_TIMEOUT_MS = 40_000;

export interface BleClientOptions {
  /** Hub address, e.g. "F8:8A:5E:09:D3:B4". Empty ⇒ discover by advertised name. */
  macAddress?: string;
  onValues: (values: DecodedValue[]) => void;
}

export interface BleClient {
  stop: () => Promise<void>;
}

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

async function discoverHubAddress(adapter: Adapter): Promise<string> {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const address of await adapter.devices()) {
      try {
        const name = await (await adapter.getDevice(address)).getName();
        if (HUB_NAME_PATTERN.test(name)) {
          console.log(`ble: discovered hub "${name}" at ${address}`);
          return address;
        }
      } catch (error) {
        // Routine during a scan: the device dropped out of range, or advertises
        // no name at all. Logged anyway so a hub we *should* have matched but
        // couldn't read is visible rather than silently skipped.
        console.log(`ble: skipping ${address} while scanning: ${(error as Error).message}`);
      }
    }
    await delay(1_000);
  }
  throw new Error("no Energica hub found while scanning — is the bike awake and in range?");
}

export function startBleClient(options: BleClientOptions): BleClient {
  let stopped = false;
  let disconnectCurrent: (() => Promise<void>) | null = null;

  async function runSession(): Promise<void> {
    await ensureBluetoothAdapterUp();
    const { bluetooth, destroy } = createBluetooth();
    let device: Awaited<ReturnType<Awaited<ReturnType<typeof bluetooth.defaultAdapter>>["waitDevice"]>> | null = null;
    let requestTimer: ReturnType<typeof setInterval> | undefined;

    try {
      const adapter = await bluetooth.defaultAdapter();
      if (!(await adapter.isDiscovering())) {
        await adapter.startDiscovery();
      }

      const hubAddress = options.macAddress || (await discoverHubAddress(adapter));
      device = await adapter.waitDevice(hubAddress);
      await device.connect();

      const ourAddress = await adapter.getAddress();
      const gattServer = await device.gatt();
      const service = await gattServer.getPrimaryService(SERVICE_UUID);
      const notifyCharacteristic = await service.getCharacteristic(NOTIFY_CHARACTERISTIC_UUID);
      const writeCharacteristic = await service.getCharacteristic(WRITE_CHARACTERISTIC_UUID);
      console.log(`ble: connected to ${hubAddress}, our address ${ourAddress}`);

      const reassembler = new FrameReassembler();
      const decoder = new BleTelemetryDecoder();
      let authorised = false;
      let handshakeInFlight = false;
      let warnedUnauthorised = false;
      const startedAt = Date.now();
      let lastFrameAt = Date.now();

      // Which address the hub wants in the third frame is genuinely ambiguous:
      // the BLE deck says "the app sends its OWN MAC", but the decompiled app
      // reads it from the *connected device* (the hub). The one enrolment we've
      // observed was mid-way through a probe that alternated both, so we can't
      // say which claimed the slot. Alternating costs nothing and means a fresh
      // bike enrols either way — it stops as soon as the hub confirms.
      const addressCandidates = [ourAddress, hubAddress];
      let handshakeAttempts = 0;

      // Measured 5-7 ms with write-without-response vs ~35 ms with response, and
      // the hub answers the seed it stored, so the cheap write is the right one.
      async function sendHandshake(seed: number): Promise<void> {
        const key = computeSessionKey(seed);
        const address = addressCandidates[handshakeAttempts % addressCandidates.length];
        handshakeAttempts += 1;
        await writeCharacteristic.writeValue(buildKeyReply(key), { type: "command" });
        await delay(ADDRESS_MATCH_DELAY_MS);
        await writeCharacteristic.writeValue(buildAddressMatch(address), { type: "command" });
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
              // Measure the Pi's clock error *before* handing the fix to the
              // clock sync, or a successful step would read back as zero drift.
              const satelliteTime = values.find(value => value.key === "gps_epoch_s");
              if (satelliteTime) {
                values.push({ key: "gps_time_offset_s", value: satelliteTime.value - Date.now() / 1000 });
                void syncSystemClockFromGps(satelliteTime.value);
              }
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
        } catch (error) {
          console.log("ble: stopNotifications failed (link already gone):", (error as Error).message);
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
      } catch (error) {
        console.log("ble: disconnect failed (already dropped):", (error as Error).message);
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
