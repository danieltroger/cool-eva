import { spawn, type ChildProcess } from "child_process";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { PARAMETER_TABLE, type VcuMicro } from "./param-table.ts";
import type { VcuParameterRow, VcuParameterSnapshot } from "./snapshot.ts";

// Service mode's engine: start a parameter sweep on demand, watch it, stop it.
//
// ── ⚠️ This does NOT put anything on the bus, and that is deliberate ─────────
// It spawns `scripts/read-vcu-params.ts` — the same command CLAUDE.md and that
// script's own header tell you to run over ssh — and watches the files it leaves
// behind. The cool-eva process still opens no CAN socket for VCU parameters, still
// builds no KWP frame and still contains no code path from an HTTP request to
// `channel.send`. The read-only argument therefore does not move an inch: every
// byte that reaches the micros is built by src/vcu/param-codec.ts, whose request
// union has three members and no writes in it.
//
// What DOES change is who decides when to spend the bus time. The standing rule in
// read-vcu-params.ts is "not at startup, not on a timer, not per page load",
// because a ~277-request burst competes with the OBD poller, the BLE link and the
// DTC reads for a bus that src/can/obd-dtc.ts measured as the scarce resource. A
// button is none of those things: it is the owner, parked, deciding once. Service
// mode is exactly the case that rule was carving out, not an exception to it.
//
// ── Why shell out instead of importing the sweep ─────────────────────────────
// 1. The script is the tested path. It resumes from `sweep.partial.jsonl`, keeps a
//    partial snapshot rather than discarding it, refuses to clobber a good
//    `latest.json` with a run that read nothing, and stops cleanly on a signal.
//    Re-implementing that in-process would mean a second copy of all four rules.
// 2. `socketcan` is a Linux-only optionalDependency. The script imports it lazily
//    so that the rest of it still runs on a laptop; importing the sweep into the
//    always-on service would drag that decision into this file for no gain.
// 3. A child process can be killed. An in-process sweep holding a 300 ms reply
//    window 277 times cannot be taken back once started, and "cancel" is the one
//    control this feature genuinely needs (the link to the bike drops — that is
//    the normal case, not the exception).
//
// ── Where progress comes from ────────────────────────────────────────────────
// Not from parsing the child's stdout, which is prose meant for a human and would
// break the first time a log line is reworded. The script appends one JSON row to
// `<out>/sweep.partial.jsonl` the moment each parameter arrives, so that file IS
// the progress feed, already in the shape the dashboard wants. It is read when the
// page asks rather than on a timer of our own — there is no polling loop here.
//
// The catch is the end of a sweep: on a COMPLETE run the script deletes the
// partial file and writes `latest.json` (and even that only if something was
// read). So the final numbers come from the timestamped archive the script writes
// on every run, complete or not, read-something or not — the one artefact that is
// always there. That is what keeps "the bike was asleep, 277 no-session" legible
// as its own result instead of silently showing the previous good snapshot.

/** How the last (or current) sweep is going. A closed union so the page cannot render a state we did not mean. */
export type VcuReadState =
  /** Nothing has been started since this process came up. Says nothing about whether a snapshot exists. */
  | { phase: "idle" }
  | { phase: "running"; startedAt: number; expected: number; tally: VcuReadTally }
  /**
   * The sweep ran to the end of its list. `complete` is the script's own flag —
   * every parameter was ASKED ABOUT, which is not the same as every one answering,
   * and `tally` is where that difference shows.
   */
  | { phase: "finished"; startedAt: number; finishedAt: number; complete: boolean; tally: VcuReadTally }
  /**
   * Stopped early, or never got going. Kept apart from `finished` with an empty
   * tally because "we could not start" and "the bike answered nothing" are
   * different claims, and only the second one is about the motorcycle.
   */
  | { phase: "failed"; startedAt: number; finishedAt: number; reason: string; tally: VcuReadTally };

/** Rows on record for a sweep, counted the two ways that make a failure legible. */
export interface VcuReadTally {
  /** Rows written down so far, including any carried over from a resumed sweep. */
  total: number;
  /** …of which answered with a record. The number a human actually wants. */
  read: number;
  /** Every outcome by name, so "44 refused" and "44 no-session" do not look alike. */
  byStatus: Record<VcuParameterRow["status"], number>;
  /** Per micro, because "the A8 was asleep" must not read as "the bike lost 44 parameters". */
  micros: { micro: VcuMicro; read: number; failed: number }[];
}

export interface VcuReadRunner {
  /** Starts a sweep. Resolves with why not, rather than throwing, when one is already running. */
  start: () => { started: boolean; reason: string | null };
  /** Asks a running sweep to stop. The script's SIGTERM handler keeps what it has. Returns false if none is running. */
  cancel: () => boolean;
  /** Reads the current state off disk. Cheap enough to call per page poll; no timers, no cached staleness. */
  state: () => Promise<VcuReadState>;
  /** Kills any running sweep, for shutdown. */
  stop: () => void;
}

