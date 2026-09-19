import { uptime } from "os";
import { ageMs, freshValue, record } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import type { HoldGesture } from "../gestures/runner.ts";
import { COMMAND_TIMEOUT_MS } from "./collect.ts";
import { writeWifiDump } from "./dump.ts";
import { NMCLI, runCommand } from "./nmcli.ts";
import { WIFI_LINK_STATE, parseWifiList, parseWifiProfileNames, type WifiLinkState } from "./parse.ts";
import {
  HOLD_ACTION,
  REJOIN_OUTCOME,
  RECOVER_TRIGGER,
  decideHold,
  type RecoverTrigger,
  type RejoinOutcome,
} from "./ladder.ts";

// The half of the wifi recovery that touches the world: it takes a dump, refreshes the
// scan and asks NetworkManager to activate the hotspot profile. ./ladder.ts decides
// WHEN and HOW FAR; nothing here makes that choice. docs/wifi.md §4.
//
// ⚠️ ONE recovery, TWO triggers — the watchdog in ./status.ts and the handlebar hold
// below. They share the in-flight flag in this module, so a thumb landing inside a
// watchdog run cannot start a second ladder against the same radio.

/** The button, and how long it must be held. Both argued in docs/handlebar-gestures.md. */
export const WIFI_GESTURE_BUTTON = "btn_set_back";

/**
 * ⚠️ 5000 ms, against a button whose longest press in the capture archive is 300 ms over
 * 15 presses. The ride log is the second corpus and no longer agrees: as of its
 * 2026-09-19 18:15 import it holds 131 pairs with ONE at 29 664 ms.
 *
 * That press is not excluded by any threshold or gate — it was made at 0.0 km/h — and it
 * is not argued away. What carries the choice is the COST of a false fire: one dump, and
 * a rejoin only when the link is already down, which is the action we would want then
 * anyway. docs/handlebar-gestures.md §"The `0x400` buttons".
 */
export const WIFI_HOLD_MS = 5000;

/**
 * The gesture does nothing above this.
 *
 * ⚠️ ZERO, and deliberately NOT ../fan/gesture.ts's 15 km/h. That ceiling exists because
 * silencing a fan while creeping in a toll queue is useful; nothing about a wifi dump is.
 * Zero is supported rather than arbitrary — `speed_can_kmh` reads exactly 0 in 317 780 of
 * 317 780 frames of the 2026-08-08 AC session (docs/fan-control.md), so a parked bike
 * needs no noise allowance.
 */
export const WIFI_GESTURE_MAX_KMH = 0;

/** How stale a speed reading may be and still say the bike is stopped. */
export const WIFI_SPEED_MAX_AGE_MS = 500;

/**
 * Whether the bike is proven stopped.
 *
 * ⚠️ PURE and separate, because the polarity is the whole of it and a mutation inverting
 * the branch survived while it lived inside the impure hold. `null` is "we cannot say",
 * which is not permission to act on the radio — the same fail-closed shape as ../fan/fun.ts.
 */
export function gateAllowsGesture(speedKmh: number | null): boolean {
  if (speedKmh === null || !Number.isFinite(speedKmh)) {
    return false;
  }
  // ⚠️ A negative speed is not "slower than stopped", it is a bad reading — refused for
  // the same reason a stale one is. ../fan/gesture.ts's isBelowOffCeiling guards it too.
  return speedKmh >= 0 && speedKmh <= WIFI_GESTURE_MAX_KMH;
}

/**
 * What a completed recovery publishes. Pure, so "the counter always advances" is a
 * property a check can hold rather than a line it can only read.
 */
export function rejoinPublication(previousSeq: number, outcome: RejoinOutcome): [string, number][] {
  return [
    ["wifi_rejoin_seq", previousSeq + 1],
    ["wifi_rejoin_outcome", outcome],
  ];
}

