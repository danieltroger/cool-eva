import { checkHistoryAndGestures } from "./riding-navigation-browser.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import assert from "node:assert/strict";
import { ROUTES } from "../public/lib/router.js";
import { evaluateOnPage, gotoPage, waitOnPage, resizePage, setPageInsets, type HeadlessPage } from "./headless-page.ts";

const COVERAGE = {
  ride: "legacy",
  cooling: "fixed",
  hypermile: "legacy",
  charge: "legacy",
  all: "scrolling",
  faults: "legacy",
} as const;
const COOLING_SIGNALS = [
  "coolant_in",
  "coolant_out",
  "batt_temp_lo",
  "batt_temp_hi",
  "motor_temp_c",
  "bike_coolant_temp",
  "ambient_temp",
  "fan_target_pct",
];
let minimumClearance = Infinity;

export async function checkRidingBrowser(page: HeadlessPage, previewFile: string): Promise<void> {
  minimumClearance = Infinity;
  assert.deepEqual(
    ROUTES.map(route => route.name).sort(),
    Object.keys(COVERAGE).sort(),
    "Every router view needs an acceptance contract."
  );
  assert.deepEqual(
    ROUTES.filter(route => route.fixed).map(route => route.name),
    ["cooling"]
  );
  for (const geometry of [
    { height: 844, top: 47 },
    { height: 797, top: 0 },
  ]) {
    await resizePage(page, { width: 390, height: geometry.height, deviceScaleFactor: 3, mobile: true });
    await setPageInsets(page, { top: geometry.top, bottom: 34, left: 0, right: 0 });
    for (const theme of ["dark", "light"]) {
      const visited = new Set<string>();
      for (const route of ROUTES) {
        await openPreview(page, previewFile, route.hash, `${geometry.height}-${theme}-${route.name}`);
        await evaluateOnPage(page, `ridingPreview("lib/theme.js").themePreference.val = ${JSON.stringify(theme)}`);
        await evaluateOnPage(page, FRAME);
        assert.equal(await evaluateOnPage(page, "ridingPreview('lib/router.js').currentView()"), route.name);
        await assertInsets(page, geometry.top, geometry.height);
        await assertPopulatedFixture(page);
        visited.add(route.name);
        if (route.fixed) {
          await assertCoolingContent(page);
          await assertFixedLayout(page);
        }
      }
      assert.deepEqual(
        [...visited].sort(),
        ROUTES.map(route => route.name).sort(),
        "All router views must actually be visited."
      );
      await checkNoticeStates(page, previewFile, theme);
    }
  }
  await resizePage(page, { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await setPageInsets(page, { top: 47, bottom: 34, left: 0, right: 0 });
  await checkInsetCounterexample(page, previewFile);
  await checkHistoryAndGestures(page, previewFile);
  await checkCoolingFailures(page, previewFile);
  console.log(
    `  ✓ riding: real PWA/native insets, ${minimumClearance}px minimum Cooling clearance, complete content, notices/Connect, history/reload and both gestures`
  );
}

async function checkInsetCounterexample(page: HeadlessPage, file: string) {
  await openPreview(page, file, "#ride/cooling", "inset-counterexample");
  await assertCoolingContent(page);
  await evaluateOnPage(page, "document.querySelector('.cooling-view').style.minHeight='668px'");
  const real = (await evaluateOnPage(
    page,
    "[document.scrollingElement.scrollHeight-innerHeight,document.querySelector('.tabs').getBoundingClientRect().top-document.querySelector('.cooling-view').getBoundingClientRect().bottom]"
  )) as number[];
  assert.ok(real[0] > 0 && real[1] < 12, "A populated over-budget riding view must fail at real insets.");
  try {
    await setPageInsets(page, { top: 0, bottom: 0, left: 0, right: 0 });
    await evaluateOnPage(page, FRAME);
    const zero = (await evaluateOnPage(
      page,
      "[document.scrollingElement.scrollHeight-innerHeight,document.querySelector('.tabs').getBoundingClientRect().top-document.querySelector('.cooling-view').getBoundingClientRect().bottom]"
    )) as number[];
    assert.equal(zero[0], 0, "The same counterexample fits only the misleading zero-inset space.");
    assert.ok(zero[1] >= 12);
  } finally {
    await setPageInsets(page, { top: 47, bottom: 34, left: 0, right: 0 });
  }
}

async function assertInsets(page: HeadlessPage, top: number, height: number) {
  const actual = await evaluateOnPage(
    page,
    `(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = [innerWidth,innerHeight,parseFloat(style.paddingTop),parseFloat(style.paddingBottom)];
    probe.remove();
    return result;
  })()`
  );
  assert.deepEqual(
    actual,
    [390, height, top, 34],
    "The real env() safe areas are mandatory; zero-inset fallback is forbidden."
  );
}

async function assertPopulatedFixture(page: HeadlessPage) {
  const values = await evaluateOnPage(
    page,
    `(() => {
    const store = ridingPreview("lib/store.js");
    const required = ${JSON.stringify([...COOLING_SIGNALS, "batt_temp_lo_vcu", "batt_temp_hi_vcu", "cell_cutoff_mv"])};
    return {missing:required.filter(key => store.valueOf(key) === null), cells:store.knownKeys.val.filter(key => /^lmu[0-9]+_cell[0-9]+_mv$/.test(key)).length, installed:ridingPreview("lib/settings.js").settings.val?.active.coolantProbesEnabled};
  })()`
  );
  assert.deepEqual(
    values,
    { missing: [], cells: 81, installed: true },
    "The normal fixture must populate every required sensor and all 81 cells."
  );
}

async function assertCoolingContent(page: HeadlessPage) {
  assert.equal(
    await evaluateOnPage(
      page,
      `[...document.querySelectorAll('.cooling-view [data-signal]')].every(element => {
    const rectangle=element.getBoundingClientRect();
    if(rectangle.width<=0 || rectangle.height<=0 || element.getClientRects().length===0) return false;
    for(let parent=element;parent;parent=parent.parentElement) {
      const style=getComputedStyle(parent);
      if(style.display==='none' || style.visibility!=='visible' || Number(style.opacity)===0) return false;
    }
    return true;
  })`
    ),
    true,
    "Every required reading must actually be rendered, not hidden in the DOM."
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `[...document.querySelectorAll('.cooling-view [data-signal]')].map(element => element.getAttribute('data-signal')).sort()`
    ),
    [...COOLING_SIGNALS].sort()
  );
  const values = await evaluateOnPage(
    page,
    `[...document.querySelectorAll('.cooling-view [data-signal]')].map(element => element.textContent)`
  );
  assert.deepEqual(
    values,
    ["36.5", "41.2", "38", "41", "65", "67", "17", "68"],
    "Required readings must render; hidden tiles cannot buy a short screen."
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "document.querySelector('.cooling-view').innerText.includes('Automatic · driver ready')"
    ),
    true
  );
}

