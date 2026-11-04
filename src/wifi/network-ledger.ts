import { chmod, chown, lstat, readFile } from "fs/promises";
import { replaceFileDurably } from "../storage/durable.ts";
import { assertSettingsWriterLock, type SettingsWriterLock } from "../settings/writer-lock.ts";
import type { NetworkLedger } from "./network-types.ts";

export async function openNetworkLedger(
  path: string,
  instanceId: string,
  lock: SettingsWriterLock
): Promise<NetworkLedgerStore> {
  assertSettingsWriterLock(lock);
  let value: NetworkLedger;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
      throw new Error("Network state is not a supported regular file.");
    }
    await chmod(path, 0o600);
    if (metadata.uid !== process.getuid!() || metadata.gid !== process.getgid!()) {
      await chown(path, process.getuid!(), process.getgid!());
    }
    value = parseNetworkLedger(JSON.parse(await readFile(path, "utf8")), instanceId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Network change state needs repair. The original file is preserved.");
    }
    value = { version: 1, instanceId, revision: 0, purposes: {}, excluded: [], change: null };
    console.log("wifi-settings: no previous network trial state");
  }
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read: () => structuredClone(value),
    write: next => {
      const copy = structuredClone(next);
      const result = queue.then(async () => {
        assertSettingsWriterLock(lock);
        parseNetworkLedger(copy, instanceId);
        await replaceFileDurably(path, `${JSON.stringify(copy, null, 2)}\n`, { mode: 0o600 });
        value = copy;
      });
      queue = result.catch(() => console.warn("wifi-settings: network state could not be saved; no values logged"));
      return result;
    },
  };
}

export interface NetworkLedgerStore {
  read: () => NetworkLedger;
  write: (next: NetworkLedger) => Promise<void>;
}

export function parseNetworkLedger(raw: unknown, instanceId: string): NetworkLedger {
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    raw.instanceId !== instanceId ||
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 0 ||
    !isRecord(raw.purposes) ||
    !Object.values(raw.purposes).every(purpose => purpose === "home" || purpose === "hotspot") ||
    (raw.hotspotUuid !== undefined && !validUuid(raw.hotspotUuid)) ||
    !Array.isArray(raw.excluded) ||
    !raw.excluded.every(validUuid)
  ) {
    throw new Error("Network state has an unsupported version or belongs to another Pi.");
  }
  if (raw.change !== null) {
    const change = raw.change;
    if (
      !isRecord(change) ||
      !validUuid(change.uuid) ||
      typeof change.ssid !== "string" ||
      !["home", "hotspot"].includes(String(change.purpose)) ||
      !PHASES.includes(String(change.phase)) ||
      !Number.isInteger(change.priority) ||
      !Number.isSafeInteger(change.attempts) ||
      typeof change.message !== "string" ||
      typeof change.resumedAtBoot !== "boolean" ||
      (change.previousHotspot !== undefined &&
        (!isRecord(change.previousHotspot) ||
          typeof change.previousHotspot.ssid !== "string" ||
          (change.previousHotspot.uuid !== undefined && !validUuid(change.previousHotspot.uuid)))) ||
      !(
        change.checkpoint === null ||
        (typeof change.checkpoint === "string" &&
          /^\/org\/freedesktop\/NetworkManager\/Checkpoint\/\d+$/.test(change.checkpoint))
      )
    ) {
      throw new Error("Network change state is invalid.");
    }
    for (const profile of [change.replaced, change.fallback]) {
      if (
        profile !== null &&
        (!isRecord(profile) ||
          !validUuid(profile.uuid) ||
          typeof profile.name !== "string" ||
          typeof profile.ssid !== "string" ||
          !Number.isInteger(profile.priority) ||
          !["keyfile", "netplan"].includes(String(profile.backend)))
      ) {
        throw new Error("Saved network identity is invalid.");
      }
    }
  }
  return raw as unknown as NetworkLedger;
}

export function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PHASES = [
  "saved",
  "trying",
  "waiting",
  "restoring",
  "failed",
  "restored",
  "confirming",
  "promoting",
  "identity",
  "retiring",
  "kept",
];
