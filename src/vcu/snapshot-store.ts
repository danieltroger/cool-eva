import { mkdir, open, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  describeChange,
  diffSnapshots,
  reportTableType,
  retableSnapshot,
  type TableTypeReport,
  type VcuParameterRow,
  type VcuParameterSnapshot,
} from "./snapshot.ts";
import { selectParameterTable } from "./param-table.ts";
import type { FileHandle } from "fs/promises";

// Where a parameter sweep's results live on disk, and the four rules about them
// that are worth more than the code that implements them:
//
//  1. **Every row is written the moment it arrives**, to `sweep.partial.jsonl`. The
//     link to the bike drops as routine — on 2026-08-08 it cost a whole result set
//     mid-read (obd-garage/DIAG_ADDRESSES.md §6) — and a sweep that has to survive
//     one connection is a sweep that loses everything to a service restart.
//  2. **A resumed sweep does not re-ask what already answered.** Rows that came back
//     as a value are carried forward; rows that failed are retried, because on this
//     link most failures are transient and the alternative is a resume that carries
//     yesterday's timeout forward for ever.
//  3. **A partial snapshot is kept and labelled, never discarded.** Half the
//     parameters off a real bike is half a set of facts. `complete: false` is what
//     stops anything downstream reading it as all of them.
//  4b. **A finished sweep names its own parameters.** A row is named when it arrives,
//     from whatever table was active then — and on a first sweep of an unfamiliar bike
//     that is a default, because `TABLE_TYPE_uC` is only read partway through the A9
//     pass. So before anything is written, the whole snapshot is re-named from the table
//     the snapshot ITSELF reports (`retableSnapshot`). Otherwise the first sweep of
//     another owner's bike is stored, served, exported and diffed under this bike's
//     names — which on the 20 tables where ids 70–94 are `RegenFade_0…24` means writing
//     `CELL_COUNT` and `CELL_OVERVOLTAGE` to disk for a bike that has neither.
//  4. **A worse run never clobbers `latest.json`.** That file is the diff baseline
//     and what GET /vcu-params and /vcu-backup.csv serve. A run where the bike was
//     asleep, or one the safety gate cut short after three parameters, is a fact
//     about the run — the timestamped archive records it — and must not replace a
//     file full of real values with one that is nearly empty. Otherwise the export
//     button offers three parameters as this bike's calibration, and the next run
//     diffs against them and reports 274 disappearances with any genuine
//     value-changed buried underneath.
//
// All four came from scripts/read-vcu-params.ts, which is where this sweep used to
// live as a separate process. They are the reason the sweep was worth moving rather
// than reimplementing.

const PARTIAL_FILE = "sweep.partial.jsonl";
const LATEST_FILE = "latest.json";

/** An append handle on the resume file, held open for a whole sweep. */
export interface PartialSweepLog {
  /** Writes one row through. Not fsynced — see the note in append(). */
  append: (row: VcuParameterRow) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Rows a previous sweep of this directory already got answers for.
 *
 * Keyed by index so the caller can skip them. A row that is present but did NOT
 * come back as a value is returned too — the caller decides to retry it, which
 * keeps that policy in one place (see rule 2 above).
 */
export async function loadPartialRows(directory: string): Promise<Map<number, VcuParameterRow>> {
  const path = join(directory, PARTIAL_FILE);
  const rows = new Map<number, VcuParameterRow>();
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    // Ordinary on a first run; anything other than "not there" is worth saying,
    // because a permissions problem here silently costs a resume.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`vcu-sweep: could not read ${path} — starting fresh:`, err);
    }
    return rows;
  }
  const lines = text.split("\n");
  for (const [position, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const row = JSON.parse(line) as VcuParameterRow;
      rows.set(row.index, row);
    } catch (err) {
      // Only the LAST line can be a torn append — a process killed between the
      // write and the newline. That one is expected and costs a single re-read of
      // one parameter.
      //
      // A bad line ANYWHERE ELSE is a damaged file (an interrupted write, a bad
      // block on the SD card) and would otherwise just quietly lower the count,
      // which is the silent-failure shape CLAUDE.md forbids.
      if (position === lines.length - 1) {
        console.log(
          `vcu-sweep: ${PARTIAL_FILE} ends mid-row — a sweep was killed while writing it; re-reading that one`
        );
        continue;
      }
      console.warn(`vcu-sweep: ${PARTIAL_FILE} line ${position + 1} is not valid JSON, skipping it:`, err);
    }
  }
  return rows;
}

