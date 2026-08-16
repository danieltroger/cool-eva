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

/**
 * The earliest satellite UTC that could possibly be real. A fix from before this
 * bike had any telemetry on it did not happen.
 *
 * A FLOOR, deliberately, and there is no matching ceiling anywhere. A floor cannot
 * expire — it only becomes more conservative as it ages, never wrong — whereas the
 * "year 24 to 99" window this replaced was a ceiling in disguise: it let a corrupted
 * year byte of 60 through as 2060 and stepped the Pi's clock 34 years forward. What
 * an absurd year is caught by instead is corroboration, in ./clock-gate.ts, which
 * compares readings with each other and names no year at all.
 *
 * What it is actually for is the GPS week-number rollover — the one failure that puts
 * a receiver in a *past* year, reading 1980 or 1999 — and a zeroed date field, which
 * decodes as 2000. All three are decades below this.
 *
 * ⚠️ Set to the start of 2026, NOT to the day this was written, and the difference
 * matters. This module also runs over history: scripts/decrypt-log.ts rebuilds
 * segments sealed weeks ago and scripts/replay-capture.ts replays old candumps, and a
 * floor at "today" would silently drop gps_epoch_s out of every one of them. It has to
 * sit below the oldest data the repo can be handed, which is April 2026 (see the
 * legacy coolant history in public/lib/bounds.js); the first ride in rides.db is
 * 2026-08-02. The check in scripts/check-gps-clock.ts replays 2026-08 sequences and
 * fails if this is ever raised past them.
 */
