# Grafana dashboards

Provisioned from `grafana/dashboards/*.json` against the `frser-sqlite-datasource` plugin (uid `cool-eva-sqlite`), reading `rides.db` decrypted from a `/dl` download. `docker compose up -d` brings the whole thing up.

Everything below cost at least one debugging round. None of it is in the plugin's documentation.

## The datasource

**`rawQueryText` is the query. `queryText` is not.** The plugin does `queryText = templateSrv.replace(rawQueryText, scopedVars)` at query time, so a `queryText` written into the JSON is overwritten and never runs. Edit `rawQueryText`; if both are present, keep them identical so the file does not lie about what executes.

**Time columns must be in seconds**, and must be listed in `timeColumns`. Handing the plugin raw millisecond `ts` does not error — it silently decodes to the year 1854. Divide by 1000.0 in the query.

**Rows must be globally sorted by time.** `ORDER BY metric, time` fails the whole query with `not sorted in ascending order by time`. Sort by time alone and let the `metric` column split the series.

**`queryType` decides the frame shape, and therefore what field overrides can match.**

- `"queryType": "table"` returns the columns under their SQL aliases. Overrides match those names directly and nothing else is needed. Use it whenever the query already names its own columns — every stat tile, and the state timelines that widen the flags into one column per bit.
- `"queryType": "time series"` splits the rows into one series per `metric` value, and every series arrives in a field literally called `value` with the series name in a `metric` **label**, not in the field name. Legends read `value iso_test_1`, and an override written against the series name matches nothing, because no field is called that.

The fix for the second case is one line in `fieldConfig.defaults`:

```json
"displayName": "${__field.labels.metric}"
```

That makes the computed display name the bare metric, and overrides match it from then on — `byName` against the metric and `byRegexp` against it both work. Without it neither does, whichever matcher you pick. So the rule is not "avoid `byName`"; it is **set `displayName` on every `time series` panel**, and choose the matcher afterwards on taste.

The corollary is worth checking when you inherit a dashboard: a `time series` panel with overrides and no `defaults.displayName` has overrides that do nothing at all. The symptom is a legend reading `value coolant_in` and palette colours where named ones were configured.

**Interpolate textbox variables through `CAST(${var:sqlstring} AS REAL)`,** not `${var}` bare. A cleared textbox interpolates to nothing and turns the expression into a syntax error; `CAST('' AS REAL)` is `0.0`, which is visibly wrong on screen instead of an error card. It also stops a crafted `?var-…=` link from putting arbitrary SQL into the query, which matters because `docker-compose.yml` runs Grafana anonymous-admin against a read-write mount.

## Panels

**State timelines ignore value mappings on numeric fields.** They label each region with its threshold bucket instead (`-∞+`, or `< 1` if you add a step). Return named text states from SQL — `CASE WHEN value <> 0 THEN 'ACTIVE' ELSE 'clear' END` — and the colours and legend come out right.

**A state timeline whose series are not known in advance needs `queryType: "table"` plus `partitionByValues`.** The pivoted one-column-per-series form only works when you can write the columns out at authoring time — fine for `bms_io_state`'s eight IO lines, impossible for diagnostic codes, where which of the 154 appear is a runtime fact. Measured against Grafana 11.3 with this plugin, on a `(time, metric, state)` query:

| shape                           | result                                                         |
| ------------------------------- | -------------------------------------------------------------- |
| `time series` + text `value`    | **`No data in response`** — the plugin builds no frame at all  |
| `time series` + numeric `value` | renders, but every row is labelled `-∞+` (see above)           |
| `table` + `partitionByValues`   | ✅ one row per distinct `metric`, text states, correct colours |

So: return `time`, `metric` and a text `value`, set `queryType: "table"`, and add

```json
"transformations": [
  { "id": "partitionByValues",
    "options": { "fields": ["metric"], "keepFields": false, "naming": { "asLabels": true } } }
]
```

`asLabels: true` puts the series name in a `metric` label, which then needs the **same `displayName` line as a time-series panel** — `"displayName": "${__field.labels.metric}"` — or every row on the timeline is called `value`. (`asLabels: false` with `"${__series.name}"` works identically; pick one and keep the file consistent.) Used by `trouble-codes.json`.

**Aggregating those text states, `MIN()` is severity-first, `MAX()` is not.** SQLite compares text with BINARY collation and `'ACTIVE'` (0x41) sorts before `'clear'` (0x63), so `MAX()` over a bucket containing both returns `'clear'` and a flag that set and cleared inside one bucket renders green. Renaming either label can flip this silently.

**Grafana keys a separate y-scale off each distinct `axisLabel`.** Setting the label on one of three right-axis series produces three stacked right axes. All series sharing an axis must share the label string exactly.

