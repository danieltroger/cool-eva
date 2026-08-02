# Cool Eva

Telemetry for a **watercooled 2021 Energica Eva Ribelle**. A Raspberry Pi inside the bike logs the temperatures of a custom watercooling loop on the battery pack, **plus** the bike's own battery / charge / cell / drive telemetry read straight off the CAN bus — all into an encrypted, write-only ride log, surfaced as a live phone dashboard and (after decryption on the laptop) a Grafana dashboard for post-ride analysis.

## Hardware & setup

- **Raspberry Pi Zero 2 W** running the app as a `systemd` service (Node.js, runs as root).
- **2× MAX31865 + PT100 probes** over SPI — coolant **in** and **out** of the custom battery watercooling loop.
- **[8devices Korlan USB2CAN](https://shop.8devices.com/usb2can/korlan/)** plugged into the bike's OBD port → `can0` (in-kernel `usb_8dev`, no driver install). 500 kbit, 11-bit. The app reads broadcast frames _and_ actively polls standard OBD-II PIDs (**read-only** — no diagnostic writes).
- **Networking:** the Pi joins my **phone's hotspot**, so it's reachable at **`http://cool-eva.local`** from the phone's browser. It's a bit janky (have to open hotspot page in phone settings for ~20s at the start of every ride), but it works for an at-a-glance dash while riding/charging.

## What it logs

Everything is logged **on change** (so steady values don't spam the log) into the encrypted ride log — see [Encrypted ride log](#encrypted-ride-log).

| Group | Signals | Source |
| --- | --- | --- |
| **Coolant** (custom loop) | `coolant_in`, `coolant_out` (°C) | MAX31865 PT100 |
| **Battery / BMS** | `batt_temp_lo`, `batt_temp_hi` (°C, always the **true** pack temperature), `batt_temp_lo_vcu`, `batt_temp_hi_vcu` (what the VCU and dash read — 15 °C lower once the DC-derate offset config is flashed), `soc` (%), `soh` (%), `pack_v` (V), `pack_a` (A), `pack_kw` (kW), `allowed_discharge_a`, `allowed_regen_a` (A), `pack_resistance_mohm` (mΩ) | CAN `0x200`/`0x202`/`0x206`/`0x660` |
| **Cells** | `cell_min_mv`, `cell_avg_mv`, `cell_max_mv`, `cell_spread_mv`, `cell_deviation_mv` (the BMS's own ΔV), `cell_lowest_v_idx`, `cell_highest_v_idx` (which cell is at each extreme _right now_ — at a few mV of spread that ranking is noise, not a health verdict), `cells_connected`, `cell_voltage_sum_v` | CAN `0x203`/`0x205`/`0x207` |
| **BMS state & faults** | `charge_state` (raw System State bitfield) + decoded `bms_state_*` (discharge / charge / balancing / trickle / idle / charge complete / maintenance), `bms_error_flags`, `bms_warning_flags` (raw words) + booleans for the ones worth acting on: cell over/under voltage, over temperature, leak detected, leak detection failed, contactor faults, low SOC, balancing required | CAN `0x201` |
| **Isolation** | `iso_test_1`, `iso_test_2`, `iso_test_total` (10-bit ADC, 512 = ideal), `bms_io_state`, `lmu_comm_warnings` | CAN `0x207`/`0x206` |
| **Charge** | `charge_state`, `dc_v`, `dc_a`, `mains_v`, `mains_a`, `charge_limit_a`, `charger_enabled`, `charger_max_dc_v`, `charger_max_dc_a` | CAN `0x201`/`0x305`/`0x306`/`0x10a`/`0x300` |
| **Energy** | `inst_consumption_wh`, `residual_energy_wh` (available energy), `bms_remaining_energy_raw`, `remaining_ah` | CAN `0x025`/`0x10A`/`0x205` |
| **Drive** | `throttle_pct`, `speed_kmh`, `motor_rpm`, `motor_load_pct`, `dist_since_clear_km` | CAN `0x109` + OBD-II `0D`/`0C`/`04`/`31` |
| **OBD-II (1 Hz)** | `bike_coolant_temp` (motor/coolant °C), `oil_temp` (°C), `ambient_temp` (°C), `aux_12v` (V), `soh_pid` (%) | OBD-II `05`/`5C`/`46`/`42`/`5B` |

### Signals that need the custom BMS config

Everything in the table above works on a **stock, unmodified Energica** — including the isolation readings on `0x207` and the allowed-current limits on `0x202`, which the BMS broadcasts as shipped.

The frames below only exist once the pack's LiBAL BMS has been reflashed with the custom config. On a stock bike they simply never arrive, so **these signals being absent is normal, not a fault**:

| Group | Signals | Source |
| --- | --- | --- |
| **Per-cell voltages** | `lmu1_cell1_mv` … `lmu11_cell7_mv` — the individual cells, multiplexed by module at 20 Hz. Known gap: cells 4-8 of LMU 1 and 2 never get sampled, because the CAN transmit order is phase-locked to the BMS's module poll (see `obd-garage/CAN_MAP.md`) | CAN `0x662`–`0x664` |
| **Per-module temps** | `lmu1_bat1_c`, `lmu1_pcb1_c`, `lmu1_pcb2_c` … — each module's battery and board sensors, keyed off the same module number as its cells | CAN `0x664` |
| **Pack temps** | `pack_temp_avg` (°C), `lmu_temp_high_idx`, `lmu_temp_low_idx`; in the offset config also the true `batt_temp_lo`/`batt_temp_hi` and `pp_output3_raw` (a diagnostic, retired once confirmed) | CAN `0x660` |
| **Energy / hours** | `bms_remaining_energy_wh` (1 Wh resolution), `bms_uptime_min` (BMCU hour meter) | CAN `0x661` |
| **Cell limits** | `cell_cutoff_mv`, `cell_end_of_life_mv`, `cell_overvoltage_mv`, `cell_target_mv` — the thresholds the BMS is actually configured with, so nothing downstream has to hardcode them | CAN `0x665` |

> VIN and BMS writes are still **not** reachable from the OBD port (on the standard pins, haven't tried the other pins yet). Per-cell voltages **are** — they just have to be enabled in the BMS's own configuration first; see `obd-garage/CAN_MAP.md`.

#### `CUSTOM_BMS_CONFIG` — set this only if you flashed the custom config

The custom config shifts the pack temperatures the VCU reads down by 15 °C, to move its DC-charge derate knee from 36 °C reported to 51 °C actual. That changes what `0x200`'s temperature bytes mean, so the app has to be told:

```bash
CUSTOM_BMS_CONFIG=1   # only with the custom BMS config flashed. Default: unset = stock.
```

**Leave it unset on a stock bike** — `batt_temp_lo` / `batt_temp_hi` then come straight off `0x200`, as they always have, from about five seconds after the BMS starts talking (see below). With it set, those keys come from `0x660` instead and `0x200`'s (shifted) view is logged separately as `batt_temp_lo_vcu` / `batt_temp_hi_vcu`. Either way `batt_temp_lo` / `batt_temp_hi` always mean the **true** pack temperature, so the history stays one continuous series.

The flag is only a hint about what to expect — the frames on the bus win. Which config is live can only be read off what arrives (a long `0x660` means the offset config, a short one means the extended config without it, and no `0x660` at all means stock), so **the true-temperature keys are not written at all until that is settled**, which takes up to 5 s from the first `0x200`. A gap is deliberate: `batt_temp_lo` / `batt_temp_hi` are never allowed to carry the shifted view, and everything is logged on change, so a few seconds of silence costs nothing while a wrong value would be sealed into the ride log for good. `batt_temp_lo_vcu` / `batt_temp_hi_vcu` are unaffected and log from the first frame.

Get the flag wrong in either direction and the app says so:

- flag unset but the custom frames turn up → loud error, and the keys take `0x660`'s true values;
- flag set but no `0x660` ever arrives → warning, and `batt_temp_lo` / `batt_temp_hi` stay **unlogged** rather than falling back to `0x200`, whose bytes are the shifted view under that config. Unset the flag if the pack really is stock.

Nothing else in the app is affected by this flag; every other decode is correct on both configs.

## How it works

```
MAX31865 probes ─┐
                 ├─► signals (log-on-change) ─► sealed ride log ─► /dl ─► laptop ─► SQLite ─► Grafana
Korlan can0 ─────┤                            └─► live state ─► WebSocket ─► phone dashboard
  · broadcast decode (0x200, 0x203, …)         (the bike holds only a public key:
  · OBD-II poll @1 Hz (0D, 05, 42, …)            it can seal history, never read it)
  · GPS on 0x410
Energica BT hub ─┘
  · torque/power, odometer, vehicle state
```

- `src/can/` — `socket` (can0 bring-up + raw channel), `decode`/`decode-bms` (broadcast frame decoders, pure), `pack-temperature` (picks which frame owns the true pack temperature, since that depends on which BMS config is flashed), `obd` (OBD-II poll loop), `signals`/`registry` (log-on-change core).
- `src/gps/` — `decode` (the hub's GPS message, pure; shared by CAN `0x410` and the BLE link, which send byte-identical frames), `clock` (steps the Pi's clock from satellite UTC — it has no RTC).
- `src/ble/` — the Bluetooth link to the Connectivity Hub: `protocol` (framing + handshake, pure), `client` (D-Bus session), `adapter` (bring-up).
- `src/sensors/max31865.ts` — the coolant probes.
- `src/storage/encrypted-log.ts` — the only persistence on the bike: sealed, append-only, write-only.
- `src/db.ts` — SQLite schema (long/EAV: `signal` + `reading`). Now used **only on the laptop**, by `scripts/decrypt-log.ts`, to rebuild a plaintext DB from decrypted segments.
- `src/ws.ts` + `public/index.html` — the live phone riding dashboard.
- `src/index.ts` — wires it all together.

## Running it

The app is a `systemd` service on the Pi (Node 24, TypeScript run directly via `--experimental-strip-types`), serving `http://<pi>/` on port 80.

```bash
npm install                       # builds better-sqlite3 + socketcan (Linux only)
sudo node scripts/setup-service.ts   # install + enable + start the systemd service

# deploy an update
git pull && npm ci && sudo systemctl restart thermometer
sudo journalctl -u thermometer -f    # follow logs
```

The sealed ride log can be downloaded from `http://<pi>/dl` — short enough to type on a phone, ~10x smaller than the old SQLite download, and safe to fetch over any network because it's ciphertext. Decrypt it on the laptop (see below) to get a `.db` for Grafana.

### Grafana

```bash
docker compose up -d     # Grafana at http://localhost:3000, reads temperatures.db
                         # (build that file from a /dl download: see "Encrypted ride log")
```

Six dashboards are provisioned from `grafana/dashboards/`, one file each:

- **Cooling** (`cooling.json`) — ΔT across the pack, heat removed against an assumed coolant flow, inlet/outlet/ambient, per-module temperatures, powertrain temps.
- **Battery & cell balancing** (`battery-cells.json`) — per-cell voltage and per-module temperature heatmaps, spread over time, the cell limits the BMS is actually configured with.
- **Ride summary** (`ride-summary.json`) — speed, power, torque, energy, peak temperatures, position, bike state.
- **Charging** (`charging.json`) — charge sessions, charger mains and DC side, the BMS system-state lanes.
- **Isolation & faults** (`isolation-faults.json`) — the BMS isolation test in raw ADC counts, the error and warning flags, the stored diagnostic code counts, the BMS IO lines.
- **Explore & data health** (`explore.json`) — every logged signal, a browser over the whole registry, and how long each signal has been quiet.

`grafana/README.md` collects the datasource and panel traps that querying log-on-change data in this plugin keeps producing — read it before writing a new dashboard.

### Encrypted ride log

A stolen bike is a stolen SD card, and the log holds every route you've ridden — including the one that ends at your front door — plus the ID of the key fob that starts it. So the Pi can be given a **public key only**: it seals every reading it writes and cannot read any of it back.

Set it up once, on the laptop:

```bash
node --experimental-strip-types scripts/generate-log-key.ts   # writes both keys
# back the PRIVATE key up (password manager) — it is the only thing that can ever read the logs
scp ride-log-key.public.pem pi@cool-eva.local:/home/pi/thermometer/
```

Restart the service; it logs `ride-log: encrypting to …` once it finds the key. Sealed segments land in `ride-logs/*.celog`. To read them back:

```bash
# a /dl download is a single file; ride-logs/ off the Pi is a directory — both work
node --experimental-strip-types scripts/decrypt-log.ts cool-eva-2026-08-01.celog
node --experimental-strip-types scripts/decrypt-log.ts ride-logs/ --out rides.db

# the key is looked up relative to the CWD, so from anywhere else:
RIDE_LOG_PRIVATE_KEY=~/Documents/cool-eva/ride-log-key.private.pem \
  node --experimental-strip-types scripts/decrypt-log.ts ~/Downloads/cool-eva-2026-08-01.celog
```

That rebuilds an ordinary SQLite file, so Grafana and the dashboards work against it unchanged.

> ⚠️ The Grafana datasource points at `/repo/temperatures.db` (`grafana/provisioning/datasources/sqlite.yml`), so either decrypt with `--out temperatures.db` **in a directory that doesn't already hold your pre-encryption archive** — the tool would append into it — or repoint the datasource at `rides.db`. The sealed log is also **~10x smaller** than the equivalent SQLite (gzip before encryption, and crypto overhead is per 30-second segment rather than per row).

Each segment uses a fresh ephemeral X25519 key (ECDH → HKDF-SHA256 → AES-256-GCM), so compromising the Pi cannot retroactively decrypt anything already written. Segments are independently sealed, so damage is contained: the reader resyncs on the next segment and reports what it couldn't read rather than stopping. **There is deliberately no recovery path: lose the private key and every logged ride is gone forever.** That is exactly what makes the SD card worthless to a thief.

#### What this does and doesn't hide

Holds up: the readings themselves — routes, coordinates, the key-fob ID, everything in the tables above. Whoever takes the SD card, or intercepts a `/dl` download, gets ciphertext.

Does not:

- **Timing metadata leaks.** Filenames are `rides-YYYY-MM-DD.celog`, and sizes scale with how much was logged. That reveals which days the bike moved and roughly for how long, without revealing where. Since the motivating worry is someone learning your habits, that's worth knowing.
- **No cross-segment integrity.** Each segment is authenticated on its own, so tampering within one is detected — but segments can be deleted or reordered without the reader noticing. It protects confidentiality, not completeness.
- **`/dl` is unauthenticated** on port 80, like the rest of the server. The payload is sealed, so the exposure is the metadata above rather than the data — but it's a wider audience than "whoever holds the SD card".

## Notes

- The CAN bus is **read-only**: passive broadcast decode + standard OBD-II _read_ requests only. No KWP/UDS writes.
- Coolant history predating the CAN integration is preserved (migrated into the current schema; the original table is kept as a backup).
- Any `temperatures.db` left on the Pi from before the encrypted log is **plaintext history** — copy it off and delete it from the bike, or the SD card still gives up every route you rode before the switch.
