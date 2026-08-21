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
// Both variants are built. The annotated one is only reachable with a flag, which is
// precisely how it would rot without anyone noticing.

const run = promisify(execFile);
const out = join(tmpdir(), "cool-eva-preview-check.html");
const failures: string[] = [];
const built = new Map<string, string>();

console.log("\n──── scripts/check-service-preview.ts ──────────────────────────────────────────");
console.log("     that both generated design previews are syntactically valid JavaScript");

for (const flags of [[], ["--annotated"]]) {
  const label = flags.length > 0 ? "annotated sheet" : "whole dashboard";
  await run("node", ["--experimental-strip-types", "scripts/build-service-preview.ts", out, ...flags]);
  const html = await readFile(out, "utf8");
  await unlink(out).catch(() => {});

  for (const placeholder of ["__CSS__", "__MODULES__"]) {
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
if (whole === annotated) {
  failures.push("both variants produced identical output — the --annotated flag is not selecting a different template");
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
console.log("\n\u2713 both previews parse, no placeholder left unreplaced");
