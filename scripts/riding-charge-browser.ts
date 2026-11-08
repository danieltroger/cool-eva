import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { assertRendered } from "./riding-layout-browser.ts";
import { assertChargeLayout } from "./charge-page-layout.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function assertChargeContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "document.querySelector('[data-ceiling]')?.dataset.ceiling==='36'&&document.querySelector('[data-charge-eta]')?.textContent.includes('estimated')&&!document.querySelector('input[name=charge-soc-limit-pct]')?.disabled",
    "the complete single Charge page"
  );
  await assertRendered(page, [
    "[data-charge-soc]",
    "[data-charge-power]",
    "[data-charge-direction]",
    "[data-charge-electrical]",
    "[data-charge-eta]",
    ".charge-ceiling",
    ".charge-chart",
    "[data-charge-action=stop]",
    "input[name=charge-soc-limit-pct]",
    "input[name=charge-current-amps]",
    "[data-charge-action=automatic]",
  ]);
  const content = await evaluateOnPage(
    page,
    `({soc:document.querySelector('[data-charge-soc]').textContent,power:document.querySelector('[data-charge-power]').textContent,direction:document.querySelector('[data-charge-direction]').textContent,electrical:document.querySelector('[data-charge-electrical]').textContent,window:document.querySelector('[data-window]').dataset.window,heights:[document.querySelector('.charge-delivery').getBoundingClientRect().height,document.querySelector('.charge-eta').getBoundingClientRect().height],fonts:[...document.querySelectorAll('.charge-view .value')].map(element=>getComputedStyle(element).fontSize),inputs:[...document.querySelectorAll('.charge-input')].map(element=>[getComputedStyle(element).fontSize,element.value]),caption:document.querySelector('.charge-graph-content>.charge-sub').textContent})`
  );
  assert.deepEqual(content, {
    soc: "62",
    power: "11",
    direction: "DC charging",
    electrical: "32 A · 358 V",
    window: "18,57",
    heights: [112, 80],
    fonts: ["32px", "32px", "32px", "32px"],
    inputs: [
      ["16px", "90"],
      ["16px", "32"],
    ],
    caption: "Observed charge-current behaviour",
  });
  assert.equal(
    await evaluateOnPage(page, "document.querySelectorAll('.charge-view [data-charge-action=stop]').length"),
    1
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "!!document.querySelector('.charge-controller-summary,.charge-request-reply,.charge-pack-view,.charge-controls-view,.charge-model-caveat,.sub-tabs')"
    ),
    false
  );
  assert.equal(
    await evaluateOnPage(page, "document.scrollingElement.scrollHeight>innerHeight"),
    true,
    "The approved page intentionally scrolls to its inline controls."
  );
  await assertGraphBounds(page);
  await assertChargeLayout(page);
}

export async function assertGraphBounds(page: HeadlessPage) {
  const result = await evaluateOnPage(
    page,
    `(()=>{
    const chart=document.querySelector('.charge-chart');const bounds=chart.getBoundingClientRect();
    const text=[...chart.querySelectorAll('text')].map(element=>({text:element.textContent,box:element.getBoundingClientRect()}));
    return {viewBox:chart.getAttribute('viewBox'),curve:Number(chart.querySelector('[data-curve]').getAttribute('stroke-width')),plot:Math.abs(Number(chart.querySelectorAll('line')[0].getAttribute('y1'))-Number(chart.querySelectorAll('line')[2].getAttribute('y1'))),outside:text.filter(element=>element.box.left<bounds.left-.1||element.box.right>bounds.right+.1||element.box.top<bounds.top-.1||element.box.bottom>bounds.bottom+.1).map(element=>element.text),overlap:text.filter((element,index)=>text.slice(index+1).some(other=>Math.abs(element.box.top-other.box.top)<2&&element.box.left<other.box.right&&element.box.right>other.box.left)).map(element=>element.text)};
  })()`
  );
  assert.deepEqual(
    result,
    { viewBox: "0 0 342 132", curve: 3, plot: 84, outside: [], overlap: [] },
    "The real SVG labels fit without cropping or overlap."
  );
}

