import assert from "node:assert/strict";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { FRAME, openPreview } from "./riding-preview-page.ts";
import { checkServiceParameterBrowser } from "./service-parameter-browser.ts";
import { checkServiceActionBrowser } from "./service-action-browser.ts";

export async function checkServiceBrowser(page: HeadlessPage, file: string) {
  for (const theme of ["dark", "light"]) {
    await openServicePreview(page, file, theme);
    await assertServiceLayout(page);
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.service-page > details > summary')].map(node=>node.textContent)"
      ),
      ["Service actions", "Recent changes", "All signals"]
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelectorAll('.parameter-browser [data-select-parameter]').length"),
      277
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-browser').open"), false);
    assert.equal(await evaluateOnPage(page, "document.querySelector('.all-signals').open"), false);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.probe-input,.vcu-write,.all-landing,.all-history-row')"),
      null
    );
    await checkServiceParameterBrowser(page);
    await checkServiceActionBrowser(page);
    await assertServiceLayout(page);
  }
  await checkStampPlacement(page, file);
  console.log(
    "  ✓ Service browser: approved catalogue/editor, individual backup changes, arm/dwell, readbacks, failure states, actions, preserved Bike stamp, both themes"
  );
}

export async function openServicePreview(page: HeadlessPage, file: string, theme: string) {
  await gotoPage(
    page,
    `file://${file}?scene=parked&fixture=all-installed&panel=advanced-service&case=service-${theme}#more`
  );
  await waitOnPage(
    page,
    "document.documentElement.dataset.previewReady==='yes'&&document.querySelectorAll('.parameter-browser [data-select-parameter]').length===277",
    "Service catalogue"
  );
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await evaluateOnPage(page, FRAME);
  await waitOnPage(
    page,
    "!ridingPreview('lib/service-client.js').serviceBusy.rawVal&&ridingPreview('lib/service-client.js').serviceCanWrite(true)",
    "ready synthetic Service controls"
  );
}

export async function assertServiceLayout(page: HeadlessPage) {
  const result = await evaluateOnPage(
    page,
    `(()=>{
    const page=document.querySelector('.service-page');
    const tabs=document.querySelector('.tabs').getBoundingClientRect();
    const header=document.querySelector('.header').getBoundingClientRect();
    const visible=[...page.querySelectorAll('button,input:not([type=file]),summary')].filter(node=>node.checkVisibility());
    return {width:innerWidth,body:document.body.scrollWidth,padding:getComputedStyle(page).paddingLeft,
      switches:[...document.querySelectorAll('.header-switch a')].map(node=>node.textContent),
      tabs:document.querySelectorAll('.tabs a').length,bottom:tabs.bottom,top:header.top,
      small:visible.filter(node=>node.getBoundingClientRect().height<44||node.getBoundingClientRect().width<44).map(node=>node.textContent),
      clipped:visible.filter(node=>node.scrollWidth>node.clientWidth+1||getComputedStyle(node).textOverflow==='ellipsis').map(node=>node.textContent)};
  })()`
  );
  assert.deepEqual(result, {
    width: 390,
    body: 390,
    padding: "12px",
    switches: ["Settings", "Bike", "Service"],
    tabs: 5,
    bottom: await evaluateOnPage(page, "innerHeight"),
    top: 0,
    small: [],
    clipped: [],
  });
}

export async function assertAllContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "document.querySelectorAll('.all-signals [data-signal]').length===528",
    "complete registry in Service"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('.all-signals').open"), true);
  assert.equal(await evaluateOnPage(page, "document.querySelectorAll('.all-signals .service-group').length"), 19);
  assert.equal(await evaluateOnPage(page, "document.querySelector('.all-landing,.all-history-row')"), null);
  const keys = await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.all-signals [data-signal]')].map(node=>node.dataset.signal).sort()"
  );
  const catalogue = await evaluateOnPage(
    page,
    "ridingPreview('lib/service-client.js').serviceCatalogue.rawVal.signals.map(signal=>signal.key).sort()"
  );
  assert.deepEqual(keys, catalogue, "All registry identities, including never-seen readings, remain browsable.");
  await assertServiceLayout(page);
}

