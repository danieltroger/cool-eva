// @ts-check
import van from "../vendor/van-1.6.1.js";
import { destination } from "../lib/destination.js";
import { peekView } from "../lib/router.js";
import { openService } from "../lib/service-client.js";
import { resetServiceEditor } from "../lib/service-edits.js";
import { resetServiceBackup } from "../lib/service-backup.js";
import { refreshLightsState } from "../lib/service-lights.js";
import { ServiceParameters } from "./service-parameters.js";
import { ServiceBackup } from "./service-backup.js";
import { ServiceActions } from "./service-actions.js";
import { ServiceRecent } from "./service-recent.js";
import { ServiceSignals } from "./service-signals.js";

/** @param {boolean} [showSignals] */
export function ServiceMode(showSignals = false) {
  resetServiceEditor();
  resetServiceBackup();
  void openService(serviceVisible).then(refreshLightsState);
  const signals = ServiceSignals(showSignals);
  if (showSignals) {
    requestAnimationFrame(() => signals.scrollIntoView({ block: "start" }));
  }
  return div(
    { class: "settings-page service-page layout-page" },
    div(
      { class: "layout-card layout-stack service-parameter-section" },
      span({ class: "label" }, "Write parameters"),
      ServiceParameters(),
      ServiceBackup()
    ),
    div({ class: "layout-card service-operations" }, ServiceActions(), ServiceRecent()),
    signals
  );
}

const { div, span } = van.tags;

/** Compatibility for the older sheet entry; the persistent Service page owns its own load. @param {()=>boolean} isOpen */
export function refreshServiceMode(isOpen) {
  return openService(isOpen);
}

function serviceVisible() {
  return destination.rawVal === "advanced-service" || (!destination.rawVal && peekView() === "all");
}
