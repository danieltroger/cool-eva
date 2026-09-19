# Ride map — a laptop-side viewer for `rides.db`

Provenance for #296. The plan is the issue; this is where its numbers come from, kept here because `CLAUDE.md` §"Findings belong in documents" says an issue body is not the place for forty lines of measurement. Related: `docs/route-map.md` (the Grafana dashboard this replaces), `grafana/README.md` (the datasource's own traps).

Everything below was measured on 2026-09-19 between 20:15 and 22:00 CEST against `rides.db` at **4 023 939 072 B, 68 040 175 readings, 249 151 `route_track` points**, `info.route_track_built_at` = `2026-09-19T16:15:04.651Z`. ⚠️ `rides.db` is shared mutable state across herd tracks — another track re-imported it at 18:15 that evening, so a figure taken before then describes a different corpus. No coordinates appear in this file, for the reason `docs/route-map.md` §"No coordinates anywhere" gives.

## ⚠️ Every timing on this file swings by more than an order of magnitude with page-cache state

This is the first thing to know, because two separate conclusions in #296 were built on the cold end of a range quoted as a constant and both were wrong.

|                   | `MAX(value)` over `gps_speed_kmh`'s 294 305 rows | same query, `COUNT(*)` |
| ----------------- | ------------------------------------------------ | ---------------------- |
| 20:20             | **12 900 ms**                                    | 50 ms                  |
| ~20:45 (reviewer) | 8 100 ms                                         | —                      |
| 21:05, three runs | **280 / 340 / 280 ms**                           | 6.5 ms                 |

Same machine, same file, same answer (`385.0`) throughout. A 46× spread across one evening with no pressure eviction and ~74 % memory free.

**What this cost.** Revision 1 of the plan divided 12.9 s by 294 305 rows, called the result a 43.8 µs-per-lookup constant, and used it to predict panel times — getting 2.09 s against 2 410 ms observed for the Distance tile, which looked like confirmation and was two readings at the same cache state. Revision 3 then built a startup-snapshot design on the _warm_ end (3.4 s) and was refuted the same way in the other direction (16–22 s when actually run). **Quote the cache state with every number, or do not quote the number.** `docs/route-map.md` carries the same hazard: its "warm page cache" tables were taken on a laptop that had just been hammering the file, and it says so.

## What does not move: scatter, not lookup count

The swing is not spread evenly across the dashboard. Between a cold and a warm state, `H` (Rides) moves 1 547 → 12 126 ms and `C` (Distance) 52 → 1 707 ms, while `B`, `D` and `E` — which each read `value` on 390 525 charge-current rows — barely move at all. So the number of value lookups was never the unit that predicts cost.

The unit is **how many distinct table pages those rows live on**. `reading` holds 68 040 175 rows in 640 615 pages of 4 KB — 106.2 rows a page — and `idx_reading_sig_ts` is `(signal_id, ts)`, so reading `value` means a lookup into the table proper. Bucketing each signal's rowids by 106 approximates the pages it touches:

| signal             | rows    | ≈ pages touched | rows per page |
| ------------------ | ------- | --------------- | ------------- |
| `odometer_can_km`  | 47 630  | 47 619          | **1.00**      |
| `gps_lat`          | 340 448 | 324 283         | 1.05          |
| `gps_speed_kmh`    | 294 305 | 276 013         | 1.07          |
| `dc_a`             | 133 643 | 25 478          | 5.25          |
| `fast_dc_target_a` | 7 258   | 1 299           | 5.59          |
| `mains_a`          | 249 624 | 32 349          | **7.72**      |

A signal logged sparsely across the whole archive — the odometer, at one row per page — pays a page fault per row. A signal logged in dense bursts while the bike charges shares 5–8 rows a page. So `H` touches ~320 000 scattered pages (≈ 1.3 GB of a 2.6 GB table) and swings hugely with cache state; the three charge panels touch ~59 000 between them and do not.

⚠️ The `rowid / 106` bucketing is an approximation — SQLite does not expose a row's page in SQL — and it assumes rows are stored in rowid order with uniform density. It is good enough to separate 1.00 from 7.72; it is not good enough to cost a query with.

## Where the time actually goes, and it is not SQL

Warm, all ten of `grafana/dashboards/route-map.json`'s targets run in **3 436 ms** total through `better-sqlite3` (three runs, median; `H` 1 585 ms, `B` 389, `G` 474, `D` 352, `E` 337, `A` 114, `F` 122, `C` 53, `I` 4, `J` 6). Run as six concurrent processes with their own database handles, the six above-the-fold targets finish in **641 ms** wall.

