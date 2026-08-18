// Energica's own freeze-frame field dictionary — the 120 "info keys" a stored
// freeze frame is built out of. Data only: no I/O, no state, no clock.
//
// ── What this is, and where it came from ─────────────────────────────────────
// The manufacturer's service tool (Energica's dealer software) carries a resource
// it calls `DTCInfoKeys`: 120 records of {id, name, unit, equation, datatype}.
// Every fault in ./fault-infokeys.ts names a subset of these ids, IN ORDER, and
// that ordered subset IS the layout of that fault's freeze-frame payload. So this
// table is two things at once: the names and units that make a freeze frame
// readable, and — through `datatype` — the byte widths that make it decodable at all.
//
// TWO INDEPENDENT COPIES WERE COMPARED, 2026-08-16, and they agree on all 120
// rows for `name`, `equation` and `datatype`:
//   • the telemetry-scaling table extracted from the 2021 build, under the
//     service tool's own folder in `<Energica_Manuals>/`
//   • the `DTCInfoKeys` JSON embedded in the service-tool executable (2024
//     build), by way of the second owner's `dtc_infokeys.py`
// The tool did not change this table between its 1.2.0 and 1.3.0 builds.
//
// ⚠️ THE UNITS COME FROM THE CSV, DELIBERATELY. The 2024 executable's own copy
// has `EF BF BD` (U+FFFD REPLACEMENT CHARACTER) where the degree sign belongs,
// in all 11 temperature rows — Energica destroyed it in their own build, so any
// extraction from the binary inherits `<?>C`. The CSV is the only clean source
// for `°C` and is therefore authoritative for `unit`. That is the one column
// where the two sources differ, and it differs in exactly those 11 rows.
//
// ── ⚠️ `id` IS NOT AN ADDRESS ───────────────────────────────────────────────
// It is the service tool's internal signal index and it has no meaning on the
// wire. The tempting reading `CommonIdentifier = 0x2000 | id` was tested against a
// real bank-2 dump and REFUTED (the service-tool file analysis in obd-garage/,
// §2.3: width agreement is 31.7 % against a 39.0 % chance baseline, and a 29-long
// run of 2-byte signals cannot be placed anywhere in bank 2 at any offset). The
// 2024 service-tool analysis in obd-garage/, §7.2, then found the reason in
// Energica's own source: `(bank << 12) | id` is real but applies to a DIFFERENT
// table, the tool's `LiveData`, which carries its own per-signal `bank`. This one
// carries none.
//
// So: these ids are an index INTO A FREEZE-FRAME PAYLOAD, which is exactly the
// context this file is used in. Do not pass one to src/vcu/param-codec.ts.
//
// ── What is NOT known ───────────────────────────────────────────────────────
// Nothing here has been read off this bike. The table is the manufacturer's,
// the widths are the manufacturer's, and the claim that a payload is these
// fields concatenated in infokey order is the service tool's own decoder behaviour
// as read out of `DTCode.GetInfoDetails` — see ./freeze-frame.ts, which is where
// the layout is asserted and where the caveat belongs.

/** Every C type the 120 records use. `int32_t` never appears, so it is not admitted. */
export type InfokeyDatatype = "uint8_t" | "int8_t" | "uint16_t" | "int16_t" | "uint32_t";

/** How many bytes each datatype occupies in a freeze-frame payload. */
const WIDTH_BY_DATATYPE: Record<InfokeyDatatype, number> = {
  uint8_t: 1,
  int8_t: 1,
  uint16_t: 2,
  int16_t: 2,
  uint32_t: 4,
};

export interface InfokeyField {
  /** The service tool's own signal index, 1…120. An index, never an address — see the header. */
  id: number;
  /** Energica's internal name, verbatim, typos included (`AttitudeSensor_Thete`, `_0xFF`). */
  name: string;
  /** The unit AFTER `equation` is applied. Empty string for the 68 that have none. */
  unit: string;
  datatype: InfokeyDatatype;
  /**
   * Energica's scaling expression, verbatim, kept for provenance even when it is
   * one this repo refuses to apply. `scaleInfokeyValue` is what decides whether it
   * can be honoured; see the note there on why this is not evaluated as code.
   */
  equation: string;
}

/**
 * The four scalings Energica actually uses, plus the one that is malformed.
 *
 * ⚠️ THIS IS A LOOKUP, NOT AN EXPRESSION EVALUATOR, AND THAT IS THE POINT. The
 * whole equation column has five distinct values across 120 fields, so parsing
 * arithmetic buys nothing and costs the ability to say what this code can do. A
 * general evaluator would also have to decide what to do with `f(x)=x@&255`,
 * which is not arithmetic in any language — and "decide" there means "guess at
 * the meaning of a battery statistic".
 *
 * `null` means "Energica states a scaling and we will not apply it". The caller
 * shows the raw value and says so, which is the honest rendering of a field whose
 * scale the manufacturer's own data has mangled.
 */
