import assert from "node:assert/strict";
import { ARM_DWELL_MS } from "../public/lib/arming.js";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { assertFixedLayout, assertRendered } from "./riding-layout-browser.ts";
import { assertChargeLayout } from "./charge-page-layout.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkChargeReviewCases(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  await checkIdle(page, file, theme);
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
  await openPreview(page, file, "#charge", `refused-40-${theme}`, "&charge-scene=warm");
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await waitOnPage(
    page,
    "document.querySelector('[data-current-status]')?.textContent==='Bike requests 32 A'",
    "held current request"
  );
  await evaluateOnPage(
    page,
    "(()=>{const input=document.querySelector('input[name=charge-current-amps]');input.value='40';input.dispatchEvent(new Event('input',{bubbles:true}));chargePreviewReplyMode='refused'})()"
  );
  await evaluateOnPage(page, FRAME);
  await sendCurrent(page);
  await waitOnPage(
    page,
    "document.querySelector('[data-current-status]').textContent==='40 A · Not sent'",
    "attempted 40 A is explicitly refused"
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "({command:ridingPreview('lib/store.js').valueOf('charge_cmd_a'),draft:document.querySelector('input[name=charge-current-amps]').value,success:document.querySelector('[data-current-status]').textContent.includes('confirmed'),detail:document.querySelector('[data-current-status]').title.includes('Synthetic refusal:'),posts:chargePreviewRequests.filter(request=>request.method==='POST'&&request.action==='charge-current').length})"
    ),
    { command: 32, draft: "40", success: false, detail: true, posts: 1 },
    "A refused different target never inherits an earlier success."
  );
  await assertChargeLayout(page);
  if (capture) {
    await capture(`charge-refused-40-${theme}`);
  }
  await evaluateOnPage(page, "chargePreviewReplyMode='send-failed'");
  await sendCurrent(page);
  await waitOnPage(
    page,
    "document.querySelector('[data-current-status]').textContent==='40 A · Delivery uncertain'",
    "partial transmission stays uncertain"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-current-status]').textContent.includes('Not sent')"),
    false
  );
  if (capture) {
    await capture(`charge-uncertain-40-${theme}`);
  }
  await evaluateOnPage(
    page,
    "pausePreviewMessages(true);window.heldChargeRequest=ridingPreview('lib/store.js').signalState('charge_cmd_a').rawVal;ridingPreview('lib/store.js').signalState('charge_cmd_a').val=null"
  );
  await evaluateOnPage(page, FRAME);
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "(()=>{const pair=ridingPreview('lib/charge-request-display.js').chargeRequestReply();return [pair.request,pair.reply]})()"
    ),
    ["—", "—"],
    "A missing command cannot leave an orphaned earlier reply in the confirmation model."
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
}
async function checkAcLimits(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  const keys = ["charge_limit_a", "ac_charge_ceiling_a", "charger_max_dc_a"];
  for (const scenario of ["fresh", "missing", "stale", "fault", "zero"]) {
    await openPreview(page, file, "#charge", `ac-${scenario}-${theme}`, "&charge-scene=ac");
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    await waitOnPage(
      page,
      "document.querySelector('[data-charge-soc]')?.textContent==='62'&&document.querySelector('[data-charge-eta]')?.textContent.includes('estimated')&&document.querySelector('input[name=charge-current-amps]')?.value==='13'",
      "accepted AC readings, duration and draft"
    );
    if (scenario !== "fresh") {
      if (scenario === "missing") {
        await evaluateOnPage(page, "pausePreviewMessages(true)");
        await evaluateOnPage(
          page,
          `for(const key of ${JSON.stringify(keys)}){ridingPreview('lib/store.js').signalState(key).val=null;}`
        );
      } else {
        await evaluateOnPage(
          page,
          `pushPatch({${keys.map((key, index) => `${key}:[${scenario === "fault" ? 65535 : scenario === "zero" ? 0 : [13, 16, 75][index]},'A','charge',${scenario === "stale" ? "Date.now()-30_000" : "Date.now()"}]`).join(",")}})`
        );
      }
      await evaluateOnPage(page, "pausePreviewMessages(true)");
      await evaluateOnPage(page, FRAME);
    }
    const expected =
      scenario === "fresh"
        ? ["13", "16", "75"]
        : scenario === "zero"
          ? ["0", "0", "0"]
          : Array(3).fill(scenario === "missing" ? "Unavailable" : scenario);
    assert.deepEqual(
      await evaluateOnPage(
        page,
        "[...document.querySelectorAll('[data-ac-reading]')].map(element=>element.textContent)"
      ),
      expected,
      "Accepted AC readings retain explicit missing, stale and fault states."
    );
    const text = String(await evaluateOnPage(page, "document.querySelector('.charge-ac-limits').textContent"));
    for (const label of ["AC setpoint", "Charger ceiling", "Battery ceiling"]) {
      assert.ok(text.includes(label), label);
    }
    if (scenario === "fresh" || scenario === "zero") {
      assert.equal((text.match(/A · mains/g) || []).length, 2);
      assert.equal((text.match(/A · pack/g) || []).length, 1);
    } else {
      assert.equal(text.includes("A ·"), false, "Unknown readings cannot wear measured units.");
    }
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.charge-chart,[data-ceiling]')"),
      null,
      "An AC allowance never uses the DC temperature curve."
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.charge-auto-control').getBoundingClientRect().height"),
      0
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.charge-current-control .charge-label').textContent"),
      "AC current request"
    );
    await assertRendered(page, ["[data-ac-reading]", ".charge-ac-limits .charge-label"]);
    await assertChargeLayout(page);
    if (capture && ["fresh", "missing"].includes(scenario)) {
      await capture(`charge-ac-${scenario}-${theme}`);
    }
  }
}
async function checkChargeDirectionAndToggle(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  await openPreview(page, file, "#charge", `direction-${theme}`, "&charge-scene=warm");
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await waitOnPage(
    page,
    "document.querySelector('[data-charge-direction]')?.textContent==='DC charging'",
    "complete Charge delivery"
  );
  for (const [value, direction] of [
    [32, "DC charging"],
    [-5, "Power out"],
    [0, "Power"],
  ] as const) {
    await evaluateOnPage(
      page,
      `pushPatch({pack_a:[${value},'A','battery'],pack_kw:[${(value * 358) / 1000},'kW','battery']});ridingPreview('lib/store.js').chartTick.val++`
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('[data-charge-direction]').textContent"),
      direction,
      "Charge uses the accepted power direction."
    );
    await assertChargeLayout(page);
    if (capture && value === -5) {
      await capture(`charge-power-out-${theme}`);
    }
  }
  await openPreview(page, file, "#charge", `active-toggle-${theme}`, "&charge-scene=warm");
  await waitOnPage(
    page,
    "document.querySelector('[data-auto-status]')?.textContent==='Paused for this charge'",
    "paused controller"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=automatic]').textContent"),
    "Resume"
  );
  await evaluateOnPage(page, "chargePreviewAutoReason=0;pushPatch({charge_auto_reason:[0,'','charge']})");
  await waitOnPage(
    page,
    "document.querySelector('[data-auto-status]')?.textContent==='Active for this charge'",
    "active controller"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-charge-action=automatic]').textContent"),
    "Switch off"
  );
  await assertChargeLayout(page);
  if (capture) {
    await capture(`charge-automatic-${theme}`);
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
    "Ride and Charge agree when charge evidence is rejected."
  );
  await assertFixedLayout(page);
}
async function sendCurrent(page: HeadlessPage) {
  await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
  await waitOnPage(
    page,
    "ridingPreview('lib/arming.js').armed.rawVal==='charge-current'",
    "current confirmation scope"
  );
  await evaluateOnPage(page, `new Promise(resolve=>setTimeout(resolve,${ARM_DWELL_MS + 80}))`);
  await evaluateOnPage(page, "document.querySelector('[data-charge-action=current]').click()");
}

async function checkIdle(page: HeadlessPage, file: string, theme: string) {
  await openPreview(page, file, "#charge", `idle-${theme}`);
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await waitOnPage(
    page,
    "document.querySelector('.charge-idle')?.textContent==='Not charging'&&document.querySelector('input[name=charge-soc-limit-pct]')?.value==='90'&&!document.querySelector('input[name=charge-soc-limit-pct]').disabled",
    "idle keeps the saved-limit card"
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "[...document.querySelectorAll('.charge-view .tile')].filter(element=>element.getBoundingClientRect().height>0).map(element=>element.classList.contains('charge-idle')?'idle':element.classList.contains('charge-soc-control')?'limit':element.className)"
    ),
    ["idle", "limit"]
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-charge-power],.charge-chart,[data-charge-eta]')"),
    null
  );
  await assertChargeLayout(page);
}
