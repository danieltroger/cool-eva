import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, onChange, record, type LiveValue } from "../src/can/signals.ts";
import { KICK_START_MS } from "../src/fan/control.ts";
import type { FanPwm } from "../src/fan/pwm.ts";
import { apply, peek, valueOf } from "../public/lib/store.js";
import { foldFanAnnouncement } from "../public/lib/announce.js";

// The fan-banner rig: a bridge, a bus, and the phone's own fold. Everything the checks built
// on it need in order to make a claim, and nothing that makes one.
//
// ⚠️ ITS OWN MODULE because scripts/check-fan-banner.ts passed the ~400-line split line and
// had grown a second subject: "the banner names the duty the fan was asked for" stayed there,
// and "a mode publish racing an in-flight command" became ./check-fan-race.ts. A check runs
// its assertions at module scope, so one cannot import from another and the shared parts have
// to live where neither owns them. ./charge-auto-live-harness.ts was lifted out the same way.
//
// ⚠️ The bus runs on import and is never stopped mid-test: `speed_can_kmh` has a 500 ms window
// (src/fan/gesture.ts STATIONARY_MAX_AGE_MS) and *off* is unreachable without a fresh one, so
// a single record() before a hold would lapse across the awaits. Each check clears `busTimer`
// when it is done with it.

defineSignals(SIGNALS);

/** The bridge, stubbed. Nothing is read back from it: every assertion is on the wire. */
export const recording: FanPwm = {
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
export const WARM_PACK_C = 42;
/** Below the curve's start, so the fan is stopped while the mode is still automatic. */
export const COLD_PACK_C = 10;

/** A bridge that can be HELD inside one `setBridgeEnabled`, so a command parks mid-flight. */
export interface HoldableBridge {
  pwm: FanPwm;
  /** Arms the NEXT call; the promise resolves once that call is parked. One-shot. */
  arm: () => Promise<void>;
  /** Lets the parked call return. */
  release: () => void;
}

/**
 * ⚠️ Held rather than slowed. §8's `unhurried` bridge delays every write by a fixed time, which
 * is enough to land a tap inside a command but not enough to be SURE one landed there — and a
 * race that resolves the wrong way leaves the ordering accidentally correct and the assertion
 * green having tested nothing. This parks a chosen call until the section says otherwise, so
 * "the command is in flight" is a fact of the run rather than a hope about the scheduler.
 *
 * `setBridgeEnabled` is the choke point on both paths under test: `beginKickStart` calls it
 * third, after the duty is already in `context.targetPercent` and before `publish()`, and
 * `goIdle` calls it FIRST, before `context.targetPercent` is zeroed.
 */
export function holdableBridge(): HoldableBridge {
  let armed = false;
  let announceParked: (() => void) | null = null;
  let letGo: (() => void) | null = null;
  return {
    pwm: {
      ...recording,
      setBridgeEnabled: async () => {
        if (!armed) {
          return;
        }
        armed = false;
        await new Promise<void>(resolve => {
          letGo = resolve;
          announceParked?.();
        });
      },
    },
    arm: () =>
      new Promise<void>(resolve => {
        armed = true;
        announceParked = resolve;
      }),
    release: () => {
      letGo?.();
      letGo = null;
    },
  };
}

export const TICK_MS = 20;

/**
 * The loop every section stands up. The tick is long enough that the curve never
 * re-commands mid-assertion: every duty below is commanded by something this file did, so
 * the recorded batches carry no third party's noise.
 */
export const LOOP_OPTIONS = { tickMs: 60_000, speedMaxAgeMs: 400, chargeSessionMaxAgeMs: 400 };

/**
 * The batches src/ws.ts would have turned into patches, in order.
 *
 * ⚠️ Subscribed through onChange() — the same list src/ws.ts subscribes to — rather than
 * sampled with latestValue(). Sampling is what cannot see this bug at all: both signals
 * are correct a few milliseconds later, and it is the ARRIVAL ORDER that lies.
 */
export const batches: Record<string, LiveValue>[] = [];
onChange(changed => batches.push({ ...changed }));

let memory: { value: string | null; baselined: boolean; offState?: number | null } = {
  value: null,
  baselined: false,
  offState: null,
};

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
export function drainBanners(): string[] {
  const raised: string[] = [];
  for (const signals of batches.splice(0)) {
    apply({ type: "patch", ts: Date.now(), signals });
    const folded = foldFanAnnouncement(
      memory,
      valueOf("fan_auto_mode"),
      valueOf("fan_target_pct"),
      peek("fan_off_state")
    );
    memory = folded.state;
    if (folded.banner !== null) {
      raised.push(folded.banner);
    }
  }
  return raised;
}

/** Which batch first carried a key, or -1. The invariant in §6 is an order between two. */
export function batchIndexOf(collected: Record<string, LiveValue>[], key: string): number {
  return collected.findIndex(signals => key in signals);
}

export function settle(ms: number): Promise<void> {
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
export function settleKick(): Promise<void> {
  return settle(KICK_START_MS + TICK_MS * 6);
}

// The bus, at its own pace and never stopped mid-test: `speed_can_kmh` has a 500 ms
// window (src/fan/gesture.ts STATIONARY_MAX_AGE_MS) and *off* is unreachable without a
// fresh one, so a single record() before a hold would lapse across the awaits.
export const bus = { speedKmh: 0, packC: WARM_PACK_C };
export const busTimer = setInterval(() => {
  record("speed_can_kmh", bus.speedKmh);
  record("batt_temp_hi", bus.packC);
}, TICK_MS);
