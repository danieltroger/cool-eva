// Synthetic PSU state uses the existing snapshot system block and read/action replies.
const PSU_HOLD = {
  instance: "synthetic-psu",
  on: false,
  remainingMs: 0,
  lastStopReason: null,
  revision: 0,
  enabled: true,
  refusal: null,
};
let psuPreviewDeadline = 0;
window.psuPreviewRequests = [];
if (ridingFixture.get("fixture") === "all-installed") {
  LIVE.psu_12v_mv = [12720, "mV", "powertrain"];
  LIVE.psu_12v_lowpower_mv = [9030, "mV", "powertrain"];
}
if (ridingFixture.get("psu-hold") === "on") {
  PSU_HOLD.on = true;
  psuPreviewDeadline = performance.now() + 3_600_000;
}

function previewPsuState() {
  const remaining = Math.max(0, psuPreviewDeadline - performance.now());
  if (PSU_HOLD.on && remaining === 0) {
    PSU_HOLD.on = false;
    PSU_HOLD.revision++;
    PSU_HOLD.lastStopReason = "timeout";
  }
  return { ...PSU_HOLD, remainingMs: PSU_HOLD.on ? remaining : 0 };
}

const originalPsuMessage = message;
message = function psuMessage(type, readings) {
  const payload = originalPsuMessage(type, readings);
  if (type === "snapshot") {
    payload.system.psuHold = previewPsuState();
  }
  return payload;
};

function psuPreviewReply(url, init = {}) {
  const method = init.method ?? "GET";
  if (method === "GET") {
    return json({ state: previewPsuState(), ok: true, message: "" });
  }
  window.psuPreviewRequests.push({ action: url.searchParams.get("action"), headers: { ...init.headers } });
  const action = url.searchParams.get("action");
  if (
    Number(url.searchParams.get("revision")) !== PSU_HOLD.revision ||
    url.searchParams.get("instance") !== PSU_HOLD.instance
  ) {
    return json({ state: previewPsuState(), ok: false, message: "State changed. Confirm again." }, 409);
  }
  if (action !== "stop" && (!PSU_HOLD.enabled || PSU_HOLD.refusal)) {
    return json(
      { state: previewPsuState(), ok: false, message: PSU_HOLD.refusal ?? "Service writes unavailable" },
      409
    );
  }
  PSU_HOLD.revision++;
  PSU_HOLD.on = action !== "stop";
  PSU_HOLD.lastStopReason = action === "stop" ? "owner" : PSU_HOLD.lastStopReason;
  psuPreviewDeadline = PSU_HOLD.on ? performance.now() + 3_600_000 : 0;
  return json({
    state: previewPsuState(),
    ok: true,
    message:
      action === "stop"
        ? "PSU hold off; no new requests will be sent."
        : action === "extend"
          ? "PSU hold extended to 60 minutes from now."
          : "PSU hold on; auto-off in 60 minutes.",
  });
}
