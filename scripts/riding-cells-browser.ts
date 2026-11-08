import assert from "node:assert/strict";
import { cellVoltageLayout } from "../public/lib/cells.js";
import { evaluateOnPage, reloadPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import { gesture } from "./riding-navigation-browser.ts";

export async function assertCellsContent(page: HeadlessPage, weakest = 1) {
  await waitOnPage(
    page,
    "document.querySelector('[data-cell-count]')?.textContent==='81 of 81 fresh'",
    "all 81 live cell readings"
  );
  const data = (await evaluateOnPage(
    page,
    `({keys:[...document.querySelectorAll('[data-cell-key]')].map(element=>element.dataset.cellKey),bars:[...document.querySelectorAll('.strip [data-cell]')].map(element=>element.dataset.cell),weakest:document.querySelector('[data-weakest]').textContent,strongest:document.querySelector('[data-strongest]').textContent,overviewBottom:document.querySelector('.cells-overview').getBoundingClientRect().bottom,barHeight:document.querySelector('.strip').getBoundingClientRect().height,tabs:document.querySelector('.tabs').getBoundingClientRect().top,modules:[...document.querySelectorAll('.cell-module')].map(element=>element.dataset.module),values:[...document.querySelectorAll('.cell-number')].map(element=>element.textContent)})`
  )) as {
    keys: string[];
    bars: string[];
    weakest: string;
    strongest: string;
    overviewBottom: number;
    barHeight: number;
    tabs: number;
    modules: string[];
    values: string[];
  };
  const keys = cellVoltageLayout().map(slot => slot.key);
  assert.deepEqual(data.keys, keys, "The full cell list is in physical pack/module order.");
  assert.deepEqual(data.bars, keys, "The strip preserves every physical slot.");
  assert.equal(data.weakest, `Weakest BMS index ${weakest}`);
  assert.equal(data.strongest, "Strongest BMS index 81");
  assert.ok(
    data.overviewBottom <= data.tabs && data.barHeight === 76,
    "The complete strip, identities and explanation fit in the first viewport."
  );
  assert.deepEqual(
    data.modules,
    Array.from({ length: 11 }, (_, index) => String(index + 1))
  );
  assert.equal(data.values.length, 81);
  assert.ok(data.values.every(text => /^\d+mV$/.test(text)));
  await evaluateOnPage(page, "window.scrollTo(0,document.scrollingElement.scrollHeight)");
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.body.scrollWidth"), 390);
  assert.equal(
    await evaluateOnPage(
      page,
      "document.querySelector('[data-cell-key=lmu11_cell7_mv]').getBoundingClientRect().bottom<=document.querySelector('.tabs').getBoundingClientRect().top"
    ),
    true,
    "The final cell must remain reachable above navigation."
  );
  await evaluateOnPage(page, "window.scrollTo(0,0)");
}

export async function checkCellsNavigation(
  page: HeadlessPage,
  file: string,
  capture?: (name: string) => Promise<void>
) {
  await openPreview(page, file, "#hypermile", "range-cells-history");
  await evaluateOnPage(page, "document.querySelector('[data-view=cells]').click()");
  await waitOnPage(
    page,
    "location.hash==='#hypermile/cells'&&!!document.querySelector('.cells-view')",
    "Cells sub-tab"
  );
  await assertCellsContent(page);
  await evaluateOnPage(
    page,
    "window.cellRows=[...document.querySelectorAll('[data-cell-key]')];ridingPreview('lib/store.js').chartTick.val++"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(
      page,
      "window.cellRows.every((row,index)=>row===document.querySelectorAll('[data-cell-key]')[index])"
    ),
    true,
    "Cells numeric rows retain their DOM nodes across sampled pulses."
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.cells-back')"),
    null,
    "An ordinary Range entry has no Back row."
  );
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(page, "!!document.querySelector('.range-view')", "Back to Range");
  await evaluateOnPage(page, "history.forward()");
  await waitOnPage(page, "!!document.querySelector('.cells-view')", "Forward to Cells");
  await reloadPage(page);
  await waitOnPage(page, "!!document.querySelector('.cells-view')", "direct reload preserves Cells");
  await evaluateOnPage(
    page,
    "window.scrollTo(0,400);[...document.querySelectorAll('.tabs a')].find(button=>button.textContent==='Range').click()"
  );
  await waitOnPage(
    page,
    "!!document.querySelector('.range-view')&&scrollY===0",
    "current parent returns to Range overview"
  );
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(page, "!!document.querySelector('.cells-view')", "Back retains the actual sub-tab");
  await evaluateOnPage(page, FRAME);
  assert.ok(await evaluateOnPage(page, "scrollY>=390"), "Back must restore Cells' scroll position.");
  for (const theme of ["dark", "light"]) {
    for (const scenario of ["fault", "stale", "missing"]) {
      await openPreview(page, file, "#hypermile/cells", `cells-${theme}-${scenario}`);
      await evaluateOnPage(
        page,
        `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pushPatch({lmu1_cell1_mv:[${scenario === "fault" ? 65535 : 3120},'mV','battery',${scenario === "stale" ? "Date.now()-30_000" : "Date.now()"}]})`
      );
      await evaluateOnPage(page, "pausePreviewMessages(true)");
      if (scenario === "missing") {
        await evaluateOnPage(page, "ridingPreview('lib/store.js').signalState('lmu1_cell1_mv').val=null");
      }
      await evaluateOnPage(page, "ridingPreview('lib/store.js').chartTick.val++");
      await evaluateOnPage(page, FRAME);
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-cell-key=lmu1_cell1_mv] .cell-number').textContent"),
        scenario === "missing" ? "—" : scenario
      );
      assert.deepEqual(
        await evaluateOnPage(
          page,
          "(() => { const bar=document.querySelector('.strip [data-cell=lmu1_cell1_mv]');return bar?{state:bar.dataset.state,fill:bar.style.fill}:null; })()"
        ),
        { state: scenario, fill: "none" },
        "Unavailable cells retain an outlined physical slot."
      );
      assert.deepEqual(
        await evaluateOnPage(
          page,
          "[...document.querySelectorAll('.strip [data-cell]')].map(element=>element.dataset.cell)"
        ),
        cellVoltageLayout().map(slot => slot.key),
        "A bad cell must not shift later bars."
      );
    }
  }
  for (const kind of ["high_beam", "btn_cruise_set"]) {
    await openPreview(page, file, "#hypermile/cells", `cells-gesture-${kind}`);
    await assertCellsContent(page);
    await gesture(page, kind);
    await waitOnPage(page, "location.hash==='#charge'", "both gesture entry points move Cells to Charge");
  }
  await openPreview(page, file, "#ride/cooling", "battery-menu-origin");
  await evaluateOnPage(page, "document.querySelector('.tabs a[href$=\"#more\"]').click()");
  await evaluateOnPage(page, "document.querySelector('[data-more=bike]').click()");
  await waitOnPage(page, "location.search.includes('panel=bike-information')", "Bike information origin");
  await clickText(page, "Battery & cooling");
  await waitOnPage(page, "!!document.querySelector('.battery-cooling-page')", "Battery & cooling menu page");
  await waitOnPage(
    page,
    "document.querySelector('[data-module-count]')?.textContent.startsWith('31 of 31 fresh')",
    "all module probes"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelectorAll('[data-module-signal]').length"), 31);
  assert.equal(await evaluateOnPage(page, "document.body.scrollWidth"), 390);
  assert.equal(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('[data-module-signal]')].every(element=>/^\\d+°C$/.test(element.textContent))"
    ),
    true
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.module-readings td')].filter(element=>element.textContent==='Not fitted').length"
    ),
    2
  );
  await clickText(page, "Cells");
  await waitOnPage(
    page,
    "!!document.querySelector('.cells-view')&&!location.search.includes('panel=')",
    "same Cells route from the menu"
  );
  await assertCellsContent(page);
  await reloadPage(page);
  await waitOnPage(page, "!!document.querySelector('.cells-back')", "Cells origin survives reload");
  assert.equal(await evaluateOnPage(page, "document.querySelector('.cells-back').textContent"), "‹ Battery & cooling");
  await evaluateOnPage(page, "document.querySelector('.cells-back').click()");
  await waitOnPage(page, "!!document.querySelector('.battery-cooling-page')", "Back restores the real menu origin");
  await openPreview(page, file, "#hypermile/cells", "direct-cells");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.cells-back')"),
    null,
    "Direct Cells entry has no redundant Range Back control."
  );
  await evaluateOnPage(page, "document.querySelector('[data-view=hypermile]').click()");
  await waitOnPage(page, "location.hash==='#hypermile'", "adjacent Range sub-tab returns from direct entry");
  await openPreview(page, file, "#charge", "charging-cells-entry", "&ride-state=charging");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.tabs a')].find(button=>button.textContent==='Range').click()"
  );
  await waitOnPage(page, "!!document.querySelector('.range-view')", "Range entry during charging");
  await evaluateOnPage(
    page,
    "document.querySelector('[data-view=cells]').click();pushPatch({lmu1_cell1_mv:[3201,'mV','battery']})"
  );
  await waitOnPage(
    page,
    "document.querySelector('[data-cell-key=lmu1_cell1_mv] .cell-number')?.textContent==='3201mV'",
    "Cells uses the current charging snapshot"
  );
  await checkRangeFollowups(page, file, capture);
  await openPreview(page, file, "#hypermile/cells", "cells-critical");
  await evaluateOnPage(
    page,
    "window.beforeTick=ridingPreview('lib/store.js').chartTick.rawVal;pushPatch({cell_min_mv:[3500,'mV','battery']})"
  );
  await waitOnPage(
    page,
    "ridingPreview('lib/store.js').chartTick.rawVal>window.beforeTick",
    "consume non-critical state"
  );
  await evaluateOnPage(page, FRAME);
  await evaluateOnPage(
    page,
    "ridingPreview('lib/arming.js').arm('charge-stop');window.scrollTo(0,400);pushPatch({cell_min_mv:[3120,'mV','battery']})"
  );
  await waitOnPage(
    page,
    "!!document.querySelector('.range-view')&&scrollY===0",
    "real automatic arrival restores already-selected Range parent"
  );
  assert.equal(await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.val"), "");
}

