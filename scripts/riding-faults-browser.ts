import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, reloadPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import { gesture } from "./riding-navigation-browser.ts";

export async function assertFaultsContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "document.querySelectorAll('.faults-view > .fault-list > .fault-row').length===3",
    "all three active code disclosures"
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.faults-view > .label,.stored-faults > summary')].map(element=>element.textContent)"
    ),
    ["Active", "Stored faults"]
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "document.querySelector('.faults-count,.fault-preview,.fault-report-action,.fault-report-view,.faults-footnote')"
    ),
    null,
    "The approved page has one expandable list, without a summary/report split."
  );
  const identities = (await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.fault-row')].map(element=>element.dataset.faultKey)"
  )) as string[];
  assert.equal(new Set(identities).size, identities.length, "Each active/stored code has one home.");
  await assertFaultLayout(page);
}

export async function checkFaultsCases(page: HeadlessPage, file: string, theme: string) {
  await openFaults(page, file, theme, "captured");
  await assertFaultsContent(page);
  await openCode(page, "P0A07");
  const fields = await evaluateOnPage(
    page,
    "[...document.querySelectorAll('[data-code=P0A07] [data-record-field]')].map(element=>({name:element.dataset.recordField,text:element.textContent,font:getComputedStyle(element.querySelector('.fault-field-value')).fontSize}))"
  );
  assert.deepEqual(fields, [
    { name: "VEHICLE_SUBSTATE", text: "Vehicle state22", font: "14px" },
    { name: "ai_WaterPumpCurrent_In", text: "Pump current0 mA", font: "14px" },
    { name: "WaterPump_ModuleSts", text: "Pump status−4", font: "14px" },
    { name: "D_IGBTA_T", text: "IGBT A34.9 °C", font: "14px" },
    { name: "D_IGBTB_T", text: "IGBT B34.9 °C", font: "14px" },
    { name: "D_IGBTC_T", text: "IGBT C34.9 °C", font: "14px" },
    { name: "V_AIR_TEMP", text: "Outside air28.5 °C", font: "14px" },
  ]);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-code=P0A07] [data-cycle-age]').textContent"),
    "Stored 255 cycles ago"
  );
  await evaluateOnPage(
    page,
    "window.pumpNode=document.querySelector('[data-code=P0A07]');window.pumpCheckbox=pumpNode.querySelector('input');window.oldFetch=window.fetch;window.expectedWrites=0;window.fetch=(url,options)=>{if(String(url).includes('/expected-faults')&&options?.method==='POST')window.expectedWrites++;return oldFetch(url,options)};pumpCheckbox.click()"
  );
  await waitOnPage(
    page,
    "!ridingPreview('lib/expected-faults.js').expectedFaults.rawVal.has('44/0')",
    "one confirmed Expected change"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "expectedWrites"), 1);
  assert.equal(
    await evaluateOnPage(
      page,
      "pumpNode===document.querySelector('[data-code=P0A07]')&&pumpNode.open&&pumpCheckbox===pumpNode.querySelector('input')&&!pumpCheckbox.checked"
    ),
    true,
    "An Expected change keeps the disclosure and checkbox."
  );
  await evaluateOnPage(
    page,
    "pushPatch({dtc_list_count:[3,'','diagnostics']});ridingPreview('lib/store.js').chartTick.val++;ridingPreview('lib/fault-data.js').stored.val={...ridingPreview('lib/fault-data.js').stored.rawVal}"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "pumpNode===document.querySelector('[data-code=P0A07]')&&pumpNode.open"),
    true,
    "Telemetry, age ticks and stored refreshes cannot collapse an opened record."
  );
  await evaluateOnPage(page, "document.querySelector('.stored-faults').open=true");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(
      page,
      "document.querySelector('[data-fault-key=\"54/11\"] [data-record-state]').dataset.recordState"
    ),
    "no-record"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-fault-key=\"60/0\"] [data-cycle-age]').textContent"),
    "Stored 255 cycles ago"
  );
  await openCode(page, "B1012");
  await evaluateOnPage(
    page,
    "window.lightingNode=document.querySelector('[data-code=B1012]');const data=ridingPreview('lib/fault-data.js');const snapshot=data.stored.rawVal;data.stored.val={...snapshot,stored:{...snapshot.stored,codes:[...snapshot.stored.codes].reverse()}} "
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "lightingNode===document.querySelector('[data-code=B1012]')&&lightingNode.open"),
    true,
    "A reordered stored list keeps the opened record node."
  );
  assert.ok(
    Number(await evaluateOnPage(page, "document.querySelectorAll('[data-fault-key=\"52/0\"] .record-raw').length")) > 0
  );
  assert.ok(
    Number(await evaluateOnPage(page, "document.querySelectorAll('[data-fault-key=\"62/0\"] .record-fault').length")) >
      0
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.record-raw')].some(element=>/mA|Wh|%/.test(element.textContent))"
    ),
    false,
    "A refused scaling keeps raw units unclaimed."
  );
  await evaluateOnPage(
    page,
    "window.originalTitle=pumpNode.querySelector('.fault-title').textContent;pumpNode.querySelector('.fault-title').textContent='UnbreakableFaultIdentifier'.repeat(40)"
  );
  await assertFaultLayout(page);
  await evaluateOnPage(page, "pumpNode.querySelector('.fault-title').textContent=window.originalTitle");
  await evaluateOnPage(
    page,
    "window.refusedWrites=0;window.fetch=(url,options)=>{if(String(url).includes('/expected-faults')&&options?.method==='POST'){window.refusedWrites++;return new Promise(resolve=>{window.releaseExpected=()=>resolve(new Response(JSON.stringify({expected:{entries:[...EXPECTED_FAULTS].map(key=>{const [component,symptom]=key.split('/').map(Number);return {component,symptom}})},message:'Synthetic refusal'}),{status:403,headers:{'Content-Type':'application/json'}}))})}return oldFetch(url,options)};pumpCheckbox.click()"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "pumpCheckbox.checked"),
    false,
    "Expected stays at the confirmed value while the reply is pending."
  );
  assert.equal(await evaluateOnPage(page, "pumpCheckbox.disabled"), true);
  await evaluateOnPage(page, "pumpCheckbox.click();window.releaseExpected()");
  await waitOnPage(
    page,
    "ridingPreview('lib/expected-faults.js').expectedFaultsError.rawVal.key==='44/0'",
    "Expected write refused by the endpoint"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "refusedWrites"), 1, "One request while an Expected change is pending.");
  assert.equal(await evaluateOnPage(page, "!!document.querySelector('[data-code=P0A07] .fault-save-error')"), true);

  assert.equal(
    await evaluateOnPage(page, "pumpCheckbox.checked"),
    false,
    "A refused Expected change cannot look saved."
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelectorAll('.fault-save-error').length"),
    1,
    "Only the affected code gets the write error."
  );

  await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').connection.val='offline'");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "!!document.querySelector('[data-active-state=unknown]')"),
    true,
    "A lost active list is visibly unknown."
  );
  await evaluateOnPage(page, "ridingPreview('lib/store.js').connection.val='live'");
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "!!document.querySelector('[data-active-state=unknown]')"), false);
  await openFaults(page, file, theme, "different-symptom");
  await evaluateOnPage(page, "document.querySelector('.stored-faults').open=true");
  await openCode(page, "B1012");
  assert.match(
    String(
      await evaluateOnPage(page, "document.querySelector('[data-code=B1012] .layout-accordion-body').textContent")
    ),
    /This component’s record belongs to B1013/
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelectorAll('[data-code=B1012] [data-record-field]').length"),
    0,
    "Another symptom's values cannot appear under B1012."
  );
  assert.match(
    String(await evaluateOnPage(page, "document.querySelector('[data-code=B1012] .fault-field-list').textContent")),
    /Vehicle state · Beam current · Lights status · 12 V supply · 12 V input/
  );
  await assertFaultLayout(page);
  for (const [variant, missing] of [
    ["partial", 5],
    ["empty-partial", 7],
  ] as const) {
    await openFaults(page, file, theme, variant);
    await openCode(page, "P0A07");
    assert.equal(
      await evaluateOnPage(page, "document.querySelectorAll('[data-code=P0A07] [data-record-field]').length"),
      7
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelectorAll('[data-code=P0A07] [data-field-state=missing]').length"),
      missing
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-code=P0A07] [data-cycle-age]').textContent"),
      "Cycle age unavailable"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelector('[data-code=P0A07]').textContent.includes('No fields recorded')"
      ),
      false,
      "A cut-short reply cannot claim this code records no fields."
    );
    await assertFaultLayout(page);
  }
  await openFaults(page, file, theme, "not-read");
  await openCode(page, "P0A07");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-code=P0A07] [data-record-state]').dataset.recordState"),
    "not-read"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelectorAll('[data-code=P0A07] [data-record-field]').length"),
    0
  );
  await openFaults(page, file, theme, "captured");
  await openCode(page, "P0A07");
  await evaluateOnPage(
    page,
    "window.beforeFaultFetch=window.fetch;window.fetch=(url,options)=>String(url).includes('/freeze-frames')?Promise.resolve({ok:false,status:503}):beforeFaultFetch(url,options);ridingPreview('lib/router.js').showView('ride')"
  );
  await evaluateOnPage(page, FRAME);
  await evaluateOnPage(page, "ridingPreview('lib/router.js').showView('faults')");
  await waitOnPage(
    page,
    "document.querySelector('[data-code=P0A07] [data-record-state]')?.dataset.recordState==='unavailable'",
    "failed refresh rejects cached values"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelectorAll('[data-code=P0A07] [data-record-field]').length"),
    0
  );
  for (const state of ["clear", "missing"]) {
    await openPreview(page, file, "#faults", `fault-${state}-${theme}`, `&fault-state=${state}`);
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelectorAll('.faults-view > .fault-list > .fault-row').length"),
      0
    );
    assert.equal(
      await evaluateOnPage(page, "!!document.querySelector('[data-active-state=unknown]')"),
      state === "missing"
    );
    await assertFaultLayout(page);
  }
  console.log(
    `  ✓ ${theme}: all recorded values/units/age, stable disclosures, one Expected write, refusal, symptom identity, partial/missing records and honest unavailable states`
  );
}

