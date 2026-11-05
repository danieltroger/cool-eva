import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { ARM_DWELL_MS } from "../public/lib/arming.js";
import {
  evaluateOnPage,
  waitOnPage,
  resizePage,
  setPageInsets,
  screenshotPage,
  type HeadlessPage,
} from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";
import { assertFixedLayout } from "./riding-layout-browser.ts";

export async function checkPsuHoldBrowser(page: HeadlessPage, file: string, shots?: string, pixelRatio = 3) {
  await resizePage(page, { width: 390, height: 844, deviceScaleFactor: pixelRatio, mobile: true });
  await setPageInsets(page, { top: 47, bottom: 34, left: 0, right: 0 });
  if (shots) {
    await mkdir(shots, { recursive: true });
  }
  for (const theme of ["dark", "light"]) {
    await openPreview(page, file, "#ride/cooling", `psu-actions-${theme}`);
    await evaluateOnPage(
      page,
      "Object.assign(GATE,{safe:true,blockers:[],checks:[],chargingEvidence:null});pushPatch({gps_speed_kmh:[0,'km/h','gps'],speed_can_kmh:[0,'km/h','drive'],motor_rpm:[0,'rpm','obd'],pack_a:[-0.3,'A','battery'],pack_kw:[-0.102,'kW','battery']})"
    );
    await evaluateOnPage(
      page,
      `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};ridingPreview('lib/setup-notice.js').dismissSetupNotice('cool-eva.setup-seen:'+SETTINGS.instanceId);ridingPreview('lib/destination.js').openDestination('advanced-service')`
    );
    await waitForAction(page, "start");
    await focusCard(page);
    if (shots) {
      await screenshotPage(page, `${shots}/psu-off-${theme}.png`);
    }
    await clickAction(page, "start");
    await clickAction(page, "start");
    assert.equal(await posts(page), 0, "A quick second tap cannot start the hold");
    assert.equal(
      await evaluateOnPage(
        page,
        "document.querySelector('[data-psu-action=start]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,cancelable:true,bubbles:true}))"
      ),
      false
    );
    assert.equal(await posts(page), 0);
    await evaluateOnPage(
      page,
      "ridingPreview('lib/destination.js').openRidingView('all');ridingPreview('lib/destination.js').openDestination('advanced-service')"
    );
    await waitForAction(page, "start");
    assert.equal(
      await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.val"),
      "",
      "Navigation disarms a pending PSU action"
    );
    await clickAction(page, "start");
    assert.equal(await posts(page), 0, "Returning to the page needs a new arm");
    await dwell(page);
    await clickAction(page, "start");
    await waitForAction(page, "stop");
    assert.equal(await posts(page), 1);
    assert.equal(await evaluateOnPage(page, "psuPreviewRequests[0].headers['X-Cool-Eva']"), "service-write");
    await waitOnPage(
      page,
      "document.querySelector('[data-psu-status]')?.textContent.includes('left')",
      "remaining PSU hold time"
    );
    assert.deepEqual(
      await evaluateOnPage(page, "[...document.querySelectorAll('[data-psu-rail]')].map(element=>element.textContent)"),
      ["12.72 V", "9.03 V"]
    );
    await focusCard(page);
    if (shots) {
      await screenshotPage(page, `${shots}/psu-on-${theme}.png`);
    }
    await clickAction(page, "stop");
    await evaluateOnPage(page, "PSU_HOLD.revision++;ridingPreview('lib/store.js').apply(message('snapshot',LIVE))");
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.val"),
      "",
      "An authoritative run change disarms the previous confirmation"
    );
    assert.equal(
      await evaluateOnPage(page, "ridingPreview('lib/psu-hold.js').psuHoldMessage.val"),
      "",
      "A previous success cannot outlive a state change"
    );
    await dwell(page);
    await clickAction(page, "stop");
    assert.equal(await posts(page), 1, "A stale Off confirmation cannot stop the newer run");
    await clickAction(page, "extend");
    assert.equal(await posts(page), 1, "An extension must arm separately");
    await dwell(page);
    await clickAction(page, "extend");
    await waitOnPage(
      page,
      "document.querySelector('[data-psu-result]').textContent.includes('extended')",
      "explicit extension reply"
    );
    assert.equal(await posts(page), 2);
    assert.equal(await evaluateOnPage(page, "psuPreviewRequests[1].action"), "extend");
    await evaluateOnPage(
      page,
      "pushPatch({psu_12v_mv:[65535,'mV','powertrain'],psu_12v_lowpower_mv:[65535,'mV','powertrain']})"
    );
    await waitOnPage(
      page,
      "[...document.querySelectorAll('[data-psu-rail]')].every(element=>element.textContent==='fault')",
      "rejected rails displayed as faults without units"
    );
    if (shots) {
      await focusCard(page);
      await screenshotPage(page, `${shots}/psu-fault-${theme}.png`);
    }
    await clickAction(page, "stop");
    assert.equal(await posts(page), 2);
    await dwell(page);
    await clickAction(page, "stop");
    await waitForAction(page, "start");
    assert.equal(await posts(page), 3);
    assert.match(
      String(await evaluateOnPage(page, "document.querySelector('[data-psu-status]').textContent")),
      /Off · stopped by owner/
    );
    assert.equal(await evaluateOnPage(page, "document.querySelector('.header-notice').hidden"), true);
    await clickAction(page, "start");
    await evaluateOnPage(
      page,
      "PSU_HOLD.instance='synthetic-psu-next-boot';PSU_HOLD.revision=0;PSU_HOLD.lastStopReason=null;ridingPreview('lib/store.js').apply(message('snapshot',LIVE))"
    );
    await evaluateOnPage(page, FRAME);
    assert.equal(
      await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.val"),
      "",
      "A service boot cannot inherit an armed On"
    );
    await checkHeader(page, file, theme, shots);
  }
  console.log(
    "PSU browser: both themes; arm/dwell/confirm/disarm, separate extension, Off, bounded rails faults, PSU-first header/count/target and inset fit pass"
  );
}

