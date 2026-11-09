import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { FRAME } from "./riding-preview-page.ts";
import { confirmServiceButton } from "./service-parameter-browser.ts";

export async function checkServiceActionBrowser(page: HeadlessPage) {
  await evaluateOnPage(page, "document.querySelector('.service-actions').open=true");
  await evaluateOnPage(page, FRAME);
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('[data-service-action]')].map(button=>button.dataset.serviceAction)"
    ),
    ["reset-vcu", "sync-clock", "set-service-point", "clear-dtcs"]
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.service-write,.service-danger')].every(button=>{const event=new KeyboardEvent('keydown',{key:'Enter',repeat:true,cancelable:true});button.dispatchEvent(event);return event.defaultPrevented;})"
    ),
    true,
    "Every actual Service write button refuses repeated Enter."
  );
  await evaluateOnPage(page, "document.querySelector('[data-service-action=reset-vcu]').click()");
  await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='service:reset-vcu'", "restart arm");
  await evaluateOnPage(page, "document.querySelector('.service-actions').open=false");
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal"), "");
  await evaluateOnPage(page, "document.querySelector('.service-actions').open=true");
  await evaluateOnPage(page, FRAME);
  await confirmServiceButton(page, ".service-actions button:not([data-service-action])", "service:lights-off");
  assert.equal(await evaluateOnPage(page, "ridingPreview('lib/service-lights.js').lightsOff.rawVal"), true);
  assert.equal(
    await evaluateOnPage(page, "ridingPreview('lib/service-lights.js').lightsOutcome.rawVal.confirmed"),
    true
  );
  const batch = (await evaluateOnPage(
    page,
    "new URL(SERVICE_PARAMETER_REQUESTS.filter(request=>request.method==='POST'&&request.url.includes('action=parameters')).at(-1).url,'http://fixture.invalid').searchParams.getAll('w')"
  )) as string[];
  assert.equal(batch.length, 5, "The existing fixed lights action retains per-circuit CAS/readback.");
  await confirmServiceButton(page, ".service-actions button:not([data-service-action])", "service:lights-restore");
  assert.equal(await evaluateOnPage(page, "ridingPreview('lib/service-lights.js').lightsOff.rawVal"), false);
  assert.equal(
    await evaluateOnPage(
      page,
      "SERVICE_PARAMETERS.probes[Object.keys(SERVICE_PARAMETERS.probes).find(index=>SERVICE_PARAMETERS.probes[index].name==='INDICATOR_MAX_CURR_TH')].value"
    ),
    2000,
    "Restore uses this synthetic bike's healthy value."
  );
  for (const action of ["reset-vcu", "sync-clock", "set-service-point", "clear-dtcs"]) {
    await confirmServiceButton(page, `[data-service-action="${action}"]`, `service:${action}`);
    assert.equal(
      await evaluateOnPage(
        page,
        `ridingPreview('lib/service-actions.js').actionOutcome(${JSON.stringify(action)}).rawVal.completed`
      ),
      true
    );
    if (action !== "reset-vcu") {
      assert.equal(
        await evaluateOnPage(page, `document.querySelector('[data-service-action="${action}"]').textContent`),
        "Done"
      );
    }
  }
}
