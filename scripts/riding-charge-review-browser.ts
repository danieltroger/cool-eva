import assert from "node:assert/strict";
import { ARM_DWELL_MS } from "../public/lib/arming.js";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { assertFixedLayout, assertRendered } from "./riding-layout-browser.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkChargeReviewCases(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  await checkRefusedTarget(page, file, theme, capture);
  await checkAcLimits(page, file, theme, capture);
  await checkChargeDirectionAndToggle(page, file, theme, capture);
}

async function checkRefusedTarget(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  await openPreview(page, file, "#charge/controls", `refused-40-${theme}`, "&charge-scene=warm");
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await waitOnPage(
    page,
    "document.querySelector('[data-charge-reply]')?.textContent==='32 A'",
    "previous confirmed 32 A"
  );
  await evaluateOnPage(
    page,
    "const input=document.querySelector('input[name=charge-current-amps]');input.value='40';input.dispatchEvent(new Event('input',{bubbles:true}));chargePreviewReplyMode='refused'"
  );
  await evaluateOnPage(page, FRAME);
  await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
  await waitOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal==='charge-current'", "40 A retry scope");
  await evaluateOnPage(page, `new Promise(resolve=>setTimeout(resolve,${ARM_DWELL_MS + 80}))`);
  await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
  await waitOnPage(
    page,
    "document.querySelector('.charge-current-control').textContent.includes('Synthetic refusal:')",
    "the attempted 40 A is explicitly refused"
  );
  assert.ok(
    String(await evaluateOnPage(page, "document.querySelector('.charge-current-control').textContent")).includes(
      "40 A request NOT sent."
    ),
    "A refusal must name the attempted amperage and say it was NOT sent."
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `({request:document.querySelector('[data-last-charge-request]').textContent,reply:document.querySelector('[data-charge-reply]').textContent,draft:document.querySelector('input[name=charge-current-amps]').value,success:document.querySelector('.charge-current-control').textContent.includes('✅'),oldAcknowledgement:document.querySelector('.charge-current-control').textContent.includes('settled at the last commanded current'),posts:chargePreviewRequests.filter(request=>request.method==='POST'&&request.action==='charge-current').length})`
    ),
    { request: "32 A", reply: "32 A", draft: "40", success: false, oldAcknowledgement: false, posts: 1 },
    "A refused different target must not inherit an unqualified earlier success."
  );
  assert.equal(await evaluateOnPage(page, "document.body.scrollWidth"), 390);
  if (capture) {
    await capture(`controls-refused-40-${theme}`);
  }
  await evaluateOnPage(
    page,
    "chargePreviewReplyMode='send-failed';document.querySelector('[data-charge-action=current]').click()"
  );
  await waitOnPage(
    page,
    "ridingPreview('lib/arming.js').armed.rawVal==='charge-current'",
    "uncertain transmission scope"
  );
  await evaluateOnPage(page, `new Promise(resolve=>setTimeout(resolve,${ARM_DWELL_MS + 80}))`);
  await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
  await waitOnPage(
    page,
    "document.querySelector('.charge-current-control').textContent.includes('delivery uncertain')",
    "a partial send stays uncertain"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.charge-current-control').textContent.includes('NOT sent')"),
    false,
    "A possible partial transmission must never be labelled NOT sent."
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.charge-current-control').textContent.includes('✅')"),
    false
  );
  if (capture) {
    await capture(`controls-uncertain-40-${theme}`);
  }
  await evaluateOnPage(
    page,
    "pausePreviewMessages(true);window.heldChargeRequest=ridingPreview('lib/store.js').signalState('charge_cmd_a').rawVal;ridingPreview('lib/store.js').signalState('charge_cmd_a').val=null"
  );
  await evaluateOnPage(page, FRAME);
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "[document.querySelector('[data-last-charge-request]').textContent,document.querySelector('[data-charge-reply]').textContent]"
    ),
    ["—", "—"],
    "A missing command cannot leave an orphaned 32 A reply."
  );
  await evaluateOnPage(
    page,
    "ridingPreview('lib/store.js').signalState('charge_cmd_a').val=window.heldChargeRequest;ridingPreview('lib/store.js').connection.val='offline'"
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "(()=>{const pair=ridingPreview('lib/charge-request-display.js').chargeRequestReply();return [pair.request,pair.reply]})()"
    ),
    ["stale", "stale"],
    "Request and reply share the link-down freshness boundary."
  );
  await evaluateOnPage(page, FRAME);
  const displayed = await evaluateOnPage(
    page,
    "[document.querySelector('[data-last-charge-request]')?.textContent??null,document.querySelector('[data-charge-reply]')?.textContent??null]"
  );
  assert.ok(
    JSON.stringify(displayed) === JSON.stringify(["stale", "stale"]) ||
      JSON.stringify(displayed) === JSON.stringify([null, null]),
    "A dropout either marks both stale or hides both with the existing session gate."
  );
}

