import { activeParameterTable, parameterTable, recordLengthFor } from "../src/vcu/param-table.ts";
import { reportTableType, type VcuParameterRow, type VcuParameterSnapshot } from "../src/vcu/snapshot.ts";
import type { VcuParamsResponse } from "../src/http/vcu-params.ts";
import type { VcuProbeReading } from "../src/vcu/probe.ts";
import { interpretServiceStamp, type ServiceStamp } from "../src/vcu/service-actions.ts";
import { PROBE_TARGETS } from "../src/vcu/probe.ts";

/** Synthetic parameter values for exercising the approved editor; no owner readings or factory defaults. */
export function serviceParameterFixtures(): ServiceParameterFixtures {
  const table = activeParameterTable();
  const values: Record<string, number> = {
    MAX_DC_CHG_CURRENT: 75,
    FCHG_CURRENT_GAIN: 225,
    TORQUE_LIMIT: 2300,
    REGEN_TORQUE_LIMIT: 600,
    MAP3_PWR: 480,
    BEAM_MAX_CURR_TH: 7500,
    POSLIGHTS_MAX_CURR_TH: 300,
    RPOSLIGHTS_MAX_CURR_TH: 500,
    STOPLIGHTS_MAX_CURR_TH: 300,
    INDICATOR_MAX_CURR_TH: 2000,
    TABLE_TYPE_uC: table.tableType,
    TABLE_TYPE_uS: table.tableType,
  };
  const probes: Record<string, VcuProbeReading> = {};
  const rows: VcuParameterRow[] = [];
  for (const parameter of parameterTable()) {
    const value = values[parameter.name] ?? 0;
    const rawHex =
      value
        .toString(16)
        .padStart(recordLengthFor(parameter.type) * 2, "0")
        .toUpperCase()
        .match(/../g)
        ?.join(" ") ?? "";
    probes[String(parameter.index)] = {
      target: parameter.micro,
      bank: 1,
      index: parameter.index,
      identifier: parameter.identifier,
      status: "read",
      name: parameter.name,
      section: parameter.section,
      rawHex,
      unsigned: value,
      signed: value,
      value,
      note: null,
      flowControlLatency: null,
    };
    rows.push({
      index: parameter.index,
      identifier: parameter.identifier,
      micro: parameter.micro,
      name: parameter.name,
      section: parameter.section,
      type: parameter.type,
      signed: parameter.signed,
      status: "read",
      rawHex,
      unsigned: value,
      value,
      widthMismatch: false,
      otherBikeValue: null,
      note: null,
    });
  }
  const snapshot: VcuParameterSnapshot = { readAt: Date.UTC(2026, 0, 1), complete: true, micros: ["A8", "A9"], rows };
  return {
    stamp: syntheticServiceStamp(),
    probes,
    targets: [...PROBE_TARGETS],
    params: { state: "snapshot", snapshot, tableType: reportTableType(snapshot) },
  };
}

interface ServiceParameterFixtures {
  stamp: ServiceStamp;
  probes: Record<string, VcuProbeReading>;
  targets: string[];
  params: VcuParamsResponse;
}

function syntheticServiceStamp(): ServiceStamp {
  const seconds = (Date.UTC(2026, 0, 1) - Date.UTC(2000, 0, 1)) / 1000;
  return interpretServiceStamp(
    { dateLow: seconds & 0xffff, dateHigh: seconds >>> 16, odometerLow: 12000, odometerHigh: 0 },
    Date.UTC(2026, 0, 1)
  );
}
