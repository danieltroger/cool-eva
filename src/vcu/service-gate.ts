// Is this motorcycle safe to hold in service mode right now?
//
// Pure: readings in, a verdict out. No signal registry, no clock, no socket — the caller
// samples and passes what it sampled, which is what lets every branch below be exercised
// on a laptop (scripts/check-vcu-params.ts §10) rather than first discovered on a moving
// bike. Same split as param-codec.ts / kwp-client.ts.
//
// ⚠️ FAIL CLOSED. Every verdict starts from "no" and has to be argued up to "yes". A
// signal that has never arrived, or that arrived too long ago to still describe the bike,
// blocks — because "I cannot see the speedometer" and "the speedometer reads zero" are
// different claims and only one of them is a reason to proceed.
//
// ⚠️ What CANNOT be checked without the bike is the thing the gate exists for: that these
// bits move the instant a real motorcycle starts to roll away, and that the sweep is out
// of the way before it does. Every signal here has been seen in both states on a real
// bike; the LATENCY between the two has only ever been reasoned about.
//
// What service mode is for, why an unreliable check is worse than no check, the captures
// that pin the passing and blocking paths, and the six days of riding that changed four
// rules in this file: docs/vcu-parameters.md §12.

import { CHARGE_INLET_VETO, chargeEvidenceKeys, findChargingEvidence, inletIsEmpty } from "./charge-session.ts";

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

/**
 * How one requirement came out. Served on the verdict so the endpoints carry the whole
 * gate and not only its complaint, and so a check can assert on a single row.
 *
 * ⚠️ Nothing in `public/` renders this today. An earlier comment here claimed the page
 * showed it, which was never true and was used to justify adding a row; the row is worth
 * having as a served record, and what the rider actually reads is `blockers`.
 */
export interface ServiceGateCheck {
  key: string;
  /** The requirement in the words the dashboard shows, e.g. "road speed is zero". */
  requirement: string;
  state: ServiceGateCheckState;
  value: number | null;
  ageMs: number | null;
  /**
   * Whether an ABSENT or STALE reading blocks. Carried on the check rather than looked up
   * in RULES by position — the loop below used to index `RULES[position]`, which made
   * "add a rule" and "add a row" silently different operations and threw a `TypeError`
   * out of every gate call the first time they diverged.
   */
  required: boolean;
}

export type ServiceGateCheckState =
  /** Present, fresh, and saying what it has to say. */
  | "ok"
  /** Present and fresh, and the bike is not safe to service. */
  | "unsafe"
  /** Present but too old to describe the bike now. */
  | "stale"
  /** Never seen. Blocks for a required signal; noted and passed over for a corroborating one. */
  | "missing"
  /**
   * Would have blocked, and does not, because the bike is on a charger. Only
   * `energized` can ever be this — see CHARGE_EVIDENCE in ./charge-session.ts. A state of
   * its own rather than silently reporting `ok`, so the page can say WHY it is allowed and
   * nobody reads a passing gate as "the drive is down" when it is not.
   */
  | "excused-by-charging"
  /**
   * The charge manager is on the bus and says the inlet is empty. Only the veto row can
   * ever be this. It cancels every charge excuse — see CHARGE_INLET_VETO.
   */
  | "inlet-empty";

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
  /**
   * What says the bike is on a charger, or null when nothing does. Non-null is what
   * excuses `energized`; it is on the verdict rather than kept private so the page
   * can show the reason and a reviewer can see which signal carried the argument.
   */
  chargingEvidence: string | null;
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
  /**
   * What a confirmed charge session changes about this rule. Default: nothing.
   *
   *  • `excuse-unsafe` — a fresh reading saying "not safe" is accepted anyway. Only
   *    `energized` uses it: a charging bike's HV side is up by definition.
   *  • `allow-absent` — a MISSING or STALE reading is accepted, but a fresh one that
   *    says the bike is moving still blocks. Only the two 0x104 signals use it, and
   *    on the argument — since refuted, see CHARGE_EVIDENCE_LIVENESS below — that the bike
   *    stops broadcasting that frame while it charges.
   */
  whileCharging?: "excuse-unsafe" | "allow-absent";
}

