import { FAN_MODE_CODE, startFanAutomatic } from "../src/fan/auto.ts";
import { MAX_DUTY_PERCENT, startFanControl } from "../src/fan/control.ts";
import { FAN_REASON } from "../src/fan/curve.ts";
import { latestValue } from "../src/can/signals.ts";
import { valueOf } from "../public/lib/store.js";
import {
  COLD_PACK_C,
  LOOP_OPTIONS,
  TICK_MS,
  WARM_PACK_C,
  batches,
  bus,
  busTimer,
  drainBanners,
  holdableBridge,
  recording,
  settle,
  settleKick,
} from "./fan-banner-harness.ts";

// What the phone is told when a MODE PUBLISH races a command that is already in flight.
//
//   node --experimental-strip-types scripts/check-fan-race.ts
//
// The sibling of ./check-fan-banner.ts, over the same harness, split out when that file passed
// the ~400-line line with both subjects in it. There the question is whether one action raises
// one banner naming the right duty; here it is what happens when a second action lands inside
// the first one's awaits — which is a different mechanism and a different set of fixes.
//
// ⚠️ THE PAIR IS THE PROPERTY. `fan_auto_mode` and `fan_target_pct` are published by two
// different files, the banner is worded from BOTH, and src/can/signals.ts flushes one batch per
// microtask — so two records separated by an `await` are two WebSocket patches, and a mode that
// arrives before its duty is read against the duty of the mode before it.
//
// §7 a bridge that never answers must not eat the mode (#203's documented trade)
// §8 a tap back to Auto inside an in-flight slider command (commandManual's guard)
// §9 a /fan?mode=manual tap inside an in-flight CURVE command (#206), both directions, and the
//    guard that switchMode's own await made necessary
//
// docs/fan-control.md §"The two fan signals must reach the phone duty-first" has the archive
// measurements behind all three.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

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

// --- 9. A /fan?mode=manual tap landing INSIDE a curve command ---------------------
//
// ⚠️ #206, and the half #203 explicitly left open: a tap inside a curve command was worded from
// the duty from before the tap. Both directions, which say opposite false things.
// docs/fan-control.md §"The two fan signals must reach the phone duty-first".
//
// ⚠️ The bridge is HELD rather than merely slow. A timing race that resolves the wrong way
// makes the ordering accidentally correct and the section green having exercised nothing —
// so the parked state is asserted as a premise before each tap, exactly the way §1b and §8
// assert theirs: the wire and the context DISAGREEING is what "parked mid-command" looks
// like from outside.

console.log("\n9. a /fan?mode=manual tap inside an in-flight curve command");

