import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function assertRangeContent(page: HeadlessPage) {
  await waitOnPage(
    page,
    "['consumption','range-estimate'].every(name=>/^\\d+$/.test(document.querySelector('[data-reading='+name+']')?.textContent??''))",
    "populated rolling-consumption and range estimate"
  );
  await waitOnPage(page, "document.querySelector('[data-reading=margin]').textContent==='320'", "stored VCU limits");
  const content = (await evaluateOnPage(
    page,
    `(() => {
    const view=document.querySelector('.range-view');const field=name=>view.querySelector('[data-reading="'+name+'"]').textContent;
    return {labels:[...view.querySelectorAll('.label')].map(element=>element.textContent),margin:field('margin'),explanations:!!view.querySelector('[data-reading=rest-sag],[data-reading=cutoff],.range-timer .sub,.range-rule')||/BMS index|modelled R|at rest|mV sag|allowed below cut-off|drains above/.test(view.innerText),line:view.querySelector('.range-margin-number').innerText.replace(/\\s+/g,' '),drive:field('drive-allowed'),regen:field('allowed_regen_a'),energy:field('energy'),range:field('range-estimate'),horizon:field('consumption-horizon'),shares:[...view.querySelectorAll('.range-share')].map(element=>element.textContent),sizes:[...view.querySelectorAll(':scope > .range-margin,:scope > .range-timer,:scope > .range-pair,:scope > .range-consumption')].map(element=>element.getBoundingClientRect().height),height:view.getBoundingClientRect().height,fonts:[getComputedStyle(view.querySelector('.range-margin-number')).fontSize,getComputedStyle(view.querySelector('.range-allowance .value')).fontSize,getComputedStyle(view.querySelector('.range-share')).fontSize],bars:[...view.querySelectorAll('.range-availability')].map(element=>({height:element.getBoundingClientRect().height,state:element.dataset.state,width:parseFloat(element.firstElementChild.style.width)})),hidden:[...view.querySelectorAll('[data-reading]')].filter(element=>{if(element.getBoundingClientRect().width<=0||element.getBoundingClientRect().height<=0)return true;for(let parent=element;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return true;}return false;}).map(element=>element.dataset.reading),instantPower:!!view.querySelector('[data-signal=pack_kw]')};
  })()`
  )) as {
    labels: string[];
    margin: string;
    explanations: boolean;
    line: string;
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
    "Weakest cell",
    "Drive allowed",
    "Regen available",
    "Rolling consumption",
    "Energy left",
    "Range at this rate",
  ]);
  assert.equal(content.margin, "320");
  assert.equal(content.explanations, false, "Range keeps derivation and provenance in the docs.");
  assert.equal(content.line, "Limp in 170 mV · stop in 320 mV");
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
  assert.deepEqual(content.shares, ["≈ 71.4 kW", "≈ 18.7 kW"]);
  assert.deepEqual(content.sizes, [112, 112, 108, 92]);
  assert.equal(content.height, 464);
  assert.deepEqual(content.fonts, ["14px", "34.4px", "16px"]);
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
      field: "drive-allowed",
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
      field: "drive-allowed",
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
    { name: "fault-minimum", patch: "cell_min_mv:[65535,'mV','battery']", field: "margin", text: "fault" },
    { name: "energy-fault", patch: "bms_remaining_energy_wh:[-1,'Wh','battery']", field: "energy", text: "fault" },
    {
      name: "range-energy-fault",
      patch: "bms_remaining_energy_wh:[-1,'Wh','battery']",
      field: "range-estimate",
      text: "fault",
    },
    {
      "name": "vcu-drive",
      "patch": "go:[1,'','state'],current_max_out_a:[25,'A','inverter']",
      "field": "drive-allowed",
      "text": "25",
      "state": "fresh",
      "width": 6.25,
      "caption": "≈ 8.5 kW",
    },
    {
      "name": "empty",
      "patch": "soc:[0,'%','battery'],bms_remaining_energy_wh:[0,'Wh','battery'],residual_energy_wh:[0,'Wh','battery']",
      "field": "energy",
      "text": "Empty — charge now",
      "range": "Empty — charge now",
    },
    {
      "name": "limp-cell",
      "patch": "cell_min_mv:[2850,'mV','battery']",
      "field": "margin",
      "text": "50",
      "line": "Limp · stop in 50 mV",
      "range": "Range uncertain — charge now",
    },
    {
      "name": "uncertain-before-limp",
      "patch": "cell_min_mv:[3050,'mV','battery']",
      "field": "limp-margin",
      "text": "100",
      "line": "Limp in 100 mV · stop in 250 mV",
      "range": "Range uncertain — charge now",
    },
    {
      "name": "under-stop",
      "patch": "cell_min_mv:[2775,'mV','battery']",
      "field": "margin",
      "text": "25",
      "line": "Limp · 25 mV under stop",
    },
    {
      "name": "limits-not-read",
      "prepare": "ridingPreview('lib/service-client.js').serviceCatalogue.val=null",
      "field": "margin",
      "text": "VCU limits not read",
    },
    {
      name: "hard-pull",
      patch: "cell_min_mv:[2988,'mV','battery'],pack_a:[-377,'A','battery'],limp_pack_res:[132,'','vcu']",
      field: "limp-margin",
      text: "661",
      line: "Limp in 661 mV · stop in 803 mV",
    },
  ];
  for (const state of cases) {
    await openPreview(page, file, "#hypermile", `range-${theme}-${state.name}`);
    await waitOnPage(page, "document.querySelector('[data-reading=margin]').textContent==='320'", "stored VCU limits");
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    if (state.patch) {
      await evaluateOnPage(page, `pushPatch({${state.patch}})`);
    }
    await evaluateOnPage(page, "pausePreviewMessages(true)");
    if (state.prepare) {
      await evaluateOnPage(page, state.prepare);
    }
    await evaluateOnPage(page, "ridingPreview('lib/store.js').chartTick.val++");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, `document.querySelector('[data-reading="${state.field}"]').textContent`),
      state.text
    );
    if (state.line)
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('.range-margin-number').innerText.replace(/\\s+/g,' ')"),
        state.line
      );
    if (state.range)
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-reading=range-estimate]').textContent"),
        state.range
      );
    if (state.name === "limits-not-read" || state.name === "hard-pull")
      assert.match(
        String(await evaluateOnPage(page, "document.querySelector('[data-reading=range-estimate]').textContent")),
        /^\d+$/
      );
    if (state.caption)
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('[data-share=drive-allowed]').textContent"),
        state.caption
      );
    if (state.state) {
      assert.equal(
        await evaluateOnPage(page, `document.querySelector('[data-allowance="${state.field}"]').dataset.state`),
        state.state
      );
      if (state.state === "fresh") {
        assert.equal(
          await evaluateOnPage(
            page,
            `parseFloat(document.querySelector('[data-allowance="${state.field}"] > div').style.width)`
          ),
          state.width ?? 0
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
  await openPreview(page, file, "#hypermile", `range-${theme}-limits-read-on-open`);
  await waitOnPage(page, "document.querySelector('[data-reading=margin]').textContent==='320'", "stored VCU limits");
  const indexes = await evaluateOnPage(
    page,
    `(()=>{
    const client=ridingPreview('lib/service-client.js');
    const indexes=['LIMP_MIN_CELL','CELL_UNDERVOLTAGE'].map(name=>client.serviceCatalogue.rawVal.parameters.find(parameter=>parameter.name===name).index);
    ridingPreview('lib/router.js').showView('ride');
    SERVICE_PARAMETERS.params={state:'never-read',directory:'synthetic',hint:'synthetic'};
    SERVICE_PARAMETER_REQUESTS.length=0;GATE.safe=true;
    return indexes;
  })()`
  );
  await waitOnPage(page, "!!document.querySelector('.ride-view')", "leaving Range");
  await evaluateOnPage(page, "ridingPreview('lib/router.js').showView('hypermile')");
  await waitOnPage(
    page,
    "SERVICE_PARAMETER_REQUESTS.filter(request=>request.method==='POST'&&request.url.startsWith('/vcu-probe')).length===2&&document.querySelector('[data-reading=margin]').textContent==='320'",
    "two named limit reads on Range entry"
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "SERVICE_PARAMETER_REQUESTS.filter(request=>request.method==='POST'&&request.url.startsWith('/vcu-probe')).map(request=>Number(new URL(request.url,'http://eva.local').searchParams.get('index')))"
    ),
    indexes
  );
  await assertLayout(page);
}
