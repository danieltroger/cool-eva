import {
  MINIMUM_AGE_SECONDS,
  planCaptureDeletions,
  type ManifestRow,
  type RemoteFile,
} from "./free-pi-captures-plan.ts";

// Guards the gate that deletes raw CAN captures off the bike's SD card.
//
//     node --experimental-strip-types scripts/check-free-pi-captures.ts
//
// ⚠️ Every case below is a real one. The sizes, names and states are taken from the Pi
// and from ~/Documents/cool-eva-route/data/ride-captures/MANIFEST.tsv as they read on
// 2026-09-19, because the two rows that matter most — the live capture being appended to,
// and the original untracked capture script sitting in the manifest as a deletable row —
// are things that ACTUALLY happened, not hazards someone imagined.

/** 2026-09-19 21:00 UTC, so every age below is arithmetic rather than a moving target. */
const NOW = Math.floor(Date.UTC(2026, 8, 19, 21, 0, 0) / 1000);
const DAY = 24 * 3600;
const CURRENT_BOOT = "c587b2e4";

const failures: string[] = [];

// ⚠️ First, not last. An earlier draft had this at the bottom of the file — after the
// process.exit(1) — where it could never fire, which is the exact shape of assertion this
// repo keeps getting bitten by.
if (MINIMUM_AGE_SECONDS !== DAY) {
  failures.push(`the age floor is ${MINIMUM_AGE_SECONDS}s; every case below is written against 24 h`);
}

checkTheHappyPath();
checkTheLiveCapture();
checkTheSupersededScript();
checkUnknownSourceStates();
checkTheUntrustworthyClock();
checkTheStoredCopy();
checkStrictHashing();
checkDeduplicationAcrossProofSources();
checkAbsentIsNotARefusal();
checkAnUnknownBootIdRefusesEverything();

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "\n✓ a verified, complete, day-old capture is deletable, and every one of the seven guards refuses on its own: " +
    "a name that is not a capture, a source_state that is not exactly complete, a size that moved, the running " +
    "boot, either clock reading under 24 h, a missing or wrong-sized copy, and a sha256 that disagrees"
);

/** The case the whole script exists for: verified, complete, old, unchanged. */
function checkTheHappyPath(): void {
  const plan = plan1(row(), remote());
  if (plan.deletable.length !== 1) {
    failures.push(`a verified day-old capture was not deletable: ${plan.refusals[0]?.reason ?? "no reason given"}`);
    return;
  }
  if (plan.deletable[0].bytes !== 37908480) {
    failures.push(`the freed size is ${plan.deletable[0].bytes}, expected the Pi's 37908480`);
  }
  if (plan.deletable[0].proofSource !== "MANIFEST.tsv") {
    failures.push("the plan does not name which proof source justified the deletion");
  }
}

/**
 * ⚠️ The row that was actually wrong. `capture-20260919-170112-c587b2e4-00000023.log` was
 * verified at 382 046 710 B while the service kept appending; by 20:32 the card held
 * 1 358 842 394 B. Four guards refuse it and the precedence decides which is reported.
 */
function checkTheLiveCapture(): void {
  const live = row({
    name: "capture-20260919-170112-c587b2e4-00000023.log",
    rawBytes: 382046710,
    sourceState: "prefix-of-live-file",
  });
  const onCard = remote({ bytes: 1358842394, mtimeEpochSeconds: NOW - 60 });
  const plan = plan1(live, onCard);
  if (plan.deletable.length !== 0) {
    failures.push(
      "the live capture — verified as a prefix, 976 MB larger on the card, written a minute ago — was deletable"
    );
  }
  if (!plan.refusals[0]?.reason.includes("source_state")) {
    failures.push(`the live capture was refused for ${plan.refusals[0]?.reason}, but source_state has precedence`);
  }
  // Each of the other three must also refuse it ALONE, or the precedence is hiding a hole.
  const completed = { ...live, sourceState: "complete" };
  if (plan1(completed, onCard).deletable.length !== 0) {
    failures.push("with only source_state corrected, a file 976 MB larger than its proof became deletable");
  }
  // ⚠️ The size guard needs a case of its own. Every variation above is ALSO caught by
  // the boot-id or age guards, so a mutation run that deleted the size comparison
  // survived the whole file until this was added — the other assertions were covering it.
  const onlySizeMoved = plan1(row(), remote({ bytes: 37908480 + 4096 }));
  if (onlySizeMoved.deletable.length !== 0) {
    failures.push(
      "an old capture from a dead boot was deletable although the card's copy is 4 kB bigger than its proof"
    );
  }
  if (!onlySizeMoved.refusals[0]?.reason.includes("changed since it was verified")) {
    failures.push(`a size mismatch was refused for the wrong reason: ${onlySizeMoved.refusals[0]?.reason}`);
  }

  const sizeAgrees = plan1({ ...completed, rawBytes: 1358842394 }, onCard);
  if (sizeAgrees.deletable.length !== 0) {
    failures.push("a capture written by the boot that is running now became deletable once its size agreed");
  }
  if (!sizeAgrees.refusals[0]?.reason.includes("boot that is running now")) {
    failures.push(`expected the clock-free boot-id guard to catch it; got ${sizeAgrees.refusals[0]?.reason}`);
  }
}

