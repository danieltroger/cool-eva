import { readFile } from "node:fs/promises";
import { decodeFrame } from "../src/can/decode.ts";
import { parseHexBytes } from "./captured-vcu-records.ts";
import { SIGNALS } from "../src/can/registry.ts";
import {
  evaluateServiceGate,
  sampleServiceGate,
  serviceGateSignalKeys,
  type ServiceGateReadings,
} from "../src/vcu/service-gate.ts";
import {
  CHARGE_EVIDENCE,
  CHARGE_INLET_VETO,
  CHARGE_SESSION_MAX_AGE_MS,
  chargeManagerIsLive,
  chargePathIsActive,
  chargeSessionFrom,
} from "../src/vcu/charge-session.ts";
import { serviceActionPolicy, serviceActionRefusal, type ServiceWriteRequest } from "../src/vcu/write-runner.ts";
import { HOW_TO_READ } from "../src/vcu/lifetime-store.ts";

// May a CHARGING motorcycle be serviced? The gate's charge behaviour, end to end.
//
//   node --experimental-strip-types scripts/check-service-gate-charging.ts
//
// ⚠️ Every bike state below is REAL BYTES, replayed through src/can/decode.ts, with the
// capture and the timestamp beside it — so a passing row is a fact about a motorcycle and
// not about a fixture agreeing with itself. The one constructed state is marked as such
// and its bytes are sourced individually, the way scripts/check-charge-mode.ts does it.
//
// What each witness is, why the inlet veto exists and what is still unmeasured:
// docs/vcu-parameters.md §12.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** Frames → the readings the gate consumes, per-frame ages so freshness can be posed. */
function readingsFrom(frames: [number, string, number?][], defaultAgeMs = 50): ServiceGateReadings {
  const readings: ServiceGateReadings = {};
  for (const [id, hex, frameAgeMs] of frames) {
    // parseHexBytes, not parseInt: it THROWS on a malformed byte, where parseInt turns a
    // typo into NaN and then 0 — a frame nobody ever wrote, asserted against in a safety gate.
    const bytes = Buffer.from(parseHexBytes(hex));
    for (const { key, value } of decodeFrame(id, bytes)) {
      readings[key] = { value, ageMs: frameAgeMs ?? defaultAgeMs };
    }
  }
  return readings;
}

// ── the fixtures, each one bytes off the wire ────────────────────────────────
//
// AC: capture-20260803-210802-8579bbf4.log at 2026-08-04 01:30:00 — six hours into an
// overnight AC charge. 0x102 b1 = 0x02 is `energized` with nothing else set, which is the
// state this whole feature exists to serve.
const AC_102_ENERGIZED = "00 02 00 44 94 FF D8 FF";
const AC_104_STILL = "A1 9A 02 00 00 00 00 00";
const AC_610 = "19 00 00 00 F1 05 01 02"; // status 0x19: inlet present + locked; state 0x02 AC
const AC_305 = "01 0F 00 0B 00 80 0B FF";

// DC: capture-20260809-144317-edcdcf23.log at 14:51:00 — a settled DC fast charge.
// 0x102 b3 = 0x45 is the fast-DC contactor closed.
const DC_102_CONTACTOR = "00 12 00 45 78 FF E9 FF";

// The DC handshake: capture-20260809-080235-cd40b535.log at 14:43:30, inside the
// 14:42:53.883 → 14:44:52.390 window the two other witnesses are blind to.
const DC_610_HANDSHAKE = "0A 00 00 00 F1 05 01 23"; // inlet present, settled DC
const DC_102_HANDSHAKE = "00 10 00 44 7D FF E9 FF"; // key_on only — b3 bit0 clear

// ⚠️ EPISODE E0, and it is the reason the veto exists.
// capture-20260809-080235-cd40b535.log, 14:36:59.856562 → 14:37:14.657580: a failed charge
// attempt whose likeliest diagnosis is plug detection. `charge_manager_state` reads 0x02 —
// the settled AC value — in 123 of 123 frames, decoding cleanly (b4 = 0xF1), while b0 says
// no inlet and no lock throughout. This frame is one of the 107 that read 0x00.
const E0_610 = "00 00 00 00 F1 05 01 02";