/**
 * ⚠️ Why two of the motion checks may go ABSENT while charging, and what still holds them
 * up: `speed_can_kmh` and `motor_rpm_can` may be missing or stale while a charger is
 * attached, and the four named here must still be FRESH and clear. A fresh 0x104 that says
 * the bike IS moving still blocks, charger or no charger — this relaxes "we must see it",
 * not "it must be zero".
 *
 * ⚠️ NEVER fall back to the last value, and never fall back to zero. Forward-filling hands
 * you 47.0 km/h and 1 976 rpm for a bike plugged in for seven hours — a real trap, and
 * untouched by the next paragraph.
 *
 * ❌ The JUSTIFICATION for this escape does not hold: "the bike stops broadcasting 0x104
 * while it charges" counted log-on-change rows as frame presence. Left standing anyway
 * rather than removed in a commit about charge evidence — issue #194, and §12.
 */
const CHARGE_EVIDENCE_LIVENESS = ["moving", "go", "go_request", "throttle_on"] as const;

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
    whileCharging: "allow-absent",
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
    whileCharging: "allow-absent",
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

  // ✅ CAN 0x102 b1 bit1, both states seen on a real bike — 0 parked on 2026-08-02, and
  // toggling with the rider's actions on the garage lap that afternoon. That is what
  // separates it from `key_on` below.
  //
  // ⚠️ `energized` = 1 does NOT mean "rideable". It means the HV side is up, and a charging
  // bike's HV side is up by definition: CAN_MAP.md records it setting for the whole of a
  // 17-minute stationary DC fast charge on 2026-08-04.
  //
  // ⚠️⚠️ SO IT IS EXCUSED WHILE CHARGING, DELIBERATELY, AND MUST NOT BE "FIXED" BACK.
  // Refusing the one state the feature is FOR is not caution; it is a gate that gets
  // switched off. What keeps it safe is that the excuse is narrow (see CHARGE_EVIDENCE in
  // ./charge-session.ts, and the inlet veto beside it) and
  // that every other check still applies — zero speed, zero motor rpm, `moving` clear and
  // the whole drive-request trio clear. The implication that matters is unchanged:
  // `energized` 0 ⇒ the drive is down. Full argument: docs/vcu-parameters.md §12.
  {
    key: "energized",
    requirement: "the drive is not energized",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
    whileCharging: "excuse-unsafe",
  },

  // ⚠️ Measured on rides.db 2026-08-16: `go` = 0 is NOT a reliable "cannot move". Two clean
  // episodes have the bike rolling at 5.2-6.7 km/h with `go` = 0 AND `energized` = 0 —
  // physically ordinary, since a bike can be pushed or coast with the drive down. That is
  // exactly why speed and rpm are the load-bearing checks above and these are corroboration:
  // a gate resting on `go` alone would have opened on a bike rolling at jogging pace. The
  // converse holds well (98.5 % of live `go` = 1 time has the bike moving), so `go` = 1 is a
  // trustworthy positive.
  //
  // 🟡 CAN 0x102 b1 bit3. It moves when the bike is ridden, which is what a gate needs, but
  // "go" is the third-party .xdbc's label and not the manufacturer's — whose own table for
  // this frame does not list b1 0x08 at all. Do not read the name as authority;
  // docs/vcu-parameters.md §12.
  {
    key: "go",
    requirement: "the bike is not in drive",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
  },

  // 🟡 CAN 0x102 b1 bit2, also caught toggling on the lap and 0 parked.
  //
  // ⚠️ It does NOT lead `go`, whatever the name suggests. Measured on rides.db
  // 2026-08-16: both signals have exactly 27 rising edges and the largest gap
  // between a matched pair is **20 ms**, i.e. the same 0x102 frame or the next one.
  // An earlier version of this comment claimed it bought the abort a head start;
  // it buys nothing of the kind. It is kept because it costs nothing and because
  // two bits agreeing is marginally better evidence than one, not for lead time.
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
 * ⚠️ Most of them are traps, several are things a brief would reasonably suggest, and the
 * reasons they do not work are not obvious — so read docs/vcu-parameters.md §12 before
 * adding one. In brief: `reverse_gear` is not a latched gear selection but 30 ms bus-rate
 * chatter at walking pace; `stand_up` is excluded on MEANING, since a bike on a workshop
 * lift reads 1 and that is precisely the situation service mode is for; `key_on` has never
 * been observed as anything but 1, and a check never seen to fail is not a check;
 * `throttle_pct`'s 🟡 ÷10 scale could refuse every sweep for ever; 0x101 b0/b1 is a
 * not-DC-charging detector rather than a vehicle mode; `bms_state_*` is the BMS's own
 * charge state and says nothing about motion; `high_beam_lamp` is the high beam and shipped
 * as `charging` until 2026-08-16; and `bms_err_contactor` is a fault flag, not contactor
 * state — nothing on this bus broadcasts HV-live at all.
 */
