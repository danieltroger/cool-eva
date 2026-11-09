# Faults and recorded values

The approved Faults page is one scrolling `#faults` screen. Active codes have expandable rows; the remaining stored codes live in the Stored faults disclosure. Each component/symptom appears once. Every row keeps its Expected checkbox and its own recorded values. The bottom bar stays present. The old `#faults/report` bookmark normalises to this page, and Bike uses the persistent Faults tab. Browser history retains the actual origin.

The former count/previews/report split, counters and explanatory paragraphs are retired. Their implementation constraints and negative results are preserved here and in [the retired implementation notes](fault-report-legacy.md).

## Recorded data audit

`scripts/check-fault-records.ts` writes all 29 committed freeze-frame replies to a temporary durable store, serves the production GET `/freeze-frames` endpoint on localhost, and checks the response through the UI's record resolver. The pump's seven captured fields survive unchanged: vehicle state 22, pump current 0 mA, pump status −4, three IGBT temperatures 34.9 °C, outside air 28.5 °C, and cycle byte 255. No server change is needed for that replay. This establishes the committed path; it does not establish what is currently saved on a particular Pi.

Daniel's feedback screenshot explicitly says that B1012's component record belongs to B1013. That explains the absent B1012 values in that image without evidence of a decoder failure. The UI continues to withhold another symptom's measurements and shows the matching code plus B1012's own field names. A component and symptom form the identity; an OBD string alone is insufficient because some OBD strings occur under two components.

## Complete values and quality

All expected code-specific field slots are retained, including missing fields in a partial reply. Present values come only from the named HTTP response shape; there are no fallback or example measurements in production UI code. The sketch's friendly pump and lighting labels retain original field names in titles. Other field names remain available verbatim. Units come from each decoded field. Implausible values use the existing infokey/bounds gate and display fault; refused scaling displays raw data without claiming its scaled unit. The cycle caption uses the actual decoded byte, with null distinct from zero. The counter's unresolved meaning stays in its title and [freeze-frame.md](freeze-frame.md).

Not read, not listed, a missing/failed reply, an exact `57 00` no-record answer, a different symptom and a matching record remain separate. A garbled reply does not become “no record.” Failed HTTP refreshes cannot display an earlier cached payload as the new answer. The fetch runs when Faults opens; its GET serves saved data without touching the bike. A silent or offline active list carries an explicit unavailable state; expected codes remain in the data and never reduce reported totals.

Disclosure nodes and their list wrapper survive telemetry pulses, membership changes, stored-list refreshes and Expected reordering. VanJS property derives retain their owning DOM node; preserving rows while replacing their wrapper can silently detach those derives, leaving a visible checkbox unable to reflect a pending write. The stable wrapper is therefore a binding constraint as well as a visual one. Removed rows leave the node cache so returning rows get live bindings. The checkbox uses the existing serialised, CSRF-protected expected-fault endpoint. It waits for the server's set; a refusal keeps the confirmed value and reports only under the affected code. Empty reactive states retain a DOM anchor so later errors and liveness changes can render.

## Preserved implementation rationale

These blocks moved from `public/views/faults.js` while splitting the existing report; their evidence and negative results are retained. Historical references to “this screen” describe the complete report.

```js
// The faults screen.
//
// Built around one property of this bike's only observed code: it FLICKERS.
// P0A07 (water pump open circuit) was active on 2 of 8 consecutive polls across
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
```

```js
/**
 * Every code seen since the page opened, active ones first, then most recent.
 *
 * ⚠️ It does NOT read chartTick, and that changed with #226. It used to, so that
 * "last seen 4 min ago" would count up — but that put every fault card, and since
 * #226 a real `<button>` inside one, into a subtree VanJS `replaceWith`s twice a
 * second. A finger down at t and up at t+120 ms can then land on an element that
 * no longer exists: exactly the failure `StoredCodes` above is bound off the tick
 * to avoid, where its own comment records the "show all" button being "a different
 * element by the time a thumb reached it".
 *
 * The counting-up now happens where it belongs — inside the one line that has to do
 * it (`FaultCard`'s age caption), which is the same shape `StoredSummary`'s "Last
 * read" already uses. The LIST still refreshes without the tick: src/ws.ts
 * re-broadcasts the whole snapshot every 5 s, so every `dtc_*` signal is written
 * again on that cadence and this re-runs then — which is far inside RECENT_MS's 30
 * minutes, the only deadline the membership of this list actually has.
 * @returns {FaultRow[]}
 */
```

## All: snapshot before parked detail

The six-reading snapshot is independent of filtering. Raw groups stay below the filter/history row; stored lifetime readings follow the raw groups and retain their own filtering, ages and qualifications. The landing is 504 px; lower parked content deliberately scrolls. Arrival resets to the top. Raw onDemand readings use the shared presence/link-liveness policy, and keep rejected-value warnings. `pack_kw (raw)` retains its sign with “− out · + in”.

The original All view was a debugging view grouped by signal registry because the flat grid of roughly 230 signals, including 81 cell voltages, had become unusable. It remains the place to inspect a raw number when another view looks wrong; the live snapshot now precedes that grid.

Both the snapshot and raw grid preserve signed pack power in normal foreground ink. Fault-only raw and button tiles retain their rejection warning without stale dimming: only an accepted reading can become stale. Accepted onDemand readings still use presence and link liveness, while measured readings retain their age check.

## Stored lifetime statistics: original placement rationale

The snapshot now precedes raw groups and stored lifetime data. The stored block still stays separate from live-signal groups, and its filter behavior is preserved.

```js
/**
 * The bike's lifetime battery statistics, above the grid.
 *
 * ⚠️ PINNED RATHER THAN A SECTION OF THE GRID, and the reason is not layout: these are
 * not signals. They have no arrival time and no staleness, so `groupOf` and
 * `isStale(key, STALE_MS)` — which every tile below depends on — have nothing true to
 * say about them, and a "lifetime" group sorting alphabetically between `gps` and
 * `motor` would be findable only by somebody who already knew it was there.
 *
 * It still OBEYS the filter, so the one interaction this view has keeps working: type
 * anything and these rows narrow with the rest, and the block disappears when none of
 * them match. docs/dashboard-decisions.md § "The lifetime block".
 */
```

A missing or silent active list is unknown: a confirmed empty list means the bike reported no active faults, while missing data cannot establish that. Current totals use the complete reported count even when individual entries were capped or are unrecognised; expected entries are included.