export async function checkFaultNavigation(page: HeadlessPage, file: string) {
  await openPreview(page, file, "#faults/report", "legacy-fault-report");
  await waitOnPage(
    page,
    "location.hash==='#faults'&&!!document.querySelector('.faults-view')",
    "legacy report URL opens the one Faults page"
  );
  await reloadPage(page);
  await assertFaultsContent(page);
  await evaluateOnPage(page, "document.querySelector('.tabs a[href$=\"#ride\"]').click()");
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(page, "!!document.querySelector('.faults-view')", "Back to Faults");
  await evaluateOnPage(page, "history.forward()");
  await waitOnPage(page, "!!document.querySelector('.ride-view')", "Forward to Ride");
  await evaluateOnPage(page, "ridingPreview('lib/destination.js').openDestination('bike-information')");
  await waitOnPage(page, "document.querySelector('h2')?.textContent==='This ride'", "Bike information");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.settings-page a[href=\"#faults\"]')"),
    null,
    "Bike uses the persistent Faults tab without an extra navigation row."
  );
  await evaluateOnPage(page, "document.querySelector('.tabs a[href$=\"#faults\"]').click()");
  await waitOnPage(
    page,
    "!!document.querySelector('.faults-view')&&!location.search.includes('panel=')",
    "Bike enters the same Faults page"
  );
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(
    page,
    "ridingPreview('lib/destination.js').destination.val==='bike-information'",
    "Back retains Bike origin"
  );
  for (const kind of ["high_beam", "btn_cruise_set"]) {
    await openFaults(page, file, "dark", "captured");
    await evaluateOnPage(
      page,
      "document.querySelector('.stored-faults').open=true;document.querySelector('[data-code=P0A07]').open=true;window.scrollTo(0,300)"
    );
    await evaluateOnPage(page, FRAME);
    assert.ok(Number(await evaluateOnPage(page, "scrollY")) > 0);
    await gesture(page, kind);
    await waitOnPage(
      page,
      "location.hash==='#ride'&&scrollY===0",
      "both gestures leave the scrolled Faults page for Ride"
    );
  }
  console.log("  ✓ Faults: one route, legacy URL, browser history, Bike bottom tab and both handlebar gestures");
}

