import assert from "node:assert/strict";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkSettingsCleanupBrowser(page: HeadlessPage, previewFile: string): Promise<void> {
  for (const theme of ["dark", "light"]) {
    await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=phone&cleanup=${theme}`);
    await waitOnPage(page, "!!document.querySelector('.settings-page select[aria-label=Units]')", "phone preferences");
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').setThemePreference(${JSON.stringify(theme)})`);
    await waitOnPage(page, `document.documentElement.dataset.theme===${JSON.stringify(theme)}`, "the cleanup theme");
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.settings-page select')].every(control=>getComputedStyle(control).textAlign==='left')"
      ),
      true,
      "Phone preference values align left."
    );
    await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=bike&cleanup=${theme}`);
    await waitOnPage(
      page,
      "document.querySelectorAll('[data-settings-section=bike] .setting-help').length===3",
      "Bike setup help"
    );
    await checkBikeSetupStatus(page);
    assert.equal(
      await evaluateOnPage(page, "document.querySelectorAll('[data-settings-section=bike] .setting-help').length"),
      3
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('[data-settings-section=bike] .settings-field')].every(field=>{const control=field.querySelector('[role=switch]').getBoundingClientRect();const help=field.querySelector('summary').getBoundingClientRect();return control.left-help.right>=0&&control.left-help.right<=12&&help.height>=44&&help.width>=44;})"
      ),
      true,
      "Each Bike setup field owns adjacent help."
    );
    await evaluateOnPage(page, "document.querySelector('[role=switch][aria-label=\"Coolant probes fitted\"]').click()");
    await waitOnPage(page, "!!document.querySelector('[data-settings-save]')", "B4: editing before opening help");
    await evaluateOnPage(
      page,
      "document.querySelector('[data-settings-section=bike] .setting-help > summary').click()"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "(()=>{const help=document.querySelector('.setting-help[open] .settings-note').getBoundingClientRect();return help.width>0&&help.left>=0&&help.right<=390;})()"
      ),
      true,
      "B4: help stays inside the viewport while editing."
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.settings-page select')].every(control=>getComputedStyle(control).textAlign==='left')"
      ),
      true,
      "Bike setup values align left."
    );
    await evaluateOnPage(page, "document.querySelector('[data-settings-cancel]').click()");
    await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=connections&cleanup=${theme}`);
    await waitOnPage(page, "!!document.querySelector('.settings-page input')", "Connections");
    assert.equal(
      await evaluateOnPage(
        page,
        "/Motorcycle connection|Bike data . CAN adapter|Choose motorcycle/.test(document.querySelector('.settings-page').innerText)"
      ),
      false,
      "Removed settings cannot return through a setup nudge."
    );
    await evaluateOnPage(
      page,
      "(async()=>{SETTINGS.notices=['hub-address-invalid','hub-discover-once'];SETTINGS.revision++;await ridingPreview('lib/settings.js').refreshSettings();ridingPreview('lib/destination.js').openDestination('settings','advanced');})()"
    );
    await waitOnPage(
      page,
      "document.querySelector('[data-settings-section=advanced]')?.open===true",
      "Advanced setup notes"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "/Choose motorcycle|Choose your own motorcycle/.test(document.querySelector('.settings-page').innerText)"
      ),
      false
    );
    await gotoPage(page, `file://${previewFile}?scene=parked&panel=bike-information&cleanup=${theme}`);
    await waitOnPage(page, "!!document.querySelector('.raw-grid')", "stored Bike history");
    await evaluateOnPage(
      page,
      "(()=>{const library=ridingPreview('lib/lifetime.js');const stored=library.lifetimeStats.rawVal;library.lifetimeStats.val={...stored,reading:{...stored.reading,statistics:{...stored.reading.statistics,rows:stored.reading.statistics.rows.map((row,index)=>index===0?{...row,status:'rejected',raw:65535,value:null}:row)}}};})()"
    );
    await waitOnPage(
      page,
      "document.querySelector('.raw-value.raw-fault')?.textContent==='fault'",
      "rejected Bike history"
    );
    await evaluateOnPage(
      page,
      "ridingPreview('lib/lifetime.js').lifetimeStats.val={...ridingPreview('lib/lifetime.js').lifetimeStats.rawVal,reading:null}"
    );
    await waitOnPage(
      page,
      "[...document.querySelectorAll('.section')].some(node=>node.textContent==='Bike history · —')",
      "empty Bike history"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "/node --experimental-strip-types|service stopped|menu → Service mode/.test(document.querySelector('.settings-page').innerText)"
      ),
      false,
      "Empty Bike history uses rider copy."
    );
    await evaluateOnPage(
      page,
      "STATUS.log.enabled=false;ridingPreview('views/sheet.js').refreshStatus();window.cleanupFlushes=0;window.cleanupDownloads=[];window.fetch=(original=>(input,init)=>{if(String(input)==='/recording/flush'&&init?.method==='POST'){window.cleanupFlushes++;}return original(input,init);})(window.fetch);Object.defineProperty(window.__previewLocation,'href',{configurable:true,set(target){window.cleanupDownloads.push(target);}})"
    );
    await waitOnPage(page, "ridingPreview('views/sheet.js').status.rawVal?.log.enabled===false", "recording off");
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.owner-action')].find(row=>row.querySelector('.owner-action-status').textContent==='Download all ride logs').querySelector('button').click()"
    );
    await waitOnPage(page, "window.cleanupDownloads.length===1", "the archive download action");
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "({flushes:window.cleanupFlushes,downloads:window.cleanupDownloads,destination:ridingPreview('lib/destination.js').destination.rawVal})"
      ),
      { flushes: 1, downloads: ["/dl"], destination: "bike-information" },
      "Recording off still seals and downloads archives without leaving Bike."
    );
  }
  console.log(
    "  ✓ Settings cleanup: left alignment, removed controls, Bike fault/empty states and download with recording off, both themes"
  );
}