/**
 * The three things a ladder actually does to the world, injectable so the ORDER and the
 * GUARDS are drivable without a radio.
 *
 * ⚠️ Added because four mutations survived otherwise — skipping the dump, disabling the
 * shared in-flight flag, and freezing the counter all left every assertion green. A
 * safety claim nothing can falsify is not a safety claim.
 */
export interface LadderEffects {
  dump: () => Promise<string | null>;
  scanShowsHotspot: () => Promise<boolean>;
  activate: () => Promise<{ ok: boolean; profile: string | null }>;
}

export interface RecoverContext {
  iface: string;
  hotspotSsid: string;
  dumpDirectory: string;
}

let running = false;
let armedAt: number | null = null;
let rejoinSeq = 0;

/**
 * Runs the recovery. Always resolves; never throws at its callers, which are a timer and
 * a gesture with nobody watching a terminal.
 *
 * ⚠️ The outcome reaches the rider through SIGNALS, not through this return value:
 * `wifi_rejoin_seq` and `wifi_rejoin_outcome` are what the phone raises a banner from and
 * what the ride log keeps. A recovery nobody can see afterwards is half a feature.
 */
export async function recoverWifi(
  context: RecoverContext,
  trigger: RecoverTrigger,
  effects: LadderEffects = realEffects(context)
): Promise<RejoinOutcome> {
  if (running) {
    console.log(`wifi-recover: ${trigger} ignored — a recovery is already running`);
    return REJOIN_OUTCOME.NONE;
  }
  running = true;
  try {
    return await runLadder(trigger, effects);
  } catch (error) {
    // runLadder does not throw by design. If it ever does, the flag must still clear or
    // nothing recovers for the rest of the boot.
    console.warn("wifi-recover: the ladder threw:", error);
    return REJOIN_OUTCOME.FAILED;
  } finally {
    running = false;
  }
}

/** Dump ALWAYS, then refresh the scan and activate. */
async function runLadder(trigger: RecoverTrigger, effects: LadderEffects): Promise<RejoinOutcome> {
  // ⚠️ Rung 0 is unconditional. A recovery that rejoins without recording what was wrong
  // leaves the next occurrence exactly as undiagnosable as this one was.
  const written = await effects.dump();
  console.log(
    written === null
      ? `wifi-recover: ${trigger} — the dump could not be written, see the warning above`
      : `wifi-recover: ${trigger} — wrote ${written}`
  );
  const seen = await effects.scanShowsHotspot();
  if (!seen) {
    // ⚠️ Attempted anyway. A hidden SSID, or one missed by a single scan, is not proof of
    // absence, and `ssid-not-found` never reaches the auth path that spends auth-retries.
    console.log(`wifi-recover: ${trigger} — the hotspot is not in the refreshed scan, trying anyway`);
  }
  const attempt = await effects.activate();
  const outcome = outcomeOf(attempt);
  console.log(`wifi-recover: ${trigger} — outcome ${outcome}`);
  lastOutcome = outcome;
  for (const [key, value] of rejoinPublication(rejoinSeq, outcome)) {
    record(key, value);
  }
  rejoinSeq += 1;
  return outcome;
}

/**
 * ⚠️ A FAILED ACTIVATION IS `FAILED`, whether or not the scan saw the hotspot. It was
 * `seen ? FAILED : NOT_IN_RANGE`, which sold a real auth-path failure — the kind that
 * spends the `connection.auth-retries` the backoff exists to protect — as "not in range".
 * NO_PROFILE is now the only non-attempt, and it says what it means.
 */
function outcomeOf(attempt: { ok: boolean; profile: string | null }): RejoinOutcome {
  if (attempt.profile === null) {
    return REJOIN_OUTCOME.NO_PROFILE;
  }
  return attempt.ok ? REJOIN_OUTCOME.REJOINED : REJOIN_OUTCOME.FAILED;
}

/**
 * The real commands, behind the seam.
 *
 * ⚠️ `--rescan yes` is the whole of "rescan and settle": nmcli sets the scan cutoff to now
 * and waits until NetworkManager's results are provably newer, bounded internally, so
 * there is no wait loop here and no timeout constant of ours to get wrong. It is also why
 * this must never run on the poll path, whose contract is 2 × WIFI_POLL_TIMEOUT_MS <
 * WIFI_POLL_MS.
 */
