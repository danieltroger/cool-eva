// What the wifi logging and the dump builder must do, checked against output captured
// off this Pi rather than invented. docs/wifi.md has the 2026-09-19 diagnosis these
// exist for; docs/diagnostics-and-checks.md describes this file.
//
// Nothing here starts a process or touches a radio: src/wifi/parse.ts and
// src/wifi/diag.ts are pure, and that is the whole reason they are separate from
// src/wifi/nmcli.ts and src/wifi/collect.ts.

import { SIGNALS } from "../src/can/registry.ts";
import { FRESH_MS } from "../src/http/status.ts";
import { REDACTED, buildWifiDump, redactSecrets } from "../src/wifi/diag.ts";
import { JOURNAL_MAX_LINES, readOnlyCommands } from "../src/wifi/collect.ts";
import { MAX_OUTPUT_BYTES } from "../src/wifi/nmcli.ts";
import { WIFI_DIAG_KEEP, dumpFilename } from "../src/wifi/dump.ts";
import { WIFI_POLL_MS } from "../src/wifi/status.ts";
import {
  WIFI_LINK_STATE,
  WIFI_NETWORK,
  classifyNetwork,
  parseDeviceState,
  parseWifiList,
  splitTerseFields,
} from "../src/wifi/parse.ts";
import { boundsFor, isPlausible } from "../public/lib/bounds.js";

let failures = 0;

