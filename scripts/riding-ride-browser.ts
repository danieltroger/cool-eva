import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function assertRideContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "!!document.querySelector('.ride-trace svg polyline')",
    "populated ten-minute trace on its real chart tick"
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `[...document.querySelectorAll('.ride-view [data-signal]')].map(element=>[element.dataset.signal,element.textContent])`
    ),
    [
      ["gps_speed_kmh", "87"],
      ["pack_kw", "48"],
      ["soc", "46%"],
      ["batt_temp_lo", "38"],
      ["batt_temp_hi", "41"],
      ["motor_temp_c", "65"],
      ["bike_coolant_temp", "67"],
    ],
    "Every required Ride reading must render."
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-reading=coolant-delta]').textContent.includes('4.70')"),
    true
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-reading=resistance-heat]').textContent"),
    "1.47"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-reading=loop-removal]').textContent"), "4.43");
  assert.equal(
    await evaluateOnPage(
      page,
      "document.querySelector('.ride-heat').innerText.includes('3.1% of output · modelled R') && document.querySelector('.ride-heat').innerText.includes('Rated flow')"
    ),
    true
  );
  assert.equal(
    await evaluateOnPage(page, "!!document.querySelector('.ride-trace svg.polyline, .ride-trace svg polyline')"),
    true,
    "The ten-minute trace must actually draw populated history."
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `[...document.querySelectorAll('.ride-view [data-signal],.ride-view [data-reading]')].filter(element=>{
    if(element.getBoundingClientRect().width<=0 || element.getBoundingClientRect().height<=0)return true;
    for(let parent=element;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return true;}return false;
  }).map(element=>element.getAttribute('data-signal')||element.getAttribute('data-reading'))`
    ),
    [],
    "Hidden Ride content cannot buy a short screen."
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `[...document.querySelectorAll('.ride-power,.ride-delta,.ride-heat,.ride-pair')].map(element=>element.getBoundingClientRect().height)`
    ),
    [176, 144, 132, 104]
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `[parseFloat(getComputedStyle(document.querySelector('.ride-speed')).fontSize),parseFloat(getComputedStyle(document.querySelector('.ride-kilowatts')).fontSize),parseFloat(getComputedStyle(document.querySelector('.ride-speed .hero-unit')).fontSize),document.querySelector('.ride-trace').getBoundingClientRect().height,document.querySelector('.ride-view').getBoundingClientRect().height]`
    ),
    [64, 34.4, 17.6, 40, 596]
  );
  await assertEdge(page, 2, 0);
}

