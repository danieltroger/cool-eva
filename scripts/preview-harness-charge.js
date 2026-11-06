// Synthetic Charge cases extend only the complete riding fixture; normal Settings/network fixtures remain intact.
const chargeScene = new URLSearchParams(location.search).get("charge-scene");
window.chargePreviewRequests = [];
window.chargePreviewReplyMode = new URLSearchParams(location.search).get("soc-reply") ?? "success";
window.chargePreviewStatusMode = new URLSearchParams(location.search).get("write-status") ?? "success";
window.chargePreviewStatusWaiters = [];
window.releaseChargeStatus = (enabled = true) => {
  WRITE_STATUS.enabled = enabled;
  window.chargePreviewStatusMode = "success";
  for (const resolve of window.chargePreviewStatusWaiters.splice(0)) {
    resolve();
  }
};
window.chargePreviewAutoReason = 4;
if (ridingFixture.get("fixture") === "all-installed" && chargeScene) {
  const cold = chargeScene === "cold";
  Object.assign(LIVE, {
    soc: [62, "%", "battery"],
    charge_soc_limit_pct: [90, "%", "charge", Date.now() - 60_000],
    pack_v: [358, "V", "battery"],
    pack_a: [cold ? 16 : 32, "A", "battery"],
    pack_kw: [((cold ? 16 : 32) * 358) / 1000, "kW", "battery"],
    gps_speed_kmh: [0, "km/h", "gps"],
    speed_can_kmh: [0, "km/h", "drive"],
    ambient_temp: [cold ? -5 : 28, "°C", "obd"],
    batt_temp_lo: [cold ? 3 : 43, "°C", "battery"],
    batt_temp_hi: [cold ? 7 : 47, "°C", "battery"],
    batt_temp_lo_vcu: [chargeScene === "custom" ? 33 : cold ? 3 : 43, "°C", "battery"],
    batt_temp_hi_vcu: [chargeScene === "custom" ? 33 : cold ? 7 : 47, "°C", "battery"],
    fast_dc_contactor: [1, "", "charge"],
    charge_manager_state: [35, "", "charge"],
    charge_cmd_a: [cold ? 16 : 32, "A", "charge", Date.now() - 60_000],
    charge_auto_mode: [1, "", "charge", Date.now() - 60_000],
    charge_auto_reason: [4, "", "charge", Date.now() - 60_000],
    bms_state_balancing: [0, "", "battery"],
    bms_state_trickle: [0, "", "battery"],
    bms_state_maintenance: [0, "", "battery"],
    iso_test_total: [5800, "", "bms"],
  });
  WRITE_STATUS.chargeAck = {
    verdict: { kind: "took", fromAmps: 50, toAmps: cold ? 16 : 32, latencyMs: 120 },
    message: "The bike’s request settled at the last commanded current.",
  };
  if (chargeScene === "readonly") {
    WRITE_STATUS.enabled = false;
  }
  if (chargeScene === "unknown") {
    delete LIVE.batt_temp_lo_vcu;
    delete LIVE.batt_temp_hi_vcu;
  }
  if (chargeScene === "outside-missing") {
    delete LIVE.ambient_temp;
  }
  if (chargeScene === "ac") {
    Object.assign(LIVE, {
      fast_dc_contactor: [0, "", "charge"],
      charge_manager_state: [2, "", "charge"],
      bms_state_charge: [1, "", "battery"],
      pack_a: [15, "A", "battery"],
      pack_kw: [5.37, "kW", "battery"],
      charge_cmd_a: [15, "A", "charge", Date.now() - 60_000],
      dc_a: [15, "A", "charger"],
      dc_v: [358, "V", "charger"],
      mains_v: [230, "V", "charger"],
      mains_a: [25, "A", "charger"],
      charger_max_dc_a: [20, "A", "charger"],
      charger_max_dc_v: [400, "V", "charger"],
      charge_limit_a: [15, "A", "charger"],
      charger_enabled: [1, "", "charger"],
    });
  }
  if (chargeScene === "ac") {
    WRITE_STATUS.chargeAck = {
      verdict: { kind: "took", fromAmps: 16, toAmps: 15, latencyMs: 120 },
      message: "The AC request settled at 15 A.",
    };
  }
  for (let module = 1; module <= 11; module++) {
    for (const sensor of ["bat1", "pcb1", "pcb2"]) {
      if (sensor === "bat1" && [6, 8].includes(module)) continue;
      LIVE[`lmu${module}_${sensor}_c`] = [(cold ? 3 : 43) + (module % 5), "°C", "battery"];
    }
  }
  if (cold) {
    LIVE.coolant_in = [2, "°C", "coolant"];
    LIVE.coolant_out = [3.2, "°C", "coolant"];
  }
  const originalChargeInstantiate = instantiate;
  instantiate = function instantiateChargePreview() {
    const imports = originalChargeInstantiate();
    const now = imports("lib/clock.js").monotonicNow();
    const powerHistory = imports("lib/ring.js").ringFor("pack_kw");
    // Later timestamps replace the riding seed inside the ETA's live window.
    for (let sample = 0; sample < 10; sample++) {
      powerHistory.push(now - 1_800 + sample * 200, LIVE.pack_kw[0]);
    }
    for (let sample = 0; sample < 11; sample++) {
      imports("lib/ring.js")
        .ringFor("cell_spread_mv")
        .push(now - 600_000 + sample * 59_000, 48 - sample);
    }
    return imports;
  };
  const originalChargeFetch = window.fetch;
  window.fetch = async function fetchChargePreview(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const method = init.method ?? "GET";
    if (url.pathname.endsWith("/charge-auto")) {
      window.chargePreviewRequests.push({ action: "automatic", method, query: url.search });
      const response = {
        state: { mode: "automatic", reason: window.chargePreviewAutoReason, commandedAmps: null },
        reasonText:
          window.chargePreviewAutoReason === 4
            ? "Paused after the rider set the current."
            : "Automatic reduction is active.",
        floorAmps: 35,
        message: null,
      };
      if (method === "POST") {
        response.state.mode = url.searchParams.get("mode") ?? "off";
        response.state.reason = 0;
        response.reasonText = "Waiting for the next controller tick.";
      }
      return json(response);
    }
    if (url.pathname.endsWith("/vcu-write") && method === "GET") {
      window.chargePreviewRequests.push({ action: "status", method, query: url.search });
      if (window.chargePreviewStatusMode === "pending") {
        await new Promise(resolve => window.chargePreviewStatusWaiters.push(resolve));
      }
      if (window.chargePreviewStatusMode === "failed") {
        throw new Error("Synthetic permission status unavailable");
      }
    }
    if (url.pathname.endsWith("/vcu-write") && method === "POST") {
      const action = url.searchParams.get("action");
      window.chargePreviewRequests.push({
        action,
        method,
        query: url.search,
        header: new Headers(init.headers).get("X-Cool-Eva"),
      });
      if (window.chargePreviewReplyMode === "timeout") {
        throw new Error("Synthetic interrupted response; delivery is unknown");
      }
      if (window.chargePreviewReplyMode === "pending") {
        await new Promise(resolve => {
          window.releaseChargePreview = resolve;
        });
      }
      if (window.chargePreviewReplyMode === "refused") {
        return json({
          status: writeStatus(url.searchParams),
          result: null,
          chargeCurrentAttempt: action === "charge-current" ? "not-sent" : undefined,
          message:
            "Synthetic refusal: the bus lease is busy. The request was not sent; wait for the current operation and check the bike’s live state before trying again.",
        });
      }
      if (window.chargePreviewReplyMode === "send-failed" && action === "charge-current") {
        return json({
          status: writeStatus(url.searchParams),
          result: null,
          chargeCurrentAttempt: "unknown",
          message: "Synthetic transmit failure after the first frame.",
        });
      }
      if (!["charge-current", "charge-stop"].includes(action)) {
        return originalChargeFetch(input, init);
      }
      if (action === "charge-current") {
        const amps = Number(url.searchParams.get("amps"));
        LIVE.charge_cmd_a = [amps, "A", "charge"];
        WRITE_STATUS.chargeAck = {
          verdict: { kind: "waiting", elapsedMs: 0 },
          message: "Waiting for the bike’s own request; delivered current is not acknowledgement.",
        };
        pushPatch({ charge_cmd_a: LIVE.charge_cmd_a });
      }
      return json({
        status: writeStatus(url.searchParams),
        result: {
          action,
          status: "sent",
          message:
            action === "charge-stop"
              ? "Synthetic stop request sent. This does not establish completion: watch the charge wind down and follow the bike’s unplug prompt."
              : "Synthetic current request sent; the bike’s reply is still pending.",
          succeeded: true,
        },
        message: null,
      });
    }
    return originalChargeFetch(input, init);
  };
}
