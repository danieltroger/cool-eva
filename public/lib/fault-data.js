// @ts-check
// Shared active/recent membership, counts and read-only fetches: docs/fault-report.md.
import van from "../vendor/van-1.6.1.js";
import { knownKeys, valueOf, isStale } from "./store.js";
import { monotonicNow } from "./clock.js";
import { historyOf, componentOf, symptomOf } from "./fault-history.js";
import { faultKey, isExpected, loadExpectedFaults } from "./expected-faults.js";
import { request } from "./transport.js";
import * as colors from "./colors.js";
import { readingHasFault } from "./reading-status.js";

export function loadFaultData() {
  void loadTable();
  void loadInfokeys();
  void refreshStoredCodes();
  void loadExpectedFaults();
}

/**
 * Codes quiet for longer than this drop off the screen. Chosen against the
 * observed cadence: P0A07's longest gap between firings was ~3.5 min, so a code
 * silent for 30 min is genuinely gone rather than mid-cycle.
 *
 * MUST stay below HISTORY_MS or it does nothing: Ring.since() already discards
 * anything older than the window it is given, so if the two are equal the ring is
 * silently enforcing the policy this constant claims to own — and lowering this one
 * to tighten the drop-off would have no effect at all.
 */
const RECENT_MS = 30 * 60_000;

/**
 * A fault list not refreshed within this long is treated as unknown, not as clear.
 *
 * liveState never drops a key and the server re-broadcasts the whole snapshot every
 * 5 s, so `dtc_list_count` stays readable forever once it has arrived — meaning a
 * dead BLE link to the hub is indistinguishable from a healthy bike with no faults
 * on value alone, and the screen would show a confident green "clear" next to a
 * header still reading "live". record() refreshes the timestamp on EVERY call, not
 * only on change (src/can/signals.ts), so staleness is the signal that separates
 * them. ~3 min is three missed rounds.
 */
const DIAGNOSTICS_SILENCE_MS = 3 * 60_000;

/**
 * How often the OBD-II lists are re-fetched while this tab is open. The server
 * re-reads them once a minute, so anything faster only costs bandwidth.
 *
 * The refresh is driven off the render tick rather than a setInterval on purpose:
 * views here are rebuilt on every switch INTO a tab and have no unmount hook, so an
 * interval started here would outlive the screen and keep polling from behind the
 * Ride view for the rest of the session.
 */
const STORED_REFRESH_MS = 30_000;

/** How many stored codes to show before hiding the rest behind a tap. */
export const STORED_PREVIEW_LIMIT = 6;

/** Loaded once from /dtc-table, so a code can be named rather than numbered. */
const table = van.state(/** @type {Record<string, DtcTableRow> | null} */ (null));
/** Set once the fetch has failed — the view then degrades to raw numbers and says so. */
export const tableError = van.state(/** @type {string | null} */ (null));

/** The OBD-II stored/pending/permanent lists, from /stored-dtcs. */
export const stored = van.state(/** @type {TroubleCodeSnapshot | null} */ (null));
/** Set when the fetch fails. Distinct from "the bike did not answer" — see storedSummary. */
export const storedError = van.state(/** @type {string | null} */ (null));
/** Whether the full stored list is expanded. Off by default; 39 rows is a lot of thumb. */
export const storedExpanded = van.state(false);

/**
 * Energica's per-fault telemetry shortlists, from /fault-infokeys. Null until the
 * fetch lands; a failure leaves it null and the lines simply stay un-expandable,
 * which is why there is no error state here — nothing on screen would be wrong,
 * there would just be less of it.
 */
export const infokeys = van.state(/** @type {FaultInfokeysPayload | null} */ (null));

/**
 * Which code's shortlist is open, as `"component/symptom"`, or null.
 *
 * One at a time. Thirty-nine codes each unfolding six field names would be a
 * screen you cannot navigate, and the question this answers — "what does Energica
 * say to measure for THIS code" — is asked about one code at a time anyway.
 */
export const openShortlist = van.state(/** @type {string | null} */ (null));

/** Monotonic mark of the last successful fetch, for the refresh above. */
let storedFetchedAt = /** @type {number | null} */ (null);

// Pulled from the server rather than re-declared. A hand-copied shape is the same
// drift this endpoint exists to prevent, one level up: renaming `obdCode` server-side
// would type-check clean here and show `undefined` on the card. Same rule as
// DashboardMessage in CLAUDE.md — typecheck covers public/ via checkJs.
/** @typedef {import("../../src/http/dtc-table.ts").DtcTableRow} DtcTableRow */
/** @typedef {import("../../src/http/dtc-table.ts").DtcTablePayload} DtcTablePayload */
/** @typedef {import("../../src/http/stored-dtcs.ts").TroubleCodeSnapshot} TroubleCodeSnapshot */
/** @typedef {import("../../src/http/stored-dtcs.ts").TroubleCodeListState} TroubleCodeListState */
/** @typedef {import("../../src/http/stored-dtcs.ts").TroubleCodeRow} TroubleCodeRow */
/** @typedef {import("../../src/http/fault-infokeys.ts").FaultInfokeysPayload} FaultInfokeysPayload */

