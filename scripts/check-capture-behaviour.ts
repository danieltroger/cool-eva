import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { runCaptureScriptWithStubs } from "./can-capture/stub-run.ts";

// Runs the raw-CAN-capture script and checks what it DOES. Split from
// scripts/check-can-capture.ts, which reads the same file and checks what it SAYS — that
// one was past 400 lines with both jobs in it (CLAUDE.md).
//
//     node --experimental-strip-types scripts/check-capture-behaviour.ts
//
// ⚠️ Why executing it is worth a second file at all: three of the properties that matter
// are ORDERINGS the regexes over there can only approximate with indexOf — the tool guard
// and the disk floor must both come before the capture file is created, and the can0 wait
// before candump — and the floor's fail-closed direction is not a property any regex can
// see. `ip`, `candump`, `df`, `stdbuf`, `timeout`, `sleep` and `split` are stubbed, the
// capture directory and the two /proc paths are rewritten in a copy, and nothing here
// touches a bike or a real /home/pi.

const CAPTURE_SCRIPT = new URL("./can-capture/capture.sh", import.meta.url);
const script = await readFile(CAPTURE_SCRIPT, "utf8");
const failures: string[] = [];

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
// Parsed and compared as a NUMBER: `"-C 655360".includes("-C 65536")` is true, so the
// substring test this replaces accepted a ten-times-larger chunk.
const invokedChunk = /(?:^|\s)-C (\d+)(?:\s|$)/.exec(healthy.splitArgv ?? "");
if (!invokedChunk || Number(invokedChunk[1]) !== 65536) {
  failures.push(
    `split was invoked with chunk ${invokedChunk?.[1] ?? "none"}, expected exactly 65536 (argv: ${healthy.splitArgv})`
  );
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
for (const tool of ["gzip", "candump", "mktemp", "cat"]) {
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

// ⚠️ The ORDER of the two lines that create files, which no static assertion can see and
// which the guard above cannot test: `command -v mktemp` passes here and mktemp then fails
// when called. With `STATUS_FILE=$(mktemp)` before `: > "$OUTPUT"` that leaves nothing
// behind; swap them and every restart leaves a 0-byte .log.gz in the directory the archive
// is swept from — ~17 000 a day at RestartSec=5. A mutation run found this gap unguarded.
const brokenMktemp = await runCaptureScriptWithStubs(scriptPath, { mktempFails: true });
if (brokenMktemp.exitCode === 0) {
  failures.push("capture.sh exited 0 when mktemp failed, so candump's status had nowhere to go");
}
if (brokenMktemp.captureFiles.length !== 0) {
  failures.push(
    `a failing mktemp left ${brokenMktemp.captureFiles.join(", ")} behind — the status file must be claimed ` +
      `BEFORE \`: > "$OUTPUT"\`, or every restart leaves an empty capture`
  );
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "\n✓ capture.sh writes one readable .log.gz through 64 kB members with candump's stderr folded in; the disk " +
    "floor refuses below 10 GiB, passes exactly on it and fails CLOSED on an unreadable df; candump's exit code " +
    "reaches systemd unchanged without pipefail; and a missing binary leaves no file behind"
);
