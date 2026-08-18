import type { RawChannel } from "socketcan";
import { createVcuKwpClient } from "./kwp-client.ts";
import {
  activeParameterTable,
  contentTwinsOf,
  describeTableType,
  parameterTable,
  type VcuMicro,
  type VcuParameter,
} from "./param-table.ts";
import {
  describeRow,
  reportTableType,
  toParameterRow,
  type VcuParameterRow,
  type VcuParameterSnapshot,
} from "./snapshot.ts";
import { loadPartialRows, openPartialSweepLog, writeSnapshot } from "./snapshot-store.ts";
import type { ServiceGateVerdict } from "./service-gate.ts";

// One parameter sweep, in the service's own process, on the service's own CAN
// socket. Started by hand from service mode and by nothing else.
//
// ── ⚠️ Why this is allowed to exist ──────────────────────────────────────────
// The standing rule this repo grew up with was that the always-on service never
// asks the micros anything: the sweep lived in a script you ran over ssh, and
// /vcu-read shelled out to it. The rule was never about the SERVICE being
// dangerous — it was about cost and about timing:
//
//  1. **Bus contention, measured.** src/can/obd-dtc.ts records a mode-03 transfer
//     on this bike succeeding somewhere between 25 % and 70 % of the time, with
//     zero mode-01 replies interleaved on the successful ones and 50+ on the
//     failures. The bus is the scarce resource, and a ~277-request burst is the
//     last thing to add to service startup, which is exactly when the OBD poller,
//     the BLE link and the DTC reads are all coming up.
//  2. **A restart is routine** (deploy is `git pull` + `systemctl restart`), so
//     "once at startup" means "every time anyone touches the Pi".
//  3. **Nothing downstream wants it live**: 277 keys in `liveState`, which
//     src/ws.ts re-broadcasts whole every five seconds, for values that do not move.
//
// None of those is an argument against a sweep the owner starts, once, standing
// next to a parked bike — which is what ./service-gate.ts now proves the situation
// to be before a single frame goes out. So the sweep moved in here and the script
// went away, because two copies of the four resume/partial/baseline rules in
// ./snapshot-store.ts was the real cost of keeping them apart.
//
// ── ⚠️ Still read-only, and still structurally ───────────────────────────────
// Every byte that reaches the bus is built by ./param-codec.ts, whose request union
// has three members — start session, tester present, read one parameter — and whose
// encoder throws on anything else on the way out. Moving the caller from a child
// process into this one changes nothing about that: there is no raw-bytes entry
// point here, no service byte derived from anything a caller supplied, and no HTTP
// parameter anywhere that names a service, an identifier or a value.
//
// ── ⚠️ It does not configure can0 and does not own the socket ────────────────
// The channel is the service's, already up and already started. Nothing here calls
// `bringUpCan` (which takes the interface DOWN and would kill every other raw-CAN
// socket on the Pi), and nothing here calls `channel.start()` or `channel.stop()`.
// Frames are handed in by the caller rather than subscribed to, so this module owns
// no listener to leak either.

/** What a sweep needs. Everything is supplied — no globals, no env, no clock of its own. */
export interface ParameterSweepOptions {
  /** The service's already-started channel. Never reconfigured, never stopped here. */
  channel: RawChannel;
  /** Where the resume file and the snapshots go. */
  directory: string;
  /**
   * Consulted before EVERY request, including the session opens. This is what makes
   * "auto-exit if the bike stops being safe" a property of the sweep rather than a
   * timer racing it: the check sits between the loop and the socket, so a sweep that
   * has been told to stop cannot emit one more frame on its way out.
   */
  checkGate: () => ServiceGateVerdict;
  /** Called once per row as it is written down, so a caller can show progress without reading the file back. */
  onRow?: (row: VcuParameterRow) => void;
}

export interface ParameterSweepResult {
  snapshot: VcuParameterSnapshot;
  /**
   * Null when the sweep asked about every parameter on its list. A sentence when it
   * stopped early — cancelled, or put out by the gate — already phrased for the page.
   */
  stoppedBecause: string | null;
}