export async function checkChargeCases(
  page: HeadlessPage,
  file: string,
  _assertLayout: (page: HeadlessPage) => Promise<void>,
  theme: string
) {
  for (const state of [
    { name: "cold", ceiling: "25.4", window: "-15,17" },
    { name: "custom", ceiling: "75", window: "18,43" },
    { name: "unknown", ceiling: "unknown", window: "20,65" },
    { name: "outside-missing", ceiling: "36", window: "20,65" },
  ]) {
    await openPreview(page, file, "#charge", `charge-${theme}-${state.name}`, `&charge-scene=${state.name}`);
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    await waitOnPage(
      page,
      `document.querySelector('[data-ceiling]')?.dataset.ceiling===${JSON.stringify(state.ceiling)}&&document.querySelector('[data-window]')?.dataset.window===${JSON.stringify(state.window)}`,
      state.name
    );
    if (state.name === "custom") {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-reported-label=both]').textContent"),
        "33° · both"
      );
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('circle[data-reported-marker]').getAttribute('r')"),
        "7"
      );
    }
    if (state.name === "unknown") {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-curve]').getAttribute('stroke-dasharray')"),
        "5 4"
      );
      assert.equal(await evaluateOnPage(page, "document.querySelectorAll('[data-reported-marker]').length"), 0);
      assert.equal(
        await evaluateOnPage(
          page,
          "document.querySelector('.charge-graph').innerText.includes('Temperatures missing · reference window')"
        ),
        true
      );
    }
    await assertGraphBounds(page);
    await assertChargeLayout(page);
  }
  for (const state of [
    { name: "zero", patch: "batt_temp_lo_vcu:[65,'°C','battery'],batt_temp_hi_vcu:[65,'°C','battery']", ceiling: "0" },
    {
      name: "cold-governs",
      patch: "batt_temp_lo_vcu:[-20,'°C','battery'],batt_temp_hi_vcu:[47,'°C','battery']",
      ceiling: "1",
    },
    {
      name: "reported-stale",
      patch: "batt_temp_hi_vcu:[47,'°C','battery',Date.now()-30_000]",
      ceiling: "unknown",
      text: "stale",
    },
    { name: "reported-fault", patch: "batt_temp_hi_vcu:[65535,'°C','battery']", ceiling: "unknown", text: "fault" },
    { name: "physical-fault", patch: "batt_temp_hi:[65535,'°C','battery']", ceiling: "36" },
    { name: "limit-removed", patch: "charge_soc_limit_pct:[0,'%','charge']", ceiling: "36", eta: "Unavailable" },
    { name: "soc-fault", patch: "soc:[65535,'%','battery']", ceiling: "36", eta: "Unavailable", soc: "fault" },
    { name: "off-curve", patch: "batt_temp_hi_vcu:[70,'°C','battery']", ceiling: "unknown", text: "Unknown" },
    { name: "power-out", patch: "pack_kw:[-0.2,'kW','battery']", ceiling: "36", direction: "Power out", power: "0.2" },
    { name: "power-stale", patch: "pack_kw:[11.456,'kW','battery',Date.now()-30_000]", ceiling: "36", power: "stale" },
    { name: "power-fault", patch: "pack_kw:[65535,'kW','battery']", ceiling: "36", power: "fault" },
    { name: "zero-power", patch: "pack_kw:[-0.01,'kW','battery']", ceiling: "36", direction: "Power", power: "0.0" },
  ]) {
    await openPreview(page, file, "#charge", `charge-${theme}-${state.name}`, "&charge-scene=warm");
    await assertChargeContent(page);
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pushPatch({${state.patch}});pausePreviewMessages(true);ridingPreview('lib/store.js').chartTick.val++`
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-ceiling]').dataset.ceiling"),
      state.ceiling,
      state.name
    );
    if (state.text) {
      assert.ok(
        String(await evaluateOnPage(page, "document.querySelector('.charge-ceiling').textContent")).includes(
          state.text
        ),
        state.name
      );
    }
    if (state.eta) {
      assert.equal(await evaluateOnPage(page, "document.querySelector('[data-charge-eta]').textContent"), state.eta);
    }
    if (state.soc) {
      assert.equal(await evaluateOnPage(page, "document.querySelector('[data-charge-soc]').textContent"), state.soc);
    }
    if (state.direction) {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-charge-direction]').textContent"),
        state.direction
      );
    }
    if (state.power) {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-charge-power]').textContent"),
        state.power
      );
    }
    await assertGraphBounds(page);
    await assertChargeLayout(page);
  }
  await openPreview(page, file, "#charge", `charge-${theme}-imperial`, "&charge-scene=warm");
  await assertChargeContent(page);
  await evaluateOnPage(
    page,
    "ridingPreview('lib/units.js').unitSystem.val='imperial';ridingPreview('lib/store.js').chartTick.val++"
  );
  await evaluateOnPage(page, FRAME);
  await assertGraphBounds(page);
  await assertChargeLayout(page);
}
