import { defineSignals, onChange, record } from "../src/can/signals.ts";
import { readFile } from "node:fs/promises";
import { noteChargeCommandSent } from "../src/charge/ack-watch.ts";
import { HEARTBEAT_MS } from "../src/ws.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { boundsFor } from "../public/lib/bounds.js";
import { latestValue } from "../src/can/signals.ts";
import { connection, serverTime, signalState } from "../public/lib/store.js";

// What wakes the charge tab, and how often — both halves of #207, on a laptop with no browser.
//
//   node --experimental-strip-types scripts/check-charge-write-polling.ts
//
// ⚠️ THE BUG. `views/charge-current.js` read `charge_cmd_ack` in a `van.derive` with no value
// guard. `ws.ts` heartbeats a FULL snapshot every 5 s and `store.js` assigns a freshly parsed
// object, so the signal's identity churned whether or not the number moved and the phone re-fetched
// /vcu-write at 0.2 Hz for a whole charge — a payload that re-read the parameter sweep and the
// entire audit journal, on the event loop serving the 10 Hz WebSocket and the CAN RX handler.
//
// ⚠️ AND THE TRAP UNDER THE OBVIOUS FIX. `record()` logs only on CHANGE, so two commands settling
// to the same verdict move `charge_cmd_ack` not at all — the automatic controller stepping
// 32 → 30 → 28 A settles `took` three times and writes once, with the rider nowhere near the phone.
// A guard on the verdict would freeze the first command's sentence on screen for the rest of the
// charge, which is worse than the poll. `charge_cmd_ack_seq` is the edge that cannot be missed, and
// §2 and §3 are red without it.
//
// The fetch is stubbed and COUNTED; the store and the views are the real ones.

const failures: string[] = [];
let fetches = 0;

// ⚠️ TWO CLOCKS, and they are not the same clock. `clock` below is the PI's wall clock, which is
// what store.js's staleness compares against; `phoneNow` is the phone's monotonic one, which is
// what paces the retry (public/lib/clock.js — this dashboard has a button that steps a wall
// clock). Stubbed rather than slept through, the way scripts/check-arming.ts hands the dwell a
// reading instead of waiting 400 ms.
let phoneNow = 0;
performance.now = () => phoneNow;

/** Every URL the page asked for, so §5b can say what it did and did not want. */
const requested: string[] = [];

globalThis.fetch = (async (input: string) => {
  fetches += 1;
  requested.push(String(input));
  return new Response(JSON.stringify({ status: { enabled: true, chargeAck: null }, result: null, message: null }));
}) as unknown as typeof fetch;

const { STATUS_RETRY_MS, writesEnabled } = await import("../public/lib/charge-write.js");
await import("../public/views/charge-current.js");

/** charge_manager_state = 0x23, a settled DC session. */
const DC_SESSION = 0x23;
/** 0x610 broadcasts at 10 Hz, so a heartbeat re-delivers a reading up to this old. */
const SIGNAL_PERIOD_MS = 100;

let clock = 0;

/** VanJS schedules derives on a microtask (van-1.6.1.js:8), and the fetch stub resolves on one. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** One WebSocket message: the store's clock moves, and the signals it carries are re-delivered. */
async function deliver(signals: Record<string, number>, advanceMs = SIGNAL_PERIOD_MS): Promise<void> {
  clock += advanceMs;
  phoneNow += advanceMs;
  for (const [key, value] of Object.entries(signals)) {
    signalState(key).val = { value, unit: "", group: "charge", ts: clock };
  }
  serverTime.val = clock;
  await flush();
}

/** A heartbeat: ws.ts re-sends EVERY signal at its current value, changed or not. */
async function heartbeat(signals: Record<string, number>): Promise<void> {
  await deliver(signals, HEARTBEAT_MS);
}

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
    return;
  }
  console.error(`  ✗ ${what}`);
  failures.push(what);
}

console.log("\n──── scripts/check-charge-write-polling.ts ─────────────────────────────────────");
console.log("     what wakes the charge tab: one fetch per settle, none per heartbeat, and a retry");

// ── §1 a live charge that settles nothing costs ONE fetch, not one per heartbeat ──────
connection.val = "live";
await deliver({ charge_manager_state: DC_SESSION });
const openingFetches = fetches;
check("a session opening fetches the status once", openingFetches === 1);

// A verdict that has already settled — it persists in liveState across sessions, which is the
// state the issue was measured in.
await deliver({ charge_cmd_ack: 1, charge_cmd_ack_seq: 7 });
fetches = 0;
for (let beat = 0; beat < 5; beat += 1) {
  await heartbeat({ charge_manager_state: DC_SESSION, charge_cmd_ack: 1, charge_cmd_ack_seq: 7 });
}
check("five heartbeats that change nothing cost NO fetches (they cost five before #207)", fetches === 0);

