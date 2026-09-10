import { CHARGE_AUTO_REASON, MIN_COMMAND_A, type ChargeAutoReason } from "../src/charge/auto-curve.ts";
import { CHARGE_AUTO_REASON_TEXT, type ChargeAutoResponse } from "../src/http/charge-auto.ts";
import type { ChargeAutoMode } from "../src/charge/auto.ts";
import { SIGNALS } from "../src/can/registry.ts";
import type { LiveValue } from "../src/can/signals.ts";
import { HEARTBEAT_MS, type DashboardMessage } from "../src/ws.ts";

// Whether the charge tab's automatic-current tile still says what the Pi is doing WHILE it does it.
//
//   node --experimental-strip-types scripts/check-charge-auto-live.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ⚠️ THE BUG (#200, from the road on 2026-09-10). The tile re-read /charge-auto only when
// `charge_auto_reason` changed value. The v1 rule changed reason almost every tick, so that was
// enough; #193's rule sits in one reason for many ticks while the current moves 1-15 A per tick, so
// nothing refreshed and the sentence — "Commanding x A" included — froze until a page reload.
//
// ⚠️ NO BROWSER AND NO DOM. It drives the real public/views/charge-auto.js against the real
// public/lib/store.js, feeding real DashboardMessages through apply() so readings pass the real
// plausibility gate and get the fresh object identity every heartbeat actually has. Only `fetch` is
// stood in for, and it must be stood in for BEFORE the modules load — hence the dynamic imports.
// The tile's DOM is not rendered (van.tags needs a document); controllerSentence() is the text that
// binding puts on screen, so asserting it asserts what a rider reads.
//
// What it cannot show: that the Pi records what it claims to. src/charge/auto.ts's own records are
// scripts/check-charge-auto.ts's business, and the bus is nobody's without a bike.

const failures: string[] = [];

/** The controller as the stubbed Pi holds it, so a section can step it the way `runTick` does. */
const pi = {
  mode: "automatic" as ChargeAutoMode,
  reason: CHARGE_AUTO_REASON.NO_HISTORY as ChargeAutoReason,
  commandedAmps: null as number | null,
};

/** Whether GET /vcu-write reports writes on for this Pi, so a section can shut that gate. */
let writesAreOn = true;

/** Every path the page asked for, in order — so a section can assert what it did and did NOT fetch. */
const fetched: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input), "http://eva.local/").pathname;
  fetched.push(path);
  if (path === "/vcu-write") {
    return new Response(JSON.stringify({ status: { enabled: writesAreOn } }));
  }
  if (path === "/charge-auto") {
    // The body src/http/charge-auto.ts's respond() would build for this state. The sentence comes
    // from the Pi's own table rather than being written again here, which is the whole reason it
    // travels on the wire — see CHARGE_AUTO_REASON_TEXT's header.
    const body: ChargeAutoResponse = {
      state: { mode: pi.mode, reason: pi.reason, commandedAmps: pi.commandedAmps },
      reasonText: CHARGE_AUTO_REASON_TEXT[pi.reason] ?? "",
      floorAmps: MIN_COMMAND_A,
      message: null,
    };
    return new Response(JSON.stringify(body));
  }
  throw new Error(`the charge tab asked for ${path}, which this check does not stand in for`);
}) as typeof fetch;

const { apply, connection } = await import("../public/lib/store.js");
const { applyWriteStatus, fetchChargeWriteStatus } = await import("../public/lib/charge-write.js");
const { controllerSentence } = await import("../public/views/charge-auto.js");

/** charge_manager_state (0x610 b7): 0x23 a settled DC session, 0x02 AC, 0x00 nothing plugged in. */
const DC_SESSION = 0x23;
const AC_SESSION = 0x02;
const NO_SESSION = 0x00;

/** The bus as the page has been told it, so a heartbeat can re-send all of it the way ws.ts does. */
const bus: Record<string, number> = {};

/** The server clock the messages carry. Advanced explicitly, so every age in the run is deliberate. */
let serverClockMs = 1_000;

connection.val = "live";

// ── §1 ⚠️ THE BUG: the amps move, the reason stands still ──────────────────
//
// Driven as `runTick` really emits it. src/charge/auto.ts records the reason at :197, awaits the
// command at :203 and records the amps at :206 — different microtasks, and src/ws.ts:193 turns
// every batch into its own patch, so the browser gets TWO patches seconds apart and pays two
// fetches. The first reads `commandedAmps` while the command is still in flight and gets the old
// one; the second is what makes the tile right. Asserting a single combined patch would pin an
// ordering the bike never produces.
patch({ charge_manager_state: DC_SESSION });
await settle();
pi.reason = CHARGE_AUTO_REASON.CLOSING;
patch({ charge_auto_reason: CHARGE_AUTO_REASON.CLOSING });
await settle();
pi.commandedAmps = 70;
patch({ charge_auto_target_a: 70 });
await settle();
expect("§1a", `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.CLOSING]} Commanding 70 A.`);

