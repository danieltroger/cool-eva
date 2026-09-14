import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
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
const PROJECT_DIR = "/opt/probe-project-dir";
const unit = canCaptureUnitText(PROJECT_DIR);
const failures: string[] = [];

// The line that does the work. Everything below is about this one command. Matched on
// `exec` rather than on "candump", which also appears in the guard above it — the loose
// version silently pointed every assertion below at the wrong line.
const candumpLine = script.split("\n").find(line => line.trimStart().startsWith("exec ") && line.includes("candump"));
if (!candumpLine) {
  failures.push("capture.sh no longer exec's candump");
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
// The redirect moved off the candump line onto the brace group when the header echo was
// added (#188), so it is found by what it DOES rather than by which line it is on — a test
// pinned to the exec line would have gone green the day the redirect stopped covering it.
const redirectLine = script.split("\n").find(line => /^\}?\s*>\s*"\$OUTPUT"/.test(line.trimStart()));
if (!redirectLine) {
  failures.push('nothing in capture.sh redirects to "$OUTPUT" any more — the capture would go to the journal');
}

if (redirectLine && !redirectLine.includes("2>&1")) {
  failures.push(
    "the candump redirect has lost 2>&1. With -D that removes the only in-band record of an " +
      "interface bounce, leaving a silently gappy capture — see docs/can-capture.md"
  );
}

// -tA is the wire format every reader of these files assumes: scripts/replay-capture.ts
// parses it, and so does every awk recipe in docs/. -td would parse as garbage silently.
if (candumpLine && !/\s-tA(\s|$)/.test(candumpLine)) {
  failures.push(
    `the candump invocation is not -tA — replay-capture.ts and the awk recipes in docs/ all assume absolute timestamps: ${candumpLine.trim()}`
  );
}

// ⚠️ -D promoted this to the ONLY bound on a capture file's size: nothing else now ends
// one. Without it a single boot writes until the card fills.
if (candumpLine && !/\btimeout\s+28800\b/.test(candumpLine)) {
  failures.push(
    `the candump invocation has lost its 8 h \`timeout 28800\` — with -D nothing else ever closes a capture ` +
      `file, so this is the only bound on how big one gets: ${candumpLine.trim()}`
  );
}

// The exec has to sit INSIDE the group the redirect covers, or candump writes to the
// journal while the header line is the only thing in the file.
const redirectIndex = redirectLine ? script.indexOf(redirectLine) : -1;
const groupIndex = script.indexOf('{\n  echo "# boot');
if (candumpLine && redirectIndex >= 0) {
  const candumpIndex = script.indexOf(candumpLine);
  if (!(groupIndex >= 0 && groupIndex < candumpIndex && candumpIndex < redirectIndex)) {
    failures.push('the candump exec is no longer inside the group redirected to "$OUTPUT"');
  }
}

// ⚠️ The boot id and the uptime go INSIDE the file as well as into its name. The archive
// travels to the laptop; the journal stays on a card that gets reflashed, so anything not in
// the file is lost — the same argument that keeps 2>&1. replay-capture.ts counts a line it
// cannot parse as framesSkipped, so it costs a reader nothing.
if (!/^\s*echo "# boot \$BOOT_ID uptime \$UPTIME"/m.test(script)) {
  failures.push("capture.sh no longer writes the boot id and uptime into the capture file itself");
}

// The Pi has no RTC, so uptime is the only monotonic thing it has and it is what orders two
// captures from one boot when the clock steps between them.
if (!script.includes("/proc/uptime")) {
  failures.push("capture.sh no longer reads /proc/uptime — nothing in the name would survive a clock step");
}
if (!/OUTPUT="[^"]*\$UPTIME/.test(script)) {
  failures.push("the capture filename no longer carries $UPTIME — a mid-boot clock step reorders the files");
}

// ⚠️ The DATE stays first, and that is a decision rather than an accident — argued from six
// boots, which is every boot in the archive with more than one capture. docs/ride-log-clock.md §5.