/**
 * @typedef {{ key: string, codeKey: string, active: boolean, lastSeenMs: number | null,
 *   firings: number, row: DtcTableRow | null }} FaultRow
 */

export function headlineState() {
  const faults = collectFaults();
  const reported = valueOf("dtc_list_count");
  // The bike's complete count survives unknown/capped individual keys; silence never means clear.
  if (reported === null || readingHasFault("dtc_list_count") || isStale("dtc_list_count", DIAGNOSTICS_SILENCE_MS)) {
    return { kind: "unknown", count: 0 };
  }
  const active = Math.max(reported, faults.filter(fault => fault.active).length);
  if (active > 0) {
    return { kind: "active", count: active };
  }
  if (faults.length > 0) {
    return { kind: "recent", count: faults.length };
  }
  return { kind: "clear", count: 0 };
}

export function headlineColor() {
  switch (headlineState().kind) {
    case "active":
      return colors.BAD;
    case "recent":
      return colors.WARN;
    case "unknown":
      return colors.MUTED;
    default:
      return colors.GOOD;
  }
}

export function headlineValue() {
  const state = headlineState();
  switch (state.kind) {
    case "active":
    case "recent":
      return String(state.count);
    case "unknown":
      return "–";
    default:
      return "clear";
  }
}

export function headlineCaption() {
  const state = headlineState();
  switch (state.kind) {
    case "active": {
      // ⚠️ The hero NUMBER still counts every active fault. It is the one figure on this tab
      // meant to be read at a glance, and making it mean "active, minus the ones you ticked"
      // would change what it has always said. The split is a CAPTION concern, so it is
      // counted here rather than carried on a union member `headlineColor` and
      // `headlineValue` would both have had to ignore.
      const noun = state.count === 1 ? "fault active now" : "faults active now";
      const expected = collectFaults().filter(fault => fault.active && isExpected(fault.codeKey)).length;
      return expected === 0 ? noun : `${noun} · ${expected} of them expected`;
    }
    case "recent":
      return "not active now — but seen this session";
    case "unknown":
      return valueOf("dtc_list_count") == null
        ? "no fault list received yet"
        : "fault list has stopped arriving — this is not “no faults”";
    default:
      return "nothing in the bike's active list";
  }
}

/**
 * How old the bike's answer is: the server's own monotonic age at the moment it
 * served the snapshot, plus however long this phone has been holding it. Both
 * halves are needed — the first alone goes stale in the browser, and the second
 * alone would call a minute-old reading fresh because the fetch was recent.
 * @param {TroubleCodeSnapshot} snapshot
 */
export function describeSnapshotAge(snapshot) {
  if (snapshot.ageMs === null) {
    return "never";
  }
  const heldFor = storedFetchedAt === null ? 0 : monotonicNow() - storedFetchedAt;
  const seconds = Math.round((snapshot.ageMs + heldFor) / 1000);
  return seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

// Historical constraints and evidence: docs/fault-report.md.
export function collectFaults() {
  const now = monotonicNow();
  const codes = table.val;
  /** @type {FaultRow[]} */
  const faults = [];

  // `\d+`, not `\d{4}`: dtcSignalKey pads the component to a MINIMUM of four
  // digits, so a code no table row names keeps its raw low 16 bits and can be
  // five. Those are precisely the codes worth not filtering out.
  for (const key of knownKeys.val) {
    if (!/^dtc_\d+_\d+$/.test(key)) {
      continue;
    }
    const active = (valueOf(key) ?? 0) > 0;
    const { lastSeenMs, firings } = historyOf(key, now);
    // A key that exists but has never been non-zero is the backend saying "this
    // code is not set". That is not a fault and must not take up the screen.
    if (!active && lastSeenMs === null) {
      continue;
    }
    if (!active && lastSeenMs !== null && lastSeenMs > RECENT_MS) {
      continue;
    }
    // ⚠️ The `component/symptom` key is computed ONCE here rather than re-split out of the
    // signal key at each use. It was being rebuilt four times per card — twice inside the
    // sort comparator, i.e. per comparison — and `lib/expected-faults.js` calls itself "the
    // one place this key is spelled".
    faults.push({
      key,
      codeKey: faultKey(componentOf(key), symptomOf(key)),
      active,
      lastSeenMs,
      firings,
      row: codes ? (codes[key] ?? null) : null,
    });
  }

  // ⚠️ Expected sorts LAST, and only here — in the active list. A handful of cards fit on
  // the screen at once, so nothing falls off the end, and a code the owner has not marked
  // becomes the first card, which is the whole point of the list. The STORED list is not
  // re-ranked: it holds 41 codes behind a six-row preview (STORED_PREVIEW_LIMIT), so
  // sorting five expected codes last there would push all five out of the default view —
  // hiding them, which this feature must never do — and demoting them below ~36 unlisted
  // peers in a history that only grows would bury them without surfacing anything.
  return faults.sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    const leftExpected = isExpected(left.codeKey);
    const rightExpected = isExpected(right.codeKey);
    if (leftExpected !== rightExpected) {
      return leftExpected ? 1 : -1;
    }
    return (left.lastSeenMs ?? Infinity) - (right.lastSeenMs ?? Infinity);
  });
}

