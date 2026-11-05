import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { guestDiagnosticsSeed } from "./diagnostics.ts";
import { captureGuestInspection, verifyGuestDiagnostics } from "./inspection.ts";
import type { GuestSsh } from "./ssh.ts";

export async function checkQemuDiagnostics(parent: string): Promise<void> {
  const root = join(parent, "qemu-diagnostics");
  for (const directory of ["bin", "units", "log", "libexec", "proc/pressure", "proc/sys/kernel/random"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const [name, contents] of [
    ["fixture", ""],
    ["proc/uptime", "100.00 200.00\n"],
    ["proc/meminfo", "MemTotal: 524288 kB\nMemAvailable: 64000 kB\nSwapTotal: 262144 kB\nSwapFree: 200000 kB\n"],
    ["proc/vmstat", "oom_kill 0\npswpin 5\npswpout 9\n"],
    ["proc/stat", "cpu 100 0 10 500 0 0 0 0\nprocs_running 1\n"],
    ["proc/pressure/memory", "some avg10=0.00 total=123\n"],
    ["proc/sys/kernel/random/boot_id", "synthetic-boot-id\n"],
  ]) {
    await writeFile(join(root, name), contents);
  }
  const environment = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, QEMU_TEST_ROOT: root };
  for (const [name, script] of [
    [
      "systemctl",
      'case "$1" in enable) exit 0 ;; is-active) exit 0 ;; is-enabled) echo masked; exit 1 ;; esac\nprintf "Id=ssh.service\\nActiveState=active\\nMainPID=456\\n"\nexit 4',
    ],
    ["journalctl", "echo SYNTHETIC_JOURNAL"],
    ["timeout", 'shift; exec "$@"'],
    ["curl", "echo 'http=200 seconds=0.010'"],
    ["ps", "printf 'PID PPID STAT ELAPSED CPU RSS COMMAND\\n123 1 S 4 2.0 1024 needrestart\\n'"],
    ["free", "echo SYNTHETIC_FREE_MEMORY"],
    ["dmesg", "echo SYNTHETIC_KERNEL"],
    ["sleep", 'if [ -e "$QEMU_TEST_ROOT/ticked" ]; then exit 77; fi; touch "$QEMU_TEST_ROOT/ticked"'],
  ]) {
    await writeFile(join(root, "bin", name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const seed = join(root, "seed.sh");
  await writeFile(seed, mapFixture(guestDiagnosticsSeed(), root));
  await promisify(execFile)("sh", ["-n", seed]);
  await promisify(execFile)("sh", ["-eu", seed], { env: environment });
  for (const name of ["serial-getty@ttyS0.service", "getty@ttyS0.service"]) {
    assert.equal(await readlink(join(root, "units", name)), "/dev/null", "No getty may hang up the diagnostic TTY");
  }
  const unit = await readFile(join(root, "units/cool-eva-qemu-diagnostics.service"), "utf8");
  assert(unit.includes(`StandardOutput=append:${join(root, "log/cool-eva-qemu-diagnostics.log")}`));
  assert(!unit.includes("StandardOutput=tty"), "Collection must persist independently of serial output");
  const consoleUnit = await readFile(join(root, "units/cool-eva-qemu-console.service"), "utf8");
  assert(consoleUnit.includes("/usr/bin/tail --lines=+1 --follow=name --retry"));
  assert(consoleUnit.includes("TTYVHangup=no"));
  const sampler = join(root, "libexec/cool-eva-qemu-diagnostics");
  const output = join(root, "log/cool-eva-qemu-diagnostics.log");
  let failure: unknown;
  try {
    await promisify(execFile)("sh", ["-c", 'sh "$1" > "$2" 2>&1', "sampler", sampler, output], {
      env: environment,
    });
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error && "code" in failure && failure.code === 77, "Controlled stop after two samples");
  const report = await readFile(output, "utf8");
  assert.equal([...report.matchAll(/COOL_EVA_QEMU_GUEST .* uptime=/g)].length, 2);
  for (const expected of [
    "SYNTHETIC_JOURNAL",
    "synthetic-boot-id",
    "MemAvailable: 64000",
    "oom_kill 0",
    "needrestart",
    "unit query failed or timed out",
    "http=200 seconds=0.010",
  ]) {
    assert(report.includes(expected), expected);
  }
  const guest: GuestSsh = { key: "fixture", knownHosts: "fixture", port: 12345 };
  const execute = async (_guest: GuestSsh, command: string): Promise<string> => {
    const result = await promisify(execFile)("sh", ["-c", mapFixture(command.replace(/^sudo sh/, "sh"), root)], {
      env: environment,
    });
    return result.stdout;
  };
  await captureGuestInspection(guest, join(root, "inspection.log"), execute);
  const inspection = await readFile(join(root, "inspection.log"), "utf8");
  for (const expected of [
    "SYNTHETIC_JOURNAL",
    "SYNTHETIC_FREE_MEMORY",
    "SYNTHETIC_KERNEL",
    "needrestart",
    "INSPECTION command failed:",
  ]) {
    assert(inspection.includes(expected), expected);
  }
  await writeFile(
    join(root, "bin/sleep"),
    `#!/bin/sh
read uptime idle < "$QEMU_TEST_ROOT/proc/uptime"
printf '%s.00 200.00\\n' "$((\${uptime%%.*} + 2))" > "$QEMU_TEST_ROOT/proc/uptime"
if [ -f "$QEMU_TEST_ROOT/alive" ]; then printf 'COOL_EVA_QEMU_GUEST 2026-11-05T00:00:00Z uptime=102\\n' >> "$QEMU_TEST_ROOT/log/cool-eva-qemu-diagnostics.log"; fi
`,
    { mode: 0o755 }
  );
  await writeFile(join(root, "alive"), "");
  await verifyGuestDiagnostics(guest, "fixture", execute);
  await writeFile(
    join(root, "bin/sleep"),
    `#!/bin/sh
read uptime idle < "$QEMU_TEST_ROOT/proc/uptime"
printf '%s.00 200.00\\n' "$((\${uptime%%.*} + 2))" > "$QEMU_TEST_ROOT/proc/uptime"
printf 'COOL_EVA_QEMU_GUEST unit query failed\\n' >> "$QEMU_TEST_ROOT/log/cool-eva-qemu-diagnostics.log"
`,
    { mode: 0o755 }
  );
  await assert.rejects(
    verifyGuestDiagnostics(guest, "stale", execute),
    /Command failed/,
    "An active unit with a stopped sampler must fail the gate"
  );
  console.log(
    "QEMU diagnostics: getty masks, persistent collection, bounded queries, failure snapshot and live-versus-stale sampling passed."
  );
}

function mapFixture(script: string, root: string): string {
  return script
    .replaceAll("/usr/local/libexec", join(root, "libexec"))
    .replaceAll("/etc/systemd/system", join(root, "units"))
    .replaceAll("/var/log", join(root, "log"))
    .replaceAll("/etc/cool-eva-qemu-fixture", join(root, "fixture"))
    .replaceAll("/proc/", `${root}/proc/`);
}
