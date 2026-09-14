import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TABS } from "../public/lib/router.js";
import {
  closePage,
  evaluateOnPage,
  findBrowser,
  gotoPage,
  openHeadlessPage,
  waitOnPage,
  type HeadlessPage,
} from "./headless-page.ts";

// The dashboard fits a 390 px phone — MEASURED in a browser, not argued from the CSS.
//
//   node --experimental-strip-types scripts/check-phone-width.ts
//
// ⚠️ Deliberately NOT in scripts/run-checks.ts. It needs a browser, and `npm test`'s claim
// is that it runs anywhere with no bike and two devDependencies — docs/diagnostics-and-checks.md
// §11.2 and §11.6, which is also where the trade is argued. It runs as its own step in
// .github/workflows/test.yml, on an image that ships Chrome, so every PR is still gated on it.
//
// What it was written for (#253): at 390x844 the Faults tab reported body.scrollWidth 449
// against a 390 px client width. The page scrolled sideways, and in the light theme the
// overflow drew as black bars down the side of the tiles. Nothing in the tree was misbehaving
// — a `min-width: auto` tile floored its column at 440.6 px, the grid that held it could not
// go below 374, and the difference painted past the phone. docs/dashboard-decisions.md has
// the measured chain, and two wrong versions of it before this one.
//
// Hence two assertions rather than one. No tab wider than the phone; AND the row that did
// it still readable in full — because the cheap way to pass the first is an ellipsis, and
// what it would eat is `· freeze frame · expected`, the two suffixes that say why a row
// matters on the one screen meant to be read carefully.
//
// Not covered: the other four scenes (only `faults` has stored-code rows), the themes —
// nothing here depends on the palette — and anything vertical, which is #183.

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** iPhone 14/15/16 at DPR 3, which is what Daniel reads this on. */
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };

/**
 * The row this check exists for, pinned by its text. Without it the width assertion goes
 * vacuous the day the fixture changes: a Faults tab with nothing long on it fits trivially
 * and would report a clean ✓ for a page that had never been tested.
 */
const LONGEST_ROW = "Position lights open circuit fault · freeze frame · expected";

interface Measurement {
  hash: string;
  innerWidth: number;
  clientWidth: number;
  bodyScrollWidth: number;
  widest: string;
  rows: { text: string; clipped: boolean }[];
}

/** Read in the page. `getAttribute` rather than `className`: an SVG's is not a string. */
const MEASURE = `(() => {
  const clientWidth = document.documentElement.clientWidth;
  const widest = [...document.querySelectorAll("*")]
    .map(element => ({
      name: element.tagName + "." + (element.getAttribute("class") ?? ""),
      right: element.getBoundingClientRect().right,
    }))
    .sort((first, second) => second.right - first.right)[0];
  return {
    hash: location.hash,
    innerWidth: window.innerWidth,
    clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    widest: widest === undefined ? "nothing" : widest.name + " right=" + Math.round(widest.right),
    rows: [...document.querySelectorAll(".code-line-text")].map(element => ({
      text: element.textContent,
      clipped: element.scrollWidth > element.clientWidth + 0.5,
    })),
  };
})()`;

/**
 * A deliberately synthetic probe, run in the page and undone again.
 *
 * Once the description wraps, nothing the bike can actually store has a min-content wide
 * enough to widen anything — so no fixture can falsify the OTHER half of #253's fix,
 * `.tile { min-width: 0 }`. This puts content in the tile that cannot wrap by construction
 * and asks the one question that line answers: is the tile's BOX still the phone's width, or
 * has its content been allowed to set it? ⚠️ The box, not the page: unbreakable content still
 * paints past the tile either way, and the body reports 3878 px in both. Nothing in CSS stops
 * that without clipping, which is why the row above is the assertion that guards the phone.
 */
const PROBE = `(() => {
  const tile = [...document.querySelectorAll(".tile")].find(candidate => candidate.querySelector(".code-line-text"));
  if (tile === undefined) {
    throw new Error("no stored-code tile on the faults tab to probe");
  }
  const probe = document.createElement("span");
  probe.style.whiteSpace = "nowrap";
  probe.textContent = "unbreakable ".repeat(40).replaceAll(" ", "-");
  tile.append(probe);
  // Against the VIEWPORT, not against the group: the group is sized by the tile it holds, so
  // the two agree all the way to 3883 px and comparing them can never fail.
  const widths = {
    tile: Math.round(tile.getBoundingClientRect().width),
    viewport: document.documentElement.clientWidth,
  };
  probe.remove();
  return widths;
})()`;

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

const browserPath = await findBrowser();
if (browserPath === null) {
  console.error("✗ no browser to measure in — install Chrome or Chromium, or set CHROME_PATH to one.");
  console.error("  Nothing was measured, so nothing is claimed. This check does not pass by default.");
  process.exit(1);
}

const workspace = await mkdtemp(join(tmpdir(), "cool-eva-phone-width-"));
const previewFile = join(workspace, "dashboard.html");
// The committed template and the shipped public/ — the same page `npm run preview` builds
// for the dashboard gate, so what is asserted here is what a person looks at there.
await run(
  process.execPath,
  ["--experimental-strip-types", join(ROOT, "scripts/build-service-preview.ts"), previewFile],
  {
    cwd: ROOT,
  }
);
console.log(
  `\nmeasuring ${previewFile} at ${PHONE.width}x${PHONE.height} DPR ${PHONE.deviceScaleFactor} in ${browserPath}`
);