function check(what: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✓ ${what}`);
  } else {
    // ⚠️ stderr AND an exit code. A mutation harness that greps stdout for "FAILED"
    // reports a false green on a check whose failures only ever went to stdout.
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

// --- 1. The terse-field splitter, which is where a parser quietly goes wrong ----------

console.log("\n1. `nmcli -t` escaping");

// Captured verbatim from the Pi on 2026-09-19. `-t` escapes the separator INSIDE a value.
const REAL_WIFI_LIST = [
  "yes:Martin Router King:54:2472 MHz:CC\\:BA\\:BD\\:34\\:31\\:92",
  "no:Martin Router King:49:2472 MHz:AA\\:29\\:48\\:2D\\:74\\:3A",
].join("\n");

check("a BSSID's escaped colons stay inside one field", splitTerseFields(REAL_WIFI_LIST.split("\n")[0]).length === 5);
check(
  "…and the BSSID comes back with its colons",
  splitTerseFields(REAL_WIFI_LIST.split("\n")[0])[4] === "CC:BA:BD:34:31:92"
);
// ⚠️ An SSID may contain a colon, and a hotspot can be renamed at any time. A naive
// split reads this row as six fields and puts "juice" where the signal belongs.
check(
  "an SSID containing a colon is one field",
  splitTerseFields("yes:orange\\:juice:71").length === 3 &&
    splitTerseFields("yes:orange\\:juice:71")[1] === "orange:juice"
);
check("an escaped backslash survives", splitTerseFields("a:b\\\\c")[1] === "b\\c");

// --- 2. Device state, folded from libnm's own numbers ---------------------------------

console.log("\n2. GENERAL.STATE");

// ⚠️ The field is a NUMBER AND A WORD. Number("100 (connected)") is NaN.
check(
  "the captured connected line reads CONNECTED",
  parseDeviceState("GENERAL.STATE:100 (connected)") === WIFI_LINK_STATE.CONNECTED
);
check("30 disconnected", parseDeviceState("GENERAL.STATE:30 (disconnected)") === WIFI_LINK_STATE.DISCONNECTED);
// The state the 2026-09-19 latch left the device in. It is NOT "unavailable": the radio
// worked the whole time, which is exactly what made the failure invisible.
check(
  "120 failed is DISCONNECTED, not UNAVAILABLE",
  parseDeviceState("GENERAL.STATE:120 (failed)") === WIFI_LINK_STATE.DISCONNECTED
);
check(
  "110 deactivating is DISCONNECTED",
  parseDeviceState("GENERAL.STATE:110 (deactivating)") === WIFI_LINK_STATE.DISCONNECTED
);
check("50 config is CONNECTING", parseDeviceState("GENERAL.STATE:50 (config)") === WIFI_LINK_STATE.CONNECTING);
check("60 need-auth is CONNECTING", parseDeviceState("GENERAL.STATE:60 (need auth)") === WIFI_LINK_STATE.CONNECTING);
check("20 unavailable", parseDeviceState("GENERAL.STATE:20 (unavailable)") === WIFI_LINK_STATE.UNAVAILABLE);
check("10 unmanaged is UNAVAILABLE", parseDeviceState("GENERAL.STATE:10 (unmanaged)") === WIFI_LINK_STATE.UNAVAILABLE);
check(
  "a missing field does not claim a link",
  parseDeviceState("GENERAL.CONNECTION:whatever") === WIFI_LINK_STATE.UNAVAILABLE
);
check("unparseable does not claim a link", parseDeviceState("GENERAL.STATE:banana") === WIFI_LINK_STATE.UNAVAILABLE);

// --- 3. The list, and the one reading the whole feature turns on ----------------------

console.log("\n3. the scan list");

const onHome = parseWifiList(REAL_WIFI_LIST, "orange-juice");
check("the active row's SSID is read", onHome.activeSsid === "Martin Router King");
check("…and its signal", onHome.signalPercent === 54);
check("the hotspot is correctly absent from the home list", onHome.hotspotSeen === false);
check(
  "on another network, wifi_network is OTHER",
  classifyNetwork(onHome.activeSsid, "orange-juice") === WIFI_NETWORK.OTHER
);

// The pathological reading: the hotspot IS in range and we are NOT on it. This is the
// shape of the 2026-09-19 failure and the reason `wifi_hotspot_seen` exists at all.
const strandedList = [
  "no:orange-juice:71:2437 MHz:8E\\:A4\\:6A\\:E1\\:35\\:97",
  "no:Martin Router King:31:2472 MHz:CC\\:BA\\:BD\\:34\\:31\\:92",
].join("\n");
const stranded = parseWifiList(strandedList, "orange-juice");
check("stranded: the hotspot is seen", stranded.hotspotSeen === true);
check("stranded: nothing is active", stranded.activeSsid === null);
check("stranded: wifi_network is NONE", classifyNetwork(stranded.activeSsid, "orange-juice") === WIFI_NETWORK.NONE);

const onHotspot = parseWifiList("yes:orange-juice:88:2437 MHz", "orange-juice");
check(
  "on the hotspot, wifi_network is HOTSPOT",
  classifyNetwork(onHotspot.activeSsid, "orange-juice") === WIFI_NETWORK.HOTSPOT
);
check("…and hotspot_seen is set by the active row too", onHotspot.hotspotSeen === true);
check("an empty list says nothing rather than something", parseWifiList("", "orange-juice").hotspotSeen === false);

// --- 4. The dump: failures reported, secrets not -------------------------------------

console.log("\n4. the dump builder");

const FAKE_PSK = "hunter2-not-a-real-key";
const dump = buildWifiDump({
  at: Date.UTC(2026, 8, 19, 10, 48, 52),
  uptimeSeconds: 318,
  results: [
    {
      command: "/usr/bin/nmcli -f ALL connection show orange-juice",
      exitCode: 0,
      // ⚠️ The fixture CARRIES a secret. A redaction test whose input has nothing to
      // redact passes with the redactor deleted, which is the assertion-that-cannot-fail
      // this repo has been bitten by before.
      stdout: `802-11-wireless-security.psk:                 ${FAKE_PSK}\n802-11-wireless.ssid:                    orange-juice`,
      stderr: "",
      elapsedMs: 61,
      timedOut: false,
      truncated: false,
    },
    {
      command: "/usr/sbin/iw dev wlan0 link",
      exitCode: 237,
      stdout: "",
      stderr: "command failed: No such device (-19)",
      elapsedMs: 8,
      timedOut: false,
      truncated: false,
    },
    {
      command: "/usr/bin/journalctl -u NetworkManager",
      exitCode: null,
      stdout: "one line that arrived",
      stderr: "",
      elapsedMs: 10_000,
      timedOut: true,
      truncated: true,
    },
  ],
});

check("the secret is gone from the whole dump", !dump.includes(FAKE_PSK));
check(
  "…and the setting it was on is still visible",
  dump.includes("802-11-wireless-security.psk") && dump.includes(REDACTED)
);
check("a non-secret value on the same block survives", dump.includes("orange-juice"));
// Never swallow errors: a failed command's exit code AND its stderr reach the file.
check("a failed command's exit code is in the dump", dump.includes("exit 237"));
check("…and its stderr", dump.includes("No such device (-19)"));
check("a timeout announces itself", dump.includes("TIMED OUT"));
check("a truncation announces itself rather than looking complete", dump.includes("TRUNCATED"));
check(
  "the header names the commands that went wrong",
  dump.includes("problems:") && dump.includes("/usr/sbin/iw dev wlan0 link")
);
check(
  "a command with no output says so",
  buildWifiDump({
    at: 0,
    uptimeSeconds: 0,
    results: [{ command: "x", exitCode: 0, stdout: "", stderr: "", elapsedMs: 1, timedOut: false, truncated: false }],
  }).includes("(no output)")
);

// The redactor on its own, including the case that must NOT be touched.
check("a psk line is redacted", redactSecrets("psk=abc123").includes(REDACTED));
check("nmcli's own <hidden> needs no help", redactSecrets("802-11-wireless-security.psk: <hidden>").includes(REDACTED));
check(
  "a line merely mentioning a word is left alone",
  redactSecrets("wrote password policy doc") === "wrote password policy doc"
);

// --- 5. The command list is read-only, and stays that way ----------------------------

console.log("\n5. every collected command is a read");

const commands = readOnlyCommands("wlan0", "orange-juice");
const flat = commands.map(([file, args]) => [file, ...args].join(" "));
// ⚠️ The rail. A dump must be safe to take at any moment, including mid-charge on a
// healthy link. The forced rejoin is a separate, deliberate act.
for (const forbidden of [
  "connection up",
  "connection down",
  "device disconnect",
  "device connect",
  "radio wifi off",
  "networking off",
  "connection modify",
  "connection delete",
]) {
  check(`no command in the dump does \`${forbidden}\``, !flat.some(line => line.includes(forbidden)));
}
// A forced scan costs airtime and can disturb an association — the opposite of a diagnostic.
check(
  "the wifi list reads the cache (`--rescan no`)",
  flat.some(line => line.includes("device wifi list") && line.includes("--rescan no"))
);
check("no command forces a rescan", !flat.some(line => line.includes("device wifi rescan")));
check(
  "`iw scan` is the cached `scan dump`",
  flat.some(line => line.includes("scan dump")) && !flat.some(line => /\bscan$/.test(line))
);
// The one control that actually keeps the PSK out of the file.
check("the connection dump never asks for secrets", !flat.some(line => line.includes("--show-secrets")));
// The command that would have answered 2026-09-19 without an ssh.
check(
  "the journal is collected",
  flat.some(line => line.includes("journalctl") && line.includes("NetworkManager") && line.includes("wpa_supplicant"))
);
check(
  "…and is bounded by lines as well as by time",
  flat.some(line => line.includes(`--lines ${JOURNAL_MAX_LINES}`))
);
check(
  "absolute paths throughout, since /usr/sbin is not on a non-login PATH",
  commands.every(([file]) => file.startsWith("/"))
);
check("the buffer is larger than Node's 1 MB default", MAX_OUTPUT_BYTES > 1024 * 1024);