export async function checkRideBrowser(
  page: HeadlessPage,
  file: string,
  assertLayout: (page: HeadlessPage) => Promise<void>,
  theme: string
) {
  const cases = [
    {
      name: "full-ceilings",
      patch: "allowed_discharge_a:[400,'A','battery'],allowed_regen_a:[120,'A','battery']",
      ticks: 2,
      unknown: 0,
    },
    {
      name: "charging-fault",
      patch: "pack_kw:[-999,'kW','battery']",
      ticks: 0,
      unknown: 0,
      status: "Charging · power fault · riding limits off",
      side: "none",
    },
    { name: "drive", patch: "pack_kw:[-48.3,'kW','battery']", ticks: 2, unknown: 0, side: "right" },
    {
      name: "regen",
      patch: "pack_kw:[8,'kW','battery'],pack_a:[8000/340,'A','battery']",
      ticks: 2,
      unknown: 0,
      side: "left",
    },
    { name: "zero", patch: "pack_kw:[0,'kW','battery'],pack_a:[0,'A','battery']", ticks: 2, unknown: 0, side: "none" },
    {
      name: "zero-limit",
      patch: "allowed_discharge_a:[0,'A','battery']",
      ticks: 2,
      unknown: 0,
      status: "Over drive limit",
    },
    { name: "over", patch: "allowed_discharge_a:[50,'A','battery']", ticks: 2, unknown: 0, status: "Over drive limit" },
    {
      name: "regen-over",
      patch: "pack_kw:[8,'kW','battery'],allowed_regen_a:[10,'A','battery']",
      ticks: 2,
      unknown: 0,
      status: "Over regen limit",
      side: "left",
    },
    {
      name: "regen-off-scale",
      patch: "pack_kw:[45,'kW','battery'],pack_a:[45000/340,'A','battery']",
      ticks: 2,
      unknown: 0,
      status: "Over regen limit",
      side: "left",
    },
    {
      name: "off-scale",
      patch: "pack_kw:[-170,'kW','battery'],pack_a:[-500,'A','battery']",
      ticks: 2,
      unknown: 0,
      status: "Over drive limit",
    },
    { name: "missing-limit", clear: "allowed_discharge_a", ticks: 1, unknown: 1, status: "Drive limit unavailable" },
    {
      name: "stale-limit",
      patch: "allowed_discharge_a:[210,'A','battery',Date.now()-30_000]",
      ticks: 1,
      unknown: 1,
      status: "Drive limit stale",
    },
    {
      name: "fault-limit",
      patch: "allowed_discharge_a:[10000,'A','battery']",
      ticks: 1,
      unknown: 1,
      status: "Drive limit fault",
    },
    {
      name: "power-stale",
      patch: "pack_kw:[-48.3,'kW','battery',Date.now()-30_000]",
      ticks: 2,
      unknown: 0,
      status: "Power stale",
      side: "none",
    },
    {
      name: "power-fault",
      patch: "pack_kw:[-999,'kW','battery']",
      ticks: 2,
      unknown: 0,
      status: "Power fault",
      side: "none",
    },
    { name: "power-missing", clear: "pack_kw", ticks: 2, unknown: 0, status: "Power unavailable", side: "none" },
    {
      name: "charging",
      patch: "pack_kw:[15,'kW','battery'],fast_dc_contactor:[1,'','charge'],charge_manager_state:[35,'','charge']",
      ticks: 0,
      unknown: 0,
      status: "Charging · riding limits off",
      side: "none",
    },
  ];
  for (const state of cases) {
    await openPreview(
      page,
      file,
      "#ride",
      `power-${state.name}-${theme}`,
      state.name.startsWith("charging") ? "&ride-state=charging" : ""
    );
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    if (state.patch) {
      await evaluateOnPage(page, `pushPatch({${state.patch}})`);
    }
    if (state.clear) {
      await evaluateOnPage(page, `ridingPreview('lib/store.js').signalState(${JSON.stringify(state.clear)}).val=null`);
    }
    await evaluateOnPage(page, FRAME);
    await assertEdge(page, state.ticks, state.unknown);
    if (state.status) {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('.ride-power-status').textContent"),
        state.status
      );
    }
    if (state.side) {
      const fill = await evaluateOnPage(
        page,
        `(() => {const fill=document.querySelector('[data-layer=measured]');if(!fill)return 'none';const x=parseFloat(fill.getAttribute('x'));return Math.abs(x-36/166*100)<0.00001?'right':'left';})()`
      );
      assert.equal(fill, state.side, "Negative pack power drives right; positive riding power regenerates left.");
      if (state.side !== "none") {
        assert.equal(
          await evaluateOnPage(page, "document.querySelector('[data-layer=measured]').style.fill"),
          state.side === "right" ? "var(--flow)" : "var(--good)",
          "The actual Edge must paint drive blue and regen green."
        );
      }
    }
    if (state.status?.startsWith("Over")) {
      assert.equal(
        await evaluateOnPage(
          page,
          "document.querySelector('[data-layer=excess]').style.fill==='var(--bad)' && !!document.querySelector('[data-layer=excess-hatch]')"
        ),
        true,
        "Excess must remain visible as bad-ink hatching."
      );
    }
    if (state.name === "zero") {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-signal=pack_kw]').textContent"),
        "0.0",
        "Measured zero must remain a reading."
      );
    }
    if (state.name.endsWith("off-scale")) {
      assert.equal(await evaluateOnPage(page, "!!document.querySelector('[data-layer=off-scale]')"), true);
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-layer=off-scale]').getAttribute('x')"),
        state.name === "regen-off-scale" ? "0%" : "100%"
      );
      assert.equal(
        await evaluateOnPage(
          page,
          "[...document.querySelectorAll('[data-layer=off-scale] path')].some(path=>path.style.stroke==='var(--fg)')"
        ),
        true,
        "The end arrow must remain visible over bad-ink excess."
      );
    }
    if (state.unknown) {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-layer=ceiling]').dataset.side"),
        "regen",
        "A fresh opposite limit must remain visible."
      );
    }
    await assertLayout(page);
  }
  for (const condition of ["imperial", "coolant-fault", "coolant-stale", "temperature-fault", "missing-voltage"]) {
    await openPreview(page, file, "#ride", `${condition}-${theme}`);
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    if (condition.startsWith("coolant-")) {
      await waitOnPage(
        page,
        "document.querySelector('.ride-trace').dataset.trace==='available'",
        "a live trace before its input fails"
      );
    }
    if (condition === "imperial") {
      await evaluateOnPage(page, "ridingPreview('lib/units.js').unitSystem.val='imperial'");
    }
    if (condition === "coolant-fault") {
      await evaluateOnPage(page, "pushPatch({coolant_in:[-242,'°C','coolant']})");
    }
    if (condition === "coolant-stale") {
      await evaluateOnPage(page, "pushPatch({coolant_in:[36.5,'°C','coolant',Date.now()-30_000]})");
    }
    if (condition === "temperature-fault") {
      await evaluateOnPage(
        page,
        "pushPatch({batt_temp_lo:[-999,'°C','battery'],batt_temp_hi:[999,'°C','battery'],motor_temp_c:[999,'°C','motor'],bike_coolant_temp:[999,'°C','obd']})"
      );
    }
    if (condition === "missing-voltage") {
      await evaluateOnPage(page, "ridingPreview('lib/store.js').signalState('pack_v').val=null");
    }
    await evaluateOnPage(page, FRAME);
    if (condition === "missing-voltage") {
      await assertEdge(page, 0, 2);
    }
    if (condition.startsWith("coolant-")) {
      await waitOnPage(
        page,
        "document.querySelector('.ride-trace').dataset.trace==='unavailable'",
        "failed trace suppressed on the chart tick"
      );
      assert.equal(await evaluateOnPage(page, "document.querySelector('.ride-trace').dataset.trace"), "unavailable");
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-reading=loop-removal]').textContent"),
        condition === "coolant-fault" ? "fault" : "stale"
      );
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-reading=resistance-heat]').textContent"),
        "1.47"
      );
    }
    await assertLayout(page);
  }
}

