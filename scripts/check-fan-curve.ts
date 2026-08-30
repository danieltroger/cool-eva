import { boundsFor } from "../public/lib/bounds.js";
import {
  FAN_REASON_TEXT,
  FAN_TEMPERATURE_NOTE,
  TEMPERATURE_FAULT_REASON,
  describeAutoReason,
  dutyStopIndex,
  dutyStops,
} from "../public/lib/fan-display.js";
import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, latestValue, record } from "../src/can/signals.ts";
import type { FanCommandResult, FanController, FanState } from "../src/fan/control.ts";
import { KICK_START_MS, MIN_RUNNING_DUTY_PERCENT, startFanControl } from "../src/fan/control.ts";
import { monotonicNow, since } from "../src/monotonic.ts";
import type { FanPwm } from "../src/fan/pwm.ts";
import { AUTO_TICK_MS, CHARGE_SESSION_MAX_AGE_MS, SPEED_MAX_AGE_MS, startFanAutomatic } from "../src/fan/auto.ts";
import {
  CHARGE_MANAGER_STATE_DC,
  DC_CURVE_TOP_C,
  FAN_OFF_TEMPERATURE_C,
  FAN_ON_TEMPERATURE_C,
  FAN_REASON,
  FAN_TEMPERATURE_INPUT,
  PACK_TEMPERATURE_MAX_C,
  PACK_TEMPERATURE_MIN_C,
  RIDING_CURVE_TOP_C,
  ROAD_SPEED_MAX_KMH,
  SPEED_GATE_OFF_KMH,
  SPEED_GATE_ON_KMH,
  TEMPERATURE_GRACE_MS,
  fanCurveDecision,
  type FanCurveInputs,
} from "../src/fan/curve.ts";

// The automatic cooling-fan curve, checked with no bike, no Pi and no fan.
//
//   node --experimental-strip-types scripts/check-fan-curve.ts
//
// src/fan/curve.ts is pure for exactly this reason: a warm-up through 35 °C, a rider
// crossing 90 km/h and a temperature sensor dying are three things that cannot be staged
// in a garage, and all three are one function call here.
//
// ⚠️ THE FAILURE THIS GUARDS IS SILENT. This fan has no tacho and no current sense, so a
// curve that reads the wrong signal, gates the wrong way round or answers "off" to a dead
// sensor looks identical from the saddle to one that works — right up to the point the
// pack cooks. The three signal choices in §6 are each one character away from a
// near-miss that would be wrong only sometimes, which is the worst kind.
//
// The last section drives the real controller through a recording FanPwm, so it also
// covers the running-phase duty changes that issue #119 records check-fan-ordering.ts
// never reaches.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** A full set of inputs with nothing interesting in it, so each case names what it varies. */
function inputs(overrides: Partial<FanCurveInputs> = {}): FanCurveInputs {
  return {
    packTemperatureC: 20,
    temperatureAgeMs: 0,
    speedKmh: 0,
    chargeManagerState: null,
    previouslyRunning: false,
    ...overrides,
  };
}

function dutyAt(overrides: Partial<FanCurveInputs>): number {
  return fanCurveDecision(inputs(overrides)).dutyPercent;
}

function reasonAt(overrides: Partial<FanCurveInputs>): number {
  return fanCurveDecision(inputs(overrides)).reason;
}

// --- 1. The riding / parked / AC curve ---------------------------------------
//
// 35 → 48 °C mapped onto 30 → 100 %. The midpoint is asserted as a LITERAL 65 rather
// than recomputed from the constants: an assertion that recomputes the thing it is
// checking passes for every value of it, which is not a check.

console.log("\n1. the riding / parked / AC curve, 35 → 48 °C");

check("at the foot (35.1 °C) it is just off the 30 % floor", dutyAt({ packTemperatureC: 35.1 }) === 31);
check("halfway (41.5 °C) is halfway (65 %)", dutyAt({ packTemperatureC: 41.5 }) === 65);
check("40 °C is 57 %", dutyAt({ packTemperatureC: 40 }) === 57);
check(`at the top (${RIDING_CURVE_TOP_C} °C) it is 100 %`, dutyAt({ packTemperatureC: RIDING_CURVE_TOP_C }) === 100);
check("and past the top it stays 100 %, never more", dutyAt({ packTemperatureC: 70 }) === 100);
check("the reason names the pack temperature", reasonAt({ packTemperatureC: 41.5 }) === FAN_REASON.PACK_TEMPERATURE);
check(
  "a cold pack is off, and says why",
  dutyAt({ packTemperatureC: 20 }) === 0 && reasonAt({ packTemperatureC: 20 }) === FAN_REASON.BELOW_THRESHOLD
);

