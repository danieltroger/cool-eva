// @ts-check
import van from "../vendor/van-1.6.1.js";
import { arm, armDwellElapsed, armed } from "./arming.js";
import {
  refreshServiceStatus,
  sendServiceWrite,
  serviceBusy,
  serviceCanAct,
  serviceOpen,
  serviceOperation,
  serviceProblem,
  serviceStatus,
} from "./service-client.js";
import { lightsOff, lightsOutcome } from "./service-lights.js";

/** @typedef {"reset-vcu"|"sync-clock"|"set-service-point"|"clear-dtcs"} ServiceAction */
/** @typedef {{completed:boolean,text:string,title:string}} ActionOutcome */

/** @param {ServiceAction} action */
export async function changeServiceAction(action) {
  if (serviceBusy.rawVal || !serviceOpen()) {
    return;
  }
  const key = `service:${action}`;
  if (armed.rawVal !== key) {
    actionOutcome(action).val = null;
    await serviceOperation(() => prepareServiceAction(action, key));
    return;
  }
  if (!armDwellElapsed()) {
    return;
  }
  await serviceOperation(() => performServiceAction(action, key));
}

export const SERVICE_ACTIONS = /** @type {const} */ ([
  {
    action: "reset-vcu",
    title: "Restart bike",
    hint: "Restarts the bike’s computer.",
    confirm: "Confirm bike restart",
  },
  { action: "sync-clock", title: "Set bike clock", hint: "Uses GPS-verified time.", confirm: "Confirm" },
  {
    action: "set-service-point",
    title: "Record service",
    hint: "Overwrites the last-service record.",
    confirm: "Confirm",
  },
  { action: "clear-dtcs", title: "Clear stored faults", hint: "Active problems can return.", confirm: "Confirm" },
]);
/** @type {Map<ServiceAction,import("../vendor/van-1.6.1.js").State<ActionOutcome|null>>} */
const outcomes = new Map();
let confirmation = /** @type {{action:ServiceAction,key:string,token:string}|null} */ (null);

/** @param {ServiceAction} action */
export function actionOutcome(action) {
  let outcome = outcomes.get(action);
  if (!outcome) {
    outcome = van.state(/** @type {ActionOutcome|null} */ (null));
    outcomes.set(action, outcome);
  }
  return outcome;
}

/** @param {string} action @param {string} [iso] */
export function confirmationFor(action, iso = "") {
  return action === "sync-clock" ? `${iso.slice(0, 16)}Z` : action;
}

/** @param {ServiceAction} action @param {boolean} [sampled] */
export function serviceActionAvailable(action, sampled = false) {
  const status = sampled ? serviceStatus.rawVal : serviceStatus.val;
  return (
    serviceCanAct(sampled) &&
    (action !== "sync-clock" || status?.clock.trustworthy === true) &&
    (action !== "reset-vcu" || status?.gate.chargingEvidence === null)
  );
}

/** @param {ServiceAction} action @param {string} key */
async function prepareServiceAction(action, key) {
  if (!(await refreshServiceStatus()) || !serviceActionAvailable(action, true) || !serviceOpen()) {
    return;
  }
  confirmation = { action, key, token: confirmationFor(action, serviceStatus.rawVal?.clock.iso ?? "") };
  arm(key);
}

/** @param {ServiceAction} action @param {string} key */
async function performServiceAction(action, key) {
  const pending = confirmation;
  if (
    !pending ||
    pending.action !== action ||
    pending.key !== key ||
    !serviceOpen() ||
    !serviceActionAvailable(action, true)
  ) {
    armed.val = "";
    return;
  }
  confirmation = null;
  const payload = await sendServiceWrite(new URLSearchParams({ action, confirm: pending.token }));
  const result = payload?.result;
  const expectedAction = action === "sync-clock" ? "rtc-sync" : action;
  if (
    !result?.succeeded ||
    result.action !== expectedAction ||
    (action === "clear-dtcs" && result.clear?.verdict !== "erased") ||
    (action === "set-service-point" && (!result.stamp?.after || result.stamp.after.implausible !== null))
  ) {
    actionOutcome(action).val = {
      completed: false,
      text: "—",
      title: payload?.message ?? result?.message ?? serviceProblem.rawVal,
    };
    return;
  }
  const text =
    action === "reset-vcu"
      ? "Bike restarted."
      : action === "set-service-point"
        ? "Service recorded."
        : action === "clear-dtcs"
          ? "Stored faults cleared."
          : "";
  actionOutcome(action).val = { completed: true, text, title: result.message };
  if (action === "reset-vcu" && lightsOutcome.rawVal?.confirmed) {
    lightsOutcome.val = { confirmed: true, text: `Lights ${lightsOff.rawVal ? "off" : "on"}.`, title: result.message };
  }
}
