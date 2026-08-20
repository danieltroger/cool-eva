import { execFile } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

// Fails the build if the manufacturer's service-tool product name — or any of the file
// and library names that only exist inside it — appears anywhere in a TRACKED file.
//     node --experimental-strip-types scripts/check-vendor-names.ts
//
// It exists because the names come back on their own: obd-garage/ is gitignored, uses
// them correctly, and is where nearly every fact in src/vcu/ and src/diagnostics/ came
// from, so anybody who reads it to write a comment copies one across without deciding
// to. ⚠️ REPLACE THE NAME, KEEP THE CLAIM — the provenance is the valuable part and none
// of it needs a product name. docs/diagnostics-and-checks.md §11.5.
//
// ⚠️ THE NEEDLES ARE SPELLED `"em" + "suite"` AND MUST STAY THAT WAY. This file is itself
// a tracked file, so it is scanned by its own check; a needle written as one literal
// would sit in this source AS that literal, the check would find itself on its first run,
// and the build would be permanently red with no fix short of deleting the check. Split
// across two literals, the forbidden text never exists in the file at all — deliberately
// better than an exemption, since there is then no path this check skips and no file it
// declines to read. Do not "tidy" the concatenations.
//
// ## What it cannot do — it searches TRACKED FILES ONLY, which is load-bearing:
// obd-garage/ is invisible here by construction rather than by an ignore list, because
// those notes must keep the real names. It sees text, not intent, and knows only the
// names written below — a new artefact name out of the same tool needs a new entry. If
// git is missing or this is not a checkout it FAILS: a check that could not look is not
// a check that found nothing.
//
// ⚠️ AND IT GUARDS THE WORKING TREE, NOT HISTORY. Every earlier commit still carries the
// names in full, readable through `git log -p`, the merged PR diffs and GitHub search —
// including the diff of the change that removed them. What this check guarantees is the
// narrower, useful thing: nothing this repo currently SHIPS attributes anything to a
// named third-party product.

const execFileAsync = promisify(execFile);

interface ForbiddenName {
  /**
   * The literal to look for. Matched case-insensitively, so every capitalisation of a
   * name is one entry rather than four — the product's own name is written at least
   * four ways across the manufacturer's material, and all of them are this one line.
   * Assembled from two fragments so it never appears in this file — see the header.
   *
   * ⚠️ And do not spell the variants out in a comment to be helpful. This exact JSDoc
   * used to list them, which put the name in a tracked file and turned the check red on
   * itself — caught by this check, in CI, which is the demonstration that it works.
   */
  needle: string;
  /** What the repo writes instead. Printed on failure, so the fix takes seconds. */
  instead: string;
}

/**
 * Everything that must not appear. One entry covers every case variant and every longer
 * name built on it: the product name also catches its `.exe`, any path under a directory
 * named for it, and the `*_2024` / `*_FILES` notes in `obd-garage/` when a comment cites
 * them by filename.
 */
const FORBIDDEN_NAMES: readonly ForbiddenName[] = [
  {
    needle: "em" + "suite",
    instead:
      'the product itself is "the manufacturer\'s service tool" (or just "the service tool" once that is ' +
      'established, and "the tool" inside the same paragraph); its binary is "the service-tool executable"; a ' +
      'build of it is "the 2024 service-tool build". To cite the gitignored notes, write "the 2024 service-tool ' +
      'analysis in obd-garage/" or "the service-tool file analysis in obd-garage/" and keep the § number.',
  },
  {
    needle: "common" + ".dll",
    instead: "the shared library the tool's KWP code lives in — write \"the service tool's shared library\".",
  },
  {
    needle: "common" + ".canbusdb",
    instead: "the tool's frame/signal database — write \"the manufacturer's CAN signal database\".",
  },
  {
    needle: "common" + ".network",
    instead: "the tool's transport library — write \"the service tool's network library\".",
  },
  {
    needle: "em" + "_fault_codes",
    instead: 'a table extracted from the tool — write "the manufacturer\'s fault-code table".',
  },
  {
    needle: "em" + "_telemetry_scaling",
    instead: 'a table extracted from the tool — write "the manufacturer\'s telemetry-scaling table".',
  },
  {
    needle: "em" + "_parameter_dictionary",
    instead: 'a table extracted from the tool — write "the manufacturer\'s parameter dictionary".',
  },
  {
    needle: "em" + "cvoc",
    instead: "the tool's bundle resource — write \"the manufacturer's parameter bundles\".",
  },
];

/** Enough for any plausible failure; a clean run produces nothing at all on stdout. */
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

const projectDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const needles = FORBIDDEN_NAMES.map(forbidden => forbidden.needle);

const trackedPaths = await listTrackedPaths(projectDir);
if (trackedPaths.length === 0) {
  // "No matches" and "nothing was searched" are the same exit status out of `git grep`,
  // so an empty index or a sparse checkout would otherwise print a ✓ that means nothing.
  // Same rule as the rethrow in grepTracked(): a check that could not look is not a
  // check that found nothing.
  throw new Error(
    "check-vendor-names: `git ls-files` listed no tracked files, so `git grep` had nothing to search and its " +
      '"no matches" exit status carries no information. Refusing to report success.'
  );
}

