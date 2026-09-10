import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, latestValue, onChange, record, type LiveValue } from "../src/can/signals.ts";
import { FAN_MODE_CODE, startFanAutomatic } from "../src/fan/auto.ts";
import { KICK_START_MS, MAX_DUTY_PERCENT, startFanControl } from "../src/fan/control.ts";
import { FAN_REASON } from "../src/fan/curve.ts";
import type { FanPwm } from "../src/fan/pwm.ts";
import { startFanCycleGesture } from "../src/fan/gesture-runner.ts";
import { apply, valueOf } from "../public/lib/store.js";
import { foldFanAnnouncement } from "../public/lib/announce.js";

// The banner the phone raises for the fan, driven through the REAL patch sequence the Pi
// would have broadcast.
//
//   node --experimental-strip-types scripts/check-fan-banner.ts
//
// ⚠️ WHAT THIS IS GUARDING is that the banner names the duty the fan was actually asked
// for. `fan_auto_mode` and `fan_target_pct` are published by two different files and the
// banner is worded from BOTH — so they are a pair, and src/can/signals.ts flushes one
// batch per microtask, which makes two records separated by an `await` two WebSocket
// patches. A mode published ahead of its duty reaches the phone beside the duty of the
// mode before it. That is #199, and it said "Fan: manual 68 %" over a fan at 100 %.
//
// The order this file pins is therefore not tidiness: it is the whole property.
// docs/fan-control.md §"The two fan signals must reach the phone duty-first".
//
// ⚠️ The sibling hole is NOT covered here: a /fan?mode=manual tap landing inside a curve
// command tears the same way and is issue #206, whose remedy is a change to the seam
// between auto.ts and control.ts rather than a re-ordering.
//
// ⚠️ It does NOT press a button. scripts/check-hold-gestures.ts owns the road from a
// 0x102 bit to a fired gesture; this drives the gesture's own action so that what is on
// screen is the banner and nothing else. The harness — a recording FanPwm through the
// `openPwm` seam, a real loop, a real cycle — is lifted from that file's §3.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

defineSignals(SIGNALS);

/** The bridge, stubbed. Nothing is read back from it: every assertion is on the wire. */
const recording: FanPwm = {
  channelPath: "/sys/class/pwm/pwmchipFAKE/pwm0",
  setDutyPercent: async () => {},
  setOutputEnabled: async () => {},
  setBridgeEnabled: async () => {},
};

/**
 * A pack temperature the curve answers with a RUNNING duty that is neither 0 nor the cap
 * — so "the banner named the duty from before the command" and "the banner named the
 * right one" cannot be the same string. 42 °C is 68 %, which is the number in the bug
 * report; scripts/check-fan-curve.ts §567 pins the mapping.
 */
const WARM_PACK_C = 42;
/** Below the curve's start, so the fan is stopped while the mode is still automatic. */
const COLD_PACK_C = 10;

const TICK_MS = 20;

/**
 * The loop every section stands up. The tick is long enough that the curve never
 * re-commands mid-assertion: every duty below is commanded by something this file did, so
 * the recorded batches carry no third party's noise.
 */
const LOOP_OPTIONS = { tickMs: 60_000, speedMaxAgeMs: 400, chargeSessionMaxAgeMs: 400 };

/**
 * The batches src/ws.ts would have turned into patches, in order.
 *
 * ⚠️ Subscribed through onChange() — the same list src/ws.ts subscribes to — rather than
 * sampled with latestValue(). Sampling is what cannot see this bug at all: both signals
 * are correct a few milliseconds later, and it is the ARRIVAL ORDER that lies.
 */
const batches: Record<string, LiveValue>[] = [];
onChange(changed => batches.push({ ...changed }));

let memory: { value: string | null; baselined: boolean } = { value: null, baselined: false };

