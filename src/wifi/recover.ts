import { uptime } from "os";
import { ageMs, freshValue, record } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import type { HoldGesture } from "../gestures/runner.ts";
import { writeWifiDump } from "./dump.ts";
import { NMCLI, runCommand } from "./nmcli.ts";
import { WIFI_LINK_STATE, parseWifiList, parseWifiProfileNames, type WifiLinkState } from "./parse.ts";
import { REJOIN_OUTCOME, RECOVER_TRIGGER, decideGesture, type RecoverTrigger, type RejoinOutcome } from "./ladder.ts";

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

export interface RecoverContext {
  iface: string;
  hotspotSsid: string;
  dumpDirectory: string;
}

let running = false;
let armedAt: number | null = null;
let rejoinSeq = 0;

/** Whether a ladder is in flight, so ./status.ts does not start a second one. */
export function recoveryInFlight(): boolean {
  return running;
}

/**
 * Runs the recovery. Always resolves; never throws at its callers, which are a timer and
 * a gesture with nobody watching a terminal.
 *
 * ⚠️ The outcome reaches the rider through SIGNALS, not through this return value:
 * `wifi_rejoin_seq` and `wifi_rejoin_outcome` are what the phone raises a banner from and
 * what the ride log keeps. A recovery nobody can see afterwards is half a feature.
 */
export async function recoverWifi(context: RecoverContext, trigger: RecoverTrigger): Promise<RejoinOutcome> {
  if (running) {
    console.log(`wifi-recover: ${trigger} ignored — a recovery is already running`);
    return REJOIN_OUTCOME.NONE;
  }
  running = true;
  try {
    return await runLadder(context, trigger);
  } catch (error) {
    // runLadder does not throw by design. If it ever does, the flag must still clear or
    // nothing recovers for the rest of the boot.
    console.warn("wifi-recover: the ladder threw:", error);
    return REJOIN_OUTCOME.FAILED;
  } finally {
    running = false;
  }
}

/** Dump first, then — if asked — refresh the scan and activate. */
async function runLadder(context: RecoverContext, trigger: RecoverTrigger): Promise<RejoinOutcome> {
  const written = await writeWifiDump(context.dumpDirectory, context.iface, uptime());
  console.log(
    written === null
      ? `wifi-recover: ${trigger} — the dump could not be written, see the warning above`
      : `wifi-recover: ${trigger} — wrote ${written}`
  );
  const outcome = await rejoin(context, trigger);
  publish(outcome);
  return outcome;
}

/**
 * The radio half.
 *
 * ⚠️ `--rescan yes` is the whole of "rescan and settle". nmcli sets the scan cutoff to
 * now and waits until NetworkManager's results are provably newer, bounded internally, so
 * there is no hand-rolled wait loop here and no timeout constant of ours to get wrong.
 * It is also why this must never run on the poll path: that path's contract is
 * 2 × WIFI_POLL_TIMEOUT_MS < WIFI_POLL_MS, which a call this slow would break.
 */
async function rejoin(context: RecoverContext, trigger: RecoverTrigger): Promise<RejoinOutcome> {
  const list = await runCommand(
    NMCLI,
    ["-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi", "list", "--rescan", "yes"],
    RESCAN_TIMEOUT_MS
  );
  if (list.exitCode !== 0) {
    console.warn(`wifi-recover: ${list.command} exited ${list.exitCode}: ${list.stderr.trim()}`);
  }
  const seen = list.exitCode === 0 && parseWifiList(list.stdout, context.hotspotSsid).hotspotSeen;
  if (!seen) {
    // ⚠️ Attempted anyway. A hidden SSID, or one missed by a single scan, is not proof of
    // absence — and the attempt is cheap in the resource that matters, because
    // `ssid-not-found` never reaches the auth path that spends connection.auth-retries.
    console.log(`wifi-recover: ${trigger} — the hotspot is not in the refreshed scan, trying anyway`);
  }
  const profile = await hotspotProfileName(context.hotspotSsid);
  if (profile === null) {
    console.warn(`wifi-recover: no saved profile carries the configured SSID — nothing to activate`);
    return REJOIN_OUTCOME.NOT_IN_RANGE;
  }
  // ⚠️ BY NAME. NetworkManager's nmc_find_connection() matches uuid, id, path and
  // filename and has no SSID arm, so `connection up <ssid>` can only answer "unknown
  // connection" whenever the two differ — which they do on this Pi. docs/wifi.md §3.
  const up = await runCommand(NMCLI, ["connection", "up", profile], ACTIVATE_TIMEOUT_MS);
  if (up.exitCode === 0) {
    console.log(`wifi-recover: ${trigger} — activated "${profile}"`);
    return REJOIN_OUTCOME.REJOINED;
  }
  console.warn(`wifi-recover: ${trigger} — activating "${profile}" failed: ${up.stderr.trim() || up.stdout.trim()}`);
  return seen ? REJOIN_OUTCOME.FAILED : REJOIN_OUTCOME.NOT_IN_RANGE;
}

