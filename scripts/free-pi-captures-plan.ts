// Decides which captures on the Pi's card may be deleted. Pure: no ssh, no filesystem,
// no clock — every input is a parameter, so the whole gate is exercised by
// scripts/check-free-pi-captures.ts against cases that never touch a bike.
//
// The rule Daniel gave on 2026-09-19: "yes as long as we still have one copy somewhere
// the ones on the cool-eva pi can be deleted". Everything below is that sentence made
// checkable — what counts as a copy, and what counts as knowing it is still there.

/** One row of a proof source: a MANIFEST.tsv written by whoever verified the copy. */
export interface ManifestRow {
  name: string;
  rawBytes: number;
  sha256OnPi: string;
  storedFile: string;
  storedBytes: number;
  sourceState: string;
  /** Which manifest carried this row, so a dry run is auditable back to one proof. */
  proofSource: string;
}

/** What the Pi says about the file right now. */
export interface RemoteFile {
  bytes: number;
  mtimeEpochSeconds: number;
  /** Only read with --strict; hashing 5 GB over the card costs minutes. */
  sha256?: string;
}

export interface PlanInput {
  rows: ManifestRow[];
  /** Absent from the map = the Pi no longer has it; nothing to free, and not a refusal. */
  remote: Map<string, RemoteFile>;
  /** `storedFile` → its size here, or null when it is missing. */
  storedCopies: Map<string, number | null>;
  nowEpochSeconds: number;
  /**
   * First 8 hex of the Pi's `/proc/sys/kernel/random/boot_id`.
   *
   * ⚠️ Null or empty REFUSES EVERYTHING. This is the only guard that does not depend on
   * the Pi's clock, and the clock is the one this repo documents as untrustworthy — so
   * losing it is losing the only reliable answer to "is something still writing this".
   */
  currentBootId: string | null;
  strict: boolean;
  /** False only when the proof source's blobs live somewhere this machine cannot see. */
  requireStoredCopy: boolean;
}

export interface PlannedDeletion {
  name: string;
  bytes: number;
  proofSource: string;
}

export interface Refusal {
  name: string;
  reason: string;
}

export interface DeletionPlan {
  deletable: PlannedDeletion[];
  refusals: Refusal[];
  /** In a manifest, already gone from the Pi. Nothing to do, and not a problem. */
  absent: string[];
}

/**
 * ⚠️ Only this shape may ever be deleted, and the allowlist is the point rather than the
 * validation. `/home/pi/ride-captures/` also holds `charge.log`, `ride-1.log` and
 * `capture.sh.superseded` — the last being the ORIGINAL untracked capture script, 1 015
 * bytes, which `docs/can-capture.md` is written about. All three are manifest rows, so a
 * delete that trusted the manifest alone would have destroyed it.
 */
const CAPTURE_NAME = /^capture-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([0-9a-f]{8})(?:-\d{8})?\.log(?:\.gz)?$/;

/**
 * Whether a name is one this project's capture unit writes — the deletion allowlist.
 *
 * ⚠️ Exported so `scripts/check-capture-behaviour.ts` can feed it the filename the REAL
 * capture.sh produced under stubs. Without that the allowlist is a fifth hand-written copy
 * of the name shape with no witness, and the failure is silent in the safe direction: a
 * name change makes this refuse every new capture, nothing goes red, and the card simply
 * stops being swept until the disk floor stops the capture too.
 */
export function isCaptureName(name: string): boolean {
  return CAPTURE_NAME.test(name);
}

/** A capture must be this old by every clock we have before it is a candidate. */
export const MINIMUM_AGE_SECONDS = 24 * 60 * 60;

export function planCaptureDeletions(input: PlanInput): DeletionPlan {
  const deletable: PlannedDeletion[] = [];
  const refusals: Refusal[] = [];
  const absent: string[] = [];

  for (const row of dedupeRows(input.rows)) {
    const remote = input.remote.get(row.name);
    if (!remote && CAPTURE_NAME.test(row.name)) {
      absent.push(row.name);
      continue;
    }
    // `|| !remote` rather than a guard inside refuse(): the compiler then PROVES what a
    // comment would otherwise have to assert, and the reason string stays in the one place
    // that can produce it.
    const reason = refuse(row, remote, input);
    if (reason || !remote) {
      refusals.push({ name: row.name, reason: reason ?? "not on the Pi" });
      continue;
    }
    deletable.push({ name: row.name, bytes: remote.bytes, proofSource: row.proofSource });
  }
  return { deletable, refusals, absent };
}