// --- 2. The DC curve, and the floor ------------------------------------------

console.log(`\n2. the DC curve, 35 → ${DC_CURVE_TOP_C} °C, and the floor a session always gets`);

const dc = { chargeManagerState: CHARGE_MANAGER_STATE_DC };

check("halfway (44.5 °C) is halfway (65 %)", dutyAt({ ...dc, packTemperatureC: 44.5 }) === 65);
check(`at the top (${DC_CURVE_TOP_C} °C) it is 100 %`, dutyAt({ ...dc, packTemperatureC: DC_CURVE_TOP_C }) === 100);
check("past the top it stays 100 %", dutyAt({ ...dc, packTemperatureC: 80 }) === 100);
check(
  "⚠️  48 °C is 78 % on DC and 100 % riding — the two curves are NOT the same line",
  dutyAt({ ...dc, packTemperatureC: 48 }) === 78 && dutyAt({ packTemperatureC: 48 }) === 100
);
check(
  `a cold pack on DC still gets the ${MIN_RUNNING_DUTY_PERCENT} % floor, not 0`,
  dutyAt({ ...dc, packTemperatureC: 5 }) === MIN_RUNNING_DUTY_PERCENT &&
    reasonAt({ ...dc, packTemperatureC: 5 }) === FAN_REASON.DC_FLOOR
);
check(
  "⚠️  and the floor ignores the speed gate, which a DC session cannot be moving through anyway",
  dutyAt({ ...dc, packTemperatureC: 5, speedKmh: 200 }) === MIN_RUNNING_DUTY_PERCENT
);
check(
  "the floor holds right up to the foot of the curve",
  dutyAt({ ...dc, packTemperatureC: FAN_ON_TEMPERATURE_C }) === MIN_RUNNING_DUTY_PERCENT
);

// --- 3. The speed gate, and its hysteresis -----------------------------------
//
// Both directions matter and they are not symmetric: a stopped fan needs to be under
// SPEED_GATE_ON_KMH to start, a running one only under SPEED_GATE_OFF_KMH to carry on.
// Collapsing the two is the mutation this section exists to catch.

console.log(`\n3. the speed gate — starts under ${SPEED_GATE_ON_KMH}, stops over ${SPEED_GATE_OFF_KMH} km/h`);

const hot = { packTemperatureC: 45 };

check("a hot pack at 50 km/h runs", dutyAt({ ...hot, speedKmh: 50 }) === 84);
// ⚠️ Literal 89 and 90, not SPEED_GATE_ON_KMH ± something. An assertion phrased in the
// constant it is checking passes for EVERY value of that constant — a gate moved to
// 70 km/h left this whole section green until these two lines were literals.
check("89 km/h is under the gate", dutyAt({ ...hot, speedKmh: 89 }) === 84);
check("90 km/h is not", dutyAt({ ...hot, speedKmh: 90 }) === 0);
check(
  `the same pack at ${SPEED_GATE_ON_KMH} km/h does not start, and says why`,
  dutyAt({ ...hot, speedKmh: SPEED_GATE_ON_KMH }) === 0 &&
    reasonAt({ ...hot, speedKmh: SPEED_GATE_ON_KMH }) === FAN_REASON.ROAD_SPEED
);
check("one tenth under the gate it does start", dutyAt({ ...hot, speedKmh: SPEED_GATE_ON_KMH - 0.1 }) === 84);
check(
  "⚠️  a RUNNING fan keeps running at 91 km/h — past the start gate, inside the hysteresis",
  dutyAt({ ...hot, speedKmh: 91, previouslyRunning: true }) === 84
);
check(
  "…and a stopped one at 91 km/h stays stopped, which is the same speed and the other answer",
  dutyAt({ ...hot, speedKmh: 91, previouslyRunning: false }) === 0
);
// ⚠️ Literal 92 and 93 for the same reason 89 and 90 above are literals. Written as
// `speedKmh: SPEED_GATE_OFF_KMH` this passed for EVERY value of the constant, because
// belowSpeedGate() compares with `<` against that same number — a stop gate moved to
// 110 km/h left the whole section green, and a fan still running 19 km/h past the gate
// the doc names went unnoticed. The constant is pinned separately, once.
check("the stop gate is the 93 km/h the doc says, so the band is 3 km/h", SPEED_GATE_OFF_KMH === 93);
check("a running fan is still running at 92 km/h", dutyAt({ ...hot, speedKmh: 92, previouslyRunning: true }) === 84);
check("…and finally stops at 93", dutyAt({ ...hot, speedKmh: 93, previouslyRunning: true }) === 0);
check("an ABSENT speed opens the gate rather than closing it", dutyAt({ ...hot, speedKmh: null }) === 84);
check(
  "⚠️  and so does an impossible one — the failure that would hold the fan off over a hot pack",
  dutyAt({ ...hot, speedKmh: 4000 }) === 84 && dutyAt({ ...hot, speedKmh: -5 }) === 84
);
// ⚠️ 4000 km/h is far past anything the bus can hand this, so the line above holds the
// ceiling nowhere near where it matters: `speed_can_kmh` is a 13-bit field ÷ 10, topping
// out at 819.1 km/h, and every value in (300, 819] left the whole file green. A ceiling
// anywhere in that band turns a garbage reading into a VALID road speed, closes the gate
// and holds the fan off over a hot pack — the dangerous direction the docstring on the
// constant names. So: the constant as a literal, and a probe at the top of the field.
check("the road-speed ceiling is the 300 km/h the doc says", ROAD_SPEED_MAX_KMH === 300);
check(
  "⚠️  819 km/h — the top of the 13-bit field — is read as NO speed, not as a road speed",
  dutyAt({ ...hot, speedKmh: 819 }) === 84
);

