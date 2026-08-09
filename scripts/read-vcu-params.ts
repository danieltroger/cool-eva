import { execFile } from "child_process";
import { mkdir, open, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { createVcuKwpClient } from "../src/vcu/kwp-client.ts";
import {
  PARAMETER_TABLE,
  ambiguousParameterNames,
  parameterAtIndex,
  parametersNamed,
  type VcuMicro,
  type VcuParameter,
} from "../src/vcu/param-table.ts";
import {
  describeChange,
  describeRow,
  diffSnapshots,
  toParameterRow,
  type VcuParameterRow,
  type VcuParameterSnapshot,
} from "../src/vcu/snapshot.ts";

// Reads the VCU's calibration parameters off the bike, by name. ON DEMAND — this is
// a script you run, not something the thermometer service does. See §Why not in the
// service, below.
//
//   # everything, both micros (~277 reads, well under a minute)
//   node --experimental-strip-types scripts/read-vcu-params.ts
//
//   # just the ones you came for
//   node --experimental-strip-types scripts/read-vcu-params.ts MAX_DC_CHG_CURRENT FCHG_CURRENT_GAIN
//
//   # an identifier the name table does not describe — reads back as raw bytes.
//   # The table covers 1…277 with no gaps, so an undescribed index means 278 and up.
//   node --experimental-strip-types scripts/read-vcu-params.ts --index 278
//
// ⚠️ RUN IT DETACHED. The link to the bike drops — that is the normal case, not the
// exception, and on 2026-08-08 it cost a whole result set mid-read
// (obd-garage/DIAG_ADDRESSES.md §6). ssh dying takes an attached process with it:
//
//   ssh pi@cool-eva.local 'cd thermometer && nohup setsid node --experimental-strip-types \
//     scripts/read-vcu-params.ts > /tmp/vcu-params.log 2>&1 & echo started'
//   ssh pi@cool-eva.local 'tail -f /tmp/vcu-params.log'   # reconnect as often as you like
//
// Even attached and killed, nothing read is lost: every row is appended to
// `<out>/sweep.partial.jsonl` the moment it arrives, and re-running the same command
// RESUMES from that file instead of starting over. Which is the other half of the
// answer to a flaky link — you do not need one connection to last the whole sweep.
//
// ── ⚠️ Read-only ─────────────────────────────────────────────────────────────
// Every byte this puts on the bus comes from src/vcu/param-codec.ts, which cannot
// express a write; the services it must never gain are listed in that file's
// header. This script also never touches `bringUpCan`, so it cannot reconfigure
// can0 and cannot knock the running thermometer service off the bus — it shares
// the interface as it finds it. (The two do not confuse each other: our replies
// arrive on 0x7E0 with 0xF1 in byte 0, and the service's OBD handler rejects
// anything whose first nibble is not 0x0.)
//
// ── Why this is not in the always-on service ─────────────────────────────────
// Because it would be paying, forever, for an answer that changes about once a
// year. In detail, in descending order of how much each mattered:
//
//  1. **Bus contention, measured.** src/can/obd-dtc.ts records that a mode-03
//     transfer on this bike succeeds somewhere between 25 % and 70 % of the time,
//     and that a transfer which completed had ZERO mode-01 replies interleaved
//     while a failed one had 50+. The bus is already the scarce resource. A
//     277-request burst is the last thing to add to service startup, which is
//     exactly when the OBD poller, the BLE link and the DTC reads are all coming up.
//  2. **A restart is routine.** Deploy is `git pull` + `systemctl restart`
//     (CLAUDE.md), so "once at startup" means "every time anyone touches the Pi".
//  3. **Nothing downstream wants it live.** These cannot be signals — 277 keys in
//     `liveState`, which src/ws.ts re-broadcasts whole every five seconds, for
//     values that do not move. src/diagnostics/stored-codes.ts already refused that
//     trade for 39 trouble codes.
//
// What is genuinely worth knowing is that a parameter CHANGED, and that is a diff
// between two snapshots rather than a sample rate: every run of this script
// compares against the last one and says so loudly. The snapshot it leaves behind
// is what GET /vcu-params serves, so the result is still on the phone in the
// garage without an ssh session — the service exposes it, it just never asks for it.

const execFileAsync = promisify(execFile);

const DEFAULT_OUTPUT_DIRECTORY = "vcu-params";
const PARTIAL_FILE = "sweep.partial.jsonl";
const LATEST_FILE = "latest.json";

interface Options {
  iface: string;
  outputDirectory: string;
  baselinePath: string | null;
  micros: VcuMicro[];
  fresh: boolean;
  paceMs: number | undefined;
  timeoutMs: number | undefined;
  /** Explicit indices from `--index`, plus anything resolved from names. Empty ⇒ sweep everything. */
  requested: number[];
}

const USAGE = `Usage: node --experimental-strip-types scripts/read-vcu-params.ts [options] [NAME…]

  NAME…            parameter names from src/vcu/param-table.ts. None ⇒ read all ${PARAMETER_TABLE.length}.
  --index N        read identifier 0x1000|N even if the name table does not describe it (repeatable)
  --micro A8|A9    only this micro (default: both)
  --iface IFACE    CAN interface, already up (default: can0). This never configures it.
  --out DIR        where snapshots and the resume file go (default: ${DEFAULT_OUTPUT_DIRECTORY})
  --baseline PATH  snapshot to diff against (default: <out>/${LATEST_FILE})
  --fresh          discard a half-finished sweep instead of resuming it
  --pace MS        gap between requests (default: 10)
  --timeout MS     reply window (default: 300)

Names that describe two indices each: ${ambiguousParameterNames().join(", ")}`;

const options = parseArguments(process.argv.slice(2));
const targets = resolveTargets(options);
if (targets.length === 0) {
  console.error("nothing to read — every requested parameter was filtered out by --micro");
  process.exit(1);
}

await mkdir(options.outputDirectory, { recursive: true });
const partialPath = join(options.outputDirectory, PARTIAL_FILE);
const rows = options.fresh ? new Map<number, VcuParameterRow>() : await loadPartial(partialPath);
if (options.fresh) {
  await rm(partialPath, { force: true });
}
if (rows.size > 0) {
  console.log(`resuming: ${rows.size} row(s) already in ${partialPath} — re-run with --fresh to start over`);
}
// A row that is present but did NOT come back as a value is retried rather than
// kept: on a link this unreliable most failures are transient, and the alternative
// is a resume that carries yesterday's timeout forward forever. A successful read
// is never re-asked, which is what makes resuming cheap.
const remaining = targets.filter(target => rows.get(target.index)?.status !== "read");
console.log(`reading ${remaining.length} parameter(s) on ${options.iface} (${targets.length} requested)`);

await warnIfListenOnly(options.iface);

// Imported here rather than at the top so that --help, an unknown parameter name and
// every other argument error still work on a laptop. `socketcan` is an
// optionalDependency with a Linux-only native build, so a static import makes the
// whole file unloadable on macOS — including the part whose job is to tell you what
// the parameters are called.
const channel = (await openCanChannel()).createRawChannel(options.iface, true);
const client = createVcuKwpClient(channel, { paceMs: options.paceMs, responseTimeoutMs: options.timeoutMs });
channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));
channel.start();

