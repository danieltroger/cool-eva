import assert from "node:assert/strict";
import { ARM_DWELL_MS } from "../public/lib/arming.js";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { assertFixedLayout, assertRendered } from "./riding-layout-browser.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkChargeActions(page: HeadlessPage, file: string) {
  for (const theme of ["dark", "light"]) {
    await openPreview(page, file, "#charge/controls", `controls-${theme}`, "&charge-scene=warm");
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    await waitOnPage(
      page,
      "!!document.querySelector('[data-charge-action=current]')&&!document.querySelector('input[name=charge-current-amps]').disabled",
      "live current form"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-last-charge-request]').textContent"),
      "32 A"
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('[data-charge-reply]').textContent"), "32 A");
    await typeInput(page, "charge-current-amps", "40");
    await evaluateOnPage(
      page,
      "window.currentInput=document.querySelector('input[name=charge-current-amps]');window.socInput=document.querySelector('input[name=charge-soc-limit-pct]');pushPatch({pack_kw:[11.5,'kW','battery'],charge_soc_limit_pct:[90,'%','charge']})"
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(
        page,
        "window.currentInput===document.querySelector('input[name=charge-current-amps]')&&window.socInput===document.querySelector('input[name=charge-soc-limit-pct]')"
      ),
      true,
      "Live patches must not replace the draft input nodes."
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-last-charge-request]').textContent"),
      "32 A"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-charge-reply]').textContent"),
      "32 A",
      "Draft edits cannot manufacture a bike reply."
    );
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-current'", "current arm");
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
    assert.equal(await posts(page), 0, "A second tap inside the dwell must not send.");
    await typeInput(page, "charge-current-amps", "41");
    assert.equal(
      await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal"),
      "",
      "Changing a draft disarms the old scope."
    );
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-current'", "new scope arm");
    await dwell(page);
    assert.equal(
      await evaluateOnPage(
        page,
        "(()=>{const event=new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true});document.querySelector('[data-charge-action=current]').dispatchEvent(event);return event.defaultPrevented;})()"
      ),
      true,
      "Held Enter must be refused."
    );
    await assertRendered(page, [
      "[data-last-charge-request]",
      "[data-charge-reply]",
      "[data-saved-charge-limit]",
      "input[name=charge-current-amps]",
      "input[name=charge-soc-limit-pct]",
      "[data-charge-action=current]",
      "[data-charge-action=limit-set]",
      "[data-charge-action=automatic]",
    ]);
    await assertControlsFit(page);
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
    await waitOnPage(
      page,
      "document.querySelector('[data-charge-reply]').textContent==='Waiting'",
      "sent is distinct from the bike replying"
    );
    assert.equal(await posts(page), 1);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-last-charge-request]').textContent"),
      "41 A"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "window.chargePreviewRequests.find(entry=>entry.action==='charge-current').query.includes('confirm=charge-current-41')"
      ),
      true
    );
    assert.equal(
      await evaluateOnPage(page, "window.chargePreviewRequests.find(entry=>entry.action==='charge-current').header"),
      "service-write"
    );
    await evaluateOnPage(
      page,
      "WRITE_STATUS.chargeAck={verdict:{kind:'took',fromAmps:50,toAmps:41,latencyMs:150},message:'Synthetic bike request settled at 41 A.'};pushPatch({charge_cmd_ack_seq:[2,'','charge']})"
    );
    await waitOnPage(
      page,
      "document.querySelector('[data-charge-reply]').textContent==='41 A'",
      "real acknowledgement update"
    );
    await typeInput(page, "charge-current-amps", "42");
    await evaluateOnPage(
      page,
      "window.chargePreviewReplyMode='refused';document.querySelector('[data-charge-action=current]').click()"
    );
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-current'", "refusal arm");
    await dwell(page);
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
    await waitOnPage(
      page,
      "document.querySelector('.charge-current-control').innerText.includes('Synthetic refusal:')",
      "the complete operation-specific refusal"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-last-charge-request]').textContent"),
      "41 A",
      "A refused request cannot become the last sent request."
    );
    await evaluateOnPage(
      page,
      "window.chargePreviewReplyMode='success';pushPatch({fast_dc_limit_max_a:[0,'A','charge']})"
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').disabled"),
      true,
      "The current cannot exceed the live source ceiling."
    );
    await openPreview(page, file, "#charge/controls", `controls-read-${theme}`, "&charge-scene=warm");
    await typeInput(page, "charge-soc-limit-pct", "90");
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=limit-set]').click()");
    await evaluateOnPage(page, FRAME);
    assert.equal(await posts(page, "charge-soc-limit"), 0, "The first Set tap only confirms intent.");
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-soc-limit'", "SOC limit arm");
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=limit-set]').click()");
    assert.equal(await posts(page, "charge-soc-limit"), 0, "An immediate second Set tap retains the dwell.");
    await dwell(page);
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=limit-set]').click()");
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal===''", "SOC limit result");
    assert.equal(await posts(page, "charge-soc-limit"), 1, "Set remains a single confirmed write.");
    assert.equal(await posts(page, "charge-soc-limit-read"), 1, "The opening read needs no button or arming.");
    assert.equal(await evaluateOnPage(page, "document.querySelector('[data-charge-action=limit-read]')"), null);
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=automatic]').click()");
    await waitOnPage(
      page,
      "window.chargePreviewRequests.filter(entry=>entry.action==='automatic'&&entry.method==='POST').length===1",
      "automatic permission retains one-tap semantics"
    );
    await openPreview(page, file, "#charge", `stop-${theme}`, "&charge-scene=warm");
    await waitOnPage(
      page,
      "document.querySelector('[data-ceiling]')?.dataset.ceiling==='36'",
      "populated Stop overview"
    );
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=stop]').click()");
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-stop'", "Stop arm");
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=stop]').click()");
    assert.equal(await posts(page, "charge-stop"), 0, "Stop retains its dwell.");
    await dwell(page);
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=stop]').click()");
    await waitOnPage(
      page,
      "document.querySelector('.stop-result-summary').textContent.includes('Sent')",
      "Stop sent summary"
    );
    assert.equal(await posts(page, "charge-stop"), 1);
    await assertFixedLayout(page);
    await evaluateOnPage(page, "document.querySelector('.charge-controller-summary').click()");
    await waitOnPage(page, "!!document.querySelector('.stop-operation-result')", "complete Stop result on Controls");
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('.stop-operation-result').innerText")).includes(
        "follow the bike’s unplug prompt"
      )
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelectorAll('[data-charge-action=stop]').length"),
      0,
      "Stop exists once, on the overview."
    );
    await openPreview(page, file, "#charge/controls", `timeout-${theme}`, "&charge-scene=warm");
    await typeInput(page, "charge-current-amps", "40");
    await evaluateOnPage(
      page,
      "window.chargePreviewReplyMode='timeout';document.querySelector('[data-charge-action=current]').click()"
    );
    await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-current'", "timeout operation arm");
    await dwell(page);
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
    await waitOnPage(
      page,
      "document.querySelector('.charge-current-control').innerText.includes('This does NOT guarantee nothing was sent')",
      "uncertain delivery stays explicit"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-charge-reply]').textContent"),
      "32 A",
      "A failed transport cannot invent a new reply."
    );
    assert.equal(await evaluateOnPage(page, "document.body.scrollWidth"), 390);
    await openPreview(page, file, "#charge/controls", `controls-readonly-${theme}`, "&charge-scene=readonly");
    await waitOnPage(
      page,
      "document.querySelector('[data-saved-charge-limit]')?.textContent==='90 %'",
      "read-only retained limit"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelectorAll('[data-charge-action]').length"),
      0,
      "A read-only phone cannot expose command controls."
    );
  }
}
async function typeInput(page: HeadlessPage, name: string, value: string) {
  await waitOnPage(page, `!!document.querySelector('input[name="${name}"]')`, name);
  await evaluateOnPage(
    page,
    `(()=>{const input=document.querySelector('input[name="${name}"]');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await evaluateOnPage(page, FRAME);
}
async function dwell(page: HeadlessPage) {
  await evaluateOnPage(page, `new Promise(resolve=>setTimeout(resolve,${ARM_DWELL_MS + 50}))`);
}
async function posts(page: HeadlessPage, action = "charge-current") {
  return await evaluateOnPage(
    page,
    `window.chargePreviewRequests.filter(entry=>entry.method==='POST'&&entry.action===${JSON.stringify(action)}).length`
  );
}
async function assertControlsFit(page: HeadlessPage) {
  assert.equal(await evaluateOnPage(page, "document.scrollingElement.scrollHeight-innerHeight"), 0);
  assert.equal(await evaluateOnPage(page, "document.body.scrollWidth"), 390);
  assert.equal(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.charge-controls-view button')].filter(button=>button.getBoundingClientRect().height>0).every(button=>button.getBoundingClientRect().height>=44&&button.getBoundingClientRect().width>=44)"
    ),
    true
  );
}
