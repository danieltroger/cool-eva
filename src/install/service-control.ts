import { setTimeout as delay } from "node:timers/promises";
import { command } from "./commands.ts";
import { monotonicNow, since } from "../monotonic.ts";

export async function submitServiceStart(service: string): Promise<void> {
  await command("systemctl", ["enable", service]);
  await command("systemctl", ["start", "--no-block", service]);
}

/** Recovery can select an old checkout with no release-health endpoint. Confirm its actual process. */
export async function waitForRunningService(service: string): Promise<void> {
  const started = monotonicNow();
  let running: { processId: string; restarts: string; started: number } | null = null;
  while (since(started) < 180_000) {
    const properties = new Map(
      (
        await command("systemctl", [
          "show",
          service,
          "--property=ActiveState",
          "--property=MainPID",
          "--property=Job",
          "--property=NRestarts",
        ])
      )
        .split("\n")
        .map(line => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
    // A slow manager reply can arrive after the observation window has expired.
    if (since(started) >= 180_000) break;
    const state = properties.get("ActiveState");
    const processId = properties.get("MainPID") ?? "";
    const restarts = properties.get("NRestarts") ?? "";
    if (state === "active" && Number(processId) > 0 && /^\d+$/.test(restarts)) {
      running ??= { processId, restarts, started: monotonicNow() };
      if (running.processId !== processId || running.restarts !== restarts) {
        throw new Error(`The ${service} service restarted during setup recovery.`);
      }
      if (since(running.started) >= 10_000) return;
    } else if (running !== null) {
      throw new Error(`The ${service} service did not remain running during setup recovery.`);
    }
    const job = properties.get("Job")?.split(" ")[0];
    if (state === "failed" || (state === "inactive" && (job === "" || job === "0"))) {
      throw new Error(`The ${service} service is stopped after setup recovery.`);
    }
    await delay(1_000);
  }
  throw new Error(`The ${service} service did not reach running state after setup recovery.`);
}
