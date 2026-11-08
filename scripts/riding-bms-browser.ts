import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkBmsBrowser(page: HeadlessPage, file: string) {
  for (const theme of ["dark", "light"]) {
    await openPreview(page, file, "#hypermile/cells", `bms-held-${theme}`);
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    await applyHeldBmsFixture(page);
    await evaluateOnPage(
      page,
      "document.querySelector('[data-map-mode=balance]').click();document.querySelector('[data-position=\"4\"]').click()"
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-cell-description]').textContent"),
      "M1 · L1 C4 · 3.000 V"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelector('[data-position=\"4\"]').style.getPropertyValue('--cell-color')"
      ),
      "var(--sub)",
      "Old held readings keep neutral map ink."
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-cell-extra]').textContent.includes('below best')"),
      false
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-spread-now]').textContent"),
      "40mV",
      "The current BMS summary stays independent of held cell values."
    );
    await evaluateOnPage(page, "document.querySelector('[data-position=\"1\"]').click()");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-cell-description]').textContent"),
      "M1 · L1 C1 · 3.405 V"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelector('[data-position=\"1\"]').style.getPropertyValue('--cell-color')"
      ),
      "color-mix(in srgb,var(--warn) 0%,var(--good))",
      "A current cell above the BMS maximum has zero relative gap."
    );
    await evaluateOnPage(page, "ridingPreview('lib/destination.js').openDestination('battery-cooling')");
    await waitOnPage(page, "!!document.querySelector('.battery-cooling-page')", "Battery & cooling module grid");
    await evaluateOnPage(page, FRAME);
    await assertHeldModules(page);
    await evaluateOnPage(
      page,
      `(() => {
      const store=ridingPreview('lib/store.js');
      const timestamp=store.peekServerTime()+8001;
      store.apply({type:'snapshot',ts:timestamp,signals:{pack_v:{value:330,unit:'V',group:'battery',ts:timestamp}}});
      store.chartTick.val++;
    })()`
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-module-signal=lmu1_pcb1_c]').textContent"),
      "stale",
      "Live unrelated traffic cannot keep a dead multiplex's held values fresh."
    );
  }
  console.log("  ✓ BMS held values stay visible in Cells/module views, neutral when old, with current 0x203 summaries");
}

export async function applyHeldBmsFixture(page: HeadlessPage) {
  await evaluateOnPage(
    page,
    `(() => {
    const store=ridingPreview('lib/store.js');
    const definitions=ridingPreview('lib/generated-bounds.js').DISPLAY_FRESHNESS;
    const timestamp=Date.now();
    const signals={};
    for (const [key,freshness] of Object.entries(definitions)) {
      const previous=store.signalState(key).rawVal;
      const age=freshness==='lmu-cells-1-to-3'?9000:90_000;
      signals[key]=[previous.value,previous.unit,previous.group,timestamp-age];
    }
    Object.assign(signals,{
      lmu_cell_mux:[1,'','bms',timestamp],
      lmu1_cell1_mv:[3405,'mV','cells',timestamp],
      lmu1_cell4_mv:[3000,'mV','cells',timestamp-90_000],
      lmu1_pcb1_c:[60,'°C','battery',timestamp-90_000],
      lmu2_pcb1_c:[42,'°C','battery',timestamp],
      cell_min_mv:[3280,'mV','cells',timestamp],cell_max_mv:[3320,'mV','cells',timestamp],
      cell_spread_mv:[40,'mV','cells',timestamp],
      cell_lowest_v_idx:[7,'','cells',timestamp],cell_highest_v_idx:[19,'','cells',timestamp]
    });
    pushPatch(signals);
    pausePreviewMessages(true);
    store.chartTick.val++;
  })()`
  );
  await evaluateOnPage(page, FRAME);
}

async function assertHeldModules(page: HeadlessPage) {
  assert.ok(
    String(await evaluateOnPage(page, "document.querySelector('[data-module-count]').textContent")).startsWith(
      "31 of 31 fresh"
    )
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-module-signal=lmu1_pcb1_c]').textContent"),
    "60°C"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-module-signal=lmu1_pcb1_c]').style.color"),
    "var(--sub)"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelectorAll('.module-temperatures .heatmap rect')[1].style.fill"),
    "var(--sub)"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-module-signal=lmu2_pcb1_c]').style.color"),
    "var(--watch)",
    "A current temperature keeps its temperature colour in the module view."
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelectorAll('.module-temperatures .heatmap rect')[4].style.fill"),
    "var(--watch)",
    "The heatmap must show current temperature colour as well as held neutral readings."
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelectorAll('.module-readings td.sub').length"),
    2,
    "The two unfitted probes remain distinct."
  );
}
