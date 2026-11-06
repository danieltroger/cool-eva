import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkBmsBrowser(page: HeadlessPage, file: string) {
  for (const theme of ["dark", "light"]) {
    await openPreview(page, file, "#hypermile/cells", `bms-held-${theme}`);
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    await applyHeldBmsFixture(page);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-cell-count]').textContent"),
      "81 of 81 fresh"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-cell-key=lmu1_cell4_mv] .cell-number').textContent"),
      "3000mV"
    );
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('[data-cell-extremes],[data-weakest],[data-strongest]')].map(element=>element.textContent)"
      ),
      ["3280 – 3320 mV · observed span 40 mV", "Weakest BMS index 7", "Strongest BMS index 19"]
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.strip [data-cell=lmu1_cell4_mv]').style.fill"),
      "var(--sub)",
      "Old held bars draw with neutral ink."
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.strip [data-cell=lmu1_cell1_mv]').style.fill"),
      "var(--good)",
      "A current cell above the BMS maximum has no gap."
    );
    await evaluateOnPage(page, "ridingPreview('lib/router.js').showView('charge-pack')");
    await waitOnPage(page, "!!document.querySelector('.charge-pack-view')", "Pack route");
    await evaluateOnPage(page, FRAME);
    await assertHeldModules(page);
    assert.equal(
      await evaluateOnPage(page, "document.querySelectorAll('.charge-voltage-grid .heatmap rect')[3].style.fill"),
      "var(--sub)"
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
  console.log(
    "  ✓ BMS held values stay visible in Cells/Pack/module views, neutral when old, with current 0x203 summaries"
  );
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
    await evaluateOnPage(page, "document.querySelectorAll('.module-readings td.sub').length"),
    2,
    "The two unfitted probes remain distinct."
  );
}
