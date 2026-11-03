# Post-ride analysis with Grafana

> The following sections preserve the former README at commit `58c7eba` (2026-11-03), including dated measurements and limitations. For first installation, use the [current README](../README.md). Older validation/status claims are historical; the existing subsystem findings and current code take precedence.

## Grafana

The whole path from a ride to a chart, on the laptop. Grafana reads a plaintext SQLite file, and the bike only ever produces sealed segments, so decrypting is a step you cannot skip:

```bash
# 1. park within wifi range and pull the sealed log off the bike
curl -O http://cool-eva.local/dl        # or just open http://cool-eva.local/dl on your phone

# 2. import it. Needs the PRIVATE key from step 6 of Setup, in the current directory.
#    Decrypts into a staging file, puts back the waypoints a rebuild would drop, builds
#    the route map's track, and only then replaces rides.db. Measured end to end at
#    3 min 55 s for 26 files / 45.9 M readings / a 2.5 GB result; it scales with the
#    archive, not with what is new, because a /dl dump contains all of it.
node --experimental-strip-types scripts/import-ride-log.ts dl --out rides.db

# 3. Grafana at http://localhost:3000 — no login, dashboards already provisioned
docker compose up -d
```

The datasource points at `/repo/rides.db` (`grafana/provisioning/datasources/sqlite.yml`), which is this repo's directory mounted into the container — so `rides.db` must sit at the repo root. Every panel says **No data** until step 2 has run at least once.

**Which files to give it.** A `/dl` download is every day file concatenated at the moment you download it, so a later import is a _rebuild from all of them_, not a top-up: pass the newest dump plus the day and boot files written after it, and nothing that the dump already contains. `reading` has no uniqueness constraint — pass a dump **and** the day files inside it and every overlapping row is stored twice, silently. ⚠️ The gap in that rule, stated because nothing closes it yet: a day file written after the dump was taken also holds the earlier part of that day, so excluding it to avoid doubling loses whatever was logged between the dump and midnight.

**What the step does, in order** (`scripts/import-ride-log.ts`, and `scripts/ride-import.ts` for the refusals):

1. **Decrypt into `rides.db.import-<runId>`** — never over the live file, which is what makes an import that fails halfway cost nothing. `--heap-mb` (default 24576) is the V8 heap the decrypt gets; a dump that outgrows it dies with a heap OOM and the step says so.
2. **Re-run the waypoint recovery.** Once over the whole archive, reported and writing nothing, so you can see what falls outside the window; then once more with `--commit` up to `2026-09-10T21:55:06Z`, the instant #197 changed the hold beat the recovery models. `--recover-from` / `--recover-to` override it. `docs/waypoints.md` §"Not losing the ride log".
3. **Materialise the route map's track** into `route_track`, which is why the map now loads in well under a second. `--materialise-only <db>` runs just this stage on a database you already have. `docs/route-map.md` §"Materialised once, not per load".
4. **Swap** — and refuse instead, leaving the staging file for you to look at, if the new database covers fewer readings or a shorter span than the one it replaces (`--allow-shrink` if you meant it), or if `rides.db-wal` is non-empty because something still has the old file open. The replaced database is kept as `rides.db.bak-replaced-<runId>`; delete it once Grafana looks right.

`scripts/decrypt-log.ts` on its own is still there and still the right tool for a scratch database (`--out evidence/scratch.db`); it refuses an existing `--out` and only `--force` appends into one.

Ten dashboards are provisioned from `grafana/dashboards/`, one file each:

- **Cooling** (`cooling.json`) — ΔT across the pack, heat removed against an assumed coolant flow, inlet/outlet/ambient, per-module temperatures, powertrain temps.
- **Battery & cell balancing** (`battery-cells.json`) — per-cell voltage and per-module temperature heatmaps, spread over time, the cell limits the BMS is actually configured with.
- **Ride summary** (`ride-summary.json`) — speed, power, torque, energy, peak temperatures, position, bike state. Torque appears twice on purpose: against power from the Connectivity Hub, and as the inverter's own commanded-vs-delivered pair off `0x02C` with the hub's reading laid over it as an independent check. See `docs/can-decode-findings.md` §0x02C for what the gap between the two means and why that panel breaks the hub's line rather than holding it.
- **Charging** (`charging.json`) — charge sessions, charger mains and DC side, the BMS system-state lanes.
- **Isolation & faults** (`isolation-faults.json`) — the BMS isolation test in raw ADC counts, the error and warning flags, the stored diagnostic code counts, the BMS IO lines.
- **Explore & data health** (`explore.json`) — every logged signal, a browser over the whole registry, and how long each signal has been quiet.
- **Charge manager** (`charge-manager.json`) — the DC fast-charge side, off CAN `0x605`/`0x610`/`0x615`/`0x620`/`0x625`: the current the vehicle requests against the three separate limits that bound it and against what the pack actually took, the state machine split back out into its factory fields, and the fault source and code. The **Charging** tab above cannot show a DC session — the onboard charger's frames are absent through one.
- **Power & battery** (`power-battery.json`) — power in kW against battery percentage, charge power derived from `dc_v × dc_a` and pack power measured, plus cell-vs-board pack temperature.
- **Route & charging map** (`route-map.json`) — where the bike went and where it charged, on a map. The track is every GPS fix in the window, coloured by speed; charge stops are pins sized by energy added and coloured by how stale their position is, because the hub sleeps while charging and a stop is drawn at the last fix from before it was plugged in. Both tables drill down into the dashboards above with the range already set. See `docs/route-map.md`.
- **Trouble codes** (`trouble-codes.json`) — every diagnostic code the bike has reported, named from Energica's own type-approval table. The code table in that file is generated; see `grafana/README.md`.

`grafana/README.md` collects the datasource and panel traps that querying log-on-change data in this plugin keeps producing — read it before writing a new dashboard.
