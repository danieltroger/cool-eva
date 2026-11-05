import assert from "node:assert/strict";
import { evaluateOnPage, gotoPage, resizePage, setPageInsets, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkScreenGeometry(page: HeadlessPage, previewFile: string): Promise<void> {
  await gotoPage(page, `file://${previewFile}?scene=parked&panel=settings&section=software`);
  await waitOnPage(page, "!!document.querySelector('.screen-geometry')", "the screen geometry readout");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.screen-geometry').textContent"),
    "390×844 · DPR 3 · insets T/R/B/L 47/0/34/0 px · standalone: no"
  );
  try {
    await setPageInsets(page, { top: 0, right: 47, bottom: 21, left: 34 });
    await resizePage(page, { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
    await waitOnPage(
      page,
      "document.querySelector('.screen-geometry').textContent==='844×390 · DPR 2 · insets T/R/B/L 0/47/21/34 px · standalone: no'",
      "the live geometry after rotation/resize, including all four inset values"
    );
  } finally {
    await setPageInsets(page, { top: 47, right: 0, bottom: 34, left: 0 });
    await resizePage(page, { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  }
  console.log("  ✓ screen geometry: viewport, DPR, env() insets and display mode; live resize/rotation readback");
}
