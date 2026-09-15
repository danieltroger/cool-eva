// Energica Connectivity-Hub BLE protocol — pure decode/encode, no I/O.
//
// Reverse-engineered from Cappelle's Android app (Energica_Manuals/emapp-android:
// helpers/CommParser.java, services/ble/ConnectionManager.java,
// model/ble/SecurityAccess.java) and cross-checked against his "Energica BLE
// Connection" deck. Validated live against the bike 2026-07-26: connect, service
// discovery, notifications, frame reassembly and seed parsing all confirmed.
//
// Session flow:
//   1. hub pushes SEED  (type 0, sub 0xFF, seed = LE uint32 at bytes 2..5)
//   2. we reply  04 11 00 00 <key LE32> 00 00   with key = transform(seed)
//   3. +15 ms we send  04 11 00 FE <our 6 MAC bytes>   (the "address match")
//   4. hub answers MATCH_ATTEMPT (type 1); byte2 != 0 ⇒ session confirmed
//   5. from then on the hub PUSHES telemetry unsolicited — nothing to poll
//
// ⚠️ The hub only ever accepts ONE authorised device address, stored on the bike.
// A new device is ignored until the old one is cleared from the dashboard.

import { FRAME_SIZE, GPS_MESSAGE_TYPE, GpsMessageDecoder, type DecodedValue } from "../gps/decode.ts";
import { SuppressedFixWatcher } from "../gps/fix-watch.ts";
import { HUB_OUTPUT_TYPE, decodeHubOutput, isHubOutputFrame } from "../hub/output.ts";
import { i16le } from "../can/frame.ts";

// The GPS sub-frames are byte-identical on CAN 0x410 — which the instrument cluster
// transmits, not the hub (docs/can-0x410.md) — so their bit unpacking lives in
// ../gps/decode.ts and is shared with src/can/gps.ts rather than duplicated. The record
// size comes from there for the same reason: it is the protocol's framing, not this
// transport's.
export type { DecodedValue };

// Message types (CommParser constants). Only read-only types are handled here —
// this module deliberately contains no encoder for the commands that ACT on the
// bike (20 setChargePowerLimit, 22 setChgTermination, 23 setSpeedLimit,
// 24 setHornPulse, 27 sendFoundStations, 29 setResetTrip).
const TYPE_SEED = 0;
const TYPE_MATCH_ATTEMPT = 1;
const TYPE_VEHICLE_STATUS = 2;
// 3 is HUB_OUTPUT_TYPE, declared in ../hub/output.ts because CAN decodes it too.
const TYPE_ODOMETER = 4;

/**
 * SecurityAccess.java. Java uses a signed 32-bit arithmetic shift and relies on
 * int overflow wrapping — `>>` (not `>>>`) and the `| 0` are both load-bearing.
 *
 * ⚠️ The offset is 0xC1A0BABE (Java `offset = -1046431042`). An older note in
 * obd-garage/CAN_MAP.md had it as 0xC1A1B1BE; that is wrong and the hub silently
 * ignores every reply derived from it — no error, just endless re-seeding.
 */
export function computeSessionKey(seed: number): number {
  const mixed = ((seed & 0xaaaaaaaa) >> 1) | ((seed & 0x55555555) << 1);
  return (mixed + 0xc1a0babe) | 0;
}

export function isSeedFrame(frame: Uint8Array): boolean {
  return frame[0] === TYPE_SEED && frame[1] === 0xff;
}

export function readSeed(frame: Uint8Array): number {
  return (frame[5] << 24) | (frame[4] << 16) | (frame[3] << 8) | frame[2] | 0;
}

export function isSessionConfirmed(frame: Uint8Array): boolean {
  return frame[0] === TYPE_MATCH_ATTEMPT && frame[2] !== 0;
}

/** Frame 2 of the handshake: the answer to the hub's challenge. */
export function buildKeyReply(key: number): Buffer {
  return Buffer.from([4, 17, 0, 0, key & 0xff, (key >> 8) & 0xff, (key >> 16) & 0xff, (key >> 24) & 0xff, 0, 0]);
}

/** Frame 3 of the handshake: our own adapter address, which the hub stores. */
export function buildAddressMatch(macAddress: string): Buffer {
  const bytes = macAddress.split(":").map(part => Number.parseInt(part, 16));
  // Range-check as well as parse: "1FF:00:…" yields 511, which is an integer and
  // would then be silently truncated to 0xFF by Buffer.from.
  if (bytes.length !== 6 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`ble: malformed MAC address ${macAddress}`);
  }
  return Buffer.from([4, 17, 0, 0xfe, ...bytes]);
}

/**
 * BlueZ does not preserve ATT notification boundaries — an 8-byte record was
 * observed arriving split 3+5, which silently corrupts every later frame. So we
 * treat the characteristic as a byte stream and re-slice it ourselves.
 */