// Appended to on every row. Opened once and held: 277 open/close pairs on an SD
// card is a lot of syscalls for no benefit, and the handle is closed on every exit
// path below including the signal handler.
const partial = await open(partialPath, "a");

let interrupted = false;
const onSignal = (signal: string): void => {
  // Not an error — this is the documented way to stop a sweep, and everything read
  // so far is already on disk. The flag stops the loop; the read in progress is
  // then DISCARDED rather than filed, because `client.stop()` settles it as
  // "no response" and writing that down would record our own Ctrl-C as the bike
  // refusing to answer, which the next resume would then believe.
  console.log(`\n${signal} — stopping; ${rows.size} row(s) already saved to ${partialPath}`);
  interrupted = true;
  client.stop();
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGHUP", () => onSignal("SIGHUP"));

for (const micro of options.micros) {
  // Same interrupted check the read loop below has: a Ctrl-C between the two pings must
  // not go on to open a session on the other micro. The client now refuses to transmit
  // after stop() too, but breaking here also stops the misleading "NOT responding" line.
  if (interrupted) {
    break;
  }
  const reachable = await client.ping(micro);
  console.log(reachable ? `${micro}: session open, responding` : `${micro}: NOT responding to 10 81 + 3E`);
}

for (const target of remaining) {
  if (interrupted) {
    break;
  }
  const outcome = await client.readParameter(target.micro, target.index);
  if (interrupted) {
    break;
  }
  const row = toParameterRow(outcome);
  rows.set(row.index, row);
  // Written before it is printed, so a kill between the two loses the log line and
  // not the datum. No fsync per row on purpose: 277 of them onto a Pi Zero's SD
  // card buys protection against a power cut, which is not the failure this script
  // is built for — a dropped link or a killed process leaves the page cache, and
  // therefore the file, intact.
  await partial.write(`${JSON.stringify({ at: Date.now(), ...row })}\n`);
  console.log(describeRow(row));
}

await partial.close();
client.stop();
try {
  channel.stop();
} catch (err) {
  console.log("can: channel stop failed:", err);
}

// "Complete" means every parameter was ASKED ABOUT, not that every one answered. A
// slot that refuses or stays silent is a finding in its own right and must not make
// a finished sweep look truncated for ever — that distinction is the same one
// src/diagnostics/stored-codes.ts draws between "no codes" and "no answer".
const completed = !interrupted && targets.every(target => rows.has(target.index));
await report({
  readAt: Date.now(),
  complete: completed,
  micros: options.micros,
  rows: [...rows.values()].sort((left, right) => left.index - right.index),
});
process.exit(0);

/**
 * Writes the snapshot out and says what changed since the last one.
 *
 * A PARTIAL snapshot is still written — labelled `complete: false`, never
 * discarded. Half the parameters read off a real bike is half a set of facts; the
 * flag is there so that nothing downstream mistakes "we stopped early" for "these
 * are all of them". The partial JSONL is kept too, so the next run resumes.
 */
async function report(snapshot: VcuParameterSnapshot): Promise<void> {
  const baseline = await loadBaseline(options);
  const latestPath = join(options.outputDirectory, LATEST_FILE);
  const archivePath = join(
    options.outputDirectory,
    `${new Date(snapshot.readAt).toISOString().replace(/:/g, "-")}.json`
  );
  const serialised = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(archivePath, serialised, "utf-8");

  // `latest.json` is the diff baseline AND what GET /vcu-params serves, so it is only
  // replaced by a snapshot that actually read something. A run where the bike was
  // asleep (every read `no-session`), or that was stopped before the first reply, is a
  // fact about the run — the timestamped archive above records it — and must not clobber
  // a file full of real values with one full of failures. Otherwise the next run diffs
  // against that and reports 277 status changes, burying any genuine value-changed. The
  // rest of this script is careful about exactly this "read nothing" vs "read and it
  // changed" distinction; latest.json was the one place it was not.
  const read = snapshot.rows.filter(row => row.status === "read").length;
  if (read > 0) {
    await writeFile(latestPath, serialised, "utf-8");
  }

  console.log(
    `\n${read}/${snapshot.rows.length} read${snapshot.complete ? "" : "  ⚠️ INCOMPLETE — re-run to resume"}` +
      (read > 0
        ? `\nwrote ${archivePath} and ${latestPath}`
        : `\nwrote ${archivePath}; left ${latestPath} as it was — nothing was read, so the baseline stands`)
  );
  if (snapshot.complete) {
    // Only once the sweep finished: deleting the resume file after a partial run is
    // exactly the "losing what we got" this script exists to avoid.
    await rm(partialPath, { force: true });
  }

  if (!baseline) {
    console.log("no previous snapshot to compare against — this one becomes the baseline");
    return;
  }
  const changes = diffSnapshots(baseline.snapshot, snapshot);
  const valueChanges = changes.filter(change => change.kind === "value-changed");
  console.log(`\ncompared against ${baseline.path} (${new Date(baseline.snapshot.readAt).toISOString()}):`);
  if (changes.length === 0) {
    console.log("  no differences at all");
    return;
  }
  for (const change of changes) {
    console.log(`  ${describeChange(change)}`);
  }
  if (valueChanges.length > 0) {
    // Loud on purpose. A calibration parameter moving means something wrote to the
    // VCU's EEPROM between the two reads, which on a bike nobody has been servicing
    // is the single most interesting thing this script can tell you.
    console.log(`\n⚠️  ${valueChanges.length} PARAMETER VALUE(S) CHANGED — something reconfigured the bike.`);
  }
}

/** Which parameters to read: grouped by micro in the order --micro gave, ascending within each. */
function resolveTargets(options: Options): VcuParameter[] {
  const wanted =
    options.requested.length > 0
      ? options.requested.map(index => parameterAtIndex(index) ?? unnamedParameter(index, options.micros))
      : PARAMETER_TABLE;
  // Grouped, because A8 and A9 hold separate sessions: interleaving them would let
  // each one idle out while the other was being read, and pay for a re-open on
  // every single parameter.
  return wanted
    .filter(parameter => options.micros.includes(parameter.micro))
    .sort(
      (left, right) =>
        options.micros.indexOf(left.micro) - options.micros.indexOf(right.micro) || left.index - right.index
    );
}

/** Loads the Linux-only CAN binding, and says plainly where it is missing rather than throwing a resolver error. */
async function openCanChannel(): Promise<typeof import("socketcan")> {
  try {
    return (await import("socketcan")).default as unknown as typeof import("socketcan");
  } catch (err) {
    console.error(
      "socketcan is not available here — this script has to run on the Pi, where the native module is built.\n" +
        "On a laptop, scripts/check-vcu-params.ts exercises everything except the bus."
    );
    throw err;
  }
}

/**
 * A routing stand-in for an index the name table does not describe, so `--index 278`
 * still reads. Only `index` and `micro` are used — toParameterRow() looks the real
 * table up again, so an unnamed identifier comes out with a null name and type and
 * its raw bytes intact, rather than wearing the placeholders below.
 *
 * The micro follows the caller. Given an explicit `--micro` the stand-in is stamped
 * with it: an unnamed index has no table owner to contradict, and probing the other
 * micro is the entire point of `--index N --micro A8`. Only with both micros in play
 * (the default) is there nothing to go on — then it reads from the A9, where 233 of
 * the 277 live, and says so, `--micro A8` being the thing to try if that is silent.
 * That advice now works: it used to stamp A9 unconditionally, so `--micro A8` filtered
 * the stand-in straight back out and the run read nothing.
 */
function unnamedParameter(index: number, micros: VcuMicro[]): VcuParameter {
  const micro = micros.length === 1 ? micros[0] : "A9";
  if (micros.length > 1) {
    console.warn(
      `index ${index} is not in the name table — assuming it lives on the A9; use --micro A8 if it is silent`
    );
  }
  return {
    index,
    identifier: 0x1000 | index,
    name: `UNKNOWN_${index}`,
    type: "WORD",
    signed: false,
    micro,
    section: "(not in params.ecf)",
    otherBikeValue: 0,
  };
}

/** Reads back a partial sweep. A malformed line is reported and skipped, never silently dropped. */
async function loadPartial(path: string): Promise<Map<number, VcuParameterRow>> {
  const rows = new Map<number, VcuParameterRow>();
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    // Ordinary on a first run; anything other than "not there" is worth saying.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`could not read ${path} — starting fresh:`, err);
    }
    return rows;
  }
  for (const [lineNumber, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const row = JSON.parse(line) as VcuParameterRow;
      rows.set(row.index, row);
    } catch (err) {
      // The last line of a file whose process was killed mid-write. Everything
      // before it is intact, which is the whole point of a line-per-row format.
      console.warn(`${path}:${lineNumber + 1} is not valid JSON, skipping it:`, err);
    }
  }
  return rows;
}

