import { Script } from "node:vm";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Builds the standalone design preview and PARSES what came out.
//
// ⚠️ This check exists because of a specific failure. The Prettier action reformatted
// scripts/service-preview-template.html on push and turned the `__MODULES__` placeholder
// into `__MODULES__,`; the generator emits entries that already end in a comma, so every
// bundle after that carried `},,` and died on "Unexpected token ','". It rendered 0 panels.
// `npm test` stayed green throughout, because nothing here executed the file — it took
// loading the page in a browser to find. `new Script()` catches exactly that, with no
// browser and no dependency: it parses without running, so none of the page's own code
// executes and there is no DOM to stand up.

const run = promisify(execFile);
const out = join(tmpdir(), "cool-eva-preview-check.html");

console.log("\n──── scripts/check-service-preview.ts ──────────────────────────────────────────");
console.log("     that the generated design preview is syntactically valid JavaScript");

await run("node", ["--experimental-strip-types", "scripts/build-service-preview.ts", out]);
const html = await readFile(out, "utf8");
await unlink(out).catch(() => {});

const failures: string[] = [];

// An unreplaced placeholder means the generator silently no-op'd a substitution.
for (const placeholder of ["__CSS__", "__MODULES__"]) {
  if (html.includes(placeholder)) {
    failures.push(`${placeholder} survived into the output — a substitution did not happen`);
  }
}

const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
if (blocks.length === 0) {
  failures.push("no <script> block in the generated file");
}
for (const [index, source] of blocks.entries()) {
  try {
    new Script(source);
  } catch (error) {
    failures.push(`script block ${index}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The registry is what the `},,` bug emptied without changing the file's validity, so
// its size is checked separately from whether it parses.
const modules = [...html.matchAll(/"[^"]+": function \(__exports, __imp\)/g)].length;
if (modules < 20) {
  failures.push(`only ${modules} modules in the bundle — the registry did not fill`);
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(`\n✓ ${blocks.length} script block(s) parse, ${modules} modules, no placeholder left unreplaced`);
