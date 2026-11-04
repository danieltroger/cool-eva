import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function assertRangeContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "/^\\d+$/.test(document.querySelector('[data-reading=consumption]')?.textContent??'')",
    "populated rolling-consumption history"
  );
  const content = (await evaluateOnPage(
    page,
    `(() => {
    const view=document.querySelector('.range-view');const field=name=>view.querySelector('[data-reading="'+name+'"]').textContent;
    return {labels:[...view.querySelectorAll('.label')].map(element=>element.textContent),margin:field('margin'),rest:field('rest-sag'),cutoff:field('cutoff'),timer:field('dwell'),drive:field('allowed_discharge_a'),regen:field('allowed_regen_a'),energy:field('energy'),spread:field('spread'),horizon:field('consumption-horizon'),shares:[...view.querySelectorAll('.range-share')].map(element=>element.textContent),sizes:[...view.querySelectorAll(':scope > .range-margin,:scope > .range-timer,:scope > .range-pair,:scope > .range-consumption')].map(element=>element.getBoundingClientRect().height),height:view.getBoundingClientRect().height,fonts:[getComputedStyle(view.querySelector('.range-margin-number')).fontSize,getComputedStyle(view.querySelector('.range-allowance .value')).fontSize,getComputedStyle(view.querySelector('.range-share')).fontSize],bars:[...view.querySelectorAll('.range-availability')].map(element=>({height:element.getBoundingClientRect().height,state:element.dataset.state,width:parseFloat(element.firstElementChild.style.width)})),hidden:[...view.querySelectorAll('[data-reading]')].filter(element=>{if(element.getBoundingClientRect().width<=0||element.getBoundingClientRect().height<=0)return true;for(let parent=element;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return true;}return false;}).map(element=>element.dataset.reading),instantPower:!!view.querySelector('[data-signal=pack_kw]')};
  })()`
  )) as {
    labels: string[];
    margin: string;
    rest: string;
    cutoff: string;
    timer: string;
    drive: string;
    regen: string;
    energy: string;
    spread: string;
    horizon: string;
    shares: string[];
    sizes: number[];
    height: number;
    fonts: string[];
    bars: { height: number; state: string; width: number }[];
    hidden: string[];
    instantPower: boolean;
  };
  assert.deepEqual(content.labels, [
    "Weakest cell above cut-off",
    "Estimated cut-off timer",
    "Drive current",
    "Regen current",
    "Rolling consumption",
    "Energy left",
    "Cell spread",
  ]);
  assert.equal(content.margin, "120");
  assert.match(content.rest, /\d+ mV at rest · \d+ mV sag/);
  assert.ok(content.cutoff.includes("3000 mV") && content.cutoff.includes("modelled R"));
  assert.equal(content.timer, "clear");
  assert.equal(content.drive, "210");
  assert.equal(content.regen, "55");
  assert.equal(content.energy, "4.8");
  assert.equal(content.spread, "38");
  assert.match(content.horizon, /Last [\d.]+ km · about \d+ km left at this rate/);
  assert.deepEqual(content.shares, ["53% of 400 A", "46% of 120 A"]);
  assert.deepEqual(content.sizes, [140, 96, 112, 108, 92]);
  assert.equal(content.height, 648);
  assert.deepEqual(content.fonts, ["64px", "34.4px", "16px"]);
  assert.deepEqual(
    content.bars.map(bar => [bar.height, bar.state]),
    [
      [8, "fresh"],
      [8, "fresh"],
    ]
  );
  assert.ok(
    Math.abs(content.bars[0].width - 52.5) < 0.001 && Math.abs(content.bars[1].width - (55 / 120) * 100) < 0.001
  );
  assert.deepEqual(content.hidden, [], "No required Range reading may be omitted or hidden.");
  assert.equal(content.instantPower, false, "Range has no instantaneous pack-kW readout.");
}

