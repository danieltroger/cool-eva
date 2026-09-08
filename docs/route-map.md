# Route & charging map

`grafana/dashboards/route-map.json` — where the bike went, and where it charged, from the decrypted ride log. Related: `grafana/README.md` (the datasource's own traps), `docs/charge-manager.md` (what the charge signals mean), `docs/dashboard-decisions.md`.

Everything below was measured against the 2026-09-07 decrypt (15 477 057 readings, 2026-08-02 → 2026-09-07). No coordinates appear in this file or in the dashboard JSON, and that is deliberate — see [No coordinates anywhere](#no-coordinates-anywhere).

## Reconstructing a track from two independent signals

`gps_lat` and `gps_lon` are **separate log-on-change signals with independent deadbands**. They share a millisecond whenever the decoder completes a fix and both moved — but a heading that only moves one of them logs only that one. Over the archive:

|                            | rows   |
| -------------------------- | ------ |
| `gps_lat`                  | 53 872 |
| `gps_lon`                  | 55 191 |
| sharing an exact timestamp | 45 130 |

So an inner join on equal `ts` silently drops **~16 % of the track**. Each signal is carried forward onto the other's timestamps instead. SQLite has no `IGNORE NULLS`, so the carry-forward is expressed as "the timestamp of the last non-null", joined back to the row holding it.

The window reaches 10 minutes below `$__from` to seed that hold, for the reason `grafana/README.md` gives under _"Carry-forward joins need seeding from before `$__from`"_: a window opening mid-ride otherwise starts with a latitude and no longitude and draws nothing.

### One point per second, and why it matters more than it sounds

The per-millisecond pivot emits a row at **each signal's own timestamp**, so a latitude row and a longitude row 1 ms apart become two points a few metres apart — a staircase.

That staircase is not a cosmetic problem. It destroys any speed-based outlier test: 7 m in 1 ms reads as 25 000 km/h. A first attempt at despiking on implied speed rejected **2 561 of 113 798 steps** as impossible, essentially all of which were this artefact and not bad data. Collapsing to the last exact sample of each second removes it, and drops the archive to 65 482 points.

## Despiking by shape, not by speed and not by coordinate range

The decoder occasionally produces a longitude carrying an **extra leading digit**, landing it roughly 100° away from the fixes one second either side of it. Two of these survive the archive. (The values themselves are not reproduced here, for the same reason the dashboard carries no coordinates.)

**A coordinate range gate would catch them and is the wrong tool three times over.** Such a value is a perfectly valid longitude, so the test is really a geography test; a `BETWEEN` in a committed dashboard tells anyone reading the repo which part of the world this bike is ridden in; and — the strongest of the three — **not every corrupt fix leaves the plausible box.** The archive contains single fixes that jump 0.3 km, 1.4 km, 4.8 km and 420 km out and straight back, all of them well inside any latitude/longitude bounds you would think to write. A range gate cannot see those at all.

A spike is defined by **shape** instead: the point sits far from both neighbours _while the neighbours agree with each other_. That third clause is what makes the test safe with no assumption about speed or sampling rate — when the bike is genuinely carried somewhere between two fixes (a trailer, a ferry, an overnight gap), the point after the gap is also far from the point before it, the neighbours **disagree**, and the real position is kept. Only a lone excursion away from a track that continues undisturbed is thrown out.

The comparison is **scale-free** — "sticks out by more than 5× what the neighbours are apart" — rather than a tuned distance, because any fixed threshold is simultaneously too tight for a parked bike and too loose for a moving one.

It carries one absolute floor, and that floor is not a redundant belt. The ratio **degenerates exactly where the neighbours converge**, which is every second the bike sits still with the hub awake: `d(prev, next)` approaches zero, and ordinary GPS jitter then satisfies any ratio you pick. Measured over the archive's 65 481 points:

| rule                               | points rejected |
| ---------------------------------- | --------------- |
| ratio alone (5×)                   | 280             |
| ratio + 220 m floor                | **17**          |
| earlier absolute-only rule (11 km) | 11              |

The 263 the floor saves are parked jitter, not data. The 17 it keeps are a strict superset of what the old absolute rule caught, and the 6 it adds are unambiguous: every one is an out-and-back whose outbound and return legs agree to within metres while the neighbours sit metres apart — the smallest being 284 m out and 280 m back in 1.6 s, or 640 km/h. 220 m is far above GPS jitter and far below any real excursion.

Distances stay **squared and in degrees**: no `SQRT`, no `POW`, no trig, so nothing depends on the datasource's SQLite being built with `SQLITE_ENABLE_MATH_FUNCTIONS`.

> ⚠️ An earlier version gated on the time step instead — skip the test when `dt > 120 s`, on the grounds that a long gap can legitimately move a long way. That let exactly **two** corrupt fixes through, both in stretches where reception was sparse enough that the neighbouring steps exceeded the gate. Two points out of 67 851 were enough to stretch the map's auto-fit to the whole globe. **A despiker on map data is not judged by the fraction it catches but by whether any survive.**

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

**This bike logs almost no GPS while charging.** The Connectivity Hub sleeps, so across 37 `charger_enabled` rising edges, **33 had zero GPS fixes inside the session**.

A charge stop is therefore drawn at the **last fix from before the bike was plugged in**, and that fix's age ranges from seconds to over a week (the worst in the archive is 14 122 minutes — nearly ten days). Two sessions have no prior fix at all, because GPS logging started later that same evening.

`Fix age (min)` is carried as a field and drives the marker colour — green under 30 minutes, amber past that, red past six hours — so a stale position is visible as stale rather than drawn as a confident pin. This is the same argument `public/lib/bounds.js` makes for readings: a value that cannot be trusted is shown as a fault, never quietly rendered as something plausible.

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

## A charge stop ends a ride

The Rides table splits on charging, not only on GPS gaps. Before that rule the evening of 2026-09-07 read as **one 281-minute, 217 km ride** — with a 21-minute DC stop sitting inside it and its duration counted as riding time. It is really two rides:

|                    | minutes | km    |
| ------------------ | ------- | ----- |
| before the DC stop | 193     | 132.8 |
| after it           | 56      | 83.9  |

Distance is conserved (132.8 + 83.9 ≈ 217); what disappears is the half hour the bike spent plugged in and stationary.

Two things enforce it. Fixes logged **while plugged in are dropped outright** — a stationary hour at a charger is not riding, and on the sessions where the hub does stay awake it would otherwise open the next ride with a long motionless prefix. And a session **starting between two surviving fixes forces a break**, which is what catches short stops: a 21-minute charge leaves no 30-minute hole for the gap rule to find.

## Known limitations

- **Rides are runs of GPS fixes**, not of motion, so a stretch with no reception splits one ride in two. `km` comes from the odometer rather than from the fixes, so the distance stays right even where the track does not.
- Sessions shorter than 5 minutes, and charging under 0.5 A, are not counted as stops — and a ride that straddles one of those is not split by it.
- **`gps_speed_kmh` is gated to `public/lib/bounds.js`'s declared 0…300 range**, which is the right gate: this bike's top speed is 270 km/h, so a "Top km/h" of 256 is a real reading and not an artefact. (An earlier draft of this document called that value implausible and proposed tightening the bound. It was wrong about the bike.)
- The 49 772 readings stamped 2060 (a corrupt GPS frame stepped the Pi's clock; see the Clock section of `README.md`) are excluded by an explicit `ts < 2000000000000` guard in every query, **and** by the dashboard defaulting to a relative `now-90d → now` range: `now` is before 2060, so those rows sort after the window and fall out on their own. A hardcoded absolute range would work today and go stale; the relative one stays correct as new rides land.
