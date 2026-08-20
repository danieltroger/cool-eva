import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// `npm test` — runs every self-check in the repo, in order, and exits non-zero if any
// of them does. A runner, not a framework: the checks predate it and are top-level
// scripts that report failure with `process.exit(1)`, so each gets its OWN PROCESS.
// Imported into one, the first failure would take the runner down and leave every later
// check unreported — the opposite of what a red build should tell you.
//
// ⚠️ Only checks that pass or fail on their own, with no bike and no local-only files,
// belong here. The rest of scripts/ is left out on purpose, and one exclusion matters
// more than the others: scripts/read-freeze-frame.ts TALKS TO THE BIKE. It is the only
// thing in the repo that opens a socket outside the service, so it must never appear in
// CHECKS. Which others are out, and why each: docs/diagnostics-and-checks.md §11.2.
//
// ⚠️ Nothing below opens a CAN socket, and CHECK_TIMEOUT_MS is the guard against that
// quietly changing: a check that DID reach for hardware would mostly not fail — it
// would sit waiting on a bus that is not there — so a check that stops producing a
// verdict is counted as one that failed.
//
// Why there is no test framework here: docs/diagnostics-and-checks.md §11.1.

/**
 * Per-check wall-clock limit. The whole suite runs in about a second today, so this is
 * not a performance budget: it is only here to turn a hang into a red build instead of
 * an Actions job that runs until the six-hour ceiling.
 */
const CHECK_TIMEOUT_MS = 120_000;

interface SelfCheck {
  /** Path from the repo root — the same thing you would type to run it by hand. */
  script: string;
  /**
   * Fixed flags this script needs to be a check at all. Not argument forwarding — see
   * runCheck() for why the runner's own argv never reaches a script — but part of the
   * entry, so what runs here is what the `covers` line claims and cannot drift with
   * however the suite happens to be invoked.
   *
   * generate-grafana-dtc.ts is why this exists: with no flag it REWRITES the dashboard
   * and exits 0, which under `npm test` would be a check that silently edits a tracked
   * file and never fails. `--check` is what makes it report instead of act.
   */
  args?: string[];
  /** What it covers. Printed as a header, so a red log names what went rather than a path. */
  covers: string;
}

