import type { ServiceGateReadings } from "./service-gate.ts";

// What proves the bike is tethered to a charger — and what refutes it.
//
// Pure, like ./service-gate.ts which owns it: readings in, evidence out. Split off
// because "is a cable live" is a second responsibility from "may this bike be
// serviced", and because ./write-runner.ts asks the same question about three of its
// actions and had three copies of it.
//
// ⚠️ FRESHNESS, NEVER THE VALUE ALONE. `liveState` keeps the last reading of every
// signal for ever, so an unplugged bike still reports whatever `dc_v` last was and
// `charge_manager_state` holds `0x23` through a ride — measured: rides.db session 42
// (2026-09-07) has one `charge_manager_state` row at 14:01 and the bike reaches
// 151.8 km/h at 15:34 with that value still standing.
//
// Why three witnesses and not one, why the inlet veto exists, and the two captures
// that pin them: docs/vcu-parameters.md §12.

/**
 * How fresh `charge_manager_state` must be to say a session is live.
 *
 * ⚠️ Shared with ./write-runner.ts deliberately. The invariant that matters is that the
 * gate's window is never LONGER than the one `performResetVcu` refuses on: a window where
 * the gate says "charging, so the drive being energized is excused" while the reset action
 * says "not charging, go ahead" is a VCU reset into a live charge. One constant makes that
 * impossible to drift; scripts/check-service-gate-charging.ts asserts the ordering anyway,
 * so deliberately splitting them again fails rather than passing quietly.
 */
export const CHARGE_SESSION_MAX_AGE_MS = 5000;

/**
 * How long a charger frame may be silent and still count as plugged in.
 *
 * `0x305`/`0x306` are 5 Hz and broadcast only while the onboard AC charger is running, so
 * two seconds is ten frames of margin. A different number from the one above because it is
 * a different question about a different frame rate, not because either is arbitrary.
 */
const CHARGER_FRAME_MAX_AGE_MS = 2000;

/** `0x102` is 100 Hz, so a second of silence is a hundred missed frames. Matches the gate's own budget. */
const BROADCAST_MAX_AGE_MS = 1000;

/** `charge_manager_state` (`0x610` b7) settled values — the cleanest AC/DC discriminator on this bus. */
export const CHARGE_MANAGER_STATE_AC = 0x02;
export const CHARGE_MANAGER_STATE_DC = 0x23;

/**
 * `charge_manager_status` (`0x610` b0) bit 3, factory `CM_INL_STS` — a cable in the inlet.
 *
 * A mask rather than a decoded key on purpose: src/can/charge-manager.ts logs b0 whole
 * because "the raw byte survives a bit-position error and the split fields do not".
 */
const INLET_PRESENT_MASK = 0x08;

/** One thing that, being fresh, says a charger is attached. */
export interface ChargeEvidenceRule {
  key: string;
  /** How the page says it. A function so one rule can name the mode it found. */
  meaning: (value: number) => string;
  /** True when this reading, being fresh, means a charger is attached. */
  counts: (value: number) => boolean;
  maxAgeMs: number;
}

/**
 * What makes a charge session believable. ANY ONE of these, fresh, is enough.
 *
 * ⚠️ The escape is narrow and that is what makes it cheap: it excuses exactly one gate
 * check, `energized`. Speed, motor rpm, `moving`, `go`, `go_request` and `throttle_on` all
 * still apply, so the worst a false positive can do is degrade the gate to "stationary and
 * not in drive". It cannot admit a moving bike, nor one in drive.
 *
 * ⚠️ Three witnesses because no one of them sees every real charge. Which capture proves
 * that for which witness — including the 118.5 s of a DC handshake that only the third
 * sees — is in docs/vcu-parameters.md §12.
 */
export const CHARGE_EVIDENCE: ChargeEvidenceRule[] = [
  // ✅ 0x102 b3 bit0, the DC fast-charge contactor monitor. The strongest of the three: it
  // rides on a 100 Hz frame the bike broadcasts whenever it is awake, so its ZERO state is
  // observed millions of times rather than being an absence — which is the standard the
  // gate's own RULES are held to. Set in exactly one interval of the whole capture corpus
  // and that interval is a DC charge; 0 through every AC session.
  {
    key: "fast_dc_contactor",
    meaning: () => "the DC fast-charge contactor is closed",
    counts: value => value === 1,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
  },

  // ✅ The onboard AC charger's own frames, 0x305 and 0x306 at 5 Hz, present only while it
  // is running. Their VALUES are never consulted — that the frame arrived at all is the
  // claim — so this detects "plugged in" rather than "current is flowing", which is the
  // property that matters: a tethered bike cannot be ridden away without unplugging first.
  //
  // ⚠️ AC ONLY. A DC fast charge bypasses this charger and sends neither frame, which is
  // why the list did not cover DC at all until 2026-09-09.
  {
    key: "dc_v",
    meaning: () => "the AC charger is reporting DC volts",
    counts: () => true,
    maxAgeMs: CHARGER_FRAME_MAX_AGE_MS,
  },
  {
    key: "dc_a",
    meaning: () => "the AC charger is reporting DC amps",
    counts: () => true,
    maxAgeMs: CHARGER_FRAME_MAX_AGE_MS,
  },
  {
    key: "mains_v",
    meaning: () => "the AC charger is reporting mains volts",
    counts: () => true,
    maxAgeMs: CHARGER_FRAME_MAX_AGE_MS,
  },
  {
    key: "mains_a",
    meaning: () => "the AC charger is reporting mains amps",
    counts: () => true,
    maxAgeMs: CHARGER_FRAME_MAX_AGE_MS,
  },

  // ✅ 0x610 b7, the charge manager's own state. The only witness that covers BOTH modes,
  // and the only one that sees a DC session before its contactor closes — measured at
  // 118.5 s of handshake where the two above see nothing (docs/vcu-parameters.md §12).
  //
  // ⚠️ SETTLED VALUES ONLY, and it is still not sufficient alone: `0x02` is both "a settled
  // AC session" and the state the charge manager sits in with nothing in the inlet. That is
  // what the veto below is for.
  {
    key: "charge_manager_state",
    meaning: value =>
      value === CHARGE_MANAGER_STATE_DC
        ? "the charge manager reports a live DC session"
        : "the charge manager reports a live AC session",
    counts: value => value === CHARGE_MANAGER_STATE_AC || value === CHARGE_MANAGER_STATE_DC,
    maxAgeMs: CHARGE_SESSION_MAX_AGE_MS,
  },
];

