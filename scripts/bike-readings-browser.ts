import assert from "node:assert/strict";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { FRAME } from "./riding-preview-page.ts";

export async function checkBikeReadingsBrowser(page: HeadlessPage, file: string) {
  for (const theme of ["dark", "light"]) {
    await gotoPage(page, `file://${file}?scene=parked&bike-readings=${theme}#ride`);
    await waitOnPage(page, "document.documentElement.dataset.previewReady==='yes'", "Bike preview");
    await evaluateOnPage(
      page,
      `(()=>{
      ridingPreview('lib/theme.js').setThemePreference(${JSON.stringify(theme)},false);
      WRITE_STATUS.lastServiceStamp={readAt:Date.now()-86400000,dateIso:'2025-05-12T00:00:00.000Z',implausible:null,confirmed:true};
      window.bikeRequests=[];window.failBikeRead=false;
      window.fetch=(original=>async(input,init)=>{
        const path=new URL(String(input),'http://fixture.invalid').pathname;
        const method=init?.method??'GET';
        bikeRequests.push({path,method});
        if(window.failBikeRead&&path==='/vcu-write'&&method==='POST')return new Response(JSON.stringify({status:writeStatus(new URLSearchParams()),result:null,message:'Synthetic read refused'}),{status:409});
        return original(input,init);
      })(window.fetch);
      ridingPreview('lib/destination.js').openDestination('bike-information');
    })()`
    );
    await waitOnPage(
      page,
      "document.querySelector('[data-bike-read=service]')?.textContent==='Read again'&&document.querySelector('.raw-grid')&&document.querySelector('.action-block [role=status]')?.textContent==='12 May 2025'",
      "stored Bike readings"
    );
    assert.equal(await readPosts(page), 0, "Opening Bike uses stored data and sends no motorcycle reads.");
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('[data-this-ride] > .layout-list-row')].map(row=>row.firstChild.textContent)"
      ),
      ["Distance", "Riding time"]
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "/Energy used|Average|Altitude|Satellites/.test(document.querySelector('[data-this-ride]').innerText)"
      ),
      false
    );
    const historyBefore = await evaluateOnPage(page, "document.querySelector('.raw-grid').textContent");
    await evaluateOnPage(page, "document.querySelector('[data-bike-read=history]').click()");
    await waitOnPage(
      page,
      "bikeRequests.filter(request=>request.path==='/lifetime-read'&&request.method==='POST').length===1&&!ridingPreview('lib/bike-readings.js').bikeReadBusy.rawVal",
      "one-tap history read"
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('.raw-grid').textContent"), historyBefore);
    await waitOnPage(page, "!document.querySelector('[data-bike-read=service]').disabled", "stamp read ready");
    await evaluateOnPage(page, "document.querySelector('[data-bike-read=service]').click()");
    await waitOnPage(
      page,
      "document.querySelector('.action-block [role=status]')?.textContent==='fault'",
      "one-tap empty stamp read"
    );
    assert.equal(await readPosts(page), 2, "Each read needs exactly one tap and sends one POST.");
    assert.equal(
      await evaluateOnPage(
        page,
        "/Confirm read|Confirm history/.test(document.querySelector('.settings-page').innerText)"
      ),
      false
    );
    await evaluateOnPage(
      page,
      "WRITE_STATUS.lastServiceStamp={readAt:Date.now(),dateIso:'2025-05-12T00:00:00.000Z',implausible:null,confirmed:true};GATE.safe=false"
    );
    await waitOnPage(
      page,
      "[...document.querySelectorAll('[data-bike-read]')].every(button=>button.disabled&&button.textContent==='Park to read')",
      "parked permissions refresh"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.action-block [role=status]').textContent"),
      "12 May 2025"
    );
    await evaluateOnPage(page, "document.querySelector('[data-bike-read=service]').click();GATE.safe=true");
    assert.equal(await readPosts(page), 2);
    await waitOnPage(page, "!document.querySelector('[data-bike-read=service]').disabled", "parked again");
    await evaluateOnPage(page, "window.failBikeRead=true;document.querySelector('[data-bike-read=service]').click()");
    await waitOnPage(
      page,
      "document.querySelector('.action-block .action-note')?.textContent==='Read failed'&&!ridingPreview('lib/bike-readings.js').bikeReadBusy.rawVal",
      "refused read keeps stored date"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.action-block [role=status]').textContent"),
      "12 May 2025"
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(
        page,
        "innerWidth===390&&document.body.scrollWidth===390&&document.querySelectorAll('.tabs a').length===5"
      ),
      true
    );
  }
  console.log(
    "  ✓ Bike: stored-only entry, one-tap reads, parked feedback, retained dates and compact ride rows, both themes"
  );
}

async function readPosts(page: HeadlessPage) {
  return evaluateOnPage(
    page,
    "bikeRequests.filter(request=>request.method==='POST'&&['/lifetime-read','/vcu-read','/vcu-write'].includes(request.path)).length"
  );
}
