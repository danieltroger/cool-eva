# Fault summary and complete report

The handlebar landing keeps the full count and two stable named previews. The scrolling `#faults/report` retains all diagnostic lists, expected-fault editing, counters, recorded values and qualifications. Bike information opens that report directly; browser history retains its actual origin. Expected faults remain counted.

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
