import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { CAN_CAPTURE_UNIT_PATH, canCaptureUnitText } from "./can-capture/unit.ts";
import { runCaptureScriptWithStubs } from "./can-capture/stub-run.ts";

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
// ⚠️ For assertions about what the script DOES. Several comments below quote the very
// constructs they forbid, and a naive `script.includes(…)` then fails on its own prose.
const code = script
  .split("\n")
  .filter(line => !line.trimStart().startsWith("#"))
  .join("\n");
const PROJECT_DIR = "/opt/probe-project-dir";
const unit = canCaptureUnitText(PROJECT_DIR);
const failures: string[] = [];

// The line that does the work. Everything below is about this one command, so the anchor
// is the load-bearing part of this file: five assertions below are `if (candumpLine && …)`
// and ALL of them silently become no-ops if it matches nothing.
//
// ⚠️ Anchored on the invocation SHAPE, not on the word "candump" — which also appears in
// the tool guard above it, and matching that line is the exact bug the previous version of
// this comment recorded. `exec ` was the old anchor, and it went when the pipeline arrived.
const CANDUMP_INVOCATION = /^\s*(?:if )?stdbuf -oL timeout \d+ candump\b/;
const candumpLines = script.split("\n").filter(line => CANDUMP_INVOCATION.test(line));
const candumpLine = candumpLines[0];
if (candumpLines.length !== 1) {
  failures.push(
    `capture.sh should hold exactly one \`stdbuf -oL timeout <n> candump\` line; found ${candumpLines.length}. ` +
      `Zero means every flag assertion below is a silent no-op; two means one of them is unguarded`
  );
}

if (candumpLine && !/\s-D(\s|$)/.test(candumpLine)) {
  failures.push(
    "the candump invocation has lost -D. Without it, `ip link set can0 down` — which a cool-eva " +
      "restart used to do on every deploy — ends the capture, systemd waits RestartSec and a NEW " +
      "file opens. That is issue #160, measured twice at 5-6 s"
  );
}

// ⚠️ Every assertion in this block is positive, and the direction is deliberate. -D
// removes the file boundary that used to mark a gap, so candump's own "can0: interface
// down" on stderr is the only evidence IN THE FILE that one happened — and the file is
// what gets archived, not the journal. docs/charge-manager.md's E2 reading turns on
// exactly this kind of evidence.
//
// The single `> "$OUTPUT"` line used to do two jobs; the pipeline splits them into three
// places, so each is found by what it DOES rather than by which line it sits on.
const createLine = script.split("\n").find(line => /^:\s+>\s+"\$OUTPUT"$/.test(line.trimStart()));
if (!createLine) {
  failures.push('capture.sh no longer creates "$OUTPUT" with `: > "$OUTPUT"`');
}

const filterMatch = /--filter='([^']*)'/.exec(script);
if (!filterMatch) {
  failures.push("capture.sh no longer passes a --filter to split — the capture would be uncompressed, or absent");
} else {
  const filter = filterMatch[1];
  // ⚠️ Two characters, and both decide whether the capture exists at all. Without `-c`
  // gzip writes nowhere. With `>` in place of `>>` EVERY member truncates the file, which
  // leaves a valid, readable gzip holding the last 64 kB of an eight-hour ride — no error,
  // no red unit, nothing anywhere saying the other eight hours were overwritten.
  if (!/(^|\s)-c(\s|$)/.test(filter)) {
    failures.push(
      `the split filter has lost gzip's -c, so gzip writes a file of its own and not the capture: ${filter}`
    );
  }
  if (!filter.includes('>> "$OUTPUT"')) {
    failures.push(
      `the split filter no longer APPENDS to "$OUTPUT" (found: ${filter}). A single \`>\` makes every 64 kB member ` +
        `truncate the file, and the result is a perfectly readable gzip holding only the end of the ride`
    );
  }
  if (!/\bgzip\b/.test(filter)) {
    failures.push(`the split filter no longer runs gzip: ${filter}`);
  }
}

