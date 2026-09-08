import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { connection, serverTime, signalState } from "../public/lib/store.js";
import { HEARTBEAT_MS } from "../src/ws.ts";

// charge-write.js fetches /vcu-write on the session edge, and a relative URL is not a URL
// outside a browser. Stubbed BEFORE the module is imported (hence the dynamic import below) so
// the check exercises the staleness logic without printing a network failure that is not one.
globalThis.fetch = (async () => ({ json: async () => ({ status: { enabled: false } }) })) as unknown as typeof fetch;
const { CHARGE_SESSION_MAX_AGE_MS, liveChargeType } = await import("../public/lib/charge-write.js");

// Holds the charge tab's write controls against the one thing that made them flicker: a
// staleness window the same size as the WebSocket heartbeat. On a laptop, with no browser.
//
//   node --experimental-strip-types scripts/check-charge-write-visibility.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ⚠️ THE BUG. `charge_manager_state` holds 0x23 all session (8399 frames, zero changes, measured),
// and signals.ts patches only on CHANGE — so the browser's copy of its age is refreshed only by
// the 5 s heartbeat while serverTime advances ~10×/s. With the window also 5000 ms the age crossed
// it on any late timer and the whole tile unmounted. The Pi's own age is ~100 ms off a per-frame
// monotonic mark: same number, different clocks. Full argument, and why charge-mode.js already
// uses 12 s: public/lib/charge-write.js and issue #142 §2.
//
// Drives the REAL store.js staleness logic, as check-connection.ts drives the real link policy.

const failures: string[] = [];

/** 0x610 broadcasts at 10.0 Hz, so a snapshot carries a reading up to this old. Measured 2026-09-07. */
const SIGNAL_PERIOD_MS = 100;

/** How often the dashboard receives ANY message during a charge — ~10/s, measured over the session. */
const MESSAGE_PERIOD_MS = 100;

/**
 * Messages do not land on the heartbeat's grid, and modelling them as if they did is what makes
 * this check useless: aligned, the last sample before a snapshot is exactly AT the snapshot and
 * the age never reaches the window. An arbitrary offset, held fixed so the run is deterministic.
 */
const MESSAGE_PHASE_MS = 37;

/**
 * How late `setInterval` runs the heartbeat. It is a timer on a Pi Zero that is also serving a
 * WebSocket and, before every arm, a 219 KiB status payload (#107) — so lateness is routine, and
 * it is the other half of what pushes the age past a 5 s window.
 */
const HEARTBEAT_DRIFT_MS = 40;

/** charge_manager_state = 0x23, a settled DC session. */
const DC_SESSION = 0x23;

// ── §1 a steady DC session never reads as gone ─────────────────────────────
//
// The mechanism, not a mock of it: the reading's timestamp advances only on the heartbeat and
// lags it by up to one signal period, while serverTime advances on every message.
//
// ⚠️ SWEPT, not walked down one timeline. A single simulated timeline only visits the lag/drift
// pairs its own arithmetic happens to produce — an earlier draft of this check made them cancel
// and passed on the broken 5000 ms window, which is worse than having no check. The sweep asks
// the question directly: over every combination the mechanism admits, how old does the browser's
// copy get? Deterministic, so it fails identically every run.
connection.val = "live";
let nullReadings = 0;
let worstAgeMs = 0;
let worstCase = "";
for (let lag = 0; lag <= SIGNAL_PERIOD_MS; lag += 10) {
  for (let drift = 0; drift <= HEARTBEAT_DRIFT_MS; drift += 10) {
    // One heartbeat's worth of messages, ending just before the next snapshot lands.
    const snapshotAt = HEARTBEAT_MS + drift;
    const readingTs = snapshotAt - lag;
    for (
      let elapsed = snapshotAt + MESSAGE_PHASE_MS;
      elapsed < snapshotAt + HEARTBEAT_MS;
      elapsed += MESSAGE_PERIOD_MS
    ) {
      signalState("charge_manager_state").val = { value: DC_SESSION, unit: "", group: "charge", ts: readingTs };
      serverTime.val = elapsed;
      if (elapsed - readingTs > worstAgeMs) {
        worstAgeMs = elapsed - readingTs;
        worstCase = `heartbeat ${drift} ms late carrying a reading ${lag} ms old`;
      }
      if (liveChargeType() === null) {
        nullReadings += 1;
      }
    }
  }
}
if (nullReadings > 0) {
  failures.push(
    `§1 liveChargeType() read null ${nullReadings} time(s) over the sweep — worst age ${worstAgeMs} ms ` +
      `(${worstCase}) against a ${CHARGE_SESSION_MAX_AGE_MS} ms window. Every one of those is the whole ` +
      `set-current tile unmounting and remounting`
  );
}