/** In script-name order; they are independent, so nothing depends on which runs first. */
const CHECKS: SelfCheck[] = [
  {
    script: "scripts/check-can-decoders.ts",
    covers:
      "the broadcast frame decoders against frames captured 2026-08-02, plus three properties of the decoder set as a whole: that every id which decodes is in the kernel RX filter, that every emitted key is declared in the registry, and that no 1/0 flag carries a deadband big enough to swallow its own transitions",
  },
  {
    script: "scripts/check-charge-mode.ts",
    covers:
      "the dashboard's one charge rule, driven by real frames through the real decoders: that a parked bike and a " +
      "ridden one are not a charge however the AC charger's frames are behaving, that an AC session reads AC, that " +
      "a DC session reads DC even though the BMS reports Idle for the whole of one and survives the late heartbeat " +
      "a steady boolean's freshness depends on, that the same Idle at the tail of an AC session is not mistaken " +
      "for a fast charge, and that no answer ever names DC without the contactor bit under it — plus that every " +
      "signal the rule consults is still a registered stream signal, since a renamed one would leave it answering " +
      "'not charging' for ever in silence",
  },
  {
    script: "scripts/check-ride-log-status.ts",
    covers:
      "what /status reports about the ride log, and about the CAN sources: that the log count is read " +
      "off the directory rather than capped or hardcoded (13 files, sized, past the 10 that was reported as stuck), " +
      "that five real seals through src/storage/encrypted-log.ts still land in one day file — so a file is not a " +
      "segment, and a caption that comes back may not call it one — that a group nothing has ever been heard from " +
      "reads [0, n] rather than being left out of the payload, that a group is dropped from the summary only when " +
      "every signal in it is written on request, that a group which does reach the payload is one the check names " +
      "on purpose, and that a talking bus counts each key once — plus that a sealed segment opens with the matching " +
      "private key and with no other, which is the only security property anything here is allowed to claim",
  },
  {
    script: "scripts/check-vcu-params.ts",
    covers:
      "VCU parameter table — including that it is Energica's table 16407, the one the bike itself names at " +
      "parameter 276, and that a bike naming any other one is shouted about rather than silently mislabelled — " +
      "request encoding and the read-only guard, framing against frames captured 2026-08-08, " +
      "the live bank-1 reads, interpretation, the snapshot diff, the KWP transport against a simulated micro, and — " +
      "since the service-write PR — the write allowlist and its per-parameter ranges, the refusal of every " +
      "non-allowlisted identifier, the table-type gate that refuses a parameter write until the bike has itself " +
      "named a table this software encodes (refused when never read, refused when mismatched, permitted when " +
      "confirmed — in the codec as well as the runner, and not applied to the service actions, which address no " +
      "index), the seed→key algorithm against four seed/key pairs captured off this bike's own " +
      "bus, the 0x120 clock frame against two frames that really went out, the service-stamp decode, Mode 04 and the bus lease",
  },
  {
    script: "scripts/check-button-decode.ts",
    covers:
      "the handlebar-button bits on 0x102 b0 and 0x400 b2 and the fast-charge contactor monitor on 0x102 b3, against frames captured 2026-08-04, plus the RX filter, short frames, and the registry and bounds entries a button needs to reach the dashboard",
  },
  {
    script: "scripts/check-handlebar-gestures.ts",
    covers:
      "the two handlebar gestures — double-click cruise-set for the next tab, long-press indicator-cancel to save a waypoint — replayed through the recognisers the phone runs, including the deadline wakeup without which a hold could only ever fire on release. Most cases are real durations that must fire NOTHING: the 140 ms median press, the 30 ms shortest, the 920 ms longest ordinary press on any handlebar button, and the only 1794 ms cruise-set press in the corpus. Plus the threshold margins and the binding itself — registered, deadband-free, and not the cruise-arm switch, whose every recorded press armed cruise control",
  },
  {
    script: "scripts/check-connection.ts",
    covers:
      "when the dashboard has a WebSocket open and what it does when it should not: that hiding the page closes the " +
      "socket and unhiding opens exactly one new one, that the messages queued while it was hidden are refused " +
      "rather than replayed as live telemetry, that lock/unlock/lock/unlock never costs more than one socket at a " +
      "time however the abandoned ones' events arrive afterwards, that a socket which stops carrying data is torn " +
      "down and replaced with NO close event ever delivered — but not one second before 12 s, so a parked bike " +
      "cannot churn sockets — that the 2 s backoff still gates every retry and none is queued while hidden, that " +
      "isStale() calls every reading stale while the link is not live so nothing frozen is shown at full " +
      "brightness — while the view rules hold their edges across the same gap, so a dropout during a DC charge " +
      "cannot throw the rider off the Charge tab and back — and that the Pi skips a client past the backlog cap " +
      "and hangs up on one still past it a heartbeat later, with the cap still holding several full snapshots — " +
      "and, against real servers on loopback ports, that neither an oversized frame nor a malformed one can end " +
      "the process — which is what a missing `error` listener turns a rejected frame into — while a bind that " +
      "FAILS still does end it, rather than leaving a live process with nothing listening for systemd to call healthy",
  },
  {
    script: "scripts/check-service-preview.ts",
    covers:
      "that scripts/build-service-preview.ts produces a file whose script blocks actually parse — the one failure mode nothing else here can see, since no other check executes generated output",
  },
  {
    script: "scripts/check-freeze-frame.ts",
    covers:
      "the 120 infokey fields and 155 per-fault shortlists against dtc-table.ts, the 0x17 request encoding and its read-only guard, extended-addressed ISO-TP reassembly and the freeze-frame layout against CONSTRUCTED transfers (no 0x17 payload has ever been captured), plus the refused, wrong-component, gapped, short, oversized, truncated, surplus and foreign replies they must reject — and that every rejection still carries the bytes that caused it",
  },
  {
    script: "scripts/check-gps-clock.ts",
    covers:
      "the GPS clock gate against the four corrupt frames in rides.db and two real cold boots, replayed again ten years on to prove the rule has no expiry date, plus the recoverable cooldown, the week-rollover floor, the two's-complement altitude and the blended-fix guard",
  },
  {
    script: "scripts/check-irreversible-actions.ts",
    covers:
      "what is behind the menu sheet's red fold — that the collapsed row's count and its three names are read off " +
      "the list of actions rather than written a second time beside it, and, across the two files that cannot see " +
      "each other, that the fold holds EXACTLY the actions src/http/vcu-write.ts refuses without a confirmation: a " +
      "fourth confirm-gated action on the Pi that nobody put behind the fold would otherwise be a destructive " +
      "control sitting in the open list with the read-only ones, and nothing else in the repo would notice",
  },
  {
    script: "scripts/check-kwp-multiframe.ts",
    covers:
      "the multi-frame half of the VCU's custom-KWP channel: the five read services and the guard that keeps every write unexpressible, ISO-TP segmentation against the 0x35 request frame captured 2026-08-08 and flow control in both directions, the one multi-frame reply with real bytes behind it (A8 bank-2 0x2001, reconstructed from two independent live records), the gapped / short / oversized / foreign / flooding replies the transport must abandon rather than complete, and the whole 0x35/0x36/0x37 bulk sequence with its block cap, cancellation and bus lease",
  },
  {
    script: "scripts/check-tab-routing.ts",
    covers:
      "the dashboard's tab URLs — that each tab still lives at the address every bookmark holds, that a fragment naming no tab (empty, unknown, malformed, or a path) lands on the riding screen instead of throwing before the first render, and that the tab ring the high-beam gesture advances through closes",
  },
  {
    script: "scripts/check-vendor-names.ts",
    covers:
      "that no tracked file names the manufacturer's service-tool product, its executable, its libraries or the " +
      "tables extracted from it — in its contents or in its own path. The gitignored obd-garage/ notes use those " +
      "names legitimately and are where they keep being copied from, so this is the check that stops a fact " +
      "arriving with a product name still attached to it",
  },
  {
    script: "scripts/decode-dtc-response.ts",
    covers:
      "ISO-TP reassembly and the OBD-II mode-03 decoder, against a real 80-byte transfer captured 2026-08-04, plus the gapped, oversized, refused and foreign replies they must reject",
  },
  {
    script: "scripts/generate-grafana-dtc.ts",
    args: ["--check"],
    covers:
      "the copy of the DTC table embedded in grafana/dashboards/trouble-codes.json as a SQL VALUES list, its NULL-MIL arm and the queryText that claims to mirror it, plus every prose sentence that states how many codes there are",
  },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = join(__dirname, "..");

const failures: string[] = [];

for (const check of CHECKS) {
  console.log(`\n──── ${check.script} ${"─".repeat(Math.max(0, 74 - check.script.length))}`);
  console.log(`     ${check.covers}\n`);
  const outcome = await runCheck(check);
  if (!outcome.passed) {
    failures.push(`${check.script} — ${outcome.reason}`);
  }
}

console.log("");
if (failures.length > 0) {
  console.error(`FAILED — ${failures.length} of ${CHECKS.length} checks:`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  // Not process.exit(): Node's stdio is asynchronous whenever it is a pipe, which it
  // always is under Actions, and exit() abandons whatever is still queued — here, the
  // list naming which check broke, i.e. the only part of a red run worth reading.
  process.exitCode = 1;
} else {
  console.log(`✓ all ${CHECKS.length} checks passed — no bike, no can0, no local-only files`);
}

type CheckOutcome = { passed: true } | { passed: false; reason: string };

/**
 * Runs one check to completion and reports how it went.
 *
 * Output is inherited rather than captured. These scripts print the evidence for what
 * they verified — the 39 decoded trouble codes, the parameters that differ from the
 * variant file — and that is worth having in the log of a run that passed, not only in
 * one that failed.
 */
async function runCheck(check: SelfCheck): Promise<CheckOutcome> {
  // Deliberately no forwarding of *this* process's argv. The checks take different
  // flags, and one of them takes bare arguments: check-vcu-params.ts has --dump <path>,
  // while decode-dtc-response.ts reads its arguments as CAN frames to decode *instead
  // of* the committed capture — which would skip the assertions that make it a check at
  // all. A shared argv would therefore mean something different, and wrong, to each.
  // Run a script directly when you want to pass it something. check.args is the
  // opposite of that: fixed per entry, written down next to what the entry claims to
  // cover, and the same on every run.
  const child = spawn(process.execPath, ["--experimental-strip-types", check.script, ...(check.args ?? [])], {
    cwd: projectDir,
    stdio: "inherit",
  });

  let timedOut = false;
  return await new Promise<CheckOutcome>(resolve => {
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: what this catches is a check blocked on hardware that is
      // not there. It has nothing to unwind, and a process stuck in a bus read is not
      // necessarily in a state to act on a polite signal.
      child.kill("SIGKILL");
    }, CHECK_TIMEOUT_MS);

    child.on("error", error => {
      clearTimeout(timer);
      resolve({ passed: false, reason: `could not be started: ${error.message}` });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ passed: false, reason: `no verdict within ${CHECK_TIMEOUT_MS / 1000} s — killed` });
        return;
      }
      if (signal !== null) {
        resolve({ passed: false, reason: `killed by ${signal}` });
        return;
      }
      resolve(code === 0 ? { passed: true } : { passed: false, reason: `exited ${code}` });
    });
  });
}
