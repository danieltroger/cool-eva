# Cool Eva

Telemetry for a **watercooled 2021 Energica Eva Ribelle**. A Raspberry Pi inside the bike logs the temperatures of a custom watercooling loop on the battery pack, **plus** the bike's own battery / charge / cell / drive telemetry read straight off the CAN bus — all into an encrypted, write-only ride log, surfaced as a live phone dashboard and (after decryption on the laptop) a Grafana dashboard for post-ride analysis.

## Hardware

- **Raspberry Pi Zero 2 W** running the app as a `systemd` service (Node.js, runs as root).
- **[8devices Korlan USB2CAN](https://shop.8devices.com/usb2can/korlan/)** plugged into the bike's OBD port → `can0` (in-kernel `usb_8dev`, no driver install). 500 kbit, 11-bit. The app reads broadcast frames _and_ actively polls standard OBD-II PIDs (**read-only** — no diagnostic writes).
- **2× MAX31865 + PT100 probes** over SPI — coolant **in** and **out** of the custom battery watercooling loop. **Optional**: this is the one piece of hardware most Energicas don't have. Without it everything else works and the coolant tiles simply don't appear.
- **Networking:** the Pi joins my **phone's hotspot**, so it's reachable at **`http://cool-eva.local`** from the phone's browser. It's a bit janky (have to open hotspot page in phone settings for ~20s at the start of every ride), but it works for an at-a-glance dash while riding/charging.

### If you have a stock Energica

The Korlan alone gets you most of this. Everything under [What it logs](#what-it-logs) works on a stock, unmodified bike except the sections explicitly marked otherwise — no watercooling loop, no probes and no BMS reflash required. Set `COOLANT_ENABLED=0` and the coolant probes are never attempted.

Two caveats worth knowing before you spend money:

- It is developed against a **2021 Eva Ribelle**. The pack shape is hardcoded in places — 81 cells in 11 modules, a 400 A discharge and 120 A regen ceiling, a 130 kW power bar — and nothing detects a mismatch. On another bike in the same pack family the readings are right and those scale limits may not be; on a differently-packed model (Experia) treat the whole thing as untested. Reports welcome.
- The bike's **CAN bus is not a toy**. This app only ever reads, but it does transmit standard OBD-II _read_ requests to do so (see [Notes](#notes)). If you would rather it never spoke at all, `OBD_ENABLED=0` makes it passive-only.

## Setup

From a blank SD card to a dashboard. Steps 1–5 are the Pi, step 6 is your laptop, and **step 6 is the one people skip and regret** — without it the dashboard works perfectly and nothing at all is saved.

**1. Flash Raspberry Pi OS (64-bit).** In Raspberry Pi Imager, open the gear icon and set:

- **hostname `cool-eva`** — this is what makes `http://cool-eva.local` work. Skip it and your Pi is `raspberrypi.local`.
- **Enable SSH**, with a password or your public key. There is no screen on the bike, so this is the only way in — including for every future update.
- **Wi-Fi: your phone's hotspot** (SSID and password), so it connects on the road. Add your home Wi-Fi too, from the Pi later, or you'll be swapping the card to get it back.

**2. Join the phone hotspot** (if you didn't set it in the Imager). Bookworm uses NetworkManager:

```bash
sudo nmcli device wifi connect "<your hotspot SSID>" password "<password>"
sudo nmcli connection modify "<your hotspot SSID>" connection.autoconnect yes
```

On iOS you have to **open Settings → Personal Hotspot and leave it on screen for ~20 s** at the start of a ride, or the phone won't accept the join. That is an iOS behaviour, not something this app can fix.

**3. Install Node 24.** Raspberry Pi OS's `apt` Node is far too old — the app is TypeScript run directly, which needs `--experimental-strip-types` (Node 22.6.0 at the very oldest; 24 is what this is tested on).

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # must be v22.6 or newer
```

**4. Clone and install.**

```bash
git clone https://github.com/<your-fork>/cool-eva.git ~/cool-eva
cd ~/cool-eva
npm install
```

`npm install` compiles three native modules (`better-sqlite3`, `socketcan`, `spi-device`). On a Pi Zero 2 W that takes **several minutes** and wants swap enabled — if it gets killed, that's memory, not a bug.

**5. Only if you have the coolant probes: enable SPI.** `sudo raspi-config` → Interface Options → SPI → Yes, then reboot. **Don't enable it if you have no probes wired**: with SPI on and nothing attached the reads succeed and return −242 °C forever. The app notices and retires the probe after a minute, but it's noise you don't need.

**6. Generate the ride-log keypair — on your laptop, not the Pi.** Nothing is persisted until the Pi has a public key. See [Encrypted ride log](#encrypted-ride-log) for why it works this way.

```bash
# on the LAPTOP, in a clone of this repo
node --experimental-strip-types scripts/generate-log-key.ts
# back the PRIVATE key up now (password manager) — it is the only thing that
# can ever read your logs, and there is no recovery path
scp ride-log-key.public.pem pi@cool-eva.local:/home/pi/cool-eva/
```

**7. Install the service** (back on the Pi):

```bash
sudo $(which node) --experimental-strip-types scripts/setup-service.ts
sudo journalctl -u cool-eva -f    # follow the logs
```

The installer refuses to run on too-old a Node, removes the old `thermometer` unit if you're upgrading, and tells you if the ride-log key is still missing. In the log you want to see `ride-log: encrypting to …`; if you see the `NO PUBLIC KEY` banner instead, step 6 didn't land.

Then open **`http://cool-eva.local`** on your phone.

## What it logs

Everything is logged **on change** (so steady values don't spam the log) into the encrypted ride log — see [Encrypted ride log](#encrypted-ride-log).

| Group | Signals | Source |
| --- | --- | --- |
| **Coolant** (custom loop) | `coolant_in`, `coolant_out` (°C) | MAX31865 PT100 |
| **Battery / BMS** | `batt_temp_lo`, `batt_temp_hi` (°C, always the **true** pack temperature), `batt_temp_lo_vcu`, `batt_temp_hi_vcu` (what the VCU and dash read — lowered once a DC-derate config is flashed, by an amount that depends on the config; under the current bounded clamp they read 35 °C throughout the 35–54 °C band and the true temperature either side of it), `soc` (%), `soh` (%), `pack_v` (V), `pack_a` (A), `pack_kw` (kW), `allowed_discharge_a`, `allowed_regen_a` (A), `pack_resistance_mohm` (mΩ) | CAN `0x200`/`0x202`/`0x206`/`0x660` |
| **Cells** | `cell_min_mv`, `cell_avg_mv`, `cell_max_mv`, `cell_spread_mv`, `cell_deviation_mv` (the BMS's own ΔV), `cell_lowest_v_idx`, `cell_highest_v_idx` (which cell is at each extreme _right now_ — at a few mV of spread that ranking is noise, not a health verdict), `cells_connected`, `cell_voltage_sum_v` | CAN `0x203`/`0x205`/`0x207` |
| **BMS state & faults** | `charge_state` (raw System State bitfield) + decoded `bms_state_*` (discharge / charge / balancing / trickle / idle / charge complete / maintenance), `bms_error_flags`, `bms_warning_flags` (raw words) + booleans for the ones worth acting on: cell over/under voltage, over temperature, leak detected, leak detection failed, contactor faults, low SOC, balancing required | CAN `0x201` |
| **Isolation** | `iso_test_1`, `iso_test_2`, `iso_test_total` (10-bit ADC, 512 = ideal), `bms_io_state`, `lmu_comm_warnings` | CAN `0x207`/`0x206` |
| **Charge** | `charge_state`, `dc_v`, `dc_a`, `mains_v`, `mains_a`, `charge_limit_a`, `charger_enabled`, `charger_max_dc_v`, `charger_max_dc_a`, `bms_post_processor_1` (purpose unknown, logged raw so a ride can name it), `fast_dc_contactor` — the DC fast-charge contactor monitor (Energica's `V_FASTDC_MON_SW`, and the analog wire `A020_FCHG_MON`). It is 1 only on DC: across 1.1 M frames of `0x102` it was set in exactly one interval, a 17-minute DC session that took the pack 30 → 42 %, and 0 through every AC charge including a 48-minute one at 14 A. It rises ~190 ms before `charger_enabled` and ~470 ms before the first amp, which is what a contactor monitor should do | CAN `0x201`/`0x305`/`0x306`/`0x10a`/`0x300`/`0x102` b3 |
| **Energy** | `inst_consumption_wh`, `residual_energy_wh` (available energy), `bms_remaining_energy_raw`, `remaining_ah`, plus the hub's own trip figures: `range_km`, `avg_consumption_wh_km`, `km_per_kwh`, `kwh_per_100km` (the last two emit nonsense at a standstill and are gated on the dashboard) | CAN `0x025`/`0x10A`/`0x205` + hub |
| **Drive** | `throttle_pct`, `speed_kmh`, `motor_rpm`, `motor_load_pct`, `dist_since_clear_km`, `motor_torque_nm`, `motor_power_kw` (Bluetooth only — on no CAN frame and no OBD PID we know of), `odometer_km`, `trip_km`, `vehicle_state`, `vehicle_substate` | CAN `0x109` + OBD-II `0D`/`0C`/`04`/`31` + hub |
| **Drive, second opinion** | `speed_can_kmh`, `motor_rpm_can`, `odometer_can_km`, `reverse_gear` — deliberately **not** merged into the keys above, because comparing the two over a ride is the point and one key with two writers just flaps. Plus the inverter's own limits `current_max_out_a`, `current_max_regen_a`, `current_other_a` (unidentified; logged so a ride can name it) | CAN `0x104`/`0x109` |
| **GPS** | `gps_lat`, `gps_lon` (emitted only when both axes arrived in the same sub-frame cycle — a half-fresh fix is withheld, not blended), `gps_altitude_m` (16-bit two's complement, so −1 m reads as −1 m), `gps_speed_kmh`, `gps_course_deg`, `gps_satellites`, `gps_fix`, `gps_epoch_s` (satellite UTC, logged raw — the Pi has no RTC, so a no-network boot's timestamps stay repairable). Arrives over **both** transports; position is not Bluetooth-only | CAN `0x410` + hub over BLE |
| **Powertrain temps** | `inverter_igbt_min_c`, `inverter_igbt_c`, `inverter_igbt_max_c`, `inverter_gate_c`, `motor_temp_c` (°C) — separate sensors from the OBD poller's `bike_coolant_temp`, and they move differently under load | CAN `0x020`/`0x022` |
| **Controls & vehicle state** | `high_beam` (which is also how you change dashboard screens), `high_beam_lamp`, `low_beam_lamp`, `brake`, `blinker_left`, `blinker_right`, `horn`, `energized`, `go_request`, `go`, `key_on`, `stand_up` (sidestand retracted), `ignition_button`, `throttle_on`, `moving`, `cruise_active` (cruise control armed — inferred, not in any vendor table, from two events where it followed the cruise ON/OFF button by half a second). ⚠️ The two beam lamps were logged as `charging` and `charge_port_unlocked` until 2026-08-16, on a rider-made `.xdbc`'s word: **both names were simply wrong.** Each agrees with its beam switch in `0x102` b0 across all 1 103 000 frames of the capture corpus with zero disagreements, and the old `charging` bit reads 0 through every real charge. Old rows are correct readings under a wrong name, so the Grafana State panel unions the old key into each lane and the history stays continuous | CAN `0x102` |
| **Handlebar buttons** | `btn_mode_left`, `btn_mode_right`, `btn_mode_enter`, `btn_indicator_cancel` (left pod, as VCU discretes), `btn_set_back`, `btn_cruise_enable`, `btn_cruise_set`, `btn_heated_grip` (dashboard inputs). Momentary and short — the median press measured 140 ms and the shortest 30 ms — so the dashboard latches them for 600 ms and counts presses; see [The dashboard](#the-dashboard). **Confidence varies per bit and is written down next to each one in `src/can/decode.ts`**: indicator-cancel and the two cruise buttons are confirmed by what they correlate with, the MODE pair is confirmed as menu buttons but not as left-vs-right, and `btn_set_back`/`btn_heated_grip` have never been seen set at all | CAN `0x102` b0 + `0x400` b2 |
| **Attitude** | `attitude_roll_deg` (positive = leaning right), `attitude_pitch_deg` (positive = nose-down, i.e. braking) — the attitude sensor's two derived angles in degrees, **not** the accelerations the `.xdbc` calls them. Gravity-referenced and not gyro-fused, so a steady corner reads ≈0 and pitch mostly reports braking rather than gradient; they say which way is down, not how far over the bike is. Logged as `accel_lateral_raw`/`accel_frontal_raw` before 2026-08-15 — same numbers, in 0.1°. See `src/can/attitude.ts` | CAN `0x102` b4-7 |
| **Security** | `key_fob_id` (which fob started the bike — part of why the log is sealed), `keys_paired` (read once at startup from the E-LOCK ECU) | CAN `0x480` + E-LOCK `0x791` |
| **OBD-II (1 Hz)** | `bike_coolant_temp` (motor/coolant °C), `oil_temp` (°C), `ambient_temp` (°C), `aux_12v` (V), `soh_pid` (%) | OBD-II `05`/`5C`/`46`/`42`/`5B` |
| **Trouble codes** | `mil_on`, `dtc_count` (stored, per PID `01`), `dtc_stored_count` (the mode-03 list's own length — the same number down a second path), `dtc_list_count` (the bike's _active_ list, a different thing), `dtc_unrecognised_count`, `freeze_frame_dtc` (the code that lit the lamp), plus one 1/0 signal per code Energica documents. `dtc_pending_count` and `dtc_permanent_count` are written **only if** modes 07/0A ever answer — on this bike they never have, and their absence is the honest record of that. See [Trouble codes](#trouble-codes) | OBD-II `01`/`02` + **mode 03** · CAN `0x410` |
| **Service counters** | `time_since_clear_min` (monotonic ⇒ an hour meter), `warmups_since_clear`, `dist_with_mil_km`, `time_with_mil_min` | OBD-II `4E`/`30`/`21`/`4D` |
| **Waypoints** | `waypoint_seq`, `waypoint_lat`, `waypoint_lon` — written only when you ask, from the dashboard button or Siri. See [Saving a waypoint from Siri](#saving-a-waypoint-from-siri) | `GET /waypoint` |

### Signals that need the custom BMS config

Everything in the table above works on a **stock, unmodified Energica** — including the isolation readings on `0x207` and the allowed-current limits on `0x202`, which the BMS broadcasts as shipped.

The frames below only exist once the pack's LiBAL BMS has been reflashed with the custom config. On a stock bike they simply never arrive, so **these signals being absent is normal, not a fault**:

| Group | Signals | Source |
| --- | --- | --- |
| **Per-cell voltages** | `lmu1_cell1_mv` … `lmu11_cell7_mv` — the individual cells, multiplexed by module at 20 Hz. Known gap: cells 4-8 of LMU 1 and 2 never get sampled, because the CAN transmit order is phase-locked to the BMS's module poll (see `src/can/decode-bms.ts`) | CAN `0x662`–`0x664` |
| **Per-module temps** | `lmu1_bat1_c`, `lmu1_pcb1_c`, `lmu1_pcb2_c` … — each module's battery and board sensors, keyed off the same module number as its cells. Modules 6 and 8 have no battery sensor enabled, so they never report one: configuration, not a fault | CAN `0x664` |
| **Module selector** | `lmu_cell_mux` — the raw module number the per-cell frames are currently carrying, logged so that "byte 0 isn't the LMU number after all" stays distinguishable from "the frames never arrived". Deadbanded to one row per boot | CAN `0x662`–`0x664` b0 |
| **Pack temps** | `pack_temp_avg` (°C), `lmu_temp_high_idx`, `lmu_temp_low_idx`; in the clamp config also the true `batt_temp_lo`/`batt_temp_hi` plus the clamp's own arithmetic (`clamp_gate`, `clamp_amount`, `batt_temp_hi_vcu_echo`) | CAN `0x660` |
| **Energy / hours** | `bms_remaining_energy_wh` (1 Wh resolution), `bms_uptime_min` (BMCU hour meter) | CAN `0x661` |
| **Cell limits** | `cell_cutoff_mv`, `cell_end_of_life_mv`, `cell_overvoltage_mv`, `cell_target_mv` — the thresholds the BMS is actually configured with, so nothing downstream has to hardcode them | CAN `0x665` |

> VIN and BMS writes are still **not** reachable from the OBD port (on the standard pins, haven't tried the other pins yet). Per-cell voltages **are** — they just have to be enabled in the BMS's own configuration first, which needs the vendor's BMS tooling and is not something this repo can do for you.

#### `CUSTOM_BMS_CONFIG` — set this only if you flashed the custom config

The custom config lowers the pack temperatures the VCU reads, so that its DC-charge derate knee — which starts at a reported 36 °C, far too early for a watercooled pack — is not reached while the pack is merely warm. How much lower is not a constant, and depends on which config is flashed. The newest one (`15-bounded-clamp`, built 2026-08-09 and not yet flashed — the bike currently runs `14-signbit-clamp`) is a **bounded** clamp: the true temperature below 35 °C, a flat **35 °C** from 35 to 54 °C, and the **true temperature again from 55 °C up**. That upper bound is the point — the VCU enters limp mode at 55 °C battery (`LIMP_B_TEMP`), and its predecessor `14-signbit-clamp`, which pinned the reading at 35 for _any_ temperature above 35, did not delay that protection so much as disable it. An earlier config shifted by a flat −15 °C instead; it broke charging and is retired. Whichever is loaded, this changes what `0x200`'s temperature bytes mean, so the app has to be told:

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
- `src/gps/` — `decode` (the hub's GPS message, pure; shared by CAN `0x410` and the BLE link, which send byte-identical frames), `clock-gate` (whether a satellite time may be stepped to — also pure, so `scripts/check-gps-clock.ts` can replay real sequences through it), `clock` (the I/O half: reads both clocks and runs `date -u -s`, because the Pi has no RTC).
- `src/ble/` — the Bluetooth link to the Connectivity Hub: `protocol` (framing + handshake, pure), `client` (D-Bus session), `adapter` (bring-up).
- `src/sensors/max31865.ts` — the coolant probes.
- `src/storage/encrypted-log.ts` — the only persistence on the bike: sealed, append-only, write-only.
- `src/db.ts` — SQLite schema (long/EAV: `signal` + `session` + `reading`). Now used **only on the laptop**, by `scripts/decrypt-log.ts`, to rebuild a plaintext DB from decrypted segments. `reading.ts` is a wall-clock stamp and `(session_id, seq)` is the write order; they are separate because the wall clock steps (see [Clock](#clock)), so `ORDER BY ts` is not the order the rows were written. Nothing queries the counter yet and no index covers it — it is recorded so the ordering is _recoverable_, and adding an index over 6.2 M rows is a decision for whoever first needs one.
- `src/http/` — `static` (serves `public/` from memory), `download` (`/dl`), `waypoint` (`/waypoint`), `status` (`/status`).
- `src/ws.ts` + `public/` — the live phone riding dashboard (see below).
- `src/index.ts` — wires it all together.

## The dashboard

Five screens, switched from the tab bar — or by **flashing the high beam three times**, which is the only control that works with both hands on the bars.

| Screen | For |
| --- | --- |
| **Ride** | GPS speed, power, pack and coolant temperatures, **coolant ΔT** with the I²R watts going in beside it, charge |
| **Hypermile** | Weakest cell's headroom above cut-off (instantaneous **and** sag-compensated), the BMS's 60 s cut-off timer, allowed current, rolling Wh/km, resistive loss, all 81 cells as a strip |
| **Charge** | A / V / kW, what the BMS is granting the charger, balancing state, cell spread trend, pack temperature, isolation |
| **All** | Every signal the bike is producing, grouped and filterable. The **buttons** group renders differently from the rest: the handlebar buttons are momentary, and the median press is 140 ms — one or two frames of a 60 Hz display — so a raw 1/0 readout would flicker and be gone. Each button tile latches lit for 600 ms after the bit drops and keeps a press count with the time of the last one. Trust the count over the light: a count that climbs while the tile never visibly lights is a working button whose flash the browser dropped, and a tile stuck lit with a count of 1 is a fault, not a press |
| **Faults** | Stored and active trouble codes, named from Energica's own table, with the history behind each. Carries the ⚠ itself, so a code appearing mid-ride is visible without costing space on the screen you're looking at |

**Ride** and **Charge** are what you leave it on; Hypermile and Charge the bike picks for you. It switches to Charge when the BMS reports a charging state, and to Hypermile below 5 % SOC **or** when the weakest cell drops within 150 mV of cut-off — SOC near empty comes from an OCV table that was never re-characterised for these cells, so it can't be the only trigger. The switch is edge-triggered: once it has moved you, you can move back and it stays put.

Design notes for the hypermiling numbers are in `HYPERMILING.md`; the derivations all live in `public/lib/derive.js` and nothing derived is ever logged.

### No build step

`public/` is plain ES modules that the browser runs exactly as committed — deploy stays `git pull` + restart, with nothing to rebuild and no dist to go stale, and you can edit a file over ssh in the garage. The one dependency is [VanJS](https://vanjs.org) (5 kB, vendored in `public/vendor/`), which is signals over real DOM with no virtual DOM anywhere.

It is still type-checked: `tsconfig.json` sets `checkJs`, and the modules carry JSDoc types that **import the server's own `DashboardMessage` from `src/ws.ts`**. Change the wire shape and `npm run typecheck` fails — which is what stops the two drifting apart.

Bad readings are filtered rather than drawn. Across 7.6 M logged rows the bike has produced `coolant_in` at −242 °C (59 450 rows), `coolant_out` at 988 °C (40 351), `0xFFFF` cell voltages and `high_beam` reading 193 — so `public/lib/bounds.js` gates every signal against a physical range, and a rejected value shows as **sensor fault** instead of being clamped into something plausible.

### Developing it without the bike

```bash
node --experimental-strip-types scripts/replay-capture.ts <capture.log> --speed 4 --skip 60
# → dashboard on http://localhost:8080, fed by the real decoders
```

Replays a `candump -tA` capture through the actual decode path, so what's on screen has taken the same route it does on the Pi.

The captures this was developed against are one motorcycle's ride history and aren't in the repo, so you'll need your own: `candump -tA can0 > capture.log` on the Pi while the bike is awake, and anything from a few seconds up will do. `scripts/decode-dtc-response.ts` does run standalone — it replays a real, committed trouble-code transfer and needs no capture at all.

### Checking it without the bike

```bash
npm test        # about a second; no bike, no can0, no capture
```

Runs the self-checks that replay **committed** fixtures: the trouble-code transfer above, and `scripts/check-vcu-params.ts` (parameter table, request encoding, framing, the live reads, interpretation, the snapshot diff, and the KWP transport against a simulated micro). `scripts/check-button-decode.ts` replays eleven real `0x102`/`0x400` frames — including the two the cruise buttons were ever recorded on and the one the fast-charge contactor closed in — and also guards the three ways this feature could be switched off without anything else failing: `0x400` dropping out of the kernel RX filters, a button key missing from the registry, and a deadband on a 0/1 signal, which stops it logging after the first sample and does so silently. It also runs `scripts/generate-grafana-dtc.ts --check`, which compares the fault-code table Grafana carries inline against `src/diagnostics/dtc-table.ts` — a copy that once went stale for months without anything on screen looking wrong. CI runs the same command on every PR, so a change that breaks a decoder, the parameter table or that dashboard goes red rather than green.

There is no test framework — `scripts/run-checks.ts` runs each check as its own process and fails if any of them does, which keeps them runnable by hand exactly as their own headers document. Anything that opens a CAN socket, wants root, or needs a local-only file is deliberately excluded; that list, with a reason for each, is at the top of the runner.

### Saving a waypoint from Siri

`GET /waypoint` stamps the current fix into the ride log and replies with one line of text, which Siri reads back. To set it up: **Shortcuts → new shortcut → Get Contents of URL → `http://cool-eva.local/waypoint`**, then add **Speak Text** with the result. Name it something like "Mark this spot" and it works from the handlebars.

A waypoint is stored as three ordinary signals (`waypoint_seq`, `waypoint_lat`, `waypoint_lon`), so it travels the normal path into the encrypted log and needs no change to the log format. It refuses to save on a fix older than 30 seconds, and says so rather than silently recording the wrong place.

## Running it

The app is the `cool-eva` `systemd` service on the Pi (Node 24, TypeScript run directly via `--experimental-strip-types`), serving `http://<pi>/` on port 80. First install is under [Setup](#setup); after that, deploying is a pull and a restart:

```bash
git pull && sudo systemctl restart cool-eva
sudo journalctl -u cool-eva -f    # follow logs
```

> ⚠️ **Don't run `npm install` or `npm ci` on the Pi unless a dependency actually changed.** `package-lock.json` is generated on macOS, where `socketcan`'s Linux-only native build is skipped as an optionalDependency; installing against that lockfile on the Pi deletes the real one, and the service then dies on boot with `ERR_MODULE_NOT_FOUND: socketcan`. `npm install socketcan` will insist it's "up to date" even with `--force` — the fix is `rm package-lock.json && npm install` **on the Pi** (~4 min). A plain `git pull` never touches `node_modules` and is always safe.

The sealed ride log can be downloaded from `http://<pi>/dl` — short enough to type on a phone, ~10x smaller than the old SQLite download, and safe to fetch over any network because it's ciphertext. Decrypt it on the laptop (see below) to get a `.db` for Grafana.

### Configuration

Every option is an environment variable, and every default is what the bike in the photo runs. Set them in **`/etc/default/cool-eva`**, one `NAME=value` per line:

```bash
sudo tee /etc/default/cool-eva <<'EOF'
COOLANT_ENABLED=0
EOF
sudo systemctl restart cool-eva
```

Not in the unit file — `scripts/setup-service.ts` rewrites that every time it runs, which is exactly what you do to migrate a Pi or after a Node upgrade, and anything configured there would be silently discarded.

| Variable | Default | What it does |
| --- | --- | --- |
| `COOLANT_ENABLED` | on | `0` skips the MAX31865 probes entirely. Set this on a bike with no watercooling loop. |
| `CAN_ENABLED` | on | `0` skips CAN altogether — coolant probes only. |
| `OBD_ENABLED` | on | `0` makes the bus **listen-only**: broadcasts are decoded, nothing is ever transmitted. Costs you the OBD-II PIDs and the trouble-code list. |
| `ELOCK_ENABLED` | on | `0` skips the one-shot keys-paired read from the E-LOCK ECU at startup. |
| `BLE_ENABLED` | on | `0` skips the Bluetooth link to the Connectivity Hub (torque/power, odometer, vehicle state). GPS also arrives over CAN, so you keep position either way. |
| `BLE_MAC` | discover | Pin the hub's address instead of finding it by advertised name. |
| `GPS_TIME_SYNC` | on | `0` never steps the system clock from satellite time. The Pi has no RTC, so leave it on unless you have another time source. A step needs five consecutive satellite readings that agree — see [Clock](#clock). |
| `CUSTOM_BMS_CONFIG` | unset | Set to `1` **only** if the pack's BMS has been reflashed with the custom config — see [below](#custom_bms_config--set-this-only-if-you-flashed-the-custom-config). Leave unset on a stock bike. |
| `RIDE_LOG_PUBKEY` | `./ride-log-key.public.pem` | Where the sealing key lives. |
| `RIDE_LOG_DIR` | `./ride-logs` | Where sealed `.celog` segments are written. |
| `VCU_PARAM_DIR` | `./vcu-params` | Where service mode leaves parameter snapshots for `/vcu-params` and `/vcu-backup.csv` to serve, and where the write audit journal `service-writes.jsonl` is appended. |
| `SERVICE_MODE_ENABLED` | on | `0` forbids the dashboard from starting a VCU parameter read. That read is the only thing here that puts requests on the bike's bus on purpose; the snapshot is still served and exported either way. The safety gate applies regardless — see [Service mode](#service-mode). |
| `SERVICE_WRITE_ENABLED` | **off** | `1` lets the dashboard **change** things on the bike: five allowlisted calibration parameters, the service point, the bike's clock, and the stored trouble codes. ⚠️ The only switch here that is opt-**in** — everything else defaults on and takes a `0` to disable — so a Pi nobody has told about it cannot write to a motorcycle's EEPROM. Separate from `SERVICE_MODE_ENABLED` on purpose. See [Changing something on the bike](#changing-something-on-the-bike). |

### Grafana

The whole path from a ride to a chart, on the laptop. Grafana reads a plaintext SQLite file, and the bike only ever produces sealed segments, so decrypting is a step you cannot skip:

```bash
# 1. park within wifi range and pull the sealed log off the bike
curl -O http://cool-eva.local/dl        # or just open http://cool-eva.local/dl on your phone

# 2. decrypt it into the file the datasource expects. Needs the PRIVATE key
#    from step 6 of Setup, in the current directory.
node --experimental-strip-types scripts/decrypt-log.ts cool-eva-2026-08-01.celog --out rides.db

# 3. Grafana at http://localhost:3000 — no login, dashboards already provisioned
docker compose up -d
```

The datasource points at `/repo/rides.db` (`grafana/provisioning/datasources/sqlite.yml`), which is this repo's directory mounted into the container — so `rides.db` must sit at the repo root. Decrypt more `.celog` files into the same `rides.db` later and they append; every panel says **No data** until step 2 has run at least once.

Six dashboards are provisioned from `grafana/dashboards/`, one file each:

- **Cooling** (`cooling.json`) — ΔT across the pack, heat removed against an assumed coolant flow, inlet/outlet/ambient, per-module temperatures, powertrain temps.
- **Battery & cell balancing** (`battery-cells.json`) — per-cell voltage and per-module temperature heatmaps, spread over time, the cell limits the BMS is actually configured with.
- **Ride summary** (`ride-summary.json`) — speed, power, torque, energy, peak temperatures, position, bike state.
- **Charging** (`charging.json`) — charge sessions, charger mains and DC side, the BMS system-state lanes.
- **Isolation & faults** (`isolation-faults.json`) — the BMS isolation test in raw ADC counts, the error and warning flags, the stored diagnostic code counts, the BMS IO lines.
- **Explore & data health** (`explore.json`) — every logged signal, a browser over the whole registry, and how long each signal has been quiet.

`grafana/README.md` collects the datasource and panel traps that querying log-on-change data in this plugin keeps producing — read it before writing a new dashboard.

### Clock

The Pi has no RTC. Without a network it boots with whatever date the filesystem left behind, so satellite UTC off the Connectivity Hub is the only real time source out on the road, and the service steps its own system clock to it (`date -u -s`).

Trusting a single frame to do that turned out to be expensive. A corrupted year byte reading 60 decoded as **2060**, the clock was stepped 34 years forward, and the five-minute anti-thrash cooldown then blocked the correction that would have undone it — so one bad frame cost five minutes of rows, not one row. Four such frames are in the history and two of them landed while the service could set the time: **49 772 rows in `rides.db` are stamped 2060** because of them.

What decides a step now (`src/gps/clock-gate.ts`, pure, replayed against the real frames by `scripts/check-gps-clock.ts`):

- **Five consecutive readings must agree**, each within 3 s of the others once carried forward by the **monotonic** clock. The corruption is always a single frame — the frames either side of all four are sane — so a lone bad one can never corroborate itself. Costs 1.4–5 s of a cold boot.
- **A floor, and no ceiling.** Nothing before 2026 is a real fix (that catches the GPS week-number rollover, which reads 1980 or 1999, and a zeroed date field, which reads 2000). There is deliberately **no upper bound on the calendar** — a "2024 to 2035" window would just be a fix with an expiry date. 2060 is refused because nothing agrees with it, not because 2060 is a year we disbelieve, and the check proves that by replaying every case ten years on and requiring identical verdicts.
- **Cold boot is not drift.** With no confirmed time yet, a step of many hours is expected and allowed — two real ones in the history are 20 h 46 m and 20 h 38 m. Once there _is_ a confirmed time, a candidate must also stay within 10 s of it carried forward, which is what refuses a 34-year jump mid-session. That anchor expires after 5 minutes without reconfirmation, so a session can always re-derive its time rather than being locked out.
- **The cooldown is recoverable.** It still holds off small corrections so we don't fight `systemd-timesyncd`, but a disagreement over an hour bypasses it — that is not thrashing, that is a broken clock, and waiting it out is what made one frame cost five minutes.
- **Refusing to sync is not allowed to be quiet.** Every non-step state is one the clock could in principle sit in forever, so the reason is logged on every change and repeated every 5 minutes while it persists — a window that keeps contradicting itself warns, rather than looking exactly like the two seconds of start-up that print the same line.

Satellite count deliberately is **not** part of this. It reads 9 and 10 at the corrupt frames, against a population where 41 % of all readings are below 8, so no threshold separates them; the floor of 4 in the decoder stays as a receiver sanity check. The wall clock is only one of the two clocks recorded anyway — `gps_epoch_s` is logged raw against every row's own timestamp, and every row now carries a write-order counter as well (see below), so both order and true time stay recoverable even from rows already stamped wrong.

### Encrypted ride log

A stolen bike is a stolen SD card, and the log holds every route you've ridden — including the one that ends at your front door — plus the ID of the key fob that starts it. So the Pi can be given a **public key only**: it seals every reading it writes and cannot read any of it back.

Set it up once, on the laptop:

```bash
node --experimental-strip-types scripts/generate-log-key.ts   # writes both keys
# back the PRIVATE key up (password manager) — it is the only thing that can ever read the logs
scp ride-log-key.public.pem pi@cool-eva.local:/home/pi/cool-eva/
```

The pair is generated on the laptop and never on the Pi, deliberately: the bike is supposed to hold a public key only, and a Pi that generated the pair would have had the private half on the SD card — which is exactly what the sealed log exists to make worthless. `scripts/setup-service.ts` checks for the key and prints these commands with your hostname filled in if it's missing.

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

> ⚠️ Decrypting **appends** into whatever `--out` names, so point it at a fresh file rather than at an existing archive you care about. The Grafana datasource reads `/repo/rides.db`, which is why the walkthrough above uses that name. The sealed log is also **~10x smaller** than the equivalent SQLite (gzip before encryption, and crypto overhead is per 30-second segment rather than per row).

Each segment uses a fresh ephemeral X25519 key (ECDH → HKDF-SHA256 → AES-256-GCM), so compromising the Pi cannot retroactively decrypt anything already written. Segments are independently sealed, so damage is contained: the reader resyncs on the next segment and reports what it couldn't read rather than stopping. **There is deliberately no recovery path: lose the private key and every logged ride is gone forever.** That is exactly what makes the SD card worthless to a thief.

#### What this does and doesn't hide

Holds up: the readings themselves — routes, coordinates, the key-fob ID, everything in the tables above. Whoever takes the SD card, or intercepts a `/dl` download, gets ciphertext.

Does not:

- **Timing metadata leaks.** Filenames are `rides-YYYY-MM-DD.celog`, and sizes scale with how much was logged. That reveals which days the bike moved and roughly for how long, without revealing where. Since the motivating worry is someone learning your habits, that's worth knowing.
- **No cross-segment integrity.** Each segment is authenticated on its own, so tampering within one is detected — but segments can be deleted or reordered without the reader noticing. It protects confidentiality, not completeness.
- **`/dl` is unauthenticated** on port 80, like the rest of the server. The payload is sealed, so the exposure is the metadata above rather than the data — but it's a wider audience than "whoever holds the SD card".

## Trouble codes

The bike keeps two completely different fault lists, and the Faults tab shows them apart because merging them would be wrong:

|  | What it is | How many, right now | Where from |
| --- | --- | --- | --- |
| **Active** | What the bike says is wrong _at this moment_. It flickers — one code was present on 2 of 8 consecutive polls at a standstill | 0-1 | Connectivity Hub message type 25, over Bluetooth and mirrored onto CAN `0x410` |
| **Stored** | Everything that has _ever_ been wrong and not been cleared. It only climbs | **39** | OBD-II **mode 03**, over ISO-TP |
| **Pending / permanent** | Would be OBD-II modes 07 and 0A | — | **no response.** See below |

Mode 03's reply is 80 bytes, so it needs ISO-TP: a First Frame, a flow-control frame back from us, then eleven Consecutive Frames. `src/can/iso-tp.ts` reassembles it and `src/diagnostics/obd-dtc.ts` decodes it — both pure, bytes in and codes out, so a captured transfer replays on a laptop:

```bash
node --experimental-strip-types scripts/decode-dtc-response.ts
# → replays a real 2026-08-04 transfer and checks it still decodes to the same 39 codes
```

Codes are named from Energica's own type-approval table, reconciled against the manufacturer's service-tool copy of it (`src/diagnostics/dtc-table.ts`, 154 codes). All 39 of this bike's are in it. **Mode 01 PID 02** — the freeze-frame code, i.e. the one the bike captured when it lit the lamp — reads `P0514`, _"Error reading temperature"_, which is why the warning light is on.

**Modes 07 and 0A return nothing at all** — silence, not a refusal, across six attempts. That means "not implemented" and "implemented but withheld" cannot be told apart from here, so the dashboard says **"no response"** rather than "none pending". Those are different claims and only one of them is true.

The transfer is not reliable — the First Frame arrives every time and the Consecutive Frames sometimes never do, at somewhere between 25 % and 70 % per attempt. It is retried, and it is read once a minute from inside the sequential OBD poll loop so nothing else of ours is on the bus while it runs.

## VCU parameters, by name

The VCU's calibration EEPROM — throttle maps, cell limits, current thresholds, the charge-current ceilings — is readable off the bus **by name, with no authentication**. The two micros serve it as KWP bank 1, and the mapping is simply `CommonIdentifier = 0x1000 | index`, where the index is the row number in Energica's own `params.ecf` parameter file. Parameter _n_ is `22 [0x10|hi] [lo]`.

`src/vcu/param-table.ts` carries a copy of that file — 277 names, widths and micro assignments — so nothing depends on a path in one person's iCloud folder. **Its values are another bike's**: the file came from a different variant, and 21 of the 233 parameters the A9 serves read differently here (`MAX_DC_CHG_CURRENT` is 75 A on this bike against the file's 60). It is a name table, and the column showing its values is labelled as another bike's everywhere it appears.

### Service mode

Reading them is a thing you **do**, from the phone: **Menu → Service mode → `🔧 Read VCU parameters from the bike`** (two taps — the first arms it). Live progress, `⏹ Stop`, and then `⬇ Export N parameters as vcu_backup.csv`, which is byte-compatible with another owner's `energica_tool.py`.

**It only starts with the bike proved parked**, and it stops by itself if that stops being true. `src/vcu/service-gate.ts` requires road speed zero on CAN `0x104`, the motor at zero rpm, the VCU's own `moving` bit clear, and `go` / `go_request` / `throttle_on` clear — every one of them fresh, from 100 Hz broadcasts. OBD PID `0D` corroborates the speed when it is answering. Anything stale, missing or contradictory refuses: the gate fails closed, so a bus that has gone quiet reads as "I cannot tell", never as "it is fine". The same check runs again before **every single request** the sweep sends, and a watchdog re-runs it five times a second, so riding away ends the read rather than racing it.

**Stationary and charging is allowed**, deliberately — you cannot test a DC charge-current limit on a bike that is not plugged in. While the charger's own frames (`0x305`/`0x306`) are arriving, two things relax: `energized` may be set, because a charging bike's HV side is up by definition; and `speed_can_kmh`/`motor_rpm_can` may be absent, because the bike stops broadcasting `0x104` while it charges. Nothing else relaxes — the `0x102` bits must still be live and clear, and a fresh speed reading that says the wheel is turning still refuses.

### Probing one identifier

The sweep covers the 277 parameters `src/vcu/param-table.ts` describes: bank 1 on the two VCU micros. **Menu → Service mode → Probe one identifier** reaches anything else — pick the micro, the bank and the index, and it reads that one. What lives out there and nothing here could reach before: **bank 2 is live data** rather than stored settings. Same header, same gate and same single-flight as a sweep.

> ⚠️ This briefly offered a **charge manager** target, on CAN `0x7C3`/`0x7E3`. That pair is wrong and has been removed: **`0x7E3` is the dashboard's request id**, so the option could have questioned the dashboard while the page said otherwise, and `RequestFrameIDs.CHM = 0x7C3` turns out to be a dead enum the manufacturer's own code references nowhere. Node `0xA4` is the charge manager's real 11-bit identity, but the ECU actually answers on **29-bit ISO-TP** — request `0x18DA09F1`, response `0x18DAF109` — which needs `ext: true`, its own RX filter and its own addressing math. That is a feature rather than a constant, so the target is gone rather than re-pointed; the full note is above `VcuTarget` in `src/vcu/param-codec.ts`. Whoever adds it should know it is **off-bus when parked** (it answers only during a live charging session), that identification reads need no SecurityAccess, and that its deeper access uses a CRC-16/CCITT algorithm that is **not** the VCU's bit-swap.

**It is on demand, never automatic.** These are configuration: they do not move while riding, so logging them as time series would spend SD-card writes re-recording constants, and 277 more keys in the WebSocket snapshot would cost every dashboard update. Nothing starts a sweep at boot, on a timer or per page load. What is worth knowing is that one _changed_ — so every run diffs against the previous snapshot and says so loudly in the journal. `GET /vcu-params` and `/params.html` serve that snapshot from disk and **never touch the bus**.

A sweep survives being interrupted: each row is appended to `vcu-params/sweep.partial.jsonl` as it arrives, and starting another one resumes from there rather than beginning again — so a stop, a gate exit or a `systemctl restart` costs only the parameters not yet read. Snapshots are gitignored — they are one motorcycle's — while the name table needed to take your own is committed.

```bash
node --experimental-strip-types scripts/check-vcu-params.ts   # on a laptop, no bike:
                                                              # codec, name table, backup CSV, the safety gate,
                                                              # and the whole write path
```

### Changing something on the bike

> ⚠️ **Nothing in this section has ever been transmitted by this repo** (as of 2026-08-16 — the bike is away for about a week). The write _service_, its framing and its authentication rule are proven: `obd-garage/DIAG_ADDRESSES.md` §9 is a passive capture of **Energica's own diagnostic software** writing to this bike's A8, and `obd-garage/VCU_PARAM_CHANGES.md` records five parameters written to this bike with a scratch tool on 2026-08-09, surviving a power cycle. What has not been exercised is _this code_. Treat every claim below as reasoning until a real bike answers.

Writing is **off unless you ask for it**: `SERVICE_WRITE_ENABLED=1`. It is the only switch here that defaults to off, and it is separate from `SERVICE_MODE_ENABLED` on purpose — reads and writes are not the same risk and must not share an off button.

What may be written is a **closed allowlist of five parameters**, in `src/vcu/write-targets.ts`, each with its own range:

| parameter | reads | may be set to | why it is on the list |
| --- | --- | --- | --- |
| `MAX_DC_CHG_CURRENT` (258) | 75 A | 0…80 | Energica's own 60/75/80 A options write **this byte and nothing else**, so 80 is a value the factory shipped. |
| `FCHG_CURRENT_GAIN` (259) | 225 | 0…512 | ⚠️ Meaning genuinely unknown — see below. |
| `TORQUE_LIMIT` (48) | 230.0 Nm | 0…276.0 Nm | 0.1 Nm per count. The ceiling is +20 %, this repo's policy, not a measured limit. |
| `REGEN_TORQUE_LIMIT` (49) | 60.0 Nm | 0…90.0 Nm | Likely clipping against `REGEN_CURRENT_LIMIT` (120 A) anyway. |
| `VSM_CONFIG_1` (16) | `0x1113` | **one bit only** | Heated handlebars, mask `0x0004`. |

Anything not on that list is rejected **in the pure codec**, not in the UI — `planWrite("CELL_OVERVOLTAGE", …)` returns a refusal that names what _is_ writable, and `src/vcu/write-codec.ts` re-derives the plan from the allowlist immediately before building the frame, so a plan assembled by hand or arriving over HTTP cannot become bytes. `VSM_CONFIG_1` is offered as a **bit toggle and never as a word**: the same word carries the PSU type (`0x0760`) and the Bluetooth variant (`0x3000`), and a fat-fingered word write would reconfigure both. The new word is computed from the one the bike currently holds, and the pure layer asserts that only the one mask moved.

Every write is a **compare-and-swap with a read-back**:

```
10 81   open a session          22 CID   read what it holds NOW  →  refuse if it is not what you were shown
27 01 / 27 02   unlock          2E CID   write                   ←  must follow the unlock within ~2 s
                                22 CID   READ IT BACK            →  a mismatch is reported, loudly
```

The `2E` positive reply never carries the written value, so "the micro accepted it" is not the same claim as "the cell holds it" — and another owner's tool has a message for exactly that gap. Nothing here reports success without a read-back. Every attempt, **including the refused ones**, is appended to `vcu-params/service-writes.jsonl` with the before and after values.

⚠️ **SecurityAccess is the scarce resource.** About three bad attempts lock the micro until the bike is power-cycled, and asking an _already-unlocked_ micro for a seed also counts as a bad attempt — so a four-second cooldown sits between authenticated operations. The seed→key algorithm is checked against **four real seed/key pairs captured off this bike's own bus**, which is the only live ground truth in the whole write path.

**The four service actions**, in the same section:

- **Read the last-service stamp** — A8 bank 1, ids 1000-1003, a 32-bit count of seconds since 2000-01-01 UTC plus a 32-bit odometer. Read-only. ⚠️ Untried: these four sit outside `params.ecf`'s 1…277, so no sweep has ever reached them, and a refusal may simply mean this bike has no service stamp. They are deliberately **not** logged as signals — reading them costs a KWP session, and they move about once a year.
- **"Service was performed now"** — `31 FC` on A8, after SecurityAccess. ⚠️ **Irreversible**, and it takes no parameters: the firmware stamps its _own_ clock and odometer, so read the stamp and fix the bike's clock first. The routine id is **not user-enterable anywhere** — the codec takes a _name_ from a one-member union, so `31 FB` (which wipes battery statistics) has no way to be expressed. The positive response `71 FC` is inferred rather than logged, so an unexpected reply is reported as _outcome unknown_, never as success.
- **Sync the bike's clock** — one raw broadcast on CAN `0x120`: `94 FF` plus five bit-packed bytes of **UTC**. Not a diagnostic service at all, and there is no session, no authentication and no reply. The packing is checked against two frames that really went out on 2026-08-16. ⚠️ **This Pi's clock has to earn it**: the sync is refused unless satellite time has arrived recently and agrees, and unless the clock falls in a plausible absolute window — a GPS date-decode bug once stamped 49 772 rows of this bike's log as the year 2060. The confirmation asks _"Is it &lt;date and time&gt;?"_ and the Pi re-checks that the confirmed minute has not passed. There is **no way to read the bike's clock back**, so this is the one action nothing can verify.
- **Clear stored trouble codes** — OBD Mode 04. ⚠️ **Irreversible**, and the first thing in this project that changes ECU state outside the parameter table. This bike's stored list has been accumulating since before anyone started looking; the freeze frame goes with it.

The UI makes an accidental write hard in four ways: you cannot write until you have **read the current value** (it becomes the compare-and-swap precondition), the confirmation **spells out old → new**, it takes **two taps** and _any_ change to the form disarms it, and the irreversible actions sit in their own block with their own arming.

⚠️ **`FCHG_CURRENT_GAIN` deserves its own warning.** Its direction of effect is unknown, and this is a real 50/50 rather than a gap someone forgot to close. If it is a _measurement calibration_ — which the name argues for — then raising 225 → 255 makes the bike believe it is drawing ~13 % more than it is, and it would back off **sooner**, not later. It might instead be a gain in the charge PID loop, in which case it changes loop dynamics and can oscillate. The arithmetic that produced 255 in the first place (`75 × 225/255 = 66.18 A`) has since been **retracted**: the wire request was measured at 75 while 66.2 A flowed, and 73.2 A was delivered on another day with no parameter change. Change one thing per charge session.

## Notes

- The CAN bus is **read-only unless you switch writing on**. Everything that runs by itself — passive broadcast decode, the OBD-II poller, the trouble-code reads, the KWP `0x22` parameter reads — cannot change anything in an ECU, and is built so it cannot express one: `src/vcu/param-codec.ts`'s request union has three members and nowhere to put a value, and `src/can/obd-dtc.ts` can emit only modes `03`, `07` and `0A`. That is unchanged and is meant to stay that way. The writes live behind `SERVICE_WRITE_ENABLED`, which is **off by default** — see [Changing something on the bike](#changing-something-on-the-bike). `0x11` ECUReset, `0x2F` InputOutputControl (the factory tool's actuator-test channel), `0x3B` and `0x3D` are implemented **nowhere**, and should stay that way.
- Coolant history predating the CAN integration is preserved (migrated into the current schema; the original table is kept as a backup).
- Any `temperatures.db` left on the Pi from before the encrypted log is **plaintext history** — copy it off and delete it from the bike, or the SD card still gives up every route you rode before the switch.
- The one thing that _does_ write to the bike is the Bluetooth handshake: enrolling with the Connectivity Hub claims its single authorised-device slot, and after several unanswered attempts the client also tries the hub's own address. If the bike is already paired to something else, that pairing can be replaced, and the way back is clearing the stored device from the bike's own dashboard. `BLE_ENABLED=0` avoids the whole question.

## Licence

AGPL-3.0 — see [`LICENSE`](LICENSE). It reverse-engineers a vehicle you own and talks to safety-relevant hardware; there is no warranty of any kind, and what you plug into your own motorcycle is your responsibility.
