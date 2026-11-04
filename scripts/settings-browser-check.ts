import assert from "assert/strict";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkSettingsBrowser(page: HeadlessPage, previewFile: string): Promise<void> {
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=bike&settings=unconfirmed`);
  await waitOnPage(
    page,
    "document.body.innerText.includes('Settings unconfirmed')",
    "the initial unread settings state"
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.settings-page select')].every(select=>select.value===''&&select.disabled)"
    ),
    true,
    "Unread settings must never present fallback Off as a saved or active choice."
  );
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=bike&settings=confirmed`);
  await waitOnPage(page, "document.body.innerText.includes('Saved: Off.')", "the first settings readback");
  await evaluateOnPage(
    page,
    "SETTINGS.ok=false;SETTINGS.fault='Synthetic preserved document fault';SETTINGS.revision++"
  );
  await waitOnPage(
    page,
    "document.body.innerText.includes('Repair instructions')&&document.body.innerText.includes('Retry settings after repair')",
    "a fault that arrived after the initial render"
  );
  assert.equal(await evaluateOnPage(page, "document.body.innerText.includes('Saved choice unreadable')"), true);
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=bike&reload-check=1`);
  await waitOnPage(
    page,
    "document.body.innerText.includes('Saved: Off.')",
    "settings before the cached-client refusal"
  );
  await evaluateOnPage(
    page,
    `window.fetch=(original=>(input,init)=>init?.method==='PATCH'?Promise.resolve({status:403,ok:false,json:async()=>({message:'Reload the page'})}):original(input,init))(window.fetch);const select=document.querySelector('select[aria-label="Coolant probes"]');select.value='true';select.dispatchEvent(new Event('change',{bubbles:true}));select.closest('.settings-card').querySelector('button:last-child').click()`
  );
  await waitOnPage(
    page,
    "document.body.innerText.includes('This dashboard is out of date')",
    "the reactive reload notice"
  );
  await evaluateOnPage(page, "localStorage.removeItem('cool-eva.setup-seen:synthetic-pi')");
  await gotoPage(page, `file://${previewFile}?scene=parked&notice-check=1#ride`);
  await waitOnPage(page, "!!document.querySelector('.migration-notice')", "the first-open riding notice");
  await evaluateOnPage(
    page,
    "[...document.querySelectorAll('button')].find(button=>button.textContent==='Got it').click()"
  );
  await waitOnPage(page, "!document.querySelector('.migration-notice')", "the dismissed notice's wrapper to disappear");
  assert.equal(
    await evaluateOnPage(
      page,
      "Math.round(document.querySelector('.view').getBoundingClientRect().top-document.querySelector('.header').getBoundingClientRect().bottom)"
    ),
    0
  );
  const dimensions = await evaluateOnPage(
    page,
    "[innerWidth,document.body.scrollWidth,document.querySelector('.header .menu').getBoundingClientRect().height]"
  );
  assert.deepEqual(dimensions, [390, 390, 44]);
  console.log(
    "  ✓ settings: unread choices, arriving fault/reload notices, a zero-height dismissal and the actual Back target"
  );
}