// --- 4. The temperature hysteresis -------------------------------------------

console.log(
  `\n4. the temperature hysteresis — on above ${FAN_ON_TEMPERATURE_C}, off at or under ${FAN_OFF_TEMPERATURE_C} °C`
);

check(
  `exactly ${FAN_ON_TEMPERATURE_C} °C does not start the fan`,
  dutyAt({ packTemperatureC: FAN_ON_TEMPERATURE_C }) === 0
);
check("a tenth above it does", dutyAt({ packTemperatureC: FAN_ON_TEMPERATURE_C + 0.1 }) === 31);
check(
  "⚠️  a RUNNING fan carries on at 34 °C — below the start threshold, inside the hysteresis",
  dutyAt({ packTemperatureC: 34, previouslyRunning: true }) === MIN_RUNNING_DUTY_PERCENT
);
check(
  "…and a stopped one at 34 °C stays stopped, which is the same pack and the other answer",
  dutyAt({ packTemperatureC: 34, previouslyRunning: false }) === 0
);
// ⚠️ Literals again, and the same defect this had: `packTemperatureC: FAN_OFF_TEMPERATURE
// _C` is true for every value of it, since warmEnough() compares with `>` against that
// same constant. A 15 °C hysteresis band instead of the documented 2 °C was green — and
// the 2 °C is what docs/fan-control.md argues stops a fan chattering on a whole-degree
// signal, so the band is the thing that has to be held, not just the mechanism.
check("the stop threshold is the 33 °C the doc says, so the band is 2 °C", FAN_OFF_TEMPERATURE_C === 33);
check(
  "a running fan is still running at 33.1 °C",
  dutyAt({ packTemperatureC: 33.1, previouslyRunning: true }) === MIN_RUNNING_DUTY_PERCENT
);
check("…and finally stops at 33", dutyAt({ packTemperatureC: 33, previouslyRunning: true }) === 0);

// --- 5. The three staleness tiers, and never-silently-off --------------------
//
// ⚠️ The whole point: a dead batt_temp_hi reads exactly like a cold pack, and "cold" is
// an answer this must never give on no evidence. Tier 3 is a floor plus a fault.

console.log(`\n5. a temperature that goes away — live, held for ${TEMPERATURE_GRACE_MS / 1000} s, then a fault`);

// ⚠️ The ages below are LITERALS. Written as `TEMPERATURE_GRACE_MS + 1` they moved with
// the constant, so a grace stretched to a week stayed green — the input and the thing
// under test were the same number. The constant is pinned separately, once.
check("the grace is the 60 s the doc says it is", TEMPERATURE_GRACE_MS === 60_000);

const warm = { packTemperatureC: 42 };
const live = fanCurveDecision(inputs(warm));
const held = fanCurveDecision(inputs({ ...warm, temperatureAgeMs: 30_000 }));
const lost = fanCurveDecision(inputs({ ...warm, temperatureAgeMs: 60_001 }));