/** ⚠️ Generous, because `--rescan yes` waits on real scan results. */
const RESCAN_TIMEOUT_MS = 25_000;
const ACTIVATE_TIMEOUT_MS = 30_000;

/** Which saved profile carries the configured SSID. */
async function hotspotProfileName(hotspotSsid: string): Promise<string | null> {
  const listing = await runCommand(NMCLI, ["-t", "-f", "NAME,TYPE", "connection", "show"], 10_000);
  if (listing.exitCode !== 0) {
    console.warn(`wifi-recover: ${listing.command} exited ${listing.exitCode}: ${listing.stderr.trim()}`);
    return null;
  }
  for (const name of parseWifiProfileNames(listing.stdout)) {
    const ssid = await runCommand(NMCLI, ["-g", "802-11-wireless.ssid", "connection", "show", name], 10_000);
    if (ssid.exitCode === 0 && ssid.stdout.trim() === hotspotSsid) {
      return name;
    }
  }
  return null;
}

/**
 * Publishes what happened.
 *
 * ⚠️ A COUNTER beside the code, for the reason docs/can-decode-findings.md gives about
 * re-selecting a value you already had: `record()` seals a row only when the value moves,
 * so two identical outcomes in a row would write one row, raise one change and put up one
 * banner — and the second hold at the same charger would look like it had worked.
 */
function publish(outcome: RejoinOutcome): void {
  rejoinSeq += 1;
  record("wifi_rejoin_seq", rejoinSeq);
  record("wifi_rejoin_outcome", outcome);
}

/** Re-records both on every poll, so the group never reads part-dark. ./status.ts calls it. */
export function republishRejoin(): void {
  record("wifi_rejoin_seq", rejoinSeq);
  record("wifi_rejoin_outcome", lastOutcome);
}

let lastOutcome: RejoinOutcome = REJOIN_OUTCOME.NONE;

/** The handlebar hold. Same machinery as the fan and waypoint gestures. */
export function wifiHoldGesture(context: RecoverContext): HoldGesture {
  return {
    button: WIFI_GESTURE_BUTTON,
    holdMs: WIFI_HOLD_MS,
    description: "dump the wifi state and rejoin",
    perform: async () => performWifiHold(context),
  };
}

/** What one hold does. Kept out of the factory so it is not a nested declaration. */
async function performWifiHold(context: RecoverContext): Promise<string> {
  const speed = freshValue("speed_can_kmh", WIFI_SPEED_MAX_AGE_MS);
  if (speed === null || speed > WIFI_GESTURE_MAX_KMH) {
    // ⚠️ FAIL-CLOSED on a missing or stale reading: `null` is "we cannot say the bike is
    // stopped", which is not permission to act on the radio. Same shape as ../fan/fun.ts.
    const age = ageMs("speed_can_kmh");
    return `refused — the bike is not proven stopped (speed ${speed ?? "unknown"}, age ${age ?? "never"} ms)`;
  }
  const decision = decideGesture(currentLinkState(), armedAt === null ? null : since(armedAt));
  if (!decision.rejoin) {
    armedAt = decision.arm ? monotonicNow() : armedAt;
    const written = await writeWifiDump(context.dumpDirectory, context.iface, uptime());
    lastOutcome = REJOIN_OUTCOME.DUMP_ONLY;
    publish(lastOutcome);
    return written === null
      ? "the link is up, so it was left alone — but the dump could not be written"
      : `the link is up, so it was left alone; dumped to ${written}. Hold again within 60 s to force a rejoin.`;
  }
  armedAt = null;
  lastOutcome = await recoverWifi(context, RECOVER_TRIGGER.GESTURE);
  return describeOutcome(lastOutcome);
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

const VALID_LINK_STATES: readonly WifiLinkState[] = [
  WIFI_LINK_STATE.UNAVAILABLE,
  WIFI_LINK_STATE.DISCONNECTED,
  WIFI_LINK_STATE.CONNECTING,
  WIFI_LINK_STATE.CONNECTED,
];

function describeOutcome(outcome: RejoinOutcome): string {
  if (outcome === REJOIN_OUTCOME.REJOINED) {
    return "rejoined";
  }
  if (outcome === REJOIN_OUTCOME.NOT_IN_RANGE) {
    return "the hotspot was not in range; the dump is on the Pi";
  }
  if (outcome === REJOIN_OUTCOME.NONE) {
    return "a recovery was already running, so this hold was ignored";
  }
  return "the rejoin did not take; the dump is on the Pi";
}

/** Lets ./status.ts record the outcome of its own ladder run. */
export function noteOutcome(outcome: RejoinOutcome): void {
  lastOutcome = outcome;
}