const page = await openHeadlessPage(PHONE, browserPath);
try {
  await sweepTabs(page, previewFile);
} finally {
  await closePage(page);
  await rm(workspace, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log(`\n✓ every tab fits a ${PHONE.width} px phone, and the longest stored-code row is readable in full`);

/**
 * Every tab of the faults scene, one page load each.
 *
 * A load rather than a hash flip, because the two are not the same test: a flip measures
 * whatever the previous tab left behind if the render is a frame late, and this is the
 * cheap way to be certain the measurement belongs to the tab it is filed under.
 */
async function sweepTabs(page: HeadlessPage, previewFile: string) {
  // An empty bar would sweep nothing and exit 0 — the one shape of this check that could
  // pass without measuring anything. scripts/check-tab-routing.ts owns the names themselves.
  check(`there are tabs to sweep (${TABS.length})`, TABS.length > 0);
  for (const tab of TABS) {
    await gotoPage(page, `file://${previewFile}?scene=faults#${tab.name}`);
    await waitOnPage(page, `document.querySelectorAll(".view > *").length > 0`, `the ${tab.name} tab to render`);
    const measured = asMeasurement(await evaluateOnPage(page, MEASURE));
    console.log(
      `\n${tab.name}: body.scrollWidth ${measured.bodyScrollWidth} · innerWidth ${measured.innerWidth} · ` +
        `widest ${measured.widest}`
    );
    // ⚠️ The bike is allowed to move the screen (lib/view-rules.js), and a measurement of
    // the tab it moved to, filed under the tab that was asked for, is worse than no
    // measurement. Nothing in the parked faults scene should spend a move; if one does,
    // this says so rather than quietly reporting the wrong tab's width.
    check(`${tab.name} is the tab that rendered`, measured.hash === `#${tab.name}`);
    // documentElement.clientWidth is the viewport itself: if emulation had not taken, or a
    // scrollbar were eating 15 px, every width below would be measured against the wrong page.
    check(`${tab.name} is being measured at ${PHONE.width} px`, measured.clientWidth === PHONE.width);
    check(
      `${tab.name} does not scroll sideways (${measured.bodyScrollWidth} ≤ ${measured.clientWidth})`,
      measured.bodyScrollWidth <= measured.clientWidth
    );
    // The layout viewport EXPANDS to fit a page that overflows, so this witnesses the same
    // defect from the other side: 449 before #253, on a viewport asked for at 390.
    check(
      `${tab.name} did not widen the layout viewport (innerWidth ${measured.innerWidth})`,
      measured.innerWidth === PHONE.width
    );
    if (tab.name === "faults") {
      checkStoredCodeRows(measured);
      checkTileIsSizedByThePhone(asTileWidths(await evaluateOnPage(page, PROBE)));
    }
  }
}

/** The stored-code list, which is where #253 came from. */
function checkStoredCodeRows(measured: Measurement) {
  const longest = measured.rows.find(row => row.text === LONGEST_ROW);
  check(`the fixture still carries the row that caused #253 ("${LONGEST_ROW}")`, longest !== undefined);
  if (longest === undefined) {
    console.error(`    what the tab lists instead: ${measured.rows.map(row => JSON.stringify(row.text)).join(", ")}`);
    return;
  }
  check("that row is readable in full — not clipped to an ellipsis", !longest.clipped);
  const clipped = measured.rows.filter(row => row.clipped);
  check(`none of the ${measured.rows.length} rows is clipped`, clipped.length === 0);
  if (clipped.length > 0) {
    console.error(`    clipped: ${clipped.map(row => JSON.stringify(row.text)).join(", ")}`);
  }
}

/** What the probe above is for: the tile is sized by the viewport, not by what is in it. */
function checkTileIsSizedByThePhone(widths: { tile: number; viewport: number }) {
  check(
    `content that cannot wrap does not widen the stored-codes tile (${widths.tile} ≤ ${widths.viewport})`,
    widths.tile <= widths.viewport
  );
}

function asTileWidths(value: unknown): { tile: number; viewport: number } {
  if (typeof value !== "object" || value === null) {
    throw new Error(`the probe answered with ${JSON.stringify(value)} rather than two widths`);
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.tile !== "number" || typeof fields.viewport !== "number") {
    throw new Error(`the probe answered with an incomplete pair of widths: ${JSON.stringify(value)}`);
  }
  return { tile: fields.tile, viewport: fields.viewport };
}

/** Throws rather than narrows: a selector that stopped matching must not read as a pass. */
function asMeasurement(value: unknown): Measurement {
  if (typeof value !== "object" || value === null) {
    throw new Error(`the page answered with ${JSON.stringify(value)} rather than a measurement`);
  }
  const fields = value as Record<string, unknown>;
  const rows = fields.rows;
  if (
    typeof fields.hash !== "string" ||
    typeof fields.innerWidth !== "number" ||
    typeof fields.clientWidth !== "number" ||
    typeof fields.bodyScrollWidth !== "number" ||
    typeof fields.widest !== "string" ||
    !Array.isArray(rows)
  ) {
    throw new Error(`the page answered with an incomplete measurement: ${JSON.stringify(value)}`);
  }
  return {
    hash: fields.hash,
    innerWidth: fields.innerWidth,
    clientWidth: fields.clientWidth,
    bodyScrollWidth: fields.bodyScrollWidth,
    widest: fields.widest,
    rows: rows.map(asRow),
  };
}

function asRow(value: unknown): { text: string; clipped: boolean } {
  if (typeof value !== "object" || value === null) {
    throw new Error(`a stored-code row came back as ${JSON.stringify(value)}`);
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.text !== "string" || typeof fields.clipped !== "boolean") {
    throw new Error(`a stored-code row came back malformed: ${JSON.stringify(value)}`);
  }
  return { text: fields.text, clipped: fields.clipped };
}
