// @ts-check
import van from "../vendor/van-1.6.1.js";
import { armed, refuseKeyRepeat } from "../lib/arming.js";
import { ageInWords } from "../lib/format.js";
import { parameterInput, parameterValue, serviceGroupLabel } from "../lib/parameter-backup.js";
import { parameterReadFailureText } from "../lib/service-feedback.js";
import { currentParameterReading, serviceBusy, serviceCanWrite, serviceCatalogue } from "../lib/service-client.js";
import {
  changeNewParameterValue,
  changeParameterSearch,
  confirmParameterChange,
  newParameterValue,
  parameterOutcome,
  parameterSearch,
  parameterSearchActive,
  selectedParameter,
  selectServiceParameter,
  serviceEditor,
} from "../lib/service-edits.js";

/** @typedef {import("../../src/http/service-catalogue.ts").ServiceParameter} ServiceParameter */

export function ServiceParameters() {
  const browser = details(
    { class: "layout-accordion parameter-browser" },
    summary(span({ class: "service-title" }, "Browse parameters"))
  );
  van.add(
    browser,
    div({ class: "layout-accordion-body" }, () => {
      const parameters = serviceCatalogue.val?.parameters ?? [];
      const groups = [...new Set(parameters.map(parameter => parameter.group))];
      return div(
        { class: "layout-stack" },
        groups.map(group =>
          details(
            { class: "service-group" },
            summary({ class: "layout-list-row" }, serviceGroupLabel(group)),
            div(
              { class: "layout-compact-stack" },
              parameters
                .filter(parameter => parameter.group === group)
                .map(parameter => ParameterChoice(parameter, browser))
            )
          )
        )
      );
    })
  );
  return div(
    { class: "layout-stack service-parameters" },
    input({
      class: "service-input",
      type: "search",
      name: "parameter-search",
      autocomplete: "off",
      placeholder: "Find a parameter…",
      "aria-label": "Find a parameter",
      value: parameterSearch,
      oninput: (/** @type {Event} */ event) => {
        if (event.target instanceof HTMLInputElement) {
          changeParameterSearch(event.target.value);
        }
      },
    }),
    () => {
      const query = parameterSearch.val.toLowerCase().trim();
      if (!parameterSearchActive.val || !query) {
        return span({ hidden: true });
      }
      const matches =
        serviceCatalogue.val?.parameters.filter(parameter =>
          `${parameter.name} ${parameter.group}`.toLowerCase().includes(query)
        ) ?? [];
      return div(
        { class: "layout-compact-stack parameter-results" },
        matches.length
          ? matches.map(parameter => ParameterChoice(parameter, browser))
          : span({ class: "service-sub" }, "No matching parameters")
      );
    },
    browser,
    () => {
      const parameter = selectedParameter.val;
      return parameter && serviceEditor.val === "parameter" ? ParameterEditor(parameter) : span({ hidden: true });
    }
  );
}

const { button, details, div, input, label, span, strong, summary } = van.tags;

/** @param {ServiceParameter} parameter @param {HTMLDetailsElement} browser */
function ParameterChoice(parameter, browser) {
  return button(
    {
      class: "parameter-choice",
      "data-select-parameter": parameter.index,
      disabled: () => serviceBusy.val,
      onclick: () => {
        browser.open = false;
        void selectServiceParameter(parameter);
      },
    },
    parameter.name
  );
}

/** @param {ServiceParameter} parameter */
function ParameterEditor(parameter) {
  const key = `parameter:${parameter.index}`;
  return div(
    { class: "layout-card parameter-editor", "data-parameter": parameter.name },
    span({ class: "parameter-name" }, parameter.name),
    div(
      { class: "layout-between parameter-facts" },
      span(
        "Current ",
        strong(
          {
            title: () => {
              const current = currentParameterReading(parameter);
              return current ? `Read ${ageInWords(current.readAt)}` : "";
            },
          },
          () => {
            const current = currentParameterReading(parameter);
            return current ? parameterValue(parameter, current.value) : "—";
          }
        )
      ),
      span(
        { class: "service-sub" },
        `Stock ${parameter.stock === null ? "—" : parameterValue(parameter, parameter.stock)}`
      )
    ),
    label({ class: "label", for: "service-parameter-value" }, `New value · ${parameter.unit}`),
    div(
      { class: "layout-row parameter-edit" },
      input({
        id: "service-parameter-value",
        class: () =>
          `service-input${newParameterValue.val && parameterInput(parameter, newParameterValue.val) === null ? " invalid" : ""}`,
        type: "number",
        name: "parameter-value",
        autocomplete: "off",
        step: parameter.scale,
        min: parameter.minimum * parameter.scale,
        max: parameter.maximum * parameter.scale,
        "aria-label": `New ${parameter.name}`,
        value: newParameterValue,
        disabled: () => !parameter.writable || serviceBusy.val || !serviceCanWrite(),
        oninput: (/** @type {Event} */ event) => {
          if (event.target instanceof HTMLInputElement) {
            changeNewParameterValue(event.target.value);
          }
        },
      }),
      button(
        {
          class: "service-button service-write",
          disabled: () => {
            const value = parameterInput(parameter, newParameterValue.val);
            const current = currentParameterReading(parameter);
            return (
              !parameter.writable ||
              serviceBusy.val ||
              !serviceCanWrite() ||
              value === null ||
              !current ||
              value === current.value
            );
          },
          onkeydown: refuseKeyRepeat,
          onclick: () => void setSelectedParameter(parameter, key),
        },
        () =>
          armed.val === key
            ? `Confirm ${parameterValue(parameter, parameterInput(parameter, newParameterValue.val) ?? 0)}`
            : "Set"
      )
    ),
    span(
      {
        class: () =>
          `service-feedback${["unconfirmed", "read-failed"].includes(parameterOutcome.val?.kind ?? "") ? " bad" : ""}`,
        role: "status",
        title: () => parameterOutcome.val?.reason ?? "",
      },
      () => {
        const failure = parameterReadFailureText(parameterOutcome.val);
        if (failure) return failure;
        if (!parameter.writable) {
          return "Read only";
        }
        if (newParameterValue.val && parameterInput(parameter, newParameterValue.val) === null) {
          return `Use ${parameterValue(parameter, parameter.minimum)}–${parameterValue(parameter, parameter.maximum)}`;
        }
        return parameterOutcome.val?.kind === "confirmed"
          ? "Bike confirmed. Restart bike to apply."
          : parameterOutcome.val?.kind === "unconfirmed"
            ? "—"
            : "";
      }
    )
  );
}

/** @param {ServiceParameter} parameter @param {string} key */
async function setSelectedParameter(parameter, key) {
  const text = newParameterValue.rawVal;
  const value = parameterInput(parameter, text);
  if (value === null) {
    return;
  }
  parameterOutcome.val = null;
  const outcome = await confirmParameterChange(
    parameter,
    value,
    key,
    () =>
      selectedParameter.rawVal === parameter &&
      serviceEditor.rawVal === "parameter" &&
      newParameterValue.rawVal === text
  );
  if (selectedParameter.rawVal === parameter && outcome) {
    parameterOutcome.val = outcome;
  }
}
