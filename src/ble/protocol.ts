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

export interface DecodedValue {
  key: string;
  value: number;
}

/** Fixed record size of every frame on the notify characteristic. */
export const FRAME_SIZE = 8;

// Message types (CommParser constants). Only read-only types are handled here —
// this module deliberately contains no encoder for the commands that ACT on the
// bike (20 setChargePowerLimit, 22 setChgTermination, 23 setSpeedLimit,
// 24 setHornPulse, 27 sendFoundStations, 29 setResetTrip).
const TYPE_SEED = 0;
const TYPE_MATCH_ATTEMPT = 1;
const TYPE_VEHICLE_STATUS = 2;
const TYPE_OUTPUT = 3;
const TYPE_ODOMETER = 4;
const TYPE_GPS_DATA = 26;

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

function signed16(high: number, low: number): number {
  return ((high << 24) >> 16) | (low & 0xff) | 0;
}

function unsigned32(byte3: number, byte2: number, byte1: number, byte0: number): number {
  return ((byte3 << 24) | (byte2 << 16) | (byte1 << 8) | byte0) >>> 0;
}

/**
 * Decodes the hub's pushed telemetry. Stateful because a GPS fix is split over
 * three sub-frames: latitude (sub 0), longitude (sub 1) and finally UTC time
 * (sub 0xFE), which is the one that completes the fix.
 */
export class BleTelemetryDecoder {
  #latitudeSign = 1;
  #latitudeDegrees = 0;
  #latitudeMinutes = 0;
  #latitudeDeciMilliminutes = 0;
  #haveLatitude = false;
  #longitudeSign = 1;
  #longitudeDegrees = 0;
  #longitudeMinutes = 0;
  #longitudeDeciMilliminutes = 0;
  #haveLongitude = false;
  #fix = 0;

  decode(frame: Uint8Array): DecodedValue[] {
    switch (frame[0]) {
      case TYPE_VEHICLE_STATUS:
        return this.#decodeVehicleStatus(frame);
      case TYPE_OUTPUT:
        return this.#decodeOutput(frame);
      case TYPE_ODOMETER:
        return this.#decodeOdometer(frame);
      case TYPE_GPS_DATA:
        return this.#decodeGps(frame);
      default:
        return [];
    }
  }

