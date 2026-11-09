import assert from "node:assert/strict";
import { evaluateOnPage, type HeadlessPage } from "./headless-page.ts";
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
    await evaluateOnPage(page, "document.querySelector('[data-map-mode=temperature]').click()");
    await evaluateOnPage(page, FRAME);
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('[data-cell-extra]').textContent")).startsWith(
        "PCB 60 / "
      ),
      "Accepted held board temperatures remain visible in Cells."
    );
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
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('[data-cell-extra]').textContent")).includes("stale"),
      "Live unrelated traffic cannot keep a dead multiplex's held values fresh."
    );
  }
  console.log("  ✓ BMS held cell and board values stay visible in Cells, neutral when old, with current summaries");
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
