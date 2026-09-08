import { Script } from "node:vm";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Builds both design previews and PARSES what came out.
//
// ⚠️ This check exists because of a specific failure. The Prettier action reformatted
// the template on push and turned the `__MODULES__` placeholder into `__MODULES__,`;
// the generator emits entries that already end in a comma, so every bundle after that
// carried `},,` and died on "Unexpected token ','". It rendered 0 panels. `npm test`
// stayed green throughout, because nothing here executed the file — it took loading the
// page in a browser to find. `new Script()` catches exactly that with no browser and no
// dependency: it parses without running, so none of the page's own code executes.
//
// Every variant is built. The two behind flags are only reachable with a flag, which is
// precisely how they would rot without anyone noticing.

const run = promisify(execFile);
const out = join(tmpdir(), "cool-eva-preview-check.html");
const failures: string[] = [];
const built = new Map<string, string>();

console.log("\n──── scripts/check-service-preview.ts ──────────────────────────────────────────");
console.log("     that every generated design preview is syntactically valid JavaScript");

const VARIANTS: Array<{ label: string; flags: string[] }> = [
  { label: "whole dashboard", flags: [] },
  { label: "annotated sheet", flags: ["--annotated"] },
  { label: "whole dashboard + controls", flags: ["--controls"] },
];

for (const { label, flags } of VARIANTS) {
  await run("node", ["--experimental-strip-types", "scripts/build-service-preview.ts", out, ...flags]);
  const html = await readFile(out, "utf8");
  await unlink(out).catch(() => {});

  for (const placeholder of ["__CSS__", "__MODULES__", "__CONTROLS__"]) {
    if (html.includes(placeholder)) {
      failures.push(`${label}: ${placeholder} survived into the output — a substitution did not happen`);
    }
  }

  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  if (blocks.length === 0) {
    failures.push(`${label}: no <script> block in the generated file`);
  }
  for (const [index, source] of blocks.entries()) {
    try {
      new Script(source);
    } catch (error) {
      failures.push(`${label}: script block ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The registry is what the `},,` bug emptied WITHOUT making the file invalid, so its
  // size is checked separately from whether the file parses.
  const modules = [...html.matchAll(/"[^"]+": function \(__exports, __imp\)/g)].length;
  if (modules < 20) {
    failures.push(`${label}: only ${modules} modules in the bundle — the registry did not fill`);
  }
  built.set(label, html);
  // ⚠️ Logged AFTER the failures are recorded, not before: an earlier version printed
  // "1 script block(s) parse" directly above "script block 0: Unexpected token ','".
  if (!failures.some(failure => failure.startsWith(label))) {
    console.log(`  ${label}: ${blocks.length} script block(s) parse, ${modules} modules`);
  }
}

// ⚠️ THE TWO VARIANTS MUST ACTUALLY DIFFER. Without this, setting `annotated` to a
// constant builds the whole-app template twice, prints both labels and exits 0 — the
// annotated sheet could rot to nothing and this check would applaud.
const whole = built.get("whole dashboard") ?? "";
const annotated = built.get("annotated sheet") ?? "";
const controlled = built.get("whole dashboard + controls") ?? "";
if (whole === annotated) {
  failures.push("both variants produced identical output — the --annotated flag is not selecting a different template");
}
if (whole === controlled) {
  failures.push("--controls produced the same file as no flag, so it is injecting nothing");
}

// ⚠️ The same "the host existing is not the host being filled" hole as the two below,
// and one more beyond it: a panel that is present but never handed `imp` writes into a
// second, unmounted copy of the store, so every slider moves and NOTHING on the page
// changes. Both halves are asserted because either alone passes while the panel is dead.
if (!controlled.includes("pc-panel")) {
  failures.push("--controls injected no panel markup");
}
if (!/window\.__previewControls\(imp\)/.test(controlled)) {
  failures.push("the controls panel is never handed the module registry, so its sliders would drive nothing");
}
// ⚠️ Asserted INSIDE the panel's own script block, not across the file. Everything ends
// up in one document, `public/lib/store.js` is bundled into it, and store.js writes
// `signalState(key).val = reading` itself — so a whole-file match for the panel writing
// to the store is satisfied by the app's own code and stays green with the panel's
// setter gutted. Found by mutating it; two looser spellings passed before this one.
const panelBlock = [...controlled.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1])
  .find(source => source.includes("__previewControls = function"));
if (panelBlock === undefined) {
  failures.push("no script block defines __previewControls, so the injected panel is inert markup");
} else if (!/signalState\([^)]+\)\.val\s*=/.test(panelBlock)) {
  failures.push("the controls panel never writes to the signal store, so it cannot move the dashboard");
}
// …and the plain build must stay clean, or the flag is decorative.
if (whole.includes("pc-panel")) {
  failures.push("the panel is in the default preview too — --controls is not what puts it there");
}

// ⚠️ And the whole-app page must actually MOUNT the app. Deleting the one line this
// variant exists for — `imp("app.js")` — left every other assertion here green: the
// file parsed, the registry filled, no placeholder survived, and the page rendered
// nothing. That is verbatim the failure this check was written to catch.
if (!/__imp\("app\.js"\)|imp\("app\.js"\)/.test(whole)) {
  failures.push('the whole-app preview never calls imp("app.js"), so it mounts nothing');
}
if (!annotated.includes("pv-panels")) {
  failures.push("the annotated sheet has no panel host, so it renders nothing");
}
// ⚠️ The host EXISTING is not the host being filled. Emptying PANELS renders an
// annotated sheet with zero panels and every other assertion here stays green — the
// annotated twin of the imp("app.js") hole above. Counted rather than merely present.
// Structural, not a text count: a count of `kind:` lines cannot tell which array they
// are in, so gutting PANELS while leaving the entries elsewhere would pass. This asserts
// the declaration itself opens onto an object.
if (!/const PANELS = \[\s*\{/.test(annotated)) {
  failures.push("the annotated sheet's PANELS array is empty — it would render no panels");
}
const panelCount = (annotated.match(/^\s*kind: "(key|sheet|actions)",$/gm) ?? []).length;
if (panelCount < 5) {
  failures.push(`the annotated sheet declares only ${panelCount} panels`);
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  \u2717 ${failure}`);
  }
  process.exit(1);
}
console.log(`\n\u2713 all ${VARIANTS.length} previews parse, no placeholder left unreplaced`);
