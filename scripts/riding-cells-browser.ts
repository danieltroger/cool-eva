import assert from "node:assert/strict";
import { packCellLayout, PACK_MODULE_GRID } from "../public/lib/pack-layout.js";
import { evaluateOnPage, reloadPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { assertFixedLayout, assertRendered } from "./riding-layout-browser.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import { gesture } from "./riding-navigation-browser.ts";

export async function assertCellsContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "document.querySelectorAll('.cell-square').length===81&&document.querySelector('[data-spread-now]')?.textContent==='38mV'&&document.querySelector('[data-cell-description]')?.textContent==='M6 · LMU 7 · 41 °C'",
    "complete approved Cells map"
  );
  await assertRendered(page, [
    ".cell-summary .value",
    "[data-map-mode]",
    "[data-map-age]",
    "[data-map-legend]",
    ".module-block",
    ".cell-square",
    "[data-cell-description]",
    "[data-cell-extra]",
    "[data-cell-step]",
  ]);
  const layout = await evaluateOnPage(
    page,
    `({modules:[...document.querySelectorAll('.module-block')].map(element=>Number(element.dataset.module)),cells:[...document.querySelectorAll('.cell-square')].map(element=>({key:element.dataset.cellKey,position:Number(element.dataset.position),lmu:Number(element.dataset.lmu),cell:Number(element.dataset.lmuCell),module:Number(element.closest('[data-module]').dataset.module)})).sort((first,second)=>first.position-second.position),columns:getComputedStyle(document.querySelector('.pack-map')).gridTemplateColumns.split(' ').length,squares:[...document.querySelectorAll('.cell-square')].map(element=>element.getBoundingClientRect().height),heights:[...document.querySelectorAll('.module-block')].map(element=>element.getBoundingClientRect().height),values:[...document.querySelectorAll('.cell-summary .value')].map(element=>getComputedStyle(element).fontSize),selected:document.querySelector('.cell-square.selected').dataset.position,absent:document.querySelectorAll('.cell-square[data-state=absent]').length,age:document.querySelector('[data-map-age]').textContent,legend:document.querySelector('[data-map-legend]').textContent,old:!!document.querySelector('.strip,.cell-values,.cell-spread-history,.cells-back,input[type=range]')})`
  );
  assert.deepEqual(layout, {
    modules: PACK_MODULE_GRID.flat(),
    cells: packCellLayout(),
    columns: 3,
    squares: Array(81).fill(16),
    heights: Array(9).fill(92),
    values: ["32px", "32px"],
    selected: "48",
    absent: 14,
    age: "Modules · now",
    legend: "38 → 50 °C",
    old: false,
  });
  await assertFixedLayout(page);
}