The same dashboard in Grafana 11.3.0, same cache state, measures **~22 s of request time** and **4.4–6.6 s** to a painted map warm, **12.3 s** on a cache-bypassing reload. A one-row answer off 52 ms of SQL takes 937 ms; 210 rows off 3 ms of SQL take 85 ms.

**So roughly 85 % of what the rider waits for is the `frser-sqlite-datasource` plugin and Grafana's own pipeline, and no index or query rewrite touches it.** That is the case for a viewer, and it is a different case from the one #296 opened with.

Method for the painted-map figure, reproducing `docs/route-map.md` §"What it is worth in the browser": an `initScript` installed before any page script samples the geomap canvas every frame into a 48×48 offscreen context and records a hash plus a non-transparent pixel count; the reported time is the first frame after the last `/api/ds/query` resource entry ends at which the canvas is non-blank and stable. `performance.getEntriesByType("resource")` supplies the query timings — hooking `window.fetch` does not work, Grafana replaces it.

## The covering index: measured, and not the fix

`idx_reading_sig_ts` is `(signal_id, ts)`, so every `value` read is a table lookup. Cold that is expensive and warm it is not, per the table above. A probe database holding only `gps_speed_kmh` and `odometer_can_km` rows, indexed `(signal_id, ts, value)`, returns the identical answers (`385.0` and `4739.4`) in **0.01–0.02 s** with `SEARCH … USING COVERING INDEX` — warm, on a 13 MB probe, which is not comparable to the 12.9 s cold figure three lines up and is quoted only to show the plan changes.

Cost, measured two ways:

|  | bytes/row, `(signal_id, ts)` | bytes/row, `(signal_id, ts, value)` | delta |
| --- | --- | --- | --- |
| two-signal extract, 341 935 rows | 17.23 | 20.10 | +2.9 (+17 %) |
| **1-in-997 proportional sample of `reading`, 68 244 rows** | **17.35** | **24.37** | **+7.02 (+40.5 %)** |

The first is wrong and worth recording as wrong: `gps_speed_kmh` and `odometer_can_km` are almost entirely integer-valued, which SQLite stores as small varints, while only **31.3 %** of `value`s across the whole table are. Scaled against the real index's measured 20.4 B/row, the honest figure is **≈ +480–565 MB** on a 4.0 GB file.

**Not done, and deliberately.** Daniel approved it on the premise that it would fix a 13–21 s Rides table; that premise was the cold-cache artefact above. What it would really buy is a _bounded_ cold path — the property that makes a first load predictable — and that is worth revisiting only with a cache-state-controlled measurement. Two traps for whoever does: `CREATE INDEX IF NOT EXISTS` will **not** widen an existing index, and the DDL sits at four sites (`src/db.ts:83`, `scripts/check-import-ride-log.ts:316`, `scripts/check-route-map-sql.ts:124`, `scripts/check-route-track.ts:282`).

## MapLibre GL JS 6.10.0, benchmarked

A scratch page with a synthetic random walk, MapLibre vendored from jsdelivr, a blank style with no basemap so nothing is waiting on tiles, rendered in the isolated Chrome on an M5 Max.

| features | first paint (`addSource` → `idle`) |
| --- | --- |
| 249 151 circles — today's whole track | **1 411 ms** |
| same, 6× CPU throttle | 3 539 ms |
| 12 000 circles — the Grafana dashboard's own budget, 6× throttle | 303 ms |
| 500 000 circles | 2 439 ms |
| 249 151 points as 125 uniform-colour `LineString`s | 182 ms |
| 1 000 000 circles | did not complete; page stopped answering CDP for > 2 min, twice |

The canvas was screenshotted and holds real pixels — the ~68 000-feature blackout `docs/route-map.md` §Thinning measures in Grafana's geomap does not appear.

⚠️ **The frame-time column that used to be here is deleted.** It measured `requestAnimationFrame`-to-`requestAnimationFrame` cadence, which is pinned to the 120 Hz display: a 200-point control measured the same 8.3 ms median as 500 000 points, and so did a bare rAF loop drawing nothing. What the harness can honestly report is **no dropped frames**, not a frame rate. Measuring render cost needs `performance.measure` around the draw or a trace, and has not been done.

### Growth, which sets the deadline

`route_track` spans 47.7 days at **5 218 points/day** lifetime and **7 059/day over the last 30**. From 249 151 points, 500 000 is **36–48 days** away and 1 000 000 is **106–144**.

### Speed colouring a split line is not solved by the 182 ms row

That benchmark drew one colour. From `@maplibre/maplibre-gl-style-spec` 26.4.4, which `maplibre-gl` 6.10.0 depends on (`^26.4.4`), `src/reference/v8.json`:

- `line-color` — `"property-type": "data-driven"`, `"parameters": ["zoom", "feature", "feature-state"]`, `sdk-support` js since 0.23.0. **One colour per feature.**
- `line-gradient` — `"property-type": "color-ramp"`, `"parameters": ["line-progress"]`, `requires` a `geojson` source with `lineMetrics: true`, and its `sdk-support."data-driven styling"` is `{}`.

⚠️ That empty `sdk-support` entry does **not** mean no SDK implements `line-gradient`; it means the property is not _data-driven_, which is a consequence of being a `color-ramp` over `line-progress` rather than a cause. The property works. The reason it cannot colour a track by speed is that the ramp is a per-**layer** function of distance along the line and cannot read feature properties.

So the two candidate designs are **speed-banded segments carrying per-feature `line-color`** (one layer, one feature per run of a speed band) or **one gradient layer per ride**. Neither is measured.

## Payloads

The whole track, 249 151 rows, out of SQLite with `.raw()`: **21–64 ms** warm (111 / 35 / 42 ms in a colder run). Opening the 4.0 GB file read-only: **2–6 ms**.

| encoding | bytes | server cost |
| --- | --- | --- |
| GeoJSON `FeatureCollection`, string | 34.7 MB | 138–178 ms to `JSON.stringify` |
| … gzip -6 | 3.30 MB | + 195–242 ms over six runs |
| … brotli q5 | 3.42 MB | + 219–350 ms |
| delta int32 µdegrees + int32 second-deltas + uint8 speed, **column-major**, gzip -6 | **0.81 MB** | 85 ms total |
| the same **row-major** (interleaved), gzip | 1.06 MB | — |

Over loopback none of that is worth doing: 35 MB `curl`s in **7.7 ms** and the browser fetches it in 81 ms and parses it in 64 ms, against **195–242 ms** merely to gzip it server-side. Handing MapLibre `data: <URL>` rather than `data: <object>` measured 1 053 vs 1 115 ms — a wash on time, but the URL form does the fetch and parse off the main thread. **Ship plain uncompressed GeoJSON.** The codec is recorded here because it is the right answer if this ever leaves loopback, not because it should be built.

## The startup snapshot, and why it is persisted

The viewer serves the non-track panels from a snapshot built by running the dashboard's existing queries once, rather than from new materialised tables in `rides.db`. Two measurements shaped that:

- Building it in memory at startup: **22 289 ms**, then **16 381 ms** immediately after — not the 3 436 ms a warm serial run suggests.
- The snapshot is **72 136 B** and reads back from a file in **0.19–0.40 ms**.

So it is persisted beside the database as `rides.db.mapcache`, keyed on the database's mtime and size **and a hash of the query text that produced it**, and rebuilt when any of those change. Four things this has to get right, each of which fails silently otherwise:

- **The queries run unbounded, and the window is applied in the browser.** The dashboard's SQL takes `$__from`/`$__to`. Build the snapshot for `now-90d`, cache it against a database that then does not change, and every later start serves a frozen window — invisible, because the map still shows ninety days of _something_, and doubly so while the archive is only 47.7 days long. Running unbounded and slicing client-side is also the more correct reading of `docs/route-map.md` §"Charge sessions need slack at the window edges too".
- **The query text is part of the key.** Phase 1 edits that SQL daily; keyed on the database alone, a stale cache survives every edit of it.
- **Write to a temporary file and `rename`**, so a truncated file or a second viewer process cannot be read as a complete one.
- ⚠️ **The extensionless name is load-bearing.** Measured: `prettier --write .` leaves `rides.db.mapcache` alone and **rewrites** `rides.db.mapcache.json`. `.gitignore:205` covers both — `git check-ignore -v rides.db.mapcache` returns that line — so no gitignore change is needed and none should be added.

⚠️ So the viewer does not write _into_ `rides.db`, but it does write **one gitignored sibling beside it**. Opened `readonly` against a `journal_mode=delete` file it creates no `-wal`/`-shm`, and it cannot collide with an import: `scripts/ride-import.ts` scans only `-wal`/`-shm`/`-journal` siblings (`SIBLING_SUFFIXES`, `:241`) and the `.import-` and `.bak-` prefixes (`:257`, `:350`).

⚠️ **Reopen the database, do not just re-query it.** `scripts/ride-import.ts:154` renames the replaced database aside rather than unlinking it, so a process holding an open handle keeps reading the old file forever, with nothing to say so.

## Basemap

**OpenFreeMap's public instance.** From openfreemap.org: no API key, no registration, no request limits stated, commercial use allowed, attribution required and "if you are using MapLibre, they are automatically added". From its TileJSON at `tiles.openfreemap.org/planet`: `minzoom 0`, `maxzoom 14`. Past z14 the basemap overzooms; the track does not, being a client-side source rather than a tiled one.