/**
 * Fetches the code table. Failure is not fatal — the view falls back to raw
 * component/symptom numbers and says so, because a fault you cannot name is still
 * a fault you need to know about.
 *
 * Re-entry is gated on a flag rather than on the error state, which matters twice.
 * FaultsView() runs on every switch INTO the tab, so gating on `table.val` alone
 * lets tab-flipping fire several requests while the first is still in the air. And
 * gating on `tableError` would make one failure permanent: a fetch that lost to the
 * phone not having joined the garage wifi yet would leave the screen showing "44/0"
 * for the rest of the session, with no reload or reconnect able to recover it.
 * Coming back to the tab retries.
 */
let fetchInFlight = false;
/** Same guard for /fault-infokeys, which is fetched once and never refreshed. */
let infokeysInFlight = false;

/**
 * Fetches /stored-dtcs when the local copy is older than STORED_REFRESH_MS, and
 * does nothing otherwise. Called from the render binding, so it stops the moment
 * the Faults tab is left.
 *
 * A failure keeps the last good snapshot on screen and only surfaces if there has
 * never been one: a stored-code list from a minute ago is still true, and blanking
 * it because the phone lost the hotspot for one poll would be a worse lie than
 * showing it with its age next to it.
 */
let storedFetchInFlight = false;

export async function refreshStoredCodes() {
  if (storedFetchInFlight) {
    return;
  }
  // The interval only applies once there is something to keep fresh. With no
  // snapshot the sole caller is FaultsView() on mount, and that has to be allowed to
  // retry every time you come back to the tab — the same reasoning as loadTable's
  // gate, and for the same failure: a fetch lost to the phone not having joined the
  // garage wifi yet must not be permanent.
  if (stored.val && storedFetchedAt !== null && monotonicNow() - storedFetchedAt < STORED_REFRESH_MS) {
    return;
  }
  storedFetchInFlight = true;
  try {
    const response = await request("/stored-dtcs");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    stored.val = /** @type {TroubleCodeSnapshot} */ (await response.json());
    storedFetchedAt = monotonicNow();
    storedError.val = null;
  } catch (error) {
    // Same reasoning as loadTable: `throw 'x'` and some engines' json() rejections
    // are not Errors, and asserting they are prints "(undefined)" on screen.
    storedError.val = error instanceof Error ? error.message : String(error);
    console.warn("faults: could not load /stored-dtcs —", error);
    // Backs off by pretending the fetch succeeded: without this, a server that is
    // down turns the 2 Hz render tick into a 2 Hz request loop.
    storedFetchedAt = monotonicNow();
  } finally {
    storedFetchInFlight = false;
  }
}

async function loadTable() {
  if (table.val || fetchInFlight) {
    return;
  }
  fetchInFlight = true;
  try {
    const response = await request("/dtc-table");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = /** @type {DtcTablePayload} */ (await response.json());
    table.val = payload.codes;
    tableError.val = null;
  } catch (error) {
    // Not a cast: `throw 'x'` and some engines' json() rejections are not Errors,
    // and asserting they are puts "Code names unavailable (undefined)" on screen.
    tableError.val = error instanceof Error ? error.message : String(error);
    console.warn("faults: could not load /dtc-table —", error);
  } finally {
    fetchInFlight = false;
  }
}

/**
 * Loads Energica's per-fault shortlists, once.
 *
 * No error state on screen, unlike /dtc-table: a code with no shortlist simply
 * does not open, and nothing already rendered becomes wrong. The failure still
 * gets a log line — a silent catch would hide a broken endpoint on a bike we
 * cannot attach a debugger to.
 */
async function loadInfokeys() {
  if (infokeys.val || infokeysInFlight) {
    return;
  }
  infokeysInFlight = true;
  try {
    const response = await request("/fault-infokeys");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    infokeys.val = /** @type {FaultInfokeysPayload} */ (await response.json());
  } catch (error) {
    console.warn("faults: could not load /fault-infokeys — code lines will not open:", error);
  } finally {
    infokeysInFlight = false;
  }
}