// ⚠️ The chunk bound is the whole reason split is in this pipeline. gzip -1 emits nothing
// until ~786 kB of input has accumulated — 7 s of bus at the measured 112 kB/s — so a
// larger chunk hands a power cut more of the capture's tail. 65536 is the largest value
// whose worst case stays under the 1.367 s shutdown walk docs/power-cuts.md §7 rests on.
const chunkMatch = /\bsplit\s+-C\s+(\d+)/.exec(script);
if (!chunkMatch) {
  failures.push(
    "capture.sh no longer bounds the gzip member with `split -C <bytes>` — a cut would cost ~7 s of capture"
  );
} else if (Number(chunkMatch[1]) > 65536) {
  failures.push(
    `split -C is ${chunkMatch[1]}, above 65536: worst-case loss is chunk/112000 + 0.38 s, and above 65536 that ` +
      `exceeds the 1.367 s shutdown walk in docs/power-cuts.md §7 — the smallest thing the capture tail measures`
  );
}

// -C and not -b: members end on a line boundary, so only the final partial member of a
// cut capture can ever yield a partial line.
if (/\bsplit\s+-b\b/.test(script)) {
  failures.push("capture.sh splits with -b, which cuts mid-line; -C keeps every member ending on a line boundary");
}

const pipeLine = script.split("\n").find(line => /^\}\s*2>&1\s*\|\s*split\b/.test(line.trimStart()));
if (!pipeLine) {
  failures.push(
    "the capture group no longer ends in `} 2>&1 | split`. Losing 2>&1 removes the only in-band record of an " +
      "interface bounce, leaving a silently gappy capture — see docs/can-capture.md"
  );
}