function realEffects(context: RecoverContext): LadderEffects {
  return {
    dump: () => writeWifiDump(context.dumpDirectory, context.iface, uptime()),
    scanShowsHotspot: async () => {
      const list = await runCommand(
        NMCLI,
        ["-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi", "list", "--rescan", "yes"],
        RESCAN_TIMEOUT_MS
      );
      if (list.exitCode !== 0) {
        console.warn(`wifi-recover: ${list.command} exited ${list.exitCode}: ${list.stderr.trim()}`);
        return false;
      }
      return parseWifiList(list.stdout, context.hotspotSsid).hotspotSeen;
    },
    activate: async () => {
      const profile = await hotspotProfileName(context.hotspotSsid);
      if (profile === null) {
        console.warn("wifi-recover: no saved profile carries the configured SSID — nothing to activate");
        return { ok: false, profile: null };
      }
      // ⚠️ BY NAME. NetworkManager's nmc_find_connection() matches uuid, id, path and
      // filename and has no SSID arm, so `connection up <ssid>` can only answer "unknown
      // connection" whenever the two differ — which they do on this Pi. docs/wifi.md §3.
      const up = await runCommand(NMCLI, ["connection", "up", profile], ACTIVATE_TIMEOUT_MS);
      if (up.exitCode !== 0) {
        console.warn(`wifi-recover: activating "${profile}" failed: ${up.stderr.trim() || up.stdout.trim()}`);
      }
      return { ok: up.exitCode === 0, profile };
    },
  };
}

/** ⚠️ Generous, because `--rescan yes` waits on real scan results. */
const RESCAN_TIMEOUT_MS = 25_000;
const ACTIVATE_TIMEOUT_MS = 30_000;

/** Which saved profile carries the configured SSID. */
async function hotspotProfileName(hotspotSsid: string): Promise<string | null> {
  const listing = await runCommand(NMCLI, ["-t", "-f", "NAME,TYPE", "connection", "show"], COMMAND_TIMEOUT_MS);
  if (listing.exitCode !== 0) {
    console.warn(`wifi-recover: ${listing.command} exited ${listing.exitCode}: ${listing.stderr.trim()}`);
    return null;
  }
  for (const name of parseWifiProfileNames(listing.stdout)) {
    const ssid = await runCommand(
      NMCLI,
      ["-g", "802-11-wireless.ssid", "connection", "show", name],
      COMMAND_TIMEOUT_MS
    );
    if (ssid.exitCode === 0 && ssid.stdout.trim() === hotspotSsid) {
      return name;
    }
  }
  return null;
}

/** Re-records both on every poll, so the group never reads part-dark. ./status.ts calls it. */
export function republishRejoin(): void {
  record("wifi_rejoin_seq", rejoinSeq);
  record("wifi_rejoin_outcome", lastOutcome);
}

let lastOutcome: RejoinOutcome = REJOIN_OUTCOME.NONE;

/** The handlebar hold. Same machinery as the fan and waypoint gestures. */
export function wifiHoldGesture(context: RecoverContext, deps: HoldDeps = realHoldDeps(context)): HoldGesture {
  return {
    button: WIFI_GESTURE_BUTTON,
    holdMs: WIFI_HOLD_MS,
    description: "dump the wifi state and rejoin",
    perform: async () => performWifiHold(deps),
  };
}

/**
 * What one hold reads and what it can do, injectable for the same reason
 * `LadderEffects` is: without it the three-way dispatch below is unreachable, and a
 * mutation collapsing the REFUSED arm — a gesture that acts at any speed — stayed green.
 */
export interface HoldDeps {
  speedKmh: () => number | null;
  speedAgeMs: () => number | null;
  linkState: () => WifiLinkState | null;
  dump: () => Promise<string | null>;
  recover: () => Promise<RejoinOutcome>;
}

