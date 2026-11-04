import { statfs, realpath, stat } from "fs/promises";
import { dirname, isAbsolute, join, resolve } from "path";
import { validBleSecret } from "../../public/lib/ble-secret.js";
import { record, type StartupSettings } from "./schema.ts";
import { validatePublicKey } from "./public-key.ts";
import type { SettingsPaths } from "./paths.ts";

export async function validateSettingsPatch(
  value: unknown,
  paths: SettingsPaths,
  codeDirectory: string
): Promise<Partial<StartupSettings>> {
  const submitted = record(value, "settings patch");
  const changes: Partial<StartupSettings> = {};
  for (const [key, field] of Object.entries(submitted)) {
    switch (key) {
      case "coolantProbesEnabled":
      case "radiatorFanEnabled":
      case "customBmsConfigurationFlashed":
      case "automaticDcChargingEnabled":
        if (typeof field !== "boolean") {
          throw new Error("This choice must be on or off.");
        }
        changes[key] = field;
        break;
      case "phoneHotspotSsid":
        if (typeof field !== "string" || Buffer.byteLength(field) > 32 || /[\0\r\n]/.test(field)) {
          throw new Error("The hotspot name must fit in 32 bytes and contain no control characters.");
        }
        changes.phoneHotspotSsid = field;
        break;
      case "dashboardBluetoothSecret":
        if (field !== "" && !validBleSecret(field)) {
          throw new Error("Use a generated 64-character Bluetooth key.");
        }
        changes.dashboardBluetoothSecret = String(field);
        break;
      case "rideLogPublicKeyPem":
        if (field !== null && typeof field !== "string") {
          throw new Error("Choose an X25519 public key.");
        }
        changes.rideLogPublicKeyPem = field === null ? null : validatePublicKey(field);
        break;
      case "rideLogDirectory":
      case "vcuParameterDirectory":
        if (typeof field !== "string") {
          throw new Error("Choose an absolute persistent data directory.");
        }
        try {
          changes[key] = await validateDataDirectory(field, paths, codeDirectory);
        } catch (error) {
          if (error instanceof Error && !("code" in error)) {
            throw error;
          }
          throw new Error("This directory cannot be checked. Choose an accessible persistent folder.");
        }
        break;
      default:
        throw new Error("This field cannot be changed here.");
    }
  }
  if (Object.keys(changes).length === 0) {
    throw new Error("Choose a setting to save.");
  }
  return changes;
}

export async function validateDataDirectory(
  path: string,
  paths: SettingsPaths,
  codeDirectory: string
): Promise<string> {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw new Error("Choose an absolute persistent data directory.");
  }
  const resolved = await resolveExistingParent(resolve(path));
  const code = await realpath(codeDirectory);
  const blocked = await Promise.all(
    [paths.privateDirectory, paths.updaterDirectory, code, "/tmp", "/run", "/dev", "/proc", "/sys"].map(
      resolveExistingParent
    )
  );
  if (
    resolved === "/" ||
    resolved === paths.dataRoot ||
    blocked.some(root => resolved === root || resolved.startsWith(`${root}/`))
  ) {
    throw new Error("Choose a data folder outside code, private state and temporary storage.");
  }
  const parent = await existingParent(resolved);
  if (!(await stat(parent)).isDirectory()) {
    throw new Error("Choose a folder, rather than a file.");
  }
  if (
    [paths.wifiDiagnosticDirectory, paths.captureDirectory].some(
      root => resolved === root || resolved.startsWith(`${root}/`) || root.startsWith(`${resolved}/`)
    )
  ) {
    throw new Error("Keep recording and service data separate from captures and diagnostics.");
  }
  const storage = await statfs(parent);
  if ([0x01021994, 0x858458f6].includes(Number(storage.type))) {
    throw new Error("Choose persistent storage rather than a memory filesystem.");
  }
  return resolved;
}

async function existingParent(path: string): Promise<string> {
  try {
    await realpath(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    if (dirname(path) === path) {
      throw error;
    }
    return existingParent(dirname(path));
  }
}

async function resolveExistingParent(path: string): Promise<string> {
  const parent = await existingParent(path);
  return join(await realpath(parent), path.slice(parent.length));
}
