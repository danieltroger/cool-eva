import assert from "node:assert/strict";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkSettingsBatchBrowser(page: HeadlessPage, file: string): Promise<void> {
  for (const theme of ["dark", "light"]) {
    await openSettings(page, file, theme, "initial");
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('[data-settings-section]')].map(node=>node.dataset.settingsSection)"
      ),
      ["phone", "bike", "charging", "connections", "recording", "software", "advanced"]
    );
    assert.equal(await evaluateOnPage(page, "document.querySelectorAll('[data-settings-save]').length"), 0);
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.settings-page a[href$=\"/LICENSE\"]')].map(node=>node.closest('[data-settings-section]')?.dataset.settingsSection).join(',')"
      ),
      "software",
      "The licence has one home in the software section."
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.settings-page').innerText.includes('Who can control')"),
      false
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.settings-page button')].filter(node=>node.textContent==='Save').length"
      ),
      0,
      "M1: no per-field Save controls."
    );
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('[data-settings-section]')].map(node=>node.getBoundingClientRect().left)"
      ),
      [12, 12, 12, 12, 12, 12, 12],
      "N2: every Settings card uses the shared 12px gutter."
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelectorAll('[data-settings-section=advanced] input,[data-settings-section=advanced] select,[data-settings-section=advanced] textarea').length"
      ),
      0,
      "Folders are read-only."
    );
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.settings-page [role=switch]')].map(node=>node.getAttribute('aria-label'))"
      ),
      [
        "Coolant probes fitted",
        "Radiator fan fitted",
        "Custom BMS already flashed",
        "Allow automatic current reduction",
        "Dashboard Bluetooth enabled",
      ],
      "Only existing backend choices are rendered."
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.settings-page button')].some(node=>/^(Open|Discard|Save off)$/.test(node.textContent))"
      ),
      false
    );
    assert.equal(
      await evaluateOnPage(
        page,
        '!!document.querySelector(\'.screen-geometry,[aria-label="Recording directory"],[aria-label="Service data directory"],[aria-label="Network password"],[aria-label="Allow bike controls from this phone"],[aria-label="Save ride history"]\')'
      ),
      false
    );
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[document.querySelector('[aria-label=\"Screen theme\"]').value,document.querySelector('[aria-label=Units]').value]"
      ),
      [theme, "metric"],
      "Displayed choices and drafts must agree on first render."
    );
    await assertGeometry(page);

    await evaluateOnPage(
      page,
      "document.querySelector('[data-settings-section=phone]').open=true;document.querySelector('[data-settings-section=bike]').open=true;window.savedThemeBefore=localStorage.getItem('coolEva.theme');window.savedUnitsBefore=localStorage.getItem('coolEva.units')"
    );
    await selectPreference(page, "Screen theme", theme === "dark" ? "light" : "dark");
    await selectPreference(page, "Units", "imperial");
    await toggle(page, "Coolant probes fitted");
    await toggle(page, "Radiator fan fitted");
    assert.equal(await evaluateOnPage(page, "window.batchRequests.length"), 0, "Editing sends no PATCH.");
    assert.equal(
      await evaluateOnPage(
        page,
        "localStorage.getItem('coolEva.theme')===window.savedThemeBefore&&localStorage.getItem('coolEva.units')===window.savedUnitsBefore"
      ),
      true
    );
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[document.querySelectorAll('[data-settings-save]').length,document.querySelectorAll('[data-settings-cancel]').length]"
      ),
      [1, 1]
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('[data-settings-update]').disabled"), true);
    await evaluateOnPage(page, "document.querySelector('.tabs a[href$=\"#hypermile\"]').click()");
    await waitOnPage(
      page,
      "document.querySelector('[data-settings-save-message]')?.textContent==='Save or cancel before leaving.'",
      "draft navigation protection"
    );
    assert.equal(await evaluateOnPage(page, "!!document.querySelector('[data-settings-batch]')"), true);
    await assertGeometry(page);
    await evaluateOnPage(page, "ridingPreview('lib/destination.js').openRidingView('hypermile')");
    await waitOnPage(page, "!document.querySelector('[data-settings-batch]')", "a route outside Settings");
    await evaluateOnPage(page, "document.querySelector('.tabs a[href$=\"#more\"]').click()");
    await waitOnPage(page, "!!document.querySelector('[data-settings-save]')", "return to the retained Settings draft");
    await evaluateOnPage(page, "document.querySelector('[data-settings-cancel]').click()");
    await waitOnPage(page, "!ridingPreview('lib/settings-batch.js').batchIsDirty()", "complete Cancel");
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[document.querySelector('[aria-label=\"Coolant probes fitted\"]').getAttribute('aria-checked'),document.querySelector('[aria-label=\"Radiator fan fitted\"]').getAttribute('aria-checked'),document.querySelector('[aria-label=\"Screen theme\"]').value,document.querySelector('[aria-label=Units]').value]"
      ),
      ["false", "true", theme, "metric"]
    );
    assert.equal(await evaluateOnPage(page, "window.batchRequests.length"), 0);

    await openSettings(page, file, theme, "saved");
    await evaluateOnPage(
      page,
      "document.querySelector('[data-settings-section=bike]').open=true;window.originalProbe=document.querySelector('[aria-label=\"Coolant probes fitted\"]');originalProbe.focus();originalProbe.click()"
    );
    await waitOnPage(
      page,
      "ridingPreview('lib/settings-batch.js').changes.rawVal.coolantProbesEnabled===true",
      "probe draft"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.activeElement===originalProbe&&originalProbe===document.querySelector('[aria-label=\"Coolant probes fitted\"]')"
      ),
      true,
      "A switch keeps focus while staging a choice."
    );
    await toggle(page, "Radiator fan fitted");
    await evaluateOnPage(page, "document.querySelector('[data-settings-save]').click()");
    await waitOnPage(
      page,
      "!ridingPreview('lib/settings-batch.js').batchIsDirty()&&ridingPreview('lib/settings.js').settings.rawVal.pending.length===2",
      "one confirmed batch save"
    );
    assert.deepEqual(await evaluateOnPage(page, "window.batchRequests"), [
      { revision: 0, changes: { coolantProbesEnabled: true, radiatorFanEnabled: false } },
    ]);
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[ridingPreview('lib/settings.js').settings.rawVal.active.coolantProbesEnabled,document.querySelectorAll('.settings-restart button').length,document.querySelectorAll('[data-settings-save]').length]"
      ),
      [false, 1, 0]
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelector('.settings-restart').innerText.includes('Saved. Applies at next restart.')"
      ),
      true
    );
    await assertGeometry(page);

    await openSettings(page, file, theme, "phone-only");
    await evaluateOnPage(page, "document.querySelector('[data-settings-section=phone]').open=true");
    await selectPreference(page, "Units", "imperial");
    await evaluateOnPage(page, "document.querySelector('[data-settings-save]').click()");
    await waitOnPage(page, "!ridingPreview('lib/settings-batch.js').batchIsDirty()", "phone-only Save");
    assert.equal(await evaluateOnPage(page, "window.batchRequests.length"), 0);
    assert.equal(await evaluateOnPage(page, "localStorage.getItem('coolEva.units')"), "imperial");
    assert.equal(await evaluateOnPage(page, "document.querySelector('.settings-restart').hidden"), true);

    for (const outcome of ["refused", "missing-readback", "disconnect"]) {
      await openSettings(page, file, theme, outcome);
      await evaluateOnPage(page, "document.querySelector('[data-settings-section=bike]').open=true");
      await toggle(page, "Coolant probes fitted");
      await evaluateOnPage(
        page,
        `window.fetch=(original=>(path,options)=>options?.method==='PATCH'?${outcome === "disconnect" ? "Promise.reject(new Error('Synthetic lost reply'))" : `Promise.resolve(new Response(JSON.stringify(${outcome === "refused" ? "{ok:false,message:'Synthetic settings refusal'}" : "{ok:true,message:'Saved.'}"}),{status:${outcome === "refused" ? 409 : 200},headers:{'Content-Type':'application/json'}}))`}:original(path,options))(window.fetch);document.querySelector('[data-settings-save]').click()`
      );
      await waitOnPage(page, "!ridingPreview('lib/settings-batch.js').batchBusy.rawVal", `${outcome} completion`);
      assert.equal(
        await evaluateOnPage(page, "ridingPreview('lib/settings-batch.js').changes.rawVal.coolantProbesEnabled"),
        true
      );
      assert.equal(await evaluateOnPage(page, "!!document.querySelector('[data-settings-cancel]')"), true);
      assert.equal(
        await evaluateOnPage(
          page,
          "!document.querySelector('.settings-restart')||document.querySelector('.settings-restart').hidden"
        ),
        true
      );
      await assertGeometry(page);
      await evaluateOnPage(page, "document.querySelector('[data-settings-cancel]').click()");
    }

    await openSettings(page, file, theme, "stale");
    await evaluateOnPage(page, "document.querySelector('[data-settings-section=bike]').open=true");
    await toggle(page, "Coolant probes fitted");
    await evaluateOnPage(page, "SETTINGS.revision++;ridingPreview('lib/settings.js').refreshSettings()");
    await waitOnPage(
      page,
      "document.querySelector('[data-settings-save-message]')?.textContent.includes('cancel and review')",
      "another client's revision"
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('[data-settings-save]').disabled"), true);
    assert.equal(await evaluateOnPage(page, "ridingPreview('lib/settings-batch.js').baseSettings.rawVal.revision"), 0);
    await evaluateOnPage(page, "document.querySelector('[data-settings-cancel]').click()");
    assert.equal(await evaluateOnPage(page, "window.batchRequests.length"), 0);

    await openSettings(page, file, theme, "bluetooth");
    await evaluateOnPage(page, "document.querySelector('[data-settings-section=connections]').open=true");
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('button')].find(node=>node.textContent==='New key').click()"
    );
    await waitOnPage(
      page,
      "!!ridingPreview('lib/settings-batch.js').changes.rawVal.dashboardBluetoothSecret",
      "staged key"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[aria-label=\"Bluetooth access key\"]').type"),
      "password"
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('[data-settings-save]').disabled"), true);
    await evaluateOnPage(
      page,
      "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Synthetic clipboard denial')}}});window.coolEvaNative={platform:'ios',saveFile:async()=>{throw new Error('Synthetic export failure')}};[...document.querySelectorAll('button')].find(node=>node.textContent==='Copy').click()"
    );
    await waitOnPage(
      page,
      "ridingPreview('lib/settings-batch.js').batchMessage.rawVal.includes('could not be saved')",
      "key export failure"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[aria-label=\"Bluetooth access key\"]').type"),
      "password",
      "A failed copy cannot reveal the key."
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('[data-settings-save]').disabled"), true);
    await evaluateOnPage(page, "document.querySelector('[data-settings-cancel]').click()");
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[aria-label=\"Bluetooth access key\"]').value"),
      ""
    );

    await openSettings(page, file, theme, "csrf");
    await evaluateOnPage(page, "document.querySelector('[data-settings-section=bike]').open=true");
    await toggle(page, "Coolant probes fitted");
    await evaluateOnPage(
      page,
      "window.fetch=(original=>(path,options)=>options?.method==='PATCH'?Promise.resolve(new Response(JSON.stringify({csrfRefusal:true,message:'Reload the page'}),{status:403,headers:{'Content-Type':'application/json'}})):original(path,options))(window.fetch);document.querySelector('[data-settings-save]').click()"
    );
    await waitOnPage(
      page,
      "[...document.querySelectorAll('.settings-page .settings-card')].some(card=>card.querySelector('button')?.textContent==='Reload'&&card.querySelector('.settings-note')?.textContent.includes('This dashboard is out of date'))",
      "the existing cached-client guard"
    );
    assert.equal(
      await evaluateOnPage(page, "ridingPreview('lib/settings-batch.js').changes.rawVal.coolantProbesEnabled"),
      true
    );

    await openSettings(page, file, theme, "unconfirmed", "&settings=unconfirmed");
    await evaluateOnPage(
      page,
      "document.querySelector('[data-settings-section=bike]').open=true;document.querySelector('[data-settings-section=phone]').open=true"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('[data-settings-section=bike] [role=switch]')].every(node=>node.hidden&&node.disabled)"
      ),
      true
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('[aria-label=Units]').disabled"), false);
    await selectPreference(page, "Units", "imperial");
    await evaluateOnPage(page, "document.querySelector('[data-settings-save]').click()");
    await waitOnPage(page, "!ridingPreview('lib/settings-batch.js').batchIsDirty()", "offline phone preference");
    assert.equal(await evaluateOnPage(page, "window.batchRequests.length"), 0);
    await openSettings(page, file, theme, "fault");
    await evaluateOnPage(
      page,
      "SETTINGS.ok=false;SETTINGS.fault='Synthetic preserved document fault';SETTINGS.revision++;ridingPreview('lib/settings.js').refreshSettings()"
    );
    await waitOnPage(
      page,
      "document.querySelector('.settings-page .settings-link')?.textContent.includes('Repair instructions')",
      "preserved-document recovery"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('[role=switch]')].every(node=>node.hidden&&node.disabled)"
      ),
      true
    );
  }
  console.log(
    "  ✓ inline Settings: seven sections, one Save/Cancel, reversible previews, one CAS batch, stable switches, honest failures, current revision, key privacy and read-only recording/folders; both themes"
  );
}

