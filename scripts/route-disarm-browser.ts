import assert from "node:assert/strict";
import { ARM_DWELL_MS } from "../public/lib/arming.js";
import { TABS } from "../public/lib/router.js";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkRouteDisarmBrowser(page: HeadlessPage, previewFile: string): Promise<void> {
  await gotoPage(page, `file://${previewFile}?scene=dc&route-disarm=1#charge`);
  await waitOnPage(page, `${STOP_BUTTON} && !${STOP_BUTTON}.disabled`, "the live Charge Stop control");
  await evaluateOnPage(
    page,
    `(() => {
    window.routeDisarmWriteRequests = 0;
    const previewFetch = window.fetch;
    window.fetch = (input, options) => {
      const url = new URL(typeof input === "string" ? input : input.url, "http://eva.local/");
      // The opening SOC read is harmless; returning must never replay a write.
      if (url.pathname === "/vcu-write" && options?.method === "POST" && url.searchParams.get("action") !== "charge-soc-limit-read") {
        window.routeDisarmWriteRequests += 1;
      }
      return previewFetch(input, options);
    };
  })()`
  );

  await evaluateOnPage(page, `${STOP_BUTTON}.click()`);
  await waitOnPage(page, `${STOP_BUTTON}.textContent === "Confirm stop"`, "Stop to arm");
  // The old confirmation must have passed its dwell, or a stale arm could appear safe by timing alone.
  await evaluateOnPage(page, `new Promise(resolve => setTimeout(resolve, ${ARM_DWELL_MS + 50}))`);
  await clickTab(page, "more");
  await clickTab(page, "charge");
  await waitOnPage(page, `${STOP_BUTTON} && !${STOP_BUTTON}.disabled`, "Stop after returning to Charge");
  const returnedCaption = await evaluateOnPage(page, `${STOP_BUTTON}.textContent`);

  await evaluateOnPage(page, `${STOP_BUTTON}.click()`);
  await waitOnPage(
    page,
    `window.routeDisarmWriteRequests > 0 || ${STOP_BUTTON}.textContent === "Confirm stop"`,
    "the first Stop tap after returning"
  );
  assert.equal(
    await evaluateOnPage(page, "window.routeDisarmWriteRequests"),
    0,
    "The first Stop tap after returning must not POST the old confirmation."
  );
  assert.equal(typeof returnedCaption, "string");
  assert.equal(returnedCaption, "Stop charge", "Navigation must leave Stop visibly unarmed.");
  await clickTab(page, "more");
  console.log("  ✓ Charge → More → Charge disarms Stop; the first return tap sends zero write requests");
}

const STOP_BUTTON = `document.querySelector("[data-charge-action=stop]")`;

async function clickTab(page: HeadlessPage, name: "more" | "charge"): Promise<void> {
  const label = TABS.find(tab => tab.name === name)?.label;
  assert.ok(label);
  await evaluateOnPage(
    page,
    `[...document.querySelectorAll(".tabs .tab")].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`
  );
  await waitOnPage(page, `location.hash === "#${name}"`, `the ${name} route`);
  await evaluateOnPage(page, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}