interface Layout {
  scroll: number;
  width: number;
  clearance: number;
  header: number;
  tabs: number;
  padding: number;
  flush: number;
  overflow: string[];
  smallTargets: string[];
  hiddenOverflow: boolean;
  textOutside: string[];
}

async function assertFixedLayout(page: HeadlessPage) {
  const result = (await evaluateOnPage(
    page,
    `(() => {
    const view = document.querySelector('.cooling-view');
    const header = document.querySelector('.header').getBoundingClientRect();
    const tabs = document.querySelector('.tabs').getBoundingClientRect();
    const boxes = [...view.querySelectorAll('.tile,.value,.sub,.label,button'), ...document.querySelectorAll('.header-notice:not([hidden]),.header .status')];
    const textOutside = [...view.querySelectorAll('.value,.label,.sub')].filter(element => {
      const range=document.createRange(); range.selectNodeContents(element);
      const text=range.getBoundingClientRect(); const card=element.closest('.tile').getBoundingClientRect();
      return text.width>0 && (text.left<card.left || text.right>card.right || text.top<card.top || text.bottom>card.bottom);
    }).map(element => element.className);
    return {
      textOutside,
      scroll:document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight,
      width:document.body.scrollWidth,
      clearance:tabs.top-view.getBoundingClientRect().bottom,
      header:header.height-parseFloat(getComputedStyle(document.querySelector('.header')).paddingTop),
      tabs:tabs.height, padding:parseFloat(getComputedStyle(document.body).paddingBottom),
      flush:view.getBoundingClientRect().top-header.bottom,
      overflow:boxes.filter(element => element.scrollWidth>element.clientWidth+1 || (element.classList.contains('tile') && element.scrollHeight>element.clientHeight+1) || getComputedStyle(element).textOverflow==='ellipsis').map(element => element.className),
      smallTargets:[...document.querySelectorAll('.header button,.tabs button,.sub-tabs button')].filter(element => !element.hidden && (element.getBoundingClientRect().width<44 || element.getBoundingClientRect().height<44)).map(element => element.textContent),
      hiddenOverflow:[view,document.body,document.documentElement,...view.querySelectorAll('.tile,.value,.label,.sub,[data-signal]')].some(element => ['hidden','clip'].includes(getComputedStyle(element).overflowY))
    };
  })()`
  )) as Layout;
  assert.equal(result.scroll, 0, `A riding view must not scroll: ${JSON.stringify(result)}`);
  assert.equal(result.width, 390);
  assert.ok(result.clearance >= 12, `At least 12 px of real riding clearance is required: ${JSON.stringify(result)}`);
  minimumClearance = Math.min(minimumClearance, result.clearance);
  assert.equal(result.header, 52);
  assert.equal(result.tabs, 84);
  assert.equal(result.padding, 84);
  assert.equal(result.flush, 0);
  assert.deepEqual(result.textOutside, [], "Full reading text must remain inside its card.");
  assert.deepEqual(result.overflow, [], "Text, charts and notices must fit internally without ellipsizing.");
  assert.deepEqual(result.smallTargets, [], "Every visible target must remain at least 44×44.");
  assert.equal(result.hiddenOverflow, false, "Hiding overflow is not a layout fix.");
}

