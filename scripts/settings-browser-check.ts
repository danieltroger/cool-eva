import assert from "assert/strict";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkSettingsBrowser(page: HeadlessPage, previewFile: string): Promise<void> {
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=bike&settings=unconfirmed`);
  await waitOnPage(
    page,
    "document.body.innerText.includes('Settings unconfirmed')",
    "the initial unread settings state"
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.settings-page select')].every(select=>select.value===''&&select.disabled)"
    ),
    true,
    "Unread settings must never present fallback Off as a saved or active choice."
  );
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=bike&settings=confirmed`);
  await waitOnPage(page, "document.body.innerText.includes('Saved: Off.')", "the first settings readback");
  await evaluateOnPage(
    page,
    "SETTINGS.ok=false;SETTINGS.fault='Synthetic preserved document fault';SETTINGS.revision++"
  );
  await waitOnPage(
    page,
    "document.body.innerText.includes('Repair instructions')&&document.body.innerText.includes('Retry settings after repair')",
    "a fault that arrived after the initial render"
  );
  assert.equal(await evaluateOnPage(page, "document.body.innerText.includes('Saved choice unreadable')"), true);
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=bike-information&service-refusal=1`);
  await waitOnPage(page, "document.body.innerText.includes('Lifetime battery statistics')", "the service-read card");
  await evaluateOnPage(
    page,
    `window.fetch=(original=>(input,init)=>String(input)==='/lifetime-read'&&init?.method==='POST'?Promise.resolve(new Response(JSON.stringify({answered:null,measurement:null,message:'Service data is unavailable. Resolve the Settings fault before reading.'}),{status:403,headers:{'Content-Type':'application/json'}})):original(input,init))(window.fetch);[...document.querySelectorAll('.owner-action')].find(row=>row.innerText.includes('Lifetime battery statistics')).querySelector('button').click()`
  );
  await waitOnPage(page, "document.body.innerText.includes('Confirm read')", "the armed service read");
  await evaluateOnPage(page, "new Promise(resolve=>setTimeout(resolve,450))");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.owner-action')].find(row=>row.innerText.includes('Lifetime battery statistics')).querySelector('button').click()"
  );
  await waitOnPage(
    page,
    "document.body.innerText.includes('Service data is unavailable. Resolve the Settings fault before reading.')",
    "the real service-data repair message"
  );
  assert.equal(await evaluateOnPage(page, "document.body.innerText.includes('This dashboard is out of date')"), false);
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=bike&reload-check=1`);
  await waitOnPage(
    page,
    "document.body.innerText.includes('Saved: Off.')",
    "settings before the cached-client refusal"
  );
  await evaluateOnPage(
    page,
    `window.fetch=(original=>(input,init)=>init?.method==='PATCH'?Promise.resolve(new Response(JSON.stringify({csrfRefusal:true,message:'Reload the page'}),{status:403,headers:{'Content-Type':'application/json'}})):original(input,init))(window.fetch);const select=document.querySelector('select[aria-label="Coolant probes"]');select.value='true';select.dispatchEvent(new Event('change',{bubbles:true}));select.closest('.settings-card').querySelector('button:last-child').click()`
  );
  await waitOnPage(
    page,
    "document.body.innerText.includes('This dashboard is out of date')",
    "the reactive reload notice"
  );
  await evaluateOnPage(page, "localStorage.removeItem('cool-eva.setup-seen:synthetic-pi')");
  await gotoPage(page, `file://${previewFile}?scene=parked&notice-check=1#ride`);
  await waitOnPage(page, "!!document.querySelector('.migration-notice')", "the first-open riding notice");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('button')].find(button=>button.textContent==='Got it').click()"
  );
  await waitOnPage(page, "!document.querySelector('.migration-notice')", "the dismissed notice's wrapper to disappear");
  assert.equal(
    await evaluateOnPage(
      page,
      "Math.round(document.querySelector('.view').getBoundingClientRect().top-document.querySelector('.header').getBoundingClientRect().bottom)"
    ),
    0
  );
  const dimensions = await evaluateOnPage(
    page,
    "[innerWidth,document.body.scrollWidth,document.querySelector('.header .menu').getBoundingClientRect().height]"
  );
  assert.deepEqual(dimensions, [390, 390, 44]);
  await checkConnectionLayouts(page, previewFile);
  await checkHotspotOwnership(page, previewFile);
  console.log(
    "  ✓ settings: unread choices, fault/CSRF distinction, zero-height dismissal, full-width connection fields, compact actions and the actual Siri repair route"
  );
}

