import { FAN_MODE_CODE, startFanAutomatic } from "../src/fan/auto.ts";
import { KICK_START_MS, MAX_DUTY_PERCENT, startFanControl } from "../src/fan/control.ts";
import { startFanCycleGesture } from "../src/fan/gesture-runner.ts";
import { FAN_OFF_CEILING_KMH } from "../src/fan/gesture.ts";
import { latestValue } from "../src/can/signals.ts";
import { valueOf } from "../public/lib/store.js";
import {
  COLD_PACK_C,
  LOOP_OPTIONS,
  TICK_MS,
  WARM_PACK_C,
  batchIndexOf,
  batches,
  bus,
  busTimer,
  drainBanners,
  recording,
  settle,
  settleKick,
} from "./fan-banner-harness.ts";

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
// ⚠️ The SIBLING SUBJECT lives next door. A mode publish racing a command already in flight —
// a tap back to Auto inside a slider command, a /fan?mode=manual inside a curve command — is
// ./check-fan-race.ts, over the same harness. It was split out when this file passed 400 lines
// with the two subjects in it.
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
check(
  `⚠️  the *off* step says off, and names the ceiling it holds to (${JSON.stringify(offHold)})`,
  offHold.length === 1 && offHold[0] === `Fan: off until ${FAN_OFF_CEILING_KMH} km/h`
);
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