async function loadBaseline(options: Options): Promise<{ path: string; snapshot: VcuParameterSnapshot } | null> {
  const path = options.baselinePath ?? join(options.outputDirectory, LATEST_FILE);
  try {
    return { path, snapshot: JSON.parse(await readFile(path, "utf-8")) as VcuParameterSnapshot };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`could not read the baseline ${path}:`, err);
    }
    return null;
  }
}

/**
 * A listen-only bus swallows every request silently, and the result looks exactly
 * like a bike that is switched off. Worth one `ip` call to tell the two apart —
 * it reads the interface, it never configures it.
 */
async function warnIfListenOnly(iface: string): Promise<void> {
  try {
    // execFile, not exec: no `/bin/sh -c`, so the interface name is an argv entry
    // rather than a fragment of a shell command. `--iface 'can0; rm -rf …'` reaches
    // `ip` as one (nonexistent) interface name and fails as a plain exit code, not
    // as a shell running whatever followed the semicolon.
    const { stdout } = await execFileAsync("ip", ["-details", "link", "show", iface]);
    if (/listen-only\s+on|\blisten-only\b(?!\s+off)/.test(stdout)) {
      console.warn(
        `⚠️  ${iface} is in LISTEN-ONLY mode: nothing can be transmitted and every read will time out.\n` +
          `   The thermometer service brings it up ACTIVE unless OBD_ENABLED=0.`
      );
    }
  } catch (err) {
    console.log(`could not inspect ${iface} (continuing anyway):`, err);
  }
}

