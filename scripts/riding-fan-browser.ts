import assert from "node:assert/strict";
import { FAN_REASON } from "../src/fan/curve.ts";
import { evaluateOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import { checkFanCommands } from "./riding-fan-commands-browser.ts";

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
      await evaluateOnPage(page, `pushPatch({fan_auto_mode:[${code},'','fan',Date.now()-60_000]})`);
      await evaluateOnPage(page, FRAME);
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-fan-status]').textContent"),
        label === "Fun" ? "Fun · driving" : `${label} control`,
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
      {
        duty: 100,
        target: 30,
        enabled: 1,
        reason: FAN_REASON.TEMPERATURE_FAULT,
        text: "Fan status fault",
        fault: true,
      },
      { duty: 68, target: 68, enabled: 1, text: "Automatic control", fault: false },
    ]) {
      await evaluateOnPage(
        page,
        `(() => { const changedAt=Date.now()-60_000; pushPatch({fan_auto_mode:[1,'','fan',changedAt],fan_auto_reason:[${state.reason ?? FAN_REASON.PACK_TEMPERATURE},'','fan',changedAt],fan_duty_pct:[${state.duty},'%','fan',changedAt],fan_target_pct:[${state.target},'%','fan',changedAt],fan_driver_enabled:[${state.enabled},'','fan',changedAt]}); })()`
      );
      await evaluateOnPage(page, FRAME);
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-fan-status]').textContent"),
        state.text,
        "Enabled-at-zero duty must be a braking fault, never normal fan operation."
      );
      if (state.fault) {
        assert.equal(
          await evaluateOnPage(page, "document.querySelector('[data-fan-status]').style.color === 'var(--bad)'"),
          true,
          "Unsafe fan states must use fault ink."
        );
      }
      await assertLayout(page);
    }
    for (const link of ["offline", "connecting"]) {
      await evaluateOnPage(
        page,
        `pausePreviewMessages(true); ridingPreview('lib/store.js').connection.val=${JSON.stringify(link)}`
      );
      await evaluateOnPage(page, "for (const socket of liveSockets) { socket.deliver(message('snapshot',LIVE)); }");
      await evaluateOnPage(page, FRAME);
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-fan-status]').textContent"),
        "Fan status unavailable",
        "Retained fan commands are unavailable when the link is not live."
      );
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-signal=fan_target_pct]').textContent"),
        "stale"
      );
      await assertLayout(page);
    }
    await evaluateOnPage(page, "pausePreviewMessages(false); pushPatch({})");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-signal=fan_target_pct]').textContent"),
      "68"
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-fan-status]').textContent"),
      "Automatic control"
    );
  }
  for (const key of ["fan_auto_mode", "fan_driver_enabled", "fan_duty_pct", "fan_target_pct"]) {
    const original = await evaluateOnPage(
      page,
      `ridingPreview('lib/store.js').signalState(${JSON.stringify(key)}).val`
    );
    assert.ok(original);
    await evaluateOnPage(page, `ridingPreview('lib/store.js').signalState(${JSON.stringify(key)}).val=null`);
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-fan-status]').textContent"),
      "Fan status unavailable"
    );
    await evaluateOnPage(
      page,
      `ridingPreview('lib/store.js').signalState(${JSON.stringify(key)}).val=${JSON.stringify(original)}`
    );
  }
  await evaluateOnPage(page, "pushPatch({fan_target_pct:[150,'%','fan',Date.now()-60_000]})");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-signal=fan_target_pct]').textContent"),
    "fault"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-fan-status]').textContent"),
    "Fan status fault"
  );
  await assertLayout(page);
  await openPreview(page, file, "#ride/cooling", "sensor-age-gate");
  await evaluateOnPage(page, "pushPatch({coolant_in:[36.5,'°C','coolant',Date.now()-60_000]})");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-signal=coolant_in]').textContent"),
    "stale",
    "Real sensors must keep their age gate."
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-signal=fan_target_pct]').textContent"), "68");
  await assertLayout(page);
  await checkFanCommands(page, file);
}