// ⚠️ A pipeline's status is its LAST command's — split's — so candump's has to travel out
// of the group some other way, or a candump that dies exits 0, systemd calls the unit
// cleanly finished, and the capture stops until the next boot.
//
// It must NOT be `set -o pipefail`: dash gained that only in 0.5.12, and CI caught this
// script exiting 0 on a runner whose /bin/sh has none. A status file is POSIX everywhere.
if (!/\$\(mktemp\)/.test(script) || !/echo \$\? > "\$STATUS_FILE"/.test(script)) {
  failures.push(
    "capture.sh no longer records candump's exit status in a file. A pipeline reports split's status, " +
      "so without this a dying candump exits 0 and Restart=on-failure never fires"
  );
}
if (!/^exit "\$CANDUMP_STATUS"$/m.test(script)) {
  failures.push("capture.sh records candump's status but no longer exits with it, so systemd never sees it");
}
if (/set -o pipefail/.test(code)) {
  failures.push(
    "capture.sh is back to `set -o pipefail` for candump's status. It is not portable enough to carry " +
      "that: dash before 0.5.12 has no such option and silently reports success instead"
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
const redirectIndex = pipeLine ? script.indexOf(pipeLine) : -1;
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
  const sample = "capture-20260914-120000-7ce067a7-00001234.log.gz";
  const uncompressed = "capture-20260914-120000-7ce067a7-00001234.log";
  const legacy = "capture-20260808-211445-2b4b0868.log";
  if (!new RegExp(namePattern2).test(sample)) {
    failures.push(`evidence/keyoff/capture-figures.py cannot parse the name capture.sh now writes (${sample})`);
  }
  if (!new RegExp(namePattern2).test(uncompressed)) {
    failures.push(
      `evidence/keyoff/capture-figures.py no longer parses the uncompressed names beside them (${uncompressed})`
    );
  }
  if (!new RegExp(namePattern2).test(legacy)) {
    failures.push(`evidence/keyoff/capture-figures.py can no longer parse the archive's existing names (${legacy})`);
  }
}
const namePattern = /OUTPUT="\$DIRECTORY\/capture-\$\(date [^)]*\)-\$BOOT_ID-\$UPTIME\.log\.gz"/;
if (!namePattern.test(script)) {
  failures.push(
    "the capture filename is no longer <date>-<bootid>-<uptime>.log.gz: the date leads so a plain `ls` stays " +
      "chronological, the uptime trails so a clock step cannot reorder one boot's files, and .gz is what every " +
      "reader now switches on"
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
// Three binaries now, not one: `: > "$OUTPUT"` truncates the file whether or not the
// pipeline can run, so any of the three missing would leave one empty capture per restart.
for (const tool of ["candump", "gzip", "split"]) {
  if (!new RegExp(`command -v ${tool}\\b`).test(script)) {
    failures.push(`capture.sh no longer checks that ${tool} exists before creating the output file`);
  }
}
if (!/command -v candump[\s\S]{0,400}?\bexit 1\b/.test(script)) {
  failures.push(
    "the candump guard no longer exits — it has to stop before the file is created, or it does nothing at all"
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
const candumpIndexForWait = candumpLine ? script.indexOf(candumpLine) : -1;
if (waitIndex === -1 || candumpIndexForWait === -1 || waitIndex > candumpIndexForWait) {
  failures.push("capture.sh no longer waits for can0 to appear before running candump");
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

// ⚠️ Everything above reads the script. This runs it — under stubbed `ip`, `candump`,
// `df`, `stdbuf`, `timeout`, `sleep` and `split`, in a temp directory — because three of
// the properties that matter are ORDERINGS the regexes above can only approximate, and
// because the floor's fail-closed direction is not a property any regex can see.
const scriptPath = fileURLToPath(CAPTURE_SCRIPT);

const healthy = await runCaptureScriptWithStubs(scriptPath);
if (healthy.exitCode !== 0) {
  failures.push(`capture.sh does not run to completion under stubs: exit ${healthy.exitCode}\n${healthy.output}`);
}
if (healthy.captureFiles.length !== 1) {
  failures.push(`a healthy run wrote ${healthy.captureFiles.length} capture files, expected exactly 1`);
} else if (!/^capture-\d{8}-\d{6}-[0-9a-f]{8}-\d{8}\.log\.gz$/.test(healthy.captureFiles[0])) {
  failures.push(`a healthy run wrote ${healthy.captureFiles[0]}, which is not the documented capture name`);
}
// The file must be real gzip AND carry the header, the frames and candump's stderr. That
// last one is what proves 2>&1 actually reaches the pipe rather than the journal.
if (healthy.capturedText === null) {
  failures.push("the capture a healthy run wrote could not be gunzipped");
} else {
  for (const expected of ["# boot 7ce067a8 uptime 00001234", "can0  101   [8]", "can0: interface down"]) {
    if (!healthy.capturedText.includes(expected)) {
      failures.push(`the capture is missing ${JSON.stringify(expected)} — got:\n${healthy.capturedText}`);
    }
  }
}
if (healthy.splitArgv === null || !healthy.splitArgv.includes("-C 65536")) {
  failures.push(`split was not invoked with the 64 kB chunk bound (argv: ${healthy.splitArgv})`);
}

// Below the floor: refuse, say so, and create NOTHING. The stub `sleep` aborts the wait,
// so this observes the refusal rather than sitting in the retry loop for a minute.
const starved = await runCaptureScriptWithStubs(scriptPath, { availableKb: "10485759" });
if (starved.captureFiles.length !== 0) {
  failures.push(`the disk floor let a capture be created with 10485759 kB free: ${starved.captureFiles.join(", ")}`);
}
if (!/disk floor: 10485759 kB free/.test(starved.output)) {
  failures.push(`the disk floor refused quietly — nothing in the journal names the free space:\n${starved.output}`);
}

// One kB the other side of it must proceed, or the floor is not a floor but a wall.
const justEnough = await runCaptureScriptWithStubs(scriptPath, { availableKb: "10485760" });
if (justEnough.captureFiles.length !== 1) {
  failures.push(`the disk floor refused at exactly 10485760 kB free, which is ON the floor and must pass`);
}

// ⚠️ An unreadable df FAILS CLOSED. Not knowing the free space is not permission to fill
// the card — the .celog ride log is the thing that must not lose.
const blindfolded = await runCaptureScriptWithStubs(scriptPath, { dfFails: true });
if (blindfolded.captureFiles.length !== 0) {
  failures.push("a df that prints nothing let a capture start — the floor must fail closed, not open");
}
if (!/could not read free space/.test(blindfolded.output)) {
  failures.push(`an unreadable df was swallowed rather than logged:\n${blindfolded.output}`);
}

// A candump that dies must take the unit down with it, or Restart=on-failure never fires.
const dyingCandump = await runCaptureScriptWithStubs(scriptPath, { candumpExitCode: 1 });
if (dyingCandump.exitCode === 0) {
  failures.push(
    "capture.sh exited 0 with a candump that failed. systemd would call the unit cleanly finished and the " +
      "capture would stop until the next boot — this is what `set -o pipefail` is for"
  );
}

// …and the mutation that proves the line above is load-bearing rather than decorative:
// with the status file bypassed, the pipeline's own status is split's, which is 0.
const withoutStatusFile = script.replace(/^exit "\$CANDUMP_STATUS"$/m, "exit 0 # status file bypassed by the mutation");
if (withoutStatusFile === script) {
  failures.push("the status-file mutation did not apply — the assertion below would be testing nothing");
} else {
  const mutated = await runCaptureScriptWithStubs(scriptPath, { candumpExitCode: 1, scriptText: withoutStatusFile });
  if (mutated.exitCode !== 0) {
    failures.push(
      `bypassing the status file was expected to hide a failing candump behind exit 0, but the run exited ` +
        `${mutated.exitCode}. Either the shell defaults changed or this check no longer proves what it claims`
    );
  }
}

// ⚠️ The status file is the only path candump's code travels, so a status that reads back
// as anything but a number has to be LOUD. Reporting success there would be the original
// silent failure wearing the fix's clothes.
const unreadableStatus = await runCaptureScriptWithStubs(scriptPath, { corruptStatus: true });
if (unreadableStatus.exitCode === 0) {
  failures.push("capture.sh exited 0 when candump's status file held something that is not a number");
}
if (!/no usable exit status/.test(unreadableStatus.output)) {
  failures.push(`an unusable status was not named in the journal:\n${unreadableStatus.output}`);
}

// ⚠️ And the portability trap itself, which is what CI caught: a shell WITHOUT pipefail
// must still propagate the failure. The status file does not care, but this asserts it
// rather than trusting whichever /bin/sh the runner happens to have.
const dashLike = await runCaptureScriptWithStubs(scriptPath, { candumpExitCode: 7 });
if (dashLike.exitCode !== 7) {
  failures.push(`candump exited 7 and capture.sh exited ${dashLike.exitCode}; the status must pass through unchanged`);
}

// Any of the three binaries missing: exit non-zero, say which, and leave NO file behind.
// `: > "$OUTPUT"` truncates whether or not the pipeline can run, so an ungated missing
// binary means one empty capture per restart — ~17 000 a day at RestartSec=5.
for (const tool of ["gzip", "candump"]) {
  const without = await runCaptureScriptWithStubs(scriptPath, { omitFromPath: [tool] });
  if (without.exitCode === 0) {
    failures.push(`capture.sh exited 0 with ${tool} missing from PATH`);
  }
  if (without.captureFiles.length !== 0) {
    failures.push(
      `capture.sh created ${without.captureFiles.join(", ")} with ${tool} missing — the guard runs too late`
    );
  }
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "\n✓ capture.sh keeps -D, its stderr marker, the boot-id name and the can0 wait; the 64 kB gzip members and " +
    "the three-binary guard hold; candump's exit status reaches systemd through a file rather than pipefail; " +
    "the disk floor refuses below 10 GiB and fails closed on an unreadable df; the unit runs the tracked script"
);
