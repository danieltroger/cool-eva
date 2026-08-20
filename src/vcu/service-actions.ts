// The pure half of the three SERVICE ACTIONS — things that change ECU state without
// being a calibration write: read and interpret the on-bike service stamp, decide
// whether this Pi's clock is fit to be copied anywhere, and build the OBD Mode 04
// request that clears stored trouble codes.
//
// Numbers in, numbers out. No socket, no clock read of its own — the caller passes
// what it sampled, the same split src/vcu/service-gate.ts uses and for the same
// reason: with the bike a week away (2026-08-16), a decision that lives in a pure
// function is a decision that can be reviewed at all.
//
// ── ⚠️ What is proven and what is not ────────────────────────────────────────
//  • ✅ The stamp's ADDRESSES and ENCODING are decompiled from Energica's own service
//    tool (`ControlMotorbikeOverview_AvailableActions.GetMotorbikeService()`,
//    obd-garage/SERVICE_RESET.md §2) — four bank-1 WORDs on A8, ids 1000-1003, the
//    date being a 32-bit count of seconds since 2000-01-01 UTC.
//  • ❌ Not one of those four identifiers has ever been read off this bike. The sweep
//    covers indices 1…277 and these are 1000…1003, which is outside it entirely. So
//    "A8 answers these" is an expectation, not an observation, and the failure mode
//    if it is wrong is a negative response — which SERVICE_RESET.md §2 says the tool
//    itself treats as "this bike does not have the feature".
//  • ❌ Mode 04 has never been sent by anything in this repo.

import { toHex } from "./param-codec.ts";

/**
 * The four bank-1 identifiers on A8 that hold the last-service stamp.
 *
 * ⚠️ These are OUTSIDE params.ecf's 1…277, so nothing in src/vcu/param-table.ts
 * describes them and nothing ever will — the name table is that file's contents. They
 * are named here instead, with their provenance, rather than being smuggled into a
 * table that claims a different source.
 *
 * The two halves are little-endian ACROSS the pair: `value = (high << 16) | low`,
 * per the decompiled `num = (date2 << 16) | date1`.
 */
export const SERVICE_STAMP_IDENTIFIERS = {
  dateLow: { index: 1000, identifier: 0x13e8 },
  dateHigh: { index: 1001, identifier: 0x13e9 },
  odometerLow: { index: 1002, identifier: 0x13ea },
  odometerHigh: { index: 1003, identifier: 0x13eb },
} as const;

/** The micro that owns the stamp and the routine that writes it. Not derivable from any index range. */
export const SERVICE_STAMP_MICRO = "A8";

/**
 * Epoch of the bike's service date: 2000-01-01 00:00:00 UTC, in Unix milliseconds.
 *
 * `Date.UTC` rather than a literal, so it cannot be wrong by a timezone — the whole
 * bug class this repo keeps tripping over (`src/gps/decode.ts` round-trips through
 * `Date.UTC` for exactly this reason).
 */
const SERVICE_DATE_EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0);

/** The stamp as the bike holds it, and as a human reads it. */
export interface ServiceStamp {
  /** The four raw WORDs, in the order they were read. Kept whole: they are the only primary evidence. */
  raw: { dateLow: number; dateHigh: number; odometerLow: number; odometerHigh: number };
  /** Seconds since 2000-01-01 UTC, as stored. */
  dateSeconds: number;
  /** …as an ISO instant, or null when the number cannot be one (see `implausible`). */
  dateIso: string | null;
  /** The odometer as stored. Units are per market — km on a European bike, miles on a USA one. */
  odometer: number;
  /**
   * Why this stamp should not be believed, or null. Non-null does NOT mean the read
   * failed — the bytes are real and are shown either way. It means the number they
   * make is not a date a motorcycle can have been serviced on, which is a fact worth
   * seeing rather than a reason to hide the reading.
   */
  implausible: string | null;
}

