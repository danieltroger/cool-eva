import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { FRAME } from "./riding-preview-page.ts";
import { selectParameter } from "./service-parameter-browser.ts";

export async function checkServiceRegroupBrowser(page: HeadlessPage) {
  assert.equal(
    await evaluateOnPage(
      page,
      "!!document.querySelector('.service-parameter-section')&&!!document.querySelector('.service-operations')"
    ),
    true,
    "Service keeps parameters and operations in their own sections."
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `(()=>{
        const parameters=document.querySelector('.service-parameter-section');
        const operations=document.querySelector('.service-operations');
        return {
          heading:parameters.querySelector(':scope > .label').innerText,
          parameterChildren:[...parameters.children].map(node=>node.className),
          operations:[...operations.querySelectorAll(':scope > details > summary')].map(node=>node.textContent),
          operationsPadding:getComputedStyle(operations).padding,
          operationsGap:getComputedStyle(operations).gap,
          signals:document.querySelector('.service-page > .all-signals > summary').textContent,
          readiness:document.querySelector('.service-page').innerText.includes('Bike controls ready'),
          pageChildren:document.querySelector('.service-page').children.length
        };
      })()`
    ),
    {
      heading: "WRITE PARAMETERS",
      parameterChildren: ["label", "layout-stack service-parameters", "layout-stack service-backup"],
      operations: ["Service actions", "Recent changes"],
      operationsPadding: "0px",
      operationsGap: "0px",
      signals: "Current CAN values",
      readiness: false,
      pageChildren: 3,
    },
    "Service retains exactly the three approved groups."
  );
  await selectParameter(page, "MAP3_PWR", 57);
  await evaluateOnPage(
    page,
    "GATE.safe=false;GATE.blockers=['Synthetic moving bike'];ridingPreview('lib/service-client.js').refreshServiceStatus()"
  );
  await waitOnPage(page, "!ridingPreview('lib/service-client.js').serviceCanWrite(true)", "blocked Service writes");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.parameter-write-block').hidden"),
    true,
    "A blocked gate alone must not create a notice before an edit."
  );
  await evaluateOnPage(
    page,
    "GATE.safe=true;GATE.blockers=[];ridingPreview('lib/service-client.js').refreshServiceStatus()"
  );
  await waitOnPage(page, "ridingPreview('lib/service-client.js').serviceCanWrite(true)", "restored Service gate");
  await evaluateOnPage(
    page,
    "(()=>{const input=document.querySelector('.parameter-editor input');input.value='500';input.dispatchEvent(new Event('input',{bubbles:true}));})()"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-write-block').hidden"), true);
  const writesBefore = await writeCount(page);
  await evaluateOnPage(
    page,
    "GATE.safe=false;GATE.blockers=['Synthetic moving bike'];ridingPreview('lib/service-client.js').refreshServiceStatus()"
  );
  await waitOnPage(page, "!document.querySelector('.parameter-write-block').hidden", "inline Confirm blocker");
  await evaluateOnPage(page, FRAME);
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `(()=>{
        const message=document.querySelector('.parameter-write-block');
        const button=document.querySelector('.parameter-editor button');
        const bounds=message.getBoundingClientRect();
        const buttonBounds=button.getBoundingClientRect();
        const editor=document.querySelector('.parameter-editor').getBoundingClientRect();
        return {text:message.textContent,confirm:button.textContent,disabled:button.disabled,
          siblings:message.parentElement===button.parentElement,
          adjacent:bounds.right<=buttonBounds.left&&buttonBounds.left-bounds.right<=12,
          centred:Math.abs(bounds.top+bounds.height/2-buttonBounds.top-buttonBounds.height/2)<1,
          oneLine:bounds.height<=parseFloat(getComputedStyle(message).fontSize)*1.5,
          inside:bounds.left>=editor.left&&bounds.right<=editor.right,
          headerStatus:!!document.querySelector('.service-page > .layout-between,.service-parameter-section > .service-tiny')};
      })()`
    ),
    {
      text: "Park to confirm",
      confirm: "Confirm 500 raw",
      disabled: true,
      siblings: true,
      adjacent: true,
      centred: true,
      oneLine: true,
      inside: true,
      headerStatus: false,
    },
    "The write blocker belongs on one line beside the disabled Confirm control."
  );
  await evaluateOnPage(page, "document.querySelector('.parameter-editor button').click()");
  assert.equal(await writeCount(page), writesBefore, "A blocked Confirm cannot send a write.");
  await evaluateOnPage(
    page,
    "GATE.safe=true;GATE.blockers=[];ridingPreview('lib/service-client.js').refreshServiceStatus()"
  );
  await waitOnPage(page, "document.querySelector('.parameter-write-block').hidden", "blocker clears after recovery");
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-editor button').textContent"), "Set");
}

function writeCount(page: HeadlessPage) {
  return evaluateOnPage(
    page,
    "SERVICE_PARAMETER_REQUESTS.filter(request=>request.method==='POST'&&request.url.startsWith('/vcu-write')).length"
  );
}
