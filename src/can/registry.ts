import type { SignalDef } from './signals.ts';

// Central registry of every signal we log — units/groups for the phone dashboard
// and the `signal` table, plus optional per-signal deadbands to tame chatty
// analog signals (see obd-garage/INTEGRATION_PLAN.md §Logging model).
//
// deadband omitted ⇒ 0 ⇒ log on any change (i.e. at sensor resolution).
export const SIGNALS: SignalDef[] = [
  // External MAX31865 coolant probes (battery loop in/out)
  { key: 'coolant_in', unit: '°C', group: 'coolant', source: 'sensor', deadband: 0.1 },
  { key: 'coolant_out', unit: '°C', group: 'coolant', source: 'sensor', deadband: 0.1 },

  // 0x200 — BMS
  { key: 'batt_temp_lo', unit: '°C', group: 'battery', source: 'stream' },
  { key: 'batt_temp_hi', unit: '°C', group: 'battery', source: 'stream' },
  { key: 'soc', unit: '%', group: 'battery', source: 'stream' },
  { key: 'soh', unit: '%', group: 'battery', source: 'stream' },
  { key: 'pack_v', unit: 'V', group: 'battery', source: 'stream' },
  { key: 'pack_a', unit: 'A', group: 'battery', source: 'stream' },
  { key: 'pack_kw', unit: 'kW', group: 'battery', source: 'stream', deadband: 0.05 },

  // 0x201 — charge state (1 idle / 2 AC / 10·16 DC)
  { key: 'charge_state', unit: '', group: 'charge', source: 'stream' },

  // 0x203 — cell balance
  { key: 'cell_min_mv', unit: 'mV', group: 'cells', source: 'stream' },
  { key: 'cell_max_mv', unit: 'mV', group: 'cells', source: 'stream' },
  { key: 'cell_spread_mv', unit: 'mV', group: 'cells', source: 'stream' },
  { key: 'min_cell_idx', unit: '', group: 'cells', source: 'stream' },
  { key: 'max_cell_idx', unit: '', group: 'cells', source: 'stream' },

  // 0x025 — instantaneous consumption
  { key: 'inst_consumption_wh', unit: 'Wh', group: 'energy', source: 'stream', deadband: 0.5 },

  // 0x305 / 0x306 — charger (present only while charging)
  { key: 'dc_v', unit: 'V', group: 'charge', source: 'stream' },
  { key: 'dc_a', unit: 'A', group: 'charge', source: 'stream' },
  { key: 'mains_v', unit: 'V', group: 'charge', source: 'stream' },
  { key: 'mains_a', unit: 'A', group: 'charge', source: 'stream' },

  // OBD-II polled @1 Hz
  { key: 'bike_coolant_temp', unit: '°C', group: 'obd', source: 'poll' },
  { key: 'oil_temp', unit: '°C', group: 'obd', source: 'poll' },
  { key: 'aux_12v', unit: 'V', group: 'obd', source: 'poll', deadband: 0.02 },
  { key: 'soh_pid', unit: '%', group: 'obd', source: 'poll' },
];
