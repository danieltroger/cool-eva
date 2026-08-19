import { decodeFrame } from "../src/can/decode.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { boundsFor } from "../public/lib/bounds.js";
import { chargeMode } from "../public/lib/charge-mode.js";

// Replays real frames through the real broadcast decoders and asks the dashboard's own
// charge rule what it makes of them — on a laptop, with no bike.
//
//   node --experimental-strip-types scripts/check-charge-mode.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ## What went wrong, and why replaying the decoder alone would not have caught it
//
// The charging screen showed "DC charging" on a bike parked in a garage with nothing
// plugged into it, directly above a card correctly reporting that the pack was
// DELIVERING 0.1 kW. Every decoder involved was right: `0x201` byte 0 read `01`, the
// bits came out as Discharge, and the delivery card read them correctly. What was
// wrong was one line of the view, which asked only "are the AC charger's frames
// arriving?" and called everything else DC — never asking whether a charge was
// happening at all.
//
// So this check sits one level above the frame decoders: real bytes in, and the answer
// the SCREEN acts on out. It is the join that had nothing testing it.
//
// ## The three values, and the two traps in them
//
// Across ~24 M frames `0x201` byte 0 takes exactly three values, and each has caught
// somebody:
//
//   0x01  Not charging — parked at −0.2 A and riding at −166 A alike. Two independent
//         reverse engineers labelled it "IDLE", which makes a discharging pack look
//         idle (obd-garage/CAN_MAP.md §"the .xdbc").
//   0x02  AC charging. Solid.
//   0x10  The BMS is not charge-managing. It covers a whole DC session — the current
//         bypasses the BMS charge path — but ALSO the last ~2 s of every AC session,
//         at −0.1 A. Reading it as "DC" is therefore wrong, which is why case 5 below
//         exists and why the DC arm rests on the contactor monitor instead.
//
// ## Provenance of the frames
//
// The 0x102 payloads are REAL, copied byte for byte with their timestamps out of the
// candump captures, the same ones scripts/check-button-decode.ts asserts the button
// and contactor bits against.
//
// The 0x201 payloads are CONSTRUCTED, and it is worth being exact about how: byte 0 is
// an observed value in every case (the `01` is from a live candump taken beside the
// bike the day this bug was reported; the `02` and `10` are the states CAN_MAP.md
// records for an AC session and its tail), and bytes 1-7 are the error and warning
// words, which have read all-zero in every capture of this healthy pack. So the byte
// under test is measured and the rest is the quiet background it has always sat in.
//
// The charger frames — 0x305 and 0x306 — are not replayed at all, on purpose. The rule
// never reads their values, only whether they arrived, so a case sets their FRESHNESS
// directly rather than inventing charger bytes that would imply a precision this has
// no need of.

const failures: string[] = [];

/** 0x102 at 100 Hz. b3 bit0 is the DC fast-charge contactor monitor. */
const PARKED_102 = "00 10 00 44 B0 FF D2 FF"; //  2026-08-04 19:58:18.703, 27 s before the contactor closed
const RIDING_102 = "C0 3E 83 44 F4 FF 17 00"; //  2026-08-02, flash-to-pass at 100 km/h
const DC_CONTACTOR_102 = "00 12 00 45 B5 FF D2 FF"; // 2026-08-04 19:58:45.488, the instant it closed

/** 0x201 at 10 Hz. b0 is the BMS System State bitfield; b1-7 are the error/warning words. */
const NOT_CHARGING_201 = "01 00 00 00 00 00 00 00";
const AC_CHARGING_201 = "02 00 00 00 00 00 00 00";
const BMS_IDLE_201 = "10 00 00 00 00 00 00 00";

/** The onboard charger's frames, whose values the rule never reads. See the note above. */
const CHARGER_FRAMES = { mains_v: 232, mains_a: 14.2, dc_v: 341, dc_a: 9.6 };

interface ChargeCase {
  /** The situation, as the rider would describe it. */
  what: string;
  /** Which frames the bike was putting on the bus. */
  frames: Array<{ id: number; hex: string }>;
  /**
   * Signals reaching the dashboard from frames not replayed here — see the note on
   * the charger frames above.
   */
  otherSignals?: Record<string, number>;
  /** Milliseconds since each signal last arrived. Anything unlisted is fresh. */
  ages?: Record<string, number>;
  expect: "ac" | "dc" | "charging" | "none";
  /** What this case is defending. */
  because: string;
}

