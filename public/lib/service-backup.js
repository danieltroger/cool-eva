// @ts-check
import van from "../vendor/van-1.6.1.js";
import { armed } from "./arming.js";
import { backupImportFailureText } from "./service-feedback.js";
import { parseParameterBackup, parameterBackupCsv } from "./parameter-backup.js";
import {
  currentParameterReading,
  readServiceParameter,
  serviceCatalogue,
  serviceOpen,
  serviceOperation,
  serviceProblem,
} from "./service-client.js";
import { confirmParameterChange, serviceEditor, changeParameterSearch, selectedParameter } from "./service-edits.js";

/** @typedef {import("./parameter-backup.js").BackupEntry} BackupEntry */
/** @typedef {import("./service-edits.js").ParameterAttempt} ParameterAttempt */
/** @typedef {BackupEntry & {version:number,outcome:import("../vendor/van-1.6.1.js").State<ParameterAttempt|null>}} BackupDifference */

/** @param {File} file */
export async function importServiceBackup(file) {
  const version = ++backupVersion;
  armed.val = "";
  changeParameterSearch("");
  selectedParameter.val = null;
  serviceEditor.val = "backup";
  backupDifferences.val = [];
  backupStatus.val = "";
  backupProblem.val = "";
  try {
    const catalogue = serviceCatalogue.rawVal;
    if (!catalogue) {
      return;
    }
    const entries = parseParameterBackup(await file.text(), catalogue.parameters);
    if (version !== backupVersion) {
      return;
    }
    const differences = await serviceOperation(() => compareServiceBackup(entries, version));
    if (!differences || version !== backupVersion || !serviceOpen()) {
      return;
    }
    backupDifferences.val = differences;
    backupStatus.val = differences.length
      ? "Only differing values. Confirm each change."
      : "Backup matches. Nothing to apply.";
  } catch (error) {
    if (version !== backupVersion) {
      return;
    }
    backupDifferences.val = [];
    const reason = error instanceof Error ? error.message : String(error);
    backupStatus.val = backupImportFailureText(reason);
    backupProblem.val = reason;
    console.warn("service: backup import failed", error);
  }
}

export const backupDifferences = van.state(/** @type {BackupDifference[]} */ ([]));
export const backupStatus = van.state("");
export const backupProblem = van.state("");
let backupVersion = 0;

/** @param {BackupDifference} difference */
export async function applyBackupDifference(difference) {
  difference.outcome.val = null;
  const result = await confirmParameterChange(
    difference.parameter,
    difference.value,
    `backup:${difference.version}:${difference.parameter.index}`,
    () => backupStillCurrent(difference)
  );
  if (!result || !backupStillCurrent(difference)) {
    return;
  }
  difference.outcome.val = result;
  if (backupDifferences.rawVal.every(row => ["confirmed", "unchanged"].includes(row.outcome.rawVal?.kind ?? ""))) {
    backupStatus.val = "Differences applied. Restart bike to apply.";
  }
}

export function exportServiceBackup() {
  const catalogue = serviceCatalogue.rawVal;
  if (!catalogue) {
    return;
  }
  const csv = parameterBackupCsv(
    catalogue.parameters,
    parameter => currentParameterReading(parameter, true)?.value ?? null
  );
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "vcu_backup.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  backupStatus.val = "Parameter backup downloaded.";
}

export function serviceHasBackupReadings() {
  return serviceCatalogue.val?.parameters.some(parameter => currentParameterReading(parameter) !== null) ?? false;
}

export function resetServiceBackup() {
  backupVersion++;
  backupDifferences.val = [];
  backupStatus.val = "";
  backupProblem.val = "";
}

/** @param {BackupEntry[]} entries @param {number} version @returns {Promise<BackupDifference[]|null>} */
async function compareServiceBackup(entries, version) {
  /** @type {BackupDifference[]} */
  const differences = [];
  for (const entry of entries) {
    if (version !== backupVersion || !serviceOpen() || !serviceCatalogue.rawVal?.parameters.includes(entry.parameter)) {
      return null;
    }
    const reading = await readServiceParameter(entry.parameter);
    if (version !== backupVersion || !serviceOpen()) {
      return null;
    }
    if (!reading) {
      backupStatus.val = backupImportFailureText(serviceProblem.rawVal);
      backupProblem.val = serviceProblem.rawVal;
      return null;
    }
    if (reading.value !== entry.value) {
      differences.push({ ...entry, version, outcome: van.state(/** @type {ParameterAttempt|null} */ (null)) });
    }
  }
  return differences;
}

/** @param {BackupDifference} difference */
function backupStillCurrent(difference) {
  return (
    serviceEditor.rawVal === "backup" &&
    difference.version === backupVersion &&
    backupDifferences.rawVal.includes(difference)
  );
}

van.derive(() => {
  const catalogue = serviceCatalogue.val;
  if (backupDifferences.rawVal.some(row => !catalogue?.parameters.includes(row.parameter))) {
    resetServiceBackup();
    serviceEditor.val = "";
  }
});
