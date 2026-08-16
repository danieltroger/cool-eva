import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// `npm test` — runs every self-check in the repo, in order, and exits non-zero if any
// of them does.
//
// Added 2026-08-16. Until then `npm test` was still the npm placeholder (`echo
// "Error: no test specified" && exit 1`) while the checks below had been passing for
// weeks and gating nothing: CI ran Prettier and tsc, so a change that broke the
// parameter table or a decoder went green.
//
// ## Why there is no test framework here
//
// The checks predate this file and were written as scripts, because that is what this
// repo is: TypeScript run directly under --experimental-strip-types, no build step, no
// bundler, deployed by `git pull`. Jest or Vitest would add a transform pipeline and a
// dependency tree to a project whose whole shape is "the file on disk is the file that
// runs" — to gain assertion sugar over the dozen-line `expect()` each check already
// carries, and nothing else those checks need. So this is a runner, not a framework:
// the checks stay runnable by hand exactly as their own comments document them, and
// this file only decides what runs and what a failure means.
//
// ## Why each check gets its own process
//
// They are top-level scripts that do their work at import time and report failure with
// `process.exit(1)`. Imported into one process, the first failure would take the runner
// down with it and every later check would go unreported — the opposite of what a red
// build should tell you. Separate processes also keep their module state apart.
//
// ## What is deliberately not run here
//
// Only checks that pass or fail on their own, with no bike and no local-only files,
// belong in `npm test`. The rest of scripts/ is left out on purpose:
//
//   setup-service.ts      installs a systemd unit, and wants root to do it
//   generate-log-key.ts   writes the keypair once and refuses to overwrite it
//   decrypt-log.ts        needs the private key and .celog segments, neither in the repo
//   replay-capture.ts     needs a candump capture — gitignored, and one bike's ride
//                         history — and serves a dashboard to look at rather than
//                         asserting anything, so there is no verdict to collect
//
// captured-dtc-transfer.ts, captured-vcu-records.ts and simulated-vcu-micro.ts are
// fixtures and a test double: data and a stand-in bus, not checks. The two replay
// scripts in CHECKS are what read them.
//
// generate-grafana-dtc.ts is in CHECKS but only ever as `--check`. Run bare it rewrites
// grafana/dashboards/trouble-codes.json and exits 0, which is a generator, not a check;
// SelfCheck.args is what keeps the distinction in the list rather than in a habit.
//
// ## No bike — and no waiting for one
//
// Nothing below opens a CAN socket. `socketcan` is imported at runtime in exactly one
// place, src/can/socket.ts, which none of these reach; everywhere else it is `import
// type`, which type stripping removes before Node ever sees it. That is why the suite
// runs on macOS and on an Actions runner, neither of which has a can0.
//
// CHECK_TIMEOUT_MS is the guard against that quietly changing. A check that did reach
// for hardware would mostly not fail — it would sit waiting on a bus that is not there
// — so a check that stops producing a verdict is counted as one that failed.

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
    script: "scripts/check-vcu-params.ts",
    covers:
      "VCU parameter table, request encoding and the read-only guard, framing against frames captured 2026-08-08, the live bank-1 reads, interpretation, the snapshot diff, and the KWP transport against a simulated micro",
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