function parseArguments(argv: string[]): Options {
  const options: Options = {
    iface: "can0",
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    baselinePath: null,
    micros: ["A9", "A8"],
    fresh: false,
    paceMs: undefined,
    timeoutMs: undefined,
    requested: [],
  };
  const names: string[] = [];
  for (let position = 0; position < argv.length; position++) {
    const argument = argv[position];
    switch (argument) {
      case "--iface":
        options.iface = requireValue(argv, ++position, argument);
        break;
      case "--out":
        options.outputDirectory = requireValue(argv, ++position, argument);
        break;
      case "--baseline":
        options.baselinePath = requireValue(argv, ++position, argument);
        break;
      case "--micro": {
        const micro = requireValue(argv, ++position, argument).toUpperCase();
        if (micro !== "A8" && micro !== "A9") {
          fail(`--micro takes A8 or A9, not ${micro}`);
        }
        options.micros = [micro];
        break;
      }
      case "--index":
        options.requested.push(requireIndex(argv, ++position, argument));
        break;
      case "--pace":
        options.paceMs = requireNumber(argv, ++position, argument);
        break;
      case "--timeout":
        options.timeoutMs = requireNumber(argv, ++position, argument);
        break;
      case "--fresh":
        options.fresh = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        if (argument.startsWith("-")) {
          fail(`unknown option ${argument}\n\n${USAGE}`);
        }
        names.push(argument);
    }
  }
  options.requested.push(...names.flatMap(resolveName));
  return options;
}

