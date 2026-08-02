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
                 ├─► signals (log-on-change) ─► sealed ride log ─► /dl ─► laptop ─► SQLite ─► Grafana
Korlan can0 ─────┤                            └─► live state ─► WebSocket ─► phone dashboard
  · broadcast decode (0x200, 0x203, …)         (the bike holds only a public key:
  · OBD-II poll @1 Hz (0D, 05, 42, …)            it can seal history, never read it)
Energica BT hub ─┘
  · GPS, torque/power, odometer
```

- `src/can/` — `socket` (can0 bring-up + raw channel), `decode` (broadcast frame decoders), `obd` (OBD-II poll loop), `signals`/`registry` (log-on-change core).
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

Dashboard provisioned from `grafana/dashboards/cooling.json` (battery temp vs coolant, ΔT across the pack, charge, cells, drive, …).

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