/**
 * Replays every batch collected so far the way the phone consumes them, and answers with
 * the banners it raised.
 *
 * One `apply()` per batch, because that is the unit: public/lib/store.js applies a whole
 * message before VanJS re-runs the derive, so a patch is evaluated once with everything
 * in it and once with nothing that is not. Driving the real apply() rather than a local
 * map also puts public/lib/bounds.js's plausibility gate in the path — the same shape
 * scripts/check-pack-resistance.ts §7 uses.
 */
function drainBanners(): string[] {
  const raised: string[] = [];
  for (const signals of batches.splice(0)) {
    apply({ type: "patch", ts: Date.now(), signals });
    const folded = foldFanAnnouncement(memory, valueOf("fan_auto_mode"), valueOf("fan_target_pct"));
    memory = folded.state;
    if (folded.banner !== null) {
      raised.push(folded.banner);
    }
  }
  return raised;
}

/** Which batch first carried a key, or -1. The invariant in §6 is an order between two. */
function batchIndexOf(collected: Record<string, LiveValue>[], key: string): number {
  return collected.findIndex(signals => key in signals);
}

function settle(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Waits out a kick-start, so the fan is SETTLED at the curve's duty.
 *
 * ⚠️ It really does wait, for the reason scripts/check-fan-curve.ts gives: the kick has
 * to run its full length or it is not a kick, and src/fan/control.ts measures it with
 * since() rather than trusting the timer. It is here so that §1 and §1b are two different
 * situations — a hold against a settled duty and a hold against a kicking one — which is
 * what makes each of the two fixes fail for its own reason.
 */
function settleKick(): Promise<void> {
  return settle(KICK_START_MS + TICK_MS * 6);
}

// The bus, at its own pace and never stopped mid-test: `speed_can_kmh` has a 500 ms
// window (src/fan/gesture.ts STATIONARY_MAX_AGE_MS) and *off* is unreachable without a
// fresh one, so a single record() before a hold would lapse across the awaits.
const bus = { speedKmh: 0, packC: WARM_PACK_C };
const busTimer = setInterval(() => {
  record("speed_can_kmh", bus.speedKmh);
  record("batt_temp_hi", bus.packC);
}, TICK_MS);

const controller = await startFanControl({ enabled: true, openPwm: async () => recording });
const automatic = startFanAutomatic(controller, LOOP_OPTIONS);
const cycle = startFanCycleGesture(automatic, { revertBeatMs: 60_000 });

// --- 1. The reported failure: a hold off a warm pack -------------------------------

console.log("\n1. one hold, from automatic with the curve driving a SETTLED fan");

await settle(TICK_MS * 3);
await automatic.setMode("automatic");
await settleKick();
const curveDuty = controller.state().targetPercent;
drainBanners();
check("the curve's duty has settled — the kick is over", controller.state().phase === "running");
check(
  `the curve holds the fan at ${curveDuty} % off a ${WARM_PACK_C} °C pack — a duty that is neither 0 nor the cap`,
  curveDuty > 0 && curveDuty !== MAX_DUTY_PERCENT
);

await cycle.gesture.perform();
await settle(TICK_MS * 3);
const warmHold = drainBanners();
check(
  `⚠️  the banner names the duty the fan was ASKED for (${JSON.stringify(warmHold)})`,
  warmHold.length === 1 && warmHold[0] === `Fan: manual ${MAX_DUTY_PERCENT} %`
);
check(
  `…and the fan really is at ${MAX_DUTY_PERCENT} %, so the banner and the bridge agree`,
  controller.state().targetPercent === MAX_DUTY_PERCENT
);

// --- 1b. The same hold, with the fan still KICKING --------------------------------
//
// ⚠️ The half of #199 that the re-ordering alone does not fix, and the likeliest shape of
// the reported one: the curve had just started the fan, so it was inside its 1500 ms
// kick, and a duty commanded there took neither publishing branch in commandDuty(). The
// mode then arrived — correctly ordered, after the command — beside a `fan_target_pct`
// that had not moved since before the hold. Revert the publish in src/fan/control.ts's
// mid-kick branch and this alone goes red.

console.log("\n1b. …and the same hold while the fan is still kick-starting");

// §1 left the fan manual and running, so this hands it back to the curve without a kick:
// the fan has to be STOPPED first, which is what the cold pack below is for. The kick
// this section needs is the one the warm pack then starts.
bus.packC = COLD_PACK_C;
await settle(TICK_MS * 3);
await automatic.setMode("automatic");
await settle(TICK_MS * 3);
bus.packC = WARM_PACK_C;
await settle(TICK_MS * 3);
await automatic.setMode("automatic");
await settle(TICK_MS * 3);
drainBanners();
check(
  `the curve has just started the fan and is kicking it (target ${controller.state().targetPercent} %)`,
  controller.state().phase === "kick-start" && controller.state().targetPercent === curveDuty
);

await cycle.gesture.perform();
await settle(TICK_MS * 3);
const kickingHold = drainBanners();
check(
  `⚠️  the banner still names ${MAX_DUTY_PERCENT} %, not the duty the kick was heading for (${JSON.stringify(kickingHold)})`,
  kickingHold.length === 1 && kickingHold[0] === `Fan: manual ${MAX_DUTY_PERCENT} %`
);

// --- 2. …and the rest of the cycle ------------------------------------------------

console.log("\n2. the other two steps say what they did");

await cycle.gesture.perform();
await settle(TICK_MS * 3);
const offHold = drainBanners();
check(`⚠️  the *off* step says off (${JSON.stringify(offHold)})`, offHold.length === 1 && offHold[0] === "Fan: off");
check("…with a 0 on the wire behind it", valueOf("fan_target_pct") === 0);

await cycle.gesture.perform();
await settle(TICK_MS * 3);
const autoHold = drainBanners();
check(
  `the step back to the curve says automatic (${JSON.stringify(autoHold)})`,
  autoHold.length === 1 && autoHold[0] === "Fan: automatic"
);

// --- 3. The cold pack, where the tear raised TWO banners ---------------------------
//
// ⚠️ The nastier half of #199 and the one a percentage comparison misses: with the curve
// holding the fan stopped, the torn patch put the key at `manual-stopped`, so the phone
// said "Fan: off" over a fan going to full — and then raised a second banner when the
// duty caught up. One hold must be one banner.

console.log("\n3. a hold off a COLD pack, where the fan was stopped");

bus.packC = COLD_PACK_C;
await settle(TICK_MS * 3);
await automatic.setMode("automatic");
await settle(TICK_MS * 3);
drainBanners();
check("the curve has the fan stopped in automatic", controller.state().targetPercent === 0);

await cycle.gesture.perform();
await settle(TICK_MS * 3);
const coldHold = drainBanners();
check(
  `⚠️  ONE banner, and it is not "Fan: off" (${JSON.stringify(coldHold)})`,
  coldHold.length === 1 && coldHold[0] === `Fan: manual ${MAX_DUTY_PERCENT} %`
);

// --- 4. The slider reaches the same code, and the same bug reached it --------------
//
// Every one of the twelve torn switches measured in the archive is this path, not the
// gesture: src/http/fan.ts posts a duty, which is commandManualDuty(), which is the
// commandManual() the gesture also calls.

console.log("\n4. the slider's first move out of automatic");

await automatic.setMode("automatic");
bus.packC = WARM_PACK_C;
await settle(TICK_MS * 4);
await automatic.setMode("automatic");
// ⚠️ Waited out, so this is the SETTLED case and not a second copy of §1b. Without it the
// command lands ~60 ms into the curve's kick, §4 goes red under BOTH mutations, and
// nothing anywhere exercises a slider move against a settled duty — which is the shape of
// all twelve flips measured in the archive.
await settleKick();
drainBanners();
const SLIDER_DUTY = 45;
check(
  `the curve is holding ${controller.state().targetPercent} % and has settled there`,
  controller.state().targetPercent !== SLIDER_DUTY && controller.state().phase === "running"
);
await automatic.commandManualDuty(SLIDER_DUTY);
await settle(TICK_MS * 3);
const sliderMove = drainBanners();
check(
  `⚠️  the banner names the thumb's duty, not the curve's (${JSON.stringify(sliderMove)})`,
  sliderMove.length === 1 && sliderMove[0] === `Fan: manual ${SLIDER_DUTY} %`
);

// --- 5. A duty commanded MID KICK-START still reaches the wire ---------------------
//
// ⚠️ src/fan/control.ts's commandDuty() publishes from beginKickStart() and applyDuty().
// A command landing while a kick is running takes neither branch: it moved targetPercent
// and published nothing, so `fan_target_pct` kept the previous value for the rest of
// KICK_START_MS — 1500 ms during which the tile and the banner both name a duty nobody
// asked for. Re-ordering §1 alone would NOT fix the banner in this window.

console.log("\n5. a command that lands mid kick-start");

const kicking = await startFanControl({ enabled: true, openPwm: async () => recording });
await kicking.setDutyPercent(68);
await settle(50);
check("the fan is kick-starting", kicking.state().phase === "kick-start");
batches.splice(0);
await kicking.setDutyPercent(MAX_DUTY_PERCENT);
await settle(TICK_MS);
const midKick = batches.map(signals => signals["fan_target_pct"]?.value).filter(value => value !== undefined);
check(
  `⚠️  the new target is published DURING the kick, not ${KICK_START_MS} ms later (${JSON.stringify(midKick)})`,
  midKick.includes(MAX_DUTY_PERCENT)
);
await kicking.stop();
batches.splice(0);

// --- 6. The invariant itself, on the recorded order -------------------------------
//
// The two assertions above are the symptom; this is the property. Stated as an order
// between batches rather than as a wording, so it holds for duties nobody has words for.

console.log("\n6. the duty never arrives after the mode that needs it");

const ordering = await startFanControl({ enabled: true, openPwm: async () => recording });
const orderingLoop = startFanAutomatic(ordering, LOOP_OPTIONS);
await settle(TICK_MS * 3);
batches.splice(0);
await orderingLoop.commandManualDuty(MAX_DUTY_PERCENT);
await settle(TICK_MS * 3);
const collected = [...batches];
const dutyAt = batchIndexOf(collected, "fan_target_pct");
const modeAt = batchIndexOf(collected, "fan_auto_mode");
check(
  `⚠️  the duty is in the mode's batch or an earlier one, never a later one ` +
    `(duty in batch ${dutyAt}, mode in batch ${modeAt})`,
  dutyAt >= 0 && modeAt >= 0 && dutyAt <= modeAt
);
orderingLoop.stop();
await ordering.stop();
batches.splice(0);

// --- 7. A bridge that never answers must not eat the mode -------------------------
//
// ⚠️ The trade §1 makes, written down as a check rather than as a claim. Publishing the
// mode after an awaited command means a write that HANGS — not one that throws, which
// the `finally` covers — leaves `fan_auto_mode` unpublished, where before it was
// published first. Accepted: a dashboard reading "automatic" over a wedged bridge is no
// more wrong than one reading "manual" over a wedged bridge, and neither is the fan. What
// must NOT happen is the process dying or the command resolving with a lie.

console.log("\n7. a bridge that never answers");

const wedged = await startFanControl({
  enabled: true,
  openPwm: async () => ({ ...recording, setDutyPercent: () => new Promise<void>(() => {}) }),
});
const wedgedLoop = startFanAutomatic(wedged, LOOP_OPTIONS);
await settle(TICK_MS * 3);
let wedgedSettled = false;
let wedgedThrew: unknown = null;
void wedgedLoop
  .commandManualDuty(MAX_DUTY_PERCENT)
  .then(() => {
    wedgedSettled = true;
  })
  // Not decoration: this promise is deliberately never awaited, so an escaped rejection
  // would end the process with a stack trace and no ✗ line — a red run that looks like a
  // crash rather than a failure.
  .catch(error => {
    wedgedThrew = error;
  });
await settle(TICK_MS * 6);
check("the command has not answered, because the bridge has not", !wedgedSettled);
check("…and it did not reject either — it is wedged, not failed", wedgedThrew === null);
check("…the loop still knows which mode it is in", wedgedLoop.mode() === "manual");
// ⚠️ `mode()` above is the premise, not the property: it reads a field assigned before the
// try and is true under every ordering. The WIRE is where the trade shows.
check(
  "⚠️  …while the WIRE still says automatic — the documented cost of publishing after the command",
  latestValue("fan_auto_mode") === FAN_MODE_CODE.automatic
);
wedgedLoop.stop();
batches.splice(0);

// --- 8. A tap back to Auto that lands INSIDE a slider command ---------------------
//
// ⚠️ The hazard the `finally` in commandManual() creates and its guard removes. Publishing
// after an awaited command means those writes land after anything that happened during the
// await — and `publishDecision(null)` stamps MANUAL/NONE unconditionally, where
// publishMode() re-reads the mode. A rider tapping Auto while a slider POST is in flight
// would otherwise be left in AUTOMATIC with the MANUAL reason on the wire until the next
// tick: public/views/fan.js prints "The slider is driving the fan." under Automatic, and
// over a TEMPERATURE_FAULT it clears the red line a dead sensor has just raised.

console.log("\n8. a tap back to Auto inside an in-flight slider command");

/** A bridge whose writes take time, the way sysfs writes and a spawned `pinctrl` do. */
const unhurried = await startFanControl({
  enabled: true,
  openPwm: async () => ({
    ...recording,
    setDutyPercent: () => new Promise<void>(resolve => setTimeout(resolve, TICK_MS)),
  }),
});
const racingLoop = startFanAutomatic(unhurried, LOOP_OPTIONS);
await settle(TICK_MS * 3);
await racingLoop.setMode("automatic");
// Settled, so the slider command below really does span its three awaited writes rather
// than returning through the mid-kick branch before the tap can land.
await settleKick();
check(
  `the curve is driving a settled fan (${unhurried.state().targetPercent} %, ${unhurried.state().phase})`,
  unhurried.state().phase === "running" && unhurried.state().targetPercent > 0
);

const sliderInFlight = racingLoop.commandManualDuty(45);
await settle(TICK_MS / 2);
await racingLoop.setMode("automatic");
await sliderInFlight;
await settle(TICK_MS * 3);
check(`⚠️  the tap wins: the loop is in automatic (${racingLoop.mode()})`, racingLoop.mode() === "automatic");
check(
  `⚠️  …and the wire agrees — no MANUAL reason under an AUTOMATIC mode ` +
    `(mode ${latestValue("fan_auto_mode")}, reason ${latestValue("fan_auto_reason")})`,
  latestValue("fan_auto_mode") === FAN_MODE_CODE.automatic && latestValue("fan_auto_reason") !== FAN_REASON.MANUAL
);
racingLoop.stop();
await unhurried.stop();
batches.splice(0);

clearInterval(busTimer);
cycle.stop();
automatic.stop();
await controller.stop();

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ every step of the fan cycle raises exactly ONE banner and it names the duty the fan was asked");
  console.log("  for: manual 100 % off a warm pack and off a cold one, off, automatic, and the slider's own");
  console.log("  first move. The duty reaches the wire in the mode's batch or an earlier one, a command landing");
  console.log("  mid kick-start is published rather than held for 1500 ms, a bridge that never answers leaves the");
  console.log("  loop's mode readable rather than taking the process with it, and a tap back to Auto inside a");
  console.log("  slider command is not overwritten with the MANUAL reason by the command it interrupted");
}