// Motion, for the rows that must refuse: capture-20260809-144317 at 15:10:00, the ride out.
const ROLLING_104 = "75 B1 02 00 22 05 B2 42";

console.log("\n1. the two fixtures named in the ruling");

// ⚠️ NON-NEGOTIABLE #1 — E0 is REFUSED. Nothing else says the bike is charging, so the
// settled `0x02` would be believed without the veto, and a parameter write to a calibration
// EEPROM would be allowed on a bike whose own charge manager reports an empty inlet.
const e0 = evaluateServiceGate(
  readingsFrom([
    [0x102, AC_102_ENERGIZED],
    [0x104, AC_104_STILL],
    [0x610, E0_610],
  ])
);
check("E0: a settled AC state with no inlet and no lock must NOT be serviceable", !e0.safe);
check("…and the refusal names the cable rather than the drive", e0.blockers[0].includes("inlet"));
check("…and no charge is claimed", e0.chargingEvidence === null);
check(
  "…with the veto reported as its own state, not folded into a rule",
  e0.checks.find(row => row.key === CHARGE_INLET_VETO.key)?.state === "inlet-empty"
);

// ⚠️ NON-NEGOTIABLE #2 — the DC handshake window is ALLOWED. The contactor is still open
// and the onboard AC charger is silent, so `charge_manager_state` is the only witness.
const handshake = evaluateServiceGate(
  readingsFrom([
    [0x102, DC_102_HANDSHAKE],
    [0x104, AC_104_STILL],
    [0x610, DC_610_HANDSHAKE],
  ])
);
check(
  `the 14:42:53-14:44:52 DC handshake must be serviceable, blocked by: ${handshake.blockers.join(" · ")}`,
  handshake.safe
);
check("…and the charge manager is what says so", handshake.chargingEvidence?.includes("DC session") === true);
// ⚠️ Stated rather than implied: `energized` reads 0 in all 11 850 frames of that window, so
// this row would pass even with no witness at all. What it proves is that the witness fires
// and names DC — not that it changed the outcome. See §2 for the state that needs it, and
// docs/vcu-parameters.md §12 for why no capture here holds that state.
check(
  "…and the window's own bytes really do have the drive down",
  readingsFrom([[0x102, DC_102_HANDSHAKE]])["energized"]?.value === 0
);

console.log("\n2. each witness, alone, on a bike whose drive IS up");

// The three witnesses against the same energized, stationary bike. Only the third is
// CONSTRUCTED: its 0x102 is the AC session's (energized, contactor clear) and its 0x610 is
// the DC handshake's (settled, inlet present) — two real frames, never seen in one second,
// because no capture here holds an energized bike witnessed only by the charge manager.
for (const [label, frames] of [
  [
    "the fast-DC contactor",
    [
      [0x102, DC_102_CONTACTOR],
      [0x104, AC_104_STILL],
    ],
  ],
  [
    "the AC charger frames",
    [
      [0x102, AC_102_ENERGIZED],
      [0x104, AC_104_STILL],
      [0x305, AC_305],
    ],
  ],
  [
    "the charge manager (CONSTRUCTED)",
    [
      [0x102, AC_102_ENERGIZED],
      [0x104, AC_104_STILL],
      [0x610, DC_610_HANDSHAKE],
    ],
  ],
] as [string, [number, string][]][]) {
  const verdict = evaluateServiceGate(readingsFrom(frames));
  check(`${label} alone excuses an energized bike, blocked by: ${verdict.blockers.join(" · ")}`, verdict.safe);
  check(
    `…and ${label} reports energized as excused rather than silently ok`,
    verdict.checks.find(row => row.key === "energized")?.state === "excused-by-charging"
  );
}

console.log("\n3. the truth table");

