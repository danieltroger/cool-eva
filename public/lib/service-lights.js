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
  serviceCanWrite,
  serviceCatalogue,
  serviceOpen,
  serviceOperation,
  serviceProblem,
} from "./service-client.js";

/** @typedef {import("../../src/http/service-catalogue.ts").ServiceParameter} ServiceParameter */
/** @typedef {{parameter:ServiceParameter,value:number,expected:number}} LightWrite */
/** @typedef {{key:string,off:boolean,table:number,writes:LightWrite[]}} LightConfirmation */

export async function changeServiceLights() {
  if (serviceBusy.rawVal || !serviceOpen()) {
    return;
  }
  const off = !lightsOff.rawVal;
  const key = off ? "service:lights-off" : "service:lights-restore";
  if (armed.rawVal !== key) {
    lightsOutcome.val = null;
    await serviceOperation(() => prepareLightChange(off, key));
    return;
  }
  if (!armDwellElapsed()) {
    return;
  }
  await serviceOperation(() => performLightChange(off, key));
}

export const lightsOff = van.state(false);
export const lightsOutcome = van.state(/** @type {{confirmed:boolean,text:string,title:string}|null} */ (null));
let confirmation = /** @type {LightConfirmation|null} */ (null);

const LIGHT_CIRCUITS = [
  { name: "BEAM_MAX_CURR_TH", off: 1810, catalogue: 7500 },
  { name: "POSLIGHTS_MAX_CURR_TH", off: 10, catalogue: 300 },
  { name: "RPOSLIGHTS_MAX_CURR_TH", off: 5, catalogue: 500 },
  { name: "STOPLIGHTS_MAX_CURR_TH", off: 25, catalogue: 300 },
  { name: "INDICATOR_MAX_CURR_TH", off: 500, catalogue: 500 },
];
const SAVED_LIGHTS_KEY = "cool-eva.lightHealthyMax";

export function refreshLightsState() {
  const catalogue = serviceCatalogue.rawVal;
  if (!catalogue) {
    return;
  }
  const readings = LIGHT_CIRCUITS.map(circuit => {
    const parameter = catalogue.parameters.find(parameter => parameter.name === circuit.name);
    return { circuit, reading: parameter ? currentParameterReading(parameter, true) : null };
  });
  if (readings.every(entry => entry.reading !== null)) {
    lightsOff.val = readings.every(entry => entry.reading !== null && entry.reading.value <= entry.circuit.off);
  }
}

/** @param {boolean} off @param {string} key */
async function prepareLightChange(off, key) {
  if (!(await refreshServiceStatus()) || !serviceCanWrite(true)) {
    return;
  }
  const catalogue = serviceCatalogue.rawVal;
  if (!catalogue) {
    return;
  }
  const saved = savedLightValues();
  /** @type {LightWrite[]} */
  const writes = [];
  for (const circuit of LIGHT_CIRCUITS) {
    const parameter = catalogue.parameters.find(parameter => parameter.name === circuit.name && parameter.writable);
    if (!parameter) {
      refuseLights(`${circuit.name}: Read only`);
      return;
    }
    const reading = await readServiceParameter(parameter);
    if (!serviceOpen() || serviceCatalogue.rawVal !== catalogue) {
      return;
    }
    if (!reading) {
      refuseLights(serviceProblem.rawVal);
      return;
    }
    const healthy = saved[circuit.name];
    const value = off
      ? circuit.off
      : typeof healthy === "number" && healthy > circuit.off
        ? healthy
        : circuit.catalogue;
    if (!off && value <= circuit.off) {
      refuseLights(`${circuit.name}: no healthy restore value is saved`);
      return;
    }
    if (value === reading.value) {
      continue;
    }
    if (off && reading.value > circuit.off) {
      saveLightValue(circuit.name, reading.value);
    }
    writes.push({ parameter, value, expected: reading.value });
  }
  if (!writes.length) {
    confirmLights(off);
    return;
  }
  confirmation = { key, off, table: catalogue.tableType, writes };
  arm(key);
}

/** @param {boolean} off @param {string} key */
async function performLightChange(off, key) {
  const pending = confirmation;
  if (
    !pending ||
    pending.off !== off ||
    pending.key !== key ||
    pending.table !== serviceCatalogue.rawVal?.tableType ||
    !serviceOpen() ||
    !serviceCanWrite(true)
  ) {
    armed.val = "";
    return;
  }
  confirmation = null;
  const query = new URLSearchParams({ action: "parameters" });
  for (const write of pending.writes) {
    query.append("w", `${write.parameter.name}:${write.value}:${write.expected}`);
  }
  const payload = await sendServiceWrite(query);
  let complete = payload?.result?.succeeded === true;
  for (const write of pending.writes) {
    const result = payload?.result?.writes?.find(result => result.name === write.parameter.name);
    const current = result?.onBike;
    rememberParameter(write.parameter, current?.name === write.parameter.name ? current.value : null);
    if (
      !result?.succeeded ||
      result.status !== "written" ||
      current?.name !== write.parameter.name ||
      current.value !== write.value
    ) {
      complete = false;
    } else {
      noteServiceChange(write.parameter, write.expected, write.value);
    }
  }
  if (complete) {
    confirmLights(off);
  } else {
    refuseLights(payload?.message ?? payload?.result?.message ?? serviceProblem.rawVal);
  }
}

/** @param {boolean} off */
function confirmLights(off) {
  lightsOff.val = off;
  armed.val = "";
  lightsOutcome.val = { confirmed: true, text: `Lights set ${off ? "off" : "on"}. Restart bike to apply.`, title: "" };
}

/** @param {string} reason */
function refuseLights(reason) {
  armed.val = "";
  lightsOutcome.val = { confirmed: false, text: "—", title: reason };
}

/** @returns {Record<string,number>} */
function savedLightValues() {
  try {
    const text = localStorage.getItem(SAVED_LIGHTS_KEY);
    if (!text) {
      return {};
    }
    const parsed = /** @type {unknown} */ (JSON.parse(text));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    /** @type {Record<string,number>} */
    const values = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        values[name] = value;
      }
    }
    return values;
  } catch (error) {
    console.warn("service: saved light values unavailable", error);
    return {};
  }
}

/** @param {string} name @param {number} value */
function saveLightValue(name, value) {
  try {
    const values = savedLightValues();
    values[name] = value;
    localStorage.setItem(SAVED_LIGHTS_KEY, JSON.stringify(values));
  } catch (error) {
    console.warn(`service: healthy light value for ${name} could not be saved`, error);
  }
}