export interface VcuReadRunnerOptions {
  /** Repo root — the child's working directory, so its relative paths mean what they mean over ssh. */
  root: string;
  /** Where snapshots and the resume file live. Passed to the script as `--out` so the two cannot disagree. */
  outputDirectory: string;
}

const SCRIPT_PATH = "scripts/read-vcu-params.ts";
const PARTIAL_FILE = "sweep.partial.jsonl";
const LATEST_FILE = "latest.json";

/**
 * How many stderr characters to keep for the failure message.
 *
 * The FIRST ones, not the last. Verified 2026-08-15 by running this against the
 * real script on a laptop: the script prints its own explanation ("socketcan is
 * not available here — this script has to run on the Pi…") and only then does Node
 * dump the stack trace and its version banner. Keeping the tail put `}` and
 * `Node.js v24.15.0` on the dashboard and threw the sentence that says what to do
 * away, which is the exact opposite of a legible failure.
 */
const STDERR_KEEP = 2000;

/**
 * How many lines of that to show. Three is enough for the script's own multi-line
 * messages and short enough to fit the sheet on a phone.
 */
const STDERR_LINES = 3;

/** Every status a row can carry, so a tally always has all the keys and the page never sees `undefined`. */
const ROW_STATUSES: VcuParameterRow["status"][] = [
  "read",
  "refused",
  "no-response",
  "no-session",
  "multi-frame",
  "unrecognised",
  "not-sent",
];

interface RunnerContext extends VcuReadRunnerOptions {
  child: ChildProcess | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Null while running, or once a run ended cleanly. Set for a non-zero exit, a spawn error or a cancel. */
  failure: string | null;
  stderr: string;
  cancelled: boolean;
  /**
   * The archives that already existed when this run started, so the one it writes
   * can be told from its predecessors without consulting a clock. Null before the
   * first start.
   */
  archivesAtStart: Promise<Set<string>> | null;
}

export function createVcuReadRunner(options: VcuReadRunnerOptions): VcuReadRunner {
  const context: RunnerContext = {
    ...options,
    child: null,
    startedAt: null,
    finishedAt: null,
    failure: null,
    stderr: "",
    cancelled: false,
    archivesAtStart: null,
  };
  return {
    start: () => start(context),
    cancel: () => cancel(context),
    state: () => readState(context),
    stop: () => stop(context),
  };
}

/**
 * Single-flight WITHIN this process. Two sweeps at once would fight over the bus,
 * over `sweep.partial.jsonl` and over the one reply id every micro answers on.
 *
 * It cannot see a sweep the owner started by hand over ssh — nothing here takes a
 * lock, and adding one would be a lockfile to go stale on a Pi that loses power.
 * The consequence is honest rather than hidden: two overlapping sweeps produce
 * timeouts and a noisy log, not wrong values, because every reply carries the
 * identifier it answers and param-codec.ts refuses one that does not match.
 */
function start(context: RunnerContext): { started: boolean; reason: string | null } {
  if (context.child) {
    return { started: false, reason: "a parameter read is already running" };
  }
  // Kicked off BEFORE the spawn and deliberately not awaited: start() stays
  // synchronous so the HTTP handler answers immediately, and the listing only has
  // to win a race against a child that has not been forked yet.
  context.archivesAtStart = listArchives(context.outputDirectory);

  const child = spawn(
    process.execPath,
    // The invocation CLAUDE.md documents, kept identical so there is one way to run
    // this and one thing to get wrong. Type stripping is on by default in Node 24,
    // so the flag is redundant today and harmless; it is what the README, the
    // systemd unit and the script's own header all say.
    [
      "--experimental-strip-types",
      join(context.root, SCRIPT_PATH),
      "--out",
      context.outputDirectory,
      // No `--fresh`: a sweep that was cut short last time resumes, which on a link
      // that drops mid-read is the whole reason the resume file exists.
    ],
    { cwd: context.root, stdio: ["ignore", "pipe", "pipe"] }
  );

  context.child = child;
  context.startedAt = Date.now();
  context.finishedAt = null;
  context.failure = null;
  context.stderr = "";
  context.cancelled = false;

  // Piped rather than inherited so a sweep's 277 log lines do not interleave with
  // the service's own journal, and so the tail is available to put on screen.
  child.stdout?.on("data", chunk => console.log(`vcu-read: ${String(chunk).trimEnd()}`));
  child.stderr?.on("data", chunk => {
    // Kept from the front and then capped, so a long crash dump cannot push the
    // script's own explanation out of the buffer. The whole thing still reaches
    // the journal below either way.
    if (context.stderr.length < STDERR_KEEP) {
      context.stderr = `${context.stderr}${String(chunk)}`.slice(0, STDERR_KEEP);
    }
    console.warn(`vcu-read: ${String(chunk).trimEnd()}`);
  });
  child.on("error", error => {
    // Never swallowed: this is "we could not even start node", which looks
    // identical to a silent bike on screen unless it is said out loud.
    console.error("vcu-read: could not start the sweep:", error);
    context.failure = error instanceof Error ? error.message : String(error);
    context.child = null;
    context.finishedAt = Date.now();
  });
  child.on("exit", (code, signal) => {
    context.child = null;
    context.finishedAt = Date.now();
    context.failure = describeExit(context, code, signal);
    console.log(`vcu-read: sweep ended (${context.failure ?? "clean"})`);
  });

  console.log(`vcu-read: started ${SCRIPT_PATH} → ${context.outputDirectory}`);
  return { started: true, reason: null };
}

