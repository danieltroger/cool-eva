import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The shared preview harness: which files it is made of, in which order, and what a template
// has to declare for it to run. scripts/build-service-preview.ts injects it into whichever
// template it picked; scripts/check-preview-fixtures.ts splices it in the same place so it
// reads the fixtures where they now live; scripts/check-preview-harness.ts holds both
// templates to the contract below.
//
// Why there is one harness rather than two hand-kept copies, what the copies had drifted into,
// and what each of the differences between them turned out to be:
// docs/diagnostics-and-checks.md §11.9.

const HERE = dirname(fileURLToPath(import.meta.url));

/** The placeholder the templates carry, and the builder replaces, for the harness. */
export const HARNESS_PLACEHOLDER = "__HARNESS__";

/**
 * The parts, in evaluation order — and that order is the contract, not a filing convention.
 *
 * They are concatenated into ONE script scope, so `const` reaches its temporal dead zone in
 * this order: the bike's fixtures reference `GATE`, which `bike.js` declares above them, and
 * the stubbed `fetch` in `pi.js` calls the write path in `write.js`. Reordering this list is a
 * behaviour change; nothing in the files themselves would tell you so.
 */
export const HARNESS_PARTS = [
  "preview-harness-browser.js",
  "preview-harness-bike.js",
  "preview-harness-write.js",
  "preview-harness-pi.js",
];

/**
 * What every template must declare for the harness to run, and the reason each one cannot
 * simply move into the harness.
 *
 * ⚠️ Exported rather than restated in the check that enforces it. A second copy of this list is
 * one edit away from leaving a seventh name unguarded — the shape that let check-service-
 * preview.ts's `kind:` alternation silently omit `form` panels while its floor went on passing.
 */
export const PAGE_CONTRACT = [
  // Builder placeholders: substituted per template, so they cannot live in a shared file.
  "__TABLES",
  "__MODULES",
  // Also a placeholder, and it must precede the page's SCENES, which reads SERVER.* .
  "SERVER",
  // The bikes THIS page can stand in for. The two pages stand in for different ones — five
  // scenes with whole signal tables on the dashboard, three gate-only ones on the annotated
  // sheet — and the harness only selects between them.
  "SCENES",
  // Which links the harness intercepts: a selector, or null for every link on the page. The
  // annotated sheet scopes to its own `.pv-stage`; the dashboard has no such class, and a
  // filter on it there caught nothing at all.
  "INTERCEPT_LINKS_WITHIN",
  // The page's own endpoints. A hoisted function declaration, so it may sit below the harness
  // that calls it; returns a json() promise, or null to fall through to the rejections.
  "pageFetch",
];

/** Each part's file name and source, in evaluation order. */
export async function harnessParts(): Promise<{ file: string; source: string }[]> {
  return Promise.all(HARNESS_PARTS.map(async file => ({ file, source: await readFile(join(HERE, file), "utf8") })));
}

/** The whole harness as one block of JavaScript, ready to drop into a `<script>`. */
export async function previewHarnessSource(): Promise<string> {
  const parts = await harnessParts();
  return parts.map(part => part.source.trimEnd()).join("\n\n");
}
