import { assertChargeLayout } from "./charge-page-layout.ts";
import { checkChargeReviewCases } from "./riding-charge-review-browser.ts";
import { assertFixedLayout, resetLayoutClearance, layoutClearance } from "./riding-layout-browser.ts";
import { assertChargeContent, checkChargeCases } from "./riding-charge-browser.ts";
import { checkChargeNavigation } from "./riding-charge-navigation.ts";
import { checkChargeActions } from "./riding-charge-actions.ts";
import { checkSocEntryBrowser } from "./riding-soc-entry-browser.ts";
import { assertRangeContent, checkRangeCases } from "./riding-range-browser.ts";
import { assertCellsContent, checkCellsNavigation } from "./riding-cells-browser.ts";
import { checkBmsBrowser } from "./riding-bms-browser.ts";
import { checkHistoryAndGestures } from "./riding-navigation-browser.ts";
import { checkPersistentNavigation } from "./persistent-navigation-browser.ts";
import { checkCoolingFan } from "./riding-fan-browser.ts";
import { checkFaultRecovery } from "./riding-fault-browser.ts";
import { checkPowerWords } from "./riding-power-browser.ts";
import { assertRideContent, checkRideBrowser, checkRideZero } from "./riding-ride-browser.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import {
  assertAllContent,
  assertFaultsContent,
  checkFaultsAllCases,
  checkFaultReportNavigation,
} from "./riding-faults-all-browser.ts";
import assert from "node:assert/strict";
import { ROUTES } from "../public/lib/router.js";
import { evaluateOnPage, gotoPage, waitOnPage, resizePage, setPageInsets, type HeadlessPage } from "./headless-page.ts";

const COVERAGE = {
  ride: "fixed",
  cooling: "fixed",
  hypermile: "fixed",
  cells: "scrolling",
  charge: "scrolling",
  all: "fixed-landing",
  faults: "fixed",
  "fault-report": "scrolling",
  more: "scrolling",
} as const;
const COOLING_SIGNALS = [
  "coolant_in",
  "coolant_out",
  "motor_temp_c",
  "bike_coolant_temp",
  "ambient_temp",
  "fan_target_pct",
];
export { assertFixedLayout } from "./riding-layout-browser.ts";

