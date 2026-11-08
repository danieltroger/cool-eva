import assert from "node:assert/strict";
import { assertPowerBar } from "./ride-power-bar-browser.ts";
import { checkRideThermalBrowser } from "./riding-thermal-browser.ts";
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
      "!/modelled R|Rated flow|of output/.test(document.querySelector('.ride-view').innerText)"
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
      `[...document.querySelectorAll('.ride-power,.ride-temperature,.ride-delta,.ride-heat')].map(element=>element.getBoundingClientRect().height)`
    ),
    [224, 72, 160, 112]
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `[parseFloat(getComputedStyle(document.querySelector('.ride-speed')).fontSize),parseFloat(getComputedStyle(document.querySelector('.ride-kilowatts')).fontSize),parseFloat(getComputedStyle(document.querySelector('.ride-speed .hero-unit')).fontSize),document.querySelector('.ride-trace').getBoundingClientRect().height,document.querySelector('.ride-view').getBoundingClientRect().height]`
    ),
    [64, 32, 16, 48, 628]
  );
  await assertPowerBar(page, 2, 0);
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
      status: "GPS · wheel 89",
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
      status: "GPS · wheel 89",
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
    await assertPowerBar(page, state.ticks, state.unknown);
    if (state.status) {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('.ride-power-status').textContent"),
        state.status
      );
    }
    if (state.name.startsWith("charging")) {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('.ride-power-status').style.color"),
        "var(--sub)",
        "A hidden charging power fault cannot colour the GPS footer."
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
        await evaluateOnPage(page, "document.querySelector('[data-layer=excess]').style.fill==='var(--bad)'"),
        true,
        "Measured excess must retain fault ink."
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
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-signal=pack_kw]').textContent"),
        state.name === "regen-off-scale" ? "45" : "170",
        "The finite bar must not clamp the measured numeric value."
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
      await assertPowerBar(page, 0, 2);
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
  await checkRideThermalBrowser(page, file, theme);
  await assertLayout(page);
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
  await assertPowerBar(page, 2, 0);
  await assertLayout(page);
}