export class FrameReassembler {
  #buffered = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.#buffered = Buffer.concat([this.#buffered, chunk]);
    const frames: Buffer[] = [];
    while (this.#buffered.length >= FRAME_SIZE) {
      frames.push(this.#buffered.subarray(0, FRAME_SIZE));
      this.#buffered = this.#buffered.subarray(FRAME_SIZE);
    }
    return frames;
  }

  reset(): void {
    this.#buffered = Buffer.alloc(0);
  }
}

function unsigned32(byte3: number, byte2: number, byte1: number, byte0: number): number {
  return ((byte3 << 24) | (byte2 << 16) | (byte1 << 8) | byte0) >>> 0;
}

/**
 * Decodes the hub's pushed telemetry. Stateful because of the GPS multiplex, which
 * spreads one fix over three sub-frames — hence one decoder instance per session.
 */
export class BleTelemetryDecoder {
  #gps = new GpsMessageDecoder();
  // BLE needs its own watcher, not a share of the CAN one: the two transports have
  // separate decoders and therefore separate counts, and this is the transport where a
  // half-assembled fix was first seen (see the sub-0xFE note in ../gps/decode.ts). One
  // watcher per session, like the decoder it watches.
  #suppressedFixes = new SuppressedFixWatcher(this.#gps, "ble");

  decode(frame: Uint8Array): DecodedValue[] {
    switch (frame[0]) {
      case TYPE_VEHICLE_STATUS:
        return this.#decodeVehicleStatus(frame);
      case HUB_OUTPUT_TYPE:
        return this.#decodeOutput(frame);
      case TYPE_ODOMETER:
        return this.#decodeOdometer(frame);
      case GPS_MESSAGE_TYPE: {
        const values = this.#gps.decode(frame);
        this.#suppressedFixes.check();
        return values;
      }
      default:
        return [];
    }
  }

  #decodeVehicleStatus(frame: Uint8Array): DecodedValue[] {
    switch (frame[1]) {
      case 0x00:
        // SOC (frame[2]) and battery temp (frame[7]) duplicate CAN 0x200 at 20 Hz,
        // so they're skipped.
        //
        // 🚨 "The range estimate is not on CAN at all" stood here until #224 and was FALSE:
        // it is CAN 0x412 b2-b3, from the same cluster variable that fills this frame's own
        // range slot, and it is decoded as `range_can_km` (src/can/cluster-range.ts). That
        // those two SOC and temperature slots agree with the BMS's own 0x200 is what tested
        // the cluster fills this message faithfully — docs/can-0x412.md.
        //
        // 🚨 "…and the vehicle state machine [is] not on CAN at all" stood here until
        // 2026-09-14 and was FALSE. It is CAN 0x101 `VCU_VEHICLE_STS` at 100 Hz, decoded
        // since (src/can/vehicle-status.ts). The CAN keys carry `_can` so these two keep
        // their history and the two transports can be compared rather than merged. ⚠️ They
        // do NOT agree completely: this path has logged `vehicle_state` 4 and 0, and
        // `vehicle_substate` 0, which the CAN byte never produces — 7 rows of 816.
        return [
          { key: "vehicle_state", value: frame[3] },
          { key: "vehicle_substate", value: frame[4] },
          { key: "range_km", value: (frame[6] << 8) | frame[5] },
        ];
      case 0x01:
        return [
          { key: "avg_consumption_wh_km", value: i16le(frame[4], frame[5]) / 10 },
          { key: "km_per_kwh", value: i16le(frame[6], frame[7]) / 100 },
        ];
      case 0x02:
        return [{ key: "kwh_per_100km", value: ((frame[3] << 8) | frame[2]) / 100 }];
      default:
        return [];
    }
  }

  // The unpacking is ../hub/output.ts, shared with the CAN 0x410 reader that decodes
  // the byte-identical record off the bus. Only the keys differ: this transport keeps
  // the bare names and CAN's carries `_can`, so the two stay comparable.
  #decodeOutput(frame: Uint8Array): DecodedValue[] {
    if (!isHubOutputFrame(frame)) {
      return [];
    }
    const output = decodeHubOutput(frame);
    return [
      { key: "motor_torque_nm", value: output.torqueNm },
      { key: "motor_power_kw", value: output.powerKw },
    ];
  }

  #decodeOdometer(frame: Uint8Array): DecodedValue[] {
    const raw = unsigned32(frame[5], frame[4], frame[3], frame[2]);
    if (frame[1] === 0xfe) {
      return [{ key: "trip_km", value: raw / 10 }];
    }
    if (frame[1] === 0x00) {
      return [{ key: "odometer_km", value: raw }];
    }
    return [];
  }
}
