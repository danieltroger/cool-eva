import assert from "node:assert/strict";
import { FAULT_MEMORY_MS } from "../public/lib/reading-status.js";
import { evaluateOnPage, type HeadlessPage } from "./headless-page.ts";
import { FRAME, openPreview } from "./riding-preview-page.ts";

export async function checkFaultRecovery(
  page: HeadlessPage,
  file: string,
  assertLayout: (page: HeadlessPage) => Promise<void>,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  const cases = [
    {
      name: "ride-probe",
      hash: "#ride",
      key: "coolant_in",
      rejected: -242,
      valid: 36.5,
      selector: "[data-reading=coolant-delta]",
      fault: "fault",
      fresh: "4.70°C",
    },
    {
      name: "ride-power",
      hash: "#ride",
      key: "pack_kw",
      rejected: -999,
      valid: -48.3,
      selector: "[data-signal=pack_kw]",
      fault: "—",
      fresh: "48",
    },
    {
      name: "ride-heat",
      hash: "#ride",
      key: "pack_a",
      rejected: -999,
      valid: -142,
      selector: "[data-reading=resistance-heat]",
      fault: "fault",
      fresh: "1.47",
    },
    {
      name: "cooling-probe",
      hash: "#ride/cooling",
      key: "coolant_in",
      rejected: -242,
      valid: 36.5,
      selector: "[data-signal=coolant_in]",
      fault: "fault",
      fresh: "36.5",
    },
    {
      name: "cooling-fan",
      hash: "#ride/cooling",
      key: "fan_target_pct",
      rejected: 150,
      valid: 68,
      selector: "[data-signal=fan_target_pct]",
      fault: "fault",
      fresh: "68",
    },
  ];
  for (const scenario of cases) {
    await openPreview(page, file, scenario.hash, `fault-recovery-${theme}-${scenario.name}`);
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pausePreviewMessages(true);window.faultRecoveryStarted=ridingPreview('lib/store.js').peekServerTime()`
    );
    await evaluateOnPage(page, FRAME);
    await assertNumericUnits(page, scenario.hash);
    await applySample(page, scenario.key, scenario.rejected, 0);
    await assertReading(page, scenario.selector, scenario.fault, `${scenario.name}: rejected newest sample`);
    await applySample(page, scenario.key, scenario.valid, 100);
    await assertReading(
      page,
      scenario.selector,
      scenario.fault,
      `${scenario.name}: valid samples must not erase fault memory`
    );
    await assertStatusUnits(page);
    if (scenario.key === "fan_target_pct") {
      await assertReading(
        page,
        "[data-fan-status]",
        "Fan status fault",
        "FanStatus uses the same memory as its reading"
      );
    }
    if (scenario.key === "pack_kw") {
      const label = (await evaluateOnPage(
        page,
        "document.querySelector('.power-edge').getAttribute('aria-label')"
      )) as string;
      assert.ok(label.includes("POWER fault."), "A fault in the Edge description must have no unit.");
      assert.equal(await evaluateOnPage(page, "document.querySelector('.ride-kilowatts .unit').textContent"), "");
    }
    await assertLayout(page);
    if (capture) {
      await capture(`${scenario.name}-${theme}`);
    }
    await applySample(page, scenario.key, scenario.valid, FAULT_MEMORY_MS - 1);
    await assertReading(
      page,
      scenario.selector,
      scenario.fault,
      `${scenario.name}: fault must last the entire memory window`
    );
    await applySample(page, scenario.key, scenario.valid, FAULT_MEMORY_MS + 1);
    await assertReading(
      page,
      scenario.selector,
      scenario.fresh,
      `${scenario.name}: recovered sample must expire fault memory`
    );
    await assertNumericUnits(page, scenario.hash);
    if (scenario.key === "fan_target_pct") {
      await assertReading(page, "[data-fan-status]", "Automatic control", "FanStatus must recover too");
    }
    assert.equal(
      await evaluateOnPage(page, `!!ridingPreview('lib/store.js').faultState(${JSON.stringify(scenario.key)}).val`),
      true,
      "Recovery must come from the policy, not deleting the store's rejection."
    );
    await applySample(page, scenario.key, scenario.rejected, FAULT_MEMORY_MS + 100);
    await applySample(page, scenario.key, null, 2 * FAULT_MEMORY_MS + 101);
    await assertReading(
      page,
      scenario.selector,
      scenario.fault,
      `${scenario.name}: latest rejection stays faulted after memory expires`
    );
    await applySample(page, scenario.key, scenario.valid, 2 * FAULT_MEMORY_MS + 102);
    await assertReading(
      page,
      scenario.selector,
      scenario.fresh,
      `${scenario.name}: valid sample recovers an old newest rejection`
    );
    await assertLayout(page);
  }
  console.log(`  ✓ ${theme}: Ride/Cooling reject → valid → 60 s memory → recovery, newest rejections and units`);
}

async function applySample(page: HeadlessPage, key: string, value: number | null, offset: number) {
  await evaluateOnPage(
    page,
    `(() => {
    const store=ridingPreview('lib/store.js');
    const timestamp=window.faultRecoveryStarted+${offset};
    const key=${JSON.stringify(key)};
    const readings=${value === null ? "{}" : `{...LIVE,[key]:[${value},LIVE[key][1],LIVE[key][2]]}`};
    const packet=message('patch',readings);
    packet.ts=timestamp;
    for(const reading of Object.values(packet.signals)){reading.ts=timestamp;}
    store.apply(packet);
    store.chartTick.val++;
  })()`
  );
  await evaluateOnPage(page, FRAME);
}

async function assertReading(page: HeadlessPage, selector: string, expected: string, reason: string) {
  assert.equal(
    await evaluateOnPage(page, `document.querySelector(${JSON.stringify(selector)}).textContent.trim()`),
    expected,
    reason
  );
}

async function assertStatusUnits(page: HeadlessPage) {
  const text = (await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.riding-view .value')].map(element=>element.textContent).join('|')"
  )) as string;
  assert.equal(
    /(?:fault|stale|missing)\s*(?:°[CF]|kW|%|km\/h|mph)/i.test(text),
    false,
    "A status word must never acquire a numeric unit."
  );
}

async function assertNumericUnits(page: HeadlessPage, hash: string) {
  assert.deepEqual(
    await evaluateOnPage(
      page,
      hash === "#ride"
        ? "[...document.querySelectorAll('.ride-temperature .unit')].map(element=>element.textContent)"
        : "[...document.querySelectorAll('.cooling-view .unit')].map(element=>element.textContent)"
    ),
    hash === "#ride" ? ["°C"] : ["°C", "°C", "°C", "%"],
    "Numeric readings must render their units after the initial snapshot and fault recovery."
  );
}