{
  const held = holdableBridge();
  const heldController = await startFanControl({ enabled: true, openPwm: async () => held.pwm });
  const heldLoop = startFanAutomatic(heldController, LOOP_OPTIONS);

  // --- 9a. inside a bring-up ---
  //
  // ⚠️ The phone's copy of the wire is BEHIND the signals here: §8 ends with `batches.splice(0)`,
  // which discards its batches rather than folding them, and record() notifies only on a MOVE —
  // so a publish of a value the signals already hold is silent and the store can never catch up
  // by repetition. §8 left the store at manual/45 while the signals were already at 0. So this
  // setup drives REAL transitions — the curve up to its warm duty and back down to a stop — and
  // folds them. Without it the fold sits on a stale `manual-running` key and every banner
  // assertion below reads [] for a reason that has nothing to do with what is being tested.
  // The mode needs its own real transition for the same reason the duty does: §8 left the
  // signals in automatic and the store in manual.
  await heldLoop.setMode("manual");
  await settle(TICK_MS);
  bus.packC = WARM_PACK_C;
  await settle(TICK_MS * 3);
  await heldLoop.setMode("automatic");
  // ⚠️ No settleKick(): the duty is published by beginKickStart() before the kick ends, and
  // commandDuty(0) clears the kick timer, so waiting it out here buys nothing but 1.6 s.
  bus.packC = COLD_PACK_C;
  await settle(TICK_MS * 3);
  await heldLoop.setMode("automatic");
  await settle(TICK_MS * 3);
  check("9a (setting up) the curve has the fan stopped", heldController.state().targetPercent === 0);
  drainBanners();
  check(
    `9a (setting up) the phone's copy of the wire has caught up with the signals ` +
      `(mode ${valueOf("fan_auto_mode")}, target ${valueOf("fan_target_pct")} %)`,
    valueOf("fan_auto_mode") === FAN_MODE_CODE.automatic && valueOf("fan_target_pct") === 0
  );

  // ⚠️ The warm reading has to REACH the signals before the command is forced. Set the pack and
  // command in the same tick and the curve reads the cold one, decides 0, and parks in the stop
  // path instead — which is a green premise assertion about the wrong command.
  bus.packC = WARM_PACK_C;
  await settle(TICK_MS * 3);
  const wireBeforeBringUp = valueOf("fan_target_pct");
  const parkedInBringUp = held.arm();
  // ⚠️ NOT awaited. With tickMs at 60 s the curve does not tick on its own, so the command has
  // to be forced — and forcing it against a parked bridge never returns, so awaiting it here
  // deadlocks the check on its own setup line.
  const bringUp = heldLoop.setMode("automatic");
  await parkedInBringUp;
  const curveDuty = heldController.state().targetPercent;
  check(
    `9a the curve's command is parked mid bring-up: the fan is being given ${curveDuty} % while the wire ` +
      `still says ${wireBeforeBringUp} % and the phase is ${heldController.state().phase}`,
    curveDuty > 0 &&
      curveDuty !== wireBeforeBringUp &&
      valueOf("fan_target_pct") === wireBeforeBringUp &&
      heldController.state().phase === "idle"
  );
  drainBanners();

  const tapInBringUp = heldLoop.setMode("manual");
  await settle(TICK_MS);
  held.release();
  await bringUp;
  await tapInBringUp;
  await settle(TICK_MS * 3);
  const bringUpBanners = drainBanners();
  check(
    `⚠️  9a ONE banner, naming the duty the fan is actually being given (${JSON.stringify(bringUpBanners)})`,
    bringUpBanners.length === 1 && bringUpBanners[0] === `Fan: manual ${curveDuty} %`
  );
  check(
    `9a …and the fan really is at ${curveDuty} %, so the banner and the bridge agree`,
    heldController.state().targetPercent === curveDuty
  );

  // --- 9b. inside a stop ---
  await heldLoop.setMode("automatic");
  await settleKick();
  const runningDuty = heldController.state().targetPercent;
  check(`9b (setting up) the curve is driving a settled fan at ${runningDuty} %`, runningDuty > 0);
  drainBanners();

  // ⚠️ The same trap §9a's setup names, in the other direction and seven lines later: setMode →
  // runTick → evaluate → sampleTemperature is one synchronous block, so a pack set in this tick
  // is not on the bus yet. Without the settle the forced evaluation reads the WARM pack, decides
  // the duty the fan is already at, and takes applyDuty() — which never touches the bridge. The
  // arm below then waits for the loop's own 60 s interval, which no line here mentions: 60.0 s of
  // a 72 s check, and a hang rather than a failure if that interval is ever lengthened.
  bus.packC = COLD_PACK_C;
  await settle(TICK_MS * 3);
  const parkedInStop = held.arm();
  const stopping = heldLoop.setMode("automatic");
  await parkedInStop;
  check(
    `9b the curve's stop is parked mid-command: the wire still says ${valueOf("fan_target_pct")} % while the ` +
      `fan is being stopped`,
    valueOf("fan_target_pct") === runningDuty
  );
  drainBanners();

  const tapInStop = heldLoop.setMode("manual");
  await settle(TICK_MS);
  held.release();
  await stopping;
  await tapInStop;
  await settle(TICK_MS * 3);
  const stopBanners = drainBanners();
  // ⚠️ The bare wording, asserted explicitly rather than assumed: fanAnnouncementText says
  // "Fan: off until 15 km/h" instead when `fan_off_state` is ARMED, and §2 leaves a gesture's
  // off state behind in a module-global signal.
  check(
    `⚠️  9b ONE banner, and it says the fan is off rather than naming the duty it was leaving ` +
      `(${JSON.stringify(stopBanners)})`,
    stopBanners.length === 1 && stopBanners[0] === "Fan: off"
  );
  check("9b …and the fan really is stopped", heldController.state().targetPercent === 0);

  // --- 9c. a tap back to Auto landing inside the manual tap's own wait ---
  //
  // ⚠️ The mirror of §8, for the guard the new await creates. publishMode() re-reads the mode
  // and is safe; publishDecision(null) stamps MANUAL/NONE unconditionally, so without its guard
  // a "back to Auto" landing inside settled() would leave the MANUAL reason under an AUTOMATIC
  // mode — "The slider is driving the fan." under Automatic until the next tick. §8 pins the
  // same pair for commandManual(); nothing pinned it here, which is why this section exists.
  await heldLoop.setMode("automatic");
  bus.packC = WARM_PACK_C;
  await settle(TICK_MS * 3);
  drainBanners();

  // Parks in the BRING-UP: the pack is warm here, and the cold one below is for the tap-back,
  // which reads it after the settle rather than in this synchronous block.
  const parkedAgain = held.arm();
  const curveWorking = heldLoop.setMode("automatic");
  await parkedAgain;
  bus.packC = COLD_PACK_C;
  const tapToManual = heldLoop.setMode("manual");
  await settle(TICK_MS);
  // Lands INSIDE the manual tap's settled() wait, which is the whole point.
  const tapBackToAuto = heldLoop.setMode("automatic");
  held.release();
  await curveWorking;
  await tapToManual;
  await tapBackToAuto;
  await settle(TICK_MS * 3);
  drainBanners();
  check(
    `⚠️  9c the tap back to Auto wins on the wire — no MANUAL reason under an AUTOMATIC mode ` +
      `(mode ${latestValue("fan_auto_mode")}, reason ${latestValue("fan_auto_reason")})`,
    latestValue("fan_auto_mode") === FAN_MODE_CODE.automatic && latestValue("fan_auto_reason") !== FAN_REASON.MANUAL
  );

  heldLoop.stop();
  await heldController.stop();
  batches.splice(0);
}

clearInterval(busTimer);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ a mode publish never reaches the phone ahead of the duty it has to be read against:");
  console.log("  a bridge that never answers leaves the loop's mode readable rather than taking the process");
  console.log("  with it, a tap back to Auto inside a slider command is not overwritten with the MANUAL");
  console.log("  reason by the command it interrupted, and a /fan?mode=manual tap inside a curve command");
  console.log("  raises ONE banner naming the duty the fan is actually being given — in a bring-up and in a");
  console.log("  stop, which say opposite false things without the wait");
}