const CHARGING_AC: [number, string][] = [
  [0x102, AC_102_ENERGIZED],
  [0x104, AC_104_STILL],
  [0x610, AC_610],
  [0x305, AC_305],
];

// {bike state} × {read, parameter write, reset-vcu, charge-current, charge-stop}. Reads and
// parameter writes are the gate; the other three are serviceActionPolicy plus the session
// predicates, called rather than restated.
const TABLE: { state: string; frames: [number, string, number?][]; gate: boolean; reset: boolean; charge: boolean }[] =
  [
    {
      state: "stationary, drive down, unplugged",
      frames: [
        [0x102, "00 00 00 44 94 FF D8 FF"],
        [0x104, AC_104_STILL],
      ],
      gate: true,
      reset: true,
      charge: false,
    },
    {
      state: "stationary, ENERGIZED, unplugged",
      frames: [
        [0x102, AC_102_ENERGIZED],
        [0x104, AC_104_STILL],
      ],
      gate: false,
      reset: false,
      charge: false,
    },
    { state: "stationary, energized, AC charging", frames: CHARGING_AC, gate: true, reset: false, charge: true },
    {
      state: "stationary, energized, DC charging",
      frames: [
        [0x102, DC_102_CONTACTOR],
        [0x104, AC_104_STILL],
        [0x610, DC_610_HANDSHAKE],
      ],
      gate: true,
      reset: false,
      charge: true,
    },
    {
      state: "charging, and MOVING",
      frames: [...CHARGING_AC.slice(0, 1), [0x104, ROLLING_104], ...CHARGING_AC.slice(2)],
      gate: false,
      reset: false,
      charge: true,
    },
    {
      state: "charging, and IN DRIVE",
      frames: [
        [0x102, "00 0A 00 44 94 FF D8 FF"],
        [0x104, AC_104_STILL],
        [0x610, AC_610],
        [0x305, AC_305],
      ],
      gate: false,
      reset: false,
      charge: true,
    },
    {
      state: "moving, unplugged",
      frames: [
        [0x102, AC_102_ENERGIZED],
        [0x104, ROLLING_104],
      ],
      gate: false,
      reset: false,
      charge: false,
    },
    {
      state: "E0: settled state, empty inlet",
      frames: [
        [0x102, AC_102_ENERGIZED],
        [0x104, AC_104_STILL],
        [0x610, E0_610],
      ],
      gate: false,
      reset: false,
      charge: true,
    },
    {
      state: "cable out 6 s ago, value still 0x02",
      frames: [
        [0x102, AC_102_ENERGIZED],
        [0x104, AC_104_STILL],
        [0x610, AC_610, 6000],
        [0x305, AC_305, 6000],
      ],
      gate: false,
      reset: false,
      charge: false,
    },
  ];

for (const row of TABLE) {
  const readings = readingsFrom(row.frames);
  const verdict = evaluateServiceGate(readings);
  const state = readings["charge_manager_state"] ?? { value: null, ageMs: null };
  const sessionLive = chargeManagerIsLive(state.value, state.ageMs);
  const settled = chargeSessionFrom(state.value, state.ageMs) !== null;

  // Reads and parameter writes both ride the bike-state gate — that they do is §6's job, so
  // this row asserts the verdict once rather than twice with a constant `&&`ed onto it.
  check(`${row.state} · read and parameter write ${row.gate ? "allowed" : "refused"}`, verdict.safe === row.gate);
  // ⚠️ reset-vcu is NOT gate-exempt, so it refuses wherever the gate does AND wherever a
  // session is live — the two reasons compose, and a row that is unsafe for a read is
  // unsafe for a reset whether or not anything is plugged in.
  // ⚠️ The SHIPPED composition, not a rebuild of it beside the table. Rebuilding
  // `(!gateApplies || safe) && !(refused && charging)` here is how a check goes green while
  // checkPreconditions composes it differently — the failure this whole PR is about.
  const resetPolicy = serviceActionPolicy("reset-vcu");
  const pathActive = chargePathIsActive(key => readings[key] ?? { value: null, ageMs: null });
  const resetAllowed = serviceActionRefusal(resetPolicy, verdict, pathActive, "reset-vcu") === null;
  check(`${row.state} · reset-vcu ${row.reset ? "allowed" : "refused"}`, resetAllowed === row.reset);
  // charge-current is gate-EXEMPT and needs a settled session — bike state cannot refuse it.
  const chargeCurrentPolicy = serviceActionPolicy("charge-current");
  const chargeAllowed =
    serviceActionRefusal(chargeCurrentPolicy, verdict, pathActive, "charge-current") === null && settled;
  check(`${row.state} · charge-current ${row.charge ? "allowed" : "refused"}`, chargeAllowed === row.charge);
  check(
    `${row.state} · charge-stop follows charge-current`,
    serviceActionPolicy("charge-stop").bikeStateGateApplies ===
      serviceActionPolicy("charge-current").bikeStateGateApplies
  );
}

