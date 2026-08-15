// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, isStale, knownKeys, valueOf } from "../lib/store.js";
import { monotonicNow } from "../lib/clock.js";
import { ringFor } from "../lib/ring.js";
import { Fact, SectionLabel } from "../lib/tiles.js";
import * as colors from "../lib/colors.js";

const { button, div, span } = van.tags;

// The faults screen.
//
// Built around one property of this bike's only observed code: it FLICKERS.
// P0A05 (water pump open circuit) was active on 2 of 8 consecutive polls across
// two boots on 2026-08-02, at constant temperature and standstill — see the
// *Trouble codes* section of obd-garage/CAN_MAP.md. A screen showing only what is
// active *right now* would have been blank six times out of eight while a real
// fault was being reported, which is the exact failure this view exists to avoid.
// So a code that has fired at any point since the page opened keeps its card,
// dimmed, with how long ago it last fired.
//
// The history behind "last seen" is the phone-side ring buffer, which starts
// empty on page load (lib/ring.js). That is a deliberate limit, not an oversight:
// the ride log is write-only by design and cannot be read back. The footnote says
// so, rather than letting the screen imply it knows more than it does.

/**
 * Codes quiet for longer than this drop off the screen. Chosen against the
 * observed cadence: P0A05's longest gap between firings was ~3.5 min, so a code
 * silent for 30 min is genuinely gone rather than mid-cycle.
 *
 * MUST stay below HISTORY_MS or it does nothing: Ring.since() already discards
 * anything older than the window it is given, so if the two are equal the ring is
 * silently enforcing the policy this constant claims to own — and lowering this one
 * to tighten the drop-off would have no effect at all.
 */
const RECENT_MS = 30 * 60_000;

/**
 * How far back "last seen" and the firing count may look. Deliberately longer than
 * RECENT_MS, per above.
 *
 * Not ring-limited: the "~30 minutes" figure on Ring's CAPACITY is the 2 Hz case
 * (pack current and friends). A dtc_* key lands once per diagnostics round — every
 * 6th BLE request at 10 s, so ~60 s — which puts 3600 samples at roughly 60 hours.
 * This constant is what bounds the reach, not the buffer.
 */
const HISTORY_MS = 6 * 60 * 60_000;

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
const STORED_PREVIEW_LIMIT = 6;

/** Loaded once from /dtc-table, so a code can be named rather than numbered. */
const table = van.state(/** @type {Record<string, DtcTableRow> | null} */ (null));
/** Set once the fetch has failed — the view then degrades to raw numbers and says so. */
const tableError = van.state(/** @type {string | null} */ (null));

/** The OBD-II stored/pending/permanent lists, from /stored-dtcs. */
const stored = van.state(/** @type {TroubleCodeSnapshot | null} */ (null));
/** Set when the fetch fails. Distinct from "the bike did not answer" — see storedSummary. */
const storedError = van.state(/** @type {string | null} */ (null));
/** Whether the full stored list is expanded. Off by default; 39 rows is a lot of thumb. */
const storedExpanded = van.state(false);
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

/**
 * @typedef {{ key: string, active: boolean, lastSeenMs: number | null,
 *   firings: number, row: DtcTableRow | null }} FaultRow
 */

export function FaultsView() {
  void loadTable();
  void refreshStoredCodes();
  return div(
    { class: "view" },
    Headline(),
    () => {
      const faults = collectFaults();
      if (faults.length === 0) {
        return div();
      }
      // .tile-group, not .view and not a bare div: .view would double the 0.5 rem
      // horizontal padding and inset this group relative to the hero and Counters
      // either side of it, while a bare div drops the cards out of any grid and
      // loses the gap between them entirely.
      return div({ class: "tile-group" }, SectionLabel("Codes"), ...faults.map(FaultCard));
    },
    SectionLabel("Counters"),
    Counters(),
    StoredCodes(),
    Footnote()
  );
}

