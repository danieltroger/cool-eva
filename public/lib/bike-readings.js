// @ts-check
import van from "../vendor/van-1.6.1.js";
import { destination } from "./destination.js";
import { loadLifetimeStats } from "./lifetime.js";
import { request } from "./transport.js";

/** Opening Bike fetches stored data and permissions; only the read buttons send to the bike. */
export function openBikeReadings() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  bikeHistoryPermission.val = null;
  bikeServicePermission.val = null;
  void loadLifetimeStats(true);
  void refreshBikeReadings();
}

/** @typedef {import("../../src/http/vcu-read.ts").VcuReadResponse} VcuReadResponse */
/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */
/** @typedef {import("../../src/vcu/write-runner.ts").VcuWriteStatus} VcuWriteStatus */
/** @typedef {import("../../src/vcu/stored-service-stamp.ts").StoredServiceStamp} StoredServiceStamp */
/** @typedef {{enabled:boolean,gate:{safe:boolean},busHeldBy?:string|null,run?:{phase:string}}} BikeReadPermission */

export const bikeHistoryPermission = van.state(/** @type {VcuReadResponse|null} */ (null));
export const bikeServicePermission = van.state(/** @type {VcuWriteStatus|null} */ (null));
export const bikeServiceStamp = van.state(/** @type {StoredServiceStamp|null} */ (null));
export const bikeReadBusy = van.state(/** @type {""|"history"|"service"} */ (""));
let pollTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
let statusRevision = 0;

export async function refreshBikeReadings() {
  const revision = ++statusRevision;
  await Promise.all([refreshHistoryPermission(revision), refreshStampPermission(revision)]);
  if (revision === statusRevision && destination.rawVal === "bike-information" && pollTimer === null) {
    pollTimer = setTimeout(pollBikeReadings, 1000);
  }
}

/** @param {BikeReadPermission|null} permission */
export function bikeReadRefusal(permission) {
  if (!permission || !permission.enabled) return "Read unavailable";
  if (!permission.gate.safe) return "Park to read";
  if (permission.busHeldBy || permission.run?.phase === "running") return "Read busy";
  return null;
}

/** @param {BikeReadPermission|null} permission @param {"history"|"service"} kind */
export function bikeReadCaption(permission, kind) {
  if (bikeReadBusy.val) return bikeReadBusy.val === kind ? "Reading…" : "Read busy";
  return bikeReadRefusal(permission) ?? "Read again";
}

async function pollBikeReadings() {
  pollTimer = null;
  if (destination.rawVal !== "bike-information") return;
  if (bikeReadBusy.rawVal) {
    pollTimer = setTimeout(pollBikeReadings, 1000);
    return;
  }
  await refreshBikeReadings();
}

/** @param {number} revision */
async function refreshHistoryPermission(revision) {
  try {
    const response = await request("/vcu-read", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Bike history status: HTTP ${response.status}`);
    }
    const payload = /** @type {VcuReadResponse} */ (await response.json());
    if (revision === statusRevision) {
      bikeHistoryPermission.val = payload;
    }
  } catch (error) {
    if (revision === statusRevision) {
      bikeHistoryPermission.val = null;
    }
    console.warn("bike history: read status unavailable", error);
  }
}

/** @param {number} revision */
async function refreshStampPermission(revision) {
  try {
    const response = await request("/vcu-write?list=0", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Last service status: HTTP ${response.status}`);
    }
    const payload = /** @type {VcuWriteResponse} */ (await response.json());
    if (revision === statusRevision) {
      bikeServicePermission.val = payload.status;
      bikeServiceStamp.val = payload.status.lastServiceStamp;
    }
  } catch (error) {
    if (revision === statusRevision) {
      bikeServicePermission.val = null;
    }
    console.warn("last service: stored reading unavailable", error);
  }
}
