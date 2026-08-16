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
//  • Six days of real riding (rides.db, 6.2 M rows, analysed 2026-08-16) settled
//    four things the captures alone could not, and every one of them changed this
//    file: the bit then called `charging` is the high beam; a charging bike stops
//    sending 0x104 entirely; `go_request` does not lead `go`; and `go`/`energized` read 0
//    while the bike rolls at up to 6.7 km/h. The notes are at each rule.
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
 * ── Why this list exists at all ──────────────────────────────────────────────
 * The owner needs to read (and later write) the DC charge-current limits, and that
 * work happens PLUGGED IN — you cannot test `MAX_DC_CHG_CURRENT` on a bike that is
 * not charging. A stationary charging bike is also arguably a safer thing to be
 * servicing than a stationary ready-to-ride one: it is tethered to a cable, the
 * rider is off it, and it cannot be ridden away without unplugging first.
 *
 * ── Why the escape is narrow, and why that makes it cheap ────────────────────
 * It excuses exactly ONE check, `energized`. Speed, motor rpm, `moving`, `go`,
 * `go_request` and `throttle_on` all still have to be clear. So the worst a WRONG
 * charge detection can do — a false positive, this list firing when nothing is
 * plugged in — is degrade the gate to "stationary and not in drive", which is
 * precisely what it would be if `energized` had never been in it. It cannot admit a
 * moving bike, and it cannot admit one in drive.
 *
 * ── Why 0x102 carries no usable charge bit ──────────────────────────────────
 * It used to look as though it did. `charging` (0x102 b2 bit0) was reasoned about
 * here as "the AC bit", on the grounds that it reads 0 through a DC fast charge.
 * That was too generous: it reads 0 through AC charging too, because it is the high
 * beam — see the block under this list, and decode.ts, where it was renamed to
 * `high_beam_lamp` on 2026-08-16. 0x102 does now carry ONE real charge signal,
 * `fast_dc_contactor` (b3 bit0), but it is set only on DC, so it cannot cover the AC
 * case on its own either. The charger frames cover both, which is why they are the
 * whole list.
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

// ⚠️⚠️ 0x102 b2 bit0 IS DELIBERATELY NOT IN THAT LIST, and the reason is worth more
// than the rule: **it is not a charging bit. It is the high beam.** It is now decoded
// under its real name, `high_beam_lamp`; it was called `charging` until 2026-08-16 and
// this file refused to depend on it for a fortnight before the rename caught up.
//
// Established from rides.db on 2026-08-16, six days of real riding:
//   • it equals `high_beam` (0x102 b0 bit6) at 421 of 421 timestamps — 100 %.
//   • Every transition of one is within 3 ms of a transition of the other (median 0).
//   • It reads 1 at 100-142 km/h, for 47 s at a stretch, on clean uninterleaved data.
//   • It reads **0 through all 25 real charging sessions**.
// Re-measured per frame the same day, over all 1 103 000 frames of 0x102 in the 14
// candump captures: 1 103 000 / 1 103 000 agreement, zero disagreements either way,
// while the cross-pair (b2 bit0 against b0 bit7) agrees only 49.35 % — so this is not
// two nearly-constant bits flattering each other.
//
// Two different bytes, so it is not decoder aliasing — they are two genuinely distinct
// bits that move together, the switch-and-lamp pairing decode.ts had already worked out
// for the blinkers. The third-party .xdbc's "b2 bit0 = charge" is simply wrong.
//
// Using it here would have meant SWITCHING ON THE HIGH BEAM EXCUSED THE DRIVE BEING
// ENERGIZED. The rename removes the trap's bait; this block stays because the list of
// things that are NOT charge evidence is worth more than the name that misled us.

