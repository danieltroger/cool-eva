import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function assertRangeContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "['consumption','range-estimate'].every(name=>/^\\d+$/.test(document.querySelector('[data-reading='+name+']')?.textContent??''))",
    "populated rolling-consumption and range estimate"
  );
  const content = (await evaluateOnPage(
    page,
    `(() => {
    const view=document.querySelector('.range-view');const field=name=>view.querySelector('[data-reading="'+name+'"]').textContent;
    return {labels:[...view.querySelectorAll('.label')].map(element=>element.textContent),margin:field('margin'),explanations:!!view.querySelector('[data-reading=rest-sag],[data-reading=cutoff],.range-timer .sub,.range-rule')||/BMS index|modelled R|at rest|mV sag|allowed below cut-off|drains above/.test(view.innerText),timer:field('dwell'),drive:field('allowed_discharge_a'),regen:field('allowed_regen_a'),energy:field('energy'),range:field('range-estimate'),horizon:field('consumption-horizon'),shares:[...view.querySelectorAll('.range-share')].map(element=>element.textContent),sizes:[...view.querySelectorAll(':scope > .range-margin,:scope > .range-timer,:scope > .range-pair,:scope > .range-consumption')].map(element=>element.getBoundingClientRect().height),height:view.getBoundingClientRect().height,fonts:[getComputedStyle(view.querySelector('.range-margin-number')).fontSize,getComputedStyle(view.querySelector('.range-allowance .value')).fontSize,getComputedStyle(view.querySelector('.range-share')).fontSize],bars:[...view.querySelectorAll('.range-availability')].map(element=>({height:element.getBoundingClientRect().height,state:element.dataset.state,width:parseFloat(element.firstElementChild.style.width)})),hidden:[...view.querySelectorAll('[data-reading]')].filter(element=>{if(element.getBoundingClientRect().width<=0||element.getBoundingClientRect().height<=0)return true;for(let parent=element;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return true;}return false;}).map(element=>element.dataset.reading),instantPower:!!view.querySelector('[data-signal=pack_kw]')};
  })()`
  )) as {
    labels: string[];
    margin: string;
    explanations: boolean;
    timer: string;
    drive: string;
    regen: string;
    energy: string;
    range: string;
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
    "Drive allowed",
    "Regen available",
    "Rolling consumption",
    "Energy left",
    "Range at this rate",
  ]);
  assert.equal(content.margin, "120");
  assert.equal(content.explanations, false, "Range keeps derivation and provenance in the docs.");
  assert.equal(content.timer, "clear");
  assert.equal(content.drive, "210");
  assert.equal(content.regen, "55");
  assert.equal(content.energy, "4.8");
  assert.match(content.range, /^\d+$/);
  const valueTops = (await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.range-bottom .value')].map(element=>element.getBoundingClientRect().top)"
  )) as number[];
  assert.equal(valueTops[0], valueTops[1], "The approved Energy left and Range at this rate values align.");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.range-spread,[data-reading=spread]')"),
    null,
    "Cell spread has one home in Cells."
  );
  assert.match(content.horizon, /^Last [\d.]+ km$/);
  assert.deepEqual(content.shares, ["53% of 400 A", "46% of 120 A"]);
  assert.deepEqual(content.sizes, [112, 64, 112, 108, 92]);
  assert.equal(content.height, 536);
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
    { name: "fault-minimum", patch: "cell_min_mv:[65535,'mV','battery']", field: "margin", text: "fault" },
    { name: "energy-fault", patch: "bms_remaining_energy_wh:[-1,'Wh','battery']", field: "energy", text: "fault" },
    {
      name: "range-energy-fault",
      patch: "bms_remaining_energy_wh:[-1,'Wh','battery']",
      field: "range-estimate",
      text: "fault",
    },
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
    await evaluateOnPage(page, "ridingPreview('lib/store.js').chartTick.val++");
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
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-reading=range-estimate]').textContent"), "—");
  await assertLayout(page);
  await openPreview(page, file, "#hypermile", `range-${theme}-net-regen`, "&range-history=regen");
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-reading=consumption]').textContent"), "Regen");
  assert.equal(await evaluateOnPage(page, "document.querySelector('.range-consumption .unit').textContent"), "");
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-reading=range-estimate]').textContent"), "—");
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
