import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { acquireBus, type BusLease } from "../vcu/bus-lease.ts";
import type { SettingsStore } from "./store.ts";
import type { SettingsReply } from "./view.ts";

export function createSettingsRestart(options: RestartOptions): SettingsRestart {
  const generation = randomUUID();
  let status: SettingsReply["restart"] = { state: "idle", message: "" };
  let releaseSettings: (() => Promise<void>) | null = null;
  let lease: BusLease | null = null;
  let reserving = false;
  let delivering = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const release = async (): Promise<void> => {
    lease?.release();
    lease = null;
    const finish = releaseSettings;
    releaseSettings = null;
    await finish?.();
  };
  const fail = async (message: string): Promise<void> => {
    if (status.state === "stopping") return;
    clearTimeout(deadline);
    status = { state: "failed", message };
    console.warn(`settings: ${message}`);
    await release();
  };
  return {
    generation,
    status: () => ({ ...status }),
    reserve: async (expectedGeneration, revision, operation) => {
      if (expectedGeneration !== generation) return false;
      if (reserving || releaseSettings || status.state === "stopping") return false;
      reserving = true;
      try {
        const blockers = options.motionBlockers();
        if (blockers.length > 0) {
          throw new RestartMotionError(`Wait until the motorcycle is parked: ${blockers.join("; ")}.`);
        }
        const reservation = await options.store.reserve(revision);
        releaseSettings = reservation.release;
        const admission = (options.acquireBus ?? acquireBus)("a Cool Eva restart");
        if (!admission.ok) {
          throw new Error(`Busy: ${admission.heldBy}. Try again when it finishes.`);
        }
        lease = admission.lease;
        if (options.motionBlockers().length > 0) {
          throw new RestartMotionError("The motorcycle started moving. Park it before restarting.");
        }
        status = { state: "reserved", message: "Restart reserved. Readings and recording will pause." };
        delivering = false;
        const reservedLease = lease;
        deadline = setTimeout(() => {
          if (lease !== reservedLease) return;
          void fail("Restart did not happen. Saved settings are still pending.").catch(error =>
            console.warn("settings: could not release an expired restart", error)
          );
        }, options.stopTimeoutMs ?? 30_000);
        if (operation) {
          try {
            await bounded(
              () => operation(() => status.state === "reserved" && lease === reservedLease),
              options.scheduleTimeoutMs ?? 5_000,
              true
            );
          } finally {
            if (status.state !== "stopping") {
              clearTimeout(deadline);
              status = { state: "idle", message: "" };
              await release();
            }
          }
        }
        return true;
      } catch (error) {
        if (status.state !== "stopping") {
          await release();
        }
        throw error;
      } finally {
        reserving = false;
      }
    },
    deliverAndSchedule: async (waitForDelivery, beforeSchedule) => {
      if (status.state !== "reserved" || delivering) return;
      delivering = true;
      const reservedLease = lease;
      try {
        await bounded(waitForDelivery, options.deliveryTimeoutMs ?? 5_000, false);
        if (beforeSchedule) {
          await bounded(beforeSchedule, options.beforeScheduleTimeoutMs ?? 8_000, false);
        }
        if (status.state !== "reserved" || lease !== reservedLease) return;
        await bounded(options.schedule ?? scheduleRestart, options.scheduleTimeoutMs ?? 5_000, true);
        // systemd can send SIGTERM before the scheduling child exits.
        if (status.state === "reserved" && lease === reservedLease) {
          status = { state: "scheduled", message: "Restart requested. Reconnect to check the active settings." };
        }
      } catch (error) {
        console.warn("settings: restart scheduling failed", error);
        if (lease === reservedLease) {
          await fail("Restart could not be scheduled. Saved settings are still pending.");
        }
      }
    },
    consume: () => {
      clearTimeout(deadline);
      status = { state: "stopping", message: "Restarting." };
    },
    close: async () => {
      clearTimeout(deadline);
      await release();
    },
  };
}

export class RestartMotionError extends Error {
  name = "RestartMotionError";
}

export interface RestartOptions {
  store: SettingsStore;
  motionBlockers: () => string[];
  schedule?: () => Promise<void>;
  acquireBus?: typeof acquireBus;
  deliveryTimeoutMs?: number;
  scheduleTimeoutMs?: number;
  beforeScheduleTimeoutMs?: number;
  stopTimeoutMs?: number;
}
export interface SettingsRestart {
  generation: string;
  status: () => SettingsReply["restart"];
  reserve: (expectedGeneration: string, revision: number | null, operation?: RestartOperation) => Promise<boolean>;
  deliverAndSchedule: (waitForDelivery: () => Promise<void>, beforeSchedule?: () => Promise<void>) => Promise<void>;
  consume: () => void;
  close: () => Promise<void>;
}
export type RestartOperation = (stillReserved: () => boolean) => Promise<void>;
async function scheduleRestart(): Promise<void> {
  await promisify(execFile)("systemctl", ["--no-block", "restart", "cool-eva"], { timeout: 5_000 });
}
async function bounded(work: () => Promise<void>, milliseconds: number, rejectTimeout: boolean): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(work)
        .catch(error => {
          if (rejectTimeout) {
            throw error;
          }
          console.warn("settings: restart reply delivery failed; proceeding", error);
        }),
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          if (rejectTimeout) {
            reject(new Error("The restart step timed out."));
          } else {
            console.warn("settings: restart step timed out; proceeding to restart");
            resolve();
          }
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