async function checkAcLimits(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  for (const scenario of ["fresh", "missing", "stale", "fault", "zero"]) {
    await openPreview(page, file, "#charge", `ac-${scenario}-${theme}`, "&charge-scene=ac");
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    await waitOnPage(
      page,
      "document.querySelector('[data-charge-soc]')?.textContent==='62'&&ridingPreview('lib/charge-display.js').currentChargeMode()==='ac'&&document.querySelector('[data-charge-eta]')?.textContent.includes(':')",
      "accepted AC limits and ETA"
    );
    if (scenario !== "fresh") {
      if (scenario === "missing") {
        await evaluateOnPage(page, "pausePreviewMessages(true)");
        await evaluateOnPage(
          page,
          "for(const key of ['charge_limit_a','charger_max_dc_a','charger_max_dc_v']){ridingPreview('lib/store.js').signalState(key).val=null;}"
        );
      } else {
        await evaluateOnPage(
          page,
          `pushPatch({charge_limit_a:[${scenario === "fault" ? 65535 : scenario === "zero" ? 0 : 15},'A','charge',${scenario === "stale" ? "Date.now()-30_000" : "Date.now()"}],charger_max_dc_a:[${scenario === "fault" ? 65535 : scenario === "zero" ? 0 : 20},'A','charge',${scenario === "stale" ? "Date.now()-30_000" : "Date.now()"}],charger_max_dc_v:[${scenario === "fault" ? 65535 : scenario === "zero" ? 0 : 400},'V','charge',${scenario === "stale" ? "Date.now()-30_000" : "Date.now()"}]})`
        );
      }
      await evaluateOnPage(page, "pausePreviewMessages(true)");
      await evaluateOnPage(page, FRAME);
    }
    const expected =
      scenario === "fresh"
        ? ["15 A", "20 A", "400 V"]
        : scenario === "zero"
          ? ["0 A", "0 A", "0 V"]
          : Array(3).fill(scenario === "missing" ? "unavailable" : scenario);
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('[data-ac-reading]')].map(element=>element.textContent)"
      ),
      expected,
      "AC setpoint and battery/charger grants retain explicit accepted or unavailable states."
    );
    const text = String(await evaluateOnPage(page, "document.querySelector('.charge-ac-limits').textContent"));
    for (const scope of [
      "AC setpoint",
      "Charger output current",
      "Battery ceiling",
      "Granted charger current",
      "Granted charger voltage",
      "not mains current",
    ]) {
      assert.ok(text.includes(scope), scope);
    }
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.charge-chart,[data-ceiling]')"),
      null,
      "An AC allowance cannot be replaced by the DC temperature curve."
    );
    await assertRendered(page, ["[data-ac-reading]", ".charge-ac-limits .label", ".charge-ac-notes"]);
    await assertFixedLayout(page);
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelector('.charge-view').children].map(element=>element.getBoundingClientRect().height)"
      ),
      [44, 124, 80, 272, 80]
    );
    if (capture && ["fresh", "missing"].includes(scenario)) {
      await capture(`charge-ac-${scenario}-${theme}`);
    }
  }
  await openPreview(page, file, "#charge/controls", `ac-controls-${theme}`, "&charge-scene=ac");
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await waitOnPage(
    page,
    "document.querySelector('.charge-current-control')?.textContent.includes('AC setpoint 15 A')",
    "applicable AC control limits"
  );
  const text = String(await evaluateOnPage(page, "document.querySelector('.charge-current-control').textContent"));
  for (const expected of [
    "AC command ceiling 15 A (default — may be ignored)",
    "AC setpoint 15 A",
    "Battery grants 20 A / 400 V",
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.equal(text.includes("temperature ceiling"), false, "Controls must not call the DC curve an AC allowance.");
  assert.equal(await evaluateOnPage(page, "document.body.scrollWidth"), 390);
  assert.equal(await evaluateOnPage(page, "document.scrollingElement.scrollHeight-innerHeight"), 0);
  if (capture) {
    await capture(`controls-ac-${theme}`);
  }
  await evaluateOnPage(
    page,
    "pausePreviewMessages(true);for(const key of ['charge_limit_a','charger_max_dc_a','charger_max_dc_v']){ridingPreview('lib/store.js').signalState(key).val=null;}"
  );
  await evaluateOnPage(page, FRAME);
  assert.ok(
    String(await evaluateOnPage(page, "document.querySelector('.charge-current-control').textContent")).includes(
      "AC setpoint unavailable · Battery grants unavailable / unavailable"
    )
  );
}

async function checkChargeDirectionAndToggle(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  await openPreview(page, file, "#charge/pack-cooling", `pack-current-${theme}`, "&charge-scene=warm");
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await waitOnPage(
    page,
    "document.querySelector('[data-module-count]')?.textContent.startsWith('31 of 31')&&document.querySelector('.charge-voltage-grid')?.textContent.includes('81 of 81 fresh')",
    "the complete installed pack before direction cases"
  );
  for (const [value, direction] of [
    [32, "Power into the pack"],
    [-5, "Power out of the pack"],
    [0, "No current flow"],
  ] as const) {
    await evaluateOnPage(
      page,
      `pushPatch({pack_a:[${value},'A','battery'],pack_kw:[${(value * 358) / 1000},'kW','battery']});ridingPreview('lib/store.js').chartTick.val++`
    );
    await evaluateOnPage(page, FRAME);
    assert.ok(
      String(await evaluateOnPage(page, "document.querySelector('.charge-pack-current').textContent")).includes(
        direction
      ),
      "Pack current must state the direction of its accepted signed reading."
    );
    if (capture && value === -5) {
      await evaluateOnPage(page, "document.querySelector('.charge-pack-current').scrollIntoView({block:'center'})");
      await evaluateOnPage(page, FRAME);
      await capture(`pack-current-out-${theme}`);
    }
  }
  await openPreview(page, file, "#charge/controls", `active-toggle-${theme}`, "&charge-scene=warm");
  await waitOnPage(page, "!!document.querySelector('[data-charge-action=automatic]')", "automatic controller");
  await evaluateOnPage(
    page,
    `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};chargePreviewAutoReason=0;pushPatch({charge_auto_reason:[0,'','charge']})`
  );
  await waitOnPage(
    page,
    "document.querySelector('.charge-auto-secondary')?.textContent.includes('Automatic reduction is active.')",
    "active automatic controller state"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=automatic]').textContent"),
    "Switch off for this charge",
    "The toggle must name its off action, not a temporary pause."
  );
  assert.equal(await evaluateOnPage(page, "document.body.scrollWidth"), 390);
  assert.equal(await evaluateOnPage(page, "document.scrollingElement.scrollHeight-innerHeight"), 0);
  if (capture) {
    await capture(`controls-automatic-${theme}`);
  }
  await openPreview(page, file, "#ride", `rejected-charge-${theme}`, "&ride-state=charging");
  await evaluateOnPage(
    page,
    `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pushPatch({pack_kw:[0.2,'kW','battery'],gps_speed_kmh:[0,'km/h','gps'],speed_can_kmh:[0,'km/h','drive'],bms_state_charge:[0,'','battery'],bms_state_trickle:[0,'','battery'],bms_state_maintenance:[0,'','battery'],fast_dc_contactor:[193,'','charge']})`
  );
  await evaluateOnPage(page, FRAME);
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "[document.querySelector('[data-power-direction]').textContent,ridingPreview('lib/charge-display.js').chargePowerDisplay().label]"
    ),
    ["POWER IN", "POWER IN"],
    "Ride and Charge must agree when charge evidence is rejected."
  );
  await assertFixedLayout(page);
}