// ⚠️ And the reduction script that reads this archive has to accept the name this script
// writes. It did not: the filename regex in evidence/keyoff/capture-figures.py predated the
// uptime field, and a non-match there is a silent `continue`, so every capture written from
// this change on would have dropped out of every figure in docs/power-cuts.md §7 with no
// error at all. The two live in different languages and nothing else pairs them.
const reductionSource = await readFile(new URL("../evidence/keyoff/capture-figures.py", import.meta.url), "utf-8");
const namePattern2 = /^NAME = re\.compile\(r"(.+)"\)$/m.exec(reductionSource)?.[1];
if (!namePattern2) {
  failures.push("evidence/keyoff/capture-figures.py no longer declares a NAME regex to check the filename against");
} else {
  const sample = "capture-20260914-120000-7ce067a7-00001234.log";
  const legacy = "capture-20260808-211445-2b4b0868.log";
  if (!new RegExp(namePattern2).test(sample)) {
    failures.push(`evidence/keyoff/capture-figures.py cannot parse the name capture.sh now writes (${sample})`);
  }
  if (!new RegExp(namePattern2).test(legacy)) {
    failures.push(`evidence/keyoff/capture-figures.py can no longer parse the archive's existing names (${legacy})`);
  }
}
const namePattern = /OUTPUT="\$DIRECTORY\/capture-\$\(date [^)]*\)-\$BOOT_ID-\$UPTIME\.log"/;
if (!namePattern.test(script)) {
  failures.push(
    "the capture filename is no longer <date>-<bootid>-<uptime>: the date leads so a plain `ls` stays " +
      "chronological, and the uptime trails so a clock step cannot reorder one boot's files"
  );
}

// ⚠️ Never a tmpfs. `docs/pi-agent-brief.md` states the rail — "never capture to /tmp, it
// is tmpfs and the Pi loses power with the bike" — and this is not hypothetical drift:
// scripts/replay-capture.ts carried a stale "/tmp/ride-captures" for months, which is
// exactly the wrong path waiting to be copied back into the script it describes.
// Quotes stripped first: `DIRECTORY="/tmp/…"` would otherwise sail straight past the test.
const directory = /^DIRECTORY=(\S+)/m.exec(script)?.[1]?.replace(/^["']|["']$/g, "");
if (!directory) {
  failures.push("capture.sh no longer sets DIRECTORY");
} else if (/^\/(tmp|run|dev\/shm)\b/.test(directory)) {
  failures.push(
    `capture.sh writes to ${directory}, which is tmpfs — the bike power-cycles the Pi and the whole capture is lost`
  );
}

// ⚠️ A healthy DIRECTORY is not the same as the file living in it. Repointing OUTPUT alone
// at /tmp leaves every other assertion here green while a power cut takes the whole boot's
// capture with it.
if (!/^OUTPUT="\$DIRECTORY\//m.test(script)) {
  failures.push('capture.sh no longer builds OUTPUT from "$DIRECTORY" — the file could sit anywhere, tmpfs included');
}

// can-utils is not a default Raspberry Pi OS package, and `exec … > "$OUTPUT"` truncates the
// file in the SHELL before exec'ing — so without this guard a missing candump leaves one
// empty capture per restart in the directory the archive is swept from.
if (!/if ! command -v candump/.test(script)) {
  failures.push("capture.sh no longer checks that candump exists before creating the output file");
} else if (!/command -v candump[\s\S]{0,400}?\bexit 1\b/.test(script)) {
  failures.push("the candump guard no longer exits — it has to stop before the redirect, or it does nothing at all");
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
if (!unit.includes(`ExecStart=/bin/sh ${PROJECT_DIR}/scripts/can-capture/capture.sh`)) {
  failures.push(
    `the unit's ExecStart does not run the tracked script, under the project directory it was given, through ` +
      `/bin/sh — a hardcoded path would install a unit pointing at someone else's checkout:\n${unit}`
  );
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
  // fileURLToPath, not .pathname: the latter stays percent-encoded while readFile above
  // decodes it, so a checkout under a path with a space would fail here and only here.
  await execFileAsync("sh", ["-n", fileURLToPath(CAPTURE_SCRIPT)]);
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