export async function checkRideZero(
  page: HeadlessPage,
  file: string,
  assertLayout: (page: HeadlessPage) => Promise<void>,
  theme: string
) {
  await openPreview(page, file, "#ride", `zero-dpr1-${theme}`);
  await evaluateOnPage(
    page,
    `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pushPatch({pack_kw:[0,'kW','battery'],pack_a:[0,'A','battery']})`
  );
  await evaluateOnPage(page, FRAME);
  await assertEdge(page, 2, 0);
  await assertLayout(page);
}

async function assertEdge(page: HeadlessPage, ticks: number, unknown: number) {
  const result = (await evaluateOnPage(
    page,
    `(() => {const edge=document.querySelector('.power-edge');const gap=edge.querySelector('[data-layer=zero-gap]');const box=edge.getBoundingClientRect();const gapBox=gap.getBoundingClientRect();const layers=[...edge.querySelectorAll('[data-layer]')].map(element=>element.getAttribute('data-layer')).filter(Boolean);const gapAt=layers.indexOf('zero-gap');const foreground=getComputedStyle(document.body).color;return {charging:edge.getAttribute('data-charging')==='true',outerRadius:parseFloat(getComputedStyle(edge).borderBottomLeftRadius),bandRadius:parseFloat(getComputedStyle(edge.querySelector('.power-band')).borderBottomLeftRadius),bandClip:getComputedStyle(edge.querySelector('.power-band')).clipPath,paint:layers[0]==='base'&&gapAt>=0&&layers.slice(gapAt+1).every((name,index)=>name===(index%2===0?'ceiling-halo':'ceiling')),ticks:edge.querySelectorAll('[data-layer=ceiling]').length,unknown:edge.querySelectorAll('[data-layer=unknown]').length,height:box.height,gapWidth:gapBox.width,gapHeight:gapBox.height,origin:(gapBox.left+gapBox.width/2-box.left)/box.width,strayForeground:[...edge.querySelectorAll('*')].filter(element=>{const style=getComputedStyle(element);return ([style.fill,style.stroke].includes(foreground)||[element.getAttribute('fill'),element.getAttribute('stroke'),element.style.fill,element.style.stroke].some(paint=>paint?.includes('--fg')))&&!element.closest('[data-layer=ceiling],[data-layer=off-scale]');}).length,partial:[...edge.querySelectorAll('line')].some(line=>line.style.stroke==='var(--fg)'&&(line.getAttribute('y1')!=='0'||line.getAttribute('y2')!=='20'||line.getAttribute('stroke-width')!=='2')),dash:[...edge.querySelectorAll('[data-layer=unknown]')].every(line=>line.getAttribute('stroke-dasharray')==='4 4'&&line.getAttribute('stroke-width')==='2'),legend:/Regen max|Drive max/.test(document.querySelector('.ride-view').innerText),accessible:edge.getAttribute('aria-label')};})()`
  )) as {
    charging: boolean;
    outerRadius: number;
    bandRadius: number;
    bandClip: string;
    paint: boolean;
    ticks: number;
    unknown: number;
    height: number;
    gapWidth: number;
    gapHeight: number;
    origin: number;
    partial: boolean;
    strayForeground: number;
    dash: boolean;
    legend: boolean;
    accessible: string;
  };
  assert.equal(result.ticks, ticks, "Fresh ceilings must remain marked; unknown ceilings must not be invented.");
  assert.equal(result.unknown, unknown, "Unknown sides need the dashed neutral centreline.");
  assert.equal(result.outerRadius, 0, "Full-height ceiling ticks must not be shortened by rounded clipping.");
  assert.equal(result.bandRadius, 13);
  assert.equal(
    result.bandClip,
    "inset(0px round 0px 0px 13px 13px)",
    "The SVG band must actually clip to the tile corners."
  );
  assert.equal(result.height, 20);
  assert.equal(result.gapWidth, 2);
  assert.equal(result.gapHeight, 18);
  assert.ok(
    Math.abs(result.origin - 36 / 166) < 0.00001,
    "Zero must use the same fixed 36/166 origin as every segment."
  );
  assert.equal(result.partial, false, "No bright partial zero stroke or thin ceiling ticks.");
  assert.equal(result.strayForeground, 0, "Only ceiling and off-scale children may paint foreground ink in the Edge.");
  assert.equal(
    result.paint,
    true,
    "Capacity and measured fill precede the uniform zero gap; ceiling ticks paint last."
  );
  assert.equal(result.dash, true);
  assert.equal(result.legend, false);
  assert.ok(result.accessible.includes(result.charging ? "inactive" : "36 kW regen, 130 kW drive"));
}
