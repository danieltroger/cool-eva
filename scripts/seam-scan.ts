import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Finding the call sites of a seam that production is not allowed to use.
//
// Three seams in this repo remove the machine from a measurement and would remove the
// measurement too if anything that ships used them: `FreezeFrameReadOptions.now`,
// `recordArrival()` in src/can/signals.ts, and `arm(key, reading)` in public/lib/arming.js.
// Each is guarded by a scan asserting no shipping file calls it. docs/diagnostics-and-checks.md §11.9.
//
// ⚠️ A SCAN WHOSE EXPECTED ANSWER IS ZERO IS THE EASIEST KIND OF CHECK TO BREAK BY ACCIDENT,
// and two of its three failure modes were live in this repo until #126. It passes when the
// walk read nothing, when the pattern rotted, and — the one nobody sees — when the function
// was RENAMED, because the check file's own prose still contains the old name for its
// positive control to find. So the pattern is built from the symbol itself and cannot be
// left behind by a rename, comments are stripped so a pointer comment naming the seam is not
// mistaken for a call, and `filesRead` is returned so the caller can assert the walk happened.

export interface SeamScan {
  /** `<root>/<path>` of every file with a call, so a failure names them. */
  offenders: string[];
  /** How many files were read. A caller asserts this, or zero offenders proves nothing. */
  filesRead: number;
}

/**
 * Every file under `root` that calls `seam`, comments not counted.
 *
 * @param seam the function itself, never its name as a string: `seam.name` follows a rename
 *   and a string does not, which is the failure this whole module exists to make impossible.
 * @param options.skip path suffixes to leave out — the seam's own module declares it and is
 *   not a caller. Matched on the path, not by trying to tell a definition from a call in a
 *   regex: the two differ only by the words in front of them.
 * @param options.argumentTest applied to the matched call and its arguments, for a seam whose
 *   mere use is fine and whose use WITH something is not (`now`, `budgetMs`).
 */
export async function scanForSeamCalls(
  root: URL,
  seam: (...args: never[]) => unknown,
  options: { skip?: string[]; argumentTest?: RegExp } = {}
): Promise<SeamScan> {
  const rootPath = root.pathname;
  const entries = (await readdir(rootPath, { recursive: true })).filter(entry => entry.endsWith(".ts"));
  const offenders: string[] = [];
  let filesRead = 0;
  for (const entry of entries) {
    const path = entry.replaceAll("\\", "/");
    if (options.skip?.some(suffix => path.endsWith(suffix))) {
      continue;
    }
    filesRead += 1;
    if (callsSeam(withoutLineComments(await readFile(join(rootPath, entry), "utf8")), seam, options.argumentTest)) {
      offenders.push(path);
    }
  }
  return { offenders, filesRead };
}

/**
 * Whether `source` calls `seam`.
 *
 * Exported so a caller can hand it a literal and assert the pattern still recognises a call
 * — the positive control that survives a rename, because it does not read any file's prose.
 */
export function callsSeam(source: string, seam: (...args: never[]) => unknown, argumentTest?: RegExp): boolean {
  const calls = source.matchAll(new RegExp(String.raw`\b${seam.name}\(([^)]*)\)`, "g"));
  return [...calls].some(call => argumentTest === undefined || argumentTest.test(call[0]));
}

/**
 * `source` with its `//` comments removed. Quote-aware only far enough to leave a `//` inside a
 * string alone, and per line, so an unterminated quote cannot swallow the rest of a file.
 */
export function withoutLineComments(source: string): string {
  return source
    .split("\n")
    .map(line => {
      let quote = "";
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote !== "") {
          if (character === "\\") {
            index += 1;
          } else if (character === quote) {
            quote = "";
          }
        } else if (character === '"' || character === "'" || character === "`") {
          quote = character;
        } else if (character === "/" && line[index + 1] === "/") {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");
}
