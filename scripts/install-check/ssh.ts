import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { monotonicNow, since } from "../../src/monotonic.ts";
import { installerRemoteCommand } from "../release/installer.ts";
import { validatePublicKey } from "../../src/settings/public-key.ts";
import { captureGuestInspection } from "./inspection.ts";

export async function sshCommand(guest: GuestSsh, command: string, timeout = 60_000): Promise<string> {
  const { stdout } = await promisify(execFile)("ssh", [...sshArguments(guest), command], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export async function waitForSsh(guest: GuestSsh): Promise<void> {
  const started = monotonicNow();
  let lastFailure = "SSH has not answered";
  while (since(started) < 300_000) {
    try {
      await sshCommand(guest, "test -e /run/sshd", 15_000);
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message.split("\n")[0] : "SSH unavailable";
    }
    await delay(2_000);
  }
  throw new Error(`QEMU did not enable SSH: ${lastFailure}`);
}

export async function runInstaller(
  guest: GuestSsh,
  publicKey: string,
  log: string,
  mode: "fresh" | "rerun" | "legacy" = "fresh"
): Promise<string> {
  const repeat = mode === "rerun";
  if (!repeat) {
    publicKey = validatePublicKey(publicKey);
  }
  const answers: [string, string][] = [
    ["Type BENCH to confirm stable bench power: ", "BENCH\n"],
    ["Home Wi-Fi name", repeat ? "\n" : "Synthetic Home\n"],
    ...(!repeat ? [["Home Wi-Fi password (hidden): ", "fixture-home-password\n"] as [string, string]] : []),
    ["Phone hotspot name", repeat ? "\n" : "Synthetic Hotspot\n"],
    ...(!repeat ? [["Phone hotspot password (hidden): ", "fixture-hotspot-password\n"] as [string, string]] : []),
    ["Public key: ", repeat ? "\n" : publicKey],
    ...(!repeat ? [["Type BACKED UP to confirm: ", "BACKED UP\n"] as [string, string]] : []),
    ...(mode === "fresh"
      ? [
          ["Optional coolant probes already wired? Type WIRED to enable, or Enter for off: ", "\n"] as [string, string],
          [
            "Optional radiator fan/driver already wired? It can start automatically. Type WIRED to enable, or Enter for off: ",
            "\n",
          ] as [string, string],
        ]
      : []),
  ];
  let output = "";
  await writeFile(log, "", { mode: 0o600 });
  let writes = Promise.resolve();
  let answerIndex = 0;
  let scanned = 0;
  const child = spawn("ssh", ["-tt", ...sshArguments(guest), installerRemoteCommand()], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 2400_000,
  });
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
    writes = writes.then(() => appendFile(log, chunk));
    writes.catch(error => {
      console.error("Cannot save installer diagnostics:", error);
      child.kill("SIGTERM");
    });
    const next = answers[answerIndex];
    if (next && output.slice(scanned).includes(next[0])) {
      scanned = output.length;
      answerIndex++;
      child.stdin.write(next[1]);
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await writes;
  if (output.includes("fixture-home-password") || output.includes("fixture-hotspot-password")) {
    throw new Error(`Installer echoed a password; see private ${log}`);
  }
  if (status !== 0 || answerIndex !== answers.length || !output.includes("Dashboard ready:")) {
    await captureGuestInspection(guest, log + ".inspection.log", sshCommand);
    try {
      const kernel = await sshCommand(guest, "sudo dmesg | tail -100");
      await appendFile(log, "\nKernel diagnostics after installer failure:\n" + kernel);
    } catch (error) {
      console.warn("Cannot collect guest kernel diagnostics:", error instanceof Error ? error.message : error);
    }
    throw new Error(`Installer failed (${status}, ${answerIndex}/${answers.length} prompts); see ${log}`);
  }
  return output;
}

export interface GuestSsh {
  key: string;
  knownHosts: string;
  port: number;
}

export function sshArguments(guest: GuestSsh): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${guest.knownHosts}`,
    "-i",
    guest.key,
    "-p",
    String(guest.port),
    "cool-eva-test@127.0.0.1",
  ];
}
