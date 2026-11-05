import assert from "node:assert/strict";
import { evaluateOnPage, gotoPage, resizePage, setPageInsets, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkScreenGeometry(page: HeadlessPage, previewFile: string): Promise<void> {
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=software`);
  await waitOnPage(page, "!!document.querySelector('.screen-geometry')", "the screen geometry readout");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.screen-geometry').textContent.split(' · display-mode')[0]"),
    "390×844 · DPR 3 · insets T/R/B/L 47/0/34/0 px"
  );
  assert.match(
    String(await evaluateOnPage(page, "document.querySelector('.screen-geometry').textContent")),
    /display-mode standalone: no · iOS standalone: unavailable · screen \d+×\d+ · visualViewport \d+(?:\.\d+)?×\d+(?:\.\d+)?/,
    "The independent iOS flag, screen size and visual viewport must render."
  );
  await evaluateOnPage(
    page,
    "Object.defineProperty(navigator,'standalone',{configurable:true,value:true});dispatchEvent(new Event('resize'))"
  );
  await waitOnPage(
    page,
    "document.querySelector('.screen-geometry').textContent.includes('display-mode standalone: no · iOS standalone: yes')",
    "the iOS flag independent of display-mode"
  );
  try {
    await evaluateOnPage(
      page,
      "Object.defineProperty(visualViewport,'height',{configurable:true,value:500});visualViewport.dispatchEvent(new Event('resize'))"
    );
    await waitOnPage(
      page,
      "document.querySelector('.screen-geometry').textContent.includes('visualViewport 390×500')",
      "a visual-viewport-only resize, as with a keyboard or zoom"
    );
    await evaluateOnPage(page, "delete visualViewport.height");
    await setPageInsets(page, { top: 0, right: 47, bottom: 21, left: 34 });
    await resizePage(page, { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
    await waitOnPage(
      page,
      "document.querySelector('.screen-geometry').textContent.startsWith('844×390 · DPR 2 · insets T/R/B/L 0/47/21/34 px · display-mode standalone: no · iOS standalone: yes')",
      "the live geometry after rotation/resize, including all four inset values"
    );
  } finally {
    await evaluateOnPage(page, "delete navigator.standalone");
    await setPageInsets(page, { top: 47, right: 0, bottom: 34, left: 0 });
    await resizePage(page, { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  }
  console.log("  ✓ screen geometry: viewport, DPR, env() insets and display mode; live resize/rotation readback");
}
