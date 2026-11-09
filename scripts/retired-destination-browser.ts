import assert from "node:assert/strict";
import { evaluateOnPage, gotoPage, reloadPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkRetiredDestinationBrowser(page: HeadlessPage, file: string) {
  const origin = `file://${file}?scene=parked&fixture=all-installed&case=retired-origin#more`;
  await gotoPage(page, origin);
  await waitOnPage(
    page,
    `location.href===${JSON.stringify(origin)}&&document.documentElement?.dataset.previewReady==='yes'`,
    "the bookmark's previous page"
  );
  await gotoPage(
    page,
    `file://${file}?scene=parked&fixture=all-installed&case=retired-bookmark&panel=battery-cooling&section=old#more`
  );
  await waitOnPage(
    page,
    "new URL(location.href).searchParams.get('case')==='retired-bookmark'&&new URL(location.href).searchParams.get('panel')==='bike-information'&&document.querySelector('[data-more=bike][aria-current=page]')",
    "the retired bookmark opens Bike"
  );
  assert.equal(await evaluateOnPage(page, "new URL(location.href).searchParams.has('section')"), false);
  assert.equal(await evaluateOnPage(page, "document.body.innerText.includes('Battery & cooling')"), false);
  assert.equal(await evaluateOnPage(page, "document.querySelectorAll('.tabs a').length"), 5);
  await evaluateOnPage(page, "window.retiredDestinationReloadMarker=true");
  await reloadPage(page);
  await waitOnPage(
    page,
    "!window.retiredDestinationReloadMarker&&document.documentElement?.dataset.previewReady==='yes'&&document.querySelector('[data-more=bike][aria-current=page]')",
    "Bike after the new document loads"
  );
  await evaluateOnPage(page, "history.back()");
  await waitOnPage(
    page,
    `location.href===${JSON.stringify(origin)}&&document.querySelector('[data-more=settings][aria-current=page]')`,
    "Back reaches the preceding page without a redirect loop"
  );
  await evaluateOnPage(page, "history.forward()");
  await waitOnPage(
    page,
    "new URL(location.href).searchParams.get('panel')==='bike-information'&&document.querySelector('[data-more=bike][aria-current=page]')",
    "Forward restores the canonical Bike bookmark"
  );
  console.log("  ✓ retired bookmark replaces itself with Bike; reload and Back/Forward preserve its history entry");
}
