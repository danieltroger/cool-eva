# Retired fault-report implementation notes

These are preserved constraints and findings from the report replaced by the approved Faults page. References to old controls and sections are historical. Current behaviour is described in [fault-report.md](fault-report.md).

## public/views/fault-report.js

```js
// .tile-group, not .view and not a bare div: .view would double the 0.5 rem
// horizontal padding and inset this group relative to the hero and Counters
// either side of it, while a bare div drops the cards out of any grid and
// loses the gap between them entirely.

/**
 * One code. Leads with the OBD code because that is what you would search for or
 * read out to a dealer.
 * @param {FaultRow} fault
 */

// ⚠️ Its own binding, and the ONLY thing on this card that reads the tick. The card
// itself must stay put — see collectFaults.

// A plain button here, unlike on a stored code line: a card is not itself a control,
// so there is nothing to nest inside.

/**
 * Three-way, not a boolean: the six codes that reach us from the manufacturer
 * data alone have no MIL column in any source, and "no" would be an answer we
 * do not have. Same distinction `rank()` sorts on below.
 * @param {boolean | null} illuminatesMil
 */

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
```

## public/views/stored-faults.js

```js
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

// Bound to the fetched snapshot ONLY — deliberately not to chartTick. This
// subtree is up to 39 rows, and reading the 2 Hz tick here rebuilt every one of
// them twice a second, which also meant the "show all" button was a different
// element by the time a thumb reached it. The tick is read in exactly one place
// below, on the one line that has to count up on its own. Same rule as the
// chart bindings in lib/tiles.js.

// The one binding on this screen paced by the render tick: "80 s ago" has to
// keep counting while nothing arrives, and scheduling the refetch from the
// same place means the polling stops dead when you leave the tab. See
// STORED_REFRESH_MS for why this is not a setInterval.

// Two independent paths to one number: PID 01's counter and the length of the
// mode-03 list. They agreed exactly (39 and 39) the day this was written, and
// a disagreement would mean one of the two decoders is wrong — so it is worth
// a line on screen rather than only in a comment.

/**
 * One line per list. The wording is the whole point of this screen's honesty: a
 * mode that answered nothing says "no response", never "0" and never "none" —
 * those would be claims the bike has not made. Modes 07 and 0A have never answered
 * here, so we cannot tell "not implemented" from "implemented and withheld".
 * @param {TroubleCodeListState} list
 */

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

// `null`, not `div()`: this is a grid item of the group above now, so an empty div
// is a second row and pays the 0.5 rem gap for it — 8 px of dead space under the
// summary on a refused read and on a bike with a clean history. van's add() skips a
// null child (`child != _undefined`), which is why the "show all" button below can be
// one too.

// ⚠️ The count is labelled with the population it belongs to. This is the OBD mode-03
// STORED list; the hero above counts the ACTIVE one, and they always disagree — 41
// against 0 or 1 on this bike. One number called "expected" with no list named would
// be read as belonging to whichever the reader was looking at.
//
// Outside the tile, like every other heading on this screen. Bound rather than
// interpolated: marking a code expected changes the count, and a plain string
// would leave the heading showing the number from before the tap.

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

/**
 * Sort key: freeze-frame code first, then lamp-lighting codes, then the rest.
 * A code Energica's table does not list has no MIL column, so it cannot be claimed
 * to be lamp-free — it sorts with the unknowns rather than with the harmless.
 * @param {TroubleCodeRow} row
 * @param {string | null} freezeFrame
 */

/**
 * One stored code, compact — 39 of these have to fit on a phone.
 * @param {TroubleCodeRow} row
 * @param {string | null} freezeFrame
 */

// ⚠️ The accent stays on the LAMP, and "expected" does not touch it. All five codes this
// bike's owner calls expected have `illuminatesMil: false` and so already render MUTED —
// so muting them changes nothing — while muting a code whose lamp bit is true, or
// unknown, would destroy the three-way distinction `milText` and `rank` keep on purpose.

// Null for a code Energica's table does not list: with no (component, symptom)
// there is no shortlist to look up, and the OBD code is not a usable key —
// U0182 is filed under two components. The line then just does not open.

// A div rather than a <button>: a button arrives with UA styles this row would
// then have to undo — rendered side by side at 390 px it comes out in Arial
// rather than the page's font, centred, and 4 px taller. The cost is that the
// keyboard affordances have to be spelled out: role, tabindex AND a key handler.
// role without the handler would be worse than no role at all, since it
// advertises a control that then does not work.

/**
 * Energica's own shortlist for one code: the telemetry the manufacturer's service
 * tool shows when this fault is selected.
 *
 * ⚠️ THIS IS NOT WHAT THE BIKE RECORDED. It is the list of fields a record for this code
 * WOULD contain — "what should I go and measure", answered offline with no bus traffic.
 * The values are ./recorded-values.js, rendered above it.
 * @param {string} key
 */

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

// An EMPTY list is a real answer and not a missing one — (60,0) P1052 has one in
// Energica's own data. Saying so beats rendering an empty box.

// A dangling id cannot happen — all 944 references resolve, and
// scripts/check-freeze-frame.ts asserts it — so if one ever shows up it
// should say what it is rather than render as an empty row.
```