async function checkHeader(page: HeadlessPage, file: string, theme: string, shots?: string) {
  for (const link of ["live", "connecting", "ble-connect"]) {
    for (const simultaneous of [false, true]) {
      await openPreview(
        page,
        file,
        "#ride/cooling",
        `psu-header-${theme}-${link}-${simultaneous}`,
        `&psu-hold=on${link === "ble-connect" ? "&header-link=ble-connect" : ""}`
      );
      await evaluateOnPage(
        page,
        `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)};pausePreviewMessages(${link !== "live"});ridingPreview('lib/store.js').connection.val=${JSON.stringify(link === "live" ? "live" : "connecting")}`
      );
      if (simultaneous) {
        await evaluateOnPage(
          page,
          "SETTINGS.fault='Synthetic settings fault';ridingPreview('lib/settings.js').settings.val={...ridingPreview('lib/settings.js').settings.rawVal,fault:SETTINGS.fault};ridingPreview('lib/page-reload.js').pageReloadRequired.val=true"
        );
      } else {
        await evaluateOnPage(
          page,
          "ridingPreview('lib/setup-notice.js').dismissSetupNotice('cool-eva.setup-seen:'+SETTINGS.instanceId)"
        );
      }
      await evaluateOnPage(page, FRAME);
      await evaluateOnPage(page, FRAME);
      const notice = (await evaluateOnPage(
        page,
        "(()=>{const notice=document.querySelector('.header-notice');return {label:notice.querySelector('.notice-label').textContent,count:notice.querySelector('.notice-count').textContent,name:notice.getAttribute('aria-label'),hidden:notice.hidden,overflow:notice.scrollWidth>notice.clientWidth}})()"
      )) as { label: string; count: string; name: string; hidden: boolean; overflow: boolean };
      assert.equal(notice.label, "PSU on");
      assert.equal(notice.count, simultaneous ? "4" : "1");
      assert.equal(notice.hidden, false);
      assert.equal(notice.overflow, false);
      assert.match(notice.name, /PSU on.*Open Advanced service to turn the hold off/);
      if (simultaneous) {
        assert.match(notice.name, /Settings fault; Page reload required; First-open setup information/);
      }
      await assertFixedLayout(page);
      if (shots && link === "ble-connect" && simultaneous) {
        await screenshotPage(page, `${shots}/psu-header-${theme}.png`);
      }
      await evaluateOnPage(page, "document.querySelector('.header-notice').click()");
      await waitOnPage(
        page,
        "ridingPreview('lib/destination.js').destination.val==='advanced-service'&&document.querySelector('[data-psu-action=stop]')",
        "notice target is Advanced service with the Off control"
      );
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('.header-notice').hidden"),
        false,
        "Active hold stays visible on a menu page"
      );
    }
  }
}

async function clickAction(page: HeadlessPage, action: string) {
  await evaluateOnPage(page, `document.querySelector('[data-psu-action=${action}]').click()`);
  await evaluateOnPage(page, FRAME);
}
async function waitForAction(page: HeadlessPage, action: string) {
  await waitOnPage(
    page,
    `document.querySelector('[data-psu-action=${action}]')&&ridingPreview('lib/psu-hold.js').psuHoldState.val&&!ridingPreview('lib/psu-hold.js').psuHoldBusy.val`,
    `PSU ${action} control and authoritative state`
  );
  await evaluateOnPage(page, FRAME);
}
async function dwell(page: HeadlessPage) {
  await evaluateOnPage(page, `new Promise(resolve=>setTimeout(resolve,${ARM_DWELL_MS + 60}))`);
}
async function posts(page: HeadlessPage) {
  return await evaluateOnPage(page, "psuPreviewRequests.length");
}
async function focusCard(page: HeadlessPage) {
  await evaluateOnPage(
    page,
    "document.getElementById('psu-hold').scrollIntoView({block:'center'});document.fonts.ready"
  );
  await evaluateOnPage(page, FRAME);
}
