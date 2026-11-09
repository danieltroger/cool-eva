// @ts-check
/** @typedef {import("../../src/http/service-catalogue.ts").ServiceParameter} ServiceParameter */
/** @typedef {{parameter:ServiceParameter,value:number}} BackupEntry */

/** @param {string} text @param {ServiceParameter[]} parameters @returns {BackupEntry[]} */
export function parseParameterBackup(text, parameters) {
  const lines = text
    .trim()
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  if (text.length > 128 * 1024 || lines.shift() !== "id_hex,name,value") {
    throw new Error("Choose a parameter backup CSV.");
  }
  const seen = new Set();
  return lines.map(line => {
    const columns = line.split(",");
    if (columns.length !== 3 || !/^0x[0-9a-f]+$/i.test(columns[0]) || !/^-?\d+$/.test(columns[2])) {
      throw new Error("The backup contains an invalid row.");
    }
    const index = Number(columns[0]);
    const parameter = parameters.find(parameter => parameter.index === index && parameter.name === columns[1]);
    if (!parameter || seen.has(index)) {
      throw new Error(`Cannot match backup parameter ${columns[1]}.`);
    }
    seen.add(index);
    const value = Number(columns[2]);
    if (!Number.isSafeInteger(value) || value < parameter.minimum || value > parameter.maximum) {
      throw new Error(`${parameter.name}: value outside the allowed range.`);
    }
    return { parameter, value };
  });
}

/** @param {ServiceParameter[]} parameters @param {(parameter:ServiceParameter)=>number|null} reading */
export function parameterBackupCsv(parameters, reading) {
  const rows = [["id_hex", "name", "value"]];
  for (const parameter of [...parameters].sort((left, right) => left.index - right.index)) {
    const value = reading(parameter);
    if (value === null) {
      continue;
    }
    rows.push([`0x${parameter.index.toString(16).toUpperCase().padStart(2, "0")}`, parameter.name, String(value)]);
  }
  return rows.map(columns => columns.map(csvField).join(",") + "\r\n").join("");
}

/** @param {ServiceParameter} parameter @param {string} text @returns {number|null} */
export function parameterInput(parameter, text) {
  if (!text.trim()) {
    return null;
  }
  const value = Number(text);
  const raw = Math.round(value / parameter.scale);
  return Number.isFinite(value) &&
    Number.isSafeInteger(raw) &&
    raw >= parameter.minimum &&
    raw <= parameter.maximum &&
    Math.abs(raw * parameter.scale - value) < 0.000001
    ? raw
    : null;
}

/** @param {ServiceParameter} parameter @param {number} raw */
export function parameterValue(parameter, raw) {
  return `${parameter.scale === 1 ? String(raw) : (raw * parameter.scale).toFixed(1)} ${parameter.unit}`;
}

/** @param {string} group */
export function serviceGroupLabel(group) {
  return (
    /** @type {Record<string,string>} */ ({
      bms: "BMS",
      diag: "Diagnostics",
      gps: "GPS",
      imu: "Motion",
      obd: "OBD",
      vcu: "VCU",
      wifi: "Wi-Fi",
    })[group] ??
    group
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/\b\w/g, letter => letter.toUpperCase())
  );
}

/** @param {string} value */
function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