export async function checkBikeSetupStatus(page: HeadlessPage): Promise<void> {
  assert.deepEqual(
    await bikeSetupStatuses(page),
    [
      {
        owner: "Radiator fan fitted",
        text: "Active: Driver ready; no rotation sensor",
        inside: true,
        oneLine: true,
      },
    ],
    "Readiness belongs inside its own card; the coolant Off choice is already shown there."
  );
  await evaluateOnPage(
    page,
    "(()=>{const client=ridingPreview('lib/settings.js');window.bikeStatusBaseline=client.settings.rawVal;const current=client.settings.rawVal;client.acceptSettings({...current,active:{...current.active,radiatorFanEnabled:false},readiness:{...current.readiness,fan:'Off'}});})()"
  );
  await waitOnPage(
    page,
    "[...document.querySelectorAll('[data-settings-section=bike] [role=status]')].every(node=>!node.textContent)",
    "fan Off readback"
  );
  assert.deepEqual(await bikeSetupStatuses(page), [], "A fan Off status must not repeat its active choice.");
  await evaluateOnPage(
    page,
    "(()=>{const client=ridingPreview('lib/settings.js');const current=window.bikeStatusBaseline;client.acceptSettings({...current,active:{...current.active,coolantProbesEnabled:true},readiness:{...current.readiness,coolant:'Unavailable',fan:'Driver ready — rotation is not measured'}});})()"
  );
  await waitOnPage(
    page,
    "document.querySelector('.settings-page')?.innerText.includes('Active: Unavailable')",
    "distinct coolant diagnostics"
  );
  assert.deepEqual(
    await bikeSetupStatuses(page),
    [
      { owner: "Coolant probes fitted", text: "Active: Unavailable", inside: true, oneLine: true },
      {
        owner: "Radiator fan fitted",
        text: "Active: Driver ready — rotation is not measured",
        inside: true,
        oneLine: true,
      },
    ],
    "Distinct probe and fan diagnostics stay visible inside their owning cards."
  );
  await evaluateOnPage(page, "ridingPreview('lib/settings.js').acceptSettings(window.bikeStatusBaseline)");
  await waitOnPage(
    page,
    "document.querySelector('.settings-page')?.innerText.includes('Active: Driver ready; no rotation sensor')",
    "restored Bike setup status"
  );
}

async function bikeSetupStatuses(page: HeadlessPage) {
  return evaluateOnPage(
    page,
    "[...document.querySelectorAll('[data-settings-section=bike] [role=status]')].filter(node=>node.textContent).map(node=>{const card=node.closest('.settings-field');const bounds=node.getBoundingClientRect();const parent=card?.getBoundingClientRect();return {owner:card?.querySelector('.settings-field-label')?.textContent??null,text:node.textContent,inside:!!parent&&bounds.left>=parent.left&&bounds.right<=parent.right&&bounds.top>=parent.top&&bounds.bottom<=parent.bottom,oneLine:bounds.height<=parseFloat(getComputedStyle(node).lineHeight)+1};})"
  );
}