**Never change a provisioned dashboard's `uid` in place.** The file provisioner then fails on every sync with `could not resolve dashboards:uid:… Dashboard not found`, permanently. Change the title instead.

## Querying log-on-change data

The DB stores a row only when a signal changes by more than its per-signal deadband (`src/can/registry.ts`), and `lastLogged` resets on service restart, so the first sample of every signal after a reboot is always written. Three things follow.

**A stat tile bounded by `r.ts BETWEEN $__from AND $__to` reads "No data"** whenever the signal has not changed inside the window — which for a healthy fault flag is most windows, and looks identical to the logger being down. Drop the lower bound (`r.ts <= $__to`) and the tile shows the held value.

**Carry-forward joins need seeding from before `$__from`.** Two signals logged independently never share a timestamp, so pairing them means holding the last known value of each. If the hold only sees rows inside the window, zooming to a stretch where just one of the pair happened to log leaves the other NULL and every derived panel blanks at once.

**Seed a timeseries at _both_ ends.** The left seed alone does not draw. Grafana pins the x scale to the dashboard time range, so a sample from before `$__from` is clipped out of the plot area, and `stepAfter` builds segments between consecutive points rather than extending past the last one — one off-screen point has nothing to pair with, so the panel goes from "No data" to an empty plot, which reads as a rendering bug rather than a data gap. Emit the last known value a second time, restamped at `$__to`:

```sql
UNION ALL
SELECT * FROM (SELECT $__to/1000.0, s.key, r.value
               FROM reading r JOIN signal s ON s.id = r.signal_id
               WHERE s.key = '…' AND r.ts <= $__to ORDER BY r.ts DESC LIMIT 1)
```

A **state timeline needs only the left seed**: its regions run until the next sample or the end of the time range, so the last state reaches the right edge by itself.

**A flat line means "no change larger than the deadband", not "no change".** Where the deadband is large (10 counts on `iso_test_*`, 100 on `lmu_cell_mux`) say so on the panel — otherwise the axis implies a resolution the data does not carry. Signals whose deadband exceeds their real range only ever produce one row per boot, so a count of them is a count of service restarts.

**A silent sensor and a steady one are not distinguishable from the value stream.** A state timeline draws its last region to the end of the range whichever it is — that is the panel type, not `spanNulls`, which only bridges nulls _between_ points. And a bounded `spanNulls` cannot separate them here: a healthy module goes 48 minutes between logged samples at a constant 28 °C in the 2026-08-02 file, so any cutoff short enough to catch a dropout fires constantly on settled hardware. Use a dedicated signal — `lmu_comm_warnings` (0x206) — rather than trying to infer it from silence.

## Generated queries

**`trouble-codes.json`'s code table is generated — do not hand-edit it.** Grafana can see the ride log and nothing else, and the ride log stores `dtc_0044_0 = 1`, not "water pump open circuit", so the two panels that name a code carry all 154 of them inline as a SQL `VALUES` CTE. That copy cannot be deleted without a second datasource, so it is derived instead: `scripts/generate-grafana-dtc.ts` rewrites the `VALUES` list from `src/diagnostics/dtc-table.ts` and nothing else in the file.

```
npm run generate:grafana-dtc   # after any change to the code table
npm run check:grafana-dtc      # the same thing as `--check`; also checks the prose counts
```

`npm test` runs that check along with the rest of `scripts/run-checks.ts`, so a stale dashboard is a red build and not something you have to remember to look for.

It was hand-maintained until 2026-08-16 and it had already gone stale: a change to the water-pump codes in the TypeScript table never reached the JSON, so for a day the dashboard and the phone screen gave this bike's own `dtc_0044_0` two different names — a seized pump on one, an unwired one on the other. (That change was itself reverted on 2026-08-16 once the bike's own mode-03 reply was read; the entry in `src/diagnostics/dtc-table.ts` argues it out.) Nothing looks wrong on screen when a lookup table is wrong; the panel renders a confident name either way. That is the whole argument for generating it.

## Verifying a dashboard before shipping it

Run every `rawQueryText` against `rides.db` with `$__from`/`$__to` and the template variables substituted, and confirm each returns rows. A panel that renders "No data" is indistinguishable from a broken bike, so it has to be ruled out at the query level first. Check `EXPLAIN QUERY PLAN` shows `SEARCH … USING INDEX idx_reading_sig_ts (signal_id=? AND ts>? AND ts<?)`: the only index on `reading` leads with `signal_id`, so a query filtered on `ts` alone scans. SQLite does flatten derived tables and push a `signal.key` predicate down through the join, so a subquery filtered only on `ts` is not automatically a scan — check the plan rather than assuming either way.
