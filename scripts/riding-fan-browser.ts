import assert from "node:assert/strict";
import { evaluateOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkCoolingFan(
  page: HeadlessPage,
  file: string,
  assertLayout: (page: HeadlessPage) => Promise<void>
) {
  await openPreview(page, file, "#ride/cooling", "fan-states");
  for (const theme of ["dark", "light"]) {
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    for (const [code, label] of [
      [0, "Manual"],
      [1, "Automatic"],
      [2, "Fun"],
    ] as const) {
      await evaluateOnPage(page, `pushPatch({fan_auto_mode:[${code},'','fan']})`);
      await evaluateOnPage(page, FRAME);
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-fan-status]').textContent"),
        `${label} · driving`,
        "Cooling must respect the published fan mode codes."
      );
      await assertLayout(page);
    }
    for (const state of [
      { duty: 0, target: 0, enabled: 0, text: "Automatic · Standby", fault: false },
      { duty: 0, target: 0, enabled: 1, text: "Braking fault · cut fan power", fault: true },
      { duty: 0, target: 68, enabled: 1, text: "Braking fault · cut fan power", fault: true },
      { duty: 68, target: 0, enabled: 1, text: "Stop failed · still driving", fault: true },
      { duty: 100, target: 68, enabled: 1, text: "Automatic · kick-starting", fault: false },
      { duty: 68, target: 68, enabled: 1, text: "Automatic · driving", fault: false },
    ]) {
      await evaluateOnPage(
        page,
        `pushPatch({fan_auto_mode:[1,'','fan'],fan_duty_pct:[${state.duty},'%','fan'],fan_target_pct:[${state.target},'%','fan'],fan_driver_enabled:[${state.enabled},'','fan']})`
      );
      await evaluateOnPage(page, FRAME);
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-fan-status]').textContent"),
        state.text,
        "Enabled-at-zero duty must be a braking fault, never normal fan operation."
      );
      if (state.fault) {
        assert.equal(
          await evaluateOnPage(page, "document.querySelector('[data-fan-status] span').style.color === 'var(--bad)'"),
          true,
          "Unsafe fan states must use fault ink."
        );
      }
      await assertLayout(page);
    }
  }
}