check(
  "charge-stop is exempt from the bike-state gate exactly as charge-current is",
  serviceActionPolicy("charge-stop").bikeStateGateApplies === serviceActionPolicy("charge-current").bikeStateGateApplies
);

console.log("\n3b. the two holes the diff review found, so they cannot come back");

// ⚠️ HOLE 1 — a DC fast charge witnessed ONLY by the contactor. This is the exact state the
// third witness exists to insure against (the 0x610 decode gate dropping), and keying the
// reset refusal on charge_manager_state alone permitted `11 02` straight into it.
const contactorOnly = readingsFrom([
  [0x102, DC_102_CONTACTOR],
  [0x104, AC_104_STILL],
]);
const contactorVerdict = evaluateServiceGate(contactorOnly);
check("a contactor-only DC charge is serviceable", contactorVerdict.safe);
check("…and is named as charge evidence", contactorVerdict.chargingEvidence !== null);
check(
  "…and reset-vcu REFUSES it, even though charge_manager_state never arrived",
  chargePathIsActive(key => contactorOnly[key] ?? { value: null, ageMs: null })
);
check(
  "…which the narrower predicate would have missed",
  !chargeManagerIsLive(
    contactorOnly["charge_manager_state"]?.value ?? null,
    contactorOnly["charge_manager_state"]?.ageMs ?? null
  )
);

// ⚠️ HOLE 2 — the veto must speak only when it DECIDED the refusal. An empty inlet on a bike
// whose drive is down has cancelled nothing, and refusing it blamed a cable for a bike that
// was fine. `0x102` b1 = 0x00 is the drive down with the key off.
const inletEmptyDriveDown = evaluateServiceGate(
  readingsFrom([
    [0x102, "00 00 00 44 94 FF D8 FF"],
    [0x104, AC_104_STILL],
    [0x610, E0_610],
  ])
);
check("an empty inlet on a bike with the drive down changes nothing, so the gate stays open", inletEmptyDriveDown.safe);
check("…and the rider is not told about a cable", inletEmptyDriveDown.blockers.length === 0);
check(
  "…while the veto is still on the record",
  inletEmptyDriveDown.checks.find(row => row.key === CHARGE_INLET_VETO.key)?.state === "inlet-empty"
);
// …and when something else is the reason, the cable is not blamed for it either.
const inletEmptyRolling = evaluateServiceGate(
  readingsFrom([
    [0x102, AC_102_ENERGIZED],
    [0x104, ROLLING_104],
    [0x610, E0_610],
  ])
);
check("a moving bike with an empty inlet is refused for the motion", !inletEmptyRolling.safe);
check(
  "…and not for the cable, which was never what let it in",
  !inletEmptyRolling.blockers.some(blocker => blocker.includes("inlet"))
);

