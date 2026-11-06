import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkSocEntryBrowser(page: HeadlessPage, file: string) {
  for (const theme of ["dark", "light"]) {
    await openPreview(page, file, "#charge/controls", `soc-entry-${theme}`, "&charge-scene=warm");
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    await readCompleted(page);
    assert.equal(await reads(page), 1, "Opening Controls reads even when an old saved limit is already held.");
    assert.equal(
      await evaluateOnPage(page, "document.getElementById('pv-toast')?.classList.contains('on')"),
      false,
      "The automatic read adds no preview-only success notice."
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('[data-charge-action=limit-read]')"), null);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.charge-soc-control .action-note').textContent.trim()"),
      "",
      "A successful opening read adds no success/verification prose."
    );
    await evaluateOnPage(
      page,
      `(() => {
      const status=ridingPreview('lib/charge-write.js');
      window.entryStatus=status.writeStatus.rawVal;
      status.applyWriteStatus({...window.entryStatus,status:{...window.entryStatus.status,enabled:false}});
      pushPatch({charge_soc_limit_pct:[90,'%','charge'],pack_kw:[11.5,'kW','battery']});
    })()`
    );
    await evaluateOnPage(page, FRAME);
    await evaluateOnPage(page, "ridingPreview('lib/charge-write.js').applyWriteStatus(window.entryStatus)");
    await evaluateOnPage(page, FRAME);
    await evaluateOnPage(page, "pushPatch({...LIVE});ridingPreview('lib/store.js').chartTick.val++");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await reads(page),
      1,
      "Its reply, heartbeat and permission false→true must never trigger another read."
    );
    await evaluateOnPage(page, "ridingPreview('views/charge-soc-limit.js').ChargeSocLimitControl()");
    await evaluateOnPage(page, FRAME);
    assert.equal(await reads(page), 1, "A design-sheet control mount is not a route entry.");
    const getCount = await statusGets(page);
    await evaluateOnPage(page, "ridingPreview('lib/destination.js').openDestination('settings','charging')");
    await waitOnPage(page, "!!document.querySelector('.settings-page')", "Charging settings");
    await evaluateOnPage(page, "history.back()");
    await readCompleted(page);
    assert.equal(await reads(page), 2, "Settings→back is one new entry/read.");
    assert.equal(await statusGets(page), getCount, "Re-entry reuses held permission without a GET.");

    await openPreview(page, file, "#charge/controls", `soc-pending-${theme}`, "&charge-scene=warm&soc-reply=pending");
    await waitOnPage(page, "!!window.releaseChargePreview", "Opening read held in flight");
    assert.equal(await reads(page), 1);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-saved-charge-limit]').textContent"),
      "Reading…"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelector('[data-charge-action=limit-set]').textContent.includes('Sending')"
      ),
      false
    );
    await evaluateOnPage(
      page,
      "SOC_LIMIT.pct=80;window.chargePreviewReplyMode='success';window.releaseChargePreview()"
    );
    await readCompleted(page);
    assert.equal(await evaluateOnPage(page, "document.querySelector('[data-saved-charge-limit]').textContent"), "80 %");
    await evaluateOnPage(page, FRAME);
    assert.equal(await reads(page), 1);

    await openPreview(page, file, "#charge", `soc-permission-${theme}`, "&charge-scene=warm&write-status=pending");
    await waitOnPage(page, "window.chargePreviewStatusWaiters.length>0", "Permission GET held");
    await evaluateOnPage(page, FRAME);
    const pendingGetCount = await statusGets(page);
    await evaluateOnPage(page, "ridingPreview('lib/router.js').showView('charge-controls')");
    await waitOnPage(page, "!!document.querySelector('.charge-controls-view')", "Controls joins a pre-existing GET");
    await evaluateOnPage(page, FRAME);
    assert.equal(await statusGets(page), pendingGetCount, "Entry joins the existing owner without another GET.");
    assert.equal(await reads(page), 0, "No POST before the actual permission response.");
    await evaluateOnPage(page, "window.releaseChargeStatus(true)");
    await readCompleted(page);
    assert.equal(await reads(page), 1);

    for (const mode of ["denied", "failed"]) {
      await openPreview(
        page,
        file,
        "#charge/controls",
        `soc-${mode}-${theme}`,
        mode === "denied" ? "&charge-scene=readonly" : "&charge-scene=warm&write-status=failed"
      );
      await evaluateOnPage(page, FRAME);
      await evaluateOnPage(page, FRAME);
      assert.equal(await reads(page), 0, `${mode} permission sends no read.`);
    }
    await openPreview(page, file, "#charge/controls", `soc-leave-${theme}`, "&charge-scene=warm&write-status=pending");
    await waitOnPage(page, "window.chargePreviewStatusWaiters.length>0", "Permission before leaving");
    await evaluateOnPage(page, "ridingPreview('lib/router.js').showView('charge')");
    await evaluateOnPage(page, FRAME);
    await evaluateOnPage(page, "window.releaseChargeStatus(true)");
    await evaluateOnPage(page, FRAME);
    assert.equal(await reads(page), 0, "Leaving Controls cancels the delayed opening read.");
  }
  console.log(
    "  ✓ SOC reads once per route entry after real permission, with no reply/heartbeat/permission loop or Read button"
  );
}

async function readCompleted(page: HeadlessPage) {
  await waitOnPage(
    page,
    "!!document.querySelector('.charge-controls-view')&&document.querySelector('[data-saved-charge-limit]')?.textContent!=='Reading…'&&!!document.querySelector('input[name=charge-soc-limit-pct]')&&!document.querySelector('input[name=charge-soc-limit-pct]').disabled",
    "Opening SOC read completes"
  );
  await evaluateOnPage(page, FRAME);
}

async function reads(page: HeadlessPage) {
  return await evaluateOnPage(
    page,
    "window.chargePreviewRequests.filter(entry=>entry.method==='POST'&&entry.action==='charge-soc-limit-read').length"
  );
}

async function statusGets(page: HeadlessPage) {
  return await evaluateOnPage(
    page,
    "window.chargePreviewRequests.filter(entry=>entry.method==='GET'&&entry.action==='status').length"
  );
}