/**
 * The window a last-service date can credibly fall in.
 *
 * The floor is the model year: this is a 2021 Eva Ribelle, so nothing was serviced on
 * it in 2019. The ceiling is "not in the future", passed in by the caller rather than
 * read here, because this module owns no clock.
 */
const EARLIEST_CREDIBLE_SERVICE_MS = Date.UTC(2019, 0, 1);

/**
 * Interprets the four WORDs. Pure.
 *
 * `nowMs` is the caller's wall clock and is used only to say "that is in the future".
 * A Pi whose own clock is wrong will therefore mislabel a good stamp — which is
 * exactly why `checkPiClock` below exists and why the page shows both.
 */
export function interpretServiceStamp(
  raw: { dateLow: number; dateHigh: number; odometerLow: number; odometerHigh: number },
  nowMs: number
): ServiceStamp {
  const dateSeconds = ((raw.dateHigh << 16) >>> 0) + raw.dateLow;
  const odometer = ((raw.odometerHigh << 16) >>> 0) + raw.odometerLow;
  const stampMs = SERVICE_DATE_EPOCH_MS + dateSeconds * 1000;
  const implausible = describeImplausibleStamp(dateSeconds, stampMs, nowMs);
  return {
    raw,
    dateSeconds,
    // Still rendered when implausible — an ISO string of 2087 tells you far more
    // about what went wrong than a null does. Only a value `Date` cannot represent
    // at all is withheld.
    dateIso: Number.isFinite(stampMs) ? new Date(stampMs).toISOString() : null,
    odometer,
    implausible,
  };
}

function describeImplausibleStamp(dateSeconds: number, stampMs: number, nowMs: number): string | null {
  if (dateSeconds === 0) {
    // A perfectly ordinary reading, and the most likely one on a bike that has never
    // had a service point set. Said plainly rather than rendered as 2000-01-01, which
    // would look like a real service on New Year's Day 2000.
    return "reads zero — no service point has ever been set on this bike, or A8 answered with an empty cell";
  }
  if (dateSeconds === 0xffffffff) {
    return "reads 0xFFFFFFFF — an erased EEPROM cell, not a date";
  }
  if (stampMs < EARLIEST_CREDIBLE_SERVICE_MS) {
    return `decodes to ${new Date(stampMs).toISOString()}, before this motorcycle existed`;
  }
  if (stampMs > nowMs) {
    return `decodes to ${new Date(stampMs).toISOString()}, which is in the future — either the bike's RTC is wrong, or this Pi's clock is`;
  }
  return null;
}

/**
 * How far the Pi's clock may be from satellite time and still be worth copying.
 *
 * src/gps/clock.ts steps the system clock whenever it disagrees with GPS by more than
 * 60 s, so a disciplined Pi is inside that by construction. 60 s is used here too:
 * anything larger means the step has not happened yet (no root, sync switched off,
 * the 5-minute hold-off), and "we know the clock is wrong and have not fixed it" is
 * not a clock to stamp a service record with.
 */
const CLOCK_AGREEMENT_LIMIT_SECONDS = 60;

/**
 * How stale a GPS reading may be and still vouch for the clock.
 *
 * Satellite time arrives at ~1.8 Hz over CAN 0x410 and over BLE. Two minutes is
 * generous — it covers a bike in a garage where the fix comes and goes — while still
 * refusing to accept "we had a fix at some point today" as evidence about now.
 */
const GPS_EVIDENCE_MAX_AGE_MS = 120_000;

/**
 * The window a plausible date falls in, as an absolute backstop.
 *
 * ⚠️ This exists because of a real incident, not a hypothetical: a bug in the GPS
 * date decode stamped **49 772 rows in this bike's own log as the year 2060**, and
 * that is being fixed in a concurrent PR. So "the Pi's clock said something absurd
 * and everything downstream believed it" is the documented behaviour of this
 * hardware, not a worry.
 *
 * The floor is the day this check was written; a Pi with no RTC boots to a filesystem
 * timestamp, which cannot be later than the deploy that put this file there. The
 * ceiling is deliberately close — ten years — because the failure it is aimed at
 * overshoots by decades, and because a check that expires loudly in 2036 is better
 * than one that would have waved 2060 through.
 */