export const GPS_UTC_FLOOR_EPOCH_S = Date.UTC(2026, 0, 1) / 1000;

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

  /**
   * Time sub-frames that produced no position because a coordinate half was
   * missing. Kept as a plain counter rather than logged from here, because this
   * class is pure — the transports watch it and complain (see ../can/gps.ts).
   *
   * Expected to stay at 0 in normal operation apart from the first cycle or two
   * after a connection comes up. A number that climbs steadily means the hub has
   * stopped sending one of the coordinate sub-frames, which is worth knowing:
   * before 2026-08-16 that condition was invisible because the decoder papered
   * over it with the last value it had.
   */
  suppressedFixes = 0;

  /** Fixes actually published, so a watcher can talk about the RATIO, not a raw count. */
  emittedFixes = 0;

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
      // 16 bits of two's complement: 6 from b2, 8 from b3, 2 from b4.
      //
      // ⚠️ Read as a 15-bit magnitude plus a sign bit until 2026-08-16, which is
      // what CommParser's field names suggest. rides.db says otherwise, and says it
      // unambiguously: 145 rows sit between −32 756 and −32 767 and NOTHING sits
      // between −13 and −1. Under sign-magnitude that gap is impossible; under two's
      // complement it is the only possible outcome, because a true −1 m becomes
      // 0xFFFF and decodes as −32 767. The run straddling one of them reads
      //     3, 5, 3, 1, [−32767, −32765, −32762, −32764, −32766], 0
      // which is a bike at sea level, once the bracket is read as −1, −3, −6, −4, −2.
      //
      // (CommParser shifts a *signed* byte for the middle field, which sign-extends
      // and corrupts the value; masking to the declared width is clearly the intent.)
      const raw = ((frame[2] >> 2) & 63) | (frame[3] << 6) | ((frame[4] & 3) << 14);
      const altitude = raw >= 0x8000 ? raw - 0x10000 : raw;
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
      // Three guards. The stream can carry this time sub-frame *before* either
      // coordinate sub-frame on a fresh connection (seen live over BLE), which
      // would otherwise log a bogus 0; like the app we suppress the null island it
      // emits before it has a fix; and — since 2026-08-16 — both coordinate
      // sub-frames must have arrived within THIS cycle, not merely at some point
      // in the past.
      //
      // ⚠️ The have-flags used to latch for the life of the stream, which made a
      // fix out of whatever the decoder happened to be holding. A latitude
      // sub-frame that stopped arriving was re-emitted as current indefinitely,
      // paired with a fresh longitude — a position that was never anywhere. The
      // #fix check cannot catch it, because #fix is set by the LONGITUDE sub-frame
      // (0x01) and so stays healthy exactly while the latitude is the dead half.
      //
      // rides.db has 84 consecutive-sample transitions implying over 250 km/h at
      // more than 3× the bike's own speedometer, including single-sample jumps of
      // 21 km on latitude alone and 6 km on longitude alone, each going straight
      // back where it came from on the next sample. That is one axis current and
      // one axis not.
      //
      // Expressed in sub-frames rather than milliseconds on purpose: the hub sends
      // 00, 01 and FE in a strict 1:1:1 cycle (measured 2026-08-02: 72/72/72 in
      // 40 s with a BLE session up, 58/58/58 in 30 s with none), so "since the last
      // fix we emitted" IS the hub's own idea of one fix. A wall-clock window would
      // be an arbitrary translation of that — and this decoder is pure, so it has
      // no clock to read anyway.
      const bothAxesFresh = this.#haveLatitude && this.#haveLongitude && this.#fix !== 0;
      if (bothAxesFresh && (latitude !== 0 || longitude !== 0)) {
        values.push({ key: "gps_lat", value: latitude }, { key: "gps_lon", value: longitude });
        this.emittedFixes += 1;
      } else if (this.#fix !== 0 && !(this.#haveLatitude && this.#haveLongitude)) {
        // Counted ONLY for the case the counter is named after: the hub has a fix and
        // is still sending time, but one of the coordinate sub-frames did not arrive.
        // Not for #fix === 0 — that is a garage, where the hub sends all three
        // sub-frames perfectly well and simply has nothing to report (the committed
        // 2026-08-02 capture is 90 s of exactly that) — and not for the null island
        // before the first fix. Counting those would make ../can/gps.ts cry "the hub
        // is only sending half a position" at every ride that starts indoors.
        this.suppressedFixes += 1;
      }
      // Consume them either way: a fix we refused is not a reason to blend the next
      // one out of the same stale half.
      this.#haveLatitude = false;
      this.#haveLongitude = false;

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
   * ranges are all sane.
   *
   * What "sane" means here is narrower than it used to be, and on purpose. This
   * decoder answers "is this a syntactically valid date at or after the floor",
   * nothing more; whether the value is trustworthy enough to STEP THE CLOCK to is
   * ./clock-gate.ts's question, because answering it needs several frames and a
   * monotonic clock, neither of which belongs in a pure decoder.
   *
   * That split is also why a value the gate will refuse is still returned rather
   * than dropped: gps_epoch_s is logged raw against every row's own timestamp, so
   * a frame that lies about the year stays visible in the database instead of
   * vanishing. All four corrupt frames behind the 2060 bursts were found that way.
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
      milliseconds < 1000;
    if (!inRange) {
      return null;
    }
    // Date.UTC silently rolls impossible dates over (31 Apr becomes 1 May), so
    // verify the fields survive a round trip rather than trusting the range check
    // alone.
    const epochMilliseconds = Date.UTC(2000 + year, month - 1, day, hours, minutes, seconds, milliseconds);
    const roundTripped = new Date(epochMilliseconds);
    if (roundTripped.getUTCMonth() !== month - 1 || roundTripped.getUTCDate() !== day) {
      return null;
    }
    // The floor, and deliberately no ceiling. `year >= 24 && year < 100` used to
    // stand here, and the upper half of it was the bug: a corrupted year byte of
    // 60 sailed through as 2060 and the clock was stepped 34 years forward, which
    // cost 49 772 rows. Replacing it with a tighter window — 2024 to 2035, say —
    // just moves the expiry date. What an implausible year is caught by now is
    // corroboration across frames in ./clock-gate.ts, which names no year at all.
    if (epochMilliseconds / 1000 < GPS_UTC_FLOOR_EPOCH_S) {
      return null;
    }
    return epochMilliseconds / 1000;
  }
}