check(
  "tier 1 — a fresh reading is used, and reported as live",
  live.dutyPercent === 68 && live.temperatureInput === FAN_TEMPERATURE_INPUT.LIVE
);
check(
  "tier 2 — 30 s stale gives the SAME duty, flagged as held rather than live",
  held.dutyPercent === 68 && held.temperatureInput === FAN_TEMPERATURE_INPUT.HELD
);
check(
  "the grace boundary itself is still held, not yet a fault",
  fanCurveDecision(inputs({ ...warm, temperatureAgeMs: 60_000 })).temperatureInput === FAN_TEMPERATURE_INPUT.HELD
);
check(
  `tier 3 — past the grace it runs at the ${MIN_RUNNING_DUTY_PERCENT} % floor and NOT at 0`,
  lost.dutyPercent === MIN_RUNNING_DUTY_PERCENT && lost.reason === FAN_REASON.TEMPERATURE_FAULT
);
check("tier 3 admits it has no temperature rather than reporting a stale one", lost.temperatureC === null);
check(
  "⚠️  a pack that WAS cold does not stay 'cold' once the sensor dies — the floor still wins",
  fanCurveDecision(inputs({ packTemperatureC: 5, temperatureAgeMs: 60_001 })).dutyPercent === MIN_RUNNING_DUTY_PERCENT
);
check(
  "…and the same on a DC session, where the fault outranks the floor's own reason",
  fanCurveDecision(inputs({ ...dc, packTemperatureC: 5, temperatureAgeMs: 60_001 })).reason ===
    FAN_REASON.TEMPERATURE_FAULT
);
check(
  "before the FIRST reading has ever arrived the fan waits, and says so",
  reasonAt({ packTemperatureC: null, temperatureAgeMs: 1000 }) === FAN_REASON.NO_READING_YET &&
    dutyAt({ packTemperatureC: null, temperatureAgeMs: 1000 }) === 0
);
check(
  "…except on DC, where the floor needs no temperature at all",
  dutyAt({ ...dc, packTemperatureC: null, temperatureAgeMs: 1000 }) === MIN_RUNNING_DUTY_PERCENT
);
check(
  "waiting for the first reading does not last forever — the grace turns it into the fault",
  reasonAt({ packTemperatureC: null, temperatureAgeMs: 60_001 }) === FAN_REASON.TEMPERATURE_FAULT
);

// --- 6. The signals, and the near-misses ------------------------------------
//
// Each of the three is one wrong choice away from a bug nothing on the bike would show.
// docs/fan-control.md §"What the curve reads" has the measurements behind each.

console.log("\n6. the three signals this rests on, and the wrong ones next to them");

// ⚠️ The literal first, for the reason 89 and 90 are literals in §3 — and this is the
// consequential one. Every DC assertion in this file spreads `dc`, which is built FROM
// this constant, so all of them stayed green for every value it could take. A wrong byte
// leaves `charging` false for a whole session: no DC curve AND no 30 % floor, which is
// the case docs/fan-control.md §"The automatic curve" says the fan is most for, on a fan
// with no tacho and with a green build. src/vcu/write-runner.ts keeps its own
// module-private copy of the same byte, so pinning both to the literal is what keeps them
// agreeing across two files that cannot see each other — the argument
// CHARGE_SESSION_MAX_AGE_MS is pinned twice under, in §10 below.
check("a DC session is 0x610 b7 = 0x23, the byte the capture archive measured", CHARGE_MANAGER_STATE_DC === 0x23);
check(
  `⚠️  charge_type's DC value (2) does NOT select the DC curve — only 0x${CHARGE_MANAGER_STATE_DC.toString(16)} does`,
  dutyAt({ chargeManagerState: 2, packTemperatureC: 5 }) === 0 && dutyAt({ ...dc, packTemperatureC: 5 }) === 30
);
check(
  "an AC session (0x02) takes the riding curve, which is what the owner chose",
  dutyAt({ chargeManagerState: 0x02, packTemperatureC: 48 }) === 100
);
check(
  "a charge state that is absent is not a DC session",
  dutyAt({ chargeManagerState: null, packTemperatureC: 5 }) === 0
);

const registered = new Set(SIGNALS.map(signal => signal.key));
for (const key of ["batt_temp_hi", "speed_can_kmh", "charge_manager_state"]) {
  // A rename would leave latestValue() answering null forever, which reads as a parked
  // bike with no temperature — i.e. the curve would fail quietly rather than loudly.
  check(`${key} is still a registered signal`, registered.has(key));
}
check(
  "⚠️  batt_temp_hi and batt_temp_hi_vcu are BOTH registered, so the near-miss is reachable and this is not vacuous",
  registered.has("batt_temp_hi_vcu") && registered.has("speed_kmh") && registered.has("charge_type")
);

// --- 7. The bounds check, server-side ---------------------------------------

console.log("\n7. the plausibility gate on batt_temp_hi, on the Pi rather than on the phone");