export async function checkRidingBrowser(page: HeadlessPage, previewFile: string): Promise<void> {
  resetLayoutClearance();
  assert.deepEqual(
    ROUTES.map(route => route.name).sort(),
    Object.keys(COVERAGE).sort(),
    "Every router view needs an acceptance contract."
  );
  const fixedViews = Object.entries(COVERAGE)
    .filter(([, policy]) => policy === "fixed" || policy === "fixed-landing")
    .map(([name]) => name);
  assert.deepEqual(
    fixedViews,
    ["ride", "cooling", "hypermile", "all", "faults"],
    "Fixed-view coverage must match the converted screens."
  );
  for (const geometry of [
    { height: 844, top: 47 },
    { height: 797, top: 0 },
  ]) {
    await resizePage(page, { width: 390, height: geometry.height, deviceScaleFactor: 3, mobile: true });
    await setPageInsets(page, { top: geometry.top, bottom: 34, left: 0, right: 0 });
    for (const theme of ["dark", "light"]) {
      const visited = new Set<string>();
      for (const route of ROUTES) {
        await openPreview(
          page,
          previewFile,
          route.hash,
          `${geometry.height}-${theme}-${route.name}`,
          route.tab === "charge" ? "&charge-scene=warm" : ""
        );
        await evaluateOnPage(page, `ridingPreview("lib/theme.js").themePreference.val = ${JSON.stringify(theme)}`);
        await evaluateOnPage(page, FRAME);
        assert.equal(await evaluateOnPage(page, "ridingPreview('lib/router.js').currentView()"), route.name);
        await assertInsets(page, geometry.top, geometry.height);
        await assertPopulatedFixture(page);
        visited.add(route.name);
        if (fixedViews.includes(route.name)) {
          if (route.name === "ride") {
            await assertRideContent(page);
          } else if (route.name === "hypermile") {
            await assertRangeContent(page);
          } else if (route.name === "all") {
            await assertAllContent(page);
          } else if (route.name === "faults") {
            await assertFaultsContent(page);
          } else {
            await assertCoolingContent(page);
          }
          await assertFixedLayout(page, route.name === "all");
        } else if (route.name === "charge") {
          await assertChargeContent(page);
        } else if (route.name === "cells") {
          await assertCellsContent(page);
        }
      }
      assert.deepEqual(
        [...visited].sort(),
        ROUTES.map(route => route.name).sort(),
        "All router views must actually be visited."
      );
      await checkNoticeStates(page, previewFile, theme);
      await checkNoticeStates(page, previewFile, theme, "#ride");
      await checkNoticeStates(page, previewFile, theme, "#hypermile");
      await checkRangeCases(page, previewFile, assertFixedLayout, theme);
      await checkChargeCases(page, previewFile, assertFixedLayout, theme);
      await checkChargeReviewCases(page, previewFile, theme);
      await checkNoticeStates(page, previewFile, theme, "#charge");
      await checkNoticeStates(page, previewFile, theme, "#all");
      await checkNoticeStates(page, previewFile, theme, "#faults");
      await checkFaultsAllCases(page, previewFile, theme);
      await checkRideBrowser(page, previewFile, assertFixedLayout, theme);
      await checkPowerWords(page, previewFile, assertFixedLayout, theme);
    }
  }
  await resizePage(page, { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await setPageInsets(page, { top: 47, bottom: 34, left: 0, right: 0 });
  for (const theme of ["dark", "light"]) {
    await checkRideZero(page, previewFile, assertFixedLayout, theme);
  }
  await resizePage(page, { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await setPageInsets(page, { top: 47, bottom: 34, left: 0, right: 0 });
  await checkInsetCounterexample(page, previewFile);
  await checkHistoryAndGestures(page, previewFile);
  await checkPersistentNavigation(page, previewFile);
  await checkCellsNavigation(page, previewFile);
  await checkBmsBrowser(page, previewFile);
  await checkChargeNavigation(page, previewFile);
  await checkFaultReportNavigation(page, previewFile);
  await checkChargeActions(page, previewFile);
  await checkSocEntryBrowser(page, previewFile);
  await checkCoolingFailures(page, previewFile);
  await checkCoolingFan(page, previewFile, assertFixedLayout);
  for (const theme of ["dark", "light"]) {
    await checkFaultRecovery(page, previewFile, assertFixedLayout, theme);
  }
  console.log(
    `  ✓ riding: real PWA/native insets, ${layoutClearance()}px minimum riding-landing clearance, complete content, parent/switch header, history/reload and both gestures`
  );
}

async function checkInsetCounterexample(page: HeadlessPage, file: string) {
  await openPreview(page, file, "#ride/cooling", "inset-counterexample");
  await assertCoolingContent(page);
  await evaluateOnPage(page, "document.querySelector('.cooling-view').style.minHeight='668px'");
  const real = (await evaluateOnPage(
    page,
    "[document.scrollingElement.scrollHeight-innerHeight,document.querySelector('.tabs').getBoundingClientRect().top-document.querySelector('.cooling-view').getBoundingClientRect().bottom]"
  )) as number[];
  assert.ok(real[0] > 0 && real[1] < 12, "A populated over-budget riding view must fail at real insets.");
  try {
    await setPageInsets(page, { top: 0, bottom: 0, left: 0, right: 0 });
    await evaluateOnPage(page, FRAME);
    const zero = (await evaluateOnPage(
      page,
      "[document.scrollingElement.scrollHeight-innerHeight,document.querySelector('.tabs').getBoundingClientRect().top-document.querySelector('.cooling-view').getBoundingClientRect().bottom]"
    )) as number[];
    assert.equal(zero[0], 0, "The same counterexample fits only the misleading zero-inset space.");
    assert.ok(zero[1] >= 12);
  } finally {
    await setPageInsets(page, { top: 47, bottom: 34, left: 0, right: 0 });
  }
}

async function assertInsets(page: HeadlessPage, top: number, height: number) {
  const actual = await evaluateOnPage(
    page,
    `(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = [innerWidth,innerHeight,parseFloat(style.paddingTop),parseFloat(style.paddingBottom)];
    probe.remove();
    return result;
  })()`
  );
  assert.deepEqual(
    actual,
    [390, height, top, 34],
    "The real env() safe areas are mandatory; zero-inset fallback is forbidden."
  );
}

async function assertPopulatedFixture(page: HeadlessPage) {
  const values = await evaluateOnPage(
    page,
    `(() => {
    const store = ridingPreview("lib/store.js");
    const required = ${JSON.stringify([...COOLING_SIGNALS, "batt_temp_lo", "batt_temp_hi", "fan_duty_pct", "fan_driver_enabled", "fan_auto_mode", "batt_temp_lo_vcu", "batt_temp_hi_vcu", "cell_cutoff_mv"])};
    return {missing:required.filter(key => store.valueOf(key) === null), cells:store.knownKeys.val.filter(key => /^lmu[0-9]+_cell[0-9]+_mv$/.test(key)).length, installed:ridingPreview("lib/settings.js").settings.val?.active.coolantProbesEnabled};
  })()`
  );
  assert.deepEqual(
    values,
    { missing: [], cells: 81, installed: true },
    "The normal fixture must populate every required sensor and all 81 cells."
  );
  assert.equal(
    await evaluateOnPage(
      page,
      `["fan_auto_mode","fan_driver_enabled","fan_duty_pct","fan_target_pct"].every(key => {
        const store=ridingPreview("lib/store.js"); const reading=store.signalState(key).val;
        return reading && store.peekServerTime()-reading.ts>=60_000;
      })`
    ),
    true,
    "Steady-fan fixture timestamps must remain at least 60 seconds old after startup."
  );
}

async function assertCoolingContent(page: HeadlessPage) {
  assert.equal(
    await evaluateOnPage(
      page,
      `[...document.querySelectorAll('.cooling-view [data-signal]')].every(element => {
    const rectangle=element.getBoundingClientRect();
    if(rectangle.width<=0 || rectangle.height<=0 || element.getClientRects().length===0) return false;
    for(let parent=element;parent;parent=parent.parentElement) {
      const style=getComputedStyle(parent);
      if(style.display==='none' || style.visibility!=='visible' || Number(style.opacity)===0) return false;
    }
    return true;
  })`
    ),
    true,
    "Every required reading must actually be rendered, not hidden in the DOM."
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `[...document.querySelectorAll('.cooling-view [data-signal]')].map(element => element.getAttribute('data-signal')).sort()`
    ),
    [...COOLING_SIGNALS].sort()
  );
  const values = await evaluateOnPage(
    page,
    `[...document.querySelectorAll('.cooling-view [data-signal]')].map(element => element.textContent)`
  );
  assert.deepEqual(
    values,
    ["36.5", "41.2", "65", "67", "17", "68"],
    "Required readings must render; hidden tiles cannot buy a short screen."
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.cooling-view').innerText.includes('Automatic control')"),
    true,
    "Steady on-demand fan commands must stay available on a live link."
  );
}

async function checkNoticeStates(page: HeadlessPage, file: string, theme: string, hash = "#ride/cooling") {
  for (const link of ["live", "offline", "connecting"]) {
    await openPreview(page, file, hash, `${theme}-${link}-${Date.now()}`);
    await evaluateOnPage(
      page,
      `pausePreviewMessages(true); ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}; ridingPreview('lib/store.js').connection.val=${JSON.stringify(link)}`
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.app-title .dot').getAttribute('aria-label')"),
      link
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.header button,.header-notice,.can-status-link,.menu')"),
      null,
      "The header has only the approved parent, connection dot and top switch."
    );
    if (hash === "#charge") {
      await assertChargeLayout(page);
    } else {
      await assertFixedLayout(page, hash === "#all");
    }
  }
}

async function checkCoolingFailures(page: HeadlessPage, file: string) {
  await openPreview(page, file, "#ride/cooling", "fault-input");
  await evaluateOnPage(page, "pushPatch({coolant_in:[-242,'°C','coolant']})");
  await waitOnPage(
    page,
    "document.querySelector('[data-signal=coolant_in]').textContent === 'fault'",
    "a visible rejected coolant input"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-signal=coolant_out]').textContent"), "41.2");
  await assertFixedLayout(page);
  await evaluateOnPage(page, "ridingPreview('lib/units.js').unitSystem.val='imperial'");
  await evaluateOnPage(page, FRAME);
  await assertFixedLayout(page);
  await evaluateOnPage(page, "ridingPreview('lib/units.js').unitSystem.val='metric'");
  await evaluateOnPage(
    page,
    "ridingPreview('lib/store.js').signalState('motor_temp_c').val=null; ridingPreview('lib/store.js').signalState('fan_auto_mode').val=null"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-signal=motor_temp_c]').textContent"), "—");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.cooling-view').innerText.includes('Fan status unavailable')"),
    true
  );
  await assertFixedLayout(page);
}
