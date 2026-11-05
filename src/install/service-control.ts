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
  while (since(started) < 180_000) {
    const properties = new Map(
      (await command("systemctl", ["show", service, "--property=ActiveState", "--property=MainPID", "--property=Job"]))
        .split("\n")
        .map(line => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
    const state = properties.get("ActiveState");
    if (state === "active" && Number(properties.get("MainPID")) > 0) return;
    const job = properties.get("Job")?.split(" ")[0];
    if (state === "failed" || (state === "inactive" && job === "0")) {
      throw new Error(`The ${service} service is stopped after setup recovery.`);
    }
    await delay(1_000);
  }
  throw new Error(`The ${service} service did not reach running state after setup recovery.`);
}