/** The one-glance answer: is anything wrong right now, or was it recently. */
function Headline() {
  return div(
    { class: "hero" },
    div({ class: "label" }, "Faults"),
    div({ class: "hero-value", style: () => `color:${headlineColor()}` }, () => headlineValue()),
    div({ class: "sub" }, () => headlineCaption())
  );
}

function headlineState() {
  const faults = collectFaults();
  const active = faults.filter(fault => fault.active).length;
  if (active > 0) {
    return { kind: "active", count: active };
  }
  if (faults.length > 0) {
    return { kind: "recent", count: faults.length };
  }
  // No list at all is not the same as an empty list: one means the bike said
  // "nothing is wrong", the other means we have not heard from it. A list that has
  // stopped arriving is the second case too — see DIAGNOSTICS_SILENCE_MS.
  if (valueOf("dtc_list_count") == null || isStale("dtc_list_count", DIAGNOSTICS_SILENCE_MS)) {
    return { kind: "unknown", count: 0 };
  }
  return { kind: "clear", count: 0 };
}

function headlineColor() {
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

function headlineValue() {
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

function headlineCaption() {
  const state = headlineState();
  switch (state.kind) {
    case "active":
      return state.count === 1 ? "fault active now" : "faults active now";
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
 * One code. Leads with the OBD code because that is what you would search for or
 * read out to a dealer.
 * @param {FaultRow} fault
 */
function FaultCard(fault) {
  const accent = fault.active ? colors.BAD : colors.MUTED;
  const row = fault.row;
  return div(
    { class: "tile span2", style: `border-left:3px solid ${accent}` },
    div(
      { class: "label" },
      span({ style: `color:${accent}` }, row ? row.obdCode : rawLabel(fault.key)),
      span({ style: `color:${colors.MUTED}` }, fault.active ? " · active" : ` · ${describeLastSeen(fault.lastSeenMs)}`)
    ),
    div(
      { class: "sub", style: `color:${colors.CALM};font-size:0.95rem;margin-top:0.25rem` },
      row ? row.description : "Not in Energica's code table — a code the type-approval document does not list."
    ),
    row ? div({ class: "sub" }, row.name) : null,
    div(
      { class: "sub", style: `color:${colors.MUTED}` },
      `component ${componentOf(fault.key)} · symptom ${symptomOf(fault.key)}` +
        (row ? ` · warning lamp: ${milText(row.illuminatesMil)}` : "") +
        (fault.firings > 1 ? ` · ${fault.firings}× this session` : "")
    )
  );
}

/**
 * Three-way, not a boolean: the six codes that reach us from the service-tool
 * data alone have no MIL column in any source, and "no" would be an answer we
 * do not have. Same distinction `rank()` sorts on below.
 * @param {boolean | null} illuminatesMil
 */
function milText(illuminatesMil) {
  if (illuminatesMil === null) {
    return "unknown";
  }
  return illuminatesMil ? "yes" : "no";
}

/**
 * The two counts, kept apart on purpose.
 *
 * They measure different things and always disagree: `dtc_count` is OBD-II PID
 * 0x01's STORED history (39 on this bike as of 2026-08-04, and only ever
 * climbing), while `dtc_list_count` is the Connectivity Hub's ACTIVE list (0 or
 * 1). That was a suspicion until 2026-08-03, when the active list was seen
 * flipping 0↔1 on a stationary bike across two boots — stored history cannot
 * flicker. Confirmed again on 2026-08-04 under load: 11 of 47 polls carried a
 * code while PID 0x01 sat at 39, riding and DC charging alike. Merging them into
 * one number would be wrong; showing either alone would hide the other.
 */
function Counters() {
  return div(
    { class: "tile span2" },
    Fact("Active list", () => count("dtc_list_count")),
    Fact("Stored (OBD)", () => count("dtc_count")),
    Fact("Unrecognised", () => count("dtc_unrecognised_count")),
    Fact("Warning lamp", () => {
      const milOn = valueOf("mil_on");
      return milOn == null ? "—" : milOn > 0 ? "ON" : "off";
    })
  );
}

/** @param {string} key */
function count(key) {
  const value = valueOf(key);
  return value == null ? "—" : String(Math.round(value));
}

/**
 * The OBD-II lists: stored history by name, and — separately — whether the bike
 * answered at all about pending and permanent codes.
 *
 * Deliberately its own section, well below the active cards. A bike can sit at 39
 * stored and 1 active, which is exactly this one's state, and the two answer
 * different questions: the cards above are "what is wrong with it now", this is
 * "what has ever been wrong with it". Putting 39 historical codes in with one live
 * fault would bury the live one.
 */
function StoredCodes() {
  return div({ class: "tile-group" }, SectionLabel("Stored codes · OBD-II"), () => {
    // Bound to the fetched snapshot ONLY — deliberately not to chartTick. This
    // subtree is up to 39 rows, and reading the 2 Hz tick here rebuilt every one of
    // them twice a second, which also meant the "show all" button was a different
    // element by the time a thumb reached it. The tick is read in exactly one place
    // below, on the one line that has to count up on its own. Same rule as the
    // chart bindings in lib/tiles.js.
    const snapshot = stored.val;
    if (!snapshot) {
      return div(
        { class: "missing", style: `color:${colors.MUTED}` },
        storedError.val ? `Stored codes unavailable (${storedError.val}).` : "reading the bike's stored codes…"
      );
    }
    return div(StoredSummary(snapshot), StoredList(snapshot));
  });
}

/**
 * The three lists' headline states, and how old the answer is.
 * @param {TroubleCodeSnapshot} snapshot
 */
function StoredSummary(snapshot) {
  return div(
    { class: "tile span2" },
    Fact("Stored · mode 03", () => describeList(snapshot.stored)),
    Fact("Pending · mode 07", () => describeList(snapshot.pending)),
    Fact("Permanent · mode 0A", () => describeList(snapshot.permanent)),
    Fact("Last read", () => {
      // The one binding on this screen paced by the render tick: "80 s ago" has to
      // keep counting while nothing arrives, and scheduling the refetch from the
      // same place means the polling stops dead when you leave the tab. See
      // STORED_REFRESH_MS for why this is not a setInterval.
      void chartTick.val;
      void refreshStoredCodes();
      return describeSnapshotAge(snapshot);
    }),
    () => {
      // Two independent paths to one number: PID 01's counter and the length of the
      // mode-03 list. They agreed exactly (39 and 39) the day this was written, and
      // a disagreement would mean one of the two decoders is wrong — so it is worth
      // a line on screen rather than only in a comment.
      const counted = valueOf("dtc_count");
      const listed = snapshot.stored.state === "codes" ? snapshot.stored.codes.length : null;
      if (counted === null || listed === null || Math.round(counted) === listed) {
        return div();
      }
      return div(
        { class: "sub", style: `color:${colors.WARN}` },
        `PID 01 counts ${Math.round(counted)} stored codes but mode 03 listed ${listed} — they should agree.`
      );
    }
  );
}

/**
 * One line per list. The wording is the whole point of this screen's honesty: a
 * mode that answered nothing says "no response", never "0" and never "none" —
 * those would be claims the bike has not made. Modes 07 and 0A have never answered
 * here, so we cannot tell "not implemented" from "implemented and withheld".
 * @param {TroubleCodeListState} list
 */
function describeList(list) {
  switch (list.state) {
    case "codes":
      return list.truncated ? `${list.codes.length} of ${list.declaredCount} — cut short` : `${list.codes.length}`;
    case "no-response":
      return "no response";
    // "we never asked", not "the bike did not answer" — a dead can0 socket must not
    // be reported as the VCU declining.
    case "not-asked":
      return "could not ask";
    case "incomplete":
      return "reply cut short";
    case "refused":
      return `refused (${list.description})`;
    case "unrecognised":
      return "unrecognised reply";
    default:
      return "not read yet";
  }
}

/**
 * The stored codes themselves.
 *
 * Ranked rather than shown in the order the bike sends them. The VCU's own order is
 * ascending by Energica component number (1, 3, 4, 4, 5, 6, 7, 10, …), which is the
 * type-approval table's order and says nothing about which code matters — so the
 * one that lit the lamp would sit fourth. Freeze-frame code first, then the codes
 * that light the lamp, then the rest.
 * @param {TroubleCodeSnapshot} snapshot
 */
function StoredList(snapshot) {
  const list = snapshot.stored;
  if (list.state !== "codes" || list.codes.length === 0) {
    return div();
  }
  const freezeFrame = snapshot.freezeFrame && snapshot.freezeFrame.raw !== 0 ? snapshot.freezeFrame.obdCode : null;
  const ranked = [...list.codes].sort((left, right) => rank(left, freezeFrame) - rank(right, freezeFrame));
  const hidden = Math.max(0, ranked.length - STORED_PREVIEW_LIMIT);

  return div(
    { class: "tile span2" },
    div({ class: "label" }, "Set in the bike's history"),
    () =>
      div(
        ...(storedExpanded.val ? ranked : ranked.slice(0, STORED_PREVIEW_LIMIT)).map(row => CodeLine(row, freezeFrame))
      ),
    hidden === 0
      ? null
      : button(
          {
            class: "code-toggle",
            onclick: () => {
              storedExpanded.val = !storedExpanded.val;
            },
          },
          () => (storedExpanded.val ? "show fewer" : `show all ${ranked.length}`)
        ),
    div({ class: "sub", style: `color:${colors.MUTED}` }, describeFreezeFrame(snapshot, freezeFrame))
  );
}

/**
 * Three states, not two — the same distinction describeList() makes just above.
 *
 * `freezeFrame === null` means PID 02 has never been answered, which is the normal
 * state for the first ten seconds after boot (the PID is on the 20-round diagnostic
 * cadence while the first mode-03 read fires on round 1) and the permanent state if
 * it times out. Saying "no freeze frame stored" there would report the bike's answer
 * before it has given one. `raw: 0` is that answer.
 * @param {TroubleCodeSnapshot} snapshot
 * @param {string | null} freezeFrame
 */
function describeFreezeFrame(snapshot, freezeFrame) {
  if (snapshot.freezeFrame === null) {
    return "Freeze-frame code not read yet — nothing here is singled out.";
  }
  if (freezeFrame) {
    return `${freezeFrame} is the freeze-frame code — the one the bike captured when it lit the lamp.`;
  }
  return "No freeze frame stored, so nothing here is singled out as the reason for the lamp.";
}

/**
 * Sort key: freeze-frame code first, then lamp-lighting codes, then the rest.
 * A code Energica's table does not list has no MIL column, so it cannot be claimed
 * to be lamp-free — it sorts with the unknowns rather than with the harmless.
 * @param {TroubleCodeRow} row
 * @param {string | null} freezeFrame
 */
function rank(row, freezeFrame) {
  if (row.obdCode === freezeFrame) {
    return 0;
  }
  if (row.illuminatesMil) {
    return 1;
  }
  return row.illuminatesMil === null ? 2 : 3;
}

/**
 * One stored code, compact — 39 of these have to fit on a phone.
 * @param {TroubleCodeRow} row
 * @param {string | null} freezeFrame
 */
function CodeLine(row, freezeFrame) {
  const isFreezeFrame = row.obdCode === freezeFrame;
  const accent = isFreezeFrame ? colors.BAD : row.illuminatesMil ? colors.WARN : colors.MUTED;
  const note = isFreezeFrame ? " · freeze frame" : row.illuminatesMil ? " · lamp" : "";
  return div(
    { class: "code-line" },
    span({ class: "code-line-id", style: `color:${accent}` }, row.obdCode),
    span(
      { class: "code-line-text", style: `color:${row.description ? colors.CALM : colors.MUTED}` },
      (row.description ?? "not in Energica's code table") + note
    )
  );
}

/**
 * How old the bike's answer is: the server's own monotonic age at the moment it
 * served the snapshot, plus however long this phone has been holding it. Both
 * halves are needed — the first alone goes stale in the browser, and the second
 * alone would call a minute-old reading fresh because the fetch was recent.
 * @param {TroubleCodeSnapshot} snapshot
 */
function describeSnapshotAge(snapshot) {
  if (snapshot.ageMs === null) {
    return "never";
  }
  const heldFor = storedFetchedAt === null ? 0 : monotonicNow() - storedFetchedAt;
  const seconds = Math.round((snapshot.ageMs + heldFor) / 1000);
  return seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

function Footnote() {
  return div({ class: "missing", style: `color:${colors.MUTED}` }, () => {
    if (tableError.val) {
      return `Code names unavailable (${tableError.val}) — showing raw component/symptom numbers.`;
    }
    return (
      "“Active list” is what the bike reports as wrong right now; “stored” is OBD-II's fault " +
      "history and is normally much larger. A code can be set with the warning lamp off. " +
      "History starts when this page is opened — the ride log is write-only and cannot be read back. " +
      "Nothing on this screen can clear a code: the bike is only ever asked, never told."
    );
  });
}

/**
 * Every code seen since the page opened, active ones first, then most recent.
 *
 * Reads chartTick so it re-evaluates on the render tick rather than only when a
 * signal changes: "last seen 4 min ago" has to keep counting up while nothing is
 * arriving, which is precisely the state this view is for.
 * @returns {FaultRow[]}
 */
function collectFaults() {
  void chartTick.val;
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
    faults.push({ key, active, lastSeenMs, firings, row: codes ? (codes[key] ?? null) : null });
  }

  return faults.sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    return (left.lastSeenMs ?? Infinity) - (right.lastSeenMs ?? Infinity);
  });
}

/**
 * When this code was last non-zero, and how many separate times it has fired.
 * @param {string} key
 * @param {number} now
 * @returns {{ lastSeenMs: number | null, firings: number }}
 */
function historyOf(key, now) {
  return faultHistory(ringFor(key).since(HISTORY_MS, now), now);
}

/**
 * The pure half of the above, split out so it can be replayed against a recorded
 * timeline without a DOM — which is how the numbers on this screen were checked
 * against the real 2026-08-02 P0A05 sequence out of the ride log.
 *
 * Counts RISING EDGES, not samples. The signal is written on change, but the ring
 * is also fed by the whole-state snapshot the server broadcasts every 5 s, so
 * counting samples would report a code that latched once as having fired hundreds
 * of times — and "247× this session" about a single stuck fault is worse than
 * saying nothing.
 *
 * @param {{ times: number[], values: number[] }} samples oldest first
 * @param {number} now
 * @returns {{ lastSeenMs: number | null, firings: number }}
 */
export function faultHistory(samples, now) {
  const { times, values } = samples;
  let lastSeenAt = /** @type {number | null} */ (null);
  let firings = 0;
  let previous = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value > 0) {
      lastSeenAt = times[index];
      if (previous <= 0) {
        firings++;
      }
    }
    previous = value;
  }
  return { lastSeenMs: lastSeenAt === null ? null : now - lastSeenAt, firings };
}

/** @param {number | null} ageMs */
function describeLastSeen(ageMs) {
  if (ageMs === null) {
    return "not seen this session";
  }
  const minutes = Math.round(ageMs / 60_000);
  return minutes < 1 ? "cleared just now" : `last seen ${minutes} min ago`;
}

/** @param {string} key */
function componentOf(key) {
  return Number(key.split("_")[1]);
}

/** @param {string} key */
function symptomOf(key) {
  return Number(key.split("_")[2]);
}

/** @param {string} key */
function rawLabel(key) {
  return `${componentOf(key)}/${symptomOf(key)}`;
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

async function refreshStoredCodes() {
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
    const response = await fetch("/stored-dtcs");
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
    const response = await fetch("/dtc-table");
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
