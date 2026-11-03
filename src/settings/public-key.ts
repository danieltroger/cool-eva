import { readFile } from "fs/promises";
import { parseRideLogPublicKey } from "../storage/ride-log-key.ts";
import { readErrorCode } from "./error-code.ts";
import type { LegacyImport } from "./legacy.ts";

export async function importLegacyPublicKey(imported: LegacyImport): Promise<LegacyPublicKeyFault | null> {
  const path = imported.document.migration.pendingPublicKeyPath;
  if (path === null) return null;
  try {
    const contents = await readFile(path, "utf-8");
    imported.document.values.rideLogPublicKeyPem = validatePublicKey(contents);
    imported.document.migration.pendingPublicKeyPath = null;
    imported.document.migration.complete = true;
    return null;
  } catch (error) {
    const absentDefault = !imported.publicKeyWasExplicit && (error as NodeJS.ErrnoException).code === "ENOENT";
    if (absentDefault) {
      console.log("settings: no default ride-log public key; recording needs setup");
      imported.document.migration.pendingPublicKeyPath = null;
      imported.document.migration.complete = true;
      return null;
    }
    const fault: LegacyPublicKeyFault = {
      code: "recording-key-unavailable",
      message: "Recording public key is unavailable. Choose a key in Settings → Ride recording.",
      errorCode: readErrorCode(error),
    };
    console.warn(`settings: ${fault.message}${fault.errorCode ? ` (${fault.errorCode})` : ""}`);
    imported.document.migration.complete = false;
    return fault;
  }
}

export interface LegacyPublicKeyFault {
  code: "recording-key-unavailable";
  message: string;
  errorCode?: string;
}

export function validatePublicKey(contents: string): string {
  return parseRideLogPublicKey(contents).export({ type: "spki", format: "pem" }).toString();
}
