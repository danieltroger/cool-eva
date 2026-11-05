// @ts-check
// Stored/pending/permanent lists, recorded values and their limits: docs/fault-report.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, valueOf } from "../lib/store.js";
import { Fact, SectionLabel } from "../lib/tiles.js";
import * as colors from "../lib/colors.js";
import { RecordedValues, hasRecordedValues } from "./recorded-values.js";
import { ExpectedToggle, expectedNote, faultKey, isExpected } from "../lib/expected-faults.js";
import {
  STORED_PREVIEW_LIMIT,
  stored,
  storedError,
  storedExpanded,
  infokeys,
  openShortlist,
  refreshStoredCodes,
  describeSnapshotAge,
} from "../lib/fault-data.js";
/** @typedef {import("../../src/http/stored-dtcs.ts").TroubleCodeSnapshot} TroubleCodeSnapshot */
/** @typedef {import("../../src/http/stored-dtcs.ts").TroubleCodeListState} TroubleCodeListState */
/** @typedef {import("../../src/http/stored-dtcs.ts").TroubleCodeRow} TroubleCodeRow */
const { button, div, span } = van.tags;

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
export function StoredCodes() {
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
    return div({ class: "tile-group" }, StoredSummary(snapshot), StoredList(snapshot));
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
    // `null`, not `div()`: this is a grid item of the group above now, so an empty div
    // is a second row and pays the 0.5 rem gap for it — 8 px of dead space under the
    // summary on a refused read and on a bike with a clean history. van's add() skips a
    // null child (`child != _undefined`), which is why the "show all" button below can be
    // one too.
    return null;
  }
  const freezeFrame = snapshot.freezeFrame && snapshot.freezeFrame.raw !== 0 ? snapshot.freezeFrame.obdCode : null;
  const ranked = [...list.codes].sort((left, right) => rank(left, freezeFrame) - rank(right, freezeFrame));
  const hidden = Math.max(0, ranked.length - STORED_PREVIEW_LIMIT);

  return div(
    { class: "tile-group" },
    // ⚠️ The count is labelled with the population it belongs to. This is the OBD mode-03
    // STORED list; the hero above counts the ACTIVE one, and they always disagree — 41
    // against 0 or 1 on this bike. One number called "expected" with no list named would
    // be read as belonging to whichever the reader was looking at.
    //
    // Outside the tile, like every other heading on this screen. Bound rather than
    // interpolated: marking a code expected changes the count, and a plain string
    // would leave the heading showing the number from before the tap.
    SectionLabel(() => `Set in the bike's history${expectedNote(ranked)}`),
    div(
      { class: "tile span2" },
      () =>
        div(
          ...(storedExpanded.val ? ranked : ranked.slice(0, STORED_PREVIEW_LIMIT)).map(row =>
            CodeLine(row, freezeFrame)
          )
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
    )
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
  // ⚠️ The accent stays on the LAMP, and "expected" does not touch it. All five codes this
  // bike's owner calls expected have `illuminatesMil: false` and so already render MUTED —
  // so muting them changes nothing — while muting a code whose lamp bit is true, or
  // unknown, would destroy the three-way distinction `milText` and `rank` keep on purpose.
  const accent = isFreezeFrame ? colors.BAD : row.illuminatesMil ? colors.WARN : colors.MUTED;
  const note = isFreezeFrame ? " · freeze frame" : row.illuminatesMil ? " · lamp" : "";
  // Null for a code Energica's table does not list: with no (component, symptom)
  // there is no shortlist to look up, and the OBD code is not a usable key —
  // U0182 is filed under two components. The line then just does not open.
  const key = row.component === null || row.symptom === null ? null : faultKey(row.component, row.symptom);
  return div(
    div(
      {
        class: "code-line",
        // A div rather than a <button>: a button arrives with UA styles this row would
        // then have to undo — rendered side by side at 390 px it comes out in Arial
        // rather than the page's font, centred, and 4 px taller. The cost is that the
        // keyboard affordances have to be spelled out: role, tabindex AND a key handler.
        // role without the handler would be worse than no role at all, since it
        // advertises a control that then does not work.
        ...(key === null
          ? {}
          : {
              role: "button",
              tabindex: "0",
              onclick: () => toggleShortlist(key),
              onkeydown: (/** @type {KeyboardEvent} */ event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }
                // Space scrolls the page otherwise, which on a 39-row list moves
                // the thing you just tried to open off the screen.
                event.preventDefault();
                toggleShortlist(key);
              },
            }),
      },
      span({ class: "code-line-id", style: `color:${accent}` }, row.obdCode),
      span(
        { class: "code-line-text", style: `color:${row.description ? colors.CALM : colors.MUTED}` },
        () => (row.description ?? "not in Energica's code table") + note + (isExpected(key) ? " · expected" : "")
      ),
      key === null ? null : span({ class: "code-line-more" }, () => (openShortlist.val === key ? "▴" : "▾"))
    ),
    () => (key !== null && openShortlist.val === key ? OpenedCode(key) : div())
  );
}

