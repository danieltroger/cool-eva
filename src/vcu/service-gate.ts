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
  | "missing"
  /**
   * Would have blocked, and does not, because the bike is on a charger. Only
   * `energized` can ever be this — see CHARGE_EVIDENCE. A state of its own rather
   * than silently reporting `ok`, so the page can say WHY it is allowed and nobody
   * reads a passing gate as "the drive is down" when it is not.
   */
  | "excused-by-charging";

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
   *    only because the bike stops broadcasting that frame while it charges — see
   *    the note under CHARGE_EVIDENCE_LIVENESS below.
   */
  whileCharging?: "excuse-unsafe" | "allow-absent";
}

/**
 * How long a charger frame may be silent and still count as "plugged in".
 *
 * 0x305 and 0x306 are 5 Hz and are broadcast only while a charger is attached
 * (src/can/decode.ts), so their FRESHNESS is the evidence and their values are not
 * consulted at all. Two seconds is ten frames of margin.
 *
 * ⚠️ It has to be a freshness test rather than a value test, because `liveState`
 * keeps the last value of every signal for ever: `dc_v` reads 400 V until the next
 * reboot, whether or not anything is plugged in. Only the age tells the difference,
 * which is the same trap the rest of this file is built around.
 */
const CHARGER_FRAME_MAX_AGE_MS = 2000;

interface ChargeEvidenceRule {
  key: string;
  /** How the page says it, e.g. "the charger is reporting DC volts". */
  meaning: string;
  /** True when this reading, being fresh, means a charger is attached. */
  counts: (value: number) => boolean;
  maxAgeMs: number;
}

/**
 * What makes a charge session believable. ANY ONE of these, fresh, is enough.
 *
 * ⚠️ The escape is deliberately narrow, and that is what makes it cheap: it excuses
 * exactly ONE check, `energized`. Speed, motor rpm, `moving`, `go`, `go_request` and
 * `throttle_on` all still have to be clear. So the worst a WRONG charge detection can do —
 * a false positive, this list firing when nothing is plugged in — is degrade the gate to
 * "stationary and not in drive". It cannot admit a moving bike, nor one in drive.
 *
 * ⚠️ 0x102 carries no usable charge bit: b2 bit0 is the HIGH BEAM (see the block under this
 * list), and `fast_dc_contactor` (b3 bit0) is set only on DC. The charger frames cover both
 * AC and DC, which is why they are the whole list. Why the escape exists at all, and why a
 * charging bike is a reasonable thing to service: docs/vcu-parameters.md §12.
 */
const CHARGE_EVIDENCE: ChargeEvidenceRule[] = [
  // The charger's own frames, 0x305 and 0x306 at 5 Hz, which decode.ts records as
  // present only while a charger is attached. Their VALUES are never consulted —
  // that the frame arrived at all is the claim — so this detects "plugged in"
  // rather than "current is flowing", which is the property that matters here: a
  // tethered bike cannot be ridden away without someone unplugging it first.
  //
  // Verified against rides.db 2026-08-16: 162 377 charger-frame rows in 30 clusters,
  // 25 of them drawing ≥ 2 A. The idle clusters (mains ~1.4 A) are plugged-in-but-
  // not-charging, and they count here on purpose.
  { key: "dc_v", meaning: "the charger is reporting DC volts", counts: () => true, maxAgeMs: CHARGER_FRAME_MAX_AGE_MS },
  { key: "dc_a", meaning: "the charger is reporting DC amps", counts: () => true, maxAgeMs: CHARGER_FRAME_MAX_AGE_MS },
  {
    key: "mains_v",
    meaning: "the charger is reporting mains volts",
    counts: () => true,
    maxAgeMs: CHARGER_FRAME_MAX_AGE_MS,
  },
  {
    key: "mains_a",
    meaning: "the charger is reporting mains amps",
    counts: () => true,
    maxAgeMs: CHARGER_FRAME_MAX_AGE_MS,
  },
];

