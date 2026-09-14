# Route & charging map

`grafana/dashboards/route-map.json` — where the bike went, and where it charged, from the decrypted ride log. Related: `grafana/README.md` (the datasource's own traps), `docs/charge-manager.md` (what the charge signals mean), `docs/dashboard-decisions.md`.

Everything below was measured against the 2026-09-07 decrypt (15 477 057 readings, 2026-08-02 → 2026-09-07), **except the charge-stop corroboration section**, which is measured against the archive as it stood on 2026-09-14 (2026-08-02 → 2026-09-12) and says so where the numbers differ. No coordinates appear in this file or in the dashboard JSON, and that is deliberate — see [No coordinates anywhere](#no-coordinates-anywhere).

## Reconstructing a track from two independent signals

`gps_lat` and `gps_lon` are **separate log-on-change signals with independent deadbands**. They share a millisecond whenever the decoder completes a fix and both moved — but a heading that only moves one of them logs only that one. Over the archive:

|                            | rows    |
| -------------------------- | ------- |
| `gps_lat`                  | 97 868  |
| `gps_lon`                  | 100 277 |
| sharing an exact timestamp | 80 774  |

So an inner join on equal `ts` silently drops **17.5 % of the track**. Each signal is carried forward onto the other's timestamps instead. SQLite has no `IGNORE NULLS`, so the carry-forward is expressed as "the timestamp of the last non-null", joined back to the row holding it.

The window reaches 10 minutes below `$__from` to seed that hold, for the reason `grafana/README.md` gives under _"Carry-forward joins need seeding from before `$__from`"_: a window opening mid-ride otherwise starts with a latitude and no longitude and draws nothing.

### One point per second, and why it matters more than it sounds

The per-millisecond pivot emits a row at **each signal's own timestamp**, so a latitude row and a longitude row 1 ms apart become two points a few metres apart — a staircase.

That staircase is not a cosmetic problem. It destroys any speed-based outlier test: 7 m in 1 ms reads as 25 000 km/h. Of the 117 370 consecutive steps on the per-millisecond pivot, **4 718 imply over 200 km/h** — essentially all of them this artefact rather than bad data, which is why a first attempt at despiking on implied speed rejected them wholesale. Collapsing to the last exact sample of each second removes it, and drops the archive to 65 483 points.

## Despiking by shape, not by speed and not by coordinate range

The decoder occasionally produces a longitude carrying an **extra leading digit**, landing it roughly 100° away from the fixes one second either side of it. Three of these exist in the archive. (The values themselves are not reproduced here, for the same reason the dashboard carries no coordinates.)

**A coordinate range gate would catch them and is the wrong tool three times over.** Such a value is a perfectly valid longitude, so the test is really a geography test; a `BETWEEN` in a committed dashboard tells anyone reading the repo which part of the world this bike is ridden in; and — the strongest of the three — **not every corrupt fix leaves the plausible box.** The archive contains single fixes that jump 0.3 km, 1.4 km, 4.8 km and 420 km out and straight back, all of them well inside any latitude/longitude bounds you would think to write. A range gate cannot see those at all.

A spike is defined by **shape** instead: the point sits far from both neighbours _while the neighbours agree with each other_. That third clause is what makes the test safe with no assumption about speed or sampling rate — when the bike is genuinely carried somewhere between two fixes (a trailer, a ferry, an overnight gap), the point after the gap is also far from the point before it, the neighbours **disagree**, and the real position is kept. Only a lone excursion away from a track that continues undisturbed is thrown out.

The comparison is **scale-free** — "sticks out by more than 5× what the neighbours are apart" — rather than a tuned distance, because any fixed threshold is simultaneously too tight for a parked bike and too loose for a moving one.

It carries one absolute floor, and that floor is not a redundant belt. The ratio **degenerates exactly where the neighbours converge**, which is every second the bike sits still with the hub awake: `d(prev, next)` approaches zero, and ordinary GPS jitter then satisfies any ratio you pick. Measured over the archive's 65 481 points:

| rule                               | points rejected |
| ---------------------------------- | --------------- |
| ratio alone (5×)                   | 280             |
| ratio + 220 m floor                | **17**          |
| earlier absolute-only rule (11 km) | 11              |

The 263 the floor saves are parked jitter, not data. ⚠️ **That measurement is now load-bearing twice over**: `src/gps/fix-plausibility.ts`'s `MAX_STEP_METRES` is a floor of the same size, derived independently from the cost curve in `docs/waypoints.md` and **not** a shared constant — this one is a despiker threshold in squared degrees over per-second points, that one a great-circle distance between two live fixes, and they are free to move apart. The agreement matters in the other direction: because this floor defines what counts as an excursion, it also bounds what the archive can say about any waypoint threshold below ~130 m. The 17 it keeps are a strict superset of what the old absolute rule caught, and the 6 it adds are unambiguous: every one is an out-and-back whose outbound and return legs agree to within metres while the neighbours sit metres apart — the smallest being 284 m out and 280 m back in 1.6 s, or 640 km/h. 220 m is far above GPS jitter and far below any real excursion.

Distances stay **squared and in degrees**: no `SQRT`, no `POW`, no trig, so nothing depends on the datasource's SQLite being built with `SQLITE_ENABLE_MATH_FUNCTIONS`.

> ⚠️ An earlier version gated on the time step instead — skip the test when `dt > 120 s`, on the grounds that a long gap can legitimately move a long way. That let exactly **two** corrupt fixes through, both in stretches where reception was sparse enough that the neighbouring steps exceeded the gate. Two points out of 67 851 were enough to stretch the map's auto-fit to the whole globe. **A despiker on map data is not judged by the fraction it catches but by whether any survive.**

### Both window edges need slack, not just the lower one

The spike test needs a point on each side, so a point with no successor is never tested — and with a window bounded at `$__to`, that is **the last point of every window**. Since the dashboard's default range ends at `now`, the untested point is the newest fix in the archive.

Measured before the fix: setting `$__to` to one of the archive's corrupt longitudes returned a window whose final point sat ~120° from the track, and one window returned a **single row**, the corrupt fix itself. `fit` then framed half the planet — precisely the failure this section says the despiker exists to prevent, reintroduced at the boundary.

So `raw` reaches 10 minutes past `$__to` as well as below `$__from`, and `budgeted` trims back to the window afterwards. The genuinely last point in the database still has no successor; that is one point at the end of all data rather than one at the end of every view.

## Charge sessions need slack at the window edges too

Same shape of bug, different query. The evidence stream was bounded at the window, so a session straddling `$__from` was **clipped rather than excluded**, and clipping is the worse failure: the session kept rendering, with the window's own `from` as its start time and a third of its energy missing, and nothing on screen said so. Opening the window later still made it vanish outright, because the clipped span fell under the five-minute minimum — which also silently removed the ride split that session was supposed to cause.

The evidence now reaches 12 hours either side and sessions are kept on **overlap** with the window. A session reports the same start time and the same energy from any window that contains any part of it.

## The track is points, not a line

This is a correctness decision, not a style one.

Grafana's route layer joins every point in the frame in order, so a window spanning more than one ride draws a straight line from the end of one to the start of the next. On this data that is a clean green line running most of the way across Europe, down roads the bike was on a trailer for. It looks exactly like a ride.

**There is no way to break that line.** The layer's `update` is, in full:

```js
update: (data) => {
  if (data.series?.length)
    for (const frame of data.series) { ...; updateLineString(frame); break; }
}
```

It renders `series[0]` and nothing else. So the obvious fix — split the query into one frame per segment with a `partitionByValues` transformation — draws only the _first_ segment and silently discards the rest.

The other obvious fix, emitting `NULL` coordinate rows as break markers, is worse than useless: a `NULL` coordinate makes the layer's extent `NaN`, and _"fit to data"_ then falls back to centre 0,0 / zoom 1 — an empty world map, with nothing logged anywhere. It takes the charge-stop markers down with it at the same time.

A markers layer has none of these problems: it cannot fabricate a path, and where the bike was not logging the points simply stop. At 1 Hz they read as a continuous track anyway.

### Thinning

Every point is an individually styled OpenLayers feature. At the archive's full ~68 000 the layer **stops painting altogether** — tiles load, the canvas stays black, nothing is logged to the console. 12 000 renders comfortably, so the query thins to that budget.

The stride is derived from the window's own row count, which makes it self-correcting: zoom out to 90 days and points land ~6 s apart (sub-pixel at that scale); narrow to one ride and the stride falls back to 1 and every fix is drawn.

> Use **ceiling** division. Plain `total / 12000` is integer division in SQLite, so a 23 616-point ride day gives a stride of 1 and no thinning at all — twice the budget, and the failure is silent.

## `view.zoom` is the fit's zoom cap, and it must be set

Setting the panel's initial view to _"Fit to data"_ is not enough. Geomap computes the cap as:

```js
const cap = view.zoom ?? view.maxZoom;
view.fit(extent, { maxZoom: cap });
if (currentZoom > cap) view.setZoom(cap);
```

The panel's **default view object supplies `zoom: 1`**, so an unset `zoom` pins every fit to zoom level 1 — the whole world — and `maxZoom` is never consulted at all. Measured on 11.3.0: the map loaded centred on 0,0 at zoom 1 with `maxZoom: 18` set and ignored, and the panel editor's "Max Zoom" field read `1` while the JSON said `18`.

So `view.zoom` is set to 18. Because `id` is `fit`, geomap's final `if (view.zoom && id !== Fit) setZoom(view.zoom)` does not fire, and it acts purely as the cap.

## A charge stop is not a measured position

**This bike logs almost no GPS while charging.** The Connectivity Hub sleeps, so of the 20 sessions the current detector finds across the archive, **11 contain no GPS fix at all** — and of the 51 `charger_enabled` rising edges, most are handshakes lasting seconds, which is why sessions are built from current rather than from that flag.

A charge stop is therefore drawn at the **last fix from before the bike was plugged in**, and that fix's age ranges from seconds to over a week (the worst in the archive is 14 122 minutes — nearly ten days). Two sessions have no prior fix at all, because GPS logging started later that same evening; they are listed in the table but cannot be drawn.

`Fix age (min)` is carried as a field and drives the marker colour — green under 30 minutes, amber past that, red past six hours — so a stale position is visible as stale rather than drawn as a confident pin. This is the same argument `public/lib/bounds.js` makes for readings: a value that cannot be trusted is shown as a fault, never quietly rendered as something plausible. (That file gates no coordinate — `gps_lat` and `gps_lon` have no entry in it — so the principle is borrowed, not the mechanism. Nothing upstream of this dashboard filters a position.)

### The inherited fix has to be one nothing contradicts

The lookup takes the newest row at or before plug-in, and **that is the one row a despiker can never see**: a lone excursion is only ever visible from its neighbours, and `r.ts <= sess.start_ts` forbids looking at the one that comes after. A corrupt final fix therefore sat there as the newest row for the whole session, and because all three layers share one `options.view` of `fit` with `allLayers: true`, one pin on another continent reframed the whole map — verbatim the failure [Despiking by shape](#despiking-by-shape-not-by-speed-and-not-by-coordinate-range) exists to prevent (#173).

So each of the three GPS sub-selects carries a clause refusing a row that a same-axis row **within ±2 s of it, in the same run**, disagrees with by more than 0.002°. `ORDER BY r.ts DESC LIMIT 1` then walks back to the newest row nothing contradicts. No window functions, no per-second pivot, no `clean` CTE duplicated into four targets.

**The two constants:**

- **±2 000 ms** — 3.03× the measured maximum lifetime of an excursion (661 ms; `docs/waypoints.md` §"The first fix of a run" has the derivation), and short enough that the bike cannot cross the threshold **in latitude** inside it: 300 km/h for 2 s is 167 m against 222.6 m. ⚠️ Not a guarantee in longitude — the next bullet has the threshold as tight as 118 m there.
- **0.002°** — 222 m in latitude, and 118–182 m in longitude across the 35–58°N this archive spans. Above the 220 m floor the track's despiker already derives; below the smallest measured excursion, 227 m. ⚠️ The longitude figure is the tight end, and a genuinely fast pair with a 2 s row gap would be called contradicted and step back a row — **up to ~180 m**, not the ~40 m an earlier draft claimed. That is affordable _here_ and would not be in `src/gps/waypoint.ts`: a false positive costs metres of pin on a position whose staleness is already reported in minutes, not a place the rider loses.

**Both directions are load-bearing.** Forward catches an excursion whose correction is logged; backward catches one the receiver never corrected because it fell silent — which is the mechanism the issue describes. A refinement of "backward **AND** (forward **OR** no successor)" was tried and refuted by the archive: it catches **5 of 13** independent ≥1 000 km excursions and **moves a charge pin by 271 km**, because an excursion after a > 2 s gap has no backward witness and one before silence has no forward witness. The `OR` across the two arms is what makes it work.

⚠️ **`IS`, never `=`, on the session** — and the failure direction is the point. The predicate sits inside `NOT EXISTS`, so an unknown comparison selects nothing, `NOT EXISTS` is satisfied, and the row is **never marked**. `=` does not over-reject the 110 654 GPS rows that carry no session; it **switches the gate off** over them, silently, with nothing in the query plan to say so. Measured: 57 `gps_lat` and 57 `gps_lon` rows marked in that block under `IS`, **0 and 0** under `=` — and the 2026-08-09 corrupt longitude, the row this exists for, is contradicted under `IS` and not under `=`.

And the session predicate is needed at all because `ts` is wall clock the Pi steps: without it, rows from two runs written days and hundreds of km apart contradict each other, and **26 `gps_lat` and 29 `gps_lon` real fixes** are rejected across the archive.

**What it costs, measured over the whole archive:**

|                                             |                                            |
| ------------------------------------------- | ------------------------------------------ |
| independent ≥ 1 000 km excursions caught    | 13 of 13                                   |
| all shape-test excursions caught            | 65 of 65                                   |
| `gps_lat` / `gps_lon` rows marked           | 189 (0.099 %) / 237 (0.116 %)              |
| charge sessions whose inherited row changes | **1 of 29**                                |
| that pin's move                             | 0.9 m, and its `Fix age` 13.9 → 14.4 min   |
| target G over the whole archive             | 0.30 s, against the shipped query's 0.30 s |

The one row that changes is not a save: it falls back from the **correction row** immediately after a 2.442° latitude excursion to the row before that excursion. Near a known excursion the lookup steps to a row with nothing anomalous inside its own window, which is the "up to two rows back" cost.

⚠️ `lat` and `lon` are resolved by **independent** sub-selects, so a gated axis can step back while the other does not, and `fix_ts` follows `lat` only. That was already true; the clause makes it visible.

**The residual, stated:** an excursion that is _both_ the first fix after a gap longer than 2 s _and_ the last before silence has no witness on either side. It is the same shape as the first-fix hole in `docs/waypoints.md`, and it is not closable from one row.

### ⚠️ The skew that was measured and not taken

The obvious fix — take the last fix at least ~5 s before `start_ts`, the way #167's waypoint gate skews its witness — **does not reduce the hazard**, and the measurement is worth keeping so it is not proposed again.

The newest row before _any_ fixed cutoff is an excursion exactly when the cutoff falls in the band between an excursion and its correction. Moving the cutoff 5 s earlier does not remove that band, it moves it — and the correction that would have exposed the excursion is then _also_ after the cutoff, and _also_ excluded. Three measurements say the same thing:

- **20 of the 27 placeable sessions inherit a row already older than 5 s** (10 s to 847 337 s — nearly ten days), so a 5 s shift reaches nothing at all for two thirds of the archive. Only 7 sessions have a last fix inside 5 s.
- For those 7 it costs **1.9, 19.8, 21.5, 32.5, 36.6, 88.6 and 156.3 m** of pin position, for no change in exposure.
- The premise that plug-in is a special moment is not supported: excursions within ±120 s of the 29 session starts, **0 observed against 1.400 expected**; at ±600 s, 3 against 6.999. ⚠️ That test refutes nothing on its own — P(0 | 1.4) = 0.247 — **and it is the wrong test**: it measures _clustering_, while the issue argued _persistence_, that an excursion near plug-in is more likely to have no successor and so stay the newest row. The clause above makes that moot rather than untested, because it does not depend on a successor existing.

The defect was never where the cutoff sits. It was that the query only ever looked backwards, while the hub keeps logging past plug-in: in all seven sessions whose last fix is within 1.2 s of `start_ts`, there is another fix **0.1–2.6 s after** it.

## Charge sessions are built from evidence that current flowed

Not from `charger_enabled`. That flag is log-on-change and **stays at 1 for days after the bike sleeps mid-session**: it merged a 2026-08-04 charge and a 2026-08-07 charge into a single three-day "session", with nothing in between but an unchanged flag. Sessions are instead runs of rows where a charging current is actually non-zero, merged across breaks under 30 minutes and kept past 5 minutes.

### `fast_dc_target_a` is the DC current — `dc_a` is not

🚨 **The single most consequential thing on this page.** A DC session sends no `0x305`/`0x306` at all, so `fast_dc_target_a` is the only DC-side current on the bus (see `docs/charge-manager.md`). `dc_a` is **not** that signal — it is present through AC charging too, reaching 6.7 A on a day whose DC legs pulled 73 A.

Detecting on `mains_a`/`dc_a` alone found **2 stops and 500 Wh** across a 498 km touring day, silently missing every fast charge that made the day possible. With `fast_dc_target_a` in the evidence set the same day reads:

| started (UTC) | min | type | kWh   | SOC     |
| ------------- | --- | ---- | ----- | ------- |
| 10:59         | 64  | AC   | 0.34  | 97 → 99 |
| 16:06         | 52  | DC   | 9.06  | 32 → 85 |
| 18:28         | 68  | DC   | 11.64 | 21 → 91 |
| 22:50         | 21  | DC   | 6.34  | 27 → 66 |
| 00:08         | 16  | AC   | 0.16  | 18 → 19 |

The AC/DC verdict rests on `fast_dc_target_a` for the same reason. `charge_type` (`1` = AC, `2` = DC) agrees where it exists but is far too sparse to key on — **23 rows in the entire archive, 4 of them on the ride day** — and it needs seeding from before the window opens, since the value in force at a ride's start was typically last written days earlier.

Energy is the pack's own `residual_energy_wh` at the end of a session minus its value at the start, each carried forward from before its bound rather than read inside it.

## No coordinates anywhere

Not in the dashboard JSON, not in the SQL, not in this file. Three places wanted one:

- the map's initial view — solved by `fit` (plus the `view.zoom` cap above) rather than a saved centre/zoom, so the panel derives its own view from whatever data is in the window;
- the despiker — solved by the shape test above rather than a `BETWEEN` on latitude/longitude;
- the "Distance" tile — reads the bike's own `odometer_can_km` delta, which is exact, needs no `SQRT`, and says nothing about where.

**The waypoint gate does put a `BETWEEN` on latitude and longitude, and it is not an exception to this.** `±90` and `±180` are the planet, not a region: they say a coordinate is a coordinate, and they would read identically in a repository belonging to a bike on another continent. The part of that gate which actually catches a wrong position is a _comparison against the fixes either side of it_ — a difference, never a place. See [Waypoints](#waypoints-are-gated-against-the-track-not-against-a-box) below and `docs/waypoints.md`.

## Waypoints are gated against the track, not against a box

A waypoint (`waypoint_seq`, `waypoint_lat`, `waypoint_lon`) is a copy of the live GPS fix, taken when the rider asks — from the handlebar, the phone's button or Siri. The map draws the corroborated ones as stars and the table below it lists every one in the window with a verdict, including the ones the map refuses.

The gate, and the two constants behind it, are derived in `docs/waypoints.md`. The one thing worth repeating here, because it is the same mistake this file's despiker section warns about from the other direction: **the fix logged immediately before a waypoint is the fix the waypoint copied**, so comparing the two proves nothing. `gps_lat`/`gps_lon` carry a 3 m deadband and a waypoint copies liveState, so the two are equal by construction — on 2026-08-09 the previous `gps_lon` row is byte-identical to the waypoint 148 ms later, and _that row was the corrupt one_. The witness has to be at least five seconds away before it is evidence at all.

Two things the waypoint query does differently from the track query above, both for reasons that do not apply to the track:

- it is driven by `waypoint_seq` and resolves each coordinate as "the last value logged at or before this timestamp", rather than pivoting the three signals on their shared `ts`. They do share one — `record()` stamps all three with a single `now` — but `waypoint_lat`/`waypoint_lon` carry no deadband, so a second save from the same live fix logs _only_ the sequence, and a pivot would hand the map a `NULL` position and the table an accusation. The carried value is exact rather than approximate: suppression happens only when the two values are equal.
- its despiking is a fixed 0.5°, not the track's scale-free ratio. The witness set only has to be free of excursions big enough to matter at the threshold it is compared against; the track's job is to catch _all_ of them, which is why it cannot use a fixed distance.

## A charge stop ends a ride

The Rides table splits on charging, not only on GPS gaps. Before that rule the evening of 2026-09-07 read as **one 281-minute, 217 km ride** — with a 21-minute DC stop sitting inside it and its duration counted as riding time. It is really two rides:

|                    | minutes | km    |
| ------------------ | ------- | ----- |
| before the DC stop | 193     | 132.8 |
| after it           | 56      | 83.9  |

Distance is conserved (132.8 + 83.9 ≈ 217); what disappears is the half hour the bike spent plugged in and stationary.

Two things enforce it. Fixes logged **while plugged in are dropped outright** — a stationary hour at a charger is not riding, and on the sessions where the hub does stay awake it would otherwise open the next ride with a long motionless prefix. And a session **starting between two surviving fixes forces a break**, which is what catches short stops: a 21-minute charge leaves no 30-minute hole for the gap rule to find.

## What the tiles count, and what the map can draw

The "Charge stops" and "Energy charged" tiles count **every** session, including the ones with no known position. The map necessarily draws only those it can place. Those two numbers therefore differ — 20 against 18 pins over the default range — and the tiles are the honest answer to "how much did it charge", so they are the ones that count everything.

An earlier version built the tiles by wrapping the _map_ query, which inherited its `lat IS NOT NULL` filter. The tiles then silently under-reported by exactly the sessions the panel description calls out as unplaceable — a tile labelled "Charge stops" reporting mappable charge stops, with nothing to say so.

## Known limitations

- **Rides are runs of GPS fixes**, not of motion, so a stretch with no reception splits one ride in two. `km` comes from the odometer rather than from the fixes, so the distance stays right even where the track does not.
- Sessions shorter than 5 minutes, and charging under 0.5 A, are not counted as stops — and a ride that straddles one of those is not split by it.
- **`Type` is three-valued.** `fast_dc_target_a` does not exist before 2026-08-26, so a session older than that cannot be shown to be DC. It reads `AC` only where mains current positively says so and `?` otherwise; it is never inferred from the absence of the DC signal.
- **The Charging dashboard is built on the AC charger's frames**, which a DC session does not send, so most of its panels come back empty for a DC stop. The `Started` cell therefore offers two links — Charging for AC, Charge manager for DC — rather than guessing.
- Rides are split by _detected_ charge sessions, so the same 5-minute floor applies: a shorter stop will not split a ride.
- **`gps_speed_kmh` is gated to `public/lib/bounds.js`'s declared 0…300 range**, which is the right gate: this bike's top speed is 270 km/h, so a "Top km/h" of 256 is a real reading and not an artefact. (An earlier draft of this document called that value implausible and proposed tightening the bound. It was wrong about the bike.)
- The 49 772 readings stamped 2060 (a corrupt GPS frame stepped the Pi's clock; see the Clock section of `README.md`) are excluded by an explicit `ts < 2000000000000` guard in every query, **and** by the dashboard defaulting to a relative `now-90d → now` range: `now` is before 2060, so those rows sort after the window and fall out on their own. A hardcoded absolute range would work today and go stale; the relative one stays correct as new rides land.
