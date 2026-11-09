import assert from "node:assert/strict";
import { evaluateOnPage, reloadPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import { assertFixedLayout, assertRendered } from "./riding-layout-browser.ts";
import { checkFaultsCases } from "./riding-faults-browser.ts";
export { assertFaultsContent, checkFaultNavigation as checkFaultReportNavigation } from "./riding-faults-browser.ts";

const SNAPSHOT = ["pack_kw", "soc", "gps_speed_kmh", "batt_temp_hi", "cell_min_mv", "allowed_discharge_a"];
type Capture = (name: string) => Promise<void>;

export async function assertAllContent(page: HeadlessPage, includeRaw = true) {
  await assertRendered(page, [
    ...SNAPSHOT.map(key => `[data-snapshot="${key}"] .value`),
    ".all-landing input[aria-label='Filter raw signals']",
    ".all-history-row .sub",
  ]);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.all-history-row button,.all-history-row a')"),
    null,
    "All has no Battery history CTA."
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('[data-snapshot]')].map(tile=>tile.querySelector('.value').textContent)"
    ),
    ["-48.3 kW", "46 %", "87 km/h", "41 °C", "3120 mV", "210 A"]
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-snapshot=pack_kw] .label').textContent"),
    "pack_kw (raw)"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-snapshot=pack_kw] .sub').textContent"),
    "− out · + in"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.all-landing').getBoundingClientRect().height"),
    504
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "document.querySelector('.all-raw').getBoundingClientRect().top>=document.querySelector('.all-landing').getBoundingClientRect().bottom"
    ),
    true
  );
  if (includeRaw) {
    await assertRendered(page, [".all-raw .raw-grid", ".all-raw .raw-key"]);
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.all-raw .raw-key')].map(element=>element.textContent==='pack_kw (raw)'?'pack_kw':element.textContent).sort()"
      ),
      await evaluateOnPage(page, "[...ridingPreview('lib/store.js').knownKeys.rawVal].sort()"),
      "Every populated raw signal must render, including all 81 cells and installed sensors."
    );
    await assertRawPower(page, "-48.30 kW");
  }
  await assertRawPowerInk(page);
}