async function checkNoticeStates(page: HeadlessPage, file: string, theme: string) {
  for (const link of ["live", "offline", "connecting", "ble-connect"]) {
    await openPreview(
      page,
      file,
      "#ride/cooling",
      `${theme}-${link}-${Date.now()}`,
      link === "ble-connect" ? "&header-link=ble-connect" : ""
    );
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}; ridingPreview('lib/store.js').connection.val=${JSON.stringify(link === "ble-connect" ? "connecting" : link)}`
    );
    for (const state of ["setup", "reload", "fault"]) {
      await evaluateOnPage(
        page,
        `(() => {
        ridingPreview('lib/page-reload.js').pageReloadRequired.val = ${state !== "setup"};
        const setting = ridingPreview('lib/settings.js').settings;
        SETTINGS.fault = ${state === "fault" ? JSON.stringify("Synthetic settings fault; open Settings for the complete repair instructions.") : "null"};
        SETTINGS.ok = !SETTINGS.fault;
        setting.val = {...setting.rawVal, fault:SETTINGS.fault,ok:SETTINGS.ok};
      })()`
      );
      await evaluateOnPage(page, FRAME);
      await evaluateOnPage(page, FRAME);
      const notice = (await evaluateOnPage(
        page,
        `(() => {
        const button=document.querySelector('.header-notice');
        return {label:button.querySelector('.notice-label').textContent,count:button.querySelector('.notice-count').textContent,name:button.getAttribute('aria-label'),visible:!button.hidden,connect:!!document.querySelector('.ble-connect'),overflow:button.scrollWidth>button.clientWidth};
      })()`
      )) as { label: string; count: string; name: string; visible: boolean; connect: boolean; overflow: boolean };
      assert.equal(notice.label, state === "fault" ? "Fault" : state === "reload" ? "Reload" : "Setup");
      assert.equal(notice.count, state === "fault" ? "3" : state === "reload" ? "2" : "");
      assert.equal(notice.visible, true);
      assert.equal(notice.overflow, false);
      assert.ok(notice.name.includes("Open Settings"));
      assert.equal(notice.connect, link === "ble-connect");
      await assertFixedLayout(page);
      if (link === "ble-connect" && state === "reload") {
        await evaluateOnPage(page, "document.querySelector('.brand-slot').style.maxWidth='44px'");
        await evaluateOnPage(page, FRAME);
        await evaluateOnPage(page, FRAME);
        assert.equal(
          await evaluateOnPage(page, "document.querySelector('.header-notice').dataset.compact"),
          "true",
          "A narrower measured slot must use the icon/count fallback."
        );
        assert.equal(
          await evaluateOnPage(
            page,
            "document.querySelector('.header-notice').scrollWidth<=document.querySelector('.header-notice').clientWidth"
          ),
          true
        );
        await evaluateOnPage(page, "document.querySelector('.brand-slot').style.maxWidth=''");
        await evaluateOnPage(page, FRAME);
      }
    }
    await evaluateOnPage(page, "document.querySelector('.header-notice').click()");
    await waitOnPage(
      page,
      "location.search.includes('panel=settings') && document.body.innerText.includes('What changed on this Pi')",
      "full notices on the existing Settings root"
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.body.innerText.includes('Repair instructions') && document.body.innerText.includes('This dashboard is out of date')"
      ),
      true
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('.header .menu').textContent"), "‹ Cooling");
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('button')].find(button=>button.textContent==='Got it').click(); document.querySelector('.header .menu').click()"
    );
    await waitOnPage(page, "!!document.querySelector('.cooling-view')", "return after acknowledging setup notes");
    await evaluateOnPage(
      page,
      `(() => {
      SETTINGS.fault=null; SETTINGS.ok=true;
      const settings=ridingPreview('lib/settings.js').settings;settings.val={...settings.rawVal,fault:null,ok:true};
      const system=ridingPreview('lib/store.js').systemStatus;system.val={...system.rawVal,settingsFault:null};
      ridingPreview('lib/page-reload.js').pageReloadRequired.val=false;
    })()`
    );
    await evaluateOnPage(page, FRAME);
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelector('.header-notice').hidden && !document.querySelector('.brand').hidden && document.querySelector('.brand').textContent==='Cool Eva'"
      ),
      true
    );
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelector('.brand').scrollWidth <= document.querySelector('.brand-slot').clientWidth"
      ),
      true,
      "The restored brand must fit without ellipsis."
    );
    await assertFixedLayout(page);
  }
}

async function checkCoolingFailures(page: HeadlessPage, file: string) {
  await openPreview(page, file, "#ride/cooling", "fault-input");
  await evaluateOnPage(page, "pushPatch({coolant_in:[-242,'°C','coolant']})");
  await waitOnPage(
    page,
    "document.querySelector('[data-signal=coolant_in]').textContent === 'fault'",
    "a visible rejected coolant input"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-signal=coolant_out]').textContent"), "41.2");
  await assertFixedLayout(page);
  await evaluateOnPage(page, "ridingPreview('lib/units.js').unitSystem.val='imperial'");
  await evaluateOnPage(page, FRAME);
  await assertFixedLayout(page);
  await evaluateOnPage(page, "ridingPreview('lib/units.js').unitSystem.val='metric'");
  await evaluateOnPage(
    page,
    "ridingPreview('lib/store.js').signalState('motor_temp_c').val=null; ridingPreview('lib/store.js').signalState('fan_auto_mode').val=null"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-signal=motor_temp_c]').textContent"), "—");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.cooling-view').innerText.includes('Fan status unavailable')"),
    true
  );
  await assertFixedLayout(page);
}
