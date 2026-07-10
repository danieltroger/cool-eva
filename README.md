# Cool Eva

Telemetry for a **watercooled 2021 Energica Eva Ribelle**. A Raspberry Pi inside the bike logs the temperatures of a custom watercooling loop on the battery pack, **plus** the bike's own battery / charge / cell / drive telemetry read straight off the CAN bus — all into one SQLite database, surfaced as a live phone dashboard and a Grafana dashboard for post-ride analysis.

## Hardware & setup

- **Raspberry Pi Zero 2 W** running the app as a `systemd` service (Node.js, runs as root).
- **2× MAX31865 + PT100 probes** over SPI — coolant **in** and **out** of the custom battery watercooling loop.
- **[8devices Korlan USB2CAN](https://shop.8devices.com/usb2can/korlan/)** plugged into the bike's OBD port → `can0` (in-kernel `usb_8dev`, no driver install). 500 kbit, 11-bit. The app reads broadcast frames _and_ actively polls standard OBD-II PIDs (**read-only** — no diagnostic writes).
- **Networking:** the Pi joins my **phone's hotspot**, so it's reachable at **`http://cool-eva.local`** from the phone's browser. It's a bit janky (have to open hotspot page in phone settings for ~20s at the start of every ride), but it works for an at-a-glance dash while riding/charging.

## What it logs

Everything is logged **on change** (so steady values don't spam the DB) into a small SQLite database.

| Group | Signals | Source |
| --- | --- | --- |
| **Coolant** (custom loop) | `coolant_in`, `coolant_out` (°C) | MAX31865 PT100 |
| **Battery / BMS** | `batt_temp_lo`, `batt_temp_hi` (°C), `soc` (%), `soh` (%), `pack_v` (V), `pack_a` (A), `pack_kw` (kW) | CAN `0x200` |
| **Cells** | `cell_min_mv`, `cell_avg_mv`, `cell_max_mv`, `cell_spread_mv`, `min_cell_idx`, `max_cell_idx` | CAN `0x203` |
| **Charge** | `charge_state` (idle/AC/DC), `dc_v`, `dc_a`, `mains_v`, `mains_a`, `charge_limit_a` | CAN `0x201`/`0x305`/`0x306`/`0x10a` |
| **Energy** | `inst_consumption_wh`, `residual_energy_wh` (available energy) | CAN `0x025`/`0x10A` |
| **Drive** | `throttle_pct`, `speed_kmh`, `motor_rpm`, `motor_load_pct`, `dist_since_clear_km` | CAN `0x109` + OBD-II `0D`/`0C`/`04`/`31` |
| **OBD-II (1 Hz)** | `bike_coolant_temp` (motor/coolant °C), `oil_temp` (°C), `ambient_temp` (°C), `aux_12v` (V), `soh_pid` (%) | OBD-II `05`/`5C`/`46`/`42`/`5B` |

> Per-cell voltages, VIN, and BMS writes are **not** reachable from the OBD port (on the standard pins, haven't tried the other pins yet).

## How it works

```
MAX31865 probes ─┐
                 ├─► signals (log-on-change) ─► SQLite (signal/reading EAV) ─► Grafana
Korlan can0 ─────┤                            └─► live state ─► WebSocket ─► phone dashboard
  · broadcast decode (0x200, 0x203, …)
  · OBD-II poll @1 Hz (0D, 05, 42, …)
```

- `src/can/` — `socket` (can0 bring-up + raw channel), `decode` (broadcast frame decoders), `obd` (OBD-II poll loop), `signals`/`registry` (log-on-change core).
- `src/sensors/max31865.ts` — the coolant probes.
- `src/db.ts` — SQLite schema (long/EAV: `signal` + `reading`) and batched writes.
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

The full SQLite DB can be downloaded from `http://<pi>/db`.

### Grafana

```bash
docker compose up -d     # Grafana at http://localhost:3000, reads temperatures.db
```

Dashboard provisioned from `grafana/dashboards/cooling.json` (battery temp vs coolant, ΔT across the pack, charge, cells, drive, …).

## Notes

- The CAN bus is **read-only**: passive broadcast decode + standard OBD-II _read_ requests only. No KWP/UDS writes.
- Coolant history predating the CAN integration is preserved (migrated into the current schema; the original table is kept as a backup).