const dashboardBounds = boundsFor("batt_temp_hi", "°C", "battery");
check(
  `the server's copy is the dashboard's [${PACK_TEMPERATURE_MIN_C}, ${PACK_TEMPERATURE_MAX_C}]`,
  dashboardBounds !== null &&
    dashboardBounds[0] === PACK_TEMPERATURE_MIN_C &&
    dashboardBounds[1] === PACK_TEMPERATURE_MAX_C
);
for (const sentinel of [-242, -50, 120, 988, Number.NaN]) {
  const decision = fanCurveDecision(inputs({ packTemperatureC: sentinel }));
  check(
    `${sentinel} °C never steers the curve (reason ${decision.reason}, ${decision.dutyPercent} %)`,
    decision.reason !== FAN_REASON.PACK_TEMPERATURE && decision.reason !== FAN_REASON.DC_TEMPERATURE
  );
}
check(
  "…and a sentinel past the grace is the fault, not a 988 °C emergency",
  fanCurveDecision(inputs({ packTemperatureC: 988, temperatureAgeMs: 60_001 })).dutyPercent === MIN_RUNNING_DUTY_PERCENT
);

// --- 8. The enums reach the dashboard ---------------------------------------
//
// A code is the wire format; the words are the dashboard's. Both halves can be added to
// independently, which is exactly how a new reason ends up rendering as a bare integer
// or being rejected by bounds.js as a dead sensor.

console.log("\n8. every code has a bound and a sentence");

const reasonBounds = boundsFor("fan_auto_reason", "", "fan");
const inputBounds = boundsFor("fan_temp_input", "", "fan");
check("fan_auto_reason is bounded at all", reasonBounds !== null);
check("fan_temp_input is bounded at all", inputBounds !== null);

for (const [name, code] of Object.entries(FAN_REASON)) {
  check(
    `FAN_REASON.${name} = ${code} is inside its bound and has words`,
    reasonBounds !== null &&
      code >= reasonBounds[0] &&
      code <= reasonBounds[1] &&
      typeof FAN_REASON_TEXT[code] === "string" &&
      FAN_REASON_TEXT[code].length > 0
  );
}
// ⚠️ …and one code's MEANING, not just its bound. public/views/fan.js paints exactly one
// reason red and cannot import a .ts module, so it keeps its own copy of the number.
// Swapping TEMPERATURE_FAULT with BELOW_THRESHOLD left every assertion above true — both
// codes still in bounds, both still with a sentence — while the sheet raised the fan's
// fault banner for a merely cold pack and never for the dead sensor it exists for.
check(
  "the code the dashboard paints as a fault is still FAN_REASON.TEMPERATURE_FAULT",
  TEMPERATURE_FAULT_REASON === FAN_REASON.TEMPERATURE_FAULT
);
for (const [name, code] of Object.entries(FAN_TEMPERATURE_INPUT)) {
  check(
    `FAN_TEMPERATURE_INPUT.${name} = ${code} is inside its bound and has an entry`,
    inputBounds !== null &&
      code >= inputBounds[0] &&
      code <= inputBounds[1] &&
      typeof FAN_TEMPERATURE_NOTE[code] === "string"
  );
}
// The other direction: words for a code that no longer exists would go on being rendered
// for whatever value happened to land in the signal.
const reasonCodes = new Set<number>(Object.values(FAN_REASON));
check(
  "no sentence is left over from a reason that has been removed",
  Object.keys(FAN_REASON_TEXT).every(code => reasonCodes.has(Number(code)))
);
check(
  "the held-temperature note is actually appended to a reason's sentence",
  describeAutoReason(FAN_REASON.PACK_TEMPERATURE, FAN_TEMPERATURE_INPUT.HELD).length >
    describeAutoReason(FAN_REASON.PACK_TEMPERATURE, FAN_TEMPERATURE_INPUT.LIVE).length
);

// --- 9. The slider's stops — the dead zone ----------------------------------
//
// The phase-1 slider ran 0…100 in 5 % steps against a 30 % floor, so 5/10/15/20/25 all
// silently meant "stop": a quarter of the travel that lied about what it did.

console.log("\n9. the slider offers only duties the Pi will take");