/** A sweep in flight. */
export interface RunningParameterSweep {
  /**
   * Feed every CAN frame here; returns true when it was consumed. The service shares
   * one socket, so this is how a reply reaches the client without a second listener.
   */
  handleFrame: (id: number, data: Buffer) => boolean;
  /** Stops it. Everything read so far is kept and written. Safe to call more than once. */
  abort: (reason: string) => void;
  /** Rows on record right now, including any carried over from a resumed sweep. */
  rows: () => VcuParameterRow[];
  /** How many parameters a full sweep asks about, so a caller can show "n of N" from the first poll. */
  expected: number;
  finished: Promise<ParameterSweepResult>;
}

/** Both micros, A9 first: 233 of the 277 parameters live there, so the useful half arrives first. */
const MICROS: VcuMicro[] = ["A9", "A8"];

/**
 * Starts a sweep and hands back a handle to it.
 *
 * Synchronous on purpose: /vcu-read answers immediately and the page follows along
 * with GET, so `start` must not be waiting on a `readdir` before it can say yes.
 */
export function startParameterSweep(options: ParameterSweepOptions): RunningParameterSweep {
  const client = createVcuKwpClient(options.channel);
  const state: SweepState = { rows: new Map(), stoppedBecause: null, client };
  const finished = runSweep(options, state);
  return {
    handleFrame: (id, data) => client.handleFrame(id, data),
    abort: reason => abort(state, reason),
    rows: () => [...state.rows.values()],
    expected: parameterTable().length,
    finished,
  };
}

interface SweepState {
  rows: Map<number, VcuParameterRow>;
  /** Set once, by the first thing that stopped the sweep. Later reasons do not overwrite it. */
  stoppedBecause: string | null;
  client: ReturnType<typeof createVcuKwpClient>;
}

/**
 * Stops the sweep.
 *
 * `client.stop()` is what makes this immediate rather than advisory: it clears the
 * pending request, settles it as `not-sent` — our own doing, never recorded as the
 * bike refusing to answer — and refuses to transmit again, so `openSession` and
 * `ping` on a micro we had not reached yet cannot put anything on the bus either.
 *
 * ⚠️ There is deliberately NO "close the session" request on the way out. `0x20`
 * StopDiagnosticSession is not in ./param-codec.ts's union and must not be added
 * for this: the session the sweep opened expires by itself after ~2.5 s of silence
 * (obd-garage/DIAG_ADDRESSES.md §3, live 2026-08-08), so the clean exit from a
 * half-finished sweep is to stop talking, which is exactly what this does. Sending
 * one more frame to tidy up would be the one case where an abort put traffic on the
 * bus of a bike that had just started moving.
 */
function abort(state: SweepState, reason: string): void {
  if (state.stoppedBecause === null) {
    state.stoppedBecause = reason;
  }
  state.client.stop();
}

