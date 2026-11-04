import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { assertRendered } from "./riding-layout-browser.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function assertChargeContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "document.querySelector('[data-ceiling]')?.dataset.ceiling==='36'&&(document.querySelector('[data-charge-eta]')?.textContent??'').includes(':')",
    "the complete warm Charge fixture, graph and ETA"
  );
  await assertRendered(page, [
    "[data-charge-soc]",
    "[data-charge-power]",
    "[data-charge-direction]",
    "[data-charge-electrical]",
    "[data-charge-eta]",
    ".charge-ceiling",
    ".charge-chart",
    "[data-charge-context]",
    "[data-charge-reports]",
    ".charge-model-caveat",
    ".charge-controller-summary",
    "[data-charge-action=stop]",
  ]);
  const content = await evaluateOnPage(
    page,
    `({soc:document.querySelector('[data-charge-soc]').textContent,power:document.querySelector('[data-charge-power]').textContent,direction:document.querySelector('[data-charge-direction]').textContent,electrical:document.querySelector('[data-charge-electrical]').textContent,window:document.querySelector('[data-window]').dataset.window,context:document.querySelector('[data-charge-context]').textContent,reports:document.querySelector('[data-charge-reports]').textContent,heights:[...document.querySelector('.charge-view').children].map(element=>element.getBoundingClientRect().height),height:document.querySelector('.charge-view').getBoundingClientRect().height,fonts:[getComputedStyle(document.querySelector('.charge-soc-number')).fontSize,getComputedStyle(document.querySelector('.charge-delivery .value')).fontSize,getComputedStyle(document.querySelector('.charge-ceiling')).fontSize,getComputedStyle(document.querySelector('.charge-chart')).fontSize],chartHeight:document.querySelector('.charge-chart').getBoundingClientRect().height,footer:[...document.querySelector('.charge-graph-footer').children].map(element=>element.getBoundingClientRect().height),caveats:document.body.innerText.split('Observed on Energica models except the Experia').length-1})`
  );
  assert.deepEqual(content, {
    soc: "62",
    power: "11",
    direction: "CHARGING",
    electrical: "32 A · 358 V",
    window: "15,65",
    context: "Outside 28 °C · battery 43–47 °C",
    reports: "Bike sees ○43 / ◆47 °C → 36 A",
    heights: [44, 124, 80, 272, 80],
    height: 648,
    fonts: ["64px", "34.4px", "30px", "12.5px"],
    chartHeight: 110,
    footer: [16, 16, 16, 16, 16],
    caveats: 1,
  });
  await assertGraphBounds(page);
  assert.equal(await evaluateOnPage(page, "document.querySelectorAll('[data-charge-action=stop]').length"), 1);
  assert.equal(
    await evaluateOnPage(
      page,
      "document.querySelector('.charge-graph').innerText.includes('Bike sees below 0 °C: near zero allowance.')"
    ),
    true
  );
  const markers = (await evaluateOnPage(
    page,
    `[...document.querySelectorAll('[data-reported-marker]')].map(marker=>marker.tagName==='circle'?[Number(marker.getAttribute('cx')),Number(marker.getAttribute('cy'))]:marker.getAttribute('points').split(' ').map(pair=>pair.split(',').map(Number)).reduce((result,point)=>[result[0]+point[0]/4,result[1]+point[1]/4],[0,0]))`
  )) as number[][];
  for (const [index, expected] of [
    [0, [199.76, 45.76]],
    [1, [223.44, 53.44]],
  ] as const) {
    assert.ok(
      Math.abs(markers[index][0] - expected[0]) < 1e-6 && Math.abs(markers[index][1] - expected[1]) < 1e-6,
      "Markers use the reported temperatures and exact capped allowance."
    );
  }
}

export async function assertGraphBounds(page: HeadlessPage) {
  const result = await evaluateOnPage(
    page,
    `(()=>{const chart=document.querySelector('.charge-chart');const bounds=chart.getBoundingClientRect();const text=[...chart.querySelectorAll('text')].map(element=>({text:element.textContent,box:element.getBoundingClientRect()}));return {curve:Number(chart.querySelector('[data-curve]').getAttribute('stroke-width')),plot:Math.abs(Number(chart.querySelectorAll('line')[0].getAttribute('y1'))-Number(chart.querySelectorAll('line')[2].getAttribute('y1'))),outside:text.filter(element=>element.box.left<bounds.left-.1||element.box.right>bounds.right+.1||element.box.top<bounds.top-.1||element.box.bottom>bounds.bottom+.1).map(element=>element.text),overlap:text.filter((element,index)=>text.slice(index+1).some(other=>Math.abs(element.box.top-other.box.top)<2&&element.box.left<other.box.right&&element.box.right>other.box.left)).map(element=>element.text)};})()`
  );
  assert.deepEqual(
    result,
    { curve: 3, plot: 72, outside: [], overlap: [] },
    "Curve, ticks and labels retain their actual sizes without cropping or overlaps."
  );
}

