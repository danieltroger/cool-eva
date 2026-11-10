// @ts-check
import van from "../vendor/van-1.6.1.js";
import { request } from "./transport.js";
import { serviceCatalogue, serviceProblem } from "./service-state.js";
/** @typedef {import("../../src/http/service-catalogue.ts").ServiceParameter} ServiceParameter */
/** @typedef {import("../../src/http/vcu-probe.ts").VcuProbeResponse} VcuProbeResponse */
/** @typedef {import("../../src/http/vcu-params.ts").VcuParamsResponse} VcuParamsResponse */
/** @typedef {{value:number,readAt:number,source:"read"|"snapshot"}} ParameterReading */

/** @param {ServiceParameter} parameter @param {boolean} [sampled] @returns {ParameterReading|null} */
export function currentParameterReading(parameter, sampled = false) {
  const catalogue = sampled ? serviceCatalogue.rawVal : serviceCatalogue.val;
  if (!catalogue || !catalogue.parameters.includes(parameter)) {
    return null;
  }
  const identity = parameterIdentity(catalogue.tableType, parameter);
  const state = readingState(identity);
  const direct = sampled ? state.rawVal : state.val;
  if (direct === "unconfirmed") {
    return null;
  }
  if (direct) {
    return direct;
  }
  const payload = sampled ? parameterSnapshot.rawVal : parameterSnapshot.val;
  if (payload?.state !== "snapshot" || payload.tableType.tableType !== catalogue.tableType) {
    return null;
  }
  const row = payload.snapshot.rows.find(
    row => row.index === parameter.index && row.name === parameter.name && row.micro === parameter.micro
  );
  return row?.status === "read" && row.value !== null && Number.isSafeInteger(row.value) && !row.widthMismatch
    ? { value: row.value, readAt: payload.snapshot.readAt, source: "snapshot" }
    : null;
}

/** @param {string} name */
export function parameterReadingNamed(name) {
  const parameter = serviceCatalogue.val?.parameters.find(parameter => parameter.name === name);
  return parameter ? currentParameterReading(parameter) : null;
}

/** @param {ServiceParameter} parameter */
export async function readServiceParameter(parameter) {
  const table = serviceCatalogue.rawVal?.tableType;
  if (table === undefined) {
    return null;
  }
  const identity = parameterIdentity(table, parameter);
  try {
    const query = new URLSearchParams({ target: parameter.micro, bank: "1", index: String(parameter.index) });
    const response = await request(`/vcu-probe?${query}`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "service-mode" },
    });
    const payload = /** @type {VcuProbeResponse} */ (await response.json());
    const answer = payload.reading;
    if (
      !response.ok ||
      answer?.status !== "read" ||
      answer.value === null ||
      !Number.isSafeInteger(answer.value) ||
      answer.name !== parameter.name ||
      answer.index !== parameter.index ||
      answer.target !== parameter.micro ||
      answer.bank !== 1
    ) {
      throw new Error(answer?.note ?? payload.message ?? "Parameter read unavailable");
    }
    if (table !== serviceCatalogue.rawVal?.tableType) {
      return null;
    }
    const reading = { value: answer.value, readAt: Date.now(), source: /** @type {const} */ ("read") };
    readingState(identity).val = reading;
    return reading;
  } catch (error) {
    readingState(identity).val = "unconfirmed";
    serviceProblem.val = describeError(error);
    console.warn(`service: parameter ${parameter.name} read failed`, error);
    return null;
  }
}

/** @param {ServiceParameter} parameter @param {number|null} value */
export function rememberParameter(parameter, value) {
  const catalogue = serviceCatalogue.rawVal;
  const table = catalogue?.tableType;
  if (table === undefined || !catalogue?.parameters.includes(parameter)) {
    return;
  }
  const identity = parameterIdentity(table, parameter);
  if (value === null || !Number.isSafeInteger(value)) {
    readingState(identity).val = "unconfirmed";
  } else {
    readingState(identity).val = { value, readAt: Date.now(), source: "read" };
  }
}

const parameterSnapshot = van.state(/** @type {VcuParamsResponse|null} */ (null));
/** @type {Map<string,import("../vendor/van-1.6.1.js").State<ParameterReading|"unconfirmed"|null>>} */
const readings = new Map();

export async function loadParameterSnapshot() {
  try {
    const response = await request("/vcu-params", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Parameter snapshot: HTTP ${response.status}`);
    }
    parameterSnapshot.val = /** @type {VcuParamsResponse} */ (await response.json());
  } catch (error) {
    parameterSnapshot.val = null;
    console.warn("service: parameter snapshot unavailable", error);
  }
}

/** @param {number} table @param {ServiceParameter} parameter */
function parameterIdentity(table, parameter) {
  return `${table}/${parameter.index}/${parameter.name}`;
}

/** @param {string} identity */
function readingState(identity) {
  let state = readings.get(identity);
  if (!state) {
    state = van.state(/** @type {ParameterReading|"unconfirmed"|null} */ (null));
    readings.set(identity, state);
  }
  return state;
}

/** @param {unknown} error */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