const SCALING_BY_EQUATION: Record<string, ((raw: number) => number) | null> = {
  // 98 fields. Already in the stated unit.
  "": raw => raw,
  // 18 fields: tenths. Pack volts, pack amps, torque, IGBT temperatures, odometer.
  "f(x)=x*0.1": raw => raw * 0.1,
  // 2 fields, both wheel-speed sensors. 0.05625 = 3.6/64, i.e. a raw count in
  // units of 1/64 m/s turned into km/h. Energica's constant, not our arithmetic.
  "f(x)=x*0.05625": raw => raw * 0.05625,
  // 1 field, V_AIR_TEMP. The standard 0.5 °C/bit, −40 °C offset air-temperature
  // encoding. Note the capital X — Energica uses two syntaxes in one column, so
  // this key is matched literally rather than normalised.
  "(X/2)-40": raw => raw / 2 - 40,
  // 1 field, AvgDOD (id 86), referenced by exactly one fault: (52,0) P1051
  // BATTERY STATISTICS INFO2. `@` is not an operator here or in the other four,
  // so this is a typo in Energica's data — most likely `x & 255` or
  // `x >> 8 & 255`, and those give different numbers. Refused rather than picked.
  "f(x)=x@&255": null,
};

/** How many bytes this field takes in a payload. */
export function infokeyWidth(datatype: InfokeyDatatype): number {
  return WIDTH_BY_DATATYPE[datatype];
}

/** The field with this id, or null when the id is outside 1…120. */
export function lookupInfokey(id: number): InfokeyField | null {
  return INFOKEY_BY_ID.get(id) ?? null;
}

/**
 * How a raw field value scales into its stated unit.
 *
 * `applied: false` is a real outcome and not an error: Energica states a scaling
 * this repo will not perform (today, only `AvgDOD`'s). The raw number is still
 * returned, so a caller always has something true to show.
 */
export type InfokeyScaling = { applied: true; value: number } | { applied: false; reason: string; equation: string };

/**
 * Applies a field's equation to a raw integer.
 *
 * Throws for an equation the table does not list — which cannot happen for the
 * 120 fields below, and is therefore exactly the case worth being loud about: it
 * means someone added a field with a scaling nobody has looked at, and a silent
 * identity there would put an unscaled number on screen wearing a unit.
 */
export function scaleInfokeyValue(field: InfokeyField, raw: number): InfokeyScaling {
  if (!(field.equation in SCALING_BY_EQUATION)) {
    throw new Error(`infokey ${field.id} (${field.name}) has unhandled equation ${JSON.stringify(field.equation)}`);
  }
  const scaling = SCALING_BY_EQUATION[field.equation];
  if (scaling === null) {
    return { applied: false, reason: "Energica's own equation is malformed", equation: field.equation };
  }
  return { applied: true, value: scaling(raw) };
}

/**
 * The 120 fields, in id order and contiguous — `field()` and the check script
 * both rely on that, and ./freeze-frame.ts relies on every referenced id
 * resolving here.
 */
