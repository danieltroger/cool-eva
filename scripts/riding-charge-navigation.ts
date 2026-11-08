import assert from "node:assert/strict";
import { evaluateOnPage, reloadPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { assertChargeLayout } from "./charge-page-layout.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import { gesture } from "./riding-navigation-browser.ts";

export async function checkChargeNavigation(page: HeadlessPage, file: string) {
  for (const hash of ["#charge/pack-cooling", "#charge/controls"]) {
    await openPreview(page, file, hash, `legacy-${hash.slice(1).replaceAll("/", "-")}`, "&charge-scene=warm");
    await waitOnPage(
      page,
      "location.hash==='#charge'&&!!document.querySelector('.charge-view')",
      "legacy Charge link canonicalizes to its one page"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.sub-tabs,.charge-pack-view,.charge-controls-view')"),
      null
    );
    await reloadPage(page);
    await waitOnPage(
      page,
      "typeof ridingPreview==='function'&&ridingPreview('lib/router.js').currentView()==='charge'&&location.hash==='#charge'",
      "reload retains Charge"
    );
    await evaluateOnPage(page, "ridingPreview('lib/router.js').showView('ride')");
    await waitOnPage(page, "location.hash==='#ride'", "Ride history entry");
    await evaluateOnPage(page, "history.back()");
    await waitOnPage(
      page,
      "location.hash==='#charge'&&!!document.querySelector('.charge-view')",
      "Back restores the complete Charge page"
    );
    await assertChargeLayout(page);
    await evaluateOnPage(page, "history.forward()");
    await waitOnPage(page, "location.hash==='#ride'", "Forward restores Ride");
  }
  for (const kind of ["high_beam", "btn_cruise_set"]) {
    await openPreview(page, file, "#charge", `charge-${kind}`, "&charge-scene=warm");
    await gesture(page, kind);
    await waitOnPage(page, "location.hash==='#faults'&&scrollY===0", "both handlebar gestures leave Charge for Faults");
  }
  await openPreview(page, file, "#ride", "charge-arrival");
  const tick = Number(await evaluateOnPage(page, "ridingPreview('lib/store.js').chartTick.rawVal"));
  await waitOnPage(page, `ridingPreview('lib/store.js').chartTick.rawVal>${tick}`, "consume initial charge state");
  await evaluateOnPage(
    page,
    "ridingPreview('lib/arming.js').arm('charge-stop');pushPatch({fast_dc_contactor:[1,'','charge'],charge_manager_state:[35,'','charge']})"
  );
  await waitOnPage(page, "location.hash==='#charge'&&scrollY===0", "real charge start opens Charge");
  assert.equal(await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal"), "");
  await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').connection.val='offline'");
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "location.hash"), "#charge", "Link loss cannot invent a charge-exit edge.");
  await evaluateOnPage(
    page,
    "pausePreviewMessages(false);pushPatch({fast_dc_contactor:[0,'','charge'],charge_manager_state:[0,'','charge'],bms_state_charge:[0,'','battery']})"
  );
  await waitOnPage(page, "location.hash==='#ride'", "real charge exit returns to Ride");
}