async function runSweep(options: ParameterSweepOptions, state: SweepState): Promise<ParameterSweepResult> {
  const targets = sweepTargets();
  // Rows a previous, interrupted sweep already got. Loaded before anything is
  // transmitted so the count on screen starts where the last one left off.
  for (const [index, row] of await loadPartialRows(options.directory)) {
    state.rows.set(index, row);
  }
  // A row that failed is retried; one that answered is never re-asked. That is what
  // makes resuming cheap and what stops a resume carrying yesterday's timeout
  // forward for ever.
  const remaining = targets.filter(target => state.rows.get(target.index)?.status !== "read");
  console.log(
    `vcu-sweep: reading ${remaining.length} parameter(s) (${state.rows.size} already on record from an earlier run)`
  );

  const partial = await openPartialSweepLog(options.directory);
  try {
    await pingMicros(options, state);
    for (const target of remaining) {
      if (!mayContinue(options, state)) {
        break;
      }
      const outcome = await state.client.readParameter(target.micro, target.index);
      if (state.stoppedBecause !== null) {
        // Aborted while this read was in flight. The outcome is DISCARDED rather
        // than filed: client.stop() settles it as `not-sent`, and writing that down
        // would record our own exit as the bike failing to answer — which the next
        // resume would then believe and retry as if the bike were at fault.
        break;
      }
      const row = toParameterRow(outcome);
      state.rows.set(row.index, row);
      // Written before it is logged, so a hard kill between the two loses the log
      // line and not the datum.
      await partial.append(row);
      options.onRow?.(row);
      console.log(`vcu-sweep: ${describeRow(row)}`);
    }
  } finally {
    // Every exit path closes the handle and stops the client, including a throw:
    // a sweep that died holding an open file and a live pending request would leak
    // both into a service that stays up for weeks.
    await partial.close().catch((err: unknown) => console.warn("vcu-sweep: could not close the resume file:", err));
    state.client.stop();
  }

  // "Complete" means every parameter was ASKED ABOUT, not that every one answered.
  // A slot that refuses or stays silent is a finding in its own right and must not
  // make a finished sweep look truncated for ever — the same distinction
  // src/diagnostics/stored-codes.ts draws between "no codes" and "no answer".
  //
  // ⚠️ `stoppedBecause` is CAPTURED here, on the same line as `complete`, and the
  // captured copy is what is returned. Re-reading `state.stoppedBecause` after the
  // `await` below would read it at a different moment: writing two JSON files and
  // diffing 277 rows takes a few hundred milliseconds on a Pi's SD card, the
  // watchdog is still armed for the first tick or two of that, and rolling the bike
  // the instant `277/277 read` scrolls past is the natural thing for an owner to
  // do. That would have returned `complete: true` in the snapshot and a gate exit
  // as the reason, and read-runner.ts checks the reason first — so a sweep that
  // asked about all 277 and deleted its own resume file would have rendered as
  // "Stopped: the bike stopped being safe to service". Same shape as the
  // wall-clock bug the first review found, and the same fix: read the fact once.
  const stoppedBecause = state.stoppedBecause;
  const complete = stoppedBecause === null && targets.every(target => state.rows.has(target.index));
  const snapshot: VcuParameterSnapshot = {
    readAt: Date.now(),
    complete,
    micros: MICROS,
    rows: [...state.rows.values()].sort((left, right) => left.index - right.index),
  };
  reportTableTypeToConsole(snapshot);
  await writeSnapshot(options.directory, snapshot);
  return { snapshot, stoppedBecause };
}

/**
 * Says whether the bike agrees it runs the parameter table these 277 names came from.
 *
 * Printed after the rows and before the archive is written, because it is the caption
 * for everything above it: 277 name/value pairs just scrolled past, and this is the
 * line that says whether the names on them were the bike's own.
 *
 * Every sweep, not once per process — unlike the `warnedThermalFrame*` flags in
 * ../can/pack-temperature.ts, which guard a warning that would otherwise fire on every
 * CAN frame. A sweep is a deliberate act an owner performs perhaps once a day, so
 * "once" is already what it means, and a run whose table type disagreed would be
 * exactly the run where a suppressed second copy is the one you needed.
 */
function reportTableTypeToConsole(snapshot: VcuParameterSnapshot): void {
  const report = reportTableType(snapshot);
  // Three levels, because there are three outcomes and journalctl grades on them:
  //   error — a micro named a table this software does not carry, the two micros named
  //           DIFFERENT tables, or a micro answered with a record the table's width
  //           forbids. Each one invalidates the NAME of some or all of the rows just
  //           printed; this is the software describing a different bike.
  //   warn  — read, no disagreement, but a micro never answered. Expected on the bike
  //           this repo runs on (the A8's 277 has never been read) and still notable
  //           every time, because the A8 is the micro that owns the one disputed id.
  //   log   — both micros answered and agreed. Routine, and worth recording as such.
  const write =
    report.mismatched || report.split || report.unusable.length > 0
      ? console.error
      : report.confirmed
        ? console.log
        : console.warn;
  for (const line of report.lines) {
    write(`vcu-sweep: ${line}`);
  }
  // ⚠️ Only the STORED snapshot gets re-named from the table the bike just reported
  // (../vcu/snapshot-store.ts). The 277 lines that scrolled past above were named as
  // they arrived, from whatever table was active then — and on a first sweep of an
  // unfamiliar bike that is a default, because 276 is only read partway through the A9
  // pass. On a `RegenFade` bike those lines say `70 CELL_COUNT 81`, and journalctl is
  // the artefact you have when the bike is out of wifi range, so the discrepancy is
  // said out loud rather than left for someone to discover by comparing the two.
  // ⚠️ contentTwinsOf(), not `!==`. 4119 and 16407 are byte-identical 277-row tables under
  // two vehicle-line tags, so a bike reporting one while the Pi names from the other has
  // every name above this line right, and shouting about it would be a false alarm that
  // teaches people to skim past a real one.
  const named = report.tableType;
  const active = activeParameterTable().tableType;
  if (named !== null && named !== active && !contentTwinsOf(named).includes(active)) {
    console.warn(
      `vcu-sweep: ⚠️  the NAMES printed above are ${describeTableType(active)}'s, but this bike runs ` +
        `${describeTableType(named)} — the snapshot on disk and /params.html are re-named from the bike's own ` +
        "table, this scrollback is not. Read it again there if a name matters."
    );
  }
}