// --- 6. The signals, resolved through the registry rather than spelled ----------------

console.log("\n6. bounds, resolved the way the dashboard resolves them");

const WIFI_KEYS = ["wifi_link_state", "wifi_network", "wifi_hotspot_seen", "wifi_signal_pct"];
for (const key of WIFI_KEYS) {
  // ⚠️ unit and group come from the REGISTRY ENTRY and are never written out here. A
  // check that spells `boundsFor(key, "", "wifi")` stays green after the registry moves
  // the key into `diag` — which is the single mutation it exists to catch.
  const signal = SIGNALS.find(entry => entry.key === key);
  check(`${key} is registered`, signal !== undefined);
  if (signal === undefined) {
    continue;
  }
  check(`…in a group of its own, not a BOOLEAN_GROUP`, signal.group === "wifi");
  check(`…and polled`, signal.source === "poll");
}

// The whole range each code can take must be plausible. `wifi_link_state` reaching 3 is
// an ordinary connected bike; under `diag`'s [0, 1] gate the dashboard would draw it as a
// dead sensor, and the ride log would keep the row while the phone showed a fault.
const linkStateSignal = SIGNALS.find(entry => entry.key === "wifi_link_state");
check(
  "wifi_link_state = 3 (connected) is plausible",
  linkStateSignal !== undefined && isPlausible(linkStateSignal.key, 3, linkStateSignal.unit, linkStateSignal.group)
);
const networkSignal = SIGNALS.find(entry => entry.key === "wifi_network");
check(
  "wifi_network = 2 (some other network) is plausible",
  networkSignal !== undefined && isPlausible(networkSignal.key, 2, networkSignal.unit, networkSignal.group)
);
check(
  "wifi_signal_pct reaches the % rule rather than a flag gate",
  (() => {
    const signal = SIGNALS.find(entry => entry.key === "wifi_signal_pct");
    if (signal === undefined) {
      return false;
    }
    const range = boundsFor(signal.key, signal.unit, signal.group);
    return range !== null && range[0] === 0 && range[1] === 100;
  })()
);