export async function checkCellsNavigation(
  page: HeadlessPage,
  file: string,
  capture?: (name: string) => Promise<void>
) {
  await openPreview(page, file, "#hypermile", "cells-history");
  await evaluateOnPage(page, "document.querySelector('[data-view=cells]').click()");
  await waitOnPage(
    page,
    "location.hash==='#hypermile/cells'&&!!document.querySelector('.cells-view')",
    "Cells top switch"
  );
  await assertCellsContent(page);
  await evaluateOnPage(
    page,
    "window.cellSquares=[...document.querySelectorAll('.cell-square')];window.moduleButtons=[...document.querySelectorAll('.module-block')];ridingPreview('lib/store.js').chartTick.val++"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(
      page,
      "cellSquares.every((element,index)=>element===document.querySelectorAll('.cell-square')[index])&&moduleButtons.every((element,index)=>element===document.querySelectorAll('.module-block')[index])"
    ),
    true,
    "Live pulses keep every square and module button mounted."
  );
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(page, "!!document.querySelector('.range-view')", "Back to Range");
  await evaluateOnPage(page, "history.forward()");
  await waitOnPage(page, "!!document.querySelector('.cells-view')", "Forward to Cells");
  await reloadPage(page);
  await waitOnPage(page, "!!document.querySelector('.cells-view')", "direct reload preserves Cells");
  await assertCellsContent(page);
  await evaluateOnPage(page, "document.querySelector('.tabs a[href$=\"#hypermile\"]').click()");
  await waitOnPage(page, "!!document.querySelector('.range-view')&&scrollY===0", "parent tab returns to Range");
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(
    page,
    "!!document.querySelector('.cells-view')&&scrollY===0",
    "Back restores the fixed Cells subview"
  );
  for (const theme of ["dark", "light"]) {
    await checkMapSelection(page, file, theme, capture);
    await checkMapQuality(page, file, theme, capture);
  }
  for (const kind of ["high_beam", "btn_cruise_set"]) {
    await openPreview(page, file, "#hypermile/cells", `cells-${kind}`);
    await assertCellsContent(page);
    await gesture(page, kind);
    await waitOnPage(page, "location.hash==='#charge'&&scrollY===0", "both handlebar gestures move Cells to Charge");
  }
  await openPreview(page, file, "#hypermile/cells", "cells-critical");
  await assertCellsContent(page);
  await evaluateOnPage(
    page,
    "window.beforeTick=ridingPreview('lib/store.js').chartTick.rawVal;pushPatch({cell_min_mv:[3500,'mV','cells']})"
  );
  await waitOnPage(page, "ridingPreview('lib/store.js').chartTick.rawVal>beforeTick", "consume non-critical state");
  await evaluateOnPage(
    page,
    "ridingPreview('lib/arming.js').arm('charge-stop');pushPatch({cell_min_mv:[3120,'mV','cells']})"
  );
  await waitOnPage(
    page,
    "!!document.querySelector('.range-view')&&scrollY===0",
    "critical cell arrival restores Range"
  );
  assert.equal(await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal"), "");
  console.log(
    "  ✓ Cells: nine physical modules, eleven LMUs, stable selection, both modes/themes, current summaries, quality states and real navigation"
  );
}

async function checkMapSelection(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  await openPreview(page, file, "#hypermile/cells", `cells-selection-${theme}`);
  await assertCellsContent(page);
  await evaluateOnPage(
    page,
    `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};window.cellSquares=[...document.querySelectorAll('.cell-square')];document.querySelector('[data-cell-step="-1"]').click();document.querySelector('[data-cell-step="-1"]').click()`
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-cell-description]').textContent"),
    "M6 · LMU 6 · —"
  );
  assert.ok(
    String(await evaluateOnPage(page, "document.querySelector('[data-cell-extra]').textContent")).startsWith(
      "No battery sensor · PCB 40 / 40 °C"
    )
  );
  await evaluateOnPage(
    page,
    "document.querySelector('[data-map-mode=balance]').click();document.querySelector('[data-module=\"1\"]').click()"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-cell-description]').textContent"),
    "M1 · L1 C1 · 3.120 V"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-cell-extra]').textContent"),
    "Position 1 · 38 mV below best · now"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-cell-step=\"-1\"]').disabled"), true);
  await evaluateOnPage(page, "document.querySelector('[data-position=\"81\"]').click()");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-cell-description]').textContent"),
    "M9 · L11 C7 · 3.158 V"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-cell-step=\"1\"]').disabled"), true);
  await evaluateOnPage(
    page,
    "document.querySelector('[data-position=\"48\"]').click();pushPatch({cell_lowest_v_idx:[7,'','cells']});ridingPreview('lib/store.js').chartTick.val++"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.cell-square.selected').dataset.position"),
    "48",
    "A BMS index cannot become a physical position."
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "cellSquares.every((element,index)=>element===document.querySelectorAll('.cell-square')[index])"
    ),
    true,
    "Mode/selection changes preserve the same 81 squares."
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-map-legend]').textContent"), "0 → −40 mV");
  const boundaries = await evaluateOnPage(
    page,
    "[...document.querySelectorAll('[data-module=\"6\"] [data-position]')].filter(element=>element.classList.contains('lmu-start')).map(element=>[element.dataset.position,element.querySelector('.lmu-label').textContent])"
  );
  assert.deepEqual(boundaries, [
    ["46", "L6"],
    ["47", "L7"],
    ["54", "L8"],
  ]);
  assert.equal(
    await evaluateOnPage(page, "getComputedStyle(document.querySelector('[data-position=\"46\"]')).borderRightStyle"),
    "dashed"
  );
  assert.equal(
    await evaluateOnPage(page, "getComputedStyle(document.querySelector('[data-position=\"54\"]')).borderTopStyle"),
    "dashed"
  );
  await assertFixedLayout(page);
  if (capture) {
    await capture(`cells-balance-${theme}`);
  }
  await evaluateOnPage(
    page,
    "ridingPreview('lib/units.js').unitSystem.val='imperial';document.querySelector('[data-map-mode=temperature]').click()"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-map-legend]').textContent"), "100 → 122 °F");
  await assertFixedLayout(page);
  await evaluateOnPage(page, "ridingPreview('lib/units.js').unitSystem.val='metric'");
}