const failures: string[] = [];

// 1. The paths themselves. A file or directory NAMED for the product would carry it in
//    every import statement, and no amount of content grepping would see it.
for (const path of trackedPaths) {
  const lowered = path.toLowerCase();
  for (const forbidden of FORBIDDEN_NAMES) {
    if (lowered.includes(forbidden.needle)) {
      failures.push(`${path} — the PATH itself carries "${forbidden.needle}". ${forbidden.instead}`);
    }
  }
}

// 2. The contents. One `git grep` for every needle at once: it is the same tool the
//    acceptance criterion is stated in, it is restricted to tracked files, and `--text`
//    means the CAD binaries and the lockfile are searched too rather than skipped.
for (const hit of await grepTracked(projectDir, needles)) {
  // Matched against the RAW line, printed as the sanitised one. Doing both off the
  // display string would lose the guidance on exactly the lines that most need it: a
  // `--text` hit inside a CAD binary, or any line whose name sits past the 200-column
  // cap, comes back with no name in it and so with nothing to tell the reader.
  //
  // Every name on the line, not just the first: one comment can easily carry the product
  // and one of its files, and both have to be rewritten before the line goes green.
  const guidance = FORBIDDEN_NAMES.filter(forbidden => hit.raw.toLowerCase().includes(forbidden.needle)).map(
    forbidden => `\n      → ${forbidden.instead}`
  );
  failures.push(`${hit.display}${guidance.join("")}`);
}

if (failures.length > 0) {
  console.error(`\nFAILED — ${failures.length} appearance(s) of a name that must not be in this public repo:`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  console.error(
    "\n  These almost always arrive from obd-garage/, which is gitignored and DOES use the real\n" +
      "  names, deliberately. Take the fact out of those notes and leave the product name behind:\n" +
      "  keep the claim, the date, the § reference and the proven/inferred marker, and swap the\n" +
      "  name for the neutral description above. Do not add an exemption to this check.\n" +
      "  scripts/check-vendor-names.ts is where the list lives."
  );
  // Not process.exit(), which the other checks do use: Node's stdio is asynchronous
  // whenever it is a pipe, which it always is under `npm test` and under Actions, and
  // exit() abandons whatever is still queued. Elsewhere that would cost a one-line
  // assertion message. Here the queued output IS the whole value of the red build —
  // which file, which line, what to write instead. Same reasoning as run-checks.ts.
  process.exitCode = 1;
} else {
  console.log(
    `✓ ${trackedPaths.length} tracked files carry none of the ${FORBIDDEN_NAMES.length} forbidden vendor names` +
      " — in their contents or in their paths"
  );
  console.log("  (obd-garage/ is gitignored and keeps the real names, by design; git grep cannot reach it)");
}

/** Every file git tracks, from the repo root whatever directory this was invoked from. */
async function listTrackedPaths(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", ":/"], {
    cwd: root,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return stdout.split("\0").filter(path => path.length > 0);
}

/** One `git grep` output line, kept both as it came and as it is safe to print. */
interface GrepHit {
  /** `path:line:text`, verbatim. What the needles are matched against. */
  raw: string;
  /** The same line, printable — see sanitise(). */
  display: string;
}

/**
 * Every `path:line:text` in a tracked file matching any needle, case-insensitively.
 *
 * Exit status 1 means "no matches", which is the passing case and not an error. Anything
 * else — git missing, not a checkout, a broken index — is rethrown: this check reporting
 * success because it could not run would be worse than not having it.
 */
async function grepTracked(root: string, patterns: string[]): Promise<GrepHit[]> {
  const args = ["grep", "--no-color", "--line-number", "--ignore-case", "--fixed-strings", "--text"];
  for (const pattern of patterns) {
    args.push("-e", pattern);
  }
  args.push("--", ":/");
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: MAX_GIT_OUTPUT_BYTES });
    return stdout
      .split("\n")
      .filter(line => line.length > 0)
      .map(line => ({ raw: line, display: sanitise(line) }));
  } catch (error) {
    if (exitStatusOf(error) === 1) {
      return [];
    }
    throw new Error(
      `check-vendor-names: \`git grep\` failed in ${root}. This check needs a git checkout to know which ` +
        `files are tracked, and it refuses to pass without one. Cause: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * `--text` can put raw bytes on stdout when a hit lands in one of the CAD binaries.
 * Control characters are dropped and the line is capped so a red log stays readable.
 */
function sanitise(line: string): string {
  const printable = line.replace(/[\u0000-\u001f\u007f]/g, "\u00b7");
  return printable.length > 200 ? `${printable.slice(0, 200)}…` : printable;
}

/** The child's exit status, or null when the failure was not an exit status at all. */
function exitStatusOf(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") {
      return code;
    }
  }
  return null;
}
