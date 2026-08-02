import { createBluetooth, type Adapter, type GattCharacteristic } from "node-ble";
import { ensureBluetoothAdapterUp } from "./adapter.ts";
import { syncSystemClockFromGps } from "../gps/clock.ts";
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
// bike's GPS receiver. Position also reaches us over CAN 0x410 (src/can/gps.ts,
// added 2026-08-02), so this link is no longer the only source of it — but motor
// torque/power (message type 3) is pushed over Bluetooth only and appears on no
// CAN frame we know of, which is why the link stays.

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

// How many unanswered handshakes before we also try the hub's own address (see
// nextEnrolmentAddress — that write is destructive to an existing pairing).
const ENROL_FALLBACK_AFTER_ATTEMPTS = 6;

export interface BleClientOptions {
  /** Hub address, e.g. "F8:8A:5E:09:D3:B4". Empty ⇒ discover by advertised name. */
  macAddress?: string;
  onValues: (values: DecodedValue[]) => void;
}

export interface BleClient {
  stop: () => Promise<void>;
}

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Answer the hub's challenge, then claim the authorised-device slot.
 *
 * Write-without-response: measured 5-7 ms versus ~35 ms with response, and the
 * hub validates against the seed it stored, so the cheap write is the right one.
 */
async function sendHandshake(writeCharacteristic: GattCharacteristic, seed: number, address: string): Promise<void> {
  await writeCharacteristic.writeValue(buildKeyReply(computeSessionKey(seed)), { type: "command" });
  await delay(ADDRESS_MATCH_DELAY_MS);
  await writeCharacteristic.writeValue(buildAddressMatch(address), { type: "command" });
}

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
      // Scanning for the whole session burns power and can degrade the very link
      // we just established. Each reconnect builds a fresh createBluetooth(), so
      // the isDiscovering() check above would otherwise just observe a scan that
      // was never turned off and leave it running.
      try {
        await adapter.stopDiscovery();
      } catch (error) {
        console.log("ble: stopDiscovery failed:", (error as Error).message);
      }

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
      // say which claimed the slot.
      //
      // So: lead with our own address (what the deck documents) and only start
      // offering the hub's after several unanswered attempts. That frame writes
      // the bike's single authorised-device slot, so alternating eagerly could
      // un-enrol an already-paired Pi over some unrelated hiccup — and the only
      // way back is physically resetting the slot from the dashboard.
      const addressCandidates = [ourAddress, hubAddress];
      let handshakeAttempts = 0;

      function nextEnrolmentAddress(): string {
        if (handshakeAttempts < ENROL_FALLBACK_AFTER_ATTEMPTS) {
          return ourAddress;
        }
        if (handshakeAttempts === ENROL_FALLBACK_AFTER_ATTEMPTS) {
          console.warn(
            `ble: ${ENROL_FALLBACK_AFTER_ATTEMPTS} handshakes unanswered — also offering the hub's own ` +
              "address now. If this bike was already paired to this Pi, that pairing may be replaced."
          );
        }
        return addressCandidates[handshakeAttempts % addressCandidates.length];
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
              const satelliteTime = values.find(value => value.key === "gps_epoch_s");
              if (satelliteTime) {
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
          const address = nextEnrolmentAddress();
          handshakeAttempts += 1;
          sendHandshake(writeCharacteristic, readSeed(frame), address)
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
