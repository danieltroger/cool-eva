// These variants leave the shared Settings defaults and the Wi-Fi data path intact.
const ridingFixture = new URLSearchParams(window.location.search);
const fanChangedAt = Date.now() - 60_000;
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
    odometer_can_km: [40012.4, "km", "drive"],
    kwh_per_100km: [16.9, "kWh/100km", "energy"],
    bms_remaining_energy_wh: [4800, "Wh", "battery"],
    range_km: [40, "km", "energy"],
    bms_state_charge: [0, "", "battery"],
    bms_state_trickle: [0, "", "battery"],
    bms_state_maintenance: [0, "", "battery"],
    fast_dc_contactor: [0, "", "charge"],
    charge_manager_state: [0, "", "charge"],
    fast_dc_limit_max_a: [75, "A", "charge"],
    charge_soc_limit_pct: [90, "%", "charge"],
    dtc_list_count: [3, "", "diagnostics"],
    dtc_count: [7, "", "diagnostics"],
    dtc_unrecognised_count: [0, "", "diagnostics"],
    mil_on: [1, "", "diagnostics"],
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
    cell_spread_mv: [38, "mV", "cells"],
    cell_lowest_v_idx: [1, "", "cells"],
    cell_highest_v_idx: [81, "", "cells"],
    lmu_cell_mux: [1, "", "bms"],
    allowed_discharge_a: [210, "A", "battery"],
    allowed_regen_a: [55, "A", "battery"],
    fan_target_pct: [68, "%", "fan", fanChangedAt],
    fan_duty_pct: [68, "%", "fan", fanChangedAt],
    fan_driver_enabled: [1, "", "fan", fanChangedAt],
    fan_auto_mode: [1, "", "fan", fanChangedAt],
    high_beam: [0, "", "buttons"],
    btn_cruise_set: [0, "", "buttons"],
  });
  const longestFaultKey = Object.entries(__TABLES["/dtc-table"].codes).sort(
    (left, right) => right[1].description.length - left[1].description.length
  )[0][0];
  SCENE.expectedFaults = [[44, 0]];
  SCENE.storedComponents = [
    [34, 0],
    [35, 0],
    [39, 0],
    [44, 0],
    [54, 11],
    [60, 0],
    [62, 0],
  ];
  for (const key of new Set([longestFaultKey, "dtc_0044_0", "dtc_0002_0"])) {
    LIVE[key] = [1, "", "diagnostics"];
  }
  if (["clear", "missing"].includes(ridingFixture.get("fault-state"))) {
    for (const key of Object.keys(LIVE).filter(key => /^dtc_\d+_\d+$/.test(key))) {
      LIVE[key][0] = 0;
    }
    LIVE.dtc_list_count[0] = 0;
    LIVE.dtc_unrecognised_count[0] = 0;
    if (ridingFixture.get("fault-state") === "missing") {
      delete LIVE.dtc_list_count;
    }
  }
  if (ridingFixture.get("ride-state") === "charging") {
    Object.assign(LIVE, {
      pack_kw: [15, "kW", "battery"],
      pack_a: [15000 / 340, "A", "battery"],
      fast_dc_contactor: [1, "", "charge"],
      charge_manager_state: [35, "", "charge"],
    });
  }
  let cellPosition = 0;
  for (let module = 1; module <= 11; module += 1) {
    for (let cell = 1; cell <= (module <= 4 ? 8 : 7); cell += 1) {
      cellPosition++;
      LIVE[`lmu${module}_cell${cell}_mv`] = [
        cellPosition === 1 ? 3120 : cellPosition === 81 ? 3158 : 3121 + ((cellPosition * 13) % 37),
        "mV",
        "battery",
      ];
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
  if (ridingFixture.get("fixture") === "all-installed") {
    const now = imports("lib/clock.js").monotonicNow();
    for (let sample = 0; sample <= 10; sample += 1) {
      const at = now - 600_000 + sample * 59_000;
      imports("lib/ring.js").ringFor("coolant_in").push(at, 36.5);
      imports("lib/ring.js")
        .ringFor("cell_spread_mv")
        .push(at, 48 - sample);
      imports("lib/ring.js")
        .ringFor("coolant_out")
        .push(at, 40 + sample * 0.12);
    }
    if (ridingFixture.get("range-history") !== "empty") {
      const rings = imports("lib/ring.js");
      for (let sample = 0; sample <= 60; sample++) {
        const at = now - 122_000 + sample * 2_000;
        rings
          .ringFor("pack_kw")
          .push(
            at,
            ridingFixture.has("charge-scene")
              ? LIVE.pack_kw[0]
              : ridingFixture.get("range-history") === "regen"
                ? 12.168
                : -12.168
          );
        rings.ringFor("odometer_can_km").push(at, 40010 + sample * 0.04);
        rings.ringFor("kwh_per_100km").push(at, 16.9);
      }
    }
    // The template seeds fanReadings() after the harness; restore the real last-change timestamps before mount.
    for (const key of ["fan_auto_mode", "fan_driver_enabled", "fan_duty_pct", "fan_target_pct"]) {
      LIVE[key][3] = fanChangedAt;
    }
  }
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