// ⚠️ And every witness has to be STALE-PROOF, because `liveState` keeps the last value for
// ever. Widening any of these windows is the mutation the first version of this check let
// through: a 10-minute contactor window makes a bike that finished charging an hour ago
// still "charging". One row per witness, each at 30 s.
for (const [label, frames] of [
  [
    "the contactor",
    [
      [0x102, DC_102_CONTACTOR, 30_000],
      [0x104, AC_104_STILL],
    ],
  ],
  [
    "the charger frames",
    [
      [0x102, AC_102_ENERGIZED],
      [0x104, AC_104_STILL],
      [0x305, AC_305, 30_000],
    ],
  ],
  [
    "the charge manager",
    [
      [0x102, AC_102_ENERGIZED],
      [0x104, AC_104_STILL],
      [0x610, AC_610, 30_000],
    ],
  ],
] as [string, [number, string, number?][]][]) {
  const verdict = evaluateServiceGate(readingsFrom(frames));
  check(`${label} 30 s old is not a bike that is plugged in`, verdict.chargingEvidence === null);
  check(`…so ${label} being stale cannot excuse an energized drive`, !verdict.safe);
}

console.log("\n4. the sampler asks for everything the decision reads");

// ⚠️ THE BUG THIS WHOLE CHECK EXISTS FOR. The charge evidence was consulted by the decision
// and never sampled by the runner, so the escape was dead on the motorcycle for its entire
// life while every check passed — the checks build their own readings from frames.
const sampled = new Set(Object.keys(sampleServiceGate(() => ({ value: 0, ageMs: 0 }))));

// ⚠️ WATCH THE DECISION READ, rather than comparing two spellings of the same list. An
// earlier version of this section looped over `CHARGE_EVIDENCE.map(rule => rule.key)` and
// asserted the sampler had them — which is character-for-character what the sampler derives
// from, so it could not fail. This asks the only question that matters: does
// evaluateServiceGate touch a key nobody sampled?
const readKeys = new Set<string>();
const probe = new Proxy({} as ServiceGateReadings, {
  get(_target, key) {
    if (typeof key === "string") {
      readKeys.add(key);
    }
    return undefined;
  },
  has() {
    return true;
  },
});
evaluateServiceGate(probe);
const unsampled = [...readKeys].filter(key => !sampled.has(key));
check(
  `the decision reads nothing the sampler skips, unsampled: ${unsampled.join(", ") || "none"}`,
  unsampled.length === 0
);
check("…and the decision really did read something", readKeys.size > 0);