## public/views/recorded-values.js

```js
// What the VCU recorded when one code set — the values, under the code that set them.
//
// ⚠️ IT NEVER SAYS "FREEZE FRAME", and that is not squeamishness. The Faults tab already
// uses that phrase, correctly, for OBD mode 01 PID 02's freeze-frame DTC — the code the
// bike captured when it lit the lamp — with its own tag and its own three-state caption.
// This is the KWP `0x17` per-component record, a different thing read a different way, and
// two things called "freeze frame" on one screen is how a reader stops trusting either.
// The wire, the store and the docs keep the protocol's name; the copy on the phone does not.
//
// ⚠️ Values are gated through lib/bounds.js and a rejected one is drawn as a FAULT, never
// clamped and never dropped. Real data contains sentinels, and a plausible-looking number
// invented from an implausible one is the failure that file exists to prevent.

/**
 * The last reading, from /freeze-frames. Null until the fetch lands; a failure leaves it
 * null and every code says "nothing has been read on this Pi", which is the honest reading
 * of what the PAGE knows.
 */

/**
 * Set when the fetch itself failed, so the page can tell "nothing has been read" from "we
 * could not ask". ⚠️ They are different claims and only one is about the motorcycle —
 * `console.warn` already kept them apart in the journal; this is what keeps them apart on
 * screen.
 */

/**
 * Fetches the reading.
 *
 * Re-fetched on every entry to the Faults tab rather than cached for the session: a read is
 * taken from the service sheet, so coming back to Faults after taking one has to show it.
 * Cheap — one record per stored code, not the 39-row list.
 */

// Never swallowed. The page renders "nothing has been read on this Pi", which is true
// of what it knows; this line is what separates that from the Pi genuinely never
// having read the bike.

/**
 * ⚠️ Only reached when /freeze-frames itself could not be fetched, so the instruction is
 * shown without the server's own wording. The server's copy is the one that ships; this
 * exists so a failed fetch does not render the word "undefined" at somebody in a garage.
 */

/**
 * Whether a decoded record for this code is on screen.
 *
 * Used by the caller to decide whether Energica's field-NAME list still earns its place: it
 * answers "what should I go and measure", and under a reading it repeats the same names
 * with a unit added. Reads `reading.val` rather than peeking, so the names come back by
 * themselves if the reading is ever cleared.
 * @param {string} key
 */

/**
 * The decoded record for this code, or null.
 *
 * ⚠️ ONE definition of "there is a reading for this code". `Values` below and
 * `hasRecordedValues` above both need it — the first to render, the second to decide
 * whether Energica's name list still earns its place — and as two spellings of
 * "found ∧ no failure ∧ decoded to a frame ∧ symptom matches" they had to agree or the
 * hiding rule would diverge from what is on screen.
 * @param {string} key
 * @returns {import("../../src/diagnostics/freeze-frame.ts").FreezeFrame | null}
 */

/**
 * The block itself.
 *
 * Four states, kept apart because they are four different claims and only one of them is
 * about the motorcycle being fine:
 *
 *   1. no reading on this Pi — nothing has been read, which says nothing about the bike
 *   2. read, but the VCU's list did not name this component
 *   3. read, the VCU listed it and answered `57 00` — it has no record to give
 *   4. read, and here is what it recorded
 *
 * @param {string} key `"component/symptom"`
 * @param {number} component
 * @param {number} symptom
 */

// ⚠️ Read from the module signal rather than taken as a parameter named `reading`, which
// shadowed it — a half-pure function that still reached for `fetchFailed.val` bought
// nothing and made `reading.val` inside here silently `undefined`.

// ⚠️ Two different sentences, because they are two different claims. "Nothing has been
// read on this Pi" is about the motorcycle; a failed fetch is about this page, and
// saying the first from the second is the screen inventing an answer the bike never
// gave — the distinction src/diagnostics/stored-codes.ts exists to protect.

// On the list and not among the records: the read ended before it got here. ⚠️ WHY it
// ended is in `completion` and is not guessed — a gate-closed abort and a budget
// overrun are different things and only one of them is about how long the read takes.

// `57 00` lands here — two bytes, shorter than the header, so the decoder files it
// `unrecognised` and carries no failure. That combination IS the bike saying it has
// nothing stored for this component.

// The record is real and is about another symptom of the same component. Said rather
// than shown under the wrong code: `0x17` takes no symptom, so this is the ordinary
// way a component with two faults answers.

// ⚠️ The null test rather than `fault.kind`, only so TypeScript narrows `value.value`
// below — the two are the same condition by construction, and `infokeyFault` is still
// what decides whether the number is out of range.

// Energica states a scaling this repo will not apply. The raw number is still true, so
// it is shown — with the reason, and with no unit, because putting one on it would be
// the claim we are declining to make. NOT bounds-checked: gating a deliberately
// unscaled number against the scaled unit's range is a second, wrong complaint.

// ⚠️ lib/format.js's rule, not a third one. `V_ODOMETER` and `TotalExchangedAh` are six
// and seven digits here, and public/lib/lifetime.js already renders the SAME
// FreezeFrameValue rows through `groupedReading` a tab away — two numbers disagreeing
// about what "precise" means is what you notice first.

/**
 * ⚠️ "Cycles", not "key cycles". The read that settled this counter spanned both a VCU
 * reset and a key-off/key-on and moved by +1, not +2, so which of the two it counts is
 * unresolved — docs/freeze-frame.md. Saying "key cycles" here would be the screen claiming
 * a thing nobody has measured.
 * @param {number | null} cycles
 */
```

