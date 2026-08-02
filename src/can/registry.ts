import type { SignalDef } from "./signals.ts";
import {
  LMU_COUNT,
  LMUS_WITHOUT_BATTERY_TEMP,
  cellsInLmu,
  cellVoltageKey,
  lmuTemperatureKey,
  type LmuTemperatureSensor,
} from "./decode-bms.ts";

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
  // them (see pack-temperature.ts), so the history stays one continuous series.
  // The _vcu pair is what the VCU and dash actually read: identical to the true pair
  // on the stock config, and 15 °C lower once the DC-derate offset is flashed. The
  // difference between the two is the useful signal — it should be a constant 15 °C,
  // and anything else means the postprocessor isn't doing what we think.
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
  // Diagnostic, retire once confirmed: the full 16-bit postprocessor Output3 slot,
  // to check that a 1-byte postprocessor result really lands in the LOW byte. Holds a
  // small temperature, so a deadband would only mask the thing it exists to reveal.
  { key: "pp_output3_raw", unit: "", group: "bms", source: "stream" },

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

  // Keyless / immobilizer
  { key: "key_fob_id", unit: "", group: "security", source: "stream" }, // 0x480 b2-5 LE uint32
  { key: "keys_paired", unit: "", group: "security", source: "poll" }, // E-LOCK 0x791 `21 99`, once at startup

  // --- Bluetooth (Connectivity Hub) ---------------------------------------
  // Pushed by the hub over BLE, not polled. GPS is NOT on the CAN bus at all
  // (see obd-garage/CAN_MAP.md §"GPS: NOT on the VDB bus"), and neither are
  // torque/power or the odometer — PID 01A6 is unsupported by Energica.
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
  // the road. Logged raw and unthrottled (~2 Hz, the rate the hub sends it): if a
  // ride ever comes back with timestamps from a no-network boot, having the real
  // time sitting next to every row makes it repairable without any reasoning.
  { key: "gps_epoch_s", unit: "s", group: "gps", source: "stream" },

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

  ...perLmuSignals(),
];

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