export async function checkRangeCases(
  page: HeadlessPage,
  file: string,
  assertLayout: (page: HeadlessPage) => Promise<void>,
  theme: string
) {
  const cases = [
    {
      name: "zero-drive",
      patch: "allowed_discharge_a:[0,'A','battery']",
      field: "allowed_discharge_a",
      text: "0",
      state: "fresh",
    },
    {
      name: "zero-regen",
      patch: "allowed_regen_a:[0,'A','battery']",
      field: "allowed_regen_a",
      text: "0",
      state: "fresh",
    },
    {
      name: "stale-drive",
      patch: "allowed_discharge_a:[210,'A','battery',Date.now()-30_000]",
      field: "allowed_discharge_a",
      text: "stale",
      state: "stale",
    },
    {
      name: "fault-regen",
      patch: "allowed_regen_a:[65535,'A','battery']",
      field: "allowed_regen_a",
      text: "fault",
      state: "fault",
    },
    { name: "missing-cutoff", clear: "cell_cutoff_mv", field: "dwell", text: "—" },
    {
      name: "fault-cell-identity",
      patch: "cell_lowest_v_idx:[NaN,'','cells']",
      field: "cutoff",
      text: "Cut-off 3000 mV · cell fault · modelled R",
    },
    {
      name: "stale-cell-identity",
      patch: "cell_lowest_v_idx:[1,'','cells',Date.now()-30_000]",
      field: "cutoff",
      text: "Cut-off 3000 mV · cell stale · modelled R",
    },
    {
      name: "missing-cell-identity",
      clear: "cell_lowest_v_idx",
      field: "cutoff",
      text: "Cut-off 3000 mV · cell — · modelled R",
    },
    { name: "fault-minimum", patch: "cell_min_mv:[65535,'mV','battery']", field: "margin", text: "fault" },
    {
      name: "stale-current",
      patch: "pack_a:[-142,'A','battery',Date.now()-30_000]",
      field: "rest-sag",
      text: "Rest/sag stale",
    },
    { name: "energy-fault", patch: "bms_remaining_energy_wh:[-1,'Wh','battery']", field: "energy", text: "fault" },
    { name: "spread-fault", patch: "cell_spread_mv:[65535,'mV','battery']", field: "spread", text: "fault" },
  ];
  for (const state of cases) {
    await openPreview(page, file, "#hypermile", `range-${theme}-${state.name}`);
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    if (state.patch) {
      await evaluateOnPage(page, `pushPatch({${state.patch}})`);
    }
    await evaluateOnPage(page, "pausePreviewMessages(true)");
    if (state.clear) {
      await evaluateOnPage(page, `ridingPreview('lib/store.js').signalState(${JSON.stringify(state.clear)}).val=null`);
    }
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, `document.querySelector('[data-reading="${state.field}"]').textContent`),
      state.text
    );
    if (state.state) {
      assert.equal(
        await evaluateOnPage(page, `document.querySelector('[data-allowance="${state.field}"]').dataset.state`),
        state.state
      );
      if (state.state === "fresh") {
        assert.equal(
          await evaluateOnPage(page, `document.querySelector('[data-allowance="${state.field}"] > div').style.width`),
          "0%"
        );
      } else {
        assert.equal(
          await evaluateOnPage(page, `document.querySelector('[data-allowance="${state.field}"]').children.length`),
          0,
          "Unknown is not a known zero allowance."
        );
      }
    }
    await assertLayout(page);
  }
  await openPreview(page, file, "#hypermile", `range-${theme}-imperial`);
  await evaluateOnPage(
    page,
    `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};ridingPreview('lib/units.js').unitSystem.val='imperial'`
  );
  await evaluateOnPage(page, FRAME);
  await assertLayout(page);
  await openPreview(page, file, "#hypermile", `range-${theme}-waiting`, "&range-history=empty");
  await evaluateOnPage(
    page,
    `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};ridingPreview('lib/units.js').unitSystem.val='metric'`
  );
  await evaluateOnPage(page, FRAME);
  assert.match(
    (await evaluateOnPage(page, "document.querySelector('[data-reading=consumption-horizon]').textContent")) as string,
    /Needs about 200 m/
  );
  await assertLayout(page);
  await openPreview(page, file, "#hypermile", `range-${theme}-net-regen`, "&range-history=regen");
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-reading=consumption]').textContent"), "Regen");
  assert.equal(await evaluateOnPage(page, "document.querySelector('.range-consumption .unit').textContent"), "");
  await assertLayout(page);
  await openPreview(page, file, "#hypermile", `range-${theme}-dwell`);
  await evaluateOnPage(
    page,
    `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pushPatch({cell_min_mv:[2950,'mV','battery']})`
  );
  await waitOnPage(
    page,
    "/^\\d+ s$/.test(document.querySelector('[data-reading=dwell]').textContent)",
    "a real estimated cut-off countdown"
  );
  await assertLayout(page);
}