const stops = dutyStops(MIN_RUNNING_DUTY_PERCENT, 100);
check(`the first stop is a stop (${stops[0]})`, stops[0] === 0);
check(`the last stop is the cap (${stops[stops.length - 1]})`, stops[stops.length - 1] === 100);
check(
  "⚠️  no stop lies between 0 and the floor — that band is the dead zone",
  stops.every(duty => duty === 0 || duty >= MIN_RUNNING_DUTY_PERCENT)
);
check(
  "the stops ascend and never repeat",
  stops.every((duty, index) => index === 0 || duty > stops[index - 1])
);
// ⚠️ 87.5 rather than 87: DUTY_STEP_PERCENT went from 5 to 1 with fun mode, so every
// whole percent is now ON the grid and a whole-number cap could no longer test the
// off-grid case this assertion exists for.
check("a lowered cap is still the last stop, whether or not it lands on the grid", dutyStops(30, 87.5).at(-1) === 87.5);
check(
  "…and nothing above it is offered",
  dutyStops(30, 87.5).every(duty => duty <= 87.5)
);
check("before the Pi has answered there is one stop and it is 0", dutyStops(0, 0).length === 1);
// Fractional for the same reason, and it is the duty fun mode actually produces: the
// throttle resolves 0.1 %, so the thumb has to land somewhere honest for 63.6 % too.
//
// ⚠️ 63.6 and not 63.4, which was this assertion's first repair and was half of one.
// `dutyStopIndex` is NEAREST, and the degenerate implementation of "nearest" is "the last
// stop at or below" — a floor. 63.4 rounds DOWN to 63, so a floor passed it; on the old
// 5 % grid the original `63 → 65` had been a round-UP case and a floor went red. 63.6
// rounds up to 64 where a floor gives 63, so both properties are pinned by one literal.
check("the thumb maps an off-grid duty to the nearest stop", dutyStops(30, 100)[dutyStopIndex(stops, 63.6)] === 64);
check("and 0 % maps to the stop position, not to the floor", stops[dutyStopIndex(stops, 0)] === 0);

// --- 10. End to end: curve → auto → control → the bridge ---------------------
//
// The same recording fake scripts/check-fan-ordering.ts uses, but driven by the curve
// rather than by a slider. This is the only place `applyDuty()` — the running-phase duty
// change — is reached at all; issue #119 records that the ordering check never gets there.

console.log("\n10. the loop, end to end, against a recording bridge");

defineSignals(SIGNALS);

interface PwmCall {
  method: "duty" | "output" | "bridge";
  value: number | boolean;
}

const calls: PwmCall[] = [];
const recording: FanPwm = {
  channelPath: "/sys/class/pwm/pwmchipFAKE/pwm0",
  setDutyPercent: async percent => {
    calls.push({ method: "duty", value: percent });
  },
  setOutputEnabled: async on => {
    calls.push({ method: "output", value: on });
  },
  setBridgeEnabled: async on => {
    calls.push({ method: "bridge", value: on });
  },
};

const TICK_MS = 20;
// The two staleness windows are turned right down for the same reason the tick is: what
// they guard is a bus that has stopped talking, and reproducing one at the real 3 s and
// 5 s would put eight seconds of sleep into every CI run.
const STALE_MS = 400;

// ⚠️ …which is exactly what makes the SHIPPED windows invisible below: everything from
// here on proves the MECHANISM at 400 ms and pins nothing about 3 s. So each one is
// pinned as a literal here, the way TEMPERATURE_GRACE_MS is in §5. The first is the
// failure src/fan/auto.ts sets in bold: with a one-hour window a `speed_can_kmh` of 120
// from ten minutes ago is still "fresh", the gate stays shut, and the fan is held off
// over a hot pack in a garage — on a bike with no tacho and with a green build.
check("speed goes stale after the 3 s the doc says, not whenever", SPEED_MAX_AGE_MS === 3_000);
// The docstring says this is deliberately the same 5 s as src/vcu/write-runner.ts, whose
// own copy is a module-private const. Pinning both to the literal is what keeps that
// sentence true across two files that cannot see each other.
check(
  "a DC session ends 5 s after 0x610 stops, the same 5 s the charge write uses",
  CHARGE_SESSION_MAX_AGE_MS === 5_000
);
check("and the curve is re-evaluated every 2 s", AUTO_TICK_MS === 2_000);
const controller = await startFanControl({ enabled: true, openPwm: async () => recording });
const automatic = startFanAutomatic(controller, {
  tickMs: TICK_MS,
  speedMaxAgeMs: STALE_MS,
  chargeSessionMaxAgeMs: STALE_MS,
});

/** Waits for `count` ticks to have run, with slack for the awaits inside each one. */
async function ticks(count: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, TICK_MS * count + 40));
}

/** Waits long enough for a signal nobody is re-recording to fall out of its window. */
async function goStale(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, STALE_MS + TICK_MS * 4));
}

