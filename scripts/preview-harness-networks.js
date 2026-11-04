// Synthetic Wi-Fi fixtures only; the shipped editor/status views render these responses.
const NETWORK_PURPOSE =
  new URL(window.location.href).searchParams.get("network-purpose") === "hotspot" ? "hotspot" : "home";
const NETWORK_PROFILE = {
  uuid: "00000000-0000-4000-8000-000000000001",
  name: `Synthetic ${NETWORK_PURPOSE} profile`,
  ssid: `Synthetic ${NETWORK_PURPOSE}`,
  priority: 20,
  autoconnect: true,
  authRetries: 0,
  security: "wpa-psk",
  backend: "keyfile",
  purpose: NETWORK_PURPOSE,
};
const NETWORK_CHANGE = {
  uuid: "00000000-0000-4000-8000-000000000003",
  ssid: "Synthetic replacement",
  purpose: "home",
  replaced: NETWORK_PROFILE,
  fallback: NETWORK_PROFILE,
  phase: "saved",
  checkpoint: null,
  priority: 20,
  attempts: 0,
  message: "Saved. Ready to try.",
  resumedAtBoot: false,
};
const NETWORK_SCENE = new URL(window.location.href).searchParams.get("network-state") || "list";
const NETWORKS = {
  ok: true,
  message: "",
  instanceId: "synthetic-pi",
  generation: "synthetic-process",
  revision: 0,
  settingsRevision: 0,
  profiles: [NETWORK_PROFILE],
  active: { uuid: NETWORK_PROFILE.uuid, address: "192.0.2.20" },
  change: NETWORK_SCENE === "list" || NETWORK_SCENE === "editor" ? null : { ...NETWORK_CHANGE },
  remainingMs: null,
  canKeep: false,
  viaBluetooth: true,
  observingRestoration: false,
};
let NETWORK_READS = 0;
if (NETWORKS.change) {
  if (NETWORK_SCENE === "trying") {
    NETWORKS.change.phase = "trying";
    NETWORKS.change.message = "Trying Synthetic replacement; previous connection Synthetic home remains saved.";
    NETWORKS.remainingMs = 93000;
    NETWORKS.active = null;
  } else if (NETWORK_SCENE.startsWith("waiting")) {
    NETWORKS.change.phase = "waiting";
    NETWORKS.change.message = "Pi connected to Synthetic replacement; waiting for this phone at http://192.0.2.30.";
    NETWORKS.remainingMs = 81000;
    NETWORKS.active = { uuid: NETWORK_CHANGE.uuid, address: "192.0.2.30" };
    NETWORKS.canKeep = NETWORK_SCENE === "waiting-wifi";
    NETWORKS.viaBluetooth = !NETWORKS.canKeep;
  } else if (NETWORK_SCENE === "restored") {
    NETWORKS.change.phase = "restored";
    NETWORKS.change.message = "Could not confirm Synthetic replacement. Reconnected to Synthetic home.";
  } else if (NETWORK_SCENE === "failed" || NETWORK_SCENE === "lost") {
    NETWORKS.change.phase = "failed";
    NETWORKS.change.message = "Synthetic home is still saved, but Cool Eva could not reconnect.";
    NETWORKS.active = null;
  } else if (NETWORK_SCENE === "kept") {
    NETWORKS.change.phase = "kept";
    NETWORKS.change.message =
      "New network kept. Confirmation finished after a power cut; Wi-Fi may switch at power-on.";
    NETWORKS.profiles = [
      { ...NETWORK_PROFILE, uuid: NETWORK_CHANGE.uuid, ssid: NETWORK_CHANGE.ssid, name: "Synthetic confirmed profile" },
    ];
    NETWORKS.active = { uuid: NETWORK_CHANGE.uuid, address: "192.0.2.30" };
  }
}
function networkPreview(path, method, init) {
  if (NETWORK_SCENE === "lost" && path.startsWith("/settings/networks")) {
    return json({ ok: false, message: "Lost contact with Cool Eva. Network result unconfirmed." }, 503);
  }
  if (path === "/settings/networks" && method === "GET") {
    NETWORK_READS++;
    NETWORKS.settingsRevision = SETTINGS.revision;
    return json(NETWORKS);
  }
  if (!path.startsWith("/settings/networks/")) return null;
  if (NETWORK_SCENE === "lost")
    return json({ ok: false, message: "Lost contact with Cool Eva. Network result unconfirmed." }, 503);
  if (method === "POST") {
    const body = JSON.parse(init.body || "{}");
    if (path === "/settings/networks/scan") return json({ ok: true, names: ["Synthetic home"] });
    if (path === "/settings/networks/save") {
      NETWORKS.change = { ...NETWORK_CHANGE, ssid: body.draft.ssid, purpose: body.draft.purpose };
      NETWORKS.revision++;
    } else if (path === "/settings/networks/cancel") {
      NETWORKS.change = null;
      NETWORKS.revision++;
    } else if (path === "/settings/networks/trial" && NETWORKS.change) {
      NETWORKS.change.phase = "trying";
      NETWORKS.change.message = "Trying Synthetic replacement; previous connection Synthetic home remains saved.";
      NETWORKS.remainingMs = 119000;
    } else if (path === "/settings/networks/keep" && NETWORKS.change) {
      NETWORKS.change.phase = "kept";
      NETWORKS.change.message = "New network kept.";
    } else if (path === "/settings/networks/previous" && NETWORKS.change) {
      NETWORKS.change.phase = "restored";
      NETWORKS.change.message = "Could not confirm Synthetic replacement. Reconnected to Synthetic home.";
      NETWORKS.remainingMs = null;
    }
  }
  NETWORKS.settingsRevision = SETTINGS.revision;
  return json(NETWORKS);
}
