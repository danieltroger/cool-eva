import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkPowerWords(
  page: HeadlessPage,
  file: string,
  assertLayout: (page: HeadlessPage) => Promise<void>,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  const cases = [
    { name: "drive", value: -48.3, label: "DRIVE", magnitude: "48", color: "flow" },
    { name: "regen", value: 8, label: "REGEN", magnitude: "8.0", color: "good" },
    { name: "small-regen", value: 0.2, label: "REGEN", magnitude: "0.2", color: "good" },
    { name: "small-drive", value: -0.2, label: "DRIVE", magnitude: "0.2", color: "flow" },
    { name: "zero", value: 0, label: "POWER", magnitude: "0.0", color: "fg" },
    { name: "rounded-zero", value: -0.01, label: "POWER", magnitude: "0.0", color: "fg" },
    { name: "charging", value: 15, label: "CHARGING", magnitude: "15", color: "good", charging: true },
    {
      name: "charge-power-out",
      value: -5,
      label: "POWER OUT",
      magnitude: "5.0",
      color: "flow",
      charging: true,
      parked: true,
    },
    { name: "parked-power-out", value: -0.2, label: "POWER OUT", magnitude: "0.2", color: "flow", parked: true },
  ];
  for (const state of cases) {
    await openPreview(
      page,
      file,
      "#ride",
      `power-words-${theme}-${state.name}`,
      state.charging ? "&ride-state=charging" : ""
    );
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pushPatch({pack_kw:[${state.value},'kW','battery'],pack_a:[${(state.value * 1000) / 340},'A','battery']${state.parked ? ",gps_speed_kmh:[0,'km/h','gps'],speed_can_kmh:[0,'km/h','drive']" : ""}})`
    );
    await evaluateOnPage(page, FRAME);
    const actual = (await evaluateOnPage(
      page,
      `(() => {
      const label=document.querySelector('[data-power-direction]');
      const number=document.querySelector('.ride-kilowatts');
      return {label:label.textContent,magnitude:number.querySelector('[data-signal=pack_kw]').textContent,labelInk:label.style.color,numberInk:number.style.color,accessible:document.querySelector('.power-edge').getAttribute('aria-label'),status:document.querySelector('.ride-power-status').textContent};
    })()`
    )) as { label: string; magnitude: string; labelInk: string; numberInk: string; accessible: string; status: string };
    assert.equal(actual.label, state.label, `${state.name}: explicit direction`);
    assert.equal(actual.magnitude, state.magnitude, `${state.name}: unsigned magnitude and no negative zero`);
    assert.equal(actual.labelInk, `var(--${state.color})`, `${state.name}: direction colours include small readings`);
    assert.equal(actual.numberInk, actual.labelInk);
    assert.ok(
      actual.accessible.includes(`${state.label} ${state.magnitude} kW`),
      "The accessible label must name the same direction and magnitude."
    );
    if (state.name === "charge-power-out") {
      assert.equal(actual.status, "Power out · riding limits off");
    }
    await assertLayout(page);
    if (capture && ["drive", "regen", "zero"].includes(state.name)) {
      await waitOnPage(
        page,
        "!!document.querySelector('.ride-trace svg polyline')",
        "populated real trace before the full-screen capture"
      );
      await assertLayout(page);
      await capture(`${state.name}-${theme}`);
    }
  }
}
