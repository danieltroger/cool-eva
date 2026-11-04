import assert from "assert/strict";
import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";

export async function checkNetworkPurposeBrowser(page: HeadlessPage, base: string): Promise<void> {
  for (const purpose of ["home", "hotspot"]) {
    await gotoPage(page, `${base}&network-state=list&network-purpose=${purpose}`);
    await waitOnPage(page, `document.body.innerText.includes('Synthetic ${purpose}')`, `${purpose} saved profile`);
    await click(page, "Change");
    await waitOnPage(page, "!!document.querySelector('select[aria-label=\"Network purpose\"]')", "purpose editor");
    assert.equal(await displayedPurpose(page), purpose, "initial display matches the saved purpose");
    await waitOnPage(page, "NETWORK_READS>=2", "poll while editing");
    assert.equal(await displayedPurpose(page), purpose, "polling preserves the displayed draft");
    await click(page, "Bluetooth setup");
    await waitOnPage(page, "!document.querySelector('select[aria-label=\"Network purpose\"]')", "leave editor");
    await click(page, "Wi-Fi networks");
    await waitOnPage(page, "!!document.querySelector('select[aria-label=\"Network purpose\"]')", "revisit editor");
    assert.equal(await displayedPurpose(page), purpose, "revisiting preserves the displayed draft");
    const changed = purpose === "home" ? "hotspot" : "home";
    await evaluateOnPage(
      page,
      `const purpose=document.querySelector('select[aria-label="Network purpose"]');purpose.value='${changed}';purpose.dispatchEvent(new Event('change',{bubbles:true}))`
    );
    assert.equal(await displayedPurpose(page), changed, "intentional change is visible");
    const reads = (await evaluateOnPage(page, "NETWORK_READS")) as number;
    await waitOnPage(page, `NETWORK_READS>${reads}`, "poll after intentional change");
    assert.equal(await displayedPurpose(page), changed, "polling cannot reset the chosen purpose");
    await click(page, "Save");
    await waitOnPage(page, "!!NETWORKS.change", "purpose Save");
    assert.equal(
      await evaluateOnPage(page, "NETWORKS.change.purpose"),
      changed,
      "submitted choice matches the displayed one"
    );
    await click(page, "Cancel change");
    await waitOnPage(page, "!NETWORKS.change", "clear candidate");
    await click(page, "Change");
    assert.equal(await displayedPurpose(page), purpose, "a new Change reads the unchanged saved profile");
    await click(page, "Save");
    await waitOnPage(page, "!!NETWORKS.change", "retained purpose Save");
    assert.equal(await evaluateOnPage(page, "NETWORKS.change.purpose"), purpose);
  }
  for (const phase of ["failed", "restored"]) {
    await gotoPage(page, `${base}&network-state=${phase}`);
    await waitOnPage(page, "document.body.innerText.includes('Dismiss')", `${phase} dismiss action`);
    const reads = (await evaluateOnPage(page, "NETWORK_READS")) as number;
    await evaluateOnPage(page, "new Promise(resolve=>setTimeout(resolve,1800))");
    assert.equal(
      await evaluateOnPage(page, "NETWORK_READS"),
      reads,
      "terminal result stops background HTTP/NM polling"
    );
    await click(page, "Read again");
    await waitOnPage(page, `NETWORK_READS>${reads}`, "explicit result readback");
    await click(page, "Dismiss");
    await waitOnPage(page, "!NETWORKS.change", "dismiss tried candidate without another Save");
  }
  console.log(
    "Wi-Fi editor: Home/hotspot saved, displayed and submitted purposes agree after polls, revisit and intentional change; terminal results idle until explicit read/dismiss."
  );
}

function displayedPurpose(page: HeadlessPage): Promise<unknown> {
  return evaluateOnPage(page, "document.querySelector('select[aria-label=\"Network purpose\"]').value");
}
function click(page: HeadlessPage, caption: string): Promise<unknown> {
  return evaluateOnPage(
    page,
    `[...document.querySelectorAll('.settings-page button')].find(button=>button.textContent===${JSON.stringify(caption)}).click()`
  );
}
