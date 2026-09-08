import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { promisify } from "util";
import { CAN_CAPTURE_UNIT_PATH, canCaptureUnitText } from "./can-capture/unit.ts";

const execFileAsync = promisify(execFile);

// Guards the raw CAN capture — the unit and the shell script that produce every `.log`
// this project's decode findings rest on. Both ran UNTRACKED on one SD card until
// 2026-09; this check is what stops the tracked copies drifting back.
//
//     node --experimental-strip-types scripts/check-can-capture.ts
//
// ⚠️ What it CANNOT do: prove candump behaves as documented on the Pi. It reads two
// tracked files and parses one of them. The claims about `-D` come from can-utils and
// kernel source (docs/can-capture.md); only an observed interface bounce settles them,
// and until that happens the PR says so. What this check does catch is the silent
// regression — a flag tidied away, a redirect "cleaned up" — where nothing fails, the
// unit stays green, and the loss only shows up weeks later as frames that were never
// recorded. That is the failure mode issue #160 is about.

const CAPTURE_SCRIPT = new URL("./can-capture/capture.sh", import.meta.url);

const script = await readFile(CAPTURE_SCRIPT, "utf8");
const unit = canCaptureUnitText("/home/pi/cool-eva");
const failures: string[] = [];

// The line that does the work. Everything below is about this one command.
const candumpLine = script.split("\n").find(line => line.includes("candump") && !line.trimStart().startsWith("#"));
if (!candumpLine) {
  failures.push("capture.sh no longer invokes candump at all");
}

if (candumpLine && !/\s-D(\s|$)/.test(candumpLine)) {
  failures.push(
    "the candump invocation has lost -D. Without it, `ip link set can0 down` — which a cool-eva " +
      "restart used to do on every deploy — ends the capture, systemd waits RestartSec and a NEW " +
      "file opens. That is issue #160, measured twice at 5-6 s"
  );
}

// ⚠️ Positive assertion, and the direction is deliberate. -D removes the file boundary
// that used to mark a gap, so candump's own "can0: interface down" on stderr becomes the
// only evidence IN THE FILE that one happened — and the file is what gets archived, not
// the journal. docs/charge-manager.md's E2 reading turns on exactly this kind of evidence.
if (candumpLine && !candumpLine.includes("2>&1")) {
  failures.push(
    "the candump redirect has lost 2>&1. With -D that removes the only in-band record of an " +
      "interface bounce, leaving a silently gappy capture — see docs/can-capture.md"
  );
}

if (candumpLine && !/>\s*"\$OUTPUT"/.test(candumpLine)) {
  failures.push(`the candump output no longer goes to "$OUTPUT": ${candumpLine.trim()}`);
}

// ⚠️ Never a tmpfs. `docs/pi-agent-brief.md` states the rail — "never capture to /tmp, it
// is tmpfs and the Pi loses power with the bike" — and this is not hypothetical drift:
// scripts/replay-capture.ts carried a stale "/tmp/ride-captures" for months, which is
// exactly the wrong path waiting to be copied back into the script it describes.
const directory = /^DIRECTORY=(\S+)/m.exec(script)?.[1];
if (!directory) {
  failures.push("capture.sh no longer sets DIRECTORY");
} else if (/^\/(tmp|run|dev\/shm)\b/.test(directory)) {
  failures.push(
    `capture.sh writes to ${directory}, which is tmpfs — the bike power-cycles the Pi and the whole capture is lost`
  );
}

// The name has to stay unique per boot without trusting the clock: this Pi has no RTC and
// steps its own time from GPS, so two boots can honestly produce the same timestamp.
if (!script.includes("/proc/sys/kernel/random/boot_id")) {
  failures.push("capture.sh no longer derives the filename from boot_id — names can collide across boots");
}

// Waits for the DEVICE to appear (USB enumeration), which -D cannot help with: a socket
// cannot be bound to an interface that does not exist yet. The two overlap, neither is
// redundant, and this has to come first.
const waitIndex = script.indexOf("ip link show can0");
const execIndex = script.indexOf("exec stdbuf");
if (waitIndex === -1 || execIndex === -1 || waitIndex > execIndex) {
  failures.push("capture.sh no longer waits for can0 to appear before exec'ing candump");
}

// `/bin/sh <script>` so a lost exec bit cannot break the unit at boot with 203/EXEC —
// nothing else tracked in this repo is executable.
if (!unit.includes("ExecStart=/bin/sh ") || !unit.includes("/scripts/can-capture/capture.sh")) {
  failures.push(`the unit's ExecStart no longer runs the tracked script through /bin/sh:\n${unit}`);
}

// ⚠️ StartLimitIntervalSec / StartLimitBurst are [Unit] keys. systemd IGNORES them in
// [Service], with one line in the journal that nobody reads — so a rate limit believed to
// be disabled is still in force. There is none here today; this keeps it that way, or
// makes whoever adds one put it in the right section. docs/can-capture.md.
const serviceSection = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
if (/StartLimit/.test(serviceSection)) {
  failures.push("a StartLimit* key is in [Service], where systemd silently ignores it — it belongs in [Unit]");
}

if (!/^Restart=/m.test(serviceSection)) {
  failures.push("the unit has no Restart= — an unplugged adapter (ENODEV) would exit candump and never come back");
}

if (!CAN_CAPTURE_UNIT_PATH.startsWith("/etc/systemd/system/")) {
  failures.push(`the unit install path is not under /etc/systemd/system: ${CAN_CAPTURE_UNIT_PATH}`);
}

// A parse check on a file nothing else here runs. `sh` is bash-in-POSIX-mode on macOS and
// dash on the CI runner, so this doubles as a portability gate — which is what a
// `#!/bin/sh` script wants, and why a legitimate bash-only construct will fail here.
try {
  await execFileAsync("sh", ["-n", CAPTURE_SCRIPT.pathname]);
} catch (error) {
  failures.push(`capture.sh does not parse as POSIX sh: ${(error as Error).message.split("\n").slice(0, 3).join(" ")}`);
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "\n✓ capture.sh keeps -D, its stderr marker, the boot-id name and the can0 wait; the unit runs the tracked script"
);