/**
 * Opens the resume file for appending, creating the directory if needed.
 *
 * Opened once and held for the whole sweep: ~277 open/close pairs on an SD card is
 * a lot of syscalls for no benefit, and every exit path — finish, abort, gate loss,
 * shutdown — closes it.
 */
export async function openPartialSweepLog(directory: string): Promise<PartialSweepLog> {
  await mkdir(directory, { recursive: true });
  const handle: FileHandle = await open(join(directory, PARTIAL_FILE), "a");
  return {
    append: async row => {
      // No fsync per row on purpose: 277 of them onto a Pi Zero's SD card buys
      // protection against a power cut, which is not the failure this is built for.
      // A dropped link, an abort or a killed process all leave the page cache — and
      // therefore the file — intact.
      await handle.write(`${JSON.stringify({ at: Date.now(), ...row })}\n`);
    },
    close: () => handle.close(),
  };
}

/** Throws the resume file away. Only ever called for a sweep that covered everything. */
export async function clearPartialSweep(directory: string): Promise<void> {
  await rm(join(directory, PARTIAL_FILE), { force: true });
}

/**
 * The last sweep on this Pi: its rows, and what they say about which of Energica's
 * parameter tables this bike runs.
 *
 * The two travel together because they come out of one file and one parse. A caller
 * that wanted both used to read `latest.json` twice — once for the gate and once for
 * the values — which on a Pi Zero's SD card is two reads and two parses of a 277-row
 * file per page load, and worse, two reads that a sweep finishing between them can put
 * out of step with each other.
 */
export interface LatestSweep {
  /** Re-named from the table the snapshot itself reports — see `loadLatestSweep`. */
  snapshot: VcuParameterSnapshot;
  report: TableTypeReport;
}

/**
 * What the last sweep on this Pi says about which of Energica's parameter tables this
 * bike runs, or null when nothing here can say.
 *
 * Lives in this file rather than in src/http/vcu-params.ts, which also reads
 * `latest.json`, because src/vcu must not import src/http — and because this module is
 * what WRITES that file, so it is where "the latest snapshot is this one" belongs. The
 * HTTP module keeps its own reader for the page's sake; both go through
 * `reportTableType`, so there is still exactly one opinion about what a `TABLE_TYPE`
 * reading MEANS.
 */
export async function loadLatestTableType(directory: string): Promise<TableTypeReport | null> {
  return (await loadLatestSweep(directory))?.report ?? null;
}

/**
 * The last sweep's snapshot and its table-type report, or null when there is no usable
 * one.
 *
 * ⚠️ Null on every failure — missing file, unreadable file, valid JSON that is not a
 * snapshot — and never an empty report. ./table-gate.ts reads a null report as "nothing
 * has confirmed either micro", which blocks, so every one of those failures fails
 * closed. They are logged rather than swallowed because "no sweep has run" and "the
 * snapshot is damaged" are different problems and only one of them is fixed by reading
 * the bike.
 *
 * ⚠️ The rows are re-named from the table the snapshot itself reports, exactly as
 * src/http/vcu-params.ts serves them. A stored snapshot's names are a DERIVED view: a
 * file written before the catalogue existed carries whichever table that build
 * hardcoded, and anything matching a row to a parameter BY NAME has to be looking at
 * the bike's own names rather than that build's.
 */
export async function loadLatestSweep(directory: string): Promise<LatestSweep | null> {
  const stored = await loadSnapshotFile(join(directory, LATEST_FILE));
  if (!stored) {
    return null;
  }
  try {
    const report = reportTableType(stored);
    return { snapshot: retableSnapshot(stored, report), report };
  } catch (err) {
    // reportTableType walks `snapshot.rows`, so a file that parsed but is not a
    // snapshot — `{}`, `null`, a truncated write that still parses — throws here.
    console.warn(`vcu-sweep: ${join(directory, LATEST_FILE)} parsed but is not a parameter snapshot:`, err);
    return null;
  }
}

/**
 * Writes a snapshot out, and says loudly what changed since the last one.
 *
 * The archive is written on EVERY run — complete or not, read-something or not — so
 * that "the bike was asleep, 277 no-session" stays legible as its own result rather
 * than leaving no trace at all. `latest.json` follows rule 4.
 */