function cancel(context: RunnerContext): boolean {
  if (!context.child) {
    return false;
  }
  // SIGTERM, not SIGKILL: the script handles it, stops the loop, closes the partial
  // file and writes the archive. SIGKILL would lose the archive and with it the
  // "which micro answered" breakdown for everything read so far.
  context.cancelled = true;
  context.child.kill("SIGTERM");
  console.log("vcu-read: cancel requested");
  return true;
}

function stop(context: RunnerContext): void {
  if (context.child) {
    context.child.kill("SIGTERM");
  }
}

/** Null when the run ended the way it was supposed to; a sentence otherwise. */
function describeExit(context: RunnerContext, code: number | null, signal: string | null): string | null {
  if (context.cancelled) {
    return "stopped from the dashboard — everything read so far was kept";
  }
  if (signal) {
    return `the sweep was killed by ${signal}`;
  }
  if (code !== 0) {
    const explanation = summariseStderr(context.stderr);
    return `the sweep exited with code ${code}${explanation ? ` — ${explanation}` : ""}`;
  }
  return null;
}

/**
 * The readable part of a crashed child's stderr.
 *
 * A Node crash is mostly frames and a version banner wrapped around one sentence
 * that says what went wrong. Those are dropped so the sentence survives — the
 * whole of stderr is in the journal for anyone who wants the trace, and what
 * reaches the phone should be the bit that tells the owner what to do about it.
 */
function summariseStderr(stderr: string): string {
  const meaningful = stderr
    .split("\n")
    .map(line => line.trim())
    .filter(
      line =>
        line.length > 0 &&
        !line.startsWith("at ") &&
        !line.startsWith("Node.js v") &&
        // `}`, `^`, `        ^^^` and friends: the punctuation V8 draws its error
        // pointers with, which carries no information away from its own context.
        /[a-z0-9]/i.test(line)
    );
  return meaningful.slice(0, STDERR_LINES).join(" · ");
}

async function readState(context: RunnerContext): Promise<VcuReadState> {
  if (context.child && context.startedAt !== null) {
    return {
      phase: "running",
      startedAt: context.startedAt,
      // What a full sweep will ask about. The script takes no filters from here, so
      // this is the whole table rather than a number that could drift from it.
      expected: PARAMETER_TABLE.length,
      tally: tallyOf(await readPartialRows(context.outputDirectory)),
    };
  }
  if (context.startedAt === null || context.finishedAt === null) {
    // Either nothing has run, or a start is somehow half-recorded. Both mean there
    // is no run of ours to describe; the snapshot on disk is still served by
    // /vcu-params either way.
    return { phase: "idle" };
  }
  const snapshot = await loadRunArchive(context.outputDirectory, context.archivesAtStart);
  const tally = tallyOf(snapshot?.rows ?? (await readPartialRows(context.outputDirectory)));
  if (context.failure) {
    return {
      phase: "failed",
      startedAt: context.startedAt,
      finishedAt: context.finishedAt,
      reason: context.failure,
      tally,
    };
  }
  return {
    phase: "finished",
    startedAt: context.startedAt,
    finishedAt: context.finishedAt,
    // Absent an archive we cannot claim the sweep covered everything. Saying "not
    // complete" about a complete run costs a re-run; the other way round hides a
    // truncated one, which is the mistake that matters.
    complete: snapshot?.complete ?? false,
    tally,
  };
}

/** Counts rows the two ways the page needs them. Pure. */
export function tallyOf(rows: VcuParameterRow[]): VcuReadTally {
  const byStatus = Object.fromEntries(ROW_STATUSES.map(status => [status, 0])) as VcuReadTally["byStatus"];
  const perMicro = new Map<VcuMicro, { micro: VcuMicro; read: number; failed: number }>();
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const entry = perMicro.get(row.micro) ?? { micro: row.micro, read: 0, failed: 0 };
    if (row.status === "read") {
      entry.read += 1;
    } else {
      entry.failed += 1;
    }
    perMicro.set(row.micro, entry);
  }
  return {
    total: rows.length,
    read: byStatus["read"],
    byStatus,
    micros: [...perMicro.values()].sort((left, right) => left.micro.localeCompare(right.micro)),
  };
}

