import assert from "node:assert/strict";
import { evaluateOnPage, reloadPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkHistoryAndGestures(page: HeadlessPage, file: string) {
  await openPreview(page, file, "#ride", "history");
  await evaluateOnPage(page, "document.querySelector('[data-view=cooling]').click()");
  await waitOnPage(
    page,
    "location.hash === '#ride/cooling' && !!document.querySelector('.cooling-view')",
    "Cooling sub-tab"
  );
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(page, "location.hash === '#ride' && !document.querySelector('.cooling-view')", "Back to Ride");
  await evaluateOnPage(page, "history.forward()");
  await waitOnPage(page, "!!document.querySelector('.cooling-view')", "Forward to Cooling");
  // Direct navigation really reloads the document; the preview's location.reload() only shows a toast.
  await evaluateOnPage(page, "window.ridingReloadMarker = true");
  await reloadPage(page);
  await waitOnPage(
    page,
    "!window.ridingReloadMarker && !!document.querySelector('.cooling-view')",
    "the actually reloaded Cooling deep link"
  );
  await evaluateOnPage(
    page,
    "ridingPreview('lib/arming.js').arm('charge-stop'); document.querySelector('.tabs .tab').click()"
  );
  await waitOnPage(page, "location.hash === '#ride'", "current parent tap restoring Ride");
  assert.equal(await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.val"), "");
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(page, "!!document.querySelector('.cooling-view')", "Back after current-parent navigation");
  await evaluateOnPage(page, "document.querySelector('.tabs a[href$=\"#more\"]').click()");
  await waitOnPage(page, "location.hash === '#more'", "Settings from Cooling");
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(page, "!!document.querySelector('.cooling-view')", "return to the actual subview origin");
  for (const kind of ["high_beam", "btn_cruise_set"]) {
    await openPreview(page, file, "#ride", `gesture-${kind}`);
    await gesture(page, kind);
    await waitOnPage(page, "!!document.querySelector('.cooling-view')", "gesture Ride to Cooling");
    await gesture(page, kind);
    await waitOnPage(page, "location.hash === '#hypermile'", "gesture Cooling to Range");
    assert.equal(await evaluateOnPage(page, "scrollY"), 0, "Range is a fixed riding landing.");
    await evaluateOnPage(page, "document.querySelector('[data-view=cells]').click()");
    await waitOnPage(page, "!!document.querySelector('.cells-view')", "scrolling Cells subview");
    await evaluateOnPage(page, "window.scrollTo(0,200)");
    assert.ok(
      Number(await evaluateOnPage(page, "scrollY")) > 0,
      "Cells must actually scroll before the arrival-reset probe."
    );
    await gesture(page, kind);
    await waitOnPage(page, "location.hash === '#charge'", "gesture Cells to Charge");
    assert.equal(
      await evaluateOnPage(page, "scrollY"),
      0,
      "Handlebar arrivals must reset scrolling even between long views."
    );
    await evaluateOnPage(page, "ridingPreview('lib/router.js').showView('fault-report')");
    await evaluateOnPage(page, FRAME);
    await evaluateOnPage(page, "window.scrollTo(0,200)");
    assert.ok(
      Number(await evaluateOnPage(page, "scrollY")) > 0,
      "The scroll-reset case must start from an actually scrolled view."
    );
    await gesture(page, kind);
    await waitOnPage(page, "location.hash === '#ride'", "gesture Fault report to Ride");
    assert.equal(await evaluateOnPage(page, "scrollY"), 0, "Handlebar arrivals must reset scrolling.");
    for (const panel of ["settings", "session", "bike-information", "battery-cooling", "advanced-service"]) {
      const origin = await evaluateOnPage(page, "[ridingPreview('lib/router.js').currentView(), location.hash]");
      await evaluateOnPage(page, `ridingPreview('lib/destination.js').openDestination(${JSON.stringify(panel)})`);
      await evaluateOnPage(page, FRAME);
      await gesture(page, kind);
      assert.equal(await evaluateOnPage(page, "ridingPreview('lib/destination.js').destination.val"), panel);
      assert.deepEqual(
        await evaluateOnPage(page, "[ridingPreview('lib/router.js').currentView(), location.hash]"),
        ["more", "#more"],
        `${kind} must preserve the view and hash beneath ${panel}.`
      );
      await evaluateOnPage(page, "ridingPreview('lib/destination.js').closeDestination()");
      await waitOnPage(
        page,
        "!ridingPreview('lib/destination.js').destination.val",
        "return from the excluded menu page"
      );
      assert.deepEqual(
        await evaluateOnPage(page, "[ridingPreview('lib/router.js').currentView(), location.hash]"),
        origin,
        `Closing ${panel} after ${kind} must return to the original view and hash.`
      );
    }
  }
  await openPreview(page, file, "#hypermile", "legacy-link");
  assert.equal(await evaluateOnPage(page, "ridingPreview('lib/router.js').currentView()"), "hypermile");
  await checkAutomaticMoves(page, file);
  await checkMoreExclusions(page, file);
}

async function checkMoreExclusions(page: HeadlessPage, file: string) {
  for (const view of ["more", "all"]) {
    await openPreview(page, file, `#${view}`, `parked-${view}`);
    await nextTick(page);
    for (const kind of ["high_beam", "btn_cruise_set"]) {
      await gesture(page, kind);
      assert.equal(
        await evaluateOnPage(page, "ridingPreview('lib/router.js').currentView()"),
        view,
        "Handlebar gestures cannot interrupt More."
      );
    }
    await evaluateOnPage(page, "pushPatch({fast_dc_contactor:[1,'','charge'],charge_manager_state:[35,'','charge']})");
    await nextTick(page);
    assert.equal(
      await evaluateOnPage(page, "ridingPreview('lib/router.js').currentView()"),
      view,
      "Charge-start focus cannot interrupt More."
    );
    await evaluateOnPage(page, "document.querySelector('.tabs a[href$=\"#hypermile\"]').click()");
    await nextTick(page);
    assert.equal(
      await evaluateOnPage(page, "location.hash"),
      "#hypermile",
      "More consumes automatic edges without replaying them on exit."
    );
  }
}

export async function gesture(page: HeadlessPage, key: string) {
  await evaluateOnPage(page, `pushPatch({${JSON.stringify(key)}:[0,'','buttons']})`);
  await evaluateOnPage(page, FRAME);
  for (let press = 0; press < (key === "high_beam" ? 3 : 2); press += 1) {
    await evaluateOnPage(page, `pushPatch({${JSON.stringify(key)}:[1,'','buttons']})`);
    await evaluateOnPage(page, FRAME);
    await evaluateOnPage(page, `pushPatch({${JSON.stringify(key)}:[0,'','buttons']})`);
    await evaluateOnPage(page, FRAME);
  }
}

async function nextTick(page: HeadlessPage) {
  const tick = await evaluateOnPage(page, "ridingPreview('lib/store.js').chartTick.val");
  await waitOnPage(
    page,
    `ridingPreview('lib/store.js').chartTick.val > ${Number(tick)}`,
    "the real automatic-view tick"
  );
}

async function checkAutomaticMoves(page: HeadlessPage, file: string) {
  await openPreview(page, file, "#ride/cooling", "automatic");
  await nextTick(page);
  assert.equal(
    await evaluateOnPage(page, "ridingPreview('lib/router.js').currentView()"),
    "cooling",
    "A subview deep link gets its first pass."
  );
  await evaluateOnPage(page, "pushPatch({fast_dc_contactor:[1,'','charge'],charge_manager_state:[35,'','charge']})");
  await waitOnPage(page, "location.hash === '#charge'", "a genuine charge start");
  await evaluateOnPage(page, "pausePreviewMessages(true); ridingPreview('lib/store.js').connection.val='offline'");
  await nextTick(page);
  assert.equal(await evaluateOnPage(page, "location.hash"), "#charge", "A link dropout cannot produce charge exit.");
  await evaluateOnPage(
    page,
    "pausePreviewMessages(false); pushPatch({fast_dc_contactor:[0,'','charge'],charge_manager_state:[0,'','charge']})"
  );
  await waitOnPage(page, "location.hash === '#ride'", "genuine charge exit returning to Ride");
  await evaluateOnPage(page, "pushPatch({cell_min_mv:[3300,'mV','cells']})");
  await nextTick(page);
  await evaluateOnPage(page, "pushPatch({cell_min_mv:[3120,'mV','cells']})");
  await waitOnPage(page, "location.hash === '#hypermile'", "the near-empty override");
  await evaluateOnPage(page, "ridingPreview('lib/destination.js').openDestination('settings')");
  await evaluateOnPage(page, "pushPatch({fast_dc_contactor:[1,'','charge'],charge_manager_state:[35,'','charge']})");
  await nextTick(page);
  assert.equal(await evaluateOnPage(page, "ridingPreview('lib/destination.js').destination.val"), "settings");
  await evaluateOnPage(page, "ridingPreview('lib/destination.js').closeDestination()");
  await waitOnPage(
    page,
    "!ridingPreview('lib/destination.js').destination.val",
    "return without a queued automatic jump"
  );
  await nextTick(page);
  assert.equal(await evaluateOnPage(page, "location.hash"), "#hypermile");
}
