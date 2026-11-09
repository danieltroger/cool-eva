// @ts-check
import { faultKey } from "./expected-faults.js";

/** @typedef {{key:string|null,code:string,description:string}} FaultIdentity */

/** @param {import("./fault-data.js").FaultRow[]} faults @returns {FaultIdentity[]} */
export function activeFaultRows(faults) {
  return faults
    .filter(fault => fault.active)
    .map(fault => ({
      key: fault.codeKey,
      code: fault.row?.obdCode ?? fault.codeKey,
      description: faultDescription(fault.row?.obdCode ?? fault.codeKey, fault.row?.description ?? fault.codeKey),
    }));
}

/** @param {import("../../src/http/stored-dtcs.ts").TroubleCodeSnapshot|null} snapshot @param {FaultIdentity[]} active @returns {FaultIdentity[]} */
export function storedFaultRows(snapshot, active) {
  if (snapshot?.stored.state !== "codes") return [];
  const activeKeys = new Set(active.map(row => row.key));
  return snapshot.stored.codes
    .map(row => ({
      key: row.component === null || row.symptom === null ? null : faultKey(row.component, row.symptom),
      code: row.obdCode,
      description: faultDescription(row.obdCode, row.description ?? row.obdCode),
    }))
    .filter(row => row.key === null || !activeKeys.has(row.key));
}

/** @param {string} code @param {string} description */
function faultDescription(code, description) {
  return FAULT_TITLES[code] ?? description;
}

/** @type {Record<string,string>} */
const FAULT_TITLES = {
  U0028: "Vehicle communication",
  P1032: "Charger communication timed out",
  P0A07: "Coolant pump disconnected",
  B1012: "High beam open circuit",
  P0A80: "Battery condition",
};