// ── §2 a settle whose verdict repeats still wakes the page ────────────────────────────
//
// ⚠️ RED without charge_cmd_ack_seq. This is the automatic controller's shape: same verdict code,
// so `charge_cmd_ack` never moves, and nothing else on the bus says a second command was judged.
fetches = 0;
await deliver({ charge_cmd_ack: 1, charge_cmd_ack_seq: 8 });
check("a second settle with the SAME verdict costs one fetch", fetches === 1);
await heartbeat({ charge_manager_state: DC_SESSION, charge_cmd_ack: 1, charge_cmd_ack_seq: 8 });
check("and the heartbeats after it cost none", fetches === 1);

// ── §3 a settle the page did not ask for — the automatic controller ───────────────────
//
// No POST from this page at all: src/vcu/write-runner.ts calls noteChargeCommandSent for every
// origin, so two thirds of the settles on this bike belong to commands the rider never sent.
fetches = 0;
await deliver({ charge_cmd_ack: 3, charge_cmd_ack_seq: 9 });
await deliver({ charge_cmd_ack: 3, charge_cmd_ack_seq: 10 });
check("two automatic settles cost two fetches, one each", fetches === 2);

// ── §4 the wrap, and a session that ends ──────────────────────────────────────────────
fetches = 0;
await deliver({ charge_cmd_ack_seq: 255 });
await deliver({ charge_cmd_ack_seq: 0 });
check("the 255 → 0 wrap is an edge like any other", fetches === 2);

fetches = 0;
// The cable comes out: charge_manager_state goes stale rather than changing value.
clock += 20_000;
phoneNow += 20_000;
serverTime.val = clock;
await flush();
check("a session that ends fetches nothing", fetches === 0);
check("and the write controls go away with it", writesEnabled() === false);

fetches = 0;
await deliver({ charge_manager_state: DC_SESSION });
// ⚠️ TWO, and this is the one duplicate the design accepts: the session edge asks for the gate,
// and the settle guard — forgotten when the session ended — sees the number on the bus for the
// first time and asks for its phrasing. Both are right on their own, they cannot be merged without
// coupling two files, and it is two requests per plug-in against twelve a minute before #207.
check("a new session costs two fetches: its own gate, and the settle it has just met", fetches === 2);
fetches = 0;
await deliver({ charge_cmd_ack_seq: 0 });
check("and no more while the same settle keeps being re-delivered", fetches === 0);

// ── §5 a status fetch that FAILS at session start is retried, and paced ───────────────
//
// ⚠️ Trap #2 on this derive's own failing path: `fetchChargeWriteStatus()` swallows its error, so
// before this the guard was already consumed and `writesOn` stayed false for the WHOLE charge —
// the write controls never appeared. It recovered only by accident, through the poll §1 removes.
clock += 20_000;
phoneNow += 20_000;
serverTime.val = clock;
await flush();
let failing = true;
globalThis.fetch = (async (input: string) => {
  fetches += 1;
  requested.push(String(input));
  if (failing) {
    throw new Error("preview: the Pi did not answer");
  }
  return new Response(JSON.stringify({ status: { enabled: true, chargeAck: null }, result: null, message: null }));
}) as unknown as typeof fetch;

fetches = 0;
const realWarn = console.warn;
console.warn = () => {};
await deliver({ charge_manager_state: DC_SESSION });
check("§5 the opening fetch is attempted", fetches === 2);
check("§5 and writing is off while it has not landed", writesEnabled() === false);

// ⚠️ Ten messages inside one retry window. The derive subscribes to serverTime deliberately, so it
// runs on every one of them — an unpaced retry would be ten requests to a Pi that is not answering.
for (let message = 0; message < 10; message += 1) {
  await deliver({ charge_manager_state: DC_SESSION });
}
check("§5 ten more messages inside the retry window cost no further attempt", fetches === 2);

failing = false;
await deliver({ charge_manager_state: DC_SESSION }, STATUS_RETRY_MS);
console.warn = realWarn;
check("§5 past the window it tries again", fetches === 3);
check("§5 and the controls come back for the same session", writesEnabled() === true);
// ⚠️ A LITERAL in charge-write.js, not `HEARTBEAT_MS` itself: a budget derived from the thing it is
// checked against is an assertion that can never fire. Mutation: lower the literal to 1000.
check(
  `§5 the retry window (${STATUS_RETRY_MS} ms) clears one heartbeat (${HEARTBEAT_MS} ms)`,
  STATUS_RETRY_MS >= HEARTBEAT_MS
);

// ── §5b the charge tab never asks for the 269 names ───────────────────────────────────
//
// ⚠️ It has no parameter picker, and this is the call armChargeCurrent() makes before every arm —
// the gesture #107 exists to shrink. Without `list=0` the listing rides along: 21 115 bytes
// against 6 722, on garage wifi, at the moment the rider is waiting for a button to go live.
check(
  "§5b every /vcu-write the charge tab asks for says list=0",
  requested.length > 0 && requested.every(url => url.includes("list=0"))
);