const PLAUSIBLE_CLOCK_FLOOR_MS = Date.UTC(2026, 7, 16);
const PLAUSIBLE_CLOCK_CEILING_MS = Date.UTC(2036, 7, 16);

/** What the caller sampled about time. Everything is passed in; nothing is read here. */
export interface PiClockEvidence {
  /** `Date.now()` on the Pi, milliseconds. */
  systemEpochMs: number;
  /** `gps_epoch_s` as last decoded, or null if it has never arrived. */
  gpsEpochSeconds: number | null;
  /** Monotonic age of that reading in ms, or null. NEVER a `Date.now()` difference — see src/monotonic.ts. */
  gpsAgeMs: number | null;
}

/** Whether this Pi's clock may be copied into a motorcycle. */
export type PiClockVerdict =
  | { trustworthy: true; iso: string; offsetFromGpsSeconds: number }
  /** Why not, one sentence per reason, already phrased for the page. */
  | { trustworthy: false; iso: string; reasons: string[] };

/**
 * Decides whether this Pi's wall clock is fit to be written into the bike's RTC.
 *
 * Fails closed, like src/vcu/service-gate.ts: no GPS evidence is a REFUSAL, not a
 * pass, because a Pi with no RTC and no fix is precisely the machine whose clock is
 * wrong. The cost is that this refuses in a garage with no sky view — which is the
 * right answer, since that Pi genuinely does not know what time it is.
 */
export function checkPiClock(evidence: PiClockEvidence): PiClockVerdict {
  const iso = Number.isFinite(evidence.systemEpochMs) ? new Date(evidence.systemEpochMs).toISOString() : "(not a date)";
  const reasons: string[] = [];

  if (!Number.isFinite(evidence.systemEpochMs)) {
    reasons.push("this Pi's clock does not read as a time at all");
  } else if (evidence.systemEpochMs < PLAUSIBLE_CLOCK_FLOOR_MS) {
    reasons.push(
      `this Pi's clock reads ${iso}, before this code was written — it has no RTC and has not been set since boot`
    );
  } else if (evidence.systemEpochMs > PLAUSIBLE_CLOCK_CEILING_MS) {
    reasons.push(
      `this Pi's clock reads ${iso}, which is implausibly far ahead — a GPS date-decode bug once stamped 49 772 rows of this bike's log as the year 2060`
    );
  }

  if (evidence.gpsEpochSeconds === null || evidence.gpsAgeMs === null) {
    reasons.push("no satellite time has arrived, so there is nothing to check this Pi's clock against");
  } else if (evidence.gpsAgeMs > GPS_EVIDENCE_MAX_AGE_MS) {
    reasons.push(
      `the last satellite time arrived ${Math.round(evidence.gpsAgeMs / 1000)} s ago, too long to vouch for the clock now`
    );
  }

  const offsetFromGpsSeconds =
    evidence.gpsEpochSeconds === null ? Number.NaN : evidence.gpsEpochSeconds - evidence.systemEpochMs / 1000;
  if (Number.isFinite(offsetFromGpsSeconds) && Math.abs(offsetFromGpsSeconds) > CLOCK_AGREEMENT_LIMIT_SECONDS) {
    reasons.push(
      `this Pi's clock is ${offsetFromGpsSeconds.toFixed(0)} s away from satellite time — src/gps/clock.ts steps it past ${CLOCK_AGREEMENT_LIMIT_SECONDS} s, so it has not managed to`
    );
  }

  if (reasons.length > 0) {
    return { trustworthy: false, iso, reasons };
  }
  return { trustworthy: true, iso, offsetFromGpsSeconds };
}

