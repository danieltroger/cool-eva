import type { SignalDef } from "./signals.ts";
import {
  LMU_COUNT,
  LMUS_WITHOUT_BATTERY_TEMP,
  cellsInLmu,
  cellVoltageKey,
  lmuTemperatureKey,
  type LmuTemperatureSensor,
} from "./decode-bms.ts";
import { DTC_TABLE, dtcSignalKey } from "../diagnostics/dtc-table.ts";

// Central registry of every signal we log — units/groups for the phone dashboard
// and the `signal` table, plus optional per-signal deadbands to tame chatty
// analog signals (see obd-garage/INTEGRATION_PLAN.md §Logging model).
//
// deadband omitted ⇒ 0 ⇒ log on any change (i.e. at sensor resolution).
export const SIGNALS: SignalDef[] = [
  // External MAX31865 coolant probes (battery loop in/out)
  { key: "coolant_in", unit: "°C", group: "coolant", source: "sensor", deadband: 0.05 },
  { key: "coolant_out", unit: "°C", group: "coolant", source: "sensor", deadband: 0.05 },

  // 0x200 / 0x660 — BMS
  // batt_temp_lo/hi always mean the TRUE pack temperature, whichever frame supplies
  // them (see pack-temperature.ts), so the history stays one continuous series. That
  // guarantee is why they can be ABSENT: until the frames establish which BMS config is
  // flashed, no row is written under them at all, and if the pack that owns the true
  // values goes silent they stop rather than fall back. Sparse is the intended shape —
  // anything reading them has to tolerate gaps instead of interpolating across one.
  // The _vcu pair is what the VCU and dash actually read: identical to the true pair on
  // the stock config, and lower once a DC-derate config is flashed. It comes straight off
  // 0x200 with no routing, so it is the pair that never has gaps. The difference between
  // the two is the useful signal, but it is NOT a fixed number, not even monotonic in
  // temperature, and must not be used as a health check — under 15-bounded-clamp (built, not yet flashed
  // now) it is 0 below 35 °C, (true − 35) from 35 to 54 °C, and 0 again from 55 °C up, where
  // the truth is reported so the VCU's limp protection can still fire. Only the retired
  // flat-offset config gave a constant 15. See the 0x200 comment in decode-bms.ts.
  { key: "batt_temp_lo", unit: "°C", group: "battery", source: "stream" },
  { key: "batt_temp_hi", unit: "°C", group: "battery", source: "stream" },
  { key: "batt_temp_lo_vcu", unit: "°C", group: "battery", source: "stream" },
  { key: "batt_temp_hi_vcu", unit: "°C", group: "battery", source: "stream" },
  { key: "soc", unit: "%", group: "battery", source: "stream" },
  { key: "soh", unit: "%", group: "battery", source: "stream" },
  { key: "pack_v", unit: "V", group: "battery", source: "stream" },
  { key: "pack_a", unit: "A", group: "battery", source: "stream" },
  { key: "pack_kw", unit: "kW", group: "battery", source: "stream", deadband: 0.05 },

  // 0x201 — BMS System State bitfield, kept under its historical key. The raw byte
  // is what has always been logged (bit 0 discharge, 1 charge, 2 balancing, 3
  // trickle, 4 idle, 5 charge complete, 6 maintenance), so old rows stay comparable;
  // the bms_state_* booleans below are the decoded version.
  { key: "charge_state", unit: "", group: "charge", source: "stream" },
  { key: "bms_state_discharge", unit: "", group: "bms", source: "stream" },
  { key: "bms_state_charge", unit: "", group: "bms", source: "stream" },
  { key: "bms_state_balancing", unit: "", group: "bms", source: "stream" },
  { key: "bms_state_trickle", unit: "", group: "bms", source: "stream" },
  { key: "bms_state_idle", unit: "", group: "bms", source: "stream" },
  { key: "bms_state_charge_complete", unit: "", group: "bms", source: "stream" },
  { key: "bms_state_maintenance", unit: "", group: "bms", source: "stream" },

  // 0x201 b1-7 — error/warning bitfields. The raw words are logged so no flag is
  // ever lost; the booleans are the ones worth an alert.
  { key: "bms_error_flags", unit: "", group: "bms", source: "stream" },
  { key: "bms_warning_flags", unit: "", group: "bms", source: "stream" },
  { key: "bms_err_cell_overvoltage", unit: "", group: "bms", source: "stream" },
  { key: "bms_err_cell_undervoltage", unit: "", group: "bms", source: "stream" },
  { key: "bms_err_over_temp", unit: "", group: "bms", source: "stream" },
  { key: "bms_err_leak_detected", unit: "", group: "bms", source: "stream" },
  { key: "bms_err_leak_detect_failed", unit: "", group: "bms", source: "stream" },
  { key: "bms_err_contactor", unit: "", group: "bms", source: "stream" },
  { key: "bms_warn_low_soc", unit: "", group: "bms", source: "stream" },
  { key: "bms_warn_balancing_required", unit: "", group: "bms", source: "stream" },

  // 0x202 — how much current the BMS is allowing right now. Both move smoothly with
  // temperature and SOC at 10 Hz, so a 1 A deadband keeps them off the hot path
  // without hiding a real derate.
  { key: "allowed_discharge_a", unit: "A", group: "battery", source: "stream", deadband: 1 },
  { key: "allowed_regen_a", unit: "A", group: "battery", source: "stream", deadband: 1 },

  // 0x203 — cell balance. cell_lowest_v_idx is mem 2025 and cell_highest_v_idx mem 2024;
  // the two were swapped before the BMS config was decrypted, hence the rename — rows
  // under the old min_cell_idx/max_cell_idx keys mean the opposite of their names.
  //
  // They name whichever cell sits at each extreme *at that instant*, which is not the
  // same as naming a weak cell: at the 9 mV pack spread measured 2026-08-02 the ranking
  // is noise, and the low index wandered between two cells while nothing else moved.
  { key: "cell_min_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_avg_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_max_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_spread_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_lowest_v_idx", unit: "", group: "cells", source: "stream" },
  { key: "cell_highest_v_idx", unit: "", group: "cells", source: "stream" },

  // 0x205 — the BMS's own energy/charge counters. cell_deviation_mv is its own
  // max−min, i.e. an independent check on cell_spread_mv computed from 0x203.
  // The energy field's unit is documented as whole kWh but doesn't match the bus;
  // logged as a raw count until 0x661 can settle it (see decode-bms.ts).
  { key: "bms_remaining_energy_raw", unit: "", group: "energy", source: "stream" },
  { key: "cell_deviation_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "remaining_ah", unit: "Ah", group: "energy", source: "stream" },
  { key: "cells_connected", unit: "", group: "cells", source: "stream" },

  // 0x206 — pack resistance + module comms
  { key: "pack_resistance_mohm", unit: "mΩ", group: "battery", source: "stream" },
  { key: "lmu_comm_warnings", unit: "", group: "bms", source: "stream" }, // bit n = LMU n
  { key: "bms_io_state", unit: "", group: "bms", source: "stream" }, // bit n = IO n+1

  // 0x207 — isolation test. 10-bit ADC counts around an ideal of 512, at 10 Hz.
  // These are a slow diagnostic (a leak vs a Y-capacitor), never a transient, so the
  // deadband is deliberately blunt: a real leak moves tens of counts, while ±3 counts
  // of ADC wobble at 10 Hz across three signals would be ~2.6M rows/day — four times
  // the entire rest of the DB, onto a Pi Zero's SD card. Worth re-checking with
  // `select key, count(*) from … group by key` after the first ride.
  { key: "iso_test_1", unit: "", group: "bms", source: "stream", deadband: 10 },
  { key: "iso_test_2", unit: "", group: "bms", source: "stream", deadband: 10 },
  { key: "iso_test_total", unit: "", group: "bms", source: "stream", deadband: 10 },
  // Sum of the measured cell voltages in 1 V steps — a cross-check on pack_v, which
  // the BMS measures at the terminals instead. Also 10 Hz, and pack voltage swings
  // tens of volts under throttle, so the deadband has to sit well above the 1 V
  // quantisation or it logs continuously while riding. The observed sum-vs-terminal
  // gap is ~6 V, so 5 V still surfaces a divergence.
  { key: "cell_voltage_sum_v", unit: "V", group: "cells", source: "stream", deadband: 5 },

  // 0x300 — charger enable + the DC limits the BMS grants the charger
  { key: "charger_enabled", unit: "", group: "charge", source: "stream" },
  { key: "charger_max_dc_v", unit: "V", group: "charge", source: "stream" },
  { key: "charger_max_dc_a", unit: "A", group: "charge", source: "stream" },
  { key: "bms_post_processor_1", unit: "", group: "bms", source: "stream" }, // purpose unknown, logged raw

  // --- Frames that only exist after the extended BMS config is flashed -----
  // 0x660 — pack thermal summary (the per-module temps ride in 0x664 instead).
  // pack_temp_avg is not touched by the VCU offset, so it stays comparable with
  // batt_temp_*. The frame also carries the true batt_temp_lo/hi in its long form.
  { key: "lmu_temp_high_idx", unit: "", group: "battery", source: "stream" },
  { key: "lmu_temp_low_idx", unit: "", group: "battery", source: "stream" },
  { key: "pack_temp_avg", unit: "°C", group: "battery", source: "stream" },
  // Clamp instrumentation, one byte each. No deadband: these are small integers whose
  // whole purpose is to show the clamp's arithmetic, so smoothing would hide it.
  // clamp_gate is the mask that decides which regime is in force — 255 while the clamp is
  // subtracting, 0 while the true temperature is going to the VCU (below 35 °C, or from
  // 55 °C up where the VCU's limp protection has to be able to see the truth). clamp_amount
  // is what it would subtract; what it actually subtracts is clamp_amount & clamp_gate.
  //
  // Both carry NO unit on purpose, and for two different reasons. clamp_gate is not a
  // quantity at all, it is a byte of all ones or all zeroes. clamp_amount happens to be
  // degrees under the current config but is a raw config-dependent slot — under
  // 11-full-conditional-offset it was a flag × 9. Tagging either "°C" would also opt it into
  // bounds.js's BY_UNIT["°C"] = [-40, 200] fallback, which would reject 255 as a dead sensor
  // and draw the healthy state as a fault. Same treatment as bms_post_processor_1 and the
  // iso_test_* signals.
  //
  // clamp_gate REPLACES clamp_diff, which 206 rows have already shipped under (Aug 2026,
  // 14-signbit-clamp) meaning "true pack temp high − 35 °C, signed". It is retired rather
  // than repurposed: −1 under the old meaning is a pack at 34 °C, and −1 is also what a
  // signed read of a closed gate would say, so reusing the key would put two unrelated
  // meanings in one series with nothing in the data to mark where one ends. Retiring it
  // costs nothing, because clamp_diff was exactly batt_temp_hi − 35 and always was —
  // verified over all 198 same-timestamp pairs in the log, true 28…55 °C, no exceptions — so
  // every old row can still be reconstructed from batt_temp_hi, which is in the same frame.
  // The units and group of those rows live in the sealed log segments themselves
  // (scripts/decrypt-log.ts prefers them over this registry), so dropping the entry here
  // does not orphan them.
  { key: "clamp_gate", unit: "", group: "bms", source: "stream" },
  { key: "clamp_amount", unit: "", group: "bms", source: "stream" },
  // Echo of the byte 0x200 b3 carries — genuinely a temperature, so "°C" is right here.
  // It must always equal batt_temp_hi_vcu; pack-temperature.ts warns once per run if it
  // ever doesn't, because that means the .bms config is repointed wrong. Unlike the
  // pp_output3_raw diagnostic it replaces, this is permanent instrumentation: it guards
  // an invariant that can break on any future config edit, so there is no point at which
  // it has "served its purpose" and can be retired.
  { key: "batt_temp_hi_vcu_echo", unit: "°C", group: "bms", source: "stream" },

  // 0x661 — 1 Wh remaining energy (5 Wh deadband: 1 Wh out of a ~21 kWh pack is far
  // below anything we can act on, and the frame arrives every second) + the BMCU's
  // monotonic power-up minutes, which is the pack's hour meter.
  { key: "bms_remaining_energy_wh", unit: "Wh", group: "energy", source: "stream", deadband: 5 },
  { key: "bms_uptime_min", unit: "min", group: "bms", source: "stream" },

  // 0x665 — the cell limits the BMS is configured with. Constants stamped into the
  // frame at config-build time, so they only ever change when the pack is reflashed;
  // logging them means nothing downstream has to hardcode a threshold.
  { key: "cell_cutoff_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_end_of_life_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_overvoltage_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_target_mv", unit: "mV", group: "cells", source: "stream" },

  // 0x662-0x664 b0 — the raw module selector, logged so that "byte 0 isn't the LMU
  // number after all" is distinguishable from "the frames never arrived": with no
  // per-cell signals and no mux row, they never arrived; with a mux row and no cells,
  // the selector is out of range and the assumption is wrong.
  //
  // The one shape the guard can't see is a 0-BASED selector — modules 0…10 would drop
  // module 0 and shift the rest onto the wrong keys, with healthy-looking cells. That
  // is ruled out by measurement, not by the guard: the config-5 capture saw all eleven
  // LMUs on 0x662, which a 0-based scheme could not produce.
  //
  // The deadband deliberately stops it after the first row per boot. It rotates at
  // 20 Hz, so log-on-change would be ~1.7M rows/day for a number that never carries
  // new information once you've seen it move. What keeps the rotation observable is
  // the 5 s full-snapshot heartbeat in ws.ts, which broadcasts liveState — liveState
  // updates on every sample, but notifyChange sits inside the deadband branch, so the
  // patch path never fires for this signal. That heartbeat is therefore load-bearing
  // here: drop it as "redundant" and this becomes invisible.
  //
  // The only signal here written by three frames, and safe precisely because they all
  // read the same memory (2129) — unlike a duplicated measurement, they can't disagree
  // in a way that would make the value flap.
  { key: "lmu_cell_mux", unit: "", group: "bms", source: "stream", deadband: 100 },

  // 0x025 (inst) / 0x10A (residual) — energy
  // Chattiest signal on the bus by far (~291k rows/day at deadband 0.5, ~49% of all
  // rows) and not worth that fidelity — 10 Wh still tracks the curve on a ~200-330 Wh
  // signal while cutting the row count by well over an order of magnitude.
  { key: "inst_consumption_wh", unit: "Wh", group: "energy", source: "stream", deadband: 10 },
  { key: "residual_energy_wh", unit: "Wh", group: "energy", source: "stream", deadband: 0 },

  // 0x305 / 0x306 — charger (present only while charging)
  { key: "dc_v", unit: "V", group: "charge", source: "stream" },
  { key: "dc_a", unit: "A", group: "charge", source: "stream" },
  { key: "mains_v", unit: "V", group: "charge", source: "stream" },
  { key: "mains_a", unit: "A", group: "charge", source: "stream" },
  { key: "charge_limit_a", unit: "A", group: "charge", source: "stream" }, // 0x10a b7 ÷7 ✅

  // OBD-II polled @1 Hz
  { key: "speed_kmh", unit: "km/h", group: "obd", source: "poll" },
  { key: "motor_rpm", unit: "rpm", group: "obd", source: "poll", deadband: 20 },
  { key: "bike_coolant_temp", unit: "°C", group: "obd", source: "poll" },
  { key: "oil_temp", unit: "°C", group: "obd", source: "poll" },
  { key: "ambient_temp", unit: "°C", group: "obd", source: "poll" },
  { key: "aux_12v", unit: "V", group: "obd", source: "poll", deadband: 0.02 },
  { key: "soh_pid", unit: "%", group: "obd", source: "poll" },
  { key: "motor_load_pct", unit: "%", group: "drive", source: "poll", deadband: 1 },
  { key: "dist_since_clear_km", unit: "km", group: "drive", source: "poll" },

  // 0x109 — throttle position (broadcast, ~100 Hz) 🟡
  { key: "throttle_pct", unit: "%", group: "drive", source: "stream", deadband: 0 },

  // 0x102 — handlebar/lights (decoded live on the bike)
  { key: "high_beam", unit: "", group: "controls", source: "stream" }, // b0 bit6
  { key: "brake", unit: "", group: "controls", source: "stream" }, // b2 0x20 front | 0x40 rear
  { key: "blinker_left", unit: "", group: "controls", source: "stream" }, // b2 0x04
  { key: "blinker_right", unit: "", group: "controls", source: "stream" }, // b2 0x08
  { key: "horn", unit: "", group: "controls", source: "stream" }, // b2 0x10

  // OBD-II diagnostics/counters, polled with the rest — all slow-moving, so
  // log-on-change keeps them to a handful of rows per ride.
  { key: "mil_on", unit: "", group: "diag", source: "poll" }, // PID 01 A bit7
  { key: "dtc_count", unit: "", group: "diag", source: "poll" }, // PID 01 A & 0x7F
  { key: "time_since_clear_min", unit: "min", group: "diag", source: "poll" }, // PID 4E — monotonic ⇒ hour meter
  { key: "dist_with_mil_km", unit: "km", group: "diag", source: "poll" }, // PID 21
  { key: "time_with_mil_min", unit: "min", group: "diag", source: "poll" }, // PID 4D
  { key: "warmups_since_clear", unit: "", group: "diag", source: "poll" }, // PID 30

  // The stored codes themselves, out of the Connectivity Hub's diagnostics
  // message (type 25). dtc_list_count is the bike's ACTIVE fault list — the same
  // count as dtc_count arrived at down a completely different path, so a
  // disagreement between the two is worth seeing.
  //
  // ⚠️ CORRECTED 2026-08-04: this comment used to claim "Mode 03 is locked on this
  // bike, so PID 01's dtc_count is all OBD-II will give up". That was wrong. Mode 03
  // works and hands over all 39 codes by name over ISO-TP; the NRC 0x33 it was
  // convicted on belonged to our own flow-control frame, not to the request. See
  // src/can/obd-dtc.ts.
  { key: "dtc_list_count", unit: "", group: "diag", source: "stream" },
  { key: "dtc_unrecognised_count", unit: "", group: "diag", source: "stream" },
  // The OBD-II lists, counted. Only the counts are signals — the codes themselves
  // go out over /stored-dtcs, because 39 more keys in every 5-second WebSocket
  // snapshot is a poor trade for a list that changes when the bike is serviced.
  // dtc_pending_count and dtc_permanent_count are recorded ONLY if modes 07/0A ever
  // answer; on this bike they never have, and their absence is the honest record of
  // that. Do not default them to 0.
  { key: "dtc_stored_count", unit: "", group: "diag", source: "poll" },
  { key: "dtc_pending_count", unit: "", group: "diag", source: "poll" },
  { key: "dtc_permanent_count", unit: "", group: "diag", source: "poll" },
  // PID 02, the raw 16-bit freeze-frame code (0x0514 ⇒ P0514). Unitless because it
  // is an identifier, not a measurement — never plot it.
  { key: "freeze_frame_dtc", unit: "", group: "diag", source: "poll" },
  ...dtcSignals(),

  // Keyless / immobilizer
  { key: "key_fob_id", unit: "", group: "security", source: "stream" }, // 0x480 b2-5 LE uint32
  { key: "keys_paired", unit: "", group: "security", source: "poll" }, // E-LOCK 0x791 `21 99`, once at startup

  // --- Connectivity Hub (CAN 0x410 and/or Bluetooth) -----------------------
  // Pushed by the hub, never polled. GPS arrives on both transports — the hub
  // mirrors its BLE framing onto CAN 0x410 at ~1.8 Hz (src/can/gps.ts) — while
  // torque/power and the odometer are Bluetooth-only, with no CAN frame and no
  // OBD PID (01A6 is unsupported by Energica) carrying them.
  //
  // lat/lon deadband ≈ 3 m: parked GPS jitters in the 5th decimal and would
  // otherwise log continuously, while any real movement blows straight past it.
  { key: "gps_lat", unit: "°", group: "gps", source: "stream", deadband: 0.00003 },
  { key: "gps_lon", unit: "°", group: "gps", source: "stream", deadband: 0.00003 },
  { key: "gps_altitude_m", unit: "m", group: "gps", source: "stream", deadband: 1 },
  { key: "gps_speed_kmh", unit: "km/h", group: "gps", source: "stream" },
  { key: "gps_course_deg", unit: "°", group: "gps", source: "stream", deadband: 2 },
  { key: "gps_satellites", unit: "", group: "gps", source: "stream" },
  { key: "gps_fix", unit: "", group: "gps", source: "stream" },

  // Satellite UTC — the Pi has no RTC, so this is the only trustworthy clock on
  // the road. Logged raw: if a ride ever comes back with timestamps from a
  // no-network boot, having the real time sitting next to every row makes it
  // repairable without any reasoning.
  //
  // The deadband is the only thing throttling it. The value carries milliseconds,
  // so no two samples are ever equal and log-on-change cannot dedupe it — with
  // both transports sending at ~1.8 Hz that would be ~3.6 rows/s, the highest of
  // any signal. Half a second is three orders of magnitude below the 60 s drift
  // the clock step acts on, so it costs the repair use case nothing.
  { key: "gps_epoch_s", unit: "s", group: "gps", source: "stream", deadband: 0.5 },

  { key: "motor_torque_nm", unit: "Nm", group: "drive", source: "stream", deadband: 0.5 },
  { key: "motor_power_kw", unit: "kW", group: "drive", source: "stream", deadband: 0.05 },

  { key: "odometer_km", unit: "km", group: "drive", source: "stream" },
  { key: "trip_km", unit: "km", group: "drive", source: "stream" },

  // Vehicle state machine — distinct from 0x201, which is *charge* state only.
  { key: "vehicle_state", unit: "", group: "drive", source: "stream" },
  { key: "vehicle_substate", unit: "", group: "drive", source: "stream" },

  { key: "range_km", unit: "km", group: "energy", source: "stream" },
  { key: "avg_consumption_wh_km", unit: "Wh/km", group: "energy", source: "stream", deadband: 0.5 },
  { key: "km_per_kwh", unit: "km/kWh", group: "energy", source: "stream", deadband: 0.05 },
  { key: "kwh_per_100km", unit: "kWh/100km", group: "energy", source: "stream", deadband: 0.05 },

  // --- Frames named by the rider-supplied .xdbc, replayed against live traffic ------
  // 0x020 / 0x022 — inverter and motor temperatures (10 Hz), both at 0.1 °C. Separate
  // sensors from the OBD poller's bike_coolant_temp (PID 05): at rest all three sit at
  // ambient, but a garage lap moved PID 05 with the inverter gate channel (+3 vs
  // +2.6 °C) while motor_temp_c moved +0.6 and the IGBT channel +10.6.
  //
  // The IGBT and gate readings carried ~0.6 °C peak-to-peak on a stone-cold parked
  // bike, so a 0.5 °C deadband is about the finest that doesn't just log ADC wobble at
  // 10 Hz across four signals — and the thermal excursion these exist to catch is tens
  // of degrees. Motor temperature was rock steady over the same capture and has far
  // more mass behind it, so it can afford 0.2 °C.
  { key: "inverter_igbt_min_c", unit: "°C", group: "powertrain", source: "stream", deadband: 0.5 },
  { key: "inverter_igbt_c", unit: "°C", group: "powertrain", source: "stream", deadband: 0.5 },
  { key: "inverter_igbt_max_c", unit: "°C", group: "powertrain", source: "stream", deadband: 0.5 },
  { key: "inverter_gate_c", unit: "°C", group: "powertrain", source: "stream", deadband: 0.5 },
  { key: "motor_temp_c", unit: "°C", group: "powertrain", source: "stream", deadband: 0.2 },

  // 0x104 — odometer / speed / rpm at 100 Hz. Deliberately NOT merged into the BLE
  // hub's odometer_km or the OBD poller's speed_kmh / motor_rpm (see decode.ts): the
  // point is to compare them over a ride, and one key with two writers just flaps.
  // The odometer only moves every 100 m, so it logs on change; speed and rpm would
  // otherwise write at 100 Hz, so 0.5 km/h (still twice as fine as the OBD PID's whole
  // km/h) and 50 rpm out of a ~11 000 rpm range keep them useful but affordable. Both
  // tracked their OBD PIDs to ~1-2 % over a garage lap, so the bit layout is confirmed.
  { key: "odometer_can_km", unit: "km", group: "drive", source: "stream" },
  { key: "speed_can_kmh", unit: "km/h", group: "drive", source: "stream", deadband: 0.5 },
  { key: "motor_rpm_can", unit: "rpm", group: "drive", source: "stream", deadband: 50 },
  { key: "reverse_gear", unit: "", group: "drive", source: "stream" },

  // 0x109 b2-7 — the inverter's current limits, alongside the throttle above. Same 1 A
  // deadband as the BMS's allowed_* pair, and for the same reason: derate limits move
  // smoothly with temperature and SOC, so 1 A keeps them off the hot path without
  // hiding a derate. The ceiling is not the same though — 0x109 is 100 Hz against the
  // BMS pair's 10 Hz, so if these ever do chatter under load it is up to 300 rows/s
  // across the three, not 20. Worth knowing before anyone tightens the value.
  // current_other_a is unidentified and logged so a ride can name it; the ÷10 scale
  // behind its "A" is pinned by b4-5 agreeing with allowed_regen_a, but what the field
  // measures is not.
  { key: "current_max_out_a", unit: "A", group: "drive", source: "stream", deadband: 1 },
  { key: "current_max_regen_a", unit: "A", group: "drive", source: "stream", deadband: 1 },
  { key: "current_other_a", unit: "A", group: "drive", source: "stream", deadband: 1 },

  // 0x102 b1-2 — the vehicle state bits. Booleans, so log-on-change is exactly one row
  // per transition and no deadband is wanted.
  { key: "energized", unit: "", group: "controls", source: "stream" }, // b1 bit1
  { key: "go_request", unit: "", group: "controls", source: "stream" }, // b1 bit2
  { key: "go", unit: "", group: "controls", source: "stream" }, // b1 bit3
  { key: "key_on", unit: "", group: "controls", source: "stream" }, // b1 bit4
  { key: "stand_up", unit: "", group: "controls", source: "stream" }, // b1 bit5, sidestand retracted
  { key: "ignition_button", unit: "", group: "controls", source: "stream" }, // b1 bit6, red button, right bar
  { key: "throttle_on", unit: "", group: "controls", source: "stream" }, // b1 bit7
  { key: "charging", unit: "", group: "charge", source: "stream" }, // b2 bit0
  // b2 bit1. Only ever seen as 1 with charging 0, which is also what !charging looks
  // like — check it across a plug-in before trusting the name (see decode.ts).
  { key: "charge_port_unlocked", unit: "", group: "charge", source: "stream" },
  { key: "moving", unit: "", group: "drive", source: "stream" }, // b2 bit7, .xdbc: speed > 1 km/h

  // 0x102 b4-7 — the attitude sensor's roll and pitch, in degrees. Logged until
  // 2026-08-15 as `accel_lateral_raw` / `accel_frontal_raw`, unitless counts, on the
  // .xdbc's word that they were accelerations. They are not accelerations; src/can/
  // attitude.ts carries the evidence and the sign conventions. The old keys keep their
  // 15 455 rows — still correct, just in units of 0.1° under a wrong name — and the
  // Grafana panel reads old and new together, scaling the old ones by ÷10, so the
  // history stays one continuous trace across the rename.
  //
  // ⚠️ Gravity-referenced, so neither means what a rider would assume from the name.
  // attitude_roll_deg reads ≈0 in a steady corner, because the bike leans into the
  // resultant, and outside one 230 ms transient it never left ±17.9° over a week of
  // riding that reached 186 km/h; attitude_pitch_deg mostly reports braking and
  // acceleration rather than gradient. They answer "which way is down, as far as the
  // bike can tell" — not "how far over is the bike".
  //
  // 1.0° replaces the old 100 counts, which under the wrong scale was believed to be
  // ~0.5 g and is really 10° — coarse enough to quantise a lean trace into three or four
  // levels, which is what made the Grafana panel unreadable. The old comment's objection
  // was row rate, so here is the measured answer. Summing |Δ| across the rows already
  // logged puts a 1.0° deadband at ≥161 000 rows for pitch and ≥6 600 for roll over the
  // seven days of ride log that exist; over that same window throttle_pct logged
  // 1 038 747 rows, speed_can_kmh 828 304 and inst_consumption_wh 1 745 373. Those
  // floors are floors — they cannot see the movement the old 10° deadband hid — but the
  // headroom is an order of magnitude, and the instantaneous ceiling is still the 100 Hz
  // frame rate. Count a real ride's rows before tightening further.
  { key: "attitude_roll_deg", unit: "°", group: "imu", source: "stream", deadband: 1 },
  { key: "attitude_pitch_deg", unit: "°", group: "imu", source: "stream", deadband: 1 },

  // Waypoints — "I am here, now", from the dashboard button or a Siri Shortcut via
  // GET /waypoint (src/http/waypoint.ts). Not measurements: they are written only
  // when asked for, which is why they carry no deadband. The position is copied
  // into its own pair of signals rather than inferred from the nearest gps_lat/lon
  // row, whose ~3 m deadband means the last logged fix can be minutes stale at a
  // standstill — exactly when you stop to save a waypoint.
  { key: "waypoint_seq", unit: "", group: "waypoint", source: "sensor" },
  { key: "waypoint_lat", unit: "°", group: "waypoint", source: "sensor" },
  { key: "waypoint_lon", unit: "°", group: "waypoint", source: "sensor" },

  ...perLmuSignals(),
];

// One 1/0 signal per trouble code Energica documents, so an active code lands in
// the ride log with a real unit and group instead of falling through to "misc".
// Generated from the table for the same reason the cell signals are: 148
// hand-written near-identical lines would bury everything above, and they could
// drift from the keys the decoder emits.
//
// Nothing is recorded for a code that isn't set — these defs exist so that the
// ones that DO appear are already described. See src/diagnostics/record.ts, which
// writes 1 when a code is in the list and 0 once it clears.
function dtcSignals(): SignalDef[] {
  return DTC_TABLE.map(entry => ({
    key: dtcSignalKey(entry.component, entry.symptom),
    unit: "",
    group: "diag",
    source: "stream" as const,
  }));
}

// 0x662-0x664 — the 81 individual cell voltages plus each module's own temperatures,
// once the extended BMS config is flashed. Generated rather than hand-listed so they
// can't drift from the keys the decoder emits, and because ~110 near-identical lines
// would bury everything above.
//
// 5 mV deadband on the cells: the whole point of them is which cell sags, and the
// resting spread worth chasing is tens of mV. Logging every millivolt of
// throttle-driven sag on 81 signals at ~2 Hz each would multiply the DB's row rate by
// more than ten. The temperatures are whole °C and move slowly, so they log on change.
function perLmuSignals(): SignalDef[] {
  const signals: SignalDef[] = [];
  for (let lmuNumber = 1; lmuNumber <= LMU_COUNT; lmuNumber++) {
    for (let cellNumber = 1; cellNumber <= cellsInLmu(lmuNumber); cellNumber++) {
      signals.push({
        key: cellVoltageKey(lmuNumber, cellNumber),
        unit: "mV",
        group: "cells",
        source: "stream",
        deadband: 5,
      });
    }
    const sensors: LmuTemperatureSensor[] = LMUS_WITHOUT_BATTERY_TEMP.includes(lmuNumber)
      ? ["pcb1", "pcb2"]
      : ["bat1", "pcb1", "pcb2"];
    for (const sensor of sensors) {
      signals.push({ key: lmuTemperatureKey(lmuNumber, sensor), unit: "°C", group: "battery", source: "stream" });
    }
  }
  return signals;
}
