// @ts-check
import van from "../vendor/van-1.6.1.js";
import { request } from "./transport.js";
import { armed } from "./arming.js";
import { loadParameterSnapshot } from "./service-parameter-readings.js";
import * as serviceState from "./service-state.js";
export { currentParameterReading, readServiceParameter, rememberParameter } from "./service-parameter-readings.js";
export { serviceCatalogue, serviceStatus, serviceBusy, serviceProblem, serviceChanges } from "./service-state.js";

/** @typedef {import("../../src/http/service-catalogue.ts").ServiceCatalogue} ServiceCatalogue */
/** @typedef {import("../../src/http/service-catalogue.ts").ServiceParameter} ServiceParameter */
/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */
/** @typedef {import("../../src/vcu/write-runner.ts").VcuWriteStatus} VcuWriteStatus */
/** @typedef {import("../../src/http/vcu-read.ts").VcuReadResponse} VcuReadResponse */

/** @param {()=>boolean} isOpen */
export async function openService(isOpen) {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  serviceIsOpen = isOpen;
  armed.val = "";
  serviceState.serviceProblem.val = "";
  attemptedInitialRead = false;
  await Promise.all([refreshCatalogue(), refreshServiceStatus(), loadParameterSnapshot(), refreshParameterRead()]);
  await startInitialRead();
  scheduleGateRefresh();
}

const parameterRead = van.state(/** @type {VcuReadResponse|null} */ (null));

let statusRequest = 0;
let pollTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
let parameterReadRequest = 0;
let attemptedInitialRead = false;
let catalogueRead = /** @type {Promise<void>|null} */ (null);
/** @type {()=>boolean} */
let serviceIsOpen = () => false;

export function serviceOpen() {
  return serviceIsOpen();
}

/** @template Result @param {()=>Promise<Result>} operation @returns {Promise<Result|null>} */
export async function serviceOperation(operation) {
  if (serviceState.serviceBusy.rawVal) {
    return null;
  }
  serviceState.serviceBusy.val = true;
  try {
    return await operation();
  } finally {
    serviceState.serviceBusy.val = false;
    scheduleGateRefresh();
  }
}

export async function refreshServiceStatus() {
  const revision = ++statusRequest;
  try {
    const response = await request("/vcu-write?list=0", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Service status: HTTP ${response.status}`);
    }
    const payload = /** @type {VcuWriteResponse} */ (await response.json());
    if (revision !== statusRequest) {
      return false;
    }
    armed.val = "";
    serviceState.serviceStatus.val = payload.status;
    if (
      serviceOpen() &&
      payload.status.tableGate.tableType !== null &&
      serviceState.serviceCatalogue.rawVal?.tableType !== payload.status.tableGate.tableType
    ) {
      await alignServiceCatalogue(payload.status.tableGate.tableType, revision);
    }
    return true;
  } catch (error) {
    if (revision === statusRequest) {
      armed.val = "";
      serviceState.serviceStatus.val = null;
      serviceState.serviceProblem.val = describeError(error);
    }
    console.warn("service: status unavailable", error);
    return false;
  }
}

export function serviceCanRead(sampled = false) {
  const status = sampled ? serviceState.serviceStatus.rawVal : serviceState.serviceStatus.val;
  const read = sampled ? parameterRead.rawVal : parameterRead.val;
  return !!status?.gate.safe && status.busHeldBy === null && (!serviceOpen() || read?.run.phase !== "running");
}

export function serviceCanAct(sampled = false) {
  const status = sampled ? serviceState.serviceStatus.rawVal : serviceState.serviceStatus.val;
  return !!status?.enabled && serviceCanRead(sampled);
}

export function serviceCanWrite(sampled = false) {
  const status = sampled ? serviceState.serviceStatus.rawVal : serviceState.serviceStatus.val;
  const catalogue = sampled ? serviceState.serviceCatalogue.rawVal : serviceState.serviceCatalogue.val;
  return (
    !!status &&
    serviceCanAct(sampled) &&
    status.tableGate.writesAllowed &&
    status.tableGate.tableType === catalogue?.tableType
  );
}

/** Called only inside serviceOperation, which holds the lock through reads, write and result handling.
 * @param {URLSearchParams} query @returns {Promise<VcuWriteResponse|null>} */
export async function sendServiceWrite(query) {
  const revision = ++statusRequest;
  armed.val = "";
  query.set("list", "0");
  try {
    const response = await request(`/vcu-write?${query}`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "service-write" },
    });
    const payload = /** @type {VcuWriteResponse} */ (await response.json());
    if (revision === statusRequest) {
      serviceState.serviceStatus.val = payload.status;
      if (
        serviceOpen() &&
        payload.status.tableGate.tableType !== null &&
        payload.status.tableGate.tableType !== serviceState.serviceCatalogue.rawVal?.tableType
      ) {
        await alignServiceCatalogue(payload.status.tableGate.tableType, revision);
      }
    }
    serviceState.serviceProblem.val = payload.result?.succeeded
      ? ""
      : (payload.message ?? payload.result?.message ?? "Change unconfirmed");
    return payload;
  } catch (error) {
    serviceState.serviceProblem.val = describeError(error);
    console.warn("service: write response unavailable; delivery is unknown", error);
    return null;
  }
}

/** @param {ServiceParameter} parameter @param {number} previous @param {number} value */
export function noteServiceChange(parameter, previous, value) {
  serviceState.serviceChanges.val = [{ parameter, previous, value }, ...serviceState.serviceChanges.rawVal].slice(
    0,
    20
  );
}

async function refreshCatalogue() {
  if (catalogueRead) {
    await catalogueRead;
    return;
  }
  const pending = loadServiceCatalogue();
  catalogueRead = pending;
  try {
    await pending;
  } finally {
    if (catalogueRead === pending) {
      catalogueRead = null;
    }
  }
}

/** @param {number} tableType @param {number} revision */
async function alignServiceCatalogue(tableType, revision) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await refreshCatalogue();
    if (revision !== statusRequest) {
      return;
    }
    if (serviceState.serviceCatalogue.rawVal?.tableType === tableType) {
      return;
    }
  }
  serviceState.serviceCatalogue.val = null;
  serviceState.serviceProblem.val = "Read only";
  console.warn("service: catalogue does not match the confirmed table", tableType);
}

async function loadServiceCatalogue() {
  try {
    const response = await request("/service-catalogue", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Service catalogue: HTTP ${response.status}`);
    }
    const payload = /** @type {ServiceCatalogue} */ (await response.json());
    armed.val = "";
    serviceState.serviceCatalogue.val = payload;
  } catch (error) {
    serviceState.serviceCatalogue.val = null;
    serviceState.serviceProblem.val = describeError(error);
    console.warn("service: catalogue unavailable", error);
  }
}