/**
 * ⚠️ Why two of the motion checks may go ABSENT while charging, and what still
 * holds them up.
 *
 * rides.db, 2026-08-16: across all 25 real charging sessions there is **not one
 * live `speed_can_kmh` or `motor_rpm_can` sample**. The bike stops broadcasting
 * 0x104 while it charges (an Energica on a charger is asleep apart from the charge
 * manager and the BMS), so a gate that demanded a fresh one could never open on a
 * charging bike — which is the single state this whole feature exists to serve.
 *
 * Worse, the naive workaround is a trap the same data documents: forward-filling
 * the last value hands you **47.0 km/h and 1 976 rpm** for a bike that had been
 * plugged in for seven hours, because that is what it was doing when it last spoke.
 * Never fall back to the last value, and never fall back to zero.
 *
 * So while a charger is attached, those two are allowed to be missing or stale —
 * and everything below still has to be FRESH and clear:
 *
 *   `moving`, `go`, `go_request`, `throttle_on`
 *
 * All four are 0x102, which is 100 Hz and which CAN_MAP.md records as live through
 * a DC session (it caught b1 going 0x10 → 0x12 at the start of one). So the gate
 * still requires proof that the bike is awake and talking; it just no longer
 * requires the one frame the bike is known to stop sending. If 0x102 goes quiet
 * too, everything blocks and service mode is unavailable — correct, because a
 * sleeping VCU answers no `10 81` either and a sweep would read 277 no-sessions.
 *
 * A fresh 0x104 that says the bike IS moving still blocks, charger or no charger.
 * This relaxes "we must see it" and not "it must be zero".
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

  // ✅ CAN 0x102 b1 bit1, as a decode: observed 0 on the parked bike 2026-08-02 AND
  // observed toggling with the rider's actions on the garage lap that afternoon —
  // both states seen, which is what separates it from `key_on` below.
  //
  // ⚠️ `energized` = 1 does NOT mean "rideable". CAN_MAP.md records it setting for
  // the whole of a 17-minute stationary DC fast charge on 2026-08-04 (0x102 b1
  // 0x10 → 0x12 at the session start, clearing at the end). The bit means the HV
  // side is up, and a charging bike's HV side is up by definition.
  //
  // ⚠️⚠️ SO IT IS EXCUSED WHILE CHARGING, DELIBERATELY. An earlier version of this
  // file blocked a charging bike and argued that a false refusal was the safe
  // direction. That was wrong on the merits, not merely unpopular: the entire
  // reason service mode exists is to read — and later write — the DC charge-current
  // limits, and there is no way to test `MAX_DC_CHG_CURRENT` on a bike that is not
  // plugged in. Refusing the one state the feature is FOR is not caution; it is a
  // gate that gets switched off. A charging bike is also tethered to a cable, so it
  // cannot be ridden away without someone unplugging it first.
  //
  // Do not "fix" this back. What keeps it safe is that the excuse is narrow (see
  // CHARGE_EVIDENCE) and that every other check still applies: a charging bike must
  // still show zero speed, zero motor rpm, `moving` clear and the whole drive-
  // request trio clear. The implication this rule contributes is unchanged in the
  // direction that matters: `energized` 0 ⇒ the drive is down.
  {
    key: "energized",
    requirement: "the drive is not energized",
    isSafe: value => value === 0,
    maxAgeMs: BROADCAST_MAX_AGE_MS,
    required: true,
    whileCharging: "excuse-unsafe",
  },

  // ⚠️ Measured on rides.db 2026-08-16: `go` = 0 is NOT a reliable "cannot move".
  // Two clean episodes have the bike rolling at **5.2-6.7 km/h with `go` = 0 AND
  // `energized` = 0** (2026-08-08 14:59:53 for 8.1 s, and 15:00:30 for 1.1 s) —
  // physically ordinary, since a bike can be pushed or coast with the drive down.
  // That is exactly why speed and rpm are the load-bearing checks above and these
  // are corroboration. A gate resting on `go` alone would have opened on a bike
  // rolling at jogging pace. The converse holds well — 98.5 % of live `go` = 1 time
  // has the bike actually moving — so `go` = 1 is a trustworthy positive.
  //
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
 * Kept here rather than in a commit message because the next person to look at this
 * will have the same ideas, and most of them are traps. Several are things a brief
 * would reasonably suggest; the reasons they do not work are in the reverse-
 * engineering notes rather than anywhere obvious.
 *
 *  • `reverse_gear` (0x104 bit 63) — the obvious "not in gear" check, and now the
 *    best-understood rejection here. Settled against rides.db on 2026-08-16, six
 *    days of riding:
 *      – it is NOT a latched gear selection. 597 rising edges in **62 separate
 *        bursts across all six days**, and **404 of the 597 pulses are under 50 ms**
 *        (median 30 ms) — bus-rate chatter, which no rider-operated selector makes;
 *      – it IS tied to very low speed. Median `speed_can_kmh` at a rising edge is
 *        **0.4 km/h**, p95 0.7, and in clean data (excluding six windows where two
 *        contradictory 0x104 streams are interleaved) it **never exceeds 4.1 km/h**.
 *    So both earlier readings were half right: the owner saw it change when he
 *    engaged reverse, and the capture note saw it fire without reverse. It behaves
 *    like a direction-of-rotation or rollback indicator — plausibly the sign bit
 *    that `speed_can_kmh` and `motor_rpm_can` lack, since both are unsigned and
 *    neither ever goes negative in 6.2 M rows. Engaging reverse turns the wheel
 *    backwards, which is why it looked like a gear.
 *    Excluded because a 50 ms pulse cannot gate anything without heavy debouncing,
 *    and because "the wheel is creeping" is already covered by `speed_can_kmh`
 *    itself. Worth decoding properly under its real meaning some day.
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
 *  • `high_beam_lamp` (0x102 b2 bit0) — **the high beam**, and shipped as `charging`
 *    until 2026-08-16. Not a gate, and not charge evidence either; the full argument
 *    and the numbers are under CHARGE_EVIDENCE above. Kept on this list under its new
 *    name because the old one is still in the ride log, in old Grafana panels and in
 *    anyone's memory, and it was the one signal here whose NAME invited you to use it.
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
