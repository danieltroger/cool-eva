import assert from "node:assert/strict";
import { evaluateOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkRegenHints(page: HeadlessPage, file: string, capture?: (name: string) => Promise<void>) {
  for (const theme of ["dark", "light"]) {
    await openPreview(page, file, "#hypermile", `regen-hint-${theme}`);
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};ridingPreview('lib/destination.js').openDestination('battery-cooling')`
    );
    for (const [soc, expected] of [
      [95, "High charge level can reduce regen."],
      [60, "Check pack temperature."],
    ] as const) {
      await evaluateOnPage(page, `pushPatch({soc:[${soc},'%','battery']})`);
      await evaluateOnPage(page, FRAME);
      assert.ok(
        String(await evaluateOnPage(page, "document.querySelector('.regen-information').innerText")).includes(expected)
      );
    }
    await evaluateOnPage(page, "pushPatch({allowed_regen_a:[120,'A','battery']});pausePreviewMessages(true)");
    await evaluateOnPage(page, FRAME);
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('.regen-information').textContent")).includes(
        "Full regen"
      ),
      "A full allowance must not suggest a derate."
    );
    if (capture) {
      await capture(`battery-full-regen-${theme}`);
    }

    await evaluateOnPage(
      page,
      "pausePreviewMessages(false);pushPatch({allowed_regen_a:[55,'A','battery']});pausePreviewMessages(true)"
    );
    await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').signalState('soc').val=null");
    await evaluateOnPage(page, FRAME);
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('.regen-information').innerText")).includes(
        "Check charge level and pack temperature."
      )
    );
    await evaluateOnPage(page, "pausePreviewMessages(false);pushPatch({allowed_regen_a:[65535,'A','battery']})");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.regen-information .value').textContent"),
      "fault"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.regen-information').innerText.includes('Check pack')"),
      false
    );
  }
}
