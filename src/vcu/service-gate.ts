// Is this motorcycle safe to hold in service mode right now?
//
// Pure: readings in, a verdict out. No signal registry, no clock, no socket — the
// caller samples and passes what it sampled, which is what lets every branch below
// be exercised on a laptop (scripts/check-vcu-params.ts §10) rather than first
// discovered on a moving bike. Same split as param-codec.ts / kwp-client.ts.
//
// ── What this is for ─────────────────────────────────────────────────────────
// Service mode is the one thing in this repo that puts ~277 requests on the bike's
// bus on purpose. Reading cannot change a calibration — param-codec.ts's request
// union has three members and no write in it — but a diagnostic session and a
// request burst are still not things to hold open while the machine is being
// ridden, and this is the gate that says so. Tesla's service mode is the model:
// you get in while stationary and out of gear, and you are put back out the moment
// that stops being true.
//
// ── Fail closed ──────────────────────────────────────────────────────────────
// Every verdict below starts from "no" and has to be argued up to "yes". A signal
// that has never arrived, or that arrived too long ago to still describe the bike,
// blocks — because "I cannot see the speedometer" and "the speedometer reads zero"
// are different claims and only one of them is a reason to proceed. That is the
// same distinction src/can/obd-dtc.ts draws between `not-sent` and `no-response`,
// and src/diagnostics/stored-codes.ts between "no codes" and "no answer".
//
// The cost of failing closed is worth naming: the gate needs the bike's 100 Hz
// broadcasts, so it refuses on a bike that is completely switched off. That is not
// a hole, it is a coincidence of requirements — a sleeping VCU answers no `10 81`
// either (see kwp-client.ts), so a sweep would read 277 no-sessions anyway. Both
// halves want the same awake, parked, key-on bike.
//
// ── Why these signals and not others ─────────────────────────────────────────
// Everything here is already decoded and already logged by this repo; nothing new
// was invented for the gate, no frame was added to the kernel RX filter, and no
// decoder was written for it. Provenance and confidence per signal is in RULES
// below, and the ones deliberately NOT used are listed under EXCLUDED_FROM_GATE at
// the bottom — an unreliable check is worse than no check, because it earns trust
// it cannot repay.
//
// ── ⚠️ What has and has not been verified (2026-08-16) ───────────────────────
// The bike is unavailable, so the only honest statement is about captured bytes.
//
//  • The PASSING path is checked against real ones. `0x102` = `80 10 02 44 99 FF
//    D8 FF` and `0x104` with its speed and rpm fields zero are the 2026-08-02
//    parked capture, and scripts/check-vcu-params.ts §10 runs them through the real
//    src/can/decode.ts and this gate and asserts `safe`. So "this refuses to let
//    anyone in, ever" is ruled out on evidence rather than on hope.
//  • The BLOCKING path is checked the same way, from the same day's garage lap:
//    `5F 00 32 00` in `0x104` b4-7 is 9.5 km/h and 400 rpm, measured against OBD
//    PIDs 0D and 0C, and the gate must refuse it.
//  • What CANNOT be checked without the bike is the thing the gate exists for: that
//    these bits move the instant a real motorcycle starts to roll away, and that the
//    sweep is out of the way before it does. Every signal here has been seen in both
//    states on a real bike, which is the strongest available evidence — but the
//    LATENCY between the wheel turning and the last frame leaving the socket has
//    only ever been reasoned about. See the PR description.

/** One signal as the caller found it. `null` in both fields means it has never arrived. */
export interface ServiceGateSample {
  value: number | null;
  /**
   * Milliseconds since it last arrived, on the MONOTONIC clock. Never a
   * `Date.now()` difference: this Pi steps its own wall clock from GPS mid-run
   * (src/gps/clock.ts), and a backwards step would make a stale reading look fresh
   * — which on this particular decision means declaring a moving bike parked. See
   * ../monotonic.ts.
   */
  ageMs: number | null;
}

/** What the caller sampled, keyed by signal name. Anything not present counts as never seen. */
export type ServiceGateReadings = Record<string, ServiceGateSample>;

/** How one requirement came out. Carried whole so the page can show which one blocks and why. */
export interface ServiceGateCheck {
  key: string;
  /** The requirement in the words the dashboard shows, e.g. "road speed is zero". */
  requirement: string;
  state: ServiceGateCheckState;
  value: number | null;
  ageMs: number | null;
}

export type ServiceGateCheckState =
  /** Present, fresh, and saying what it has to say. */
  | "ok"
  /** Present and fresh, and the bike is not safe to service. */
  | "unsafe"
  /** Present but too old to describe the bike now. */
  | "stale"
  /** Never seen. Blocks for a required signal; noted and passed over for a corroborating one. */
  | "missing";