  #decodeVehicleStatus(frame: Uint8Array): DecodedValue[] {
    switch (frame[1]) {
      case 0x00:
        // SOC (frame[2]) and battery temp (frame[7]) duplicate CAN 0x200 at 20 Hz,
        // so they're skipped. The range estimate and the vehicle state machine are
        // not on CAN at all — 0x201 only carries *charge* state, not this.
        return [
          { key: "vehicle_state", value: frame[3] },
          { key: "vehicle_substate", value: frame[4] },
          { key: "range_km", value: (frame[6] << 8) | frame[5] },
        ];
      case 0x01:
        return [
          { key: "avg_consumption_wh_km", value: signed16(frame[5], frame[4]) / 10 },
          { key: "km_per_kwh", value: signed16(frame[7], frame[6]) / 100 },
        ];
      case 0x02:
        return [{ key: "kwh_per_100km", value: ((frame[3] << 8) | frame[2]) / 100 }];
      default:
        return [];
    }
  }

  #decodeOutput(frame: Uint8Array): DecodedValue[] {
    if (frame[1] !== 0xff) {
      return [];
    }
    const revolutionsPerMinute = signed16(frame[5], frame[4]);
    const torqueNm = signed16(frame[7], frame[6]);
    return [
      { key: "motor_torque_nm", value: torqueNm },
      { key: "motor_power_kw", value: (torqueNm * 2 * Math.PI * revolutionsPerMinute) / 60000 },
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

  #decodeGps(frame: Uint8Array): DecodedValue[] {
    if (frame[1] === 0x00) {
      this.#latitudeDeciMilliminutes = ((frame[4] >> 2) & 63) | (frame[5] << 6);
      this.#latitudeMinutes = frame[6] & 63;
      this.#latitudeDegrees = ((frame[6] >> 6) & 3) | ((frame[7] & 63) << 2);
      this.#latitudeSign = ((frame[7] >> 6) & 1) !== 0 ? -1 : 1;
      this.#haveLatitude = true;
      return [
        { key: "gps_course_deg", value: frame[2] | ((frame[3] & 1) << 8) },
        // ⚠️ Deliberate deviation from CommParser, which shifts by 8 here.
        // This sub-frame is packed contiguously: course is b2 + b3 bit0 (9 bits),
        // speed is b3 bits 1-7 then b4 bits 0-1 (9 bits), and latitude's
        // deci-milliminutes resume at b4 bit2. So the high bits belong at bit 7.
        // With <<8, value-bit 7 is permanently zero and anything from 128 km/h up
        // reads 128 too high (130 -> 258). Below 128 the two are identical, which
        // is how the app gets away with it.
        { key: "gps_speed_kmh", value: ((frame[3] >> 1) & 0x7f) | ((frame[4] & 3) << 7) },
      ];
    }

    if (frame[1] === 0x01) {
      this.#longitudeDeciMilliminutes = ((frame[4] >> 2) & 63) | (frame[5] << 6);
      this.#longitudeMinutes = frame[6] & 63;
      this.#longitudeDegrees = ((frame[6] >> 6) & 3) | ((frame[7] & 63) << 2);
      this.#longitudeSign = ((frame[7] >> 6) & 1) !== 0 ? -1 : 1;
      this.#haveLongitude = true;
      // 15-bit magnitude: 6 bits from b2, 8 from b3, 1 from b4, then a sign bit.
      // (CommParser shifts a *signed* byte here, which sign-extends and corrupts
      // the value; masking to the declared field width is clearly the intent.)
      const magnitude = ((frame[2] >> 2) & 63) | (frame[3] << 6) | ((frame[4] & 1) << 14);
      const altitude = ((frame[4] >> 1) & 1) !== 0 ? -magnitude : magnitude;
      this.#fix = frame[2] & 3;
      return [
        { key: "gps_fix", value: this.#fix },
        { key: "gps_altitude_m", value: altitude },
      ];
    }

    if (frame[1] === 0xfe) {
      const latitude =
        this.#latitudeSign *
        (this.#latitudeDegrees + (this.#latitudeMinutes + this.#latitudeDeciMilliminutes / 10000) / 60);
      const longitude =
        this.#longitudeSign *
        (this.#longitudeDegrees + (this.#longitudeMinutes + this.#longitudeDeciMilliminutes / 10000) / 60);
      const satellites = (frame[7] >> 3) & 31;
      const values: DecodedValue[] = [{ key: "gps_satellites", value: satellites }];
      // Two guards. The hub can send this time sub-frame *before* either
      // coordinate sub-frame on a fresh connection (seen live), which would
      // otherwise log a bogus 0; and like the app we suppress the null island
      // it emits before it has a fix.
      // The have-flags latch, so a live fix is required too: without it a hub
      // that stops sending the coordinate sub-frames while still sending this
      // one would replay the last known position forever.
      const haveBoth = this.#haveLatitude && this.#haveLongitude && this.#fix !== 0;
      if (haveBoth && (latitude !== 0 || longitude !== 0)) {
        values.push({ key: "gps_lat", value: latitude }, { key: "gps_lon", value: longitude });
      }

      const epochSeconds = this.#decodeUtc(frame, satellites);
      if (epochSeconds !== null) {
        values.push({ key: "gps_epoch_s", value: epochSeconds });
      }
      return values;
    }

    return [];
  }

  /**
   * Satellite UTC out of the GPS sub-0xFE frame, as epoch seconds.
   *
   * This is the Pi's only trustworthy time source: it has no RTC, so after a
   * boot with no network every row gets stamped from a bogus clock (a real ride
   * once landed years in the past). Returns null unless the fix and the field
   * ranges are all sane — a wrong time is worse than no time, since we act on it.
   */
  #decodeUtc(frame: Uint8Array, satellites: number): number | null {
    if (this.#fix === 0 || satellites < 4) {
      return null;
    }
    const milliseconds = frame[2] | ((frame[3] & 3) << 8);
    const seconds = (frame[3] >> 2) & 63;
    const minutes = frame[4] & 63;
    const hours = ((frame[4] >> 6) & 3) | ((frame[5] & 7) << 2);
    const day = (frame[5] >> 3) & 31;
    const month = frame[6] & 15;
    const year = ((frame[6] >> 4) & 15) | ((frame[7] & 7) << 4);

    const inRange =
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31 &&
      hours < 24 &&
      minutes < 60 &&
      seconds < 60 &&
      milliseconds < 1000 &&
      year >= 24 &&
      year < 100;
    if (!inRange) {
      return null;
    }
    // Date.UTC silently rolls impossible dates over (31 Apr becomes 1 May), and
    // we step the system clock from this, so verify the fields survive a round
    // trip rather than trusting the range check alone.
    const epochMilliseconds = Date.UTC(2000 + year, month - 1, day, hours, minutes, seconds, milliseconds);
    const roundTripped = new Date(epochMilliseconds);
    if (roundTripped.getUTCMonth() !== month - 1 || roundTripped.getUTCDate() !== day) {
      return null;
    }
    return epochMilliseconds / 1000;
  }
}