// ── Setting the bike's own clock ────────────────────────────────────────────
//
// ✅ The mechanism exists, and it is not a diagnostic service at all: Energica's "Sync RTC"
// puts ONE raw broadcast on CAN `0x120` — a `94 FF` header plus five bit-packed bytes of
// **UTC**, zero-padded to eight. No session, no SecurityAccess, no reply. There is NO
// diagnostic route to the clock; that was searched exhaustively.
//
// ⚠️ It is `DateTime.UtcNow`, not local. Sending local time sets the bike's clock wrong by
// the timezone offset, and the service stamp with it.
//
// ⚠️ AND THE BIKE'S CURRENT TIME CANNOT BE READ BACK — no parameter, no service and no
// broadcast frame carries it. So this action is WRITE-ONLY and unverifiable, which is why
// the confirmation below asks the owner to confirm the time rather than reporting success
// afterwards. Provenance, and the three corrections this makes to
// obd-garage/SERVICE_RESET.md §5: docs/vcu-parameters.md §13.

/** The 11-bit id the clock sync goes out on. `VCU_COMMAND_REQ` in Energica's own frame database. */
export const RTC_SYNC_CAN_ID = 0x120;

/** Header bytes 0-1 of every `0x120` clock frame. One opcode among several on a shared command id. */
const RTC_SYNC_HEADER = [0x94, 0xff];

/**
 * Packs a UTC instant into the 8-byte `0x120` frame. Pure. Layout from the decompiled
 * `UpdateRTC()`; fields are little-endian WITHIN themselves and split across bytes:
 *
 *   byte 2  bits 0-4  hour            bits 5-7  minute, low 3 of 6
 *   byte 3  bits 0-2  minute, high 3  bits 3-7  second, low 5 of 6
 *   byte 4  bit  0    second, bit 5   bits 1-5  day of month   bits 6-7  weekday, low 2 of 3
 *   byte 5  bit  0    weekday, bit 2  bits 1-4  month          bits 5-7  unused, always 0
 *   byte 6            year − 2000
 *   byte 7            zero padding to DLC 8
 *
 * ⚠️ The weekday is .NET's `DayOfWeek`: Sunday = 0, which is what `getUTCDay()` returns
 * too — no conversion, and worth stating rather than relying on silently. ✅ Checked
 * against two frames that really went out; docs/vcu-parameters.md §13.
 */
export function buildRtcSyncFrame(when: Date): Uint8Array {
  const hour = when.getUTCHours();
  const minute = when.getUTCMinutes();
  const second = when.getUTCSeconds();
  const day = when.getUTCDate();
  const weekday = when.getUTCDay();
  const month = when.getUTCMonth() + 1;
  const year = when.getUTCFullYear() - 2000;
  if (year < 0 || year > 255) {
    // A year outside 2000…2255 cannot be expressed in the one byte the frame has for
    // it, and would silently wrap into a plausible-looking date. Refused instead —
    // this is the frame that sets what the service stamp will say for ever.
    throw new Error(`vcu-write: ${when.toISOString()} is outside the 2000…2255 this frame's year byte can express`);
  }
  const frame = new Uint8Array(8);
  frame[0] = RTC_SYNC_HEADER[0];
  frame[1] = RTC_SYNC_HEADER[1];
  frame[2] = (hour & 0x1f) | ((minute & 0x07) << 5);
  frame[3] = ((minute & 0x38) >> 3) | ((second & 0x1f) << 3);
  frame[4] = ((second & 0x20) >> 5) | (day << 1) | ((weekday & 0x03) << 6);
  frame[5] = ((weekday & 0x04) >> 2) | ((month & 0x0f) << 1);
  frame[6] = year;
  return frame;
}

/**
 * Unpacks a `0x120` clock frame back into its fields. Pure.
 *
 * Exists to make `buildRtcSyncFrame` checkable in BOTH directions against the two
 * captured frames — a builder checked only against its own output proves nothing —
 * and so that a capture containing one can be read without doing the bit shuffling by
 * hand. Nothing in the running service calls it.
 */