export type ServiceGateVerdict = {
  /** True only when every required check is `ok` and no corroborating one contradicts it. */
  safe: boolean;
  /**
   * Why not, one sentence per reason, already phrased for the page. Empty when
   * `safe`. Ordered as RULES is, so the most direct reason (speed) leads.
   */
  blockers: string[];
  /** Every check, safe or not — so the page can show the whole gate rather than only its complaint. */
  checks: ServiceGateCheck[];
};

/**
 * How old a 100 Hz broadcast may be and still describe the bike.
 *
 * 0x102 and 0x104 are both 100 Hz (src/can/decode.ts), so a second is a hundred
 * consecutive frames missed — a dead bus or a sleeping bike, not jitter. Generous
 * on purpose: the failure this budget guards against is a gate that flickers on a
 * busy bus and aborts a good sweep, and the thing that makes it safe to be
 * generous is that at 100 Hz a *genuinely* stale reading is never merely late.
 */
const BROADCAST_MAX_AGE_MS = 1000;

/**
 * The same, for the 2 Hz OBD poll.
 *
 * `speed_kmh` comes from a request/response round the bike can simply not answer —
 * obd-dtc.ts measures this bus refusing a mode-03 transfer 30-75 % of the time
 * under load — so a handful of missed rounds says nothing about the motorcycle.
 * Ten seconds is ~20 poll rounds at the default 500 ms interval, and it is the same
 * number src/http/status.ts already calls "live" for a polled signal.
 */
const POLL_MAX_AGE_MS = 10_000;

interface ServiceGateRule {
  key: string;
  requirement: string;
  /** True when this reading means "safe to service". */
  isSafe: (value: number) => boolean;
  maxAgeMs: number;
  /**
   * False for a signal whose ABSENCE is a fact about our own polling rather than
   * about the bike. Such a signal still blocks when it is present and disagrees —
   * it just cannot block by being missing.
   */
  required: boolean;
}

/**
 * The gate, in the order the reasons are worth reading.
 *
 * Confidence markers use the same vocabulary as src/can/decode.ts and
 * obd-garage/CAN_MAP.md: ✅ proven against ground truth, 🟡 plausible but not
 * measured against anything that could contradict it.
 */
const RULES: ServiceGateRule[] = [
  // ✅ CAN 0x104 bits 32-44, ÷10. Validated on a garage lap 2026-08-02 against OBD
  // PID 0D at 9.5/10.3 km/h, tracking to ~1-2 %; the bit position is pinned to the
  // bit (decode.ts). Zero here is the strongest single statement on the bus that
  // the bike is not moving, and at 100 Hz it is also the fastest.
  {
    key: "speed_can_kmh",
    requirement: "road speed is zero",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
  },

  // ✅ CAN 0x104 bits 45-59. Same frame, same lap, same 1-2 % agreement against OBD
  // PID 0C. It is not a redundant copy of speed: an Energica has a single-speed
  // reduction and no clutch, so the motor and the rear wheel are rigidly coupled —
  // but they are different FIELDS of the frame, so a bit-layout mistake in one
  // cannot hide in the other. Both reading zero is two decodes agreeing, not one
  // decode twice.
  {
    key: "motor_rpm_can",
    requirement: "the motor is not turning",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
  },

  // ✅ CAN 0x102 b2 bit7. The .xdbc calls it "speed > 1 km/h" and it was caught
  // toggling with the rider's actions on the 2026-08-02 lap. A third opinion on
  // motion, from a different frame and a different sender than the two above.
  {
    key: "moving",
    requirement: "the bike is not moving",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
  },

  // ✅ CAN 0x102 b1 bit1, as a decode: observed 0 on the parked bike 2026-08-02 AND
  // observed toggling with the rider's actions on the garage lap that afternoon —
  // both states seen, which is what separates it from `key_on` below.
  //
  // ⚠️ But `energized` = 1 does NOT mean "rideable". obd-garage/CAN_MAP.md records
  // it setting for the whole of a 17-minute stationary DC fast charge on 2026-08-04
  // (`102` b1 0x10 → 0x12 at the session start, clearing at the end). So this check
  // refuses a bike on a DC charger, which is stationary and perfectly safe.
  //
  // That false refusal is kept rather than worked around, for two reasons. It is the
  // direction this gate is allowed to be wrong in — a check that blocks a safe state
  // costs an unplug, one that passes an unsafe state costs something else entirely.
  // And a 277-request burst during a live CCS handshake is not obviously a good idea
  // anyway. The implication is only ever one way: `energized` 0 ⇒ the drive is down.
  {
    key: "energized",
    requirement: "the drive is not energized",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
  },

  // 🟡 CAN 0x102 b1 bit3. Caught toggling with the rider's actions on the same lap,
  // so SOMETHING real lives at that bit and it moves when the bike is ridden — which
  // is what a gate needs. The NAME is weaker than the observation: the manufacturer's
  // own signal table for this frame (the same service-tool source src/diagnostics/
  // dtc-table.ts is reconciled against, which names the two adjacent bits KickStand
  // and Start Switch) does not list b1 0x08 at all, so "go" is the third-party
  // .xdbc's label and not the manufacturer's. Gating on it is still right — a bit
  // that moves with riding and reads 0 parked is exactly the evidence wanted — but
  // do not read the name as authority.
  {
    key: "go",
    requirement: "the bike is not in drive",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
  },

  // 🟡 CAN 0x102 b1 bit2, also caught toggling on the lap and 0 parked. Checked as
  // well as `go` because it moves FIRST: catching the intent to drive buys the abort
  // a head start over catching the drive itself.
  //
  // Same naming caveat, and sharper: the manufacturer's table calls this bit
  // **Engine Switch**, which is a switch POSITION (a run/kill switch) rather than a
  // request. Either way it reads 0 on a parked bike and moves when one is ridden.
  {
    key: "go_request",
    requirement: "nobody is asking for drive",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
  },

  // ✅ CAN 0x102 b1 bit7, also caught toggling on the lap. Earliest of the lot in
  // time — throttle precedes go_request precedes go precedes speed — so it is the
  // one most likely to abort a sweep that was never in danger, e.g. a hand resting
  // on the bar. That trade is taken deliberately: an abort costs a resume from
  // `sweep.partial.jsonl` and nothing else, and this gate is allowed to be wrong
  // in exactly one direction.
  {
    key: "throttle_on",
    requirement: "the throttle is closed",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
  },

  // ✅ as a decode (OBD PID 0D is standard and it is what 0x104's speed field was
  // validated against), 🟡 as a gate — see `required: false`.
  //
  // A corroborator rather than a requirement, and the distinction is the point.
  // Its absence is a fact about OUR poller — OBD_ENABLED, a PID timing out, the
  // bus busy — not about the motorcycle, and a gate that refuses because our own
  // request went unanswered would be reading a dead socket as a moving bike. But
  // when it IS answering and it says the bike is moving while 0x104 says it is not,
  // that is two independent paths contradicting each other, and a contradiction is
  // never a reason to proceed.
  {
    key: "speed_kmh",
    requirement: "OBD road speed agrees that speed is zero",
    isSafe: value => value === 0,
    maxAgeMs: POLL_MAX_AGE_MS,
    required: false,
  },
];

