import { createPublicKey } from "crypto";
import { readFile } from "fs/promises";
import type { LegacyImport } from "./legacy.ts";

export async function importLegacyPublicKey(imported: LegacyImport): Promise<void> {
  const path = imported.document.migration.pendingPublicKeyPath;
  if (path === null) return;
  try {
    const contents = await readFile(path, "utf-8");
    imported.document.values.rideLogPublicKeyPem = validatePublicKey(contents);
    imported.document.migration.pendingPublicKeyPath = null;
    imported.document.migration.complete = true;
  } catch (error) {
    const absentDefault = !imported.publicKeyWasExplicit && (error as NodeJS.ErrnoException).code === "ENOENT";
    if (absentDefault) {
      console.log("settings: no default ride-log public key; recording needs setup");
      imported.document.migration.pendingPublicKeyPath = null;
      imported.document.migration.complete = true;
      return;
    }
    console.warn(
      "settings: the configured recording public key could not be imported; recording stays unavailable and import will retry"
    );
    imported.document.migration.complete = false;
  }
}

export function validatePublicKey(contents: string): string {
  if (
    contents.length > 16 * 1024 ||
    !contents.startsWith("-----BEGIN PUBLIC KEY-----") ||
    contents.includes("PRIVATE KEY")
  ) {
    throw new Error("Recording needs an X25519 public key, not a private key.");
  }
  try {
    const key = createPublicKey(contents);
    if (key.asymmetricKeyType !== "x25519") {
      throw new Error("wrong key type");
    }
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    throw new Error("Recording needs a valid X25519 public key.");
  }
}