async function checkHotspotOwnership(page: HeadlessPage, previewFile: string): Promise<void> {
  for (const ownership of ["network", "manual", "unknown"]) {
    await gotoPage(
      page,
      `file://${previewFile}?scene=parked&panel=settings&section=connections&hotspot-owner=${ownership}`
    );
    await waitOnPage(
      page,
      `(()=>{const input=document.querySelector('input[aria-label="Hotspot name used for connection checks"]');return input?.value==='Synthetic hotspot'&&input.readOnly===${ownership !== "manual"}&&document.body.innerText.includes('Saved:')})()`,
      "hotspot ownership readback"
    );
    const field = await evaluateOnPage(
      page,
      "(()=>{const input=document.querySelector('input[aria-label=\"Hotspot name used for connection checks\"]');return {readOnly:input.readOnly,value:input.value,save:!![...input.closest('.settings-card').querySelectorAll('button')].find(button=>button.textContent==='Save')}})()"
    );
    assert.deepEqual(field, {
      readOnly: ownership !== "manual",
      value: "Synthetic hotspot",
      save: ownership === "manual",
    });
    if (ownership === "network") {
      await waitOnPage(
        page,
        "document.body.innerText.includes('Set by your saved Phone hotspot network')",
        "network-owned name explanation"
      );
    }
  }
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=connections&hotspot-owner=manual`);
  await waitOnPage(
    page,
    "!!document.querySelector('input[aria-label=\"Hotspot name used for connection checks\"]')&&!document.querySelector('input[aria-label=\"Hotspot name used for connection checks\"]').readOnly",
    "editable unowned name"
  );
  await evaluateOnPage(
    page,
    "window.hotspotDraftInput=document.querySelector('input[aria-label=\"Hotspot name used for connection checks\"]');window.hotspotDraftInput.focus();window.hotspotDraftInput.value='Synthetic unsaved draft';window.hotspotDraftInput.dispatchEvent(new Event('input',{bubbles:true}));window.hotspotSettingsReads=0;window.fetch=(original=>(input,init)=>{if(String(input)==='/settings'&&(!init?.method||init.method==='GET'))window.hotspotSettingsReads++;return original(input,init)})(window.fetch)"
  );
  await waitOnPage(page, "window.hotspotSettingsReads>0", "settings refresh during an unowned edit");
  assert.equal(
    await evaluateOnPage(
      page,
      "document.activeElement===window.hotspotDraftInput&&window.hotspotDraftInput.value==='Synthetic unsaved draft'"
    ),
    true,
    "an unchanged manual editor must retain its focus and draft during readback"
  );
  await evaluateOnPage(
    page,
    "SETTINGS.hotspotNameOwnership='network';SETTINGS.saved.phoneHotspotSsid='Synthetic saved hotspot';SETTINGS.active.phoneHotspotSsid='Synthetic saved hotspot';SETTINGS.revision++"
  );
  await waitOnPage(
    page,
    "document.querySelector('input[aria-label=\"Hotspot name used for connection checks\"]').readOnly",
    "another client registering a hotspot"
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "document.querySelector('input[aria-label=\"Hotspot name used for connection checks\"]').value"
    ),
    "Synthetic saved hotspot",
    "a stale draft cannot be shown as the network-owned name"
  );
  console.log(
    "  ✓ hotspot-check ownership: network/unknown read-only, manual editable, saved name replaces an unsaved draft when ownership changes"
  );
}

async function checkConnectionLayouts(page: HeadlessPage, previewFile: string): Promise<void> {
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=connections`);
  await waitOnPage(page, "document.body.innerText.includes('A shared key is already saved.')", "the saved key state");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('button')].find(button=>button.textContent==='New key').click()"
  );
  await waitOnPage(page, "!!document.querySelector('input[aria-label=\"New Bluetooth key\"]')", "the draft key");
  await assertConnectionLayout(page, "Dashboard Bluetooth", 'input[aria-label="New Bluetooth key"]', ["Copy", "Save"]);
  await evaluateOnPage(
    page,
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Synthetic clipboard denial')}}});window.coolEvaNative={platform:'ios',saveFile:async()=>{throw new Error('Synthetic export failure')}};[...document.querySelectorAll('button')].find(button=>button.textContent==='Copy').click()"
  );
  await waitOnPage(page, "document.body.innerText.includes('No backup is confirmed.')", "the failed key backup");
  await assertConnectionLayout(page, "Dashboard Bluetooth", 'input[aria-label="New Bluetooth key"]', [
    "Copy",
    "Show key",
    "Save",
  ]);
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=connections`);
  await waitOnPage(page, "document.body.innerText.includes('A shared key is already saved.')", "connections readback");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('button')].find(button=>button.textContent==='Scan').click()"
  );
  await waitOnPage(
    page,
    "!!document.querySelector('select[aria-label=\"Choose your motorcycle\"]')",
    "motorcycle candidates"
  );
  await assertConnectionLayout(page, "Motorcycle connection", "select", ["Scan", "Save"]);
  await evaluateOnPage(
    page,
    "const picker=document.querySelector('select[aria-label=\"Choose your motorcycle\"]');picker.value='02:00:00:00:00:02';picker.dispatchEvent(new Event('change',{bubbles:true}))"
  );
  await waitOnPage(
    page,
    "document.body.innerText.includes('Draft motorcycle: Synthetic Energica · 02:00:00:00:00:02')",
    "the complete selected identity"
  );
  await assertConnectionLayout(page, "Motorcycle connection", "select", ["Scan", "Cancel", "Save"]);
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings`);
  await waitOnPage(page, "!!document.querySelector('button[aria-label=\"Open Advanced\"]')", "the Settings map");
  await evaluateOnPage(page, "document.querySelector('button[aria-label=\"Open Advanced\"]').click()");
  await waitOnPage(page, "document.querySelector('h2')?.textContent==='Advanced'", "the spoken Advanced route");
  for (const source of ["legacy", "fresh"]) {
    await evaluateOnPage(page, `SETTINGS.source=${JSON.stringify(source)};SETTINGS.revision++`);
    await waitOnPage(
      page,
      source === "fresh"
        ? "document.body.innerText.includes('Welcome to Cool Eva')"
        : "document.body.innerText.includes('What changed on this Pi')",
      "the installer source readback"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.settings-page a[href$=\"#saving-a-waypoint-from-siri\"]')].some(link=>link.textContent==='Update Siri shortcut →')"
      ),
      true,
      `The spoken Siri route must exist on ${source} installations.`
    );
  }
}