const CASES: ChargeCase[] = [
  {
    what: "parked in the garage, ignition on, nothing plugged in",
    frames: [
      { id: 0x201, hex: NOT_CHARGING_201 },
      { id: 0x102, hex: PARKED_102 },
    ],
    expect: "none",
    because:
      "THE REPORTED BUG. The screen read '58 % · 0.1 kW in · DC charging' over a card correctly saying the pack was delivering 0.1 kW. Nothing here is charging and nothing may say it is",
  },
  {
    what: "riding at 100 km/h with the high beam flashed",
    frames: [
      { id: 0x201, hex: NOT_CHARGING_201 },
      { id: 0x102, hex: RIDING_102 },
    ],
    expect: "none",
    because:
      "Charge is a tab, so this screen is reachable mid-ride. pack_kw is perfectly live at −41 kW, so staleness catches nothing and only the rule can",
  },
  {
    what: "AC charging from a wall socket",
    frames: [
      { id: 0x201, hex: AC_CHARGING_201 },
      { id: 0x102, hex: PARKED_102 },
    ],
    otherSignals: CHARGER_FRAMES,
    expect: "ac",
    because: "The one state that already worked, and the regression this must not cause",
  },
  {
    what: "DC fast charging at 63 A",
    frames: [
      { id: 0x201, hex: BMS_IDLE_201 },
      { id: 0x102, hex: DC_CONTACTOR_102 },
    ],
    expect: "dc",
    because:
      "The BMS reports Idle for the whole session and the charger frames never come, so a rule built on 0x201 alone calls a 19 kW fast charge 'not charging' — which is what shipped, leaving the DC tiles unreachable on the screen written for them",
  },
  {
    what: "the last two seconds of an AC session, at −0.1 A",
    frames: [
      { id: 0x201, hex: BMS_IDLE_201 },
      { id: 0x102, hex: PARKED_102 },
    ],
    otherSignals: CHARGER_FRAMES,
    ages: { mains_v: 9000, mains_a: 9000, dc_v: 9000, dc_a: 9000 },
    expect: "none",
    because:
      "0x201 b0 holds the same 0x10 here as it does through a whole DC charge. Anything that reads that byte as 'DC' claims a fast charge at the end of every AC one",
  },
  {
    what: "DC fast charging, with the heartbeat that refreshes the contactor bit running a little late",
    frames: [
      { id: 0x201, hex: BMS_IDLE_201 },
      { id: 0x102, hex: DC_CONTACTOR_102 },
    ],
    ages: { fast_dc_contactor: 7000 },
    expect: "dc",
    because:
      "The bit holds at 1 for the whole session, and signals.ts patches only what MOVES — so on the phone nothing refreshes its timestamp but ws.ts's 5 s snapshot, and its apparent age sawtooths 0 → ~5 s against a serverTime that advances on every pack_a. A window with no room for a late heartbeat drops a running fast charge to 'not charging', tears down the DC tiles and bounces the rider off the charge tab",
  },
  {
    what: "unplugged from a DC charger a minute ago, 0x102 gone quiet with the contactor bit last seen set",
    frames: [
      { id: 0x201, hex: NOT_CHARGING_201 },
      { id: 0x102, hex: DC_CONTACTOR_102 },
    ],
    // A minute, not one millisecond past the window: what this pins is that the gate
    // exists at all, and pinning it to the constant's exact value would just restate
    // the constant.
    ages: { fast_dc_contactor: 60_000 },
    expect: "none",
    because:
      "The store keeps the last reading of every signal for ever, so the contactor bit reads 1 until the next reboot. Freshness is the claim, never the value",
  },
  {
    what: "AC charging with the charger's frames briefly quiet",
    frames: [
      { id: 0x201, hex: AC_CHARGING_201 },
      { id: 0x102, hex: PARKED_102 },
    ],
    otherSignals: CHARGER_FRAMES,
    ages: { mains_v: 9000, mains_a: 9000, dc_v: 9000, dc_a: 9000 },
    expect: "charging",
    because:
      "A charge is happening — the BMS says so — but nothing on the bus says what kind, and the contactor bit says it is not DC. Answering 'dc' here would print 'DC charging' on a bike plugged into a wall socket, from the absence of evidence rather than any: the same inference this whole change exists to delete, pointing the other way",
  },
];

// ---------------------------------------------------------------------------------------
// 1. Real frames in, the answer the screen acts on out.
// ---------------------------------------------------------------------------------------

/** Every key the rule asked about, across every case, recorded as it asked. */
const consulted = new Set<string>();