// The step that froze the tile: one reason, a current that keeps moving.
pi.commandedAmps = 62;
patch({ charge_auto_target_a: 62 });
await settle();
expect(
  "§1b the controller eased the current 70 → 62 A without changing its reason, which is what #193's " +
    "rule does for many ticks at a time",
  `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.CLOSING]} Commanding 62 A.`
);

// ── §2 the reason alone still wakes it ─────────────────────────────────────
pi.reason = CHARGE_AUTO_REASON.SETTLED;
patch({ charge_auto_reason: CHARGE_AUTO_REASON.SETTLED });
await settle();
expect("§2", `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.SETTLED]} Commanding 62 A.`);

// ── §3 ⚠️ THE GUARD: a heartbeat still costs nothing ───────────────────────
//
// The property the value guard exists for, and the one this fix could plausibly break. ws.ts
// heartbeats a FULL SNAPSHOT every HEARTBEAT_MS and store.js assigns a freshly parsed object, so
// every signal's identity churns whether or not its number moved. Unguarded, the derive would be a
// 0.2 Hz poll of an HTTP endpoint on a phone strapped to a handlebar.
{
  const before = countOf("/charge-auto");
  for (let beat = 0; beat < 5; beat += 1) {
    heartbeat();
    await settle();
  }
  const beats = countOf("/charge-auto") - before;
  if (beats !== 0) {
    failures.push(
      `§3 five heartbeats repeating the same values cost ${beats} fetch(es) of /charge-auto — the guard is ` +
        `gone and the tile now polls the Pi at ${(1000 / HEARTBEAT_MS).toFixed(1)} Hz`
    );
  }
}

// ── §4 both gates hold: not a DC charge, and writes switched off ───────────
//
// ⚠️ TWO halves, because an AC session does not exercise the second: `sessionLive` stays true, so
// charge-write.js never drops the status and writesEnabled() stays on. The read-only phone — one
// that never enabled writes — is the `enabled: false` half, and it is the claim that keeps the
// charge tab a pure WebSocket consumer for everyone else.
{
  const before = countOf("/charge-auto");
  patch({ charge_manager_state: AC_SESSION });
  await settle();
  patch({ charge_auto_target_a: 48 });
  await settle();
  if (countOf("/charge-auto") !== before) {
    failures.push("§4 an AC session fetched /charge-auto — the controller is DC-only and the tile is hidden");
  }
  patch({ charge_manager_state: DC_SESSION });
  await settle();
  // Back on DC the tile is commandable again, and a tile that just became commandable must re-read
  // the Pi rather than render whatever it last heard.
  if (countOf("/charge-auto") === before) {
    failures.push("§4 returning to a DC charge did not re-read /charge-auto, so the tile shows pre-AC state");
  }

  const beforeWritesOff = countOf("/charge-auto");
  applyWriteStatus(null);
  patch({ charge_auto_target_a: 44 });
  await settle();
  if (countOf("/charge-auto") !== beforeWritesOff) {
    failures.push(
      "§4 a phone with writes switched off fetched /charge-auto — the tile is inert there, and the read-only " +
        "screen is supposed to stay a pure WebSocket consumer"
    );
  }
}

// ── §5 the number comes from the ENDPOINT, never from the signal ───────────
//
// ⚠️ The assertion the rejected alternative fails. Rendering the amps straight off
// `charge_auto_target_a` looks equivalent and is not: forgetSession() (src/charge/auto.ts:262)
// nulls the controller's own `commandedAmps` and records nothing, so the signal outlives the
// session that produced it and the tile would print a current this charge never commanded. The
// reason is moved here so the refresh fires either way — this section is about which number wins,
// not about what wakes the tile.
writesAreOn = true;
await fetchChargeWriteStatus();
await settle();
pi.reason = CHARGE_AUTO_REASON.NEAR_CEILING;
pi.commandedAmps = 55;
patch({ charge_auto_reason: CHARGE_AUTO_REASON.NEAR_CEILING, charge_auto_target_a: 40 });
await settle();
expect(
  "§5 the signal says 40 A and the Pi says it commanded 55 A",
  `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.NEAR_CEILING]} Commanding 55 A.`
);