async function checkMapQuality(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  for (const scenario of ["fault", "missing", "stale", "held"]) {
    await openPreview(page, file, "#hypermile/cells", `cells-${theme}-${scenario}`);
    await assertCellsContent(page);
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};document.querySelector('[data-map-mode=balance]').click();pushPatch({lmu1_cell4_mv:[${scenario === "fault" ? 65535 : 3000},'mV','cells',${scenario === "stale" ? "Date.now()-800_000" : scenario === "held" ? "Date.now()-90_000" : "Date.now()"}]});pausePreviewMessages(true)`
    );
    if (scenario === "missing") {
      await evaluateOnPage(page, "ridingPreview('lib/store.js').signalState('lmu1_cell4_mv').val=null");
    }
    await evaluateOnPage(
      page,
      "document.querySelector('[data-position=\"4\"]').click();ridingPreview('lib/store.js').chartTick.val++"
    );
    await evaluateOnPage(page, FRAME);
    const detail = String(await evaluateOnPage(page, "document.querySelector('[data-cell-description]').textContent"));
    assert.ok(
      detail.includes(
        scenario === "fault" ? "fault" : scenario === "missing" ? "Missing" : scenario === "stale" ? "stale" : "3.000 V"
      ),
      detail
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-position=\"4\"]').dataset.state"),
      scenario === "held" ? "fresh" : scenario
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-spread-now]').textContent"),
      "38mV",
      "A bad/held cell never replaces the current BMS spread."
    );
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.cell-square')].map(element=>Number(element.dataset.position)).sort((first,second)=>first-second)"
      ),
      Array.from({ length: 81 }, (_, index) => index + 1)
    );
    if (scenario === "held") {
      assert.equal(
        await evaluateOnPage(
          page,
          "document.querySelector('[data-position=\"4\"]').style.getPropertyValue('--cell-color')"
        ),
        "var(--sub)"
      );
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-cell-extra]').textContent.includes('below best')"),
        false
      );
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-map-age]').textContent"),
        "Latest readings · 1m old"
      );
    }
    await assertFixedLayout(page);
    if (capture) {
      await capture(`cells-${scenario}-${theme}`);
    }
  }
  await openPreview(page, file, "#hypermile/cells", `cells-board-age-${theme}`);
  await assertCellsContent(page);
  await evaluateOnPage(
    page,
    "pushPatch({lmu7_pcb1_c:[41,'°C','battery',Date.now()-90_000],lmu7_pcb2_c:[41,'°C','battery',Date.now()-90_000],lmu6_pcb1_c:[40,'°C','battery',Date.now()-90_000],lmu6_pcb2_c:[40,'°C','battery',Date.now()-90_000]});pausePreviewMessages(true);ridingPreview('lib/store.js').chartTick.val++"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-cell-description]').textContent"),
    "M6 · LMU 7 · 41 °C"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-cell-extra]').textContent"),
    "PCB 41 / 41 °C · 1m old",
    "A current battery reading cannot renew older PCB samples."
  );
  await evaluateOnPage(page, "document.querySelector('[data-position=\"46\"]').click()");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-cell-extra]').textContent"),
    "No battery sensor · PCB 40 / 40 °C · 1m old"
  );
  await assertFixedLayout(page);
  for (const signal of ["cell_spread_mv", "batt_temp_lo"]) {
    await openPreview(page, file, "#hypermile/cells", `cells-summary-${signal}-${theme}`);
    await assertCellsContent(page);
    await evaluateOnPage(
      page,
      `pushPatch({${signal}:[65535,${signal === "cell_spread_mv" ? "'mV'" : "'°C'"},'battery']});pausePreviewMessages(true)`
    );
    await evaluateOnPage(page, FRAME);
    assert.ok(
      String(
        await evaluateOnPage(
          page,
          signal === "cell_spread_mv"
            ? "document.querySelector('[data-spread-now]').textContent"
            : "document.querySelector('[data-signal=batt_temp_lo]').textContent"
        )
      ).includes("fault")
    );
    await assertFixedLayout(page);
  }
}