export function decodeRtcSyncFrame(frame: Uint8Array): {
  hour: number;
  minute: number;
  second: number;
  day: number;
  weekday: number;
  month: number;
  year: number;
} | null {
  if (frame.length < 7 || frame[0] !== RTC_SYNC_HEADER[0] || frame[1] !== RTC_SYNC_HEADER[1]) {
    // 0x120 carries other opcodes — the charge-current setpoint traffic uses 0x98,
    // 0x9A, 0x96 and 0xAC — so a frame on this id that is not ours is an ordinary
    // thing to see, not an error.
    return null;
  }
  return {
    hour: frame[2] & 0x1f,
    minute: ((frame[2] >> 5) & 0x07) | ((frame[3] & 0x07) << 3),
    second: ((frame[3] >> 3) & 0x1f) | ((frame[4] & 0x01) << 5),
    day: (frame[4] >> 1) & 0x1f,
    weekday: ((frame[4] >> 6) & 0x03) | ((frame[5] & 0x01) << 2),
    month: (frame[5] >> 1) & 0x0f,
    year: 2000 + frame[6],
  };
}

// ── OBD Mode 04: clear stored trouble codes ─────────────────────────────────
//
// ⚠️ This is the first thing in this project that changes ECU state OUTSIDE the parameter
// table. src/can/obd-dtc.ts — the always-on poller — says Mode 04 "is deliberately absent
// and must stay absent", and it still is: Mode 04 lives HERE, on the service-mode path,
// behind the same gate, the same separate enable switch and the same two-step confirmation
// as a calibration write.
//
// ⚠️ IT IS NOT RECOVERABLE. The stored list on this bike has been accumulating since before
// anyone started looking — 39 codes as of 2026-08-04 — and clearing it throws away the
// freeze frame with it.
//
// 🟡 And nobody knows the full extent of what it erases: the standard also resets readiness
// monitors and, on many ECUs, fuel trims and adaptive values. What THIS VCU does has never
// been observed. Not a "clear the dashboard light" button — docs/vcu-parameters.md §13.

const OBD_CLEAR_DTCS_MODE = 0x04;

/** The 11-bit id an OBD-II request goes out on. The functional address, as the poller uses. */
export const OBD_FUNCTIONAL_REQUEST_ID = 0x7df;

/**
 * The Mode 04 request frame.
 *
 * Plain ISO-TP addressing, NOT the extended addressing the VCU micros use — byte 0
 * is a PCI length nibble here, not an ECU address. That is why this cannot go through
 * src/vcu/write-codec.ts and has its own builder: mixing the two framings up is how a
 * request reaches the wrong ECU.
 */
export function buildClearDtcsFrame(): Uint8Array {
  const frame = new Uint8Array(8);
  frame[0] = 0x01; // one payload byte
  frame[1] = OBD_CLEAR_DTCS_MODE;
  return frame;
}

/**
 * Could this frame be an answer to OUR Mode 04, rather than somebody else's traffic?
 *
 * ⚠️ This exists because the always-on OBD poller never stops: it keeps sending mode-01 PID
 * requests, and every 120th round a multi-frame mode-03 transfer, throughout the 300 ms
 * window a Mode 04 reply is awaited in — and the bus lease does not cover it. So "the first
 * frame in 0x7E0-0x7EF" is not our answer. The KWP legs of a write need no equivalent,
 * because `parseResponseFrame` requires byte 0 to be the tester's address 0xF1 and no
 * ISO-TP PCI byte can be 0xF1; Mode 04 has no such discriminator built in.
 *
 * Deliberately permissive about WHICH ecu answered and strict about WHAT it said. Why
 * getting it wrong is worse here than elsewhere: docs/vcu-parameters.md §13.
 */
export function isClearDtcsReply(frame: Uint8Array): boolean {
  if (frame.length < 2 || frame[0] >> 4 !== 0x0) {
    // Not a single frame. A First/Consecutive/Flow-control frame in this range
    // belongs to the poller's mode-03 transfer, and taking it would break that.
    return false;
  }
  if (frame[1] === OBD_CLEAR_DTCS_MODE + 0x40) {
    return true;
  }
  // A negative response, but only one that names the service we actually sent. This
  // bus really does produce `03 7F 00 33` — a refusal of a service 0x00 that does not
  // exist and that nobody sent — as an artefact of an ECU reading a flow-control
  // frame as a request.
  return frame[1] === 0x7f && frame.length >= 3 && frame[2] === OBD_CLEAR_DTCS_MODE;
}

