// @ts-check
import van from "../vendor/van-1.6.1.js";
import { arm, armDwellElapsed, armed } from "./arming.js";
import {
  currentParameterReading,
  noteServiceChange,
  readServiceParameter,
  rememberParameter,
  refreshServiceStatus,
  sendServiceWrite,
  serviceBusy,
  serviceCanRead,
  serviceCanWrite,
  serviceCatalogue,
  serviceOpen,
  serviceOperation,
  serviceProblem,
} from "./service-client.js";

/** @typedef {import("../../src/http/service-catalogue.ts").ServiceParameter} ServiceParameter */
/** @typedef {{kind:"armed"|"unchanged"|"updated"|"confirmed"|"unconfirmed",reason?:string}} ParameterAttempt */
/** @typedef {{key:string,parameter:ServiceParameter,value:number,expected:number,table:number}} ParameterConfirmation */

export function resetServiceEditor() {
  selectionVersion++;
  selectedParameter.val = null;
  parameterSearch.val = "";
  parameterSearchActive.val = false;
  serviceEditor.val = "";
  newParameterValue.val = "";
  parameterOutcome.val = null;
  dirty = false;
  confirmation = null;
  armed.val = "";
}

export const selectedParameter = van.state(/** @type {ServiceParameter|null} */ (null));
export const parameterSearch = van.state("");
export const parameterSearchActive = van.state(false);
export const serviceEditor = van.state(/** @type {""|"parameter"|"backup"} */ (""));
export const newParameterValue = van.state("");
export const parameterOutcome = van.state(/** @type {ParameterAttempt|null} */ (null));
let selectionVersion = 0;
let dirty = false;
let confirmation = /** @type {ParameterConfirmation|null} */ (null);

/** @param {ServiceParameter} parameter */
export async function selectServiceParameter(parameter) {
  const version = ++selectionVersion;
  selectedParameter.val = parameter;
  parameterSearch.val = parameter.name;
  parameterSearchActive.val = false;
  serviceEditor.val = "parameter";
  parameterOutcome.val = null;
  armed.val = "";
  confirmation = null;
  dirty = false;
  const known = currentParameterReading(parameter, true);
  newParameterValue.val = known ? String(known.value * parameter.scale) : "";
  if (!serviceCanRead(true)) {
    return;
  }
  await serviceOperation(async () => {
    const reading = await readServiceParameter(parameter);
    if (version === selectionVersion && !reading) {
      parameterOutcome.val = { kind: "unconfirmed", reason: serviceProblem.rawVal };
    }
    if (version === selectionVersion && !dirty && reading) {
      newParameterValue.val = String(reading.value * parameter.scale);
    }
  });
}

/** @param {string} text */
export function changeParameterSearch(text) {
  parameterSearch.val = text;
  parameterSearchActive.val = true;
  serviceEditor.val = "";
  armed.val = "";
  confirmation = null;
}

/** @param {string} text */
export function changeNewParameterValue(text) {
  dirty = true;
  newParameterValue.val = text;
  parameterOutcome.val = null;
  confirmation = null;
  armed.val = "";
}

/** @param {ServiceParameter} parameter @param {number} value @param {string} key @param {()=>boolean} stillCurrent @returns {Promise<ParameterAttempt|null>} */
export async function confirmParameterChange(parameter, value, key, stillCurrent) {
  if (
    serviceBusy.rawVal ||
    !serviceOpen() ||
    !parameter.writable ||
    !Number.isSafeInteger(value) ||
    value < parameter.minimum ||
    value > parameter.maximum
  ) {
    return null;
  }
  if (!serviceCatalogue.rawVal?.parameters.includes(parameter)) {
    return null;
  }
  if (armed.rawVal !== key) {
    return serviceOperation(() => prepareParameterChange(parameter, value, key, stillCurrent));
  }
  if (!armDwellElapsed()) {
    return null;
  }
  return serviceOperation(() => performParameterChange(parameter, value, key, stillCurrent));
}

/** @param {ServiceParameter} parameter @param {number} value @param {string} key @param {()=>boolean} stillCurrent @returns {Promise<ParameterAttempt>} */
async function prepareParameterChange(parameter, value, key, stillCurrent) {
  const table = serviceCatalogue.rawVal?.tableType;
  const before = currentParameterReading(parameter, true);
  if (!(await refreshServiceStatus()) || !serviceCanWrite(true)) {
    return { kind: "unconfirmed", reason: serviceProblem.rawVal };
  }
  const current = await readServiceParameter(parameter);
  if (!current) {
    return { kind: "unconfirmed", reason: serviceProblem.rawVal };
  }
  if (
    !serviceOpen() ||
    !stillCurrent() ||
    table !== serviceCatalogue.rawVal?.tableType ||
    !serviceCatalogue.rawVal?.parameters.includes(parameter)
  ) {
    return { kind: "updated" };
  }
  if (current.value === value) {
    return { kind: "unchanged" };
  }
  if (before && before.value !== current.value) {
    return { kind: "updated" };
  }
  if (table === undefined) {
    return { kind: "unconfirmed" };
  }
  confirmation = { key, parameter, value, expected: current.value, table };
  arm(key);
  return { kind: "armed" };
}

/** @param {ServiceParameter} parameter @param {number} value @param {string} key @param {()=>boolean} stillCurrent @returns {Promise<ParameterAttempt>} */
async function performParameterChange(parameter, value, key, stillCurrent) {
  const pending = confirmation;
  if (
    !pending ||
    pending.key !== key ||
    pending.parameter !== parameter ||
    pending.value !== value ||
    pending.table !== serviceCatalogue.rawVal?.tableType ||
    !serviceCanWrite(true) ||
    !serviceOpen() ||
    !stillCurrent()
  ) {
    armed.val = "";
    return { kind: "updated" };
  }
  confirmation = null;
  const query = new URLSearchParams({
    action: "parameter",
    name: parameter.name,
    value: String(value),
    expected: String(pending.expected),
  });
  const payload = await sendServiceWrite(query);
  const result = payload?.result;
  const onBike = result?.onBike;
  rememberParameter(parameter, onBike?.name === parameter.name ? onBike.value : null);
  if (result?.succeeded && result.status === "written" && onBike?.name === parameter.name && onBike.value === value) {
    noteServiceChange(parameter, pending.expected, value);
    return { kind: "confirmed" };
  }
  return { kind: "unconfirmed", reason: payload?.message ?? result?.message ?? serviceProblem.rawVal };
}

van.derive(() => {
  const catalogue = serviceCatalogue.val;
  const parameter = selectedParameter.rawVal;
  if (parameter && !catalogue?.parameters.includes(parameter)) {
    resetServiceEditor();
  }
});

van.derive(() => {
  const parameter = selectedParameter.val;
  const reading = parameter ? currentParameterReading(parameter) : null;
  if (reading && parameter && !dirty && newParameterValue.rawVal === "") {
    newParameterValue.val = String(reading.value * parameter.scale);
  }
});