export async function writeSnapshot(directory: string, swept: VcuParameterSnapshot): Promise<void> {
  await mkdir(directory, { recursive: true });
  // Rule 4b, and it happens before EVERYTHING else in this function: the archive, the
  // latest file, the diff and the log lines all describe the same rows, so they all have
  // to describe them under the same names.
  const report = reportTableType(swept);
  const snapshot = retableSnapshot(swept, report);
  if (report.tableType !== null) {
    // ⚠️ Side effect on purpose, and the only place a sweep sets it. The next read, the
    // next page load and the next probe all name parameters out of this; selecting it
    // here means the answer arrives with the sweep rather than a service restart later.
    selectParameterTable(report.tableType);
  }
  const baseline = await loadSnapshotFile(join(directory, LATEST_FILE));
  const archivePath = join(directory, `${new Date(snapshot.readAt).toISOString().replace(/:/g, "-")}.json`);
  const serialised = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(archivePath, serialised, "utf-8");

  const read = snapshot.rows.filter(row => row.status === "read").length;
  const baselineRead = baseline?.rows.filter(row => row.status === "read").length ?? 0;
  // Rule 4, and it is a comparison rather than `read > 0`.
  //
  // `read > 0` only catches the fully-empty run. The failure the rule is actually
  // about is A BAD RUN REPLACING A GOOD FILE, and the service gate has made a new
  // way for that to happen routine: a complete sweep deletes the resume file, so
  // the next one starts from nothing — and if the owner rolls the bike three
  // parameters in, the auto-exit is working exactly as designed and `read === 3`
  // is still greater than zero. That three-row snapshot would become what
  // /vcu-params serves, what /vcu-backup.csv exports as this bike's calibration,
  // and the baseline the next run diffs against (reporting 274 disappearances).
  // The 277-row archive would still be on disk, and nothing in the dashboard can
  // reach an archive.
  //
  // So a snapshot has to be at least as good as the one it replaces: complete, or
  // carrying at least as many real values. A complete sweep wins even with fewer
  // rows — a bike that answered 200 of 277 today is a true reading of the bike,
  // and the diff saying so is the point.
  const replacesLatest = read > 0 && (snapshot.complete || read >= baselineRead);
  if (replacesLatest) {
    await writeFile(join(directory, LATEST_FILE), serialised, "utf-8");
  }
  console.log(
    `vcu-sweep: ${read}/${snapshot.rows.length} read${snapshot.complete ? "" : "  ⚠️ INCOMPLETE — start it again to resume"}` +
      (replacesLatest
        ? ` · wrote ${archivePath} and ${LATEST_FILE}`
        : read > 0
          ? // Said out loud rather than done quietly: "your export button still says
            // 277 because we kept the older, fuller snapshot" is exactly the kind of
            // thing that is baffling when it is silent.
            ` · wrote ${archivePath}; KEPT the previous ${LATEST_FILE} — it holds ${baselineRead} read values against this run's ${read}`
          : ` · wrote ${archivePath}; left ${LATEST_FILE} as it was — nothing was read, so the baseline stands`)
  );

  if (snapshot.complete) {
    // Only once the sweep finished: deleting the resume file after a partial run is
    // exactly the "losing what we got" rule 1 exists to avoid.
    await clearPartialSweep(directory);
  }
  reportChanges(baseline, snapshot);
}

/**
 * Says what moved between the last snapshot and this one.
 *
 * `value-changed` is loud on purpose: a calibration parameter this bike used to
 * hold at one value now holding another means something wrote to the VCU's EEPROM
 * between the two reads, which on a bike nobody has been servicing is the single
 * most interesting thing a sweep can tell you. The other change kinds are about the
 * reads rather than the bike and are reported separately, so "the A8 was asleep
 * this time" cannot be read as "the bike lost 44 parameters".
 */
function reportChanges(baseline: VcuParameterSnapshot | null, snapshot: VcuParameterSnapshot): void {
  if (!baseline) {
    console.log("vcu-sweep: no previous snapshot to compare against — this one becomes the baseline");
    return;
  }
  const changes = diffSnapshots(baseline, snapshot);
  if (changes.length === 0) {
    console.log(`vcu-sweep: no differences at all against ${new Date(baseline.readAt).toISOString()}`);
    return;
  }
  console.log(`vcu-sweep: compared against ${new Date(baseline.readAt).toISOString()}:`);
  for (const change of changes) {
    console.log(`  ${describeChange(change)}`);
  }
  const valueChanges = changes.filter(change => change.kind === "value-changed");
  if (valueChanges.length > 0) {
    console.warn(`vcu-sweep: ⚠️  ${valueChanges.length} PARAMETER VALUE(S) CHANGED — something reconfigured the bike.`);
  }
}

async function loadSnapshotFile(path: string): Promise<VcuParameterSnapshot | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as VcuParameterSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`vcu-sweep: could not read the baseline ${path}:`, err);
    }
    return null;
  }
}
