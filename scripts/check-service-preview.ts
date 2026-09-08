import { Script } from "node:vm";
import { readdir, readFile, unlink } from "node:fs/promises";
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

/**
 * The source of the annotated sheet's `PANELS` array, or null when it is not there.
 *
 * Bracket-counted rather than matched: the entries hold arrays and objects of their own, so
 * any regex for the closing `]` finds one of theirs.
 */
function panelsArray(html: string): string | null {
  const start = html.indexOf("const PANELS = [");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let index = html.indexOf("[", start); index < html.length; index += 1) {
    if (html[index] === "[") {
      depth += 1;
    } else if (html[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, index + 1);
      }
    }
  }
  return null;
}

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
// ⚠️ Every kind is counted, not a named few. The alternation used to list three of the
// four, so the two parameter panels went uncounted and a floor of 5 sat against a count of
// exactly 5 — zero margin, which read as strict and was: any deletion went red, by accident.
// Naming the kinds it counts also makes a panel of a NEW kind invisible to the floor, which
// is the same rot one layer up. The floor is what the sheet declares today, so a panel
// removed on purpose edits this line, one lost by accident goes red, and adding one is free.
const PANELS_DECLARED = 7;
// ⚠️ Read out of the PANELS ARRAY, not off the whole page. `kind:` is also how the write
// targets spell their control type, so a page-wide count sees a `kind: "bits"` that is not a
// panel at all — the trap the paragraph above already names, one line further on.
const kinds = [...(panelsArray(annotated)?.matchAll(/^\s*kind: "([a-z]+)",$/gm) ?? [])].map(match => match[1]);
if (kinds.length < PANELS_DECLARED) {
  failures.push(`the annotated sheet declares ${kinds.length} panels, fewer than the ${PANELS_DECLARED} it should`);
}

// ⚠️ A close-up finds its block by a MARKER INSIDE it (PANEL_BLOCK) rather than by
// position — four :nth-child selectors framed the wrong block in every close-up from
// 2026-08-27 until 2026-09-08, see docs/diagnostics-and-checks.md §11.6. But a marker is
// only a handle while the shipped page still writes that class, and a rename would leave
// every close-up throwing at render — which nothing here can see, because this check
// parses the generated page and never runs it. So the markers are read out of the
// template rather than restated, and each is looked for in the view it points at.
// ⚠️ Every settle() names what it waits for, asserted HERE rather than only by the runtime
// throw beside it — that throw fires in a browser, and this check never opens one. One
// unchanging "timed out waiting for the sheet to settle" is what hid five dead panels for
// twelve days, so a wait added without a description has to fail where somebody is looking.
// Call sites only: not the declaration, and not the `settle()` inside its own error message.
const waits = [...annotated.matchAll(/(?<!function )\bsettle\((?!\))/g)].length;
const described = [...annotated.matchAll(/(?<!function )\bsettle\((?!\))[^;]*?,\s*(?:`|"|'|[A-Za-z_$])/gs)].length;
if (waits > 0 && described !== waits) {
  failures.push(`${waits - described} of the annotated sheet's ${waits} settle() waits do not say what they wait for`);
}

const declaration = /const PANEL_BLOCK = \{([^}]*)\}/.exec(annotated);
if (!declaration) {
  failures.push("the annotated sheet declares no PANEL_BLOCK, so nothing tells a close-up which block it is about");
} else {
  const failuresBefore = failures.length;
  const entries = [...declaration[1].matchAll(/(\w+): "([^"]+)"/g)].map(match => ({
    kind: match[1],
    marker: match[2],
  }));
  // ⚠️ Every close-up kind needs an entry, and only the runtime could say so before: a panel
  // of an unlisted kind throws when it is staged, which nothing in this suite ever does.
  // `key` and `sheet` are the two that render no close-up and so need no block.
  for (const kind of new Set(kinds)) {
    if (kind !== "key" && kind !== "sheet" && !entries.some(entry => entry.kind === kind)) {
      failures.push(`a panel of kind ${kind} has no PANEL_BLOCK marker, so it would throw as soon as it is staged`);
    }
  }
  // ⚠️ Every view, not `vcu-write.js` by name. The close-ups all point into that file today,
  // and it is 2 011 lines against CLAUDE.md's ~400 — so the split that file is owed would
  // turn this red while the preview was perfectly fine. Searching the lot also STRENGTHENS
  // the count: uniqueness now means unique in everything the bundle can render, not in one file.
  // Sorted: readdir order is the filesystem's, and the ambiguity message below names the
  // files it found, which should read the same on every machine.
  const views = (await readdir(new URL("../public/views", import.meta.url))).sort();
  const sources = await Promise.all(
    views
      .filter(name => name.endsWith(".js"))
      .map(async name => ({ name, text: await readFile(new URL(`../public/views/${name}`, import.meta.url), "utf8") }))
  );
  for (const { marker } of entries) {
    // ⚠️ Matched as tag PLUS class PLUS a count of exactly one, and every part was bought
    // with a mutation that got past the version before it. The class must be a whole token
    // (`\brisk-fold\b` is also satisfied by `risk-fold-caret`, a span on the same control).
    // The tag must be there (`probe-input` is written three times: a <select>, a <div> and
    // an <input>). And the count must be ONE, because tag-plus-class is written twice for
    // `select.probe-input` — so renaming just the picker a close-up holds left this green
    // while both form panels died at render. Uniqueness is what makes a rename unmissable.
    const parts = marker.split(".");
    const [tag, className] = parts;
    if (parts.length !== 2 || !tag || !className) {
      failures.push(`${marker} is not the tag.class a close-up marker has to be`);
      continue;
    }
    const token = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${tag}\\(\\s*\\{[^{}]*class: "(?:[^"]*\\s)?${token}(?:\\s[^"]*)?"`, "g");
    const sites = sources.flatMap(source => (source.text.match(pattern) ?? []).map(() => source.name));
    if (sites.length !== 1) {
      failures.push(
        sites.length === 0
          ? `the close-ups scope by ${marker}, but no view in public/views/ builds a <${tag}> with class ${className}`
          : `${marker} is built ${sites.length} times (${[...new Set(sites)].join(", ")}), so this check can no longer ` +
              "see a rename of the one a close-up holds — give that element a class of its own, or pick a marker written once"
      );
    }
  }
  // ⚠️ `failures.length` and not a substring test. An earlier spelling matched two of this
  // section's three messages, so the ambiguity failure printed a ✓ directly above its own ✗ —
  // which is the mistake this file already corrects for itself, forty lines up.
  if (failures.length === failuresBefore) {
    console.log(`  close-up markers still written by a view: ${entries.map(entry => entry.marker).join(", ")}`);
  }
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  \u2717 ${failure}`);
  }
  process.exit(1);
}
console.log("\n\u2713 both previews parse, no placeholder left unreplaced");
