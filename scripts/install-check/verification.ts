import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { monotonicNow, since } from "../../src/monotonic.ts";
import { sshCommand, type GuestSsh } from "./ssh.ts";

export async function verifyPostInstall(
  guest: GuestSsh,
  directory: string,
  execute: typeof sshCommand = sshCommand,
  clock: VerificationClock = { now: monotonicNow, elapsed: since, wait: delay }
): Promise<void> {
  const started = clock.now();
  let evidence = "Post-install verification: one guest job, 600 s overall budget.\n";
  try {
    try {
      await withinBudget(guest, setupCommand(), started, execute, clock, BUDGET_MS);
    } catch (error) {
      if (!transportFailure(error)) {
        throw error;
      }
      evidence += "Submission connection lost; observe without resubmitting.\n";
      console.warn("Verification submission connection lost; inspecting the guest job:", error);
    }
    while (clock.elapsed(started) < BUDGET_MS) {
      let response: string;
      try {
        response = await withinBudget(guest, OBSERVE, started, execute, clock, 15_000);
      } catch (error) {
        if (!transportFailure(error)) {
          throw error;
        }
        console.warn("Verification observation connection lost; the job is not restarted:", error);
        evidence += `Observation unavailable at ${clock.elapsed(started)} ms.\n`;
        await clock.wait(Math.min(2_000, Math.max(0, BUDGET_MS - clock.elapsed(started))));
        continue;
      }
      evidence += `Observed at ${clock.elapsed(started)} ms:\n${response}\n`;
      if (clock.elapsed(started) >= BUDGET_MS) break;
      const [properties, receipt = ""] = response.split("\nRECEIPT\n");
      const values = new Map(
        properties.split("\n").map(line => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
      );
      const state = values.get("ActiveState");
      const job = values.get("Job")?.split(" ")[0] ?? "";
      if (
        values.get("LoadState") === "not-found" ||
        (state === "inactive" && (job === "" || job === "0") && values.get("Marker") === "0")
      ) {
        throw new Error("Post-install verification was not submitted; no retry was attempted.");
      }
      if (state === "failed" || (state === "inactive" && values.get("Marker") === "1")) {
        throw new Error(`Post-install verification failed: ${properties}\n${receipt}`);
      }
      if (state === "active") {
        assert.equal(values.get("Result"), "success", "Guest verification Result");
        assert.equal(values.get("ExecMainCode"), "1", "Guest verification must exit normally");
        assert.equal(values.get("ExecMainStatus"), "0", "Guest verification exit status");
        evidence += validateVerificationReceipt(receipt);
        console.log("Post-install verification passed:", EXPECTED_CHECKS.join(", "));
        return;
      }
      await clock.wait(Math.min(2_000, Math.max(0, BUDGET_MS - clock.elapsed(started))));
    }
    throw new Error("Post-install verification exceeded its 600 s overall budget; the guest job was not retried.");
  } finally {
    await writeFile(join(directory, "post-install-verification.txt"), evidence, { mode: 0o600 });
  }
}

export interface VerificationClock {
  now: () => number;
  elapsed: (started: number) => number;
  wait: (milliseconds: number) => Promise<unknown>;
}

const BUDGET_MS = 600_000;
// Independent of the script generator: deleting an assertion must leave a missing receipt entry.
const EXPECTED_CHECKS = [
  "fixture",
  "jq-manual",
  "app-active",
  "wasm-guard",
  "app-enabled",
  "dispatcher",
  "capture-off",
  "settings-mode",
  "updater-mode",
  "hotspot-mode",
  "os-power-policy",
  "networks",
];
const UNIT = "cool-eva-qemu-verify.service";
const RECEIPT = "/run/cool-eva-qemu-verify.receipt";
const MARKER = "/run/cool-eva-qemu-verify.started";

export function verificationScript(): string {
  const checks: [string, string][] = [
    ["fixture", "test -e /etc/cool-eva-qemu-fixture"],
    ["jq-manual", "manual_packages=$(apt-mark showmanual); printf '%s\\n' \"$manual_packages\" | grep -qx jq"],
    ["app-active", "systemctl is-active --quiet cool-eva"],
    [
      "wasm-guard",
      'grep -azq -- --no-wasm-lazy-compilation /proc/"$(systemctl show cool-eva --property=MainPID --value)"/cmdline',
    ],
    ["app-enabled", "systemctl is-enabled --quiet cool-eva"],
    ["dispatcher", "test -x /usr/local/libexec/cool-eva-update"],
    ["capture-off", "test ! -e /etc/systemd/system/can-capture.service"],
    ["settings-mode", 'test "$(stat -c %a /var/lib/cool-eva/state/settings.json)" = 600'],
    ["updater-mode", 'test "$(stat -c %a /var/lib/cool-eva/updater/state.json)" = 600'],
    ["hotspot-mode", 'test "$(stat -c %a /etc/NetworkManager/system-connections/cool-eva-hotspot.nmconnection)" = 600'],
    [
      "os-power-policy",
      "power_policy=$(/usr/bin/curl -fsS --max-time 10 http://127.0.0.1/os-update-ready); printf '%s\\n' \"$power_policy\" | jq -e .ok==false",
    ],
    ["networks", "nmcli connection show"],
  ];
  return `#!/bin/sh
set -eu
test -e /etc/cool-eva-qemu-fixture
mkdir ${MARKER}
step() {
    name=$1
    read started idle < /proc/uptime
    printf 'START %s %s\\n' "$name" "$started" >> ${RECEIPT}
    if sh -eu -c "$2"; then status=0; else status=$?; fi
    read finished idle < /proc/uptime
    printf 'END %s %s %s %s\\n' "$name" "$started" "$finished" "$status" >> ${RECEIPT}
    return "$status"
}
${checks.map(([name, command]) => `step ${quote(name)} ${quote(command)}`).join("\n")}
printf 'COMPLETE\\n' >> ${RECEIPT}
`;
}

export function validateVerificationReceipt(receipt: string): string {
  const lines = receipt.trim().split("\n");
  let summary = "";
  assert.equal(lines.length, EXPECTED_CHECKS.length * 2 + 1, "Every check must have a start and end");
  for (const [index, name] of EXPECTED_CHECKS.entries()) {
    const start = lines[index * 2].split(" ");
    const end = lines[index * 2 + 1].split(" ");
    assert.deepEqual(start.slice(0, 2), ["START", name]);
    assert.equal(start.length, 3);
    assert.deepEqual(end.slice(0, 3), ["END", name, start[2]]);
    assert.equal(end.length, 5);
    assert.equal(end[4], "0", `${name} failed`);
    assert(Number.isFinite(Number(start[2])) && Number(end[3]) >= Number(start[2]), `${name} monotonic times`);
    summary += `${name}: exit ${end[4]}, duration ${(Number(end[3]) - Number(start[2])).toFixed(2)} s\n`;
  }
  assert.equal(lines.at(-1), "COMPLETE");
  return summary;
}

function setupCommand(): string {
  const setup = `set -eu
test -e /etc/cool-eva-qemu-fixture
cat > /run/cool-eva-qemu-verify.sh <<'VERIFY_SCRIPT'
${verificationScript()}VERIFY_SCRIPT
chmod 700 /run/cool-eva-qemu-verify.sh
cat > /run/systemd/system/${UNIT} <<'VERIFY_UNIT'
[Unit]
Description=QEMU-only post-install assertions
[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=infinity
ExecStart=/bin/sh /run/cool-eva-qemu-verify.sh
VERIFY_UNIT
systemctl daemon-reload
systemctl start --no-block ${UNIT}
`;
  return `printf '%s' '${Buffer.from(setup).toString("base64")}' | base64 -d | sudo sh`;
}

const OBSERVE = `sudo sh -eu -c 'systemctl show ${UNIT} --property=LoadState --property=ActiveState --property=Result --property=Job --property=ExecMainCode --property=ExecMainStatus
if [ -d ${MARKER} ]; then echo Marker=1; else echo Marker=0; fi
printf "\\nRECEIPT\\n"
if [ -f ${RECEIPT} ]; then cat ${RECEIPT}; fi'`;

async function withinBudget(
  guest: GuestSsh,
  command: string,
  started: number,
  execute: typeof sshCommand,
  clock: VerificationClock,
  maximum: number
): Promise<string> {
  // execFile requires integer milliseconds; the monotonic elapsed value has fractions.
  const remaining = Math.floor(BUDGET_MS - clock.elapsed(started));
  assert(remaining > 0, "Verification budget exhausted");
  return execute(guest, command, Math.max(1, Math.min(maximum, remaining)));
}

function transportFailure(error: unknown): boolean {
  return (
    error instanceof Error && (("code" in error && error.code === 255) || ("killed" in error && error.killed === true))
  );
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
