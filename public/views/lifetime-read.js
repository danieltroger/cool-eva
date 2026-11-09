// @ts-check
import van from "../vendor/van-1.6.1.js";
import {
  bikeHistoryPermission,
  bikeReadBusy,
  bikeReadCaption,
  bikeReadRefusal,
  refreshBikeReadings,
} from "../lib/bike-readings.js";
import { loadLifetimeStats } from "../lib/lifetime.js";
import { request } from "../lib/transport.js";

// Read timing and storage constraints: docs/lifetime-battery-statistics.md.

export function LifetimeReadButton() {
  return div(
    { class: "settings-card" },
    div(
      { class: "settings-row owner-action" },
      div("Bike history"),
      button(
        {
          class: "settings-button",
          "data-bike-read": "history",
          disabled: () => !!bikeReadBusy.val || bikeReadRefusal(bikeHistoryPermission.val) !== null,
          onclick: () => void performLifetimeRead(),
        },
        () => bikeReadCaption(bikeHistoryPermission.val, "history")
      )
    ),
    () => (message.val ? div({ class: "action-note", role: "status", title: messageTitle.val }, message.val) : div())
  );
}

/** @typedef {import("../../src/http/lifetime-read.ts").LifetimeReadResponse} LifetimeReadResponse */
const { button, div } = van.tags;
const message = van.state("");
const messageTitle = van.state("");

async function performLifetimeRead() {
  if (bikeReadBusy.rawVal || bikeReadRefusal(bikeHistoryPermission.rawVal) !== null) return;
  bikeReadBusy.val = "history";
  message.val = "";
  try {
    const response = await request("/lifetime-read", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "service-mode" },
    });
    const payload = /** @type {LifetimeReadResponse} */ (await response.json());
    messageTitle.val = [payload.measurement, payload.message].filter(Boolean).join(" · ");
    message.val = response.ok && payload.answered === 2 ? "Read complete" : "Read failed";
  } catch (error) {
    console.warn("lifetime-read: request failed", error);
    messageTitle.val = error instanceof Error ? error.message : String(error);
    message.val = "Read failed";
  } finally {
    bikeReadBusy.val = "";
    await Promise.all([loadLifetimeStats(true), refreshBikeReadings()]);
  }
}
