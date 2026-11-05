import assert from "node:assert/strict";
import { evaluateOnPage, reloadPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import { assertFixedLayout, assertRendered } from "./riding-layout-browser.ts";
import { gesture } from "./riding-navigation-browser.ts";

const SNAPSHOT = ["pack_kw", "soc", "gps_speed_kmh", "batt_temp_hi", "cell_min_mv", "allowed_discharge_a"];
const UNKNOWN_FAULT = "Not in Energica's code table — a code the type-approval document does not list.";
type Capture = (name: string) => Promise<void>;

export async function assertAllContent(page: HeadlessPage, includeRaw = true) {
  await assertRendered(page, [
    ...SNAPSHOT.map(key => `[data-snapshot="${key}"] .value`),
    ".all-landing input[aria-label='Filter raw signals']",
    ".all-history-row button",
  ]);
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

export async function assertFaultsContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "document.querySelector('.faults-view')?.innerText.includes(Object.values(__TABLES['/dtc-table'].codes).sort((left,right)=>right.description.length-left.description.length)[0].description)",
    "the current DTC table's longest complete description"
  );
  await assertRendered(page, [
    ".faults-number",
    "[data-fault-split]",
    ".fault-preview .label",
    ".fault-preview-name",
    ".fault-report-action button",
    ".faults-footnote",
  ]);
  assert.equal(await evaluateOnPage(page, "document.querySelector('.faults-number').textContent"), "3");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-fault-split]').textContent"),
    "2 unexpected · 1 expected"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelectorAll('.fault-preview').length"), 2);
  assert.ok(
    String(await evaluateOnPage(page, "document.querySelector('.faults-footnote').textContent")).startsWith("1 more")
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.faults-view').getBoundingClientRect().height"),
    586
  );
}

export async function checkFaultsAllCases(page: HeadlessPage, file: string, theme: string, capture?: Capture) {
  await openPreview(page, file, "#faults", `fault-summary-${theme}`);
  await setTheme(page, theme);
  await assertFaultsContent(page);
  await assertFixedLayout(page);
  await capture?.(`faults-${theme}`);
  await evaluateOnPage(
    page,
    "window.faultPreviewNode=document.querySelector('.fault-preview'); window.faultPreviewTick=ridingPreview('lib/store.js').chartTick.rawVal"
  );
  await waitOnPage(page, "ridingPreview('lib/store.js').chartTick.rawVal>window.faultPreviewTick", "an age tick");
  assert.equal(
    await evaluateOnPage(page, "window.faultPreviewNode===document.querySelector('.fault-preview')"),
    true,
    "Age ticks must not replace the named previews."
  );
  await evaluateOnPage(
    page,
    "const patch=Object.fromEntries(Object.keys(LIVE).filter(key=>/^dtc_\\d+_\\d+$/.test(key)).map(key=>[key,[0,'','diagnostics']]));pushPatch({...patch,dtc_list_count:[1,'','diagnostics'],dtc_unrecognised_count:[1,'','diagnostics'],dtc_65535_15:[1,'','diagnostics']})"
  );
  await waitOnPage(
    page,
    `document.querySelector('.faults-view').innerText.includes(${JSON.stringify(UNKNOWN_FAULT)})`,
    "the full unknown fault description"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('.faults-number').textContent"), "1");
  assert.match(
    String(await evaluateOnPage(page, "document.querySelector('[data-fault-split]').textContent")),
    /1 unrecognised/
  );
  await assertFixedLayout(page);
  await capture?.(`faults-unknown-${theme}`);
  await evaluateOnPage(
    page,
    "pushPatch({dtc_65535_15:[0,'','diagnostics'],dtc_list_count:[0,'','diagnostics'],dtc_unrecognised_count:[0,'','diagnostics']})"
  );
  await evaluateOnPage(page, FRAME);
  assert.match(
    String(await evaluateOnPage(page, "document.querySelector('[data-fault-split]').textContent")),
    /recent, not active/
  );
  await assertFixedLayout(page);
  for (const state of ["clear", "missing"]) {
    await openPreview(page, file, "#faults", `fault-${state}-${theme}`, `&fault-state=${state}`);
    await setTheme(page, theme);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.faults-number').textContent"),
      state === "clear" ? "clear" : "–"
    );
    await assertFixedLayout(page);
  }
  await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').connection.val='offline'");
  await evaluateOnPage(page, FRAME);
  assert.match(
    String(await evaluateOnPage(page, "document.querySelector('[data-fault-split]').textContent")),
    /unavailable/
  );
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
  await evaluateOnPage(page, "document.querySelector('.all-history-row button').click()");
  await waitOnPage(page, "!!document.querySelector('.battery-cooling-page')", "the real Battery history destination");
}

