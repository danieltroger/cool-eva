import assert from "node:assert/strict";
import { evaluateOnPage, reloadPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { assertRendered } from "./riding-layout-browser.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import { gesture } from "./riding-navigation-browser.ts";

export async function checkChargeNavigation(page: HeadlessPage, file: string) {
  for (const [name, hash] of [
    ["charge-pack", "#charge/pack-cooling"],
    ["charge-controls", "#charge/controls"],
  ]) {
    await openPreview(page, file, "#charge", `history-${name}`, "&charge-scene=warm");
    await evaluateOnPage(page, `document.querySelector('[data-view="${name}"]').click()`);
    await waitOnPage(
      page,
      `location.hash===${JSON.stringify(hash)}&&!!document.querySelector('.${name === "charge-pack" ? "charge-pack" : "charge-controls"}-view')`,
      name
    );
    await evaluateOnPage(page, "history.back()");
    await waitOnPage(page, "!!document.querySelector('.charge-view')", "Back to Charge");
    await evaluateOnPage(page, "history.forward()");
    await waitOnPage(page, `location.hash===${JSON.stringify(hash)}`, "Forward to the selected detail");
    await reloadPage(page);
    await waitOnPage(
      page,
      `typeof ridingPreview==='function'&&ridingPreview('lib/router.js').currentView()===${JSON.stringify(name)}`,
      "direct reload retains the selected Charge detail"
    );
    await evaluateOnPage(
      page,
      "ridingPreview('lib/arming.js').arm('charge-stop');[...document.querySelectorAll('.tabs button')].find(button=>button.textContent==='Charge').click()"
    );
    await waitOnPage(
      page,
      "!!document.querySelector('.charge-view')&&scrollY===0",
      "parent tap restores Charge overview"
    );
    assert.equal(await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal"), "");
    for (const kind of ["high_beam", "btn_cruise_set"]) {
      await openPreview(page, file, hash, `${name}-${kind}`, "&charge-scene=warm");
      await gesture(page, kind);
      await waitOnPage(page, "location.hash==='#all'&&scrollY===0", "both gestures take Charge detail to All");
    }
    await openPreview(page, file, hash, `${name}-arrival`);
    const tick = Number(await evaluateOnPage(page, "ridingPreview('lib/store.js').chartTick.rawVal"));
    await waitOnPage(
      page,
      `ridingPreview('lib/store.js').chartTick.rawVal>${tick}`,
      "named detail consumes its first pass"
    );
    assert.equal(await evaluateOnPage(page, "ridingPreview('lib/router.js').currentView()"), name);
    await evaluateOnPage(
      page,
      "ridingPreview('lib/arming.js').arm('charge-stop');pushPatch({fast_dc_contactor:[1,'','charge'],charge_manager_state:[35,'','charge']})"
    );
    await waitOnPage(
      page,
      "location.hash==='#charge'&&!!document.querySelector('.charge-view')&&scrollY===0",
      "real charge-start restores an already-selected Charge parent"
    );
    assert.equal(await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal"), "");
    await evaluateOnPage(page, `ridingPreview('lib/router.js').showView(${JSON.stringify(name)})`);
    await evaluateOnPage(page, FRAME);
    await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').connection.val='offline'");
    const drop = Number(await evaluateOnPage(page, "ridingPreview('lib/store.js').chartTick.rawVal"));
    await waitOnPage(page, `ridingPreview('lib/store.js').chartTick.rawVal>${drop}`, "link dropout tick");
    assert.equal(await evaluateOnPage(page, "location.hash"), hash, "Link loss cannot invent a charge-exit edge.");
    await evaluateOnPage(
      page,
      "pausePreviewMessages(false);pushPatch({fast_dc_contactor:[0,'','charge'],charge_manager_state:[0,'','charge'],bms_state_charge:[0,'','battery']})"
    );
    await waitOnPage(page, "location.hash==='#ride'", "real charge exit from either Charge detail returns to Ride");
  }
  await openPreview(page, file, "#charge/pack-cooling", "pack-content", "&charge-scene=warm");
  await waitOnPage(
    page,
    "document.querySelector('[data-module-count]')?.textContent.startsWith('31 of 31')",
    "all fitted module probes in the shared widget"
  );
  await evaluateOnPage(
    page,
    "window.moduleRows=[...document.querySelectorAll('[data-module-signal]')];ridingPreview('lib/store.js').chartTick.val++"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(
      page,
      "window.moduleRows.every((element,index)=>element===document.querySelectorAll('[data-module-signal]')[index])"
    ),
    true,
    "Module cells must keep their DOM nodes across sampled pulses."
  );
  await assertRendered(page, [
    ".charge-thermal .value",
    ".module-temperatures",
    "[data-module-signal]",
    ".charge-voltage-grid",
    ".charge-isolation .value",
    ".charge-power-history .value",
  ]);
  const text = String(await evaluateOnPage(page, "document.querySelector('.charge-pack-view').innerText"));
  for (const required of [
    "Resistance heat / loop removal",
    "Physical battery",
    "Bike-reported battery",
    "Coolant",
    "Cell spread",
    "Module temperatures",
    "Cell voltages by module",
    "Isolation",
    "Raw BMS units",
    "last 10 min",
    "AC-only readings are inactive",
  ]) {
    assert.ok(text.toLowerCase().includes(required.toLowerCase()), required);
  }
  await openPreview(page, file, "#charge/pack-cooling", "pack-ac", "&charge-scene=ac");
  await waitOnPage(page, "!!document.querySelector('.charge-ac-details')", "AC source selects live AC-only details");
  for (const required of ["Mains voltage", "Mains current", "BMS grants", "AC setpoint", "Charger enabled"]) {
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('.charge-ac-details').innerText"))
        .toLowerCase()
        .includes(required.toLowerCase()),
      required
    );
  }
}
