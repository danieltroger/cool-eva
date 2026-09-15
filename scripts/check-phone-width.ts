import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TABS } from "../public/lib/router.js";
import { sceneNamesIn } from "./preview-scenes.ts";
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
// ⚠️ Deliberately NOT in scripts/run-checks.ts. It needs a browser, and `npm test`'s claim is
// that it runs anywhere with no bike and two devDependencies — docs/diagnostics-and-checks.md
// §11.2 and §11.8, which is where that trade is argued. `npm run check:phone-width`, and its
// own CI job in .github/workflows/dashboard.yml, on an image that ships Chrome.
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
// What it deliberately does not cover — both themes, WebKit, the menu sheet, anything
// vertical — is listed once, in docs/diagnostics-and-checks.md §11.8.

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
  const widest = [...document.querySelectorAll("*")].reduce((furthest, element) => {
    const right = element.getBoundingClientRect().right;
    return furthest === null || right > furthest.right
      ? { name: element.tagName + "." + (element.getAttribute("class") ?? ""), right }
      : furthest;
  }, null);
  return {
    hash: location.hash,
    innerWidth: window.innerWidth,
    clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    widest: widest === null ? "nothing" : widest.name + " right=" + Math.round(widest.right),
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

interface SheetMeasurement {
  open: boolean;
  clientWidth: number;
  bodyScrollWidth: number;
  bodyClientWidth: number;
  widestRowRight: number;
  rows: string[];
}

/**
 * The menu sheet, measured from INSIDE itself.
 *
 * ⚠️ `body.scrollWidth` cannot witness this surface at all: `.sheet` is `position: fixed;
 * inset: 0`, so a fixed subtree contributes nothing to the document's scrollable overflow,
 * and `.sheet-body` is `width: 100%` of that — its border box IS the viewport whatever it
 * holds. So the question has to be asked the way the page asks it of the body: does the
 * sheet's own content scroll inside it? `overflow-y: auto` makes `overflow-x` compute to
 * `auto` too, which is exactly where a too-wide row goes to hide.
 *
 * The per-row right edge is the second witness, from outside the scroll container: an
 * overflowing child keeps its real laid-out box, so its rect extends past the phone even
 * though the box holding it does not.
 */
const SHEET = `(() => {
  const sheet = document.querySelector(".sheet");
  const body = document.querySelector(".sheet-body");
  if (sheet === null || body === null) {
    throw new Error("no menu sheet in the page to measure");
  }
  const rows = [...document.querySelectorAll(".waypoint-row")];
  return {
    open: sheet.classList.contains("open"),
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: body.scrollWidth,
    bodyClientWidth: body.clientWidth,
    widestRowRight: Math.round(rows.reduce((furthest, row) => Math.max(furthest, row.getBoundingClientRect().right), 0)),
    rows: rows.map(row => row.textContent),
  };
})()`;

/**
 * The same synthetic-probe argument the stored-codes tile gets, for the sheet.
 *
 * Nothing a waypoint row can really hold is an unbreakable token — a coordinate has a space
 * in it and every refusal sentence breaks at spaces — so no fixture can falsify
 * `.waypoint-body { overflow-wrap: anywhere }`. Energica's identifiers are exactly that
 * shape, which is why the rule is there and why the probe uses one.
 *
 * ⚠️ It measures the SCROLL CONTAINER, not the row. A row is a block inside a block, so its
 * box is its containing block's width whatever it holds — 372 px with or without the rule,
 * which is an assertion that cannot fail. The overflow is visible one level up: 969 px of
 * `.sheet-body` scrollWidth without the rule against 390 with it, measured.
 */
const ROW_PROBE = `(() => {
  const body = document.querySelector(".sheet-body");
  const target = document.querySelector(".waypoint-row .waypoint-body");
  if (body === null || target === null) {
    throw new Error("no waypoint row to probe");
  }
  const probe = document.createElement("span");
  probe.textContent = "a" + "WaterPumpCurrentInEnergicaIdentifier".repeat(4);
  target.append(probe);
  const widths = { sheet: body.scrollWidth, viewport: body.clientWidth };
  probe.remove();
  return widths;
})()`;

/**
 * The row this half of the check exists for, pinned by its text — the same argument
 * LONGEST_ROW makes above. A list of four short coordinates fits trivially and would report
 * a clean ✓ for a sheet nothing had tested; at 74 characters this is the longest sentence
 * in WAYPOINT_REFUSAL_TEXT, so it is the row that decides whether the list fits.
 */
const LONGEST_REFUSAL = "GPS fix jumped somewhere the bike cannot have ridden — waypoint not saved.";

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
// Read out of the built page rather than listed here, so a scene added to the template is
// swept without anyone remembering to add it — the same call build-service-preview.ts makes.
const SCENES = sceneNamesIn(await readFile(previewFile, "utf8"), "check-phone-width");
console.log(
  `\nmeasuring ${previewFile} at ${PHONE.width}x${PHONE.height} DPR ${PHONE.deviceScaleFactor} in ${browserPath}\n` +
    `  ${SCENES.length} scenes x ${TABS.length} tabs: ${SCENES.join(", ")}`
);

// The page is opened INSIDE the try: a launch that throws half-way has already made a
// profile directory and this one, and neither should outlive the run.
let page: HeadlessPage | null = null;
try {
  page = await openHeadlessPage(PHONE, browserPath);
  await sweep(page, previewFile);
} finally {
  if (page !== null) {
    await closePage(page);
  }
  await rm(workspace, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log(
  `\n✓ ${SCENES.length * TABS.length} scene/tab combinations fit a ${PHONE.width} px phone, ` +
    "the longest stored-code row is readable in full, and the menu sheet — which none of those " +
    "measurements can see — does not scroll sideways with the waypoint list open"
);

/**
 * Every tab of every scene, one real page load each.
 *
 * ⚠️ `&tab=` is inert — the template reads only `scene` — and it is there to make each URL
 * differ OUTSIDE the fragment. A fragment-only navigation is a same-document navigation:
 * the page is not reloaded, `readyState` is already `complete`, the wait below does not
 * wait, and what gets measured is the previous tab's DOM if the re-render is a frame late.
 * Proved rather than assumed: a marker set on `window` survives `#faults` → `#ride` and is
 * gone when the query string changes.
 *
 * All five scenes, because four of the five tabs render almost nothing off the parked bike
 * the `faults` scene inherits — no charge session, no refusal, no derate hatching — and a
 * width guard blind to the panels it is guarding is the failure the preview template's own
 * header warns about.
 */
async function sweep(page: HeadlessPage, previewFile: string) {
  // An empty bar or an empty scene list would sweep nothing and exit 0 — the one shape of
  // this check that could pass without measuring anything. scripts/check-tab-routing.ts owns
  // the tab names themselves.
  check(`there are tabs to sweep (${TABS.length})`, TABS.length > 0);
  check(`there are scenes to sweep (${SCENES.length})`, SCENES.length > 0);
  for (const scene of SCENES) {
    for (const tab of TABS) {
      await measureTab(page, previewFile, scene, tab.name);
    }
  }
  // ⚠️ ONE scene, deliberately: the sheet is the same sheet behind every one of them, and
  // sweeping 25 of it would buy nothing but wall-clock. It is measured at all because it is
  // the surface the assertions above CANNOT see — §11.8 of docs/diagnostics-and-checks.md,
  // which named this as the gap for as long as it was one.
  await measureSheet(page, previewFile, SCENES[0]);
}

/**
 * Opens the menu sheet and measures inside it.
 *
 * ⚠️ THE CLICK IS AN ASSERTION, not a convenience. `.sheet` is `visibility: hidden`, not
 * `display: none`, so the sheet and every row in it have full layout boxes whether or not
 * anything ever opened it — every measurement below passes on a sheet nobody opened. Hence
 * the `open` check first: a `.menu` button that stopped opening the sheet must go red here
 * rather than green.
 */
async function measureSheet(page: HeadlessPage, previewFile: string, scene: string) {
  const where = `${scene}/sheet`;
  // `&sheet=1` is inert, exactly like `&tab=` above — the template reads only `scene`, and
  // its whole job is to make this URL differ outside the fragment so the page really reloads.
  // The CLICK below is what opens the sheet.
  await gotoPage(page, `file://${previewFile}?scene=${scene}&sheet=1#ride`);
  await waitOnPage(page, `document.querySelectorAll(".view > *").length > 0`, `the ${where} page to render`);
  await evaluateOnPage(page, `document.querySelector(".header .menu").click()`);
  // ⚠️ Waited on WITHOUT `.sheet.open`, deliberately. The rows are in the DOM whether or not
  // anything opened the sheet, so waiting on the open class would turn the assertion below
  // into a timeout with a vaguer reason — and the point of that assertion is to name what
  // went wrong when every width still reads fine on a sheet nobody can see.
  await waitOnPage(page, `document.querySelectorAll(".waypoint-row").length > 0`, `the ${where} to render its list`);
  const collapsed = asSheetMeasurement(await evaluateOnPage(page, SHEET));
  check(`${where} really opened — every width below is measured on a hidden sheet otherwise`, collapsed.open);
  // ⚠️ Measured EXPANDED, because the row that decides this — the longest refusal sentence —
  // is older than the six the list previews, and a check that never opened the list would
  // report a clean ✓ for the rows nobody had measured. The toggle is asserted rather than
  // assumed: it is also what says the preview is real, and clicking a `null` would fail
  // this run with a stack trace instead of a sentence.
  const toggles = await evaluateOnPage(page, `document.querySelectorAll(".waypoint-list .code-toggle").length`);
  check(`${where}'s list previews fewer rows than the bike served — there is a "show all" to press`, toggles === 1);
  if (toggles === 1) {
    await evaluateOnPage(page, `document.querySelector(".waypoint-list .code-toggle").click()`);
    await waitOnPage(
      page,
      `document.querySelectorAll(".waypoint-row").length > ${collapsed.rows.length}`,
      `the ${where}'s waypoint list to expand past its ${collapsed.rows.length}-row preview`
    );
  }
  const measured = asSheetMeasurement(await evaluateOnPage(page, SHEET));
  console.log(
    `\n${where}: sheet-body.scrollWidth ${measured.bodyScrollWidth} · clientWidth ${measured.bodyClientWidth} · ` +
      `widest waypoint row right edge ${measured.widestRowRight} · ${collapsed.rows.length} rows previewed, ` +
      `${measured.rows.length} shown`
  );
  check(
    `${where} really did expand (${collapsed.rows.length} rows previewed, ${measured.rows.length} shown)`,
    collapsed.rows.length < measured.rows.length
  );
  check(`${where} is being measured at ${PHONE.width} px`, measured.clientWidth === PHONE.width);
  check(
    `${where} does not scroll sideways inside itself (${measured.bodyScrollWidth} ≤ ${measured.bodyClientWidth})`,
    measured.bodyScrollWidth <= measured.bodyClientWidth
  );
  check(
    `${where}'s widest waypoint row ends inside the phone (${measured.widestRowRight} ≤ ${measured.clientWidth})`,
    measured.widestRowRight <= measured.clientWidth
  );
  check(
    `the fixture still carries the longest refusal sentence ("${LONGEST_REFUSAL.slice(0, 32)}…")`,
    measured.rows.some(row => row.includes(LONGEST_REFUSAL))
  );
  const probed = asProbeWidths(await evaluateOnPage(page, ROW_PROBE), "sheet");
  check(
    `an unbreakable name in a row does not scroll the sheet sideways (${probed.measured} ≤ ${probed.viewport})`,
    probed.measured <= probed.viewport
  );
}

async function measureTab(page: HeadlessPage, previewFile: string, scene: string, tab: string) {
  const where = `${scene}/${tab}`;
  await gotoPage(page, `file://${previewFile}?scene=${scene}&tab=${tab}#${tab}`);
  await waitOnPage(page, `document.querySelectorAll(".view > *").length > 0`, `the ${where} tab to render`);
  const measured = asMeasurement(await evaluateOnPage(page, MEASURE));
  console.log(
    `\n${where}: body.scrollWidth ${measured.bodyScrollWidth} · innerWidth ${measured.innerWidth} · ` +
      `widest ${measured.widest}`
  );
  // ⚠️ The bike is allowed to move the screen (lib/view-rules.js) — plugging in takes you
  // to Charge — and a measurement of the tab it moved to, filed under the tab that was
  // asked for, is worse than no measurement. This says so instead.
  check(`${where} is the tab that rendered`, measured.hash === `#${tab}`);
  // documentElement.clientWidth is the viewport itself: if emulation had not taken, or a
  // scrollbar were eating 15 px, every width below would be measured against the wrong page.
  check(`${where} is being measured at ${PHONE.width} px`, measured.clientWidth === PHONE.width);
  check(
    `${where} does not scroll sideways (${measured.bodyScrollWidth} ≤ ${measured.clientWidth})`,
    measured.bodyScrollWidth <= measured.clientWidth
  );
  // The layout viewport EXPANDS to fit a page that overflows, so this witnesses the same
  // defect from the other side: 449 before #253, on a viewport asked for at 390.
  check(
    `${where} did not widen the layout viewport (innerWidth ${measured.innerWidth})`,
    measured.innerWidth === PHONE.width
  );
  if (scene === "faults" && tab === "faults") {
    checkStoredCodeRows(measured);
    const probed = asProbeWidths(await evaluateOnPage(page, PROBE), "tile");
    check(
      `content that cannot wrap does not widen the stored-codes tile (${probed.measured} ≤ ${probed.viewport})`,
      probed.measured <= probed.viewport
    );
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

/**
 * ⚠️ Named per probe rather than shared. One shape carrying both would let a probe that
 * answered with the wrong field pass by reading the other one's number.
 * @param field which box this probe measured
 */
function asProbeWidths(value: unknown, field: "tile" | "sheet"): { measured: number; viewport: number } {
  const fields = fieldsOf(value, "the probe's answer");
  if (typeof fields[field] !== "number" || typeof fields.viewport !== "number") {
    throw new Error(`the ${field} probe answered with an incomplete pair of widths: ${JSON.stringify(value)}`);
  }
  return { measured: fields[field], viewport: fields.viewport };
}

/** Throws rather than narrows, for the reason asMeasurement() does. */
function asSheetMeasurement(value: unknown): SheetMeasurement {
  const fields = fieldsOf(value, "the sheet's measurement");
  const rows = fields.rows;
  if (
    typeof fields.open !== "boolean" ||
    typeof fields.clientWidth !== "number" ||
    typeof fields.bodyScrollWidth !== "number" ||
    typeof fields.bodyClientWidth !== "number" ||
    typeof fields.widestRowRight !== "number" ||
    !Array.isArray(rows)
  ) {
    throw new Error(`the sheet answered with an incomplete measurement: ${JSON.stringify(value)}`);
  }
  return {
    open: fields.open,
    clientWidth: fields.clientWidth,
    bodyScrollWidth: fields.bodyScrollWidth,
    bodyClientWidth: fields.bodyClientWidth,
    widestRowRight: fields.widestRowRight,
    rows: rows.map(row => (typeof row === "string" ? row : "")),
  };
}

/** Throws rather than narrows: a selector that stopped matching must not read as a pass. */
function asMeasurement(value: unknown): Measurement {
  const fields = fieldsOf(value, "the page's measurement");
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

/** The one shape every reply from the page has to have before anything is read out of it. */
function fieldsOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${what} came back as ${JSON.stringify(value)} rather than an object`);
  }
  return value as Record<string, unknown>;
}

function asRow(value: unknown): { text: string; clipped: boolean } {
  const fields = fieldsOf(value, "a stored-code row");
  if (typeof fields.text !== "string" || typeof fields.clipped !== "boolean") {
    throw new Error(`a stored-code row came back malformed: ${JSON.stringify(value)}`);
  }
  return { text: fields.text, clipped: fields.clipped };
}