export async function checkFaultReportNavigation(page: HeadlessPage, file: string) {
  await openPreview(page, file, "#faults", "report-origin");
  await waitOnPage(page, "!!document.querySelector('.fault-report-action button')", "Fault report entry");
  await evaluateOnPage(page, "document.querySelector('.fault-report-action button').click()");
  await waitOnPage(
    page,
    "location.hash==='#faults/report' && !!document.querySelector('.fault-report-view')",
    "the real full report"
  );
  await assertRendered(page, [".fault-report-heading button", ".code-line-text", ".fault-report-view .code-toggle"]);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.fault-report-heading button').textContent"),
    "‹ Faults"
  );
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.fault-report-view .code-toggle')].find(button=>button.textContent.includes('mark as expected')).click()"
  );
  await waitOnPage(
    page,
    "ridingPreview('lib/expected-faults.js').expectedFaults.rawVal.size===2",
    "expected marking confirmed by the preview service"
  );
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(page, "!!document.querySelector('.faults-view')", "Back to Faults");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.faults-number').textContent"),
    "3",
    "Acknowledgement never subtracts a fault from the count."
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-fault-split]').textContent"),
    "1 unexpected · 2 expected"
  );
  await evaluateOnPage(page, "history.forward()");
  await waitOnPage(page, "!!document.querySelector('.fault-report-view')", "Forward to report");
  await evaluateOnPage(page, "window.reportReloadMarker=true");
  await reloadPage(page);
  await waitOnPage(
    page,
    "!window.reportReloadMarker && !!document.querySelector('.fault-report-view')",
    "a real report reload"
  );
  await evaluateOnPage(page, "document.querySelector('.fault-report-heading button').click()");
  await waitOnPage(page, "!!document.querySelector('.faults-view')", "report origin after reload");
  await evaluateOnPage(page, "ridingPreview('lib/destination.js').openDestination('bike-information')");
  await waitOnPage(page, "document.querySelector('h2')?.textContent==='Bike information'", "Bike information");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.menu-link')].find(button=>button.textContent.includes('Fault details')).click()"
  );
  await waitOnPage(page, "!!document.querySelector('.fault-report-view')", "the report's real Bike information entry");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.fault-report-heading button').textContent"),
    "‹ Bike information"
  );
  await evaluateOnPage(page, "document.querySelector('.fault-report-heading button').click()");
  await waitOnPage(
    page,
    "document.querySelector('h2')?.textContent==='Bike information'",
    "return to Bike information"
  );
  for (const kind of ["high_beam", "btn_cruise_set"]) {
    await openPreview(page, file, "#faults/report", `report-gesture-${kind}`);
    await waitOnPage(page, "!!document.querySelector('.code-line-text')", "full stored report");
    await evaluateOnPage(page, "window.scrollTo(0,300)");
    assert.ok(Number(await evaluateOnPage(page, "scrollY")) > 0);
    await gesture(page, kind);
    await waitOnPage(
      page,
      "location.hash==='#ride' && !!document.querySelector('.ride-view')",
      "Fault report gesture to Ride"
    );
    assert.equal(await evaluateOnPage(page, "scrollY"), 0);
    await openPreview(page, file, "#charge/pack-cooling", `all-arrival-${kind}`, "&charge-scene=warm");
    await gesture(page, kind);
    await waitOnPage(page, "!!document.querySelector('.all-landing')", "Charge detail gesture to All snapshot");
    assert.equal(await evaluateOnPage(page, "scrollY"), 0);
  }
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