// ── §5c a settle whose fetch FAILS is retried on the next heartbeat ───────────────────
//
// Trap #2 again, on the settle guard rather than the session one: the guard is taken before a
// fetch that swallows its error, so without giving it back one dropped request costs the verdict
// this whole mechanism exists to phrase. Retried at heartbeat rate, not at message rate — this
// derive reads no serverTime, so it re-runs only when the signal object is reassigned.
failing = true;
fetches = 0;
console.warn = () => {};
await deliver({ charge_cmd_ack_seq: 42 });
check("§5c the settle is fetched", fetches === 1);
failing = false;
await heartbeat({ charge_manager_state: DC_SESSION, charge_cmd_ack_seq: 42 });
console.warn = realWarn;
check("§5c and the failure is retried on the next heartbeat, not abandoned", fetches === 2);
await heartbeat({ charge_manager_state: DC_SESSION, charge_cmd_ack_seq: 42 });
check("§5c then it goes quiet again", fetches === 2);

// ── §6 the invariants the assertions above rest on ────────────────────────────────────
//
// ⚠️ signalState() creates a state for ANY string (store.js), so every assertion above would stay
// green with the registry entry deleted and nothing on the bike ever recording the signal. This is
// what makes them assertions about the Pi rather than about a name this file made up.
check(
  "§6 charge_cmd_ack_seq is a registered signal, not a key this check invented",
  SIGNALS.some(signal => signal.key === "charge_cmd_ack_seq")
);

// ⚠️ Through onChange — what the WebSocket actually pushes — and never the module's own counter.
// A deadband on this key would swallow the edge and leave every page-side assertion above green;
// check-can-decoders.ts polices deadbands only for 0/1-bounded signals, so nothing else would say.
//
// ⚠️ defineSignals FIRST, and it is load-bearing rather than setup: `defs` is populated only by
// src/index.ts on the real Pi, so without this the whole registry reads as empty here, every
// signal falls through at deadband 0, and the assertion below cannot see the very mutation it
// exists for. It survived one, which is how this line came to be here.
defineSignals(SIGNALS);
const pushed: number[] = [];
const stopWatching = onChange(changed => {
  const seq = changed["charge_cmd_ack_seq"];
  if (seq !== undefined) {
    pushed.push(seq.value);
  }
});
// Three commands: each supersedes the one before it, so two verdicts settle — with identical
// conditions, so they settle to the SAME code and `charge_cmd_ack` moves at most once.
const acks: number[] = [];
const stopWatchingAck = onChange(changed => {
  const ack = changed["charge_cmd_ack"];
  if (ack !== undefined) {
    acks.push(ack.value);
  }
});
// ⚠️ Flushed BETWEEN commands. notifyChange coalesces a batch per microtask (signals.ts:87-94),
// so three settles in one synchronous block would arrive as one batch carrying the last value —
// which is the shape of the bus (settles are seconds apart), not a shape this check may invent.
record("fast_dc_target_a", 30);
noteChargeCommandSent("dc", 20);
await flush();
noteChargeCommandSent("dc", 20);
await flush();
noteChargeCommandSent("dc", 20);
await flush();
stopWatching();
stopWatchingAck();
check("§6 two settles push two sequence numbers", pushed.length === 2);
check("§6 and they differ, so each is an edge", pushed[0] !== pushed[1]);
check(
  "§6 while the identical verdict behind them was pushed at most once — the reason the seq exists",
  acks.length <= 1
);

// ⚠️ THE WRAP, asserted against the thing it protects rather than against two numbers. bounds.js
// gates every signal, and public/lib/store.js shows a value outside its range as a FAULT rather
// than a reading — so an unwrapped counter stops waking the page entirely past 256 settles, on a
// bike whose automatic controller settles one a minute. Two distinct numbers cannot see that.
const seqBounds = boundsFor("charge_cmd_ack_seq", "", "charge");
console.warn = () => {};
for (let command = 0; command < 300; command += 1) {
  noteChargeCommandSent("dc", 20);
}
console.warn = realWarn;
const afterMany = latestValue("charge_cmd_ack_seq");
check("§6 the counter has a bounds rule at all", seqBounds !== null);
check(
  `§6 and 299 settles leave it inside that rule (${afterMany} in ${JSON.stringify(seqBounds)})`,
  seqBounds !== null && afterMany !== null && afterMany >= seqBounds[0] && afterMany <= seqBounds[1]
);

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log(
  "\n✓ the charge tab fetches once per settled verdict and never per heartbeat, notices a settle it " +
    "did not command, survives the byte wrap, and retries a failed session-start status once per heartbeat"
);