export async function checkAllSignals(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  await openPreview(page, file, "#all", `service-signals-${theme}`);
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await assertAllContent(page);
  await filterSignals(page, "pack_kw");
  await assertOnlyPowerSignal(page);
  await evaluateOnPage(
    page,
    "(()=>{const style=document.createElement('style');style.id='service-hidden-mutant';style.textContent='.service-page .signal-row[hidden]{display:grid}';document.head.append(style);})()"
  );
  try {
    await assert.rejects(assertOnlyPowerSignal(page), /actual layout/);
  } finally {
    await evaluateOnPage(page, "document.querySelector('#service-hidden-mutant').remove()");
  }
  await assertOnlyPowerSignal(page);
  assert.equal(await signalText(page, "pack_kw"), "-48.30 kW");
  await evaluateOnPage(
    page,
    "window.serviceSignalNode=document.querySelector('[data-signal=pack_kw]');pushPatch({pack_kw:[12.3,'kW','battery']})"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await signalText(page, "pack_kw"), "12.30 kW");
  assert.equal(
    await evaluateOnPage(page, "window.serviceSignalNode===document.querySelector('[data-signal=pack_kw]')"),
    true,
    "Readings update without rebuilding an open group."
  );
  await capture?.(`service-signals-${theme}`);
  await filterSignals(page, "nothing-matches-this");
  assert.equal(
    await evaluateOnPage(page, "[...document.querySelectorAll('.signal-row')].some(row=>row.checkVisibility())"),
    false
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.all-signals .service-group')].every(node=>node.hidden)"
    ),
    true
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('.all-signals > div > .service-sub').hidden"), false);
  await filterSignals(page, "");
  await evaluateOnPage(
    page,
    "document.querySelectorAll('.all-signals .service-group').forEach(node=>node.open=true);pushPatch({fan_target_pct:[68,'%','fan',Date.now()-60000],ambient_temp:[17,'°C','obd',Date.now()-60000]})"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await signalClass(page, "fan_target_pct", "stale"), false);
  assert.equal(await signalClass(page, "ambient_temp", "stale"), true);
  const neverSeen = await evaluateOnPage(
    page,
    "ridingPreview('lib/service-client.js').serviceCatalogue.rawVal.signals.find(signal=>!ridingPreview('lib/store.js').signalState(signal.key).rawVal&&!ridingPreview('lib/store.js').faultState(signal.key).rawVal)?.key"
  );
  assert.equal(typeof neverSeen, "string");
  assert.equal(await signalText(page, String(neverSeen)), "—");
  await evaluateOnPage(
    page,
    "pushPatch({motor_temp_c:[999,'°C','motor'],fan_target_pct:[150,'%','fan'],horn:[193,'','controls']})"
  );
  await evaluateOnPage(page, FRAME);
  for (const key of ["motor_temp_c", "fan_target_pct", "horn"]) {
    assert.equal(await signalText(page, key), "fault");
    assert.equal(await signalClass(page, key, "bad"), true);
    assert.equal(await signalClass(page, key, "stale"), false);
  }
  await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').connection.val='offline'");
  await evaluateOnPage(page, FRAME);
  assert.equal(await signalClass(page, "pack_kw", "stale"), true);
  await assertServiceLayout(page);
}

async function filterSignals(page: HeadlessPage, text: string) {
  await evaluateOnPage(
    page,
    `(()=>{const input=document.querySelector('[name=signal-search]');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await evaluateOnPage(page, FRAME);
}

function signalText(page: HeadlessPage, key: string) {
  return evaluateOnPage(
    page,
    `document.querySelector('.all-signals [data-signal=${JSON.stringify(key)}] .signal-reading').textContent`
  );
}

function signalClass(page: HeadlessPage, key: string, cssClass: string) {
  return evaluateOnPage(
    page,
    `document.querySelector('.all-signals [data-signal=${JSON.stringify(key)}] .signal-reading').classList.contains(${JSON.stringify(cssClass)})`
  );
}

async function checkStampPlacement(page: HeadlessPage, file: string) {
  await gotoPage(page, `file://${file}?scene=parked&fixture=all-installed&panel=bike-information#more`);
  await waitOnPage(
    page,
    "document.querySelector('.action-block button')&&!document.querySelector('.action-block button').disabled",
    "retained Bike stamp read"
  );
  await evaluateOnPage(page, "document.querySelector('.action-block button').click()");
  await waitOnPage(page, "ridingPreview('lib/arming.js').armDwellElapsed()", "stamp read dwell");
  await evaluateOnPage(page, "document.querySelector('.action-block button').click()");
  await waitOnPage(
    page,
    "document.querySelector('.action-block [role=status]')?.textContent==='fault'",
    "honest empty service stamp"
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "/Reads four|0x0000|A8 answered/.test(document.querySelector('.action-block').innerText)"
    ),
    false
  );
}

async function assertOnlyPowerSignal(page: HeadlessPage) {
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.signal-row')].filter(row=>row.checkVisibility()).map(row=>row.dataset.signal)"
    ),
    ["pack_kw"],
    "Signal search must hide nonmatching rows in the actual layout."
  );
}
