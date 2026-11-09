// @ts-check
import van from "../vendor/van-1.6.1.js";
/** @typedef {import("../../src/http/service-catalogue.ts").ServiceCatalogue} ServiceCatalogue */
/** @typedef {import("../../src/http/service-catalogue.ts").ServiceParameter} ServiceParameter */
/** @typedef {import("../../src/vcu/write-runner.ts").VcuWriteStatus} VcuWriteStatus */
/** @typedef {{parameter:ServiceParameter,previous:number,value:number}} ServiceChange */

export const serviceCatalogue = van.state(/** @type {ServiceCatalogue|null} */ (null));
export const serviceStatus = van.state(/** @type {VcuWriteStatus|null} */ (null));
export const serviceBusy = van.state(false);
export const serviceProblem = van.state("");
export const serviceChanges = van.state(/** @type {ServiceChange[]} */ ([]));