// ── §2 the window must stay above the heartbeat ────────────────────────────
//
// §1 fails only for windows below the worst age it happens to reach. This is the invariant
// behind it, and it is the one that catches someone "restoring" the 5000 to match the Pi.
if (CHARGE_SESSION_MAX_AGE_MS <= HEARTBEAT_MS) {
  failures.push(
    `§2 CHARGE_SESSION_MAX_AGE_MS (${CHARGE_SESSION_MAX_AGE_MS} ms) is not above ws.ts HEARTBEAT_MS ` +
      `(${HEARTBEAT_MS} ms). A signal that never changes is refreshed only by the heartbeat, so any window ` +
      `at or below it is a race by construction`
  );
}
if (CHARGE_SESSION_MAX_AGE_MS < HEARTBEAT_MS * 2) {
  failures.push(
    `§2 CHARGE_SESSION_MAX_AGE_MS (${CHARGE_SESSION_MAX_AGE_MS} ms) leaves no room for a single missed ` +
      `heartbeat (${HEARTBEAT_MS} ms). charge-mode.js allows 12 s for exactly this reason`
  );
}

// ── §3 no render may reach serverTime through liveChargeType ───────────────
//
// The churn half of the same bug: VanJS `update()` replaces a binding's DOM node whether or not
// the content changed, so a binding that reads serverTime is rebuilt on every message. The views
// must read the `chargeType` STATE. Asserted by import, because the next person to add a
// `liveChargeType()` call to a caption would reintroduce it silently.
const viewsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "views");
for (const view of ["charge-current.js", "charge-stop.js"]) {
  const source = await readFile(join(viewsDirectory, view), "utf-8");
  if (source.includes("liveChargeType")) {
    failures.push(
      `§3 public/views/${view} references liveChargeType — renders must read the chargeType state, ` +
        `or the binding subscribes to serverTime and its DOM node is replaced on every message`
    );
  }
  if (/\bisStale\b/.test(source)) {
    failures.push(`§3 public/views/${view} calls isStale directly, which subscribes the binding to serverTime`);
  }
}

// ── §4 the tile's visibility does not ride on payload identity ─────────────
//
// `armWrite()` refetches /vcu-write before every arm. A visibility binding reading
// `writeStatus.val?.status?.enabled` re-ran on the new object even when the answer was unchanged,
// rebuilding the tile and its <input> mid-gesture. It must read the boolean instead.
const chargeCurrentSource = await readFile(join(viewsDirectory, "charge-current.js"), "utf-8");
if (chargeCurrentSource.includes("writeStatus.val?.status?.enabled")) {
  failures.push(
    "§4 charge-current.js gates visibility on writeStatus identity — use writesEnabled(), whose boolean " +
      "state makes an unchanged refresh a no-op"
  );
}

// ── §5 the pre-arm refresh still raises busy ───────────────────────────────
//
// ⚠️ Issue #107's warning, kept alive here: the refresh before arming exists to raise `busy`, and
// that is the double-tap guard on a control that changes the bike. A fix for the flicker that
// removed it would look like an improvement and would not be one.
for (const view of ["charge-current.js", "charge-stop.js"]) {
  const source = await readFile(join(viewsDirectory, view), "utf-8");
  const armBody = source.slice(source.indexOf("async function arm"));
  const refreshIndex = armBody.indexOf("fetchChargeWriteStatus");
  if (refreshIndex < 0 || !armBody.slice(0, refreshIndex).includes("busy.val = true")) {
    failures.push(`§5 public/views/${view}'s arm path no longer raises busy around the refresh (#107)`);
  }
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-write visibility failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ the charge tab's write controls stay mounted for every heartbeat-lateness and signal-age combination the ` +
    `mechanism admits — worst age ${worstAgeMs} ms (${worstCase}) against a ${CHARGE_SESSION_MAX_AGE_MS} ms ` +
    `window, which stays above one missed heartbeat; neither view reaches ` +
    `serverTime through liveChargeType or isStale; visibility does not ride on payload identity; and both arm ` +
    `paths still raise busy around the pre-arm refresh`
);