export async function checkFaultsAllCases(page: HeadlessPage, file: string, theme: string, capture?: Capture) {
  await checkFaultsCases(page, file, theme);
  await openPreview(page, file, "#all", `all-filter-${theme}`);
  await setTheme(page, theme);
  await assertAllContent(page);
  await assertFixedLayout(page, true);
  await capture?.(`all-${theme}`);
  await evaluateOnPage(page, "window.scrollTo(0,document.scrollingElement.scrollHeight)");
  assert.ok(Number(await evaluateOnPage(page, "scrollY")) > 0, "The complete parked raw data remains scrollable.");
  assert.equal(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.all-raw .raw-key')].at(-1).getBoundingClientRect().bottom<=document.querySelector('.tabs').getBoundingClientRect().top"
    ),
    true
  );
  await evaluateOnPage(page, "window.scrollTo(0,0)");
  await evaluateOnPage(
    page,
    "window.snapshotNode=document.querySelector('.all-landing');(()=>{const input=document.querySelector('.all-landing input');input.value='nothing-matches-this';input.dispatchEvent(new Event('input',{bubbles:true}));})()"
  );
  await evaluateOnPage(page, FRAME);
  await assertAllContent(page, false);
  assert.equal(
    await evaluateOnPage(
      page,
      "window.snapshotNode===document.querySelector('.all-landing') && document.querySelector('.all-raw').innerText==='nothing matches'"
    ),
    true,
    "Filtering narrows raw/lifetime detail without replacing the live snapshot."
  );
  await assertFixedLayout(page, true);
  await evaluateOnPage(
    page,
    "(()=>{const input=document.querySelector('.all-landing input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));pushPatch({fan_target_pct:[68,'%','fan',Date.now()-60000],charge_cmd_a:[32,'A','charge',Date.now()-60000],waypoint_seq:[4,'','waypoint',Date.now()-60000],ambient_temp:[17,'°C','obd',Date.now()-60000]});})()"
  );
  await evaluateOnPage(page, FRAME);
  for (const key of ["fan_target_pct", "charge_cmd_a", "waypoint_seq"]) {
    assert.equal(await rawStale(page, key), false, `Steady onDemand ${key} remains live.`);
  }
  assert.equal(await rawStale(page, "ambient_temp"), true, "Measured sensors retain their age test.");
  await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').connection.val='offline'");
  await evaluateOnPage(page, FRAME);
  for (const key of ["fan_target_pct", "charge_cmd_a", "waypoint_seq"]) {
    assert.equal(await rawStale(page, key), true, `Link loss dims ${key}.`);
  }
  await evaluateOnPage(page, "pausePreviewMessages(false);pushPatch({pack_kw:[12.3,'kW','battery']})");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-snapshot=pack_kw] .value').textContent"),
    "+12.3 kW"
  );
  await assertRawPower(page, "+12.30 kW");
  await assertRawPowerInk(page);
  await capture?.(`all-positive-${theme}`);
  await evaluateOnPage(
    page,
    "ridingPreview('lib/store.js').signalState('motor_temp_c').val=null;ridingPreview('lib/store.js').signalState('fan_target_pct').val=null;pushPatch({motor_temp_c:[999,'°C','motor'],fan_target_pct:[150,'%','fan'],horn:[193,'','controls']})"
  );
  await evaluateOnPage(page, FRAME);
  for (const [key, rejected] of [
    ["motor_temp_c", "⚠ 999"],
    ["fan_target_pct", "⚠ 150"],
    ["horn", "⚠ 193"],
  ]) {
    assert.equal(await rawStale(page, key), false, `Fault-only ${key} must not be styled as stale.`);
    assert.equal(
      await evaluateOnPage(page, `ridingPreview('lib/store.js').signalState(${JSON.stringify(key)}).rawVal`),
      null,
      "The fault-only fixture has no accepted sample."
    );
    assert.equal(await evaluateOnPage(page, `${rawTile(key)}.querySelector('.raw-value').textContent`), rejected);
  }
  await evaluateOnPage(page, "pushPatch({batt_temp_hi:[200,'°C','battery']})");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-snapshot=batt_temp_hi] .value').textContent"),
    "fault"
  );
  await assertFixedLayout(page, true);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.all-history-row button,.all-history-row a')"),
    null,
    "The retired Battery history CTA is gone."
  );
}

async function setTheme(page: HeadlessPage, theme: string) {
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await evaluateOnPage(page, FRAME);
}

async function rawStale(page: HeadlessPage, key: string) {
  return evaluateOnPage(page, `${rawTile(key)}.classList.contains('stale')`);
}

async function assertRawPower(page: HeadlessPage, expected: string) {
  await assertRendered(page, [".all-raw .raw-value"]);
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `(()=>{const tile=${rawTile("pack_kw (raw)")};return {value:tile.querySelector('.raw-value').textContent,convention:tile.querySelector('.raw-sub').textContent}})()`
    ),
    { value: expected, convention: "− out · + in" },
    "The raw grid preserves the signed pack_kw value and its sign convention."
  );
}

async function assertRawPowerInk(page: HeadlessPage) {
  assert.equal(
    await evaluateOnPage(
      page,
      "getComputedStyle(document.querySelector('[data-snapshot=pack_kw] .value')).color===getComputedStyle(document.body).color"
    ),
    true,
    "Raw snapshot power uses normal foreground ink for either sign."
  );
}

function rawTile(key: string) {
  return `[...document.querySelectorAll('.all-raw .raw')].find(tile=>tile.querySelector('.raw-key')?.textContent===${JSON.stringify(key)})`;
}
