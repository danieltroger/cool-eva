import { isAbsolute, join, basename } from "node:path";
import { stat } from "node:fs/promises";
import type { Server } from "node:http";
import { acquireSettingsWriterLock } from "../settings/writer-lock.ts";
import { settingsPaths } from "../settings/paths.ts";
import { openSettingsStore } from "../settings/store.ts";
import { freshSettings } from "../settings/schema.ts";
import type { StartupOptions } from "../settings/startup.ts";

export function replayOptions(arguments_: string[]): ReplayOptions | null {
  if (arguments_.length === 0) return null;
  const [flag, path, root, pass, port] = arguments_;
  if (flag !== "--replay" || arguments_.length !== 5 || !path || !root || !isAbsolute(path) || !isAbsolute(root)) {
    throw new Error("Start recorded playback with npm run simulate -- /absolute/path/to/capture.log");
  }
  validateCapturePath(path);
  if (!/^\d+$/.test(pass) || Number(pass) < 1 || !/^\d+$/.test(port) || Number(port) > 65535) {
    throw new Error("Invalid simulator pass or port.");
  }
  return { path, root, pass: Number(pass), port: Number(port), captureTime: null };
}

export interface ReplayOptions {
  path: string;
  root: string;
  pass: number;
  port: number;
  captureTime: number | null;
}

export function validateCapturePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error("The simulator needs an absolute capture path.");
  }
  if (path.endsWith(".zst")) {
    throw new Error("Decompress .zst into a temporary directory with zstd -dc first; then simulate the plain file.");
  }
}

export async function replaySettings(options: ReplayOptions, codeDirectory: string): Promise<StartupOptions> {
  const paths = settingsPaths(options.root);
  // The supervisor owns a never-reused root. The portable holder needs liveness, not flock contention.
  const lock = await acquireSettingsWriterLock(join(paths.privateDirectory, "settings.lock"), {
    executable: process.execPath,
    arguments: ["--input-type=module", "--eval", LOCK_HOLDER, "--"],
  });
  try {
    const store = await openSettingsStore(paths, lock, (await stat(codeDirectory)).gid);
    if (store.read().kind === "missing") {
      const settings = freshSettings(paths);
      settings.values.customBmsConfigurationFlashed = true;
      settings.values.automaticDcChargingEnabled = false;
      await store.initialise(settings);
    }
    return {
      codeDirectory,
      workingDirectory: options.root,
      environment: {},
      paths,
      lock,
      isLegacyInstallation: async () => false,
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export const LOCK_HOLDER =
  'process.stdout.write("cool-eva-settings-lock\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));';

export function replayMessage(options: ReplayOptions): string {
  const time = options.captureTime === null ? "starting" : new Date(options.captureTime).toISOString().slice(11, 19);
  return `Recorded playback: ${basename(options.path)}, pass ${options.pass}, capture ${time}`;
}

export async function waitForReplayStart(server: Server): Promise<void> {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }
  if (!process.send) {
    throw new Error("Recorded playback needs the npm run simulate supervisor.");
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Simulator HTTP address is unavailable.");
  }
  const started = new Promise<void>(resolve => {
    process.once("message", message => {
      if (message === "start") resolve();
    });
  });
  process.send({ type: "ready", host: address.address, port: address.port, pid: process.pid });
  await started;
}
