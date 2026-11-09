// @ts-check
import van from "../vendor/van-1.6.1.js";
import { armed, refuseKeyRepeat } from "../lib/arming.js";
import { parameterValue } from "../lib/parameter-backup.js";
import { currentParameterReading, serviceBusy, serviceCanWrite, serviceCatalogue } from "../lib/service-client.js";
import { serviceEditor } from "../lib/service-edits.js";
import {
  applyBackupDifference,
  backupDifferences,
  backupProblem,
  backupStatus,
  exportServiceBackup,
  importServiceBackup,
  serviceHasBackupReadings,
} from "../lib/service-backup.js";

/** @typedef {import("../lib/service-backup.js").BackupDifference} BackupDifference */

export function ServiceBackup() {
  const picker = input({
    type: "file",
    accept: ".csv,text/csv",
    "aria-label": "Import parameter backup",
    hidden: true,
    onchange: () => {
      const file = picker.files?.[0];
      picker.value = "";
      if (file) {
        void importServiceBackup(file);
      }
    },
  });
  return div(
    { class: "layout-stack service-backup" },
    div(
      { class: "layout-row-end" },
      button(
        {
          class: "service-button",
          disabled: () => serviceBusy.val || !serviceCatalogue.val,
          onclick: () => picker.click(),
        },
        "Import backup"
      ),
      button(
        {
          class: "service-button",
          disabled: () => serviceBusy.val || !serviceHasBackupReadings(),
          onclick: exportServiceBackup,
        },
        "Export backup"
      )
    ),
    picker,
    () =>
      serviceEditor.val === "backup" && backupDifferences.val.length
        ? div(
            { class: "layout-card backup-changes" },
            span({ class: "service-title" }, "Backup changes"),
            div({ class: "layout-stack" }, backupDifferences.val.map(BackupDifference))
          )
        : span({ hidden: true }),
    span(
      { class: () => `service-feedback${backupProblem.val ? " bad" : ""}`, role: "status", title: backupProblem },
      backupStatus
    )
  );
}

const { button, div, input, span } = van.tags;

/** @param {BackupDifference} difference */
function BackupDifference(difference) {
  const parameter = difference.parameter;
  const key = `backup:${difference.version}:${parameter.index}`;
  return div(
    { class: "layout-compact-stack backup-difference", "data-backup-index": parameter.index },
    span({ class: "parameter-name" }, parameter.name),
    div(
      { class: "layout-between" },
      span({ class: "service-sub" }, () => {
        const current = currentParameterReading(parameter);
        return ["confirmed", "unchanged"].includes(difference.outcome.val?.kind ?? "")
          ? parameterValue(parameter, difference.value)
          : `${current ? parameterValue(parameter, current.value) : "—"} → ${parameterValue(parameter, difference.value)}`;
      }),
      button(
        {
          class: "service-button service-write",
          disabled: () =>
            !parameter.writable ||
            serviceBusy.val ||
            !serviceCanWrite() ||
            !currentParameterReading(parameter) ||
            ["confirmed", "unchanged"].includes(difference.outcome.val?.kind ?? ""),
          onkeydown: refuseKeyRepeat,
          onclick: () => void applyBackupDifference(difference),
        },
        () =>
          ["confirmed", "unchanged"].includes(difference.outcome.val?.kind ?? "")
            ? "Done"
            : armed.val === key
              ? `Confirm ${parameterValue(parameter, difference.value)}`
              : "Set"
      )
    ),
    span(
      {
        class: () => `service-feedback${difference.outcome.val?.kind === "unconfirmed" ? " bad" : ""}`,
        role: "status",
        title: () => difference.outcome.val?.reason ?? "",
      },
      () =>
        !parameter.writable
          ? "Read only"
          : ["confirmed", "unchanged"].includes(difference.outcome.val?.kind ?? "")
            ? "Bike confirmed."
            : difference.outcome.val?.kind === "unconfirmed"
              ? "—"
              : ""
    )
  );
}