/**
 * A pre-flight "is this micro there?" per micro, before 277 reads find out the hard
 * way. The micros answer nothing at all until a session is open, so this is `10 81`
 * followed by `3E` — and a micro that fails it produces one legible log line
 * instead of 233 identical no-sessions.
 */
async function pingMicros(options: ParameterSweepOptions, state: SweepState): Promise<void> {
  for (const micro of MICROS) {
    if (!mayContinue(options, state)) {
      return;
    }
    const reachable = await state.client.ping(micro);
    console.log(`vcu-sweep: ${micro} ${reachable ? "session open, responding" : "NOT responding to 10 81 + 3E"}`);
  }
}

/**
 * The gate check between the loop and the socket.
 *
 * ⚠️ This is HALF of the auto-exit and it is worth being precise about which half,
 * because "no frame after unsafe" is the sentence someone will quote when deciding
 * whether the other half can be dropped.
 *
 * What this call guarantees on its own is weaker than it looks: it runs once per
 * PARAMETER, and one parameter can put up to three frames on the bus — the read,
 * then on a timeout a `10 81` to re-open the session and a second read
 * (kwp-client.ts `readParameter`). `pingMicros` below is checked once per micro and
 * `ping` sends two frames. So a gate transition landing just after a check here can
 * be followed by another frame up to a reply window later.
 *
 * What actually bounds it is `stopped` inside kwp-client.ts's `exchange`, which
 * refuses to transmit at all and is set by `abort` — reached from here AND from the
 * 200 ms watchdog in ../vcu/read-runner.ts. Since 200 ms is shorter than the 300 ms
 * reply window, at most one already-in-flight frame gets out.
 *
 * This check is still worth having: it is what makes the sweep correct on its own
 * terms rather than dependent on a caller remembering to watch it, and in the
 * common case (a read that answers in milliseconds) it is what stops the sweep,
 * with the watchdog never firing. But the tight bound is the watchdog's.
 */
function mayContinue(options: ParameterSweepOptions, state: SweepState): boolean {
  if (state.stoppedBecause !== null) {
    return false;
  }
  const verdict = options.checkGate();
  if (verdict.safe) {
    return true;
  }
  // Loud: this is the bike being ridden away with a diagnostic sweep running, or a
  // signal the gate depends on going quiet. Either is worth a journal line naming
  // which requirement failed, because it is the only record of why a sweep that was
  // going fine suddenly stopped.
  console.warn(`vcu-sweep: leaving service mode — ${verdict.blockers.join("; ")}`);
  abort(state, `the bike stopped being safe to service — ${verdict.blockers.join("; ")}`);
  return false;
}

/**
 * Which parameters to read, grouped by micro.
 *
 * Grouped rather than interleaved because A8 and A9 hold SEPARATE sessions: hopping
 * between them would let each one idle out while the other was being read, and pay
 * for a re-open on every single parameter.
 */
function sweepTargets(): VcuParameter[] {
  return [...parameterTable()].sort(
    (left, right) => MICROS.indexOf(left.micro) - MICROS.indexOf(right.micro) || left.index - right.index
  );
}