export async function checkChargeCases(
  page: HeadlessPage,
  file: string,
  assertLayout: (page: HeadlessPage) => Promise<void>,
  theme: string
) {
  for (const state of [
    { name: "cold", ceiling: "25.4", window: "-15,20" },
    { name: "custom", ceiling: "75", window: "15,60" },
    { name: "unknown", ceiling: "unknown", window: "-30,65" },
    { name: "outside-missing", ceiling: "36", window: "-30,65" },
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
        await evaluateOnPage(page, "document.querySelector('[data-charge-context]').textContent"),
        "Outside 28 °C · battery 43–47 °C"
      );
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-charge-reports]').textContent"),
        "Bike sees ○33 / ◆33 °C → 75 A"
      );
      assert.equal(
        await evaluateOnPage(
          page,
          `(()=>{const circle=document.querySelector('circle[data-reported-marker]');const points=document.querySelector('polygon[data-reported-marker]').getAttribute('points').split(' ').map(pair=>pair.split(',').map(Number));return Math.abs(Number(circle.getAttribute('cx'))-points.reduce((sum,point)=>sum+point[0]/4,0))<1e-9;})()`
        ),
        true,
        "Coincident markers must share the true coordinate."
      );
    }
    if (state.name === "unknown") {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-curve]').getAttribute('stroke-dasharray')"),
        "5 4"
      );
      assert.equal(await evaluateOnPage(page, "document.querySelectorAll('[data-reported-marker]').length"), 0);
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('.charge-graph').innerText.includes('No ceiling inferred')"),
        true
      );
    }
    await assertGraphBounds(page);
    await assertLayout(page);
  }
  const failures = [
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
    { name: "physical-fault", patch: "batt_temp_hi:[65535,'°C','battery']", ceiling: "36", text: "fault" },
    { name: "off-curve", patch: "batt_temp_hi_vcu:[70,'°C','battery']", ceiling: "unknown", text: "off curve" },
    { name: "small-power-out", patch: "pack_kw:[-0.2,'kW','battery']", ceiling: "36", direction: "POWER OUT" },
    {
      name: "power-stale",
      patch: "pack_kw:[11.456,'kW','battery',Date.now()-30_000]",
      ceiling: "36",
      direction: "POWER",
      power: "stale",
    },
    { name: "power-fault", patch: "pack_kw:[65535,'kW','battery']", ceiling: "36", direction: "POWER", power: "fault" },
    { name: "zero-power", patch: "pack_kw:[-0.01,'kW','battery']", ceiling: "36", direction: "POWER", power: "0.0" },
  ];
  for (const state of failures) {
    await openPreview(page, file, "#charge", `charge-${theme}-${state.name}`, "&charge-scene=warm");
    await assertChargeContent(page);
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pushPatch({${state.patch}})`
    );
    await evaluateOnPage(page, "pausePreviewMessages(true);ridingPreview('lib/store.js').chartTick.val++");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-ceiling]').dataset.ceiling"),
      state.ceiling,
      state.name
    );
    if (state.text) {
      assert.ok(
        String(await evaluateOnPage(page, "document.querySelector('.charge-graph').innerText")).includes(state.text),
        state.name
      );
    }
    if (state.direction) {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-charge-direction]').textContent"),
        state.direction
      );
      const color =
        state.direction === "POWER OUT"
          ? "flow"
          : state.power === "fault"
            ? "bad"
            : state.power === "0.0"
              ? "fg"
              : "sub";
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-charge-direction]').style.color"),
        `var(--${color})`
      );
    }
    if (state.power) {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-charge-power]').textContent"),
        state.power
      );
    }
    await assertGraphBounds(page);
    await assertLayout(page);
  }
  await openPreview(page, file, "#charge", `charge-${theme}-imperial`, "&charge-scene=warm");
  await assertChargeContent(page);
  await evaluateOnPage(
    page,
    "ridingPreview('lib/units.js').unitSystem.val='imperial';ridingPreview('lib/store.js').chartTick.val++"
  );
  await evaluateOnPage(page, FRAME);
  await assertGraphBounds(page);
  await assertLayout(page);
}