/**
 * The guards, in precedence order — first match wins, and that order is what makes the
 * refusal counts reproducible. The live capture trips four of them; it is counted once.
 */
function refuse(row: ManifestRow, remote: RemoteFile | undefined, input: PlanInput): string | null {
  const parsed = CAPTURE_NAME.exec(row.name);
  if (!parsed) {
    return "not a capture name — only capture-<date>-<time>-<bootid>[-<uptime>].log[.gz] is ever deletable";
  }
  // ⚠️ Fail closed, and before anything else that could pass. Without the boot id the
  // only test left for "still being written" is a clock that has been years wrong on this
  // hardware; a capture the running boot is appending to would then be deletable.
  if (!input.currentBootId) {
    return "the Pi's boot id could not be read, and it is the only guard here that does not trust the clock";
  }
  if (row.sourceState !== "complete") {
    // ⚠️ Fail closed on anything unrecognised, not just on the one known bad value.
    // `prefix-of-live-file` means the copy is an honest prefix of a file the service was
    // still appending to; a state nobody here has heard of means the same until proven.
    return `source_state is ${JSON.stringify(row.sourceState)}, not "complete" — the copy may be a prefix`;
  }
  if (!remote) {
    return null;
  }
  if (remote.bytes !== row.rawBytes) {
    return `the Pi's copy is ${remote.bytes} B, the proof covers ${row.rawBytes} B — it has changed since it was verified`;
  }

  // ⚠️ Three age tests, because two of them run on a clock this Pi cannot be trusted with.
  // `capture.sh` says so itself: it has no RTC and steps its own time from GPS, and the
  // archive holds a capture stamped 2060. The boot-id test is the only CLOCK-FREE one, and
  // it is the one that actually answers "is something still writing this".
  if (parsed[7] === input.currentBootId) {
    return `written by the boot that is running now (${parsed[7]}) — it may still be open`;
  }
  const mtimeAge = input.nowEpochSeconds - remote.mtimeEpochSeconds;
  if (mtimeAge < MINIMUM_AGE_SECONDS) {
    return `last written ${(mtimeAge / 3600).toFixed(1)} h ago, under the ${MINIMUM_AGE_SECONDS / 3600} h floor`;
  }
  const nameAge = input.nowEpochSeconds - filenameEpochSeconds(parsed);
  if (nameAge < MINIMUM_AGE_SECONDS) {
    return `its name is stamped ${(nameAge / 3600).toFixed(1)} h ago, under the ${MINIMUM_AGE_SECONDS / 3600} h floor`;
  }

  if (input.requireStoredCopy) {
    const stored = input.storedCopies.get(row.storedFile);
    if (stored === undefined || stored === null) {
      return `the verified copy ${row.storedFile} is not where the proof says it is — this could be the last one`;
    }
    if (stored !== row.storedBytes) {
      return `the verified copy ${row.storedFile} is ${stored} B, the proof records ${row.storedBytes} B`;
    }
  }

  if (input.strict) {
    if (!remote.sha256) {
      return "--strict was asked for and the Pi returned no sha256 for it";
    }
    if (remote.sha256 !== row.sha256OnPi) {
      return `sha256 on the Pi is ${remote.sha256.slice(0, 12)}…, the proof records ${row.sha256OnPi.slice(0, 12)}…`;
    }
  }
  return null;
}

/**
 * The filename's own timestamp, read as UTC.
 *
 * ⚠️ The Pi writes LOCAL time (CEST, UTC+2), so reading it as UTC places the instant up to
 * two hours LATER than it really was, which makes the file look YOUNGER and refuses more
 * often. That is the safe direction, and it is why there is no timezone parameter here.
 */
function filenameEpochSeconds(parsed: RegExpExecArray): number {
  const [, year, month, day, hour, minute, second] = parsed;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) / 1000;
}

/**
 * One row per name. A capture verified onto both the Mac and the odroid is proved twice;
 * deleting it twice is not meaningful, and the count would be wrong in the dry run.
 * The first proof source named on the command line wins, so the output is deterministic.
 */
function dedupeRows(rows: ManifestRow[]): ManifestRow[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    if (seen.has(row.name)) {
      return false;
    }
    seen.add(row.name);
    return true;
  });
}
