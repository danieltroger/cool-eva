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

- It is developed against a **2021 Eva Ribelle**. The pack shape is hardcoded in places — 81 cells in 11 modules, a 400 A discharge and 120 A regen ceiling, a 130 kW power bar — and nothing detects a mismatch. On another bike in the same pack family the readings are right and those scale limits may not be; on a differently-packed model (Experia) treat the whole thing as untested. Reports welcome. The **VCU parameter names are not** in that category any more: all 28 of Energica's parameter tables are shipped and the bike's own `TABLE_TYPE` picks one, so [that half works on your bike](#vcu-parameters-by-name) whichever it is — and if your table is newer than the 28, [adding it is one command](#adding-your-bikes-vcu-parameter-table).
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
| **BMS state & faults** | `charge_state` (raw System State bitfield) + decoded `bms_state_*` (discharge / charge / balancing / trickle / idle / charge complete / maintenance), `bms_error_flags`, `bms_warning_flags` (raw words) + booleans for the ones worth acting on: cell over/under voltage, over temperature, leak detected, leak detection failed, contactor faults, low SOC, balancing required. Plus `bms_leak_detect_inhibit` — the vehicle telling the BMS to stop isolation-monitoring for the duration of a DC session, since that monitor cannot run against a station-driven bus. It is 1 on DC and 0 on AC in 100.000 % of 43 994 frames, with no exception in either direction | CAN `0x201`/`0x605` b7 |
| **Isolation** | `iso_test_1`, `iso_test_2`, `iso_test_total` (10-bit ADC, 512 = ideal), `bms_io_state`, `lmu_comm_warnings` | CAN `0x207`/`0x206` |
| **Charge** | `charge_state`, `dc_v`, `dc_a`, `mains_v`, `mains_a`, `charge_limit_a`, `dc_charge_limit_selected_a`, `charger_enabled`, `charger_max_dc_v`, `charger_max_dc_a`, `bms_post_processor_1` (purpose unknown, logged raw so a ride can name it), `fast_dc_contactor` — the DC fast-charge contactor monitor (Energica's `V_FASTDC_MON_SW`, and the analog wire `A020_FCHG_MON`). It is 1 only on DC: across 1.1 M frames of `0x102` it was set in exactly one interval, a 17-minute DC session that took the pack 30 → 42 %, and 0 through every AC charge including a 48-minute one at 14 A. It rises ~190 ms before `charger_enabled` and ~470 ms before the first amp, which is what a contactor monitor should do. **From the charge manager** (decoded 2026-08-19 across 29 charge sessions, 18 AC and 11 DC — that ECU is only awake with a cable plugged in, and the standing assumption that this meant DC only was wrong): `fast_dc_a` — the DC fast-charge current, and the only one on this bus, since a DC session sends no `0x305`/`0x306` at all and `charge_limit_a` reads 0 through one; `fast_dc_limit_a` and `ac_supply_limit_a`, the ceilings for each path, each 0 while the other path is live; `fast_dc_limit_max_a`, the fixed 75 A that is `MAX_DC_CHG_CURRENT`; `dc_charging` / `ac_charging`, which say current is _flowing_; `charge_type` (1 = AC, 2 = DC) and `charge_manager_state`, which say a _session exists_ — `0x610` b7 reads `0x23` on DC and `0x02` on AC in 100.000 % of 44 444 frames and is the cleanest AC/DC discriminator on the bus; plus `charge_manager_status`, `charge_manager_pack_v` (the charge manager's own coarser view of pack voltage, 1 V/count) and `charge_manager_soc` | CAN `0x201`/`0x305`/`0x306`/`0x10a`/`0x300`/`0x102` b3/`0x121`/`0x605`/`0x610`/`0x615`/`0x620`/`0x625` |
| **Energy** | `inst_consumption_wh`, `residual_energy_wh` (available energy), `bms_remaining_energy_raw`, `remaining_ah`, plus the hub's own trip figures: `range_km`, `avg_consumption_wh_km`, `km_per_kwh`, `kwh_per_100km` (the last two emit nonsense at a standstill and are gated on the dashboard) | CAN `0x025`/`0x10A`/`0x205` + hub |
| **Energy, the bike's own figures** | `km_per_kwh_can`, `kwh_per_100km_can` — the VCU broadcasts its instantaneous consumption at 10 Hz, both ways round, and the two are exact algebraic reciprocals of each other, which is what pins the frame's layout and both scalings with no bike involved. Separate keys from the hub's pair above, for the same reason `odometer_can_km` is separate. **Sparse on purpose**: the VCU saturates the pair whenever consumption is undefined — standing still, or coasting — and those frames are dropped rather than logged as 65 kWh/100 km. 🟡 `km_per_kwh_100m_can`, `kwh_per_100km_100m_can` are the 100 m averages; a garage lap only ever produced two values for them, so their scaling is carried over by position rather than confirmed. See `src/can/consumption.ts` | CAN `0x10B` |
| **Drive** | `throttle_pct`, `speed_kmh`, `motor_rpm`, `motor_load_pct`, `dist_since_clear_km`, `motor_torque_nm`, `motor_power_kw` (Bluetooth only — on no CAN frame and no OBD PID we know of), `odometer_km`, `trip_km`, `vehicle_state`, `vehicle_substate` | CAN `0x109` + OBD-II `0D`/`0C`/`04`/`31` + hub |
| **Drive, second opinion** | `speed_can_kmh`, `motor_rpm_can`, `odometer_can_km`, `reverse_gear` — deliberately **not** merged into the keys above, because comparing the two over a ride is the point and one key with two writers just flaps. Plus the inverter's own limits `current_max_out_a`, `current_max_regen_a`. 🚨 `current_other_a` is **gone**: 0x109 b6-7 is not a current at all — it is Energica's ride-map-and-events bitfield, and the .xdbc reading produced 5069 A. It is replaced by `tc_event` and `eabs_event`, the VCU's own traction-control and eABS interventions, ✅ confirmed by behaviour (`tc_event` fires at 77 % throttle and +138 Nm median, and separates torque even within one throttle band) | CAN `0x104`/`0x109` |
| **ABS & brakes** | All ten signals Energica's own `ParseABS_INFO` names. `wheel_speed_front_kmh`, `wheel_speed_rear_kmh` — the ABS module's own two wheels, the only front-wheel measurement on the bike, and ✅ **calibrated against GPS to ~1 %**: Energica's 0.05625 km/h per count is 3.6/64, a wire encoding, and it stands (an earlier claim here that the channels read ~4 % off and disagreed by ~9 % was an artefact of a walking-pace garage lap, and is withdrawn). `front_brake_pressure_bar` — **brake line pressure**, which nothing else here carries; ✅ front-specific by measurement, held at 0 bar through 434 frames of rear-pedal-only braking while the front lever alone drove it to 8. `abs_warning_lamp` (a two-bit field, 0…3, not a flag — it is the self-test, and it needs road speed to clear). Plus six flags: `abs_event`, `abs_rear_control_active`, `abs_front_control_active` — ✅ all three measured firing, over **162 event frames in 61 interventions across 15 captures** (the whole archive, 565 376 frames of this ID, rescanned 2026-08-20); `abs_front_sensor_fault`, `abs_rear_sensor_fault`, `abs_front_pressure_validity` — ⚠️ never seen set in any of those 565 376 frames, which is what a healthy bike with a working decode looks like, not evidence against the bit positions. ❌ **What causes an intervention is NOT settled and the earlier regen-slip reading here is withdrawn:** the throttle is _open_ at 117 of the 162, and traction control is refuted as the alternative — drive torque is cut in 0 of 93 throttle-open interventions. The braking population (35 of 162 carry front brake pressure, 1–21 bar) is the only one whose cause the throttle, the torque and the wheel divergence all agree on. ❓ `abs_front_pressure_validity`'s **polarity is unestablished** and the pressure is deliberately not gated on it. ⚠️ The pressure's "bar" is Energica's stated unit with nothing on the bus to check it against. The ABS is physically on the **DTB** bus, not the VDB one we tap — `0x0A0` only reaches us because the VCU gateways it — so these ten are the entire ABS interface and no diagnostic sweep can ever add to them. See `src/can/abs.ts` | CAN `0x0A0` |
| **Torque, and the redundant sensor pairs** | `drive_torque_cmd_nm`, `drive_torque_feedback_nm` — what the inverter was asked for and what it delivered, in Nm; the 0.1 Nm scale is stated by Energica and independently forced by the power balance. `throttle_sensor_a_raw`, `throttle_sensor_b_raw` — the throttle position sensor's two channels as 12-bit counts, which track within [−143, 0] of each other; a divergence is what `P0120`/`P0121` exist to report. `speed_redundant_a_raw`, `speed_redundant_b_raw` — the safety micro's two road-speed channels, byte-identical in 88 % of frames. ⚠️ Those last two are **raw counts with no unit**: they correlate with road speed at r = +0.997 but no round scale survives the capture (~109 counts per km/h, which is nothing in particular), so they are not published as km/h. See `src/can/drive.ts` | CAN `0x02C`/`0x127`/`0x125` |
| **VCU error & status flags** | `vcu_flags_low`, `vcu_flags_high` — the VCU's own 64-bit flag word, logged raw in two halves so no flag is ever lost, plus booleans for the ones worth an alert: `vcu_err_charge_manager`, `vcu_err_check_modules`, `vcu_check_modules_status`, `vcu_warn_soc_misaligned`, `vcu_12v_power_good`, `vcu_err_system_fault`, `vcu_err_system_fatal_fault`, `vcu_err_system_blocking_fault`, `vcu_err_battery_ot`, `vcu_err_motor_ot`, `vcu_err_drive_ot`, `vcu_err_leak_detect`. **`vcu_err_charge_manager` is the useful one**: the charge manager's own error telemetry is not broadcast at all and needs a diagnostic session, but this summary bit is, so a charge-manager fault becomes visible passively. ⚠️ It reads **0 in all 105 736 captured frames**, including a complete DC fast charge — well-formed, never seen to fire, and the same is true of seven of the other booleans. Four bits have been watched moving, one of them landing on the exact second a DC session was unplugged. See `src/can/vcu-flags.ts` | CAN `0x100` |
| **12 V supply** | `psu_12v_mv` (validated against the engineering menu), `psu_12v_lowpower_mv` (a second rail that sits at ~9.03 V despite the name), `psu_12v_load_ma` — the DC-DC's own output current, confirmed by every consumer that switched during a lap showing up as a step of the right size: high beam +1788 mA, blinker +1030 mA, brake light +693 mA. 🟡 The mA scale itself is inferred from the millivolt rail beside it, not measured. `P_TEMP` in the same frame is deliberately **not** decoded — Energica's own equation for it gives 390 °C. See `src/can/psu.ts` | CAN `0x501` |
| **GPS** | `gps_lat`, `gps_lon` (emitted only when both axes arrived in the same sub-frame cycle — a half-fresh fix is withheld, not blended), `gps_altitude_m` (16-bit two's complement, so −1 m reads as −1 m), `gps_speed_kmh`, `gps_course_deg`, `gps_satellites`, `gps_fix`, `gps_epoch_s` (satellite UTC, logged raw — the Pi has no RTC, so a no-network boot's timestamps stay repairable). Arrives over **both** transports; position is not Bluetooth-only | CAN `0x410` + hub over BLE |
| **Powertrain temps** | `inverter_igbt_min_c`, `inverter_igbt_c`, `inverter_igbt_max_c`, `inverter_gate_c`, `motor_temp_c` (°C) — separate sensors from the OBD poller's `bike_coolant_temp`, and they move differently under load | CAN `0x020`/`0x022` |
| **Controls & vehicle state** | `high_beam_lamp`, `low_beam_lamp`, `brake` (front **or** rear — the continuous key since June; the halves are in the row below), `horn`, `energized`, `go_request`, `go`, `key_on`, `stand_up` (sidestand retracted), `ignition_button`, `throttle_on`, `moving`, `cruise_active` (cruise control armed — inferred, not in any vendor table, from two events where it followed the cruise ON/OFF button by half a second). ⚠️ The two beam lamps were logged as `charging` and `charge_port_unlocked` until 2026-08-16, on a rider-made `.xdbc`'s word: **both names were simply wrong.** Each agrees with its beam switch in `0x102` b0 across all 1 103 000 frames of the capture corpus with zero disagreements, and the old `charging` bit reads 0 through every real charge. Old rows are correct readings under a wrong name, so the Grafana State panel unions the old key into each lane and the history stays continuous | CAN `0x102` |
| **Rider controls** | Everything the rider's hands and feet move, in one group so the dashboard can show them together. The **buttons**: `btn_mode_left`, `btn_mode_right`, `btn_mode_enter`, `btn_indicator_cancel` (left pod, as VCU discretes), `btn_set_back`, `btn_cruise_enable`, `btn_cruise_set`, `btn_heated_grip` (dashboard inputs) — momentary and short, the median press measured 140 ms and the shortest 30 ms. The **held states**, added 2026-08-19: `high_beam` (b0 bit 6, the switch, which is also how you change dashboard screens), `blinker_left`, `blinker_right` (the lamp outputs, which flash rather than stay on), `front_brake` and `rear_brake` (b2 `0x20`/`0x40`, two keys because they are two circuits — captured frames carry both at once, and the rear pedal alone leaves `front_brake_pressure_bar` at 0). The dashboard latches all of them for 600 ms, counts presses, and describes a hold by its duration instead once it passes a second; see [The dashboard](#the-dashboard). **Confidence varies per bit and is written down next to each one in `src/can/decode.ts`**: indicator-cancel and the two cruise buttons are confirmed by what they correlate with, the MODE pair is confirmed as menu buttons **and, since 2026-08-19, as left-vs-right** (by instructed press: eight presses of each button in turn, every block fenced by a counted number of indicator-cancel clicks so the capture labels its own blocks), `btn_set_back` was first seen set that same day, and `btn_heated_grip` has still never been seen set at all — which is expected, since this bike has no heated grips. The b0 indicator **switches** are deliberately not decoded — decode.ts records that b0 bit 3 is right and bit 4 is left, measured over 14 650 573 frames, for whenever something needs them | CAN `0x102` b0/b2 + `0x400` b2 |
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
| **All** | Every signal the bike is producing, grouped and filterable. The **buttons** group renders differently from the rest: the handlebar buttons are momentary, and the median press is 140 ms — one or two frames of a 60 Hz display — so a raw 1/0 readout would flicker and be gone. Each button tile latches lit for 600 ms after the bit drops and keeps a press count with the time of the last one. Trust the count over the light: a count that climbs while the tile never visibly lights is a working button whose flash the browser dropped. Since 2026-08-19 the group also holds the indicators, the high beam and the two brakes, which are **not** momentary, so a tile down for over a second says how long instead ("held 4 s") — a clock reading rather than a list of which keys are held states, because the populations overlap in both directions. That also retired the old "a tile stuck lit with a count of 1 is a fault" rule, since it is now what a squeezed brake lever looks like; the duration under the tile is what separates a lever from a stuck bit. The blinkers are the one hand-named exception, because they are lamp outputs that a running indicator toggles, so counting rising edges would overreport a signalled turn by about 6×. The measured durations, the blink rate and the gap histogram behind the thresholds live next to the constants they justify — `public/lib/press.js` and `public/lib/flasher.js` — rather than being restated here |
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

Runs the self-checks that replay **committed** fixtures: the trouble-code transfer above, and `scripts/check-vcu-params.ts` (parameter table, request encoding, framing, the live reads, interpretation, the snapshot diff, and the KWP transport against a simulated micro). `scripts/check-button-decode.ts` replays eighteen real `0x102`/`0x400` frames — including the two the cruise buttons were ever recorded on, the one the fast-charge contactor closed in, the frame the right indicator lamp lit on, and the rear-brake-only frame that closed an open question in `src/can/abs.ts` — and also guards the three ways this feature could be switched off without anything else failing: `0x400` dropping out of the kernel RX filters, a button key missing from the registry, and a deadband on a 0/1 signal, which stops it logging after the first sample and does so silently. It additionally walks all 256 values byte 2 can take and asserts that `brake` still equals `front_brake | rear_brake`, because three keys off two bits drift apart on a single value nobody thought to capture. `scripts/check-freeze-frame.ts` cross-checks Energica's 155 per-fault field shortlists against `src/diagnostics/dtc-table.ts` — a real check across two independently sourced tables, which is why it knows about the two water-pump codes they disagree on — and then replays two freeze-frame transfers through the reassembler and decoder. Those two transfers are **constructed rather than captured**, and both the script and its fixture say so at length: they prove the decoder self-consistent, not the wire format right. It also runs `scripts/generate-grafana-dtc.ts --check`, which compares the fault-code table Grafana carries inline against `src/diagnostics/dtc-table.ts` — a copy that once went stale for months without anything on screen looking wrong. CI runs the same command on every PR, so a change that breaks a decoder, the parameter table or that dashboard goes red rather than green.

`scripts/check-can-decoders.ts` covers the broadcast decoders the same way, from a handful of frames copied byte for byte out of a real capture — and then checks three things about the decoder set that replaying cannot see. The important one is the **RX filter**: `STREAM_IDS` sets the kernel's CAN filters, so an ID missing from it never reaches the decoder and there is no symptom at all — no error, no warning, just a signal that never appears, which looks exactly like a bike that never sent it. That has already cost time here once, on `0x400`. The check probes the decoder across the whole 11-bit ID space and fails if anything that decodes is missing from the filter. It also fails if a decoder emits a key with no registry entry, and if any 1/0 flag carries a deadband of 1 or more — because `|1 − 0| > 1` is false, so such a signal logs once after boot and then goes silent forever.

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

The sealed ride log can be downloaded from `http://<pi>/dl` — short enough to type on a phone, and ~10x smaller than the old SQLite download. What crosses the wire is ciphertext: without the laptop's private key those bytes are noise. That is a claim about the **bytes**, not about the **transfer** — `/dl` is unauthenticated plain HTTP, so anyone on that network can pull the whole log and keep the ciphertext against the day the key leaks, and anyone in the middle can truncate it, because segments are sealed one by one and nothing signs the sequence. See [What this does and doesn't hide](#what-this-does-and-doesnt-hide). Decrypt it on the laptop (see below) to get a `.db` for Grafana.

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

The bike keeps several completely different fault records, and the Faults tab shows them apart because merging them would be wrong — they answer different questions:

|  | What it is | How many, right now | Where from |
| --- | --- | --- | --- |
| **Active** | What the bike says is wrong _at this moment_. It flickers — one code was present on 2 of 8 consecutive polls at a standstill | 0-1 | Connectivity Hub message type 25, over Bluetooth and mirrored onto CAN `0x410` |
| **Stored** | Everything that has _ever_ been wrong and not been cleared. It only climbs | **39** | OBD-II **mode 03**, over ISO-TP |
| **Pending / permanent** | Would be OBD-II modes 07 and 0A | — | **no response.** See below |
| **Freeze frames** | The conditions the bike recorded _at the moment_ one specific code latched | not read yet | KWP `0x17` on the A8 micro. Decoder, tables and transport are in; the wire format is unverified. See [Freeze frames](#freeze-frames) |
| **Freeze-frame log** | The whole stored history of the above, **with timestamps** | not read yet | KWP `0x35`/`0x36`/`0x37` bulk upload on A8 — the factory tool pulled 1198 records in one ~7-minute transfer. See [The multi-frame transport](#the-multi-frame-transport) |

Mode 03's reply is 80 bytes, so it needs ISO-TP: a First Frame, a flow-control frame back from us, then eleven Consecutive Frames. `src/can/iso-tp.ts` reassembles it and `src/diagnostics/obd-dtc.ts` decodes it — both pure, bytes in and codes out, so a captured transfer replays on a laptop:

```bash
node --experimental-strip-types scripts/decode-dtc-response.ts
# → replays a real 2026-08-04 transfer and checks it still decodes to the same 39 codes
```

Codes are named from Energica's own type-approval table, reconciled against the manufacturer's service-tool copy of it (`src/diagnostics/dtc-table.ts`, 154 codes). All 39 of this bike's are in it. **Mode 01 PID 02** — the freeze-frame code, i.e. the one the bike captured when it lit the lamp — reads `P0514`, _"Error reading temperature"_, which is why the warning light is on.

**Modes 07 and 0A return nothing at all** — silence, not a refusal, across six attempts. That means "not implemented" and "implemented but withheld" cannot be told apart from here, so the dashboard says **"no response"** rather than "none pending". Those are different claims and only one of them is true.

The transfer is not reliable — the First Frame arrives every time and the Consecutive Frames sometimes never do, at somewhere between 25 % and 70 % per attempt. It is retried, and it is read once a minute from inside the sequential OBD poll loop so nothing else of ours is on the bus while it runs.

### Freeze frames

A stored code says _what_ went wrong. A freeze frame says what the bike was **doing at the moment it latched** — pack voltage, motor speed, air temperature, and for a water-pump code the measured pump current itself. It is a different service on a different bus from either list above: KWP **`0x17`** with a component number, on the **A8** safety micro, after a `10 81` session.

What makes a freeze frame readable rather than a hex dump is Energica's own data, and both halves are now in this repo:

- **`src/diagnostics/infokey-table.ts`** — the 120 telemetry fields the manufacturer's service tool calls _info keys_, each with a name, a unit, a C datatype and a scaling equation. Transcribed from two independent copies of Energica's own table, which agree on all 120 rows.
- **`src/diagnostics/fault-infokeys.ts`** — **944 curated references** across 155 faults saying which of those fields to show for each code, _in order_. That order is the payload's byte layout, not a display preference.

Tap any stored code on the Faults tab and it opens to show that shortlist: Energica's own answer to "what should I go and measure for this fault". That part needs no bus at all — it is served from `/fault-infokeys`, static and cached.

```bash
node --experimental-strip-types scripts/check-freeze-frame.ts
# → checks the 120 fields and 155 shortlists against dtc-table.ts, then replays
#   two freeze-frame transfers through the real reassembler and decoder
```

> ⚠️ **The wire format is not verified.** The _request_ is proven twice over — the factory tool sent `0x17` to A8 29 times in a 2026-08-08 capture and got 29 positive replies, and Energica's own code builds exactly that frame. The _response layout_ has never been captured: it is reconstructed from how the manufacturer's tool decodes it, and one detail (whether the header carries a record-count byte) is genuinely open. So `scripts/check-freeze-frame.ts` replays **constructed** fixtures, not a real transfer, and says so. Every decoded frame carries `trailingHex` and `headerBytesThatFit`, which is how the first read against the bike will settle it.

### The multi-frame transport

Every freeze frame is multi-frame — the header alone is 5 bytes and an extended-addressed single frame holds 6 — so reading one means **transmitting between the request and the rest of the reply**. `src/vcu/kwp-client.ts` was built never to do that. It now can, and the property that made the old rule worth having is intact: the flow-control frame is addressed to the target the **caller** named, never to an address read off the bus.

|  |  |
| --- | --- |
| **`src/vcu/multiframe-codec.ts`** | Pure. A closed union of the five multi-frame **reads** — `0x17` freeze frame, `0x18` DTC list, `0x35`/`0x36`/`0x37` upload — with a throwing default and an allowlist re-check on the emitted service byte. No raw-bytes entry point, nowhere to put a value. Plus ISO-TP segmentation and flow control for extended addressing. |
| **`src/vcu/multiframe-transfer.ts`** | One exchange over the bus: answers a First Frame with `<target> 30 FF 00` **synchronously from the frame handler** (delaying it measurably cost transfers on the OBD channel), segments a request that does not fit one frame, and bounds a stuck responder with a frame cap, a payload cap and per-stage timeouts. |
| **`src/vcu/freeze-frame-log.ts`** | The bulk read: `0x35`, then N × `0x36`, then `0x37`. Takes a bus lease, paces itself, yields between blocks, is cancellable mid-transfer, and sends the closing `0x37` on every path out — including a cancel. |

A reply that **under-fills** is abandoned, never completed at its declared length. That is the specific failure this is built around: a short Consecutive Frame mid-transfer leaves the sequence numbers running 1, 2, 3…, so nothing looks wrong, and taking what arrived shifts every later field into numbers that still have units on them. `scripts/check-kwp-multiframe.ts` asserts it, along with the gapped, oversized, foreign and flooding replies.

```bash
node --experimental-strip-types scripts/check-kwp-multiframe.ts   # no bike
```

Reading it off the actual bike is `scripts/read-freeze-frame.ts`, and that script is **the only way to run this** — a First Frame has to be answered within milliseconds, which is not something you can type into `cansend` in time. Stop the service first and bring `can0` up ACTIVE yourself; the script's header has the exact commands and the reason it does not do it for you.

```bash
node --experimental-strip-types scripts/read-freeze-frame.ts --list           # 0x18: which components have a code
node --experimental-strip-types scripts/read-freeze-frame.ts --component 44   # 0x17: one freeze frame
node --experimental-strip-types scripts/read-freeze-frame.ts --log            # the whole stored log, minutes
```

Every reply is printed as **raw hex first**, before any decode. That is the point of the run: the reply layouts are unverified, so the bytes are the result and the decode is a hypothesis printed beside them.

> ⚠️ **The request side is proven; the reply side is not.** The check asserts that this repo's segmenter reproduces `A8 10 0C 35 12 FF FF FF` — a frame captured off this bike — byte for byte, and that the `0x18` request matches the one recovered from the manufacturer's code. But **no multi-frame reply and no flow-control frame has ever been captured on this channel**, in either direction. The one reply replayed with real bytes behind it is A8's bank-2 identifier `0x2001`, reconstructed from two independent live records that had to agree and did. Everything else is constructed from the documented framing.
>
> Three things are outright guesses, each marked at its definition: **seven of the ten operand bytes** after `35 12` (only `FF FF FF` was captured, in the First Frame), whether `0x36` carries a block-sequence counter, and whether the micro sends a flow control before our request's Consecutive Frames. All three are settleable **offline**, from `capture-20260808-182129-600daf87.log` on the Pi — the census that produced these notes filtered by service byte, and a Consecutive Frame has none, so the bytes are still in that file.

## VCU parameters, by name

The VCU's calibration EEPROM — throttle maps, cell limits, current thresholds, the charge-current ceilings — is readable off the bus **by name, with no authentication**. The two micros serve it as KWP bank 1, and the mapping is simply `CommonIdentifier = 0x1000 | index`, where the index is the row number in Energica's own `params.ecf` parameter file. Parameter _n_ is `22 [0x10|hi] [lo]`.

`src/vcu/param-file.ts` carries a copy of that file — 277 names, widths and micro assignments — so nothing depends on a path in one person's iCloud folder. **Its values are another bike's**: the file came from a different variant, and 21 of the 233 parameters the A9 serves read differently here (`MAX_DC_CHG_CURRENT` is 75 A on this bike against the file's 60). It is a name table, and the column showing its values is labelled as another bike's everywhere it appears.

**Which names are right depends on which of Energica's parameter tables your bike runs — and the bike will tell you.** `TABLE_TYPE = (family << 12) | revision`, and the VCU reports its own at parameter 276 `TABLE_TYPE_uC` (A9) and 277 `TABLE_TYPE_uS` (A8). This Ribelle reads `0x4017` = table **16407**; `params.ecf` is one revision older, **16406**.

**All 28 tables Energica's 2024 service tool can select are shipped**, in `src/vcu/table-catalog.data.ts`, and the one matching what your bike reports is what the names come from. That is the difference between this working on one motorcycle and working on yours. How much it matters depends on which table you are on:

| your table                           | ids this software would have got wrong under one hardcoded 16407     |
| ------------------------------------ | -------------------------------------------------------------------- |
| 4118 / 16406                         | 1 (id 249, `LM_TYPE` vs `R_BRAKE_POPUP`)                             |
| 20503                                | 2 (`POSLIGHTS_*` vs `FPOSLIGHTS_*`)                                  |
| 20502                                | 3                                                                    |
| 24598                                | 6 (`NT_SPD_*`/`NT_TRQ_*` vs `DBW_DUMMY_WORD13..17`)                  |
| **any of the 20 `RegenFade` tables** | **25** — ids 70–94 are `RegenFade_0..24`, not the battery cell block |

That last row is the one that matters. On 20 of the 28 tables, ids 70–94 are a 25-point regen fade curve; on the other 8 the same ids are `CELL_COUNT`, `CELL_OVERVOLTAGE`, `CELL_TARGET_AC`, `CELLV_KA` and the rest of the battery cell configuration. **Another Energica tool in circulation writes a regen curve into the cell block today**, because it carries one table and never asks. Routing (`id → micro`) and record width (`id → datatype`) are identical across all 28, so nothing on the wire can notice: the write is correctly framed, lands on the right micro, is accepted, and reads back exactly as sent.

So every sweep reads its own table type back, says so in the journal and at the top of `/params.html`, and **re-names the whole snapshot from the table the bike named** before storing it. A bike naming a table this software does not carry gets shouted about rather than silently mislabelled — and the message says how to add it, because that is a thing you can do yourself.

### Adding your bike's VCU parameter table

If your VCU reports a `TABLE_TYPE` that is not in the 28 (Energica has shipped more since; another owner reports a build with about five more, one of them for a Corsa), the tool refuses to write anything and tells you this. Fixing it takes one command and no reverse engineering:

```bash
# 1. find the main executable of your own Energica service-tool install — the dealer
#    diagnostic application itself, not its installer. On Windows it lands under
#    C:\Program Files (x86)\Energica\, in the tool's own subdirectory, where it is by
#    far the largest file (~137 MB in the 2024 build). Copy it anywhere; the script
#    only reads it.
# 2. regenerate the catalogue from it (works on macOS/Linux/Windows — no .NET tooling,
#    and nothing has to be installed on the machine you run it on, just the file)
node --experimental-strip-types scripts/extract-vcu-tables.ts /path/to/service-tool.exe

# 3. tidy and check
npx prettier --write src/vcu/table-catalog.data.ts
npm test

# 4. `git diff src/vcu/table-catalog.data.ts` shows exactly which tables are new and
#    which ids they rename. Send it as a PR — every Energica owner after you gets it.
```

**It merges, it does not overwrite.** Energica builds do not all carry the same tables — the 2021 build has 18 where the 2024 one has 28, and the ten it lacks include every table with the battery cell block — so running it against an older install adds what yours has and keeps what the repo already had. A `TABLE_TYPE` present in both with _different_ content stops the script rather than picking a side: every table shared between the two builds seen so far is byte-identical, export stamp included, so a conflict is a finding worth an issue.

The tables are ZIP archives stored as .NET resources inside the exe, and the **resource name is the answer**: `_16407` is the table a VCU reporting 16407 runs. That name is the only thing in the binary binding a table to the number your bike reports, which is why the script walks the resource directory rather than scanning the file for ZIPs — a scan finds more archives (each is stored twice, and four have no `TABLE_TYPE` name at all, so the service tool itself can never select them) and throws the binding away.

Each table is stored as a **delta against `params.ecf`** — the ids whose name or signedness differ — because `id → micro` and `id → datatype` never vary. All 28 come to ~46 KB of source that way, against ~1.1 MB as standalone tables, which matters on a Pi Zero. Each carries a fingerprint taken from Energica's own bundle, and rebuilding a table checks against it, so a delta that has drifted from the `params.ecf` text underneath it is a loud failure rather than a subtly wrong name table.

Two things Energica's bundles do **not** contain: any values (`vehicleValue` is null in all 28) and the `[SECTION]` groupings. Both come from `params.ecf`, which is a 16406 bike's — so they travel only as far as the name does. An id another table renames loses both, because "the other bike's `CELL_COUNT` is 80" is not a fact about `RegenFade_0`.

### Service mode

Reading them is a thing you **do**, from the phone: **Menu → Service mode → `🔧 Read VCU parameters from the bike`** (two taps — the first arms it). Live progress, `⏹ Stop`, and then `⬇ Export N parameters as vcu_backup.csv`, which is byte-compatible with another owner's `energica_tool.py`.

**It only starts with the bike proved parked**, and it stops by itself if that stops being true. `src/vcu/service-gate.ts` requires road speed zero on CAN `0x104`, the motor at zero rpm, the VCU's own `moving` bit clear, and `go` / `go_request` / `throttle_on` clear — every one of them fresh, from 100 Hz broadcasts. OBD PID `0D` corroborates the speed when it is answering. Anything stale, missing or contradictory refuses: the gate fails closed, so a bus that has gone quiet reads as "I cannot tell", never as "it is fine". The same check runs again before **every single request** the sweep sends, and a watchdog re-runs it five times a second, so riding away ends the read rather than racing it.

**Stationary and charging is allowed**, deliberately — you cannot test a DC charge-current limit on a bike that is not plugged in. While the charger's own frames (`0x305`/`0x306`) are arriving, two things relax: `energized` may be set, because a charging bike's HV side is up by definition; and `speed_can_kmh`/`motor_rpm_can` may be absent, because the bike stops broadcasting `0x104` while it charges. Nothing else relaxes — the `0x102` bits must still be live and clear, and a fresh speed reading that says the wheel is turning still refuses.

### Probing one identifier

The sweep covers the 277 parameters the bike's own table describes: bank 1 on the two VCU micros. **Menu → Service mode → Probe one identifier** reaches anything else — pick the micro, the bank and the index, and it reads that one. What lives out there and nothing here could reach before: **bank 2 is live data** rather than stored settings. Same header, same gate and same single-flight as a sweep.

> ⚠️ This briefly offered a **charge manager** target, on CAN `0x7C3`/`0x7E3`. That pair is wrong and has been removed: **`0x7E3` is the dashboard's request id**, so the option could have questioned the dashboard while the page said otherwise, and `RequestFrameIDs.CHM = 0x7C3` turns out to be a dead enum the manufacturer's own code references nowhere. Node `0xA4` is the charge manager's real 11-bit identity, but the ECU actually answers on **29-bit ISO-TP** — request `0x18DA09F1`, response `0x18DAF109` — which needs `ext: true`, its own RX filter and its own addressing math. That is a feature rather than a constant, so the target is gone rather than re-pointed; the full note is above `VcuTarget` in `src/vcu/param-codec.ts`. Whoever adds it should know it is **off-bus when parked** (it answers only during a live charging session), that identification reads need no SecurityAccess, and that its deeper access uses a CRC-16/CCITT algorithm that is **not** the VCU's bit-swap.

**It is on demand, never automatic.** These are configuration: they do not move while riding, so logging them as time series would spend SD-card writes re-recording constants, and 277 more keys in the WebSocket snapshot would cost every dashboard update. Nothing starts a sweep at boot, on a timer or per page load. What is worth knowing is that one _changed_ — so every run diffs against the previous snapshot and says so loudly in the journal. `GET /vcu-params` and `/params.html` serve that snapshot from disk and **never touch the bus**.

A sweep survives being interrupted: each row is appended to `vcu-params/sweep.partial.jsonl` as it arrives, and starting another one resumes from there rather than beginning again — so a stop, a gate exit or a `systemctl restart` costs only the parameters not yet read. Snapshots are gitignored — they are one motorcycle's — while the name table needed to take your own is committed.

```bash
node --experimental-strip-types scripts/check-vcu-params.ts   # on a laptop, no bike:
                                                              # codec, all 28 name tables, backup CSV,
                                                              # the safety gate, and the whole write path
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

⚠️ **And the bike has to have said which parameter table it runs, or nothing on that list may be written at all.** A parameter is written **by index**, and what an index _means_ comes from the table — but routing (`id → micro`) and record width (`id → datatype`) are identical across all 28 of Energica's tables, so a write under the wrong table goes to the right micro with the right number of bytes, is accepted, reads back cleanly, and has changed a **different parameter**. There is no NRC, no reply shape and no read-back anywhere in that sequence that can report it. 151 of 278 ids carry a different name in at least one other table, and id 249 (`LM_TYPE` in 16406, `R_BRAKE_POPUP` in 16407) is one that was found rather than imagined.

So `src/vcu/table-gate.ts` refuses a parameter write unless **both** micros have named the **same** table and it is one this software carries. The question it asks is "do we have your table?", not "are you this particular motorcycle" — all 28 pass. The ways it can fail are reported differently, because the remedies do not overlap:

| state | what it means | what fixes it |
| --- | --- | --- |
| `confirmed` | 276 and 277 both named a carried table, and the allowlist means the same thing on it | — writes are allowed |
| `mismatched` | a micro named a table this software does not carry | **no read helps** — but you can fix it: [add your table](#adding-your-bikes-vcu-parameter-table) |
| `split` | the two micros named **different** tables. Separate EEPROMs, possibly flashed at different times | **no read helps.** Nothing here holds one table per micro; picking one would name half the ids wrongly. Please open an issue with both numbers |
| `unwritable` | the table is carried, and one of the five allowlisted parameters is not called that on it | `src/vcu/write-targets.ts` needs an entry correct for that table. (No shipped table does this — all 28 agree on ids 16, 48, 49, 258 and 259) |
| `unusable` | a micro answered with a record the width column forbids, so it named nothing | the framing of that whole sweep is in question |
| `unread` | one or both micros have never been asked | **a sweep.** The refusal names the read: parameter 277 `TABLE_TYPE_uS` on the A8, `22 11 15`, read-only, no SecurityAccess |

> ⚠️ **This bike is in the `unread` state today (2026-08-18), so the gate is shut.** The A9's copy (276) was read on 2026-06-14 and says 16407; the A8's copy (277) has never been read by anyone — and id 249, the one id where the two candidate tables disagree, is an A8 parameter. The two micros hold separate EEPROMs, so one answering is not confirmation of the other.
>
> ⚠️ **Seeing the answer and recording it are different acts.** The gate reads the last **sweep's** snapshot (`vcu-params/latest.json`, written in exactly one place: the end of a sweep). "Probe one identifier" performs precisely this read and returns it in an HTTP response that nothing persists — so it is the one-frame way to find out what the bike says, and it cannot open the gate on its own. Run the parameter read and let it finish. The A8 is swept second and 277 is the highest index in the table, so it is the very last thing a sweep asks about — a run the safety gate cuts short is exactly the run that misses it.

The gate applies to the **two parameter actions and nothing else**. The service actions below are deliberately exempt: `31 FC` takes a routine local identifier that appears in none of the 28 parameter tables (it comes from the service tool's shared library), Mode 04 and the `0x120` clock broadcast carry no identifier at all, and the service stamp reads ids 1000-1003, outside `params.ecf` entirely. Gating them would be a refusal resting on evidence with no bearing on the action — and reads stay ungated for the reason that matters most: the way out of `unread` **is** a read.

Anything not on that list is rejected **in the pure codec**, not in the UI — `planWrite("CELL_OVERVOLTAGE", …)` returns a refusal that names what _is_ writable, and `src/vcu/write-codec.ts` re-derives the plan from the allowlist immediately before building the frame, so a plan assembled by hand or arriving over HTTP cannot become bytes. The table gate is enforced in the same place and on the same terms: `buildWriteFrame` re-judges the table-type report from the **raw words the bike sent**, never from the report's own `confirmed` flag, so forging one is useless — you would have to claim the bike answered `0x4017`, and if it did then the write was correct. `VSM_CONFIG_1` is offered as a **bit toggle and never as a word**: the same word carries the PSU type (`0x0760`) and the Bluetooth variant (`0x3000`), and a fat-fingered word write would reconfigure both. The new word is computed from the one the bike currently holds, and the pure layer asserts that only the one mask moved.

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

The UI makes an accidental write hard in four ways: you cannot write until something has **read the value off this bike** (it becomes the compare-and-swap precondition), the confirmation **spells out old → new**, it takes **two taps** and _any_ change to the form disarms it, and the irreversible actions sit in their own block with their own arming.

That first one accepts the **last sweep's** reading as well as a fresh one, and says which it is showing and how old it is. A completed sweep has already read all 277 parameters and written them down; demanding a per-parameter read on top of that produced a form saying "not read yet" to somebody who had just read everything, and the reading was never the property that mattered — the Pi re-reads the parameter _during_ the write and refuses if the bike disagrees with what you were shown, so an older number is a likelier refusal rather than a weaker check. The read button stays, as the way to ask whether that value is still true. On top of those, an unconfirmed parameter table disables the write button outright and says which _kind_ of blocked it is — amber and "blocked until a sweep has recorded the A8's `TABLE_TYPE` (277)" when a read would clear it, red and "this bike's parameter table is not one this software can write against" when nothing on the bus will help. The page branches on the server's `noReadWillHelp`, not on the state name, so a state added later cannot quietly start rendering as "nobody has asked yet" with an instruction that leads nowhere. Both are shown whether or not the vehicle-state gate is also closed, so a trip out to the bike learns about both at once. The read button and the service actions stay live throughout, on purpose.

Each parameter carries three kinds of prose and they are shown at the three moments they are read at: **what it is** always, above the value; **why you might not want to** behind one amber toggle that counts them, because four stacked warning paragraphs above the input is how a phone in a garage becomes unusable and how warnings stop being read at all; and **how to check the bike afterwards** — `MAX_DC_CHG_CURRENT`'s free `0x625` b2 check, the key-cycle that config words need — next to the outcome _after_ the write, where it is an instruction rather than a fourth thing to scroll past.

⚠️ **`FCHG_CURRENT_GAIN` deserves its own warning.** Its direction of effect is unknown, and this is a real 50/50 rather than a gap someone forgot to close. If it is a _measurement calibration_ — which the name argues for — then raising 225 → 255 makes the bike believe it is drawing ~13 % more than it is, and it would back off **sooner**, not later. It might instead be a gain in the charge PID loop, in which case it changes loop dynamics and can oscillate. The arithmetic that produced 255 in the first place (`75 × 225/255 = 66.18 A`) has since been **retracted**: the wire request was measured at 75 while 66.2 A flowed, and 73.2 A was delivered on another day with no parameter change. Change one thing per charge session.

## Notes

- The CAN bus is **read-only unless you switch writing on**. Everything that runs by itself — passive broadcast decode, the OBD-II poller, the trouble-code reads, the KWP `0x22` parameter reads — cannot change anything in an ECU, and is built so it cannot express one: `src/vcu/param-codec.ts`'s request union has three members and nowhere to put a value, and `src/can/obd-dtc.ts` can emit only modes `03`, `07` and `0A`. That is unchanged and is meant to stay that way. The writes live behind `SERVICE_WRITE_ENABLED`, which is **off by default** — see [Changing something on the bike](#changing-something-on-the-bike). `0x11` ECUReset, `0x2F` InputOutputControl (the factory tool's actuator-test channel), `0x3B` and `0x3D` are implemented **nowhere**, and should stay that way.
- `src/diagnostics/freeze-frame.ts` is built the same way for its own service: a closed one-member request union that can encode `0x17` and nothing else. So the freeze-frame **erase** that sits beside it in the factory tool — `31 FE` with a fixed 8-byte operand and its own SecurityAccess, which wipes the bike's record of _why_ it faulted — is unreachable rather than merely unused, and it stays outside `SERVICE_WRITE_ENABLED` rather than being one more thing that switch turns on.
- Coolant history predating the CAN integration is preserved (migrated into the current schema; the original table is kept as a backup).
- Any `temperatures.db` left on the Pi from before the encrypted log is **plaintext history** — copy it off and delete it from the bike, or the SD card still gives up every route you rode before the switch.
- The one thing that _does_ write to the bike is the Bluetooth handshake: enrolling with the Connectivity Hub claims its single authorised-device slot, and after several unanswered attempts the client also tries the hub's own address. If the bike is already paired to something else, that pairing can be replaced, and the way back is clearing the stored device from the bike's own dashboard. `BLE_ENABLED=0` avoids the whole question.

## Licence

AGPL-3.0 — see [`LICENSE`](LICENSE). It reverse-engineers a vehicle you own and talks to safety-relevant hardware; there is no warranty of any kind, and what you plug into your own motorcycle is your responsibility.
