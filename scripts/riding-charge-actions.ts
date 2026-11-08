import assert from "node:assert/strict";
import { ARM_DWELL_MS } from "../public/lib/arming.js";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { assertChargeLayout } from "./charge-page-layout.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkChargeActions(page: HeadlessPage, file: string) {
  for (const theme of ["dark", "light"]) {
    await openPreview(page, file, "#charge", `actions-${theme}`, "&charge-scene=warm");
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    await ready(page);
    assert.equal(await evaluateOnPage(page, "document.querySelector('input[name=charge-current-amps]').value"), "32");
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
    assert.equal(await posts(page), 0, "An unchanged current cannot arm or send.");
    assert.equal(await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal"), "");
    await typeInput(page, "charge-current-amps", "40");
    await evaluateOnPage(
      page,
      "window.currentInput=document.querySelector('input[name=charge-current-amps]');window.socInput=document.querySelector('input[name=charge-soc-limit-pct]');pushPatch({fast_dc_target_a:[33,'A','charge'],charge_soc_limit_pct:[90,'%','charge']})"
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(
        page,
        "window.currentInput===document.querySelector('input[name=charge-current-amps]')&&window.socInput===document.querySelector('input[name=charge-soc-limit-pct]')&&window.currentInput.value==='40'"
      ),
      true,
      "Live traffic preserves the input nodes and the owner's draft."
    );
    assert.equal(await status(page), "Not sent");
    await click(page, "current");
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-current'", "current arm");
    await click(page, "current");
    assert.equal(await posts(page), 0, "A second tap inside the dwell must not send.");
    await typeInput(page, "charge-current-amps", "41");
    assert.equal(
      await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal"),
      "",
      "Editing a draft disarms the previous value."
    );
    await click(page, "current");
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-current'", "new current scope");
    await dwell(page);
    assert.equal(
      await evaluateOnPage(
        page,
        "(()=>{const event=new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true});document.querySelector('[data-charge-action=current]').dispatchEvent(event);return event.defaultPrevented})()"
      ),
      true,
      "Held Enter is refused."
    );
    await assertChargeLayout(page);
    await click(page, "current");
    await waitOnPage(
      page,
      "document.querySelector('[data-current-status]').textContent==='Waiting for bike…'&&chargePreviewRequests.some(entry=>entry.action==='charge-current')",
      "sent awaits matching bike evidence"
    );
    assert.equal(await posts(page), 1);
    assert.equal(
      await evaluateOnPage(
        page,
        "chargePreviewRequests.find(entry=>entry.action==='charge-current').query.includes('confirm=charge-current-41')&&chargePreviewRequests.find(entry=>entry.action==='charge-current').header==='service-write'"
      ),
      true
    );
    await evaluateOnPage(
      page,
      "WRITE_STATUS.chargeAck={verdict:{kind:'took',fromAmps:50,toAmps:32,latencyMs:150},message:'Synthetic earlier 32 A reply.'};pushPatch({charge_cmd_ack_seq:[2,'','charge']})"
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(await status(page), "Waiting for bike…", "An older reply cannot confirm the new target.");
    await evaluateOnPage(
      page,
      "WRITE_STATUS.chargeAck={verdict:{kind:'took',fromAmps:50,toAmps:41,latencyMs:150},message:'Synthetic 41 A reply.'};pushPatch({fast_dc_target_a:[41,'A','charge'],charge_cmd_ack_seq:[3,'','charge']})"
    );
    await waitOnPage(
      page,
      "document.querySelector('[data-current-status]').textContent==='Bike confirmed 41 A'",
      "matching bike acknowledgement"
    );
    await typeInput(page, "charge-current-amps", "42");
    await evaluateOnPage(page, "chargePreviewReplyMode='refused'");
    await confirm(page, "current", "charge-current");
    await waitOnPage(
      page,
      "document.querySelector('[data-current-status]').textContent==='42 A · Not sent'",
      "refusal names the unsent target"
    );
    assert.equal(
      await evaluateOnPage(page, "ridingPreview('lib/store.js').valueOf('charge_cmd_a')"),
      41,
      "A refused target cannot become the last command."
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('input[name=charge-current-amps]').value"), "42");
    await evaluateOnPage(page, "chargePreviewReplyMode='success';pushPatch({fast_dc_limit_max_a:[0,'A','charge']})");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').disabled"),
      true,
      "A falling ceiling disables the current draft."
    );

    await openPreview(page, file, "#charge", `limit-${theme}`, "&charge-scene=warm");
    await ready(page);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-charge-action=limit-set]').disabled"),
      true,
      "An unchanged saved limit cannot be sent."
    );
    await typeInput(page, "charge-soc-limit-pct", "85");
    await click(page, "limit-set");
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-soc-limit'", "saved limit arm");
    await click(page, "limit-set");
    assert.equal(await posts(page, "charge-soc-limit"), 0, "A saved limit also retains its dwell.");
    await dwell(page);
    await click(page, "limit-set");
    await waitOnPage(
      page,
      "document.querySelector('[data-limit-status]').textContent==='Bike confirmed 85 %'",
      "one write and matching readback"
    );
    await evaluateOnPage(page, "pushPatch({charge_soc_limit_pct:[90,'%','charge']})");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-limit-status]').textContent.includes('confirmed 90')"),
      false,
      "A later different report cannot inherit the attempted percentage confirmation."
    );
    assert.equal(await posts(page, "charge-soc-limit"), 1);
    assert.equal(await posts(page, "charge-soc-limit-read"), 1, "Only the opening read is automatic.");
    assert.equal(await evaluateOnPage(page, "document.querySelector('[data-charge-action=limit-read]')"), null);
    await typeInput(page, "charge-soc-limit-pct", "0");
    await click(page, "limit-set");
    await waitOnPage(
      page,
      "document.querySelector('[data-charge-action=limit-set]').textContent==='Confirm remove limit'",
      "zero retains explicit remove-limit wording"
    );
    await typeInput(page, "charge-soc-limit-pct", "85");
    await click(page, "automatic");
    await waitOnPage(
      page,
      "chargePreviewRequests.filter(entry=>entry.action==='automatic'&&entry.method==='POST').length===1",
      "automatic reduction keeps its one-tap permission"
    );
    await assertChargeLayout(page);

    await openPreview(page, file, "#charge", `stop-${theme}`, "&charge-scene=warm");
    await ready(page);
    await click(page, "stop");
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-stop'", "Stop arm");
    await click(page, "stop");
    assert.equal(await posts(page, "charge-stop"), 0, "Stop retains its dwell.");
    await dwell(page);
    await click(page, "stop");
    await waitOnPage(
      page,
      "document.querySelector('[data-stop-result]').textContent==='Waiting for bike…'&&chargePreviewRequests.some(entry=>entry.action==='charge-stop')",
      "sending Stop does not claim the charge ended"
    );
    assert.equal(await posts(page, "charge-stop"), 1);
    await assertChargeLayout(page);

    await openPreview(page, file, "#charge", `timeout-${theme}`, "&charge-scene=warm");
    await ready(page);
    await typeInput(page, "charge-current-amps", "40");
    await evaluateOnPage(page, "chargePreviewReplyMode='timeout'");
    await confirm(page, "current", "charge-current");
    await waitOnPage(
      page,
      "document.querySelector('[data-current-status]').textContent==='40 A · Delivery uncertain'",
      "lost response never invents acknowledgement"
    );
    await assertChargeLayout(page);

    await openPreview(page, file, "#charge", `readonly-${theme}`, "&charge-scene=readonly");
    await waitOnPage(
      page,
      "document.querySelector('input[name=charge-soc-limit-pct]')?.value==='90'",
      "held saved limit remains readable"
    );
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('.charge-view [data-charge-action]')].filter(element=>element.getBoundingClientRect().height>0&&element.getBoundingClientRect().width>0).map(element=>element.dataset.chargeAction)"
      ),
      [],
      "A read-only phone offers no writes."
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('input[name=charge-soc-limit-pct]').disabled"),
      true
    );
    assert.equal(await posts(page, "charge-soc-limit-read"), 0);
    await assertChargeLayout(page);
  }
  console.log(
    "  ✓ Charge keeps live drafts, matching confirmation, readonly visibility, one-write gates and uncertainty states"
  );
}
async function ready(page: HeadlessPage) {
  await waitOnPage(
    page,
    "!!document.querySelector('input[name=charge-current-amps]')&&!document.querySelector('input[name=charge-current-amps]').disabled&&!document.querySelector('input[name=charge-soc-limit-pct]').disabled",
    "live controls after the opening read"
  );
}
async function typeInput(page: HeadlessPage, name: string, value: string) {
  await evaluateOnPage(
    page,
    `(()=>{const input=document.querySelector('input[name=${name}]');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`
  );
  await evaluateOnPage(page, FRAME);
}
async function click(page: HeadlessPage, action: string) {
  await evaluateOnPage(page, `document.querySelector('[data-charge-action=${action}]').click()`);
}
async function confirm(page: HeadlessPage, action: string, scope: string) {
  await click(page, action);
  await waitOnPage(page, `ridingPreview('lib/arming.js').armed.rawVal===${JSON.stringify(scope)}`, scope);
  await dwell(page);
  await click(page, action);
}
async function dwell(page: HeadlessPage) {
  await evaluateOnPage(page, `new Promise(resolve=>setTimeout(resolve,${ARM_DWELL_MS + 80}))`);
}
async function status(page: HeadlessPage) {
  return await evaluateOnPage(page, "document.querySelector('[data-current-status]').textContent");
}
async function posts(page: HeadlessPage, action = "charge-current") {
  return await evaluateOnPage(
    page,
    `chargePreviewRequests.filter(entry=>entry.method==='POST'&&entry.action===${JSON.stringify(action)}).length`
  );
}