const EXCLUDED_FROM_GATE = [
  "reverse_gear",
  "stand_up",
  "key_on",
  "throttle_pct",
  "high_beam_lamp",
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
  // ⚠️ The veto is decided BEFORE the evidence is believed, and whether it actually
  // cancelled anything is what decides if the rider is told about the cable. An inlet
  // that is empty while nothing was claiming a charge has changed no outcome and says
  // nothing worth interrupting them with.
  const inletEmpty = inletIsEmpty(readings);
  const witnessed = findChargingEvidence(readings);
  const chargingEvidence = inletEmpty ? null : witnessed;
  const checks = RULES.map(rule => checkRule(rule, readings[rule.key], chargingEvidence !== null));
  checks.push(inletCheck(readings, inletEmpty));
  const blockers = blockersFrom(checks);
  // ⚠️ The veto gets a sentence only when it DECIDED the refusal — believing the witness
  // would have opened the gate, and cancelling it is what shut it. An empty inlet on a bike
  // whose drive is down has changed nothing, and refusing it (or blaming the cable for a
  // bike that is simply moving) is a false alarm on the one control the rider needs to
  // trust. Deciding this needs the counterfactual, which is why the rules are judged twice.
  if (inletEmpty && witnessed !== null && blockers.length > 0) {
    const hadTheWitnessBeenBelieved = blockersFrom(RULES.map(rule => checkRule(rule, readings[rule.key], true)));
    if (hadTheWitnessBeenBelieved.length === 0) {
      blockers.unshift(CHARGE_INLET_BLOCKER);
    }
  }
  return { safe: blockers.length === 0, blockers, checks, chargingEvidence };
}

/** Every check that blocks, as the sentences the page shows, in RULES order. */
function blockersFrom(checks: ServiceGateCheck[]): string[] {
  const blockers: string[] = [];
  for (const check of checks) {
    if (check.state === "ok" || check.state === "excused-by-charging" || check.state === "inlet-empty") {
      continue;
    }
    if ((check.state === "missing" || check.state === "stale") && !check.required) {
      // A corroborator we have not heard from lately, or at all. Recorded in
      // `checks` so it stays visible on the page, but it cannot block.
      //
      // ⚠️ `stale` is the one that matters, and excusing only `missing` was wrong.
      // `missing` describes just the window before the OBD poller's first
      // successful PID 0D reply — after that `lastSeenMonotonic` keeps the mark
      // for ever, so from then on the only way this rule can ever say "our own
      // poller has gone quiet" is `stale`. Blocking on it made a corroborator
      // required in everything but name, contradicting `required`'s own contract.
      //
      // Worse, a running sweep is the likeliest CAUSE of it. ~277 requests share
      // a bus src/can/obd-dtc.ts measures as the scarce resource, so a poller
      // starved past the 10 s budget would have aborted the very sweep that
      // starved it — and then done it again on the next attempt. A silence we
      // caused ourselves is not evidence about the motorcycle.
      continue;
    }
    blockers.push(describeBlocker(check));
  }
  return blockers;
}

/**
 * Every signal this gate reads — rules, charge evidence and the inlet veto.
 *
 * ⚠️ DERIVED FROM THE TABLES, never written out. A hand-kept list is how the charging
 * escape came to be dead code on the motorcycle for its whole life: `CHARGE_EVIDENCE`'s
 * keys were not in it, so the sampler never asked for them, `findChargingEvidence` could
 * only ever return null on the Pi, and every check passed because the checks build their
 * own readings from decoded frames. docs/vcu-parameters.md §12.
 */
export function serviceGateSignalKeys(): string[] {
  return GATE_SIGNAL_KEYS;
}