/**
 * ⚠️ `capture.sh.superseded` is 1 015 bytes, dated 2026-08-02, and is the ORIGINAL
 * untracked capture script that docs/can-capture.md is written about. The pull swept the
 * whole directory, so it is a manifest row. Only the name allowlist stands between it and
 * a delete that trusted the manifest.
 */
function checkTheSupersededScript(): void {
  const notCaptures = [
    "capture.sh.superseded",
    "ride-1.log",
    "charge.log",
    "../ride-logs/rides-2026-09-13.celog",
    "capture-20260802-184526-1c8fc1e2.log.zst",
    "capture-2026080-184526-1c8fc1e2.log",
  ];
  for (const name of notCaptures) {
    const plan = plan1(row({ name }), remote());
    if (plan.deletable.length !== 0) {
      failures.push(`${name} is deletable, and the allowlist is the only thing that should have stopped it`);
    }
    if (plan.absent.length !== 0) {
      failures.push(`${name} was filed as "already gone" rather than refused — a bad name must never look benign`);
    }
  }
}

/** A state nobody here has heard of must fail CLOSED, not fall through to deletable. */
function checkUnknownSourceStates(): void {
  for (const state of ["prefix-of-live-file", "partial", "COMPLETE", "", "complete "]) {
    const plan = plan1(row({ sourceState: state }), remote());
    if (plan.deletable.length !== 0) {
      failures.push(`source_state ${JSON.stringify(state)} was treated as proof of a complete copy`);
    }
  }
}

/**
 * The Pi has no RTC and steps its own clock from GPS; the archive holds a capture stamped
 * 2060. So the age gate reads both clocks and refuses on either.
 */
function checkTheUntrustworthyClock(): void {
  const justUnder = plan1(row(), remote({ mtimeEpochSeconds: NOW - DAY + 60 }));
  if (justUnder.deletable.length !== 0) {
    failures.push("a capture written 23 h 59 m ago was deletable, under a 24 h floor");
  }
  const justOver = plan1(row(), remote({ mtimeEpochSeconds: NOW - DAY - 60 }));
  if (justOver.deletable.length !== 1) {
    failures.push(`a capture written 24 h 1 m ago was refused: ${justOver.refusals[0]?.reason}`);
  }
  // ⚠️ A stale mtime with a fresh NAME: the direction that would otherwise delete. The
  // mtime says two days, the filename says minutes, and the filename wins.
  const freshName = row({ name: `capture-20260919-205500-aaaaaaaa-00000024.log` });
  const lyingMtime = plan1(freshName, remote({ mtimeEpochSeconds: NOW - 2 * DAY }));
  if (lyingMtime.deletable.length !== 0) {
    failures.push("a capture whose NAME is five minutes old was deletable because its mtime claimed two days");
  }
  // And the 2060 file: a name in the future is never 24 h old, so it refuses forever.
  const fromTheFuture = row({ name: "capture-20600808-220827-0887e861.log" });
  if (plan1(fromTheFuture, remote({ mtimeEpochSeconds: NOW - 30 * DAY })).deletable.length !== 0) {
    failures.push("the 2060-stamped capture was deletable — a future name must refuse, harmlessly, forever");
  }
}

function checkTheStoredCopy(): void {
  const missing = planCaptureDeletions({
    ...base(row(), remote()),
    storedCopies: new Map([["/archive/capture.log.zst", null]]),
  });
  if (missing.deletable.length !== 0) {
    failures.push("a capture was deleted while its only verified copy was missing from this machine");
  }
  // The wording is the point: "could be the last one" is what stops someone waving it
  // through, and a size comparison against a missing file would say something else.
  if (!missing.refusals[0]?.reason.includes("could be the last one")) {
    failures.push(`a missing verified copy was refused without saying so: ${missing.refusals[0]?.reason}`);
  }
  const wrongSize = planCaptureDeletions({
    ...base(row(), remote()),
    storedCopies: new Map([["/archive/capture.log.zst", 99]]),
  });
  if (wrongSize.deletable.length !== 0) {
    failures.push("a capture was deleted while its verified copy was the wrong size");
  }
  // ⚠️ Waiving it is allowed — the odroid's copies are not on this Mac — but it must be
  // the explicit flag that does it, never a side effect of the copy being absent.
  const waived = planCaptureDeletions({
    ...base(row(), remote()),
    storedCopies: new Map(),
    requireStoredCopy: false,
  });
  if (waived.deletable.length !== 1) {
    failures.push("--no-stored-copy-check did not let an odroid-verified row through");
  }
}

