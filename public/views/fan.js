// @ts-check
// GPIO control and wire-ordering constraints: docs/fan-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { settings } from "../lib/settings.js";
import { freshValue, readingStatus } from "../lib/reading-status.js";
import { dutyStopIndex } from "../lib/fan-display.js";
import * as fanControls from "../lib/fan-control.js";
import * as colors from "../lib/colors.js";

const { div, span, button, input } = van.tags;

export function FanControl() {
  void fanControls.refreshFanStatus();
  return div(
    { class: "tile layout-card cooling-fan", hidden: () => settings.val?.active.radiatorFanEnabled === false },
    div(
      { class: "layout-between" },
      span({ class: "ride-label" }, "Cooling fan"),
      div(
        { class: "value" },
        span(
          {
            "data-signal": "fan_target_pct",
            style: () => `color:${readingStatus("fan_target_pct") === "fault" ? colors.BAD : colors.CALM}`,
          },
          () =>
            freshValue("fan_target_pct") === null
              ? readingStatus("fan_target_pct") === "missing"
                ? "—"
                : readingStatus("fan_target_pct")
              : String(Math.round(freshValue("fan_target_pct") ?? 0))
        ),
        () => (freshValue("fan_target_pct") === null ? "" : span({ class: "unit" }, "%"))
      )
    ),
    div(
      { class: "layout-row fan-choices" },
      .../** @type {const} */ ([
        ["automatic", "Auto"],
        ["manual", "Manual"],
      ]).map(([mode, label]) =>
        button(
          {
            class: "control-button",
            "data-fan-mode": mode,
            "aria-pressed": () => String(fanControls.currentFanMode() === mode),
            disabled: () => !fanControls.fanCommandable(),
            onclick: () => fanControls.selectFanMode(mode),
          },
          label
        )
      )
    ),
    input({
      class: "fan-slider",
      type: "range",
      min: 0,
      max: () => Math.max(0, fanControls.fanDutyStops().length - 1),
      step: 1,
      value: () => dutyStopIndex(fanControls.fanDutyStops(), fanControls.selectedFanDuty()),
      "aria-label": "Manual fan percentage",
      "aria-valuetext": () => `${fanControls.selectedFanDuty()} %`,
      hidden: () => fanControls.currentFanMode() !== "manual",
      disabled: () => !fanControls.fanCommandable(),
      oninput: (/** @type {Event} */ event) =>
        fanControls.selectFanDuty(Number(/** @type {HTMLInputElement} */ (event.target).value)),
    }),
    span(
      {
        class: "ride-sub",
        "data-fan-status": "",
        role: "status",
        style: () => `color:${/fault|failed|cut fan/.test(fanControls.fanStatusText()) ? colors.BAD : colors.MUTED}`,
      },
      fanControls.fanStatusText
    )
  );
}
