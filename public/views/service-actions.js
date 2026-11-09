// @ts-check
import van from "../vendor/van-1.6.1.js";
import { armed, refuseKeyRepeat } from "../lib/arming.js";
import { serviceBusy, serviceCanWrite } from "../lib/service-client.js";
import { actionOutcome, changeServiceAction, SERVICE_ACTIONS, serviceActionAvailable } from "../lib/service-actions.js";
import { changeServiceLights, lightsOff, lightsOutcome } from "../lib/service-lights.js";

export function ServiceActions() {
  return details(
    {
      class: "layout-accordion service-actions",
      ontoggle: () => {
        armed.val = "";
      },
    },
    summary(span({ class: "service-title" }, "Service actions")),
    div(
      { class: "layout-accordion-body service-action-list" },
      div(
        { class: "layout-compact-stack" },
        span({ class: "label" }, "Lights"),
        span({ class: "service-sub" }, "Applies after a bike restart."),
        div(
          { class: "layout-row-end" },
          button(
            {
              class: "service-button service-write",
              disabled: () => serviceBusy.val || !serviceCanWrite(),
              onkeydown: refuseKeyRepeat,
              onclick: () => void changeServiceLights(),
            },
            () => {
              const off = !lightsOff.val;
              return armed.val === (off ? "service:lights-off" : "service:lights-restore")
                ? off
                  ? "Confirm lights off"
                  : "Confirm restore"
                : off
                  ? "Switch lights off"
                  : "Restore lights";
            }
          )
        ),
        span(
          {
            class: () => `service-feedback${lightsOutcome.val?.confirmed === false ? " bad" : ""}`,
            role: "status",
            title: () => lightsOutcome.val?.title ?? "",
          },
          () => lightsOutcome.val?.text ?? ""
        )
      ),
      SERVICE_ACTIONS.map(ServiceAction)
    )
  );
}

const { button, details, div, span, summary } = van.tags;

/** @param {(typeof SERVICE_ACTIONS)[number]} entry */
function ServiceAction(entry) {
  const outcome = actionOutcome(entry.action);
  const restart = entry.action === "reset-vcu";
  return div(
    { class: "layout-compact-stack" },
    span({ class: "label" }, entry.title),
    span({ class: "service-sub" }, entry.hint),
    div(
      { class: "layout-row-end" },
      button(
        {
          class: `service-button ${restart ? "service-write" : "service-danger"}`,
          "data-service-action": entry.action,
          disabled: () =>
            serviceBusy.val || !serviceActionAvailable(entry.action) || (!restart && outcome.val?.completed === true),
          onkeydown: refuseKeyRepeat,
          onclick: () => void changeServiceAction(entry.action),
        },
        () =>
          !restart && outcome.val?.completed
            ? "Done"
            : armed.val === `service:${entry.action}`
              ? entry.confirm
              : entry.title
      )
    ),
    span(
      {
        class: () => `service-feedback${outcome.val?.completed === false ? " bad" : ""}`,
        role: "status",
        title: () => outcome.val?.title ?? "",
      },
      () => outcome.val?.text ?? ""
    )
  );
}