async function openFaults(page: HeadlessPage, file: string, theme: string, variant: string) {
  await openPreview(page, file, "#faults", `records-${variant}-${theme}`, `&fault-records=${variant}`);
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await assertFaultsContent(page);
  await waitOnPage(
    page,
    "document.querySelector('[data-code=P0A07] [data-record-state]')?.dataset.recordState!=='loading'&&!!document.querySelector('[data-fault-key=\"40/0\"]')",
    "captured records and dictionary"
  );
}
async function openCode(page: HeadlessPage, code: string) {
  await evaluateOnPage(page, `document.querySelector('[data-code=${JSON.stringify(code)}]').open=true`);
  await evaluateOnPage(page, FRAME);
}
export async function assertFaultLayout(page: HeadlessPage) {
  const measured = await evaluateOnPage(
    page,
    `(()=>{const view=document.querySelector('.faults-view');return{width:innerWidth,body:document.body.scrollWidth,tabs:document.querySelectorAll('.tabs a').length,small:[...view.querySelectorAll('summary,.fault-expected')].filter(element=>element.getClientRects().length&&(element.getBoundingClientRect().height<44||element.getBoundingClientRect().width<44)).length,clipped:[...view.querySelectorAll('.fault-title,.fault-record-row,.fault-field-value,.fault-sub')].filter(element=>element.getClientRects().length&&(element.scrollWidth>element.clientWidth+1||getComputedStyle(element).textOverflow==='ellipsis')).map(element=>element.textContent)}})()`
  );
  assert.deepEqual(measured, { width: 390, body: 390, tabs: 5, small: 0, clipped: [] });
}