/** How a Mode 04 request came out. */
export type ClearDtcsReply =
  /** `44` — the standard positive response to mode 04. */
  | { kind: "cleared" }
  | { kind: "refused"; negativeResponseCode: number; description: string }
  | { kind: "unrecognised"; reason: string };

/**
 * Decodes a Mode 04 reply out of a raw OBD frame. Pure.
 *
 * ⚠️ A negative response naming a service we did not ask for is reported as
 * `unrecognised` rather than as a refusal of ours. src/can/obd-dtc.ts documents a
 * real instance of this on this exact bus: something answers `03 7F 00 33` — a
 * refusal of "service 0x00", which does not exist and which we never sent — as an
 * artefact of an ECU reading a flow-control frame as a request. Believing that as an
 * answer is what made the mode-03 transfer look impossible for a while.
 */
export function decodeClearDtcsReply(frame: Uint8Array): ClearDtcsReply {
  if (frame.length < 2) {
    return { kind: "unrecognised", reason: "frame shorter than a PCI byte and a service byte" };
  }
  const length = frame[0] & 0x0f;
  if (frame[0] >> 4 !== 0x0 || length === 0) {
    return { kind: "unrecognised", reason: `not a single frame: ${toHex(frame)}` };
  }
  if (frame[1] === 0x7f) {
    if (length < 3 || frame.length < 4) {
      return { kind: "unrecognised", reason: "negative response without a service and a code" };
    }
    if (frame[2] !== OBD_CLEAR_DTCS_MODE) {
      return { kind: "unrecognised", reason: `a refusal of service 0x${frame[2].toString(16)}, which we did not send` };
    }
    return { kind: "refused", negativeResponseCode: frame[3], description: describeClearRefusal(frame[3]) };
  }
  if (frame[1] === OBD_CLEAR_DTCS_MODE + 0x40) {
    return { kind: "cleared" };
  }
  return { kind: "unrecognised", reason: `reply names service 0x${frame[1].toString(16)}, not 0x44` };
}

/**
 * The negative response codes mode 04 realistically produces, in words.
 *
 * Deliberately not routed through src/diagnostics/obd-dtc.ts's table: `0x22`
 * conditionsNotCorrect means something specific here — most ECUs refuse to clear
 * while the engine is running or a fault is still active — and a generic label would
 * lose the one piece of advice worth giving.
 */
function describeClearRefusal(code: number): string {
  switch (code) {
    case 0x12:
      return "subFunctionNotSupported — this ECU does not implement mode 04 at all";
    case 0x22:
      return "conditionsNotCorrect — an ECU normally refuses to clear while a fault is still ACTIVE. Fix the fault first; codes that are still true come straight back anyway";
    case 0x31:
      return "requestOutOfRange";
    case 0x33:
      return "securityAccessDenied — mode 04 is not meant to need authentication, so this is worth a note in obd-garage/";
    default:
      return `NRC 0x${code.toString(16).padStart(2, "0")}`;
  }
}

// ── Should the service stamp be a LOGGED SIGNAL? No, and here is why ─────────
//
// Same reason src/vcu/sweep.ts gives for not sweeping at startup: reading it costs a KWP
// session on A8, and the whole safety argument (src/vcu/service-gate.ts) rests on the
// always-on service not asking the micros anything outside service mode. It also moves
// about once a year, and the audit journal (src/vcu/write-audit.ts) is already a better
// record than a signal row — it says who read it and what happened next.
//
// If it is ever wanted on a Grafana panel, the right shape is a row in the audit journal
// being exported, not a signal polled off a motorcycle's bus. docs/vcu-parameters.md §13.