// ── §6 ⚠️ A MOVE THAT LANDS WHILE THE GATE IS SHUT IS NOT LOST ─────────────
//
// The guard must not be consumed on a run that did not refresh. Consumed above the gate — which is
// what shipped — a reason that moves while writes are momentarily off advances `lastReason`, the
// refresh never fires, and the move is gone for good: the tile then sits on the previous sentence
// until the controller happens to decide something different, which at AUTO_TICK_MS = 60 s and a
// settled rule can be a very long time. The window is real: charge-write.js clears the status on
// the session edge and the reopening GET is an async HTTP round trip.
{
  applyWriteStatus(null);
  const before = countOf("/charge-auto");
  pi.reason = CHARGE_AUTO_REASON.HARD_CEILING;
  patch({ charge_auto_reason: CHARGE_AUTO_REASON.HARD_CEILING });
  await settle();
  if (countOf("/charge-auto") !== before) {
    failures.push("§6 the tile fetched /charge-auto with the write gate shut, which §4 says it must not");
  }
  await fetchChargeWriteStatus();
  await settle();
  heartbeat();
  await settle();
  expect(
    "§6 the reason moved to HARD_CEILING while the write gate was shut, and the gate then reopened",
    `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.HARD_CEILING]} Commanding 55 A.`
  );
}

// ── §7 ⚠️ THE SESSION BOUNDARY, WHERE NO SIGNAL MOVES AT ALL ───────────────
//
// forgetSession() (src/charge/auto.ts:262-267) nulls `commandedAmps` on the `charge_manager_state`
// edge and RECORDS NOTHING — and it does not reset `context.reason` either. So for up to one 60 s
// tick /charge-auto answers "commanding nothing" with the previous session's reason, while both
// signals still hold the previous session's values. Nothing patches, so no guard can notice: the
// tile keeps saying "Commanding 35 A" about a charge that has commanded nothing. What corrects it
// is onChargeSessionEnd() clearing `loaded` and the just-commandable wake-up on the next session.
{
  pi.reason = CHARGE_AUTO_REASON.AT_FLOOR;
  pi.commandedAmps = 35;
  patch({ charge_auto_reason: CHARGE_AUTO_REASON.AT_FLOOR, charge_auto_target_a: 35 });
  await settle();
  expect(
    "§7 (setting up) the tile is current before the cable comes out",
    `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.AT_FLOOR]} Commanding 35 A.`
  );

  // The cable out, and the Pi's forgetSession() with it: no record(), so no patch.
  patch({ charge_manager_state: NO_SESSION });
  await settle();
  pi.commandedAmps = null;

  // The cable back in, at the same charger, inside the same tick. Neither signal has moved.
  patch({ charge_manager_state: DC_SESSION });
  await settle();
  expect(
    "§7 a re-plug quick enough that no controller tick intervenes — neither signal moved, and the Pi is " +
      "commanding nothing",
    CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.AT_FLOOR]
  );
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-auto-live failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ the charge tab's controller sentence follows the Pi while it works: the commanded current moving with the ` +
    `reason unchanged updates it (the #200 freeze), the reason moving alone still does, five heartbeats repeating ` +
    `the same values cost nothing, neither an AC session nor a phone with writes off fetches anything, the amps ` +
    `shown are the endpoint's and not the signal's, a move that lands while the write gate is shut is not thrown ` +
    `away, and a re-plug inside one controller tick never leaves the last session's "Commanding x A" on screen`
);

/**
 * The tile's own text, against what the Pi's state says it should read.
 *
 * ⚠️ Failures go to `failures` rather than throwing, so one broken section still reports the rest —
 * the shape every check in this repo uses.
 */
function expect(label: string, wanted: string): void {
  const got = controllerSentence();
  if (got !== wanted) {
    failures.push(`${label}: the tile reads "${got}", the Pi's state says "${wanted}"`);
  }
}

/** How many times the page has fetched a path this run. */
function countOf(path: string): number {
  return fetched.filter(seen => seen === path).length;
}

/**
 * One WebSocket patch, exactly as src/ws.ts sends a change batch.
 *
 * The unit and group come from the registry rather than being written here, because
 * public/lib/bounds.js gates on all three and a hand-typed group is how a check ends up asserting
 * against a reading the real page would have rejected as a dead sensor.
 */
function patch(signals: Record<string, number>): void {
  serverClockMs += 100;
  apply(messageOf("patch", signals));
}

/** The 5 s full snapshot — every signal again, unchanged, with the fresh identity that churns. */
function heartbeat(): void {
  serverClockMs += HEARTBEAT_MS;
  apply(messageOf("snapshot", bus));
}

function messageOf(type: "patch" | "snapshot", signals: Record<string, number>): DashboardMessage {
  const readings: Record<string, LiveValue> = {};
  for (const [key, value] of Object.entries(signals)) {
    const definition = SIGNALS.find(signal => signal.key === key);
    if (!definition) {
      throw new Error(`${key} is not in src/can/registry.ts — the bike cannot broadcast it and neither may this`);
    }
    bus[key] = value;
    readings[key] = { value, unit: definition.unit, group: definition.group, ts: serverClockMs };
  }
  return { type, ts: serverClockMs, signals: readings };
}

/**
 * Lets the store's derive, the view's fetch and its `apply()` all run.
 *
 * A macrotask, because the chain is several microtask hops deep: VanJS flushes with
 * queueMicrotask, refresh() awaits the response and awaits its .json(), and only then assigns.
 */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