// …and the PRODUCTION caller has to go through it. The bug was never in the list; it was a
// runner that built its own readings map beside it, which no assertion about the list could
// have seen. src/index.ts hands this one gate to every service endpoint and both watchdogs.
const runnerSource = await readFile(new URL("../src/vcu/read-runner.ts", import.meta.url), "utf8");
check("read-runner samples through the gate", /sampleServiceGate\(/.test(runnerSource));
check(
  "…and does not build a readings map of its own",
  !/Object\.fromEntries\(\s*serviceGateSignalKeys/.test(runnerSource)
);
// A key list with no spelling check is a comment wearing a check's clothes: a signal nothing
// produces would sit here for ever, sampled as `null`, and the rule reading it never fires.
const registered = new Set(SIGNALS.map(signal => signal.key));
for (const key of serviceGateSignalKeys()) {
  check(`${key} is a signal src/can/registry.ts actually produces`, registered.has(key));
}

console.log("\n5. the windows cannot drift apart in the dangerous direction");

// ⚠️ A window where the GATE says "charging, so energized is excused" while performResetVcu
// says "not charging, go ahead" is a VCU reset into a live charge. The gate's charge witness
// must therefore never outlive the reset refusal. Asserted as an ordering rather than as
// equality, so deliberately splitting the constants still fails.
const chargeManagerRule = CHARGE_EVIDENCE.find(rule => rule.key === "charge_manager_state");
check(
  "the gate's charge-manager window never exceeds the one reset-vcu refuses on",
  (chargeManagerRule?.maxAgeMs ?? Infinity) <= CHARGE_SESSION_MAX_AGE_MS
);
check(
  "a session that is live for reset-vcu is live for every settled reading the gate believes",
  chargeManagerIsLive(0x02, CHARGE_SESSION_MAX_AGE_MS) && chargeSessionFrom(0x02, CHARGE_SESSION_MAX_AGE_MS) !== null
);
check(
  "…and the handshake states refuse a charge-current command while still refusing a reset",
  chargeSessionFrom(0x14, 100) === null && chargeManagerIsLive(0x14, 100)
);

console.log("\n6. every action kind is classified");

// ⚠️ TOTAL over the union, and the totality is the TYPE's, not a list's: EXPECTED is keyed on
// `ServiceWriteRequest["kind"]`, so a new action is a type error HERE as well as in
// serviceActionPolicy's `default`-less switch. A hand-written array beside it would have gone
// on passing with the new kind simply absent.
const EXPECTED: Record<ServiceWriteRequest["kind"], [boolean, boolean, boolean]> = {
  "parameter": [true, false, true],
  "parameters": [true, false, true],
  "bit": [true, false, true],
  "read-service-stamp": [true, false, false],
  "set-service-point": [true, false, false],
  "sync-clock": [true, false, false],
  "clear-dtcs": [true, false, false],
  "charge-current": [false, false, false],
  "charge-stop": [false, false, false],
  "reset-vcu": [true, true, false],
};
const KINDS = Object.keys(EXPECTED) as ServiceWriteRequest["kind"][];
for (const kind of KINDS) {
  const policy = serviceActionPolicy(kind);
  const [gate, charging, table] = EXPECTED[kind];
  check(
    `${kind} · gate ${gate} · refused-while-charging ${charging} · table ${table}`,
    policy.bikeStateGateApplies === gate &&
      policy.refusedWhileCharging === charging &&
      policy.tableGateApplies === table
  );
}
check(
  "exactly two actions are exempt from the bike-state gate",
  KINDS.filter(kind => !serviceActionPolicy(kind).bikeStateGateApplies).length === 2
);
check(
  "exactly one action is refused while charging",
  KINDS.filter(kind => serviceActionPolicy(kind).refusedWhileCharging).length === 1
);

console.log("\n7. the on-screen instruction and the gate describe the same bike");

// ⚠️ PINNED TO THE VERDICT, not to a second copy of the sentence. The instruction the All
// tab shows on a Pi that has never taken a reading has to describe the bike this gate
// actually admits, and it has drifted twice: it named a shell flag that never existed, and
// then (#187) a bike with the drive down, which was right only because the charging escape
// was dead. These four assertions fail whichever of the two moves alone.
const chargingBike = evaluateServiceGate(
  readingsFrom([
    [0x102, DC_102_CONTACTOR],
    [0x104, AC_104_STILL],
  ])
);
check("a stationary charging bike passes the gate", chargingBike.safe);
check(
  `…so the instruction must name that case, got ${JSON.stringify(HOW_TO_READ)}`,
  HOW_TO_READ.includes("or plugged in")
);
// Duplicates check-vcu-params.ts's `energizedNotCharging` on a different fixture. Said out
// loud rather than presented as new coverage: what is new is the pairing with the copy.
const energizedUnplugged = evaluateServiceGate(
  readingsFrom([
    [0x102, AC_102_ENERGIZED],
    [0x104, AC_104_STILL],
  ])
);
check("…while an energized, unplugged bike is still refused", !energizedUnplugged.safe);
check("…so the instruction must still name the drive", HOW_TO_READ.includes("drive down"));
// ⚠️ The exact disjunct, and the negatives. An alternation like /plugged in|charg/ matches
// "and NOT plugged in" just as happily, and polarity is the one distinction a safety
// instruction cannot afford to get wrong.
for (const forbidden of ["not charging", "unplug", "not plugged"]) {
  check(`…and must not tell the rider to ${forbidden}`, !HOW_TO_READ.toLowerCase().includes(forbidden));
}

if (failures > 0) {
  console.error(`\nFAILED — ${failures} checks`);
  process.exit(1);
}
console.log("\n✓ the charging gate holds, on real bytes");