/**
 * The one thing that can CANCEL every witness above: the charge manager itself saying the
 * inlet is empty.
 *
 * ⚠️ This is not belt-and-braces, it is the fix for a measured hole. On 2026-08-09 a failed
 * charge attempt (episode E0) broadcast `0x610` for 14.8 s with `charge_manager_state` at
 * `0x02` in 123 of 123 frames — the settled AC value, decoding cleanly — while b0 said no
 * inlet and no lock throughout. Its likeliest diagnosis is a plug-detection failure, i.e.
 * exactly the case where the cable is not doing the job the tether argument assumes.
 *
 * Shaped as a contradiction rather than a requirement, like the gate's `speed_kmh`
 * corroborator: it never fires by being absent, only by disagreeing.
 */
export const CHARGE_INLET_VETO = {
  key: "charge_manager_status",
  requirement: "the charge manager sees a cable in the inlet",
  maxAgeMs: CHARGE_SESSION_MAX_AGE_MS,
  hasCable: (value: number) => (value & INLET_PRESENT_MASK) !== 0,
} as const;

/**
 * What says a charger is attached, or null. The FIRST match wins and is reported by name,
 * so the page and the journal say which signal carried the argument.
 *
 * ⚠️ Does NOT apply the veto — ./service-gate.ts does that, because whether the veto
 * actually cancelled anything is what decides if the rider is told about the cable.
 */
export function findChargingEvidence(readings: ServiceGateReadings): string | null {
  for (const rule of CHARGE_EVIDENCE) {
    const sample = readings[rule.key];
    if (sample === undefined || sample.value === null || sample.ageMs === null) {
      continue;
    }
    if (sample.ageMs > rule.maxAgeMs) {
      continue;
    }
    if (rule.counts(sample.value)) {
      return rule.meaning(sample.value);
    }
  }
  return null;
}

/** True when the charge manager is on the bus and reports nothing in the inlet. */
export function inletIsEmpty(readings: ServiceGateReadings): boolean {
  const sample = readings[CHARGE_INLET_VETO.key];
  if (sample === undefined || sample.value === null || sample.ageMs === null) {
    return false;
  }
  if (sample.ageMs > CHARGE_INLET_VETO.maxAgeMs) {
    return false;
  }
  return !CHARGE_INLET_VETO.hasCable(sample.value);
}

/** Every signal this module reads, so the gate's sampler cannot ask for a smaller set. */
export function chargeEvidenceKeys(): string[] {
  return [...CHARGE_EVIDENCE.map(rule => rule.key), CHARGE_INLET_VETO.key];
}

/**
 * The charge manager is on the bus, whatever it is saying.
 *
 * ⚠️ A WIDER predicate than chargeSessionFrom, and the difference is deliberate: this is what
 * REFUSES an action (reset-vcu), so it must fire during the handshake too — `11 02` is the
 * charge manager's own bootloader-entry service and a session being established is exactly as
 * bad a moment to reset as one in progress. Settled-only here would have quietly allowed a
 * reset through every handshake.
 *
 * Being a superset of chargeSessionFrom is also what keeps the gate honest: there is no state
 * where the safety gate excuses `energized` as "charging" while reset-vcu considers the bike
 * unplugged. scripts/check-service-gate-charging.ts asserts that ordering.
 */
export function chargeManagerIsLive(value: number | null, ageMs: number | null): boolean {
  return value !== null && ageMs !== null && ageMs <= CHARGE_SESSION_MAX_AGE_MS;
}

/** A live charge session as the write actions ask about it: present, fresh, settled. */
export interface ChargeSession {
  state: number;
  mode: "ac" | "dc";
}

/**
 * The predicate ./write-runner.ts asks before commanding a current, stopping a charge or
 * refusing a reset. Sampling stays at the caller; the decision is here so a laptop can
 * exercise every branch.
 */
export function chargeSessionFrom(value: number | null, ageMs: number | null): ChargeSession | null {
  if (value === null || ageMs === null || ageMs > CHARGE_SESSION_MAX_AGE_MS) {
    return null;
  }
  if (value === CHARGE_MANAGER_STATE_AC) {
    return { state: value, mode: "ac" };
  }
  if (value === CHARGE_MANAGER_STATE_DC) {
    return { state: value, mode: "dc" };
  }
  return null;
}