/**
 * Signals considered for the gate and deliberately left out.
 *
 * Kept here rather than in a commit message because the next person to look at this
 * will have the same ideas, and most of them are traps. Several are things a brief
 * would reasonably suggest; the reasons they do not work are in the reverse-
 * engineering notes rather than anywhere obvious.
 *
 *  • `reverse_gear` (0x104 bit 63) — the obvious "not in gear" check. What is
 *    established is that the bit is a real, separately-varying field: decode.ts
 *    records b7 = 0x80 on 1122 frames of the 2026-08-02 lap, which is how bit 63 was
 *    told apart from the tachometer field below it. What it MEANS is the .xdbc's
 *    label alone — reverse was never deliberately engaged in any capture, and there
 *    is no forward, neutral or park counterpart to cross-check it against. Gating on
 *    an inferred label that was set on a thousand frames of ordinary riding could
 *    refuse every sweep, and with the bike a week away there is no way to find out.
 *
 *  • `stand_up` (0x102 b1 bit5) — the bit itself is the best-attested one here:
 *    the manufacturer's own table calls it KickStand, so it is confirmed rather than
 *    reverse-engineered. It is left out on MEANING, not confidence. A bike on a paddock stand or a workshop lift reads
 *    `stand_up` 1 while being as parked as a motorcycle gets, and that is precisely
 *    the situation service mode is for. Requiring it would refuse the workshop. (Its
 *    polarity — 0 = stand down — also rests on one observation, "stand_up 0 (it is
 *    on the sidestand)".)
 *
 *  • `key_on` (0x102 b1 bit4) — has only ever been observed as 1; decode.ts says so
 *    explicitly ("a key-off capture is what would confirm it"). A check never seen
 *    to fail is not a check.
 *
 *  • `throttle_pct` (0x109 b0-1 ÷10) — would be a second, independent throttle
 *    reading, and the ÷10 scale is 🟡 with "0000 idle" seen at exactly one operating
 *    point. If this bike's throttle sensor rests a tenth of a percent off zero, a
 *    gate demanding zero refuses every sweep for ever, and nobody could find out for
 *    a week. `throttle_on` is the same fact as a confirmed BIT, so it is used instead.
 *
 *  • `0x101` b0/b1 — suggested as a vehicle-mode enum. It is not one, or not one
 *    that helps: obd-garage/DC_CHARGE_LIMITS.md §5 gives 43/40 for **"riding / idle"
 *    as a single row**, 62/60 transitional and 104/100 DC charging, from one session
 *    on 2026-08-04. It therefore does not separate a moving bike from a parked one —
 *    it is a not-DC-charging detector. It is also not decoded here at all, not in the
 *    kernel RX filter, and CAN_MAP.md (older) still lists 0x101 under "unmapped".
 *
 *  • `bms_state_*` (0x201 b0) — suggested as vehicle state; it is the BMS's own
 *    charge state and it says nothing about motion. `bms_state_discharge` reads 1 on
 *    a parked bike drawing −0.2 A of housekeeping current, and during a DC fast
 *    charge the BMS sits in `bms_state_idle` and never reports Charge at all
 *    (CAN_MAP.md, 2026-08-04). Neither state distinguishes parked from moving.
 *
 *  • `charging` (0x102 b2 bit0) — reads 0 during a DC fast charge (it is AC-only),
 *    so it cannot even do the job its name suggests. And blocking on charging would
 *    be a different feature — protecting a charge session from bus contention —
 *    smuggled in under this one. `energized` already refuses a DC session as a side
 *    effect; see its rule above.
 *
 *  • `bms_err_contactor` (0x201 error bits 21-25) — a FAULT flag, not contactor
 *    state. It is 0 on a healthy bike whether the contactors are open or closed, so
 *    it says nothing about whether the HV bus is live. There is no contactor-state,
 *    precharge-complete or HV-live signal broadcast on this bus at all; the BMS has
 *    them internally and the stock config does not transmit them.
 */
