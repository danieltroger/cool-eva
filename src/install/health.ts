import { createHash, createPublicKey } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { monotonicNow, since } from "../monotonic.ts";
import type { SettingsReply } from "../settings/view.ts";
import { command, exists } from "./commands.ts";

export async function checkInstalledApp(
  release: string,
  probe: HealthProbe = { now: monotonicNow, since, sleep: delay, request: requestHealth }
): Promise<SettingsReply> {
  const started = probe.now();
  let healthySince: number | null = null;
  let generation: string | null = null;
  while (probe.since(started) < 180_000) {
    try {
      const response = await probe.request("http://127.0.0.1/release-health");
      const body: unknown = await response.json();
      if (
        response.ok &&
        body &&
        typeof body === "object" &&
        "ok" in body &&
        body.ok === true &&
        "release" in body &&
        body.release === release
      ) {
        const settings = await probe.request("http://127.0.0.1/settings");
        if (!settings.ok) {
          throw new Error("Settings readback is unavailable");
        }
        const view = (await settings.json()) as SettingsReply;
        if (!view.ok || view.fault || typeof view.processGeneration !== "string") {
          throw new Error("Settings or migration is not ready");
        }
        if (generation !== view.processGeneration) {
          generation = view.processGeneration;
          healthySince = null;
        }
        healthySince ??= probe.now();
        if (probe.since(healthySince) >= 60_000) {
          return view;
        }
      } else {
        healthySince = null;
      }
    } catch (error) {
      healthySince = null;
      console.log(
        "Waiting for the dashboard and service-owned settings checks:",
        error instanceof Error ? error.name : "unavailable"
      );
    }
    await probe.sleep(2_000);
  }
  throw new Error("The dashboard did not pass its startup checks. Read the cool-eva service log before retrying.");
}

export interface HealthProbe {
  now: () => number;
  since: (mark: number) => number;
  sleep: (milliseconds: number) => Promise<void>;
  request: (url: string) => Promise<Response>;
}

function requestHealth(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(3_000) });
}

export async function printInstallResults(view: SettingsReply, expectedKey: string | null): Promise<void> {
  if (!view.ok || view.fault) {
    throw new Error("Settings or data migration needs repair; setup is incomplete.");
  }
  if (view.notices.includes("private-key-on-pi")) {
    console.warn(
      "A legacy ride-log key file on this Pi contains the PRIVATE key. Remove that old copy after verifying your computer backup. Existing ride data was retained."
    );
  }
  if (expectedKey) {
    const fingerprint = createHash("sha256")
      .update(createPublicKey(expectedKey).export({ type: "spki", format: "der" }))
      .digest("hex");
    if (view.recordingFingerprint !== fingerprint || view.readiness.recording !== "Recording") {
      throw new Error(
        "The public key was saved but encrypted ride recording is not active. Check Settings → Ride recording."
      );
    }
  }
  console.log(`Bundle: ${view.version}`);
  const hostname = await command("hostname", []);
  const addresses = (await command("hostname", ["-I"]))
    .split(/\s+/)
    .filter(address => /^\d+\.\d+\.\d+\.\d+$/.test(address));
  console.log(`Dashboard ready: http://${hostname}.local${addresses.map(address => ` (http://${address})`).join("")}.`);
  console.log(
    view.readiness.recording === "Recording"
      ? `Encrypted ride recording ready. Public fingerprint: ${view.recordingFingerprint}`
      : "NOT SAVING RIDES — add your PUBLIC key in Settings → Ride recording."
  );
  console.log(
    (await exists("/sys/class/net/can0"))
      ? `Motorcycle readings: ${view.readiness.can}. Missing readings are normal while the bike is asleep.`
      : "CAN adapter not detected — check the USB data connection. The dashboard is running; bike readings are not yet available."
  );
  console.log(
    "Service enabled for future boots. Keep the private ride-log key backed up on your computer, never on the Pi."
  );
}
