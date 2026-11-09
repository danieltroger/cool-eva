import assert from "node:assert/strict";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkSettingsCleanupBrowser(page: HeadlessPage, previewFile: string): Promise<void> {
  for (const theme of ["dark", "light"]) {
    await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=phone&cleanup=${theme}`);
    await waitOnPage(page, "!!document.querySelector('.settings-page .toggle-row button')", "phone preferences");
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').setThemePreference(${JSON.stringify(theme)})`);
    await waitOnPage(page, `document.documentElement.dataset.theme===${JSON.stringify(theme)}`, "the cleanup theme");
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.settings-page .toggle-row button')].every(control=>getComputedStyle(control).textAlign==='left')"
      ),
      true,
      "Phone preference values align left."
    );
    await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=bike&cleanup=${theme}`);
    await waitOnPage(page, "document.querySelectorAll('.setting-help').length===3", "Bike setup help");
    assert.equal(await evaluateOnPage(page, "document.querySelectorAll('.setting-help').length"), 3);
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.setting-control')].every(row=>{const control=row.querySelector('select').getBoundingClientRect();const help=row.querySelector('summary').getBoundingClientRect();return help.left-control.right>=0&&help.left-control.right<=12&&help.height>=44&&help.width>=44;})"
      ),
      true,
      "Each Bike setup field owns adjacent help."
    );
    await evaluateOnPage(page, "document.querySelector('.setting-help > summary').click()");
    assert.equal(
      await evaluateOnPage(
        page,
        "(()=>{const help=document.querySelector('.setting-help[open] .settings-note').getBoundingClientRect();return help.width>0&&help.left>=0&&help.right<=390;})()"
      ),
      true
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.settings-page select')].every(control=>getComputedStyle(control).textAlign==='left')"
      ),
      true,
      "Bike setup values align left."
    );
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
    await waitOnPage(page, "document.querySelector('h2')?.textContent==='Advanced'", "Advanced setup notes");
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
