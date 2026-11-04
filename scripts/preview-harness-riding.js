// These variants leave the shared Settings defaults and the Wi-Fi data path intact.
const ridingFixture = new URLSearchParams(window.location.search);
if (ridingFixture.get("fixture") === "all-installed") {
  for (const key of Object.keys(LIVE)) {
    delete LIVE[key];
  }
  __TABLES["/lifetime-stats"].reading = null;
  __TABLES["/freeze-frames"].reading = null;
  JOURNAL.length = 0;
  SETTINGS.saved.coolantProbesEnabled = true;
  SETTINGS.active.coolantProbesEnabled = true;
  SETTINGS.saved.radiatorFanEnabled = true;
  SETTINGS.active.radiatorFanEnabled = true;
  SETTINGS.notices = SETTINGS.notices.filter(notice => notice !== "coolant-default-off");
  SETTINGS.readiness.coolant = "Two probes ready";
  SETTINGS.instanceId = `synthetic-riding-${ridingFixture.get("case") ?? "normal"}`;
  SCENE.fan = { ...SCENE.fan, dutyPercent: 68, targetPercent: 68, driverEnabled: true, phase: "running" };
  Object.assign(LIVE, {
    soc: [46, "%", "battery"],
    bms_remaining_energy_wh: [4800, "Wh", "battery"],
    range_km: [40, "km", "energy"],
    bms_state_charge: [0, "", "battery"],
    bms_state_trickle: [0, "", "battery"],
    bms_state_maintenance: [0, "", "battery"],
    fast_dc_contactor: [0, "", "charge"],
    charge_manager_state: [0, "", "charge"],
    fast_dc_limit_max_a: [75, "A", "charge"],
    charge_soc_limit_pct: [90, "%", "charge"],
    dtc_list_count: [0, "", "diagnostics"],
    dtc_count: [0, "", "diagnostics"],
    mil: [0, "", "diagnostics"],
    gps_speed_kmh: [87, "km/h", "gps"],
    speed_can_kmh: [89, "km/h", "drive"],
    pack_a: [-142, "A", "battery"],
    pack_kw: [-48.3, "kW", "battery"],
    pack_v: [340, "V", "battery"],
    batt_temp_lo: [38, "°C", "battery"],
    batt_temp_hi: [41, "°C", "battery"],
    batt_temp_lo_vcu: [38, "°C", "battery"],
    batt_temp_hi_vcu: [41, "°C", "battery"],
    coolant_in: [36.5, "°C", "coolant"],
    coolant_out: [41.2, "°C", "coolant"],
    motor_temp_c: [65, "°C", "motor"],
    bike_coolant_temp: [67, "°C", "obd"],
    ambient_temp: [17, "°C", "obd"],
    cell_cutoff_mv: [3000, "mV", "cells"],
    cell_min_mv: [3120, "mV", "cells"],
    cell_max_mv: [3158, "mV", "cells"],
    cell_lowest_v_idx: [1, "", "cells"],
    cell_highest_v_idx: [12, "", "cells"],
    allowed_discharge_a: [210, "A", "battery"],
    allowed_regen_a: [55, "A", "battery"],
    fan_target_pct: [68, "%", "fan"],
    fan_duty_pct: [68, "%", "fan"],
    fan_driver_enabled: [1, "", "fan"],
    fan_auto_mode: [1, "", "fan"],
    high_beam: [0, "", "buttons"],
    btn_cruise_set: [0, "", "buttons"],
  });
  for (let module = 1; module <= 11; module += 1) {
    for (let cell = 1; cell <= (module <= 4 ? 8 : 7); cell += 1) {
      LIVE[`lmu${module}_cell${cell}_mv`] = [3120 + ((module * 7 + cell * 3) % 39), "mV", "battery"];
    }
    for (const sensor of ["bat1", "pcb1", "pcb2"]) {
      if (sensor === "bat1" && [6, 8].includes(module)) continue;
      LIVE[`lmu${module}_${sensor}_c`] = [38 + (module % 4), "°C", "battery"];
    }
  }
}

// Substitute only the shipped header button, without enabling BLE transport or changing origins.
if (ridingFixture.get("header-link") === "ble-connect") {
  const originalBleFactory = __MODULES["views/ble-connect.js"];
  if (originalBleFactory) {
    __MODULES["views/ble-connect.js"] = (exports, imp) => {
      originalBleFactory(exports, imp);
      exports.BleHeaderButton = exports.BleConnectButton;
    };
  }
}

const originalInstantiateForRiding = instantiate;
instantiate = function instantiateRidingPreview() {
  const imports = originalInstantiateForRiding();
  window.ridingPreview = imports;
  return imports;
};

const originalSeedForRiding = seed;
seed = async function seedRidingPreview(imports, connectTheStore) {
  if (ridingFixture.get("fixture") === "all-installed") {
    if (connectTheStore) {
      imports("lib/store.js").connect();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return;
  }
  await originalSeedForRiding(imports, connectTheStore);
};