**Not `tile.openstreetmap.org`**, which `grafana/dashboards/route-map.json` uses today via the `osm-standard` basemap. Its usage policy forbids bulk download and prefetch outright and offers no SLA. ⚠️ An earlier draft also claimed it "requires a `User-Agent` a browser cannot set"; the policy refutes that in its own words — "Browsers will use the browser's default User-Agent" and "Modern browsers, with default settings, already satisfy these technical requirements." The prefetch prohibition is the part that actually rules it out for offline.

**Offline** is a Protomaps PMTiles regional extract: the v4 planet basemap is ~120 GB at z0–15, and `pmtiles extract` cuts a region, with `--maxzoom` to trim further. ⚠️ `pmtiles extract` takes a bounding box, **which is a place** — that command is a local step and must never be committed, for the same reason `.gitignore` keeps rendered route PNGs out of this repo.

## Versions, read from the npm registry on 2026-09-19

| package | version | peers that matter |
| --- | --- | --- |
| `svelte` | 5.57.1 |  |
| `@sveltejs/kit` | 2.70.3 | `vite ^5.0.3 \|\| ^6 \|\| ^7 \|\| ^8`, `svelte ^4 \|\| ^5`, `typescript ^5.3.3 \|\| ^6` |
| `@sveltejs/vite-plugin-svelte` | 7.3.0 | `vite ^8`, `svelte ^5.46.4`; engines node `^20.19 \|\| ^22.12 \|\| >=24` |
| `vite` | 8.3.0 |  |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.3 | `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8` |
| `shadcn-svelte` | 1.7.0 | `svelte ^5.0.0` |
| `bits-ui` | 2.19.2 | `svelte ^5.33.0`, `@internationalized/date ^3.8.1` |
| `maplibre-gl` | 6.10.0 | depends on `@maplibre/maplibre-gl-style-spec ^26.4.4` |

shadcn-svelte's Tailwind v4 support landed in May 2025 (`docs/content/changelog/2025-05-tailwind-v4.md` in `huntabyte/shadcn-svelte`); its SvelteKit install page is `sv create … --add tailwindcss` then `shadcn-svelte@latest init`.

`maplibre-gl` 6.10.0 is **1 098 292 B** minified across two chunks, **295 446 B gzipped**, plus 83 195 B of CSS.

### ⚠️ Three MapLibre v6 traps, each of which cost time here

1. **ESM only, and no default export.** `dist/maplibre-gl.mjs` exports `Map` by name; `import maplibregl from "maplibre-gl"` throws `does not provide an export named 'default'`.
2. **The worker is a separate asset.** The bundle fetches `./maplibre-gl-worker.mjs` beside itself. When that 404s, the browser logs a bare resource error and **MapLibre says nothing at all** — no console message of its own, no `error` event, no map, indefinitely. ⚠️ The fix is **PR #8454** ("Report worker script load failures"), merged `2026-09-15T21:04:49Z`; 6.10.0 was published `2026-09-15T20:31:00.778Z`, **34 minutes earlier**, so it is not in this release. An earlier draft cited **#8018** as the fix — that is the _issue_ ("Map hangs silently when the worker script fails to load…"), not the change, and citing a bug report as its own fix is the `docs/can-capture.md` failure this repo names. A bundler handles the asset; copying `dist/` by hand does not.
3. `maplibre-gl.mjs` and `maplibre-gl-worker.mjs` both import `./maplibre-gl-shared.mjs`, so all three must be served.

## Still unverified, and what each would cost

- **`better-sqlite3` inside a SvelteKit server route.** It is a native module, so Vite must externalise it for SSR (`ssr.external`) rather than try to bundle it. ⚠️ This is the one open item that can **invalidate** the data path rather than merely slow it, and the materialised tables that could have sidestepped it are deleted — so it is the first thing phase 1 proves, before anything is built on top of it.
- **Speed-banding a split `MultiLineString`**, either as per-feature `line-color` runs or one gradient layer per ride. Benched before it is built.
- **The 1 000 000-feature ceiling** is an observed hang, not a measured limit.
- **`map/node_modules` size**, unmeasured because scaffolding was out of scope while this was a plan.
- **Neither existing gate covers this viewer.** `scripts/check-route-map-sql.ts:117` builds its fixture with `new Database(":memory:")`, so it cannot back a screenshot; a file-backed synthetic fixture is phase-1 work. And `scripts/check-phone-width.ts:7` imports `TABS` from `public/lib/router.js`, so it measures the Pi dashboard's tabs and not `map/` — the viewer needs its own width gate.
