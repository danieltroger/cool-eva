// GPS out of the Connectivity Hub's telemetry framing (message type 26 = 0x1A),
// shared by both transports that carry it: the BLE notify characteristic
// (src/ble/protocol.ts) and CAN id 0x410 (src/can/gps.ts). Both deliver the same
// 8-byte record — byte 0 = message type, byte 1 = sub-index — so one decoder
// serves both and there is only ever one place for the bit packing to be wrong.
//
// Pure: bytes in, values out, no I/O and no clock reads. That is what makes it
// testable by replaying captured frames when the bike is out of reach, which is
// how this decode was verified in the first place.
//
// Stateful across frames by necessity: a fix is split over three sub-frames —
// latitude (sub 0x00), longitude (sub 0x01) and UTC time (sub 0xFE), which is
// the one that completes it. Hence a class with an instance per stream.

// The one declaration of the shape every decoder in the app returns. It lives in
// can/frame.ts, which imports nothing itself, so reaching for it from here (and
// therefore from the BLE path, which re-exports it) creates no cycle.
import type { DecodedValue } from "../can/frame.ts";

export type { DecodedValue };

/** CommParser's GPS_DATA. Frames of any other type are not ours to decode. */
export const GPS_MESSAGE_TYPE = 26;

/**
 * The hub's record size, identical on both transports: anything shorter than this
 * is a truncated frame and indexing into it yields NaN. Declared here rather than
 * in either transport because both need it — ble/protocol.ts re-slices the notify
 * characteristic to it, since BlueZ does not preserve ATT notification boundaries.
 */
export const FRAME_SIZE = 8;

export class GpsMessageDecoder {
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
    // CAN 0x410 multiplexes the hub's whole message set onto one id, so the type
    // check is load-bearing there, not just belt-and-braces as it is over BLE.
    if (frame.length < FRAME_SIZE || frame[0] !== GPS_MESSAGE_TYPE) {
      return [];
    }

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
      // Two guards. The stream can carry this time sub-frame *before* either
      // coordinate sub-frame on a fresh connection (seen live over BLE), which
      // would otherwise log a bogus 0; and like the app we suppress the null
      // island it emits before it has a fix.
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