async function openSettings(
  page: HeadlessPage,
  file: string,
  theme: string,
  scenario: string,
  query = ""
): Promise<void> {
  await gotoPage(page, `file://${file}?scene=parked&panel=settings&batch=${theme}-${scenario}${query}`);
  await waitOnPage(page, "!!document.querySelector('[data-settings-batch]')", "inline Settings");
  if (!query.includes("unconfirmed")) {
    await waitOnPage(page, "ridingPreview('lib/settings.js').settingsConfirmed.rawVal", "confirmed Settings");
  }
  await evaluateOnPage(
    page,
    `ridingPreview('lib/theme.js').setThemePreference(${JSON.stringify(theme)},false);ridingPreview('lib/units.js').setUnitSystem('metric',false);ridingPreview('lib/settings-batch.js').beginSettingsBatch();window.batchRequests=[];window.fetch=(original=>(path,options)=>{if(options?.method==='PATCH'){window.batchRequests.push(JSON.parse(options.body));}return original(path,options);})(window.fetch)`
  );
  await waitOnPage(page, `document.documentElement.dataset.theme===${JSON.stringify(theme)}`, "Settings palette");
}

async function toggle(page: HeadlessPage, title: string): Promise<void> {
  await evaluateOnPage(page, `document.querySelector('[role=switch][aria-label=${JSON.stringify(title)}]').click()`);
  await evaluateOnPage(page, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
}

async function selectPreference(page: HeadlessPage, title: string, value: string): Promise<void> {
  await evaluateOnPage(
    page,
    `(()=>{const select=document.querySelector('select[aria-label=${JSON.stringify(title)}]');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`
  );
  await evaluateOnPage(page, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
}

async function assertGeometry(page: HeadlessPage): Promise<void> {
  await evaluateOnPage(page, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const geometry = (await evaluateOnPage(
    page,
    `(()=>{const footer=document.querySelector('.settings-footer');const tabs=document.querySelector('.tabs').getBoundingClientRect();const box=footer.getBoundingClientRect();return {width:innerWidth,body:document.body.scrollWidth,dpr:devicePixelRatio,footerVisible:!footer.hidden,footerHeight:box.height,pagePadding:parseFloat(getComputedStyle(document.querySelector('[data-settings-batch]')).paddingBottom),footerBottom:box.bottom,tabsTop:tabs.top,buttons:[...footer.querySelectorAll('button')].filter(node=>node.getClientRects().length).map(node=>{const bounds=node.getBoundingClientRect();return {width:bounds.width,height:bounds.height,bottom:bounds.bottom}})}})()`
  )) as {
    width: number;
    body: number;
    dpr: number;
    footerVisible: boolean;
    footerHeight: number;
    pagePadding: number;
    footerBottom: number;
    tabsTop: number;
    buttons: { width: number; height: number; bottom: number }[];
  };
  assert.equal(geometry.width, 390);
  assert.equal(geometry.body, 390);
  assert.equal(geometry.dpr, 3);
  if (geometry.footerVisible) {
    assert.equal(geometry.footerBottom, geometry.tabsTop, "The shared footer clears the persistent tabs.");
    assert(geometry.pagePadding >= geometry.footerHeight + 12, "The page reserves the shared footer's full height.");
    assert(
      geometry.buttons.every(button => button.width >= 44 && button.height >= 44 && button.bottom <= geometry.tabsTop)
    );
  }
}