function scheduleGateRefresh() {
  if (
    pollTimer !== null ||
    !serviceIsOpen() ||
    (serviceCanRead(true) && parameterRead.rawVal?.run.phase !== "running" && !waitingForInitialRead())
  ) {
    return;
  }
  pollTimer = setTimeout(pollServiceGate, 1000);
}

function waitingForInitialRead() {
  const gate = serviceState.serviceStatus.rawVal?.tableGate;
  return !attemptedInitialRead && !!gate && !gate.writesAllowed && !gate.noReadWillHelp;
}

async function pollServiceGate() {
  pollTimer = null;
  if (!serviceIsOpen()) {
    return;
  }
  const wasRunning = parameterRead.rawVal?.run.phase === "running";
  await Promise.all([refreshServiceStatus(), refreshParameterRead()]);
  if (wasRunning && parameterRead.rawVal?.run.phase !== "running") {
    await loadParameterSnapshot();
  }
  await startInitialRead();
  scheduleGateRefresh();
}

async function refreshParameterRead() {
  const revision = ++parameterReadRequest;
  try {
    const response = await request("/vcu-read", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Parameter read: HTTP ${response.status}`);
    }
    const payload = /** @type {VcuReadResponse} */ (await response.json());
    if (revision === parameterReadRequest) {
      parameterRead.val = payload;
    }
  } catch (error) {
    parameterRead.val = null;
    console.warn("service: parameter read state unavailable", error);
  }
}

async function startInitialRead() {
  const gate = serviceState.serviceStatus.rawVal?.tableGate;
  const read = parameterRead.rawVal;
  if (
    attemptedInitialRead ||
    !serviceOpen() ||
    !gate ||
    gate.writesAllowed ||
    gate.noReadWillHelp ||
    !read?.enabled ||
    !read.gate.safe ||
    serviceState.serviceBusy.rawVal ||
    read.run.phase === "running"
  ) {
    return;
  }
  attemptedInitialRead = true;
  const revision = ++parameterReadRequest;
  try {
    const response = await request("/vcu-read", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "service-mode" },
    });
    const payload = /** @type {VcuReadResponse} */ (await response.json());
    if (revision === parameterReadRequest) {
      parameterRead.val = payload;
    }
    if (!response.ok) {
      throw new Error(`Initial parameter read: HTTP ${response.status}`);
    }
    if (parameterRead.rawVal?.run.phase !== "running") {
      await Promise.all([loadParameterSnapshot(), refreshServiceStatus()]);
    }
  } catch (error) {
    serviceState.serviceProblem.val = describeError(error);
    console.warn("service: initial parameter read failed", error);
  }
}

/** @param {unknown} error */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