record("batt_temp_hi", 42);
record("speed_can_kmh", 0);
await ticks(2);
check("a 42 °C pack starts the fan without anybody touching the slider", controller.state().targetPercent === 68);
check("through a kick-start, like every start from rest", controller.state().dutyPercent === 100);
check(
  "…which the dashboard can SEE, because the applied duty and the target are published apart",
  latestValue("fan_duty_pct") === 100 && latestValue("fan_target_pct") === 68
);
check(
  "and the curve says which rule it used, not just a number",
  latestValue("fan_auto_mode") === 1 &&
    latestValue("fan_auto_reason") === FAN_REASON.PACK_TEMPERATURE &&
    latestValue("fan_temp_input") === FAN_TEMPERATURE_INPUT.LIVE
);

// The kick has to run its full length or it is not a kick — so this really does wait.
await new Promise(resolve => setTimeout(resolve, KICK_START_MS + 250));
check("and it settles on the curve's duty when the kick ends", controller.state().dutyPercent === 68);

calls.length = 0;
await ticks(4);
check(
  `⚠️  a steady curve writes NOTHING for four ticks (${calls.length} calls) — every tick would be two pinctrl spawns`,
  calls.length === 0
);

record("batt_temp_hi", 45);
await ticks(2);
check(
  "a warmer pack moves the duty without a second kick-start",
  controller.state().dutyPercent === 84 && controller.state().phase === "running"
);

record("batt_temp_hi", 34);
await ticks(2);
check(
  "⚠️  a RUNNING fan at 34 °C stays on — the loop feeds the curve the FAN's state, which is the hysteresis",
  controller.state().driverEnabled && controller.state().targetPercent === MIN_RUNNING_DUTY_PERCENT
);

record("batt_temp_hi", 45);
await ticks(2);
record("batt_temp_hi", -242);
await ticks(2);
check(
  "⚠️  a −242 °C sentinel does not stop the fan — the last in-bounds reading still steers it",
  controller.state().dutyPercent === 84
);

record("speed_can_kmh", 120);
calls.length = 0;
await ticks(2);
check("crossing the speed gate stops the fan", !controller.state().driverEnabled);
check(
  "and the enables were dropped BEFORE the output, exactly as a manual stop would",
  calls.findIndex(call => call.method === "bridge" && call.value === false) >= 0 &&
    calls.findIndex(call => call.method === "bridge" && call.value === false) <
      calls.findIndex(call => call.method === "output" && call.value === false)
);

// ⚠️ Nothing re-records the speed now, so it goes stale — which must read as "the bike is
// parked", not as "still doing 120". Trusting the last value here is the failure that
// would hold the fan off over a hot pack in a garage, and it is invisible on the bike.
await goStale();
check(
  "⚠️  a speed that stops arriving is not the last speed — the fan comes back on",
  controller.state().driverEnabled && controller.state().targetPercent === 84
);

record("speed_can_kmh", 120);
record("charge_manager_state", CHARGE_MANAGER_STATE_DC);
record("batt_temp_hi", 10);
await ticks(2);
check(
  "a DC session starts it again at the floor, at 10 °C, at 120 km/h — the floor answers to none of them",
  controller.state().targetPercent === MIN_RUNNING_DUTY_PERCENT && controller.state().driverEnabled
);
check(
  "and the published reason says DC rather than leaving 30 % to be guessed at",
  latestValue("fan_auto_reason") === FAN_REASON.DC_FLOOR
);

// The session ending is a staleness event too: 0x610 simply stops when the cable comes
// out, and nothing ever writes a "not charging" value for the loop to notice.
await goStale();
check(
  "a session that stops broadcasting ends, and the 10 °C pack goes back to being cold",
  !controller.state().driverEnabled
);

record("batt_temp_hi", 45);
// Nothing re-records batt_temp_hi from here to the end of the manual session below, so
// this mark is when the loop's LAST GOOD READING arrived.
const hotReadingArrivedAt = monotonicNow();
await ticks(2);
check("a hot pack starts it again", controller.state().driverEnabled);

const manual = await automatic.commandManualDuty(0);
check(`the slider takes over and stops the fan (${manual.message})`, manual.ok && automatic.mode() === "manual");
check(
  "and the mode reaches the dashboard as a signal, with the reason cleared",
  latestValue("fan_auto_mode") === 0 && latestValue("fan_auto_reason") === FAN_REASON.MANUAL
);
calls.length = 0;
await ticks(4);
check("⚠️  and the curve leaves it alone afterwards — otherwise the drag would be undone in 2 s", calls.length === 0);

