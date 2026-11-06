import { Script } from "node:vm";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Parse the actual generated bundle: the placeholder/comma regression and the
// reason syntax alone does not prove it mounts are recorded in docs/diagnostics-and-checks.md §11.6.

const run = promisify(execFile);
const out = join(tmpdir(), "cool-eva-preview-check.html");
const failures: string[] = [];
const built = new Map<string, string>();

console.log("\n──── scripts/check-service-preview.ts ──────────────────────────────────────────");
console.log("     that the generated dashboard fixture are syntactically valid JavaScript");

for (const flags of [[]]) {
  const label = "whole dashboard";
  await run("node", ["--experimental-strip-types", "scripts/build-service-preview.ts", out, ...flags]);
  const html = await readFile(out, "utf8");
  await unlink(out);

  // ⚠️ A pattern, not a list. This named two of what are now four placeholders — it never covered
  // __TABLES__ and would not have covered __SERVER_FACTS__ — and `String.replace` substitutes only
  // the FIRST occurrence, so a template that grew a second copy of one (the two are copy-edited)
  // ships a bare identifier that parses fine here and throws a ReferenceError at load.
  for (const [placeholder] of html.matchAll(/__[A-Z][A-Z_]*__/g)) {
    failures.push(`${label}: ${placeholder} survived into the output — a substitution did not happen`);
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

const whole = built.get("whole dashboard") ?? "";
if (!/__imp\("app\.js"\)|imp\("app\.js"\)/.test(whole)) {
  failures.push('the whole-app preview never calls imp("app.js"), so it mounts nothing');
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  \u2717 ${failure}`);
  }
  process.exit(1);
}
console.log("\n\u2713 the dashboard fixture parses, no placeholder left unreplaced");