function realHoldDeps(context: RecoverContext): HoldDeps {
  return {
    speedKmh: () => freshValue("speed_can_kmh", WIFI_SPEED_MAX_AGE_MS),
    speedAgeMs: () => ageMs("speed_can_kmh"),
    linkState: currentLinkState,
    dump: () => writeWifiDump(context.dumpDirectory, context.iface, uptime()),
    recover: () => recoverWifi(context, RECOVER_TRIGGER.GESTURE),
  };
}

/** What one hold does. Kept out of the factory so it is not a nested declaration. */
export async function performWifiHold(deps: HoldDeps): Promise<string> {
  const speed = deps.speedKmh();
  const decision = decideHold(speed, deps.linkState(), armedAt === null ? null : since(armedAt), gateAllowsGesture);
  if (decision.action === HOLD_ACTION.REFUSED) {
    // ⚠️ FAIL-CLOSED on a missing or stale reading: `null` is "we cannot say the bike is
    // stopped", which is not permission to act on the radio. Same shape as ../fan/fun.ts.
    return `refused — the bike is not proven stopped (speed ${speed ?? "unknown"}, age ${deps.speedAgeMs() ?? "never"} ms)`;
  }
  if (decision.action === HOLD_ACTION.DUMP_ONLY) {
    // ⚠️ The dump takes the SHARED flag too. It runs a dozen children against the same
    // radio a watchdog ladder may already be using, and "it only dumps" is not a reason
    // to let two of them overlap.
    if (running) {
      return "a recovery is already running, so this hold was ignored";
    }
    running = true;
    armedAt = decision.arm ? monotonicNow() : armedAt;
    let written: string | null = null;
    try {
      written = await deps.dump();
      lastOutcome = REJOIN_OUTCOME.DUMP_ONLY;
      for (const [key, value] of rejoinPublication(rejoinSeq, lastOutcome)) {
        record(key, value);
      }
      rejoinSeq += 1;
    } finally {
      running = false;
    }
    return written === null
      ? "the link is up, so it was left alone — but the dump could not be written"
      : `the link is up, so it was left alone; dumped to ${written}. Hold again within 60 s to force a rejoin.`;
  }
  armedAt = null;
  // ⚠️ NOT assigned to lastOutcome: an ignored trigger answers NONE, and writing that
  // over the real outcome of the run still in flight would make the signal disagree with
  // the counter beside it. runLadder owns lastOutcome; this only words a sentence.
  return describeOutcome(await deps.recover());
}

/**
 * The link state as the poller last recorded it.
 *
 * ⚠️ Read from the SIGNAL rather than by asking nmcli again: the poller refreshed it at
 * most 8 s ago, and a second `device show` here would add a fork to the thumb's latency
 * for a number we already have. A stale or absent reading answers null, which
 * decideGesture() treats as "not connected" — the fail-safe direction, since the worst it
 * costs is a rejoin attempt on a link that was already fine.
 */
function currentLinkState(): WifiLinkState | null {
  const value = freshValue("wifi_link_state", WIFI_STATE_MAX_AGE_MS);
  if (value === null) {
    return null;
  }
  return VALID_LINK_STATES.find(state => state === value) ?? null;
}

/** Three poll intervals: stale enough to be suspicious, fresh enough not to be flaky. */
const WIFI_STATE_MAX_AGE_MS = 30_000;

const VALID_LINK_STATES: readonly WifiLinkState[] = Object.values(WIFI_LINK_STATE);

function describeOutcome(outcome: RejoinOutcome): string {
  if (outcome === REJOIN_OUTCOME.REJOINED) {
    return "rejoined";
  }
  if (outcome === REJOIN_OUTCOME.NO_PROFILE) {
    return "no saved profile carries the configured SSID; the dump is on the Pi";
  }
  if (outcome === REJOIN_OUTCOME.NONE) {
    return "a recovery was already running, so this hold was ignored";
  }
  return "the rejoin did not take; the dump is on the Pi";
}
