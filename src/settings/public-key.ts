import { readFile } from "fs/promises";
import { parseRideLogPublicKey } from "../storage/ride-log-key.ts";
import { readErrorCode } from "./error-code.ts";
import type { LegacyImport } from "./legacy.ts";

export async function importLegacyPublicKey(imported: LegacyImport): Promise<LegacyPublicKeyFault | null> {
  const path = imported.document.migration.pendingPublicKeyPath;
  if (path === null) return null;
  try {
    const contents = await readFile(path, "utf-8");
    const { publicKey, reason } = parseRideLogPublicKey(contents);
    imported.document.values.rideLogPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    imported.document.migration.pendingPublicKeyPath = null;
    imported.document.migration.complete = true;
    if (reason !== null) {
      if (!imported.document.migration.notices.includes(reason)) {
        imported.document.migration.notices.push(reason);
      }
      const warning: LegacyPublicKeyFault = {
        code: reason,
        severity: "warning",
        message: "A private key is on the Pi, which defeats the sealed log; put the public key there instead.",
      };
      console.warn(`settings: ${warning.message}`);
      return warning;
    }
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
      severity: "fault",
      message: "Recording public key is unavailable. Choose a key in Settings → Ride recording.",
      errorCode: readErrorCode(error),
    };
    console.warn(`settings: ${fault.message}${fault.errorCode ? ` (${fault.errorCode})` : ""}`);
    imported.document.migration.complete = false;
    return fault;
  }
}

export interface LegacyPublicKeyFault {
  code: "recording-key-unavailable" | "private-key-on-pi";
  severity: "fault" | "warning";
  message: string;
  errorCode?: string;
}

export function validatePublicKey(contents: string): string {
  const { publicKey, reason } = parseRideLogPublicKey(contents);
  if (contents.length > 16 * 1024 || reason !== null) {
    throw new Error("Settings need an X25519 public key, not a private key or an oversized file.");
  }
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}