// --- 7. The poll interval is a contract with /status, not a preference ----------------

console.log("\n7. the poll interval against FRESH_MS");

// ⚠️ Read OFF src/http/status.ts rather than compared to a second literal 10_000. The
// previous shape of this idea in check-hold-gestures.ts was green for every value of
// either number until it was made to read the real one.
check(`the wifi poll (${WIFI_POLL_MS} ms) is faster than FRESH_MS (${FRESH_MS} ms)`, WIFI_POLL_MS < FRESH_MS);
// A margin, not just an inequality: one cycle costs ~282 ms of wall time on the Pi and a
// cold nmcli is slower still, so a poll that only just clears the window would read dark
// whenever the machine is busy.
check("…with at least a second of margin for a slow cycle", FRESH_MS - WIFI_POLL_MS >= 1000);

// --- 8. The dump directory cannot grow without end -----------------------------------

console.log("\n8. dump filenames and the prune");

check("a dump filename carries no colons", !dumpFilename(Date.UTC(2026, 8, 19, 10, 48, 52)).includes(":"));
// The prune sorts lexically and takes the tail, so the name must sort chronologically.
check(
  "filenames sort chronologically as strings",
  dumpFilename(Date.UTC(2026, 8, 19, 9, 0, 0)) < dumpFilename(Date.UTC(2026, 8, 19, 10, 0, 0))
);
check(
  "…across a year boundary too",
  dumpFilename(Date.UTC(2026, 11, 31, 23, 0, 0)) < dumpFilename(Date.UTC(2027, 0, 1, 1, 0, 0))
);
check("a bounded number of dumps is kept", WIFI_DIAG_KEEP > 0 && WIFI_DIAG_KEEP <= 100);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ an escaped colon stays inside its field, a failed device state never claims a link, and");
  console.log("  'the hotspot is in range and we are not on it' is readable from the signals alone;");
  console.log("  a secret in the input is absent from the dump while the setting it sat on is still");
  console.log("  visible, and a failed, timed-out or truncated command says so rather than looking");
  console.log("  complete; every collected command is a read; and the poll is faster than the");
  console.log("  freshness window /status judges liveness by.");
}