const EXCLUDED_FROM_GATE = [
  "reverse_gear",
  "stand_up",
  "key_on",
  "throttle_pct",
  "charging",
  "bms_state_discharge",
  "bms_state_idle",
  "bms_err_contactor",
] as const;

/**
 * Decides whether service mode may be entered or held, from readings the caller
 * sampled.
 *
 * Every rule is evaluated even once one has failed, so the page can show the whole
 * gate instead of the first complaint — "speed unknown AND the bike is in drive" is
 * a different situation from either alone, and hiding the second behind the first
 * is how a gate gets trusted for the wrong reason.
 */
export function evaluateServiceGate(readings: ServiceGateReadings): ServiceGateVerdict {
  const checks = RULES.map(rule => checkRule(rule, readings[rule.key]));
  const blockers: string[] = [];
  for (const [position, check] of checks.entries()) {
    const rule = RULES[position];
    if (check.state === "ok") {
      continue;
    }
    if (check.state === "missing" && !rule.required) {
      // A corroborator that has never arrived. Recorded in `checks` so it is
      // visible on the page, but it cannot block: see the rule's own note.
      continue;
    }
    blockers.push(describeBlocker(check));
  }
  return { safe: blockers.length === 0, blockers, checks };
}

/** The signal keys this gate reads, so a caller knows what to sample without duplicating the list. */
export function serviceGateSignalKeys(): string[] {
  return RULES.map(rule => rule.key);
}

/** The signals considered and rejected, exported so a check can assert they stayed rejected. */
export function serviceGateExcludedKeys(): readonly string[] {
  return EXCLUDED_FROM_GATE;
}

function checkRule(rule: ServiceGateRule, sample: ServiceGateSample | undefined): ServiceGateCheck {
  const value = sample?.value ?? null;
  const ageMs = sample?.ageMs ?? null;
  const base = { key: rule.key, requirement: rule.requirement, value, ageMs };
  if (value === null || ageMs === null) {
    return { ...base, state: "missing" };
  }
  // Staleness is judged BEFORE the value, so a stale zero is reported as stale
  // rather than as safe. That ordering is the whole gate in one line: a reading
  // that no longer describes the bike is not evidence about the bike.
  if (ageMs > rule.maxAgeMs) {
    return { ...base, state: "stale" };
  }
  return { ...base, state: rule.isSafe(value) ? "ok" : "unsafe" };
}

/** One failed check as the sentence the page shows. */
function describeBlocker(check: ServiceGateCheck): string {
  switch (check.state) {
    case "unsafe":
      return `${check.requirement} — it reads ${formatValue(check.value)}`;
    case "stale":
      return `${check.requirement}: ${check.key} last arrived ${Math.round((check.ageMs ?? 0) / 1000)} s ago, too old to go on`;
    case "missing":
      return `${check.requirement}: ${check.key} has never arrived, so there is nothing to check`;
    case "ok":
      // Unreachable — the caller filters these out — and left loud rather than
      // silently rendering an empty reason if that ever stops being true.
      return `${check.requirement} (no fault; this should not have been reported)`;
  }
}

function formatValue(value: number | null): string {
  if (value === null) {
    return "nothing";
  }
  // Booleans on this bus are 1/0 signals, so the bare number is the clearest thing
  // to show; a speed gets one decimal because that is the resolution 0x104 carries.
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