async function clickText(page: HeadlessPage, text: string) {
  await waitOnPage(
    page,
    `[...document.querySelectorAll('button')].some(button=>button.getBoundingClientRect().height>0&&button.textContent.replace('→','').trim()===${JSON.stringify(text)})`,
    `visible ${text} entry`
  );
  await evaluateOnPage(
    page,
    `[...document.querySelectorAll('button')].find(button=>button.getBoundingClientRect().height>0&&button.textContent.replace('→','').trim()===${JSON.stringify(text)}).click()`
  );
}

async function checkRangeFollowups(page: HeadlessPage, file: string, capture?: (name: string) => Promise<void>) {
  for (const theme of ["dark", "light"]) {
    await openPreview(page, file, "#hypermile", `labels-${theme}`);
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pushPatch({cell_lowest_v_idx:[7,'','cells']})`
    );
    await evaluateOnPage(page, FRAME);
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('[data-reading=cutoff]').textContent")).includes(
        "BMS index 7"
      )
    );
    await evaluateOnPage(page, "document.querySelector('[data-view=cells]').click()");
    await assertCellsContent(page, 7);
    assert.equal(await evaluateOnPage(page, "document.querySelector('.cells-back')"), null);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-weakest]').textContent"),
      "Weakest BMS index 7",
      "A BMS index must not become a physical position."
    );
    assert.ok(
      String(
        await evaluateOnPage(page, "document.querySelector('[data-cell-key=lmu1_cell1_mv] .sub').textContent")
      ).includes("Position 1 · cell 1")
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelector('.cells-content').children[1].classList.contains('cell-spread-history')"
      ),
      true,
      "Spread history follows the complete strip, before Module 1."
    );
    await evaluateOnPage(
      page,
      "pushPatch({cell_spread_mv:[54,'mV','cells']});ridingPreview('lib/store.js').chartTick.val++"
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.cell-spread-history .value').textContent"),
      "54 mV",
      "History uses the accepted spread signal, not the incomplete cell snapshot."
    );
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('.cell-spread-history').innerText")).includes(
        "last 10 min"
      )
    );
    for (const [name, value, time] of [
      ["stale", 54, "Date.now()-30_000"],
      ["fault", 65535, "Date.now()"],
    ] as const) {
      await openPreview(page, file, "#hypermile/cells", `spread-${theme}-${name}`);
      await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
      await evaluateOnPage(page, `pushPatch({cell_spread_mv:[${value},'mV','cells',${time}]})`);
      await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').chartTick.val++");
      await evaluateOnPage(page, FRAME);
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('.cell-spread-history .value').textContent"),
        name
      );
      assert.equal(
        await evaluateOnPage(page, "document.querySelectorAll('.cell-spread-history polyline').length"),
        0,
        "Unavailable spread must not leave a live trace."
      );
    }
    await openPreview(page, file, "#hypermile", `regen-hint-${theme}`);
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};ridingPreview('lib/destination.js').openDestination('battery-cooling')`
    );
    for (const [soc, expected] of [
      [95, "High charge level can reduce regen."],
      [60, "Check pack temperature."],
    ] as const) {
      await evaluateOnPage(page, `pushPatch({soc:[${soc},'%','battery']})`);
      await evaluateOnPage(page, FRAME);
      assert.ok(
        String(await evaluateOnPage(page, "document.querySelector('.regen-information').innerText")).includes(expected)
      );
    }
    await evaluateOnPage(page, "pushPatch({allowed_regen_a:[120,'A','battery']});pausePreviewMessages(true)");
    await evaluateOnPage(page, FRAME);
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('.regen-information').textContent")).includes(
        "Full regen"
      ),
      "A full allowance must not suggest a derate."
    );
    if (capture) {
      await capture(`battery-full-regen-${theme}`);
    }

    await evaluateOnPage(
      page,
      "pausePreviewMessages(false);pushPatch({allowed_regen_a:[55,'A','battery']});pausePreviewMessages(true)"
    );
    await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').signalState('soc').val=null");
    await evaluateOnPage(page, FRAME);
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('.regen-information').innerText")).includes(
        "Check charge level and pack temperature."
      )
    );
    await evaluateOnPage(page, "pausePreviewMessages(false);pushPatch({allowed_regen_a:[65535,'A','battery']})");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.regen-information .value').textContent"),
      "fault"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.regen-information').innerText.includes('Check pack')"),
      false
    );
  }
}