/**
 * Opens this code's shortlist, or closes it if it is already the open one.
 * @param {string} key
 */
function toggleShortlist(key) {
  openShortlist.val = openShortlist.val === key ? null : key;
}

/**
 * Energica's own shortlist for one code: the telemetry the manufacturer's service
 * tool shows when this fault is selected.
 *
 * ⚠️ THIS IS NOT WHAT THE BIKE RECORDED. It is the list of fields a record for this code
 * WOULD contain — "what should I go and measure", answered offline with no bus traffic.
 * The values are ./recorded-values.js, rendered above it.
 * @param {string} key
 */
function OpenedCode(key) {
  // ⚠️ ABOVE every early return in `Shortlist`, and that is not cosmetic. It returns early
  // on three conditions, and (60,0) P1052 — which IS on this bike's 0x18 list — has an
  // EMPTY shortlist, so the one code whose record carries nothing but its age would have
  // been the one code whose age never reached the screen, and it could not be marked
  // expected either. A failed /fault-infokeys hit the same wall: `infokeys.val` stays null
  // for the session, which silently disabled every recorded value even though
  // /freeze-frames had answered.
  //
  // ⚠️ And the "is there a reading?" gate lives HERE rather than inside `Shortlist`, for the
  // same reason. Inside, it sat below those three returns — so P1052 rendered "Energica
  // records no fields for this code" from `Shortlist` AND the identical sentence from the
  // record block, twice in one opened code. Here it is one policy line next to the comment
  // that justifies it, `Shortlist` goes back to the shape it had, and the "Loading Energica's
  // field list…" note stops appearing under a reading that has already arrived.
  return div(RecordedValues(key), () => (hasRecordedValues(key) ? div() : Shortlist(key)), ExpectedToggle(key));
}

/** @param {string} key */
function Shortlist(key) {
  const payload = infokeys.val;
  if (!payload) {
    return div({ class: "code-fields", style: `color:${colors.MUTED}` }, "Loading Energica's field list…");
  }
  const ids = payload.shortlists[key];
  if (!ids) {
    return div(
      { class: "code-fields", style: `color:${colors.MUTED}` },
      "Energica's tool lists no fields for this code."
    );
  }
  // An EMPTY list is a real answer and not a missing one — (60,0) P1052 has one in
  // Energica's own data. Saying so beats rendering an empty box.
  if (ids.length === 0) {
    return div({ class: "code-fields", style: `color:${colors.MUTED}` }, "Energica records no fields for this code.");
  }
  return div(
    { class: "code-fields" },
    div({ style: `color:${colors.MUTED}` }, "Energica's fields for this code:"),
    ...ids.map(id => {
      const field = payload.fields[String(id)];
      // A dangling id cannot happen — all 944 references resolve, and
      // scripts/check-freeze-frame.ts asserts it — so if one ever shows up it
      // should say what it is rather than render as an empty row.
      if (!field) {
        return div({ style: `color:${colors.WARN}` }, `unknown field ${id}`);
      }
      return div(
        { class: "code-field" },
        span({ style: `color:${colors.CALM}` }, field.name),
        span({ style: `color:${colors.MUTED}` }, field.unit ? ` · ${field.unit}` : "")
      );
    })
  );
}