## Retired stored-code row layout

```css
/* ---------- stored trouble codes (faults view) ---------- */

/* Thirty-nine of these have to fit on a phone: the code on the left at a fixed width so
   the codes form a readable column, the description filling the rest. Long rows wrap
   rather than clip — `· freeze frame · expected` are the two suffixes that say why a row
   matters at all, they sit at the END of the longest lines, and that is exactly what an
   ellipsis eats. Most rows still take one line; today's list wraps one. */
.code-line {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.76rem;
  line-height: 1.6;
}

.code-line-id {
  flex: 0 0 3.6rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

.code-line-text {
  flex: 1 1 auto;
  min-width: 0;
  /* Wrapping at all is what fixes #253: `white-space: nowrap` held this span's min-content
     at 327 px. `anywhere` rather than `break-word` — the call `.code-field` makes below,
     for the same reason — buys the rest: break-word leaves the minimum at the longest WORD
     (53 px in today's list, which fits), `anywhere` takes it to one character, and only
     that survives a name longer than the column. Energica's table is full of candidates. */
  overflow-wrap: anywhere;
}

/* The open/closed marker on a code line that has a shortlist. Pushed to the right
   edge and given a fixed width so the caret does not shift the description text
   when it flips, and so lines without one do not lose alignment. */
.code-line-more {
  flex: 0 0 0.9rem;
  text-align: right;
  color: var(--label);
  font-size: 0.7rem;
}

/* Energica's field list under an opened code. Indented to the width of the code
   column so it reads as belonging to the line above rather than as a new row. */
.code-fields {
  margin: 0.15rem 0 0.5rem 4.1rem;
  font-size: 0.72rem;
  line-height: 1.7;
}

.code-field {
  font-variant-numeric: tabular-nums;
  /* The names are Energica's internal identifiers — long, and full of
     underscores. Wrapping beats clipping here: a truncated `ai_WaterPumpCurr…`
     is exactly the name you needed to read. */
  overflow-wrap: anywhere;
}
```

## Retired grid width probe

```ts
/**
 * A deliberately synthetic probe, run in the page and undone again.
 *
 * Once the description wraps, nothing the bike can actually store has a min-content wide
 * enough to widen anything — so no fixture can falsify the OTHER half of #253's fix,
 * `.tile { min-width: 0 }`. This puts content in the tile that cannot wrap by construction
 * and asks the one question that line answers: is the tile's BOX still the phone's width, or
 * has its content been allowed to set it? ⚠️ The box, not the page: unbreakable content still
 * paints past the tile either way, and the body reports 3878 px in both. Nothing in CSS stops
 * that without clipping, which is why the row above is the assertion that guards the phone.
 */
const PROBE = `(() => {
  const tile = document.querySelector(".fault-row");
  if (tile === null) {
    throw new Error("no fault disclosure to probe");
  }
  const probe = document.createElement("span");
  probe.style.whiteSpace = "nowrap";
  probe.textContent = "unbreakable ".repeat(40).replaceAll(" ", "-");
  tile.append(probe);
  // Against the VIEWPORT, not against the group: the group is sized by the tile it holds, so
  // the two agree all the way to 3883 px and comparing them can never fail.
  const widths = {
    tile: Math.round(tile.getBoundingClientRect().width),
    viewport: document.documentElement.clientWidth,
  };
  probe.remove();
  return widths;
})()`;
```

## Previous Expected control

```js
/**
 * The mark-as-expected control.
 *
 * ⚠️ On a stored code line it renders INSIDE the opened code, never on the line itself:
 * `.code-line` is a `div` with `role="button"` and its own key handler, and a real
 * `<button>` nested in that is a control inside a control — two tap targets in one row on
 * a phone, and a screen reader announcing a button within a button. Expanding a code and
 * then marking it is also the order the decision is made in: you look at what it recorded,
 * then say whether you expected it.
 * @param {string} key `"component/symptom"`
 */
```