// ⚠️ The grace is measured from when the READING arrived — sampleTemperature() marks
// `now − age`, not `now`. With the mark set to `now`, every tick refreshes it while the
// same old value sits in the store, the age never grows, the grace never expires and the
// fail-safe §5 asserts can never fire on a bike. Ten ticks have run against one reading
// by now and the age has to have grown with them.
const heldAgeMs = automatic.state().temperatureAgeMs;
const sinceHotReading = since(hotReadingArrivedAt);
check(
  "⚠️  the grace clock runs from when the reading ARRIVED, not from the tick that read it",
  // The first half keeps the second from being vacuous: ten ticks have run against this
  // one reading, so a mark refreshed per tick would read one tick here rather than ten.
  // The 1 ms allowance is the reconstruction's own rounding — `now − age` is two clock
  // reads, so it lands a few microseconds after the arrival it is reconstructing.
  sinceHotReading > TICK_MS * 4 && heldAgeMs > sinceHotReading - 1
);

// ⚠️ Sampling sits ABOVE the mode check in runTick's evaluate(), so a reading that
// arrives during a MANUAL session is still remembered — which is what keeps /fan's
// temperatureAgeMs honest while the slider drives, and what makes a sensor that dies
// mid-session read as having died then rather than at the last automatic tick.
const manualReadingArrivedAt = monotonicNow();
record("batt_temp_hi", 46);
await ticks(3);
const manualAgeMs = automatic.state().temperatureAgeMs;
check(
  "⚠️  the loop keeps watching batt_temp_hi through a manual session",
  // Younger than the reading it held a moment ago, so it really did adopt this one, and
  // no older than this one is — which is what /fan reports while the slider is driving.
  automatic.mode() === "manual" && manualAgeMs < heldAgeMs && manualAgeMs < since(manualReadingArrivedAt) + 1
);

const back = await automatic.setMode("automatic");
check(`handing it back re-commands at once (${back.message})`, back.ok && controller.state().driverEnabled);

automatic.stop();
calls.length = 0;
record("batt_temp_hi", 60);
await ticks(4);
check("a stopped loop stops ticking, so a shutdown cannot be re-commanded into", calls.length === 0);
await controller.stop();

// --- 11. A tick that throws does not take the loop with it -------------------
//
// ⚠️ The interval discards each tick's promise, so a rejection inside one is unhandled:
// today Node ends the process — the CAN logging and the WebSocket with it, every 2 s —
// and with that default relaxed the fan simply holds its last duty in silence instead.
// Nothing on today's paths rejects, but that is a property of four other files rather
// than of this one, so the guard is driven with a controller that does.

console.log("\n11. a tick that throws is logged, and the next one still runs");

let commandAttempts = 0;
const brokenState: FanState = { dutyPercent: 0, targetPercent: 0, driverEnabled: false, phase: "idle" };
const breakingController: FanController = {
  configured: true,
  fault: null,
  setDutyPercent: async percent => {
    commandAttempts += 1;
    if (commandAttempts === 1) {
      throw new Error("pinctrl vanished mid-tick");
    }
    brokenState.targetPercent = percent;
    brokenState.dutyPercent = percent;
    brokenState.driverEnabled = percent > 0;
    brokenState.phase = percent > 0 ? "running" : "idle";
    return { ok: true, message: `commanded ${percent} %` };
  },
  state: () => brokenState,
  stop: async () => {},
};

// Listened for rather than left to Node: the default handler ENDS THE PROCESS, so an
// escaped rejection would read as "the check crashed" rather than as the named assertion
// below going red, and a red build should say which property broke.
let unhandled: unknown = null;
const noteUnhandled = (reason: unknown): void => {
  unhandled = reason;
};
process.on("unhandledRejection", noteUnhandled);

const breakingLoop = startFanAutomatic(breakingController, {
  tickMs: TICK_MS,
  speedMaxAgeMs: STALE_MS,
  chargeSessionMaxAgeMs: STALE_MS,
});
record("batt_temp_hi", 45);
await ticks(4);
breakingLoop.stop();
process.off("unhandledRejection", noteUnhandled);

check("a command that throws does not escape the tick as an unhandled rejection", unhandled === null);
check(`…and the loop is still ticking afterwards (${commandAttempts} attempts)`, commandAttempts >= 2);
check("so the fan reaches the duty the curve asked for, one tick late", brokenState.targetPercent === 84);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ both curves, the DC floor, both hysteresis pairs and all three staleness tiers hold, and a");
  console.log("  batt_temp_hi that dies runs the fan at the floor rather than reading as a cold pack");
}