// Derived once at import, from the tables, because they cannot change afterwards — 16× the
// work of the old hand-kept list when it was rebuilt on every call, and this runs on two
// 200 ms watchdogs. Still derived, which is the whole point of the note above; just once.
const GATE_SIGNAL_KEYS: string[] = [...new Set([...RULES.map(rule => rule.key), ...chargeEvidenceKeys()])];

/**
 * Samples exactly what the gate reads, from a reader the caller supplies.
 *
 * ⚠️ THE POINT IS THAT THE CALLER CANNOT EXPRESS A SMALLER SET. src/vcu/read-runner.ts used
 * to build the readings map itself from a key list, and the one time that list disagreed
 * with what the decision consulted, the disagreement was invisible for a month and on
 * every code path — reads, writes, probes and the watchdog alike.
 *
 * Injected rather than imported so this file stays pure: no signal registry, no clock.
 */
export function sampleServiceGate(read: (key: string) => ServiceGateSample): ServiceGateReadings {
  return Object.fromEntries(serviceGateSignalKeys().map(key => [key, read(key)]));
}

/** The signals considered and rejected, exported so a check can assert they stayed rejected. */
export function serviceGateExcludedKeys(): readonly string[] {
  return EXCLUDED_FROM_GATE;
}

function checkRule(rule: ServiceGateRule, sample: ServiceGateSample | undefined, charging: boolean): ServiceGateCheck {
  const value = sample?.value ?? null;
  const ageMs = sample?.ageMs ?? null;
  const base = { key: rule.key, requirement: rule.requirement, value, ageMs, required: rule.required };
  // For the two signals that ride on 0x104, "we cannot see it" is an accepted answer while
  // a charger is attached — ONLY then, and ONLY for absence. See CHARGE_EVIDENCE_LIVENESS
  // for what still has to be live, and for why the reason this rule exists is refuted (#194)
  // while the rule itself stands.
  const absenceAllowed = rule.whileCharging === "allow-absent" && charging;
  if (value === null || ageMs === null) {
    return { ...base, state: absenceAllowed ? "excused-by-charging" : "missing" };
  }
  // Staleness is judged BEFORE the value, so a stale zero is reported as stale
  // rather than as safe. That ordering is the whole gate in one line: a reading
  // that no longer describes the bike is not evidence about the bike.
  if (ageMs > rule.maxAgeMs) {
    return { ...base, state: absenceAllowed ? "excused-by-charging" : "stale" };
  }
  if (rule.isSafe(value)) {
    return { ...base, state: "ok" };
  }
  // A fresh reading that says the bike is not safe. Only `energized` is ever
  // excused here, and only against evidence of a charger: `allow-absent` rules are
  // NOT excused at this point, which is the whole distinction — a fresh 0x104
  // saying the wheel is turning blocks whether or not something is plugged in.
  return { ...base, state: rule.whileCharging === "excuse-unsafe" && charging ? "excused-by-charging" : "unsafe" };
}

/**
 * The veto as a row, whether or not it fired.
 *
 * `required: false`, so "the charge manager has never spoken" — which is every parked,
 * unplugged bike — falls through the same machinery every other corroborator uses instead
 * of being a special case here.
 */
function inletCheck(readings: ServiceGateReadings, inletEmpty: boolean): ServiceGateCheck {
  const sample = readings[CHARGE_INLET_VETO.key];
  const value = sample?.value ?? null;
  const ageMs = sample?.ageMs ?? null;
  const base = {
    key: CHARGE_INLET_VETO.key,
    requirement: CHARGE_INLET_VETO.requirement,
    value,
    ageMs,
    required: false,
  };
  if (inletEmpty) {
    return { ...base, state: "inlet-empty" };
  }
  if (value === null || ageMs === null) {
    return { ...base, state: "missing" };
  }
  if (ageMs > CHARGE_INLET_VETO.maxAgeMs) {
    return { ...base, state: "stale" };
  }
  return { ...base, state: "ok" };
}

/**
 * What the rider reads when the veto cancelled a charge that something else was claiming.
 *
 * A fixed sentence rather than one built from the byte: the value is a bitfield and
 * "it reads 16" would send somebody to a decode table to learn that their cable is loose.
 */
export const CHARGE_INLET_BLOCKER =
  "the charge manager reports nothing in the inlet — a cable that is not seated cannot make the bike safe to service";

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
    case "excused-by-charging":
    case "inlet-empty":
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