for (const scenario of CASES) {
  const values = decodeCase(scenario);
  const ages = scenario.ages ?? {};
  const read = (key: string): number | null => {
    consulted.add(key);
    return values.get(key) ?? null;
  };
  // The two arms of public/lib/store.js's isStale() that are about the SIGNAL: one
  // that has never arrived is stale, and one that has is judged on the age of its last
  // reading.
  //
  // It has a third arm, deliberately not modelled here: every signal is stale while the
  // WebSocket is not live. That one is about the LINK, and these cases are decoded CAN
  // frames with no link in the picture at all — modelling it would only mean writing
  // `linkIsLive: true` at the top of every scenario. What the omission costs is that
  // this file says nothing about how the charge rule behaves during a dropout; that is
  // covered by scripts/check-connection.ts §8, which is also where the reason it
  // matters lives (the answer is right for the charge SCREEN and wrong for the
  // edge-triggered view rules, so those hold their edges instead of asking).
  const stale = (key: string, maxAgeMs: number): boolean => {
    consulted.add(key);
    return !values.has(key) || (ages[key] ?? 0) > maxAgeMs;
  };

  const actual = chargeMode(read, stale);
  if (actual !== scenario.expect) {
    failures.push(
      `${scenario.what}: chargeMode() said "${actual}", expected "${scenario.expect}" — ${scenario.because}`
    );
  }

  // The invariant behind every "dc" above, asserted separately from the expectations
  // so that agreeing with the table is not the only thing keeping it true. "DC" is a
  // claim about hardware and the rider reads it as one, so it may only be made with
  // the contactor bit set — never, as this screen once did, from the mere absence of
  // the AC charger. That the bit must also be RECENT is pinned by the two cases above
  // that vary only its age, rather than restated here as a copy of the constant.
  if (actual === "dc" && values.get("fast_dc_contactor") !== 1) {
    failures.push(`${scenario.what}: chargeMode() answered "dc" with no fast_dc_contactor under it`);
  }
  if (actual === scenario.expect) {
    console.log(`  ✓ ${scenario.what} → ${actual}`);
  }
}

// ---------------------------------------------------------------------------------------
// 2. Every signal the rule consults must still exist, or it fails open and silently.
// ---------------------------------------------------------------------------------------
//
// A key renamed in decode.ts or dropped from the registry does not break the rule
// loudly: read() simply returns null for ever, chargeMode() answers "none" for ever,
// and the charging screen goes back to being useless at a charger with nothing to say
// why. The same silent-nothing failure scripts/check-can-decoders.ts guards the RX
// filter against, one layer up.
//
// The set is collected from the rule itself rather than restated here, so a fifth
// signal joining it is covered the day it is added.

const defined = new Map(SIGNALS.map(signal => [signal.key, signal]));
for (const key of [...consulted].sort()) {
  const signal = defined.get(key);
  if (!signal) {
    failures.push(`chargeMode() reads "${key}", which is not defined in src/can/registry.ts`);
    continue;
  }
  if (signal.source !== "stream") {
    failures.push(
      `chargeMode() reads "${key}", which the registry sources from "${signal.source}" rather than the CAN stream`
    );
  }
}

// ---------------------------------------------------------------------------------------
// 3. The DC arm's evidence must stay a gated 1/0 flag.
// ---------------------------------------------------------------------------------------
//
// `fast_dc_contactor` lives in group `charge`, which is full of real measurements and
// must never become a BOOLEAN_GROUP — `mains_v` and `dc_a` are in it. So its 0…1 gate
// hangs on a single per-key line in bounds.js, and that line has been missing once
// already. Without it a decoder returning the masked byte instead of the bit hands
// this rule a 1 that was never a 1.

const contactor = defined.get("fast_dc_contactor");
const contactorBounds = contactor ? boundsFor("fast_dc_contactor", contactor.unit, contactor.group) : null;
if (!contactorBounds || contactorBounds[0] !== 0 || contactorBounds[1] !== 1) {
  failures.push(`public/lib/bounds.js does not gate fast_dc_contactor to 0…1 — got ${JSON.stringify(contactorBounds)}`);
}

console.log("");
if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ ${CASES.length} situations decode to the charge mode the screen should show — parked and riding are not a ` +
    `charge, an AC session is AC, a DC session is DC despite the BMS reporting Idle throughout and survives a late ` +
    `heartbeat, the same Idle at the end of an AC session is not mistaken for one, and no answer names DC without ` +
    `the contactor bit under it; all ${consulted.size} signals the rule consults are registered stream signals`
);

/** The dashboard's view of one moment: every signal the replayed frames would produce. */
function decodeCase(scenario: ChargeCase): Map<string, number> {
  const values = new Map<string, number>(Object.entries(scenario.otherSignals ?? {}));
  for (const frame of scenario.frames) {
    for (const decoded of decodeFrame(frame.id, parseFrame(frame.hex))) {
      values.set(decoded.key, decoded.value);
    }
  }
  return values;
}

function parseFrame(hex: string): Buffer {
  return Buffer.from(hex.split(/\s+/).map(byte => Number.parseInt(byte, 16)));
}
