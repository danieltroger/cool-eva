import assert from "assert/strict";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkNetworkBrowser(page: HeadlessPage, previewFile: string): Promise<void> {
  const base = `file://${previewFile}?scene=parked&panel=settings&section=networks`;
  for (const state of ["list", "saved", "trying", "waiting-ble", "waiting-wifi", "restored", "failed", "kept"]) {
    await gotoPage(page, `${base}&network-state=${state}`);
    await waitOnPage(page, "document.body.innerText.includes('Synthetic home')", `Wi-Fi ${state}`);
    await assertPhoneLayout(page, state);
    if (state === "waiting-ble") {
      assert.equal(
        await evaluateOnPage(
          page,
          "[...document.querySelectorAll('.settings-page button')].some(button=>button.textContent==='Keep network')"
        ),
        false
      );
    }
    if (state === "waiting-wifi") {
      assert.equal(
        await evaluateOnPage(
          page,
          "document.body.innerText.includes('This phone reached Synthetic replacement over Wi-Fi')"
        ),
        true
      );
      assert.equal(
        await evaluateOnPage(
          page,
          "[...document.querySelectorAll('.settings-page button')].some(button=>button.textContent==='Keep network')"
        ),
        true
      );
      assert.equal(
        await evaluateOnPage(
          page,
          "[...document.querySelectorAll('.settings-page a')].some(link=>link.href==='http://192.0.2.30/?panel=settings&section=networks')"
        ),
        true
      );
    }
    if (state === "kept") {
      assert.equal(
        await evaluateOnPage(
          page,
          "document.body.innerText.includes('Previous connection: Synthetic home remains saved.')"
        ),
        false
      );
      assert.equal(await evaluateOnPage(page, "document.body.innerText.includes('profile was replaced')"), true);
    }
  }
  await gotoPage(page, `${base}&network-state=list&editor-check=1`);
  await waitOnPage(page, "document.body.innerText.includes('Synthetic home')", "network editor readback");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.settings-page button')].find(button=>button.textContent==='Change').click()"
  );
  await waitOnPage(page, "document.body.innerText.includes('Keep saved password')", "explicit retained-password mode");
  assert.equal(await evaluateOnPage(page, "document.querySelectorAll('input[type=password]').length"), 0);
  await evaluateOnPage(
    page,
    "const choice=document.querySelector('select[aria-label=\"Password choice\"]');choice.value='change';choice.dispatchEvent(new Event('change',{bubbles:true}))"
  );
  await waitOnPage(page, "!!document.querySelector('input[aria-label=\"New password\"]')", "new password mode");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.settings-page button')].find(button=>button.textContent==='Save').click()"
  );
  await waitOnPage(page, "document.body.innerText.includes('Enter a password of')", "empty password validation");
  await evaluateOnPage(
    page,
    "const input=document.querySelector('input[aria-label=\"New password\"]');input.value='synthetic-passphrase';input.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('.settings-page button')].find(button=>button.textContent==='Show password').click()"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('input[aria-label=\"New password\"]').type"), "text");
  await assertPhoneLayout(page, "password editor");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.settings-page button')].find(button=>button.textContent==='Cancel').click()"
  );
  await waitOnPage(page, "!document.body.innerText.includes('Draft — not saved.')", "cancelled password draft");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.settings-page button')].find(button=>button.textContent==='Change').click()"
  );
  await evaluateOnPage(
    page,
    "const revisitedChoice=document.querySelector('select[aria-label=\"Password choice\"]');revisitedChoice.value='change';revisitedChoice.dispatchEvent(new Event('change',{bubbles:true}))"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('input[aria-label=\"New password\"]').value"), "");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('input[aria-label=\"New password\"]').type"),
    "password"
  );

  await gotoPage(page, `${base}&network-state=saved&arming-check=1`);
  await waitOnPage(page, "document.body.innerText.includes('Saved. Ready to try.')", "saved candidate");
  await evaluateOnPage(
    page,
    "const button=[...document.querySelectorAll('.settings-page button')].find(button=>button.textContent==='Try network');button.click();button.click()"
  );
  assert.equal(await evaluateOnPage(page, "NETWORKS.change.phase"), "saved", "double tap inside dwell cannot fire");
  await evaluateOnPage(page, "NETWORKS.change.phase='trying';NETWORKS.change.message='Trying Synthetic replacement'");
  await waitOnPage(
    page,
    "![...document.querySelectorAll('.settings-page button')].some(button=>button.textContent==='Confirm trial')",
    "another client starting the trial"
  );
  await evaluateOnPage(
    page,
    "NETWORKS.change.phase='restored';NETWORKS.change.message='Reconnected to Synthetic home'"
  );
  await waitOnPage(
    page,
    "[...document.querySelectorAll('.settings-page button')].some(button=>button.textContent==='Try again')",
    "a restored trial must require a fresh arm"
  );
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.settings-page button')].find(button=>button.textContent==='Try again').click()"
  );
  await evaluateOnPage(page, "new Promise(resolve=>setTimeout(resolve,450))");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.settings-page button')].find(button=>button.textContent==='Confirm trial').click()"
  );
  await waitOnPage(page, "NETWORKS.change.phase==='trying'", "explicit armed trial");
  await evaluateOnPage(
    page,
    "window.fetch=(original=>(input,init)=>String(input)==='/settings/networks'?Promise.resolve(new Response(JSON.stringify({ok:false,message:'Lost contact with Cool Eva. Network result unconfirmed.'}),{status:503,headers:{'Content-Type':'application/json'}})):original(input,init))(window.fetch)"
  );
  await waitOnPage(
    page,
    "document.body.innerText.includes('Lost contact with Cool Eva. Network result unconfirmed.')",
    "lost-contact result"
  );
  assert.equal(
    await evaluateOnPage(page, "document.body.innerText.includes('seconds remain in this trial')"),
    false,
    "offline pages cannot continue the countdown"
  );
  assert.equal(await evaluateOnPage(page, "document.body.innerText.includes('Previous network kept')"), false);
  console.log(
    "Wi-Fi phone checks: eight states, real Wi-Fi link, password modes/clearing, blank validation, trial dwell and offline countdown pass at 390px."
  );
}

async function assertPhoneLayout(page: HeadlessPage, state: string): Promise<void> {
  const layout = await evaluateOnPage(
    page,
    "({width:innerWidth,scroll:document.body.scrollWidth,targets:[...document.querySelectorAll('.settings-page button')].filter(button=>button.offsetParent!==null).every(button=>{const rect=button.getBoundingClientRect();return rect.width>=44&&rect.height>=44})})"
  );
  const measured = layout as { width: number; scroll: number; targets: boolean };
  assert.equal(measured.width, 390, state);
  assert.ok(measured.scroll <= 390, `${state} must fit the phone`);
  assert.equal(measured.targets, true, `${state} actions need 44px targets`);
}
