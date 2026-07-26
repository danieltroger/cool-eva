import type { SignalDef } from "./signals.ts";

// Central registry of every signal we log — units/groups for the phone dashboard
// and the `signal` table, plus optional per-signal deadbands to tame chatty
// analog signals (see obd-garage/INTEGRATION_PLAN.md §Logging model).
//
// deadband omitted ⇒ 0 ⇒ log on any change (i.e. at sensor resolution).
export const SIGNALS: SignalDef[] = [
  // External MAX31865 coolant probes (battery loop in/out)
  { key: "coolant_in", unit: "°C", group: "coolant", source: "sensor", deadband: 0.05 },
  { key: "coolant_out", unit: "°C", group: "coolant", source: "sensor", deadband: 0.05 },

  // 0x200 — BMS
  { key: "batt_temp_lo", unit: "°C", group: "battery", source: "stream" },
  { key: "batt_temp_hi", unit: "°C", group: "battery", source: "stream" },
  { key: "soc", unit: "%", group: "battery", source: "stream" },
  { key: "soh", unit: "%", group: "battery", source: "stream" },
  { key: "pack_v", unit: "V", group: "battery", source: "stream" },
  { key: "pack_a", unit: "A", group: "battery", source: "stream" },
  { key: "pack_kw", unit: "kW", group: "battery", source: "stream", deadband: 0.05 },

  // 0x201 — charge state (1 idle / 2 AC / 10·16 DC)
  { key: "charge_state", unit: "", group: "charge", source: "stream" },

  // 0x203 — cell balance
  { key: "cell_min_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_avg_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_max_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "cell_spread_mv", unit: "mV", group: "cells", source: "stream" },
  { key: "min_cell_idx", unit: "", group: "cells", source: "stream" },
  { key: "max_cell_idx", unit: "", group: "cells", source: "stream" },

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
];