/**
 * The rows a sweep has written down so far.
 *
 * A resumed sweep's file also holds rows from the run before it. They are counted,
 * because they are part of the result this run will produce — the script does not
 * re-ask a parameter that already answered.
 */
async function readPartialRows(directory: string): Promise<VcuParameterRow[]> {
  let text: string;
  try {
    text = await readFile(join(directory, PARTIAL_FILE), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Not fatal — progress is a nicety and the archive is the real record — but a
      // permissions problem here would otherwise show as a sweep reading nothing.
      console.warn(`vcu-read: could not read the progress file in ${directory}:`, err);
    }
    return [];
  }
  const rows: VcuParameterRow[] = [];
  const lines = text.split("\n");
  for (const [position, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      rows.push(JSON.parse(line) as VcuParameterRow);
    } catch (err) {
      // Only the LAST line can be a torn append — a file being written to as we
      // read it. That one is expected, common, and not worth a log line every time
      // the page polls: the row arrives whole on the next read a moment later.
      //
      // A bad line anywhere else is a damaged file (an interrupted write, a bad
      // block on the SD card) and would otherwise just quietly lower the count,
      // which is the silent-failure shape CLAUDE.md forbids. The script's own
      // reader draws the same line — see loadPartial() in
      // scripts/read-vcu-params.ts.
      if (position !== lines.length - 1) {
        console.warn(`vcu-read: ${PARTIAL_FILE} line ${position + 1} is not valid JSON, skipping it:`, err);
      }
      continue;
    }
  }
  return rows;
}

/**
 * The snapshot this run left behind.
 *
 * Every run writes a timestamped archive, complete or not, whether or not anything
 * was read — unlike `latest.json`, which the script deliberately leaves alone when
 * a run read nothing so a good baseline is not clobbered by a bike that was
 * asleep. That is exactly the distinction service mode has to keep, so the archive
 * is what is read here and `latest.json` is never consulted.
 *
 * ⚠️ Which archive is OURS is decided by "it was not there when we started", not
 * by comparing its `readAt` against our `startedAt`. Both of those are `Date.now()`
 * on a Pi with no RTC that steps its own clock from GPS mid-run (src/gps/clock.ts),
 * so that comparison is exactly the cross-clock arithmetic ../monotonic.ts exists
 * to forbid: a backward step between our start and the script's finish would make a
 * PREVIOUS run's archive look like ours, and put its 277 reads on screen under a
 * sweep that managed none. Sorting the filenames has the same flaw, since they are
 * timestamps too. A set difference has no clock in it at all.
 *
 * The listing is taken at start and deliberately not awaited there, so a child that
 * wrote its archive within microseconds of spawning could be mistaken for a
 * pre-existing one. A sweep is ~277 reads over a 300 ms reply window; a readdir is
 * not, so this is theoretical rather than a race to design around.
 *
 * Returns null when nothing new appeared — the script died before writing one, or
 * never got far enough to run.
 */
async function loadRunArchive(
  directory: string,
  archivesAtStart: Promise<Set<string>> | null
): Promise<VcuParameterSnapshot | null> {
  if (!archivesAtStart) {
    return null;
  }
  const before = await archivesAtStart;
  const written = [...(await listArchives(directory))].filter(entry => !before.has(entry)).sort();
  // Sorted so a run that somehow produced two takes the later one. Only a
  // tie-break; it is not what decides whether an archive is ours.
  const ours = written.at(-1);
  if (!ours) {
    return null;
  }
  try {
    return JSON.parse(await readFile(join(directory, ours), "utf-8")) as VcuParameterSnapshot;
  } catch (err) {
    console.warn(`vcu-read: could not read the archive ${ours}:`, err);
    return null;
  }
}

/**
 * The snapshot archives in a directory. `latest.json` is excluded: it is a COPY of
 * whichever archive last read something, so counting it would make a run that read
 * nothing appear to have written two files.
 *
 * A directory that cannot be listed yields an empty set rather than throwing —
 * which then reads as "no new archive", i.e. an honest "we do not know how that run
 * ended" instead of a crash inside a progress poll.
 */
async function listArchives(directory: string): Promise<Set<string>> {
  try {
    const entries = await readdir(directory);
    return new Set(entries.filter(entry => entry.endsWith(".json") && entry !== LATEST_FILE));
  } catch (err) {
    console.warn(`vcu-read: could not list ${directory}:`, err);
    return new Set();
  }
}
