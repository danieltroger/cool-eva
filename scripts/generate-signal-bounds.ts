import { readFile, writeFile } from "fs/promises";
import { format, resolveConfig } from "prettier";
import { SIGNALS } from "../src/can/registry.ts";
import { fallbackBoundsFor } from "../public/lib/bounds.js";

// Rewrites public/lib/generated-bounds.js from the `bounds` declared beside each signal
// in src/can/registry.ts, so one copy of every number is hand-maintained.
//
//   node --experimental-strip-types scripts/generate-signal-bounds.ts           # rewrite
//   node --experimental-strip-types scripts/generate-signal-bounds.ts --check   # fail if stale
//
// WHY THE COPY EXISTS — the dashboard has no build step, so public/lib/bounds.js cannot
// import a .ts module (check-waypoint-endpoint.ts:65 says the same about its own four).
// Generating it is what stops the two drifting; before this, a bound lived in a table
// 500 lines from the signal and nothing failed when the line was forgotten.
//
// ⚠️ THE OUTPUT IS RUN THROUGH PRETTIER, and that is what makes a byte comparison safe.
// public/lib/ is NOT in .prettierignore and CI auto-commits Prettier's fixes, so a check
// comparing bytes this script chose would call the file stale the moment Prettier
// reformatted it — a deadlock with no fix short of deleting the check. Rendering through
// prettier.format() with the repo's own config makes this script's output Prettier's
// output, so the two can never disagree. `prettier` is pinned exactly (no caret).
//
// Byte-comparing rather than comparing the parsed table is deliberate: a parsed compare
// pins one export and would miss a hand-added second export, a mutation after the
// literal, a stray console.log on a module every page loads, the DO-NOT-EDIT banner, and
// a duplicate key in the literal (JS keeps the last; the parse sees one).

const GENERATED_PATH = "public/lib/generated-bounds.js";
const generatedUrl = new URL(`../${GENERATED_PATH}`, import.meta.url);

const BANNER = `// @ts-check
// GENERATED FILE — DO NOT EDIT.
//
// Written by scripts/generate-signal-bounds.ts from the \`bounds\` declared beside each
// signal in src/can/registry.ts. Edit it there; \`npm test\` fails if this copy is stale.
// Why the numbers are what they are: docs/signal-bounds.md.`;

export async function renderSignalBounds(): Promise<string> {
  const rows = SIGNALS.filter(signal => signal.bounds !== undefined)
    .map(signal => `  "${signal.key}": [${signal.bounds?.[0]}, ${signal.bounds?.[1]}],`)
    .join("\n");
  // Null-prototyped so a key naming an Object.prototype member cannot resolve through the
  // chain. `boundsFor("constructor")` used to return the Object constructor, which is
  // truthy, so isPlausible() then rejected every reading of it (#246). infokey-bounds.js
  // passes a VENDOR's field names into this lookup, so the miss case must be real.
  const source = `${BANNER}

/** @type {Record<string, [number, number]>} */
export const SIGNAL_BOUNDS = Object.assign(Object.create(null), {
${rows}
});
`;
  const config = await resolveConfig(generatedUrl.pathname);
  return format(source, { ...config, filepath: generatedUrl.pathname });
}

const failures: string[] = [];
const checkOnly = process.argv.includes("--check");
const rendered = await renderSignalBounds();

// Every signal must reach SOME rule, or say why it cannot. This is the ratchet that
// replaces KNOWN_UNGATED in check-all-view-tiles.ts §5: a new signal added with neither a
// bound nor a reason fails here, rather than rendering whatever arrives on the ALL page.
for (const signal of SIGNALS) {
  const viaFallback = fallbackBoundsFor(signal.key, signal.unit, signal.group);
  if (signal.bounds !== undefined && signal.unbounded !== undefined) {
    failures.push(`${signal.key} declares BOTH bounds and unbounded — say which it is`);
    continue;
  }
  if (signal.bounds === undefined && signal.unbounded === undefined && viaFallback === null) {
    failures.push(
      `${signal.key} (group "${signal.group}", unit "${signal.unit}") reaches no rule in ` +
        `public/lib/bounds.js and declares neither bounds nor unbounded, so boundsFor() returns null ` +
        `and the ALL page renders whatever arrives — give it bounds, or unbounded with the kind`
    );
  }
  if (signal.unbounded !== undefined && viaFallback !== null) {
    failures.push(
      `${signal.key} declares unbounded "${signal.unbounded}" but already reaches a rule ` +
        `(${JSON.stringify(viaFallback)}) — the declaration is stale, delete it`
    );
  }
}

if (checkOnly) {
  let committed: string;
  try {
    committed = await readFile(generatedUrl, "utf8");
  } catch (err) {
    committed = "";
    failures.push(`${GENERATED_PATH} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (committed !== "" && committed !== rendered) {
    failures.push(
      `${GENERATED_PATH} is stale — re-run: node --experimental-strip-types scripts/generate-signal-bounds.ts`
    );
  }
} else if (failures.length === 0) {
  await writeFile(generatedUrl, rendered, "utf8");
  console.log(`✓ wrote ${GENERATED_PATH} — ${SIGNALS.filter(s => s.bounds !== undefined).length} bounded signals`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s) with the declared bounds:`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
if (checkOnly) {
  const bounded = SIGNALS.filter(signal => signal.bounds !== undefined).length;
  const unbounded = SIGNALS.filter(signal => signal.unbounded !== undefined).length;
  console.log(`✓ ${GENERATED_PATH} matches the registry (${bounded} bounded)`);
  console.log(`✓ all ${SIGNALS.length} signals reach a rule or say why not (${unbounded} declared unbounded)`);
}