async function assertConnectionLayout(
  page: HeadlessPage,
  title: string,
  fieldSelector: string,
  captions: string[]
): Promise<void> {
  const measured = await evaluateOnPage(
    page,
    `(()=>{const card=[...document.querySelectorAll('.settings-card')].find(card=>card.querySelector('h3')?.textContent===${JSON.stringify(title)});const fields=card.querySelector('.settings-form-fields');const field=fields.querySelector(${JSON.stringify(fieldSelector)});const rows=card.querySelectorAll('.settings-actions');const row=rows[0];const buttons=[...row.querySelectorAll('button')];const width=card.clientWidth-parseFloat(getComputedStyle(card).paddingLeft)-parseFloat(getComputedStyle(card).paddingRight);return {fullWidth:[fields,field,...fields.querySelectorAll('.settings-note')].every(element=>Math.abs(element.getBoundingClientRect().width-width)<1),separate:row.getBoundingClientRect().top>=fields.getBoundingClientRect().bottom,rows:rows.length,captions:buttons.map(button=>button.textContent),targets:buttons.every(button=>button.getBoundingClientRect().width>=44&&button.getBoundingClientRect().width<=150&&button.getBoundingClientRect().height>=44),gaps:buttons.slice(1).every((button,index)=>Math.abs(button.getBoundingClientRect().left-buttons[index].getBoundingClientRect().right-8)<1),trailing:Math.abs(buttons.at(-1).getBoundingClientRect().right-fields.getBoundingClientRect().right)<1}})()`
  );
  assert.deepEqual(
    measured,
    { fullWidth: true, separate: true, rows: 1, captions, targets: true, gaps: true, trailing: true },
    `${title} keeps readable fields above one compact action row.`
  );
}