export const INFOKEY_TABLE: readonly InfokeyField[] = [
  field(1, "VEHICLE_SUBSTATE", "", "uint8_t", ""),
  field(2, "D_MOTOR_SPD", "rpm", "int16_t", ""),
  field(3, "P_V12", "mV", "uint16_t", ""),
  field(4, "P_I12", "mA", "uint16_t", ""),
  field(5, "P_TEMP", "°C", "int16_t", "f(x)=x*0.1"),
  field(6, "B_PACK_V", "V", "int16_t", "f(x)=x*0.1"),
  field(7, "B_PACK_I", "A", "int16_t", "f(x)=x*0.1"),
  field(8, "B_H_TEMP", "°C", "int8_t", ""),
  field(9, "B_L_TEMP", "°C", "int8_t", ""),
  field(10, "B_SOC", "%", "uint8_t", ""),
  field(11, "V_AIR_TEMP", "°C", "uint8_t", "(X/2)-40"),
  field(12, "B_STS_FLAG", "", "uint8_t", ""),
  field(13, "B_ERR_ACT", "", "uint16_t", ""),
  field(14, "B_WARN_FLAGS", "", "uint16_t", ""),
  field(15, "B_MIN_CELL_ID", "", "uint8_t", ""),
  field(16, "B_MAX_CELL_ID", "", "uint8_t", ""),
  field(17, "B_MIN_CELL", "mV", "uint16_t", ""),
  field(18, "B_MAX_CELL", "mV", "uint16_t", ""),
  field(19, "D_DSM_STS", "", "uint16_t", ""),
  field(20, "D_DRV_STS", "", "uint8_t", ""),
  field(21, "D_RUN_MODE", "", "uint8_t", ""),
  field(22, "D_CMD_MODE", "", "uint8_t", ""),
  field(23, "uC_AN_MAIN_HVp_SW_CTRL", "", "uint16_t", ""),
  field(24, "V_HVp_MON_SW", "", "uint8_t", ""),
  field(25, "D_DC_VOLT", "V", "int16_t", "f(x)=x*0.1"),
  field(26, "uC_AN_MAIN_HVm_SW_CTRL", "", "uint16_t", ""),
  field(27, "V_HVm_MON_SW", "", "uint8_t", ""),
  field(28, "uC_AN_PRECHG_SW_CTRL", "", "uint16_t", ""),
  field(29, "P_12VLP", "mV", "uint16_t", ""),
  field(30, "AN_12VLP", "", "uint16_t", ""),
  field(31, "AN_12V", "", "uint16_t", ""),
  field(32, "D_MOTOR_T", "°C", "int16_t", "f(x)=x*0.1"),
  field(33, "D_RUN_LOW", "", "uint16_t", ""),
  field(34, "D_RUN_HIGH", "", "uint16_t", ""),
  field(35, "AN_WATERPUMP_CTRL_IS", "", "uint16_t", ""),
  field(36, "V_ODOMETER", "km", "uint32_t", "f(x)=x*0.1"),
  field(37, "C_MAINS_V", "V", "uint16_t", ""),
  field(38, "C_MAINS_C", "A", "uint16_t", ""),
  field(39, "C_DC_V", "V", "uint16_t", "f(x)=x*0.1"),
  field(40, "C_DC_C", "A", "uint16_t", "f(x)=x*0.1"),
  field(41, "C_P_TEMP", "°C", "int8_t", ""),
  field(42, "C_S_TEMP", "°C", "int8_t", ""),
  field(43, "C_ERR_BYTE0", "", "uint8_t", ""),
  field(44, "C_ERR_BYTE1", "", "uint8_t", ""),
  field(45, "C_ERR_BYTE2", "", "uint8_t", ""),
  field(46, "P_1_STS", "", "uint8_t", ""),
  field(47, "ai_WaterPumpCurrent_In", "mA", "uint16_t", ""),
  field(48, "ai_PosLightsCurrent_In", "mA", "uint16_t", ""),
  field(49, "ai_StopLightsCurrent_In", "mA", "uint16_t", ""),
  field(50, "ai_IndicatorLCurr_In", "mA", "uint16_t", ""),
  field(51, "ai_IndicatorRCurr_In", "mA", "uint16_t", ""),
  field(52, "ai_BeamCurrent_In", "mA", "uint16_t", ""),
  field(53, "ai_HornCurrent_In", "mA", "uint16_t", ""),
  field(54, "ai_FanCurrent_In", "mA", "uint16_t", ""),
  field(55, "VehicleLights_ModuleSts", "", "int16_t", ""),
  field(56, "Fan_ModuleSts", "", "int16_t", ""),
  field(57, "Blinker_ModuleSts", "", "int16_t", ""),
  field(58, "WaterPump_ModuleSts", "", "int16_t", ""),
  field(59, "Horn_ModuleSts_In", "", "int16_t", ""),
  field(60, "DriveByWire_ModuleSts", "", "int16_t", ""),
  field(61, "D_IGBTA_T", "°C", "int16_t", "f(x)=x*0.1"),
  field(62, "D_IGBTB_T", "°C", "int16_t", "f(x)=x*0.1"),
  field(63, "D_IGBTC_T", "°C", "int16_t", "f(x)=x*0.1"),
  field(64, "uC_THROTTLE_1_GND", "", "uint16_t", ""),
  field(65, "uC_THROTTLE_1", "", "uint16_t", ""),
  field(66, "uC_THROTTLE_1_PWR", "", "uint16_t", ""),
  field(67, "uC_THROTTLE_2_GND", "", "uint16_t", ""),
  field(68, "uC_THROTTLE_2", "", "uint16_t", ""),
  field(69, "uC_THROTTLE_2_PWR", "", "uint16_t", ""),
  field(70, "uS_THROTTLE_1_GND", "", "uint16_t", ""),
  field(71, "uS_THROTTLE_1", "", "uint16_t", ""),
  field(72, "uS_THROTTLE_1_PWR", "", "uint16_t", ""),
  field(73, "uS_THROTTLE_2_GND", "", "uint16_t", ""),
  field(74, "uS_THROTTLE_2", "", "uint16_t", ""),
  field(75, "uS_THROTTLE_2_PWR", "", "uint16_t", ""),
  // Energica's own pad field. Named `_0xFF` in their data; never referenced by a
  // fault, which is consistent with it being padding rather than a signal.
  field(76, "_0xFF", "", "uint8_t", ""),
  field(77, "B_AVG_CELL", "mV", "uint16_t", ""),
  field(78, "V_TCSOC", "%", "uint8_t", ""),
  field(79, "B_SOH", "%", "uint8_t", ""),
  field(80, "TotalExchangedAh", "Ah", "uint32_t", "f(x)=x*0.1"),
  field(81, "CompletedCharges", "", "uint16_t", ""),
  field(82, "CompletedACCharges", "", "uint16_t", ""),
  field(83, "CompletedDCCharges", "", "uint16_t", ""),
  field(84, "AvgBattTemp", "°C", "int16_t", "f(x)=x*0.1"),
  field(85, "AvgCycleDepth", "", "uint8_t", ""),
  field(86, "AvgDOD", "%", "uint16_t", "f(x)=x@&255"),
  field(87, "uS_saferty_low_level_Sts", "", "uint16_t", ""),
  field(88, "uC_saferty_low_level_Sts", "", "uint16_t", ""),
  field(89, "VCU_CM_COM_BYTE0", "", "uint8_t", ""),
  field(90, "V_EV_ERROR", "", "uint8_t", ""),
  field(91, "CM_V_COM_BYTE0", "", "uint8_t", ""),
  field(92, "CM_ERROR", "", "uint8_t", ""),
  field(93, "V_TRQ_CMD", "Nm", "int16_t", "f(x)=x*0.1"),
  field(94, "D_TRQ_CMD", "Nm", "int16_t", "f(x)=x*0.1"),
  field(95, "D_TRQ_FEED", "Nm", "int16_t", "f(x)=x*0.1"),
  field(96, "AttitudeSensor_Gx", "mg", "int16_t", ""),
  field(97, "AttitudeSensor_Gy", "mg", "int16_t", ""),
  field(98, "AttitudeSensor_Gz", "mg", "int16_t", ""),
  field(99, "AttitudeSensor_Phi", "deg", "int16_t", "f(x)=x*0.1"),
  // Energica's spelling of "Theta", kept verbatim so a search of their data finds it.
  field(100, "AttitudeSensor_Thete", "deg", "int16_t", "f(x)=x*0.1"),
  field(101, "AttitudeSensor_Mag", "mg", "int16_t", ""),
  field(102, "FlashExtEraseStatus", "", "uint8_t", ""),
  field(103, "FlashExtFreezeFrame_WritteAdress", "", "uint16_t", ""),
  field(104, "FlashExtTotallyFull_WriteFlag", "", "uint16_t", ""),
  field(105, "FlashExtOperation_FaultFlag", "", "uint16_t", ""),
  field(106, "RealSpd_x10", "km/h", "int16_t", ""),
  field(107, "A_F_SPD_SENS", "km/h", "uint16_t", "f(x)=x*0.05625"),
  field(108, "A_FSENS_FAIL", "", "uint8_t", ""),
  field(109, "A_R_SPD_SENS", "km/h", "uint16_t", "f(x)=x*0.05625"),
  field(110, "A_RSENS_FAIL", "", "uint8_t", ""),
  field(111, "A_F_PRESSURE", "bar", "uint8_t", ""),
  field(112, "A_F_PRESSURE_VALIDITY", "", "uint8_t", ""),
  field(113, "uC_CAN_VDB_BUS_OFF", "", "uint8_t", ""),
  field(114, "uS_CAN_VDB_BUS_OFF", "", "uint8_t", ""),
  field(115, "uC_AN_FChg_SW_CTRL", "", "uint16_t", ""),
  field(116, "V_FChg_MON_SW", "", "uint8_t", ""),
  field(117, "uC_AN_CHG_SW_CTRL", "", "uint16_t", ""),
  field(118, "CM_ERROR_SOURCE", "", "uint8_t", ""),
  field(119, "CM_ERROR_CODE_MSB", "", "uint8_t", ""),
  field(120, "CM_ERROR_CODE_LSB", "", "uint8_t", ""),
];

const INFOKEY_BY_ID = new Map(INFOKEY_TABLE.map(entry => [entry.id, entry]));

function field(id: number, name: string, unit: string, datatype: InfokeyDatatype, equation: string): InfokeyField {
  return { id, name, unit, datatype, equation };
}