// ⚠️⚠️ 0x102 b2 bit0 IS DELIBERATELY NOT IN THAT LIST, and the reason is worth more than
// the rule: **it is not a charging bit. It is the high beam.** It is now decoded under its
// real name, `high_beam_lamp`; it was called `charging` until 2026-08-16.
//
// It agrees with `high_beam` (0x102 b0 bit6) at 1 103 000 of 1 103 000 frames of 0x102
// across the 14 candump captures, with zero disagreements either way — while the cross-pair
// (b2 bit0 against b0 bit7) agrees only 49.35 %. It reads 0 through all 25 real charging
// sessions. Two different bytes, so it is not decoder aliasing. The third-party .xdbc's
// "b2 bit0 = charge" is simply wrong.
//
// Using it here would have meant SWITCHING ON THE HIGH BEAM EXCUSED THE DRIVE BEING
// ENERGIZED. The rename removes the trap's bait; this note stays because the list of things
// that are NOT charge evidence is worth more than the name that misled us. The rest of the
// measurement is in docs/vcu-parameters.md §12.

/**
 * ⚠️ Why two of the motion checks may go ABSENT while charging, and what still holds them
 * up. Across all 25 real charging sessions in rides.db there is not one live
 * `speed_can_kmh` or `motor_rpm_can` sample: the bike stops broadcasting 0x104 while it
 * charges, so a gate demanding a fresh one could never open on a charging bike — the single
 * state this whole feature exists to serve.
 *
 * ⚠️ NEVER fall back to the last value, and never fall back to zero. Forward-filling hands
 * you 47.0 km/h and 1 976 rpm for a bike that had been plugged in for seven hours.
 *
 * So those two may be missing or stale while a charger is attached, and the four below must
 * still be FRESH and clear. A fresh 0x104 that says the bike IS moving still blocks,
 * charger or no charger: this relaxes "we must see it", not "it must be zero".
 * docs/vcu-parameters.md §12.
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
  // switched off. What keeps it safe is that the excuse is narrow (see CHARGE_EVIDENCE) and
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
  const chargingEvidence = findChargingEvidence(readings);
  const checks = RULES.map(rule => checkRule(rule, readings[rule.key], chargingEvidence !== null));
  const blockers: string[] = [];
  for (const [position, check] of checks.entries()) {
    const rule = RULES[position];
    if (check.state === "ok" || check.state === "excused-by-charging") {
      continue;
    }
    if ((check.state === "missing" || check.state === "stale") && !rule.required) {
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
  return { safe: blockers.length === 0, blockers, checks, chargingEvidence };
}

/**
 * What says a charger is attached, or null.
 *
 * The FIRST match wins and is reported by name, so the page and the journal say
 * which signal carried the argument rather than a bare "charging: yes". On a gate
 * that relaxes a safety check, the evidence is the part worth being able to audit.
 */
function findChargingEvidence(readings: ServiceGateReadings): string | null {
  for (const rule of CHARGE_EVIDENCE) {
    const sample = readings[rule.key];
    if (sample === undefined || sample.value === null || sample.ageMs === null) {
      continue;
    }
    // Freshness first, exactly as in checkRule and for the same reason: `liveState`
    // holds the last value of every signal for ever, so an unplugged bike still
    // reports whatever `dc_v` last was. Only the age separates "plugged in" from
    // "was plugged in, once".
    if (sample.ageMs > rule.maxAgeMs) {
      continue;
    }
    if (rule.counts(sample.value)) {
      return rule.meaning;
    }
  }
  return null;
}

/** The signal keys this gate reads, so a caller knows what to sample without duplicating the list. */
export function serviceGateSignalKeys(): string[] {
  return RULES.map(rule => rule.key);
}

/** The signals considered and rejected, exported so a check can assert they stayed rejected. */
export function serviceGateExcludedKeys(): readonly string[] {
  return EXCLUDED_FROM_GATE;
}

function checkRule(rule: ServiceGateRule, sample: ServiceGateSample | undefined, charging: boolean): ServiceGateCheck {
  const value = sample?.value ?? null;
  const ageMs = sample?.ageMs ?? null;
  const base = { key: rule.key, requirement: rule.requirement, value, ageMs };
  // A charging bike stops broadcasting 0x104, so for the two signals that ride on
  // it, "we cannot see it" becomes an accepted answer — and ONLY while a charger is
  // attached, and ONLY for absence. See CHARGE_EVIDENCE_LIVENESS for what still has
  // to be live for this to be safe.
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