/**
 * Name → index. Returns EVERY match, because four names in params.ecf describe two
 * indices each (see src/vcu/param-table.ts) — answering "the parameter called
 * VSM_DUMMY_WORD10" with one of the two would be inventing which one was meant.
 */
function resolveName(name: string): number[] {
  const matches = parametersNamed(name);
  if (matches.length === 0) {
    fail(
      `no parameter is called ${name}.\n` +
        `Names come from src/vcu/param-table.ts; grep it, or use --index for an identifier it does not describe.`
    );
  }
  if (matches.length > 1) {
    console.warn(
      `⚠️  ${name} describes ${matches.length} parameters (indices ${matches.map(match => match.index).join(", ")}) — reading all of them`
    );
  }
  return matches.map(match => match.index);
}

function requireValue(argv: string[], position: number, flag: string): string {
  const value = argv[position];
  if (value === undefined || value.startsWith("-")) {
    fail(`${flag} needs a value`);
  }
  return value;
}

function requireNumber(argv: string[], position: number, flag: string): number {
  const value = Number(requireValue(argv, position, flag));
  if (!Number.isFinite(value)) {
    fail(`${flag} needs a number`);
  }
  return value;
}

/**
 * `--index` names a bank-1 identifier, so it must be a whole number param-codec.ts
 * will accept. Checked HERE, at parse time, rather than being let through to blow up
 * inside identifierForIndex() once can0 is open and the partial file handle is held:
 * `--index 3.5` and `--index 9999` used to survive resolveTargets() (unnamedParameter
 * built a stand-in for them) and only throw mid-sweep, as an unhandled rejection with
 * no snapshot written. Every other bad argument in this file fails cleanly through
 * fail() before the bus is touched; this one now does too.
 */
function requireIndex(argv: string[], position: number, flag: string): number {
  const index = requireNumber(argv, position, flag);
  if (!Number.isInteger(index) || index < 1 || index > 0x0fff) {
    fail(`${flag} takes a whole parameter index between 1 and ${0x0fff}, not ${index}`);
  }
  return index;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