function checkStrictHashing(): void {
  const agrees = planCaptureDeletions({ ...base(row(), remote({ sha256: "a".repeat(64) })), strict: true });
  if (agrees.deletable.length !== 1) {
    failures.push(`--strict refused a capture whose hash matches: ${agrees.refusals[0]?.reason}`);
  }
  const differs = planCaptureDeletions({ ...base(row(), remote({ sha256: "b".repeat(64) })), strict: true });
  if (differs.deletable.length !== 0) {
    failures.push("--strict deleted a capture whose sha256 on the Pi differs from the proof");
  }
  // A Pi that returned no hash must refuse, not pass for lack of evidence.
  const silent = planCaptureDeletions({ ...base(row(), remote({ sha256: undefined })), strict: true });
  if (silent.deletable.length !== 0) {
    failures.push("--strict deleted a capture the Pi returned no sha256 for");
  }
}

/** Proved on the Mac AND on the odroid is still one file, and one deletion. */
function checkDeduplicationAcrossProofSources(): void {
  const plan = planCaptureDeletions({
    ...base(row(), remote()),
    rows: [row(), row({ proofSource: "odroid/MANIFEST.tsv" })],
  });
  if (plan.deletable.length !== 1) {
    failures.push(`a capture in two proof sources planned ${plan.deletable.length} deletions, expected 1`);
  }
  if (plan.deletable[0]?.proofSource !== "MANIFEST.tsv") {
    failures.push("the first proof source named on the command line did not win the attribution");
  }
}

/**
 * ⚠️ Losing the boot id must refuse EVERYTHING, not quietly fall back to the clock. The
 * diff reviewer demonstrated the hole: with the id null and a stale mtime, a capture the
 * running boot was appending to came back deletable.
 */
function checkAnUnknownBootIdRefusesEverything(): void {
  for (const bootId of [null, ""]) {
    const plan = planCaptureDeletions({ ...base(row(), remote()), currentBootId: bootId });
    if (plan.deletable.length !== 0) {
      failures.push(`a boot id of ${JSON.stringify(bootId)} still allowed a deletion; it must refuse everything`);
    }
    if (!plan.refusals[0]?.reason.includes("boot id could not be read")) {
      failures.push(`an unreadable boot id was refused for the wrong reason: ${plan.refusals[0]?.reason}`);
    }
  }
}

/** Already deleted is not a problem to report; it is nothing to do. */
function checkAbsentIsNotARefusal(): void {
  const plan = planCaptureDeletions({ ...base(row(), remote()), remote: new Map() });
  if (plan.absent.length !== 1 || plan.refusals.length !== 0 || plan.deletable.length !== 0) {
    failures.push(
      `a capture already gone from the Pi gave ${plan.deletable.length} deletions, ${plan.refusals.length} ` +
        `refusals and ${plan.absent.length} absent; expected 0, 0, 1`
    );
  }
}

// ---- fixtures -------------------------------------------------------------

function row(overrides: Partial<ManifestRow> = {}): ManifestRow {
  return {
    name: "capture-20260918-185937-bbec514f-00000024.log",
    rawBytes: 37908480,
    sha256OnPi: "a".repeat(64),
    storedFile: "/archive/capture.log.zst",
    storedBytes: 3979364,
    sourceState: "complete",
    proofSource: "MANIFEST.tsv",
    ...overrides,
  };
}

function remote(overrides: Partial<RemoteFile> = {}): RemoteFile {
  return { bytes: 37908480, mtimeEpochSeconds: NOW - 2 * DAY, ...overrides };
}

function base(manifestRow: ManifestRow, onCard: RemoteFile) {
  return {
    rows: [manifestRow],
    remote: new Map([[manifestRow.name, onCard]]),
    storedCopies: new Map([[manifestRow.storedFile, manifestRow.storedBytes]]),
    nowEpochSeconds: NOW,
    currentBootId: CURRENT_BOOT,
    strict: false,
    requireStoredCopy: true,
  };
}

function plan1(manifestRow: ManifestRow, onCard: RemoteFile) {
  return planCaptureDeletions(base(manifestRow, onCard));
}
