// What the wifi logging and the dump builder must do, checked against output captured
// off this Pi rather than invented. docs/wifi.md has the 2026-09-19 diagnosis these
// exist for; docs/diagnostics-and-checks.md describes this file.
//
// Nothing here starts a process or touches a radio: src/wifi/parse.ts and
// src/wifi/diag.ts are pure, and that is the whole reason they are separate from
// src/wifi/nmcli.ts and src/wifi/collect.ts.

import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SIGNALS } from "../src/can/registry.ts";
import { durabilityCounters } from "../src/storage/durable.ts";
import { FRESH_MS } from "../src/http/status.ts";
import { REDACTED, buildWifiDump, redactSecrets } from "../src/wifi/diag.ts";
import { JOURNAL_MAX_LINES, readOnlyCommands } from "../src/wifi/collect.ts";
import { MAX_OUTPUT_BYTES, runCommand } from "../src/wifi/nmcli.ts";
import { WIFI_DIAG_KEEP, dumpFilename, dumpsToRemove, writeDumpText } from "../src/wifi/dump.ts";
import {
  WIFI_DUMP_MIN_GAP_MS,
  WIFI_FAULT_DUMP_AFTER_MS,
  WIFI_POLL_MS,
  WIFI_POLL_TIMEOUT_MS,
  describeState,
  shouldDumpNow,
  signalsToRecord,
} from "../src/wifi/status.ts";
import {
  WIFI_LINK_STATE,
  WIFI_NETWORK,
  parseDeviceState,
  parseWifiList,
  parseWifiProfileNames,
  splitTerseFields,
} from "../src/wifi/parse.ts";
import { isPlausible } from "../public/lib/bounds.js";
import { fallbackBoundsFor } from "../public/lib/bounds-rules.js";

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

// The SHAPE is captured verbatim from the Pi on 2026-09-19 — `-t` escapes the separator
// INSIDE a value, which is the trap under test. The identifiers are NOT: every SSID and
// BSSID here is synthetic.
//
// ⚠️ A real BSSID is a coordinate by another name. Wifi-positioning databases key a street
// address off an access point's MAC, so committing the one on Daniel's wall to a public
// repo geolocates his home as surely as a latitude would — the rule docs/route-map.md
// states for coordinates, in a form that does not look like one. These are locally
// administered (`02:` prefix), so they can never collide with a real AP either.
const WIFI_LIST_SHAPE = [
  "yes:home-wifi:54:2472 MHz:02\\:00\\:5E\\:00\\:53\\:01",
  "no:home-wifi:49:2472 MHz:02\\:00\\:5E\\:00\\:53\\:02",
].join("\n");

check("a BSSID's escaped colons stay inside one field", splitTerseFields(WIFI_LIST_SHAPE.split("\n")[0]).length === 5);
check(
  "…and the BSSID comes back with its colons",
  splitTerseFields(WIFI_LIST_SHAPE.split("\n")[0])[4] === "02:00:5E:00:53:01"
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

const onHome = parseWifiList(WIFI_LIST_SHAPE, "phone-hotspot");
check("the active row's SSID is read", onHome.activeSsid === "home-wifi");
check("…and its signal", onHome.signalPercent === 54);
check("the hotspot is correctly absent from the home list", onHome.hotspotSeen === false);
check("on another network, wifi_network is OTHER", onHome.network === WIFI_NETWORK.OTHER);

// The pathological reading: the hotspot IS in range and we are NOT on it. This is the
// shape of the 2026-09-19 failure and the reason `wifi_hotspot_seen` exists at all.
const strandedList = [
  "no:phone-hotspot:71:2437 MHz:02\\:00\\:5E\\:00\\:53\\:11",
  "no:home-wifi:31:2472 MHz:02\\:00\\:5E\\:00\\:53\\:01",
].join("\n");
const stranded = parseWifiList(strandedList, "phone-hotspot");
check("stranded: the hotspot is seen", stranded.hotspotSeen === true);
check("stranded: nothing is active", stranded.activeSsid === null);
check("stranded: wifi_network is NONE", stranded.network === WIFI_NETWORK.NONE);

const onHotspot = parseWifiList("yes:phone-hotspot:88:2437 MHz", "phone-hotspot");
check("on the hotspot, wifi_network is HOTSPOT", onHotspot.network === WIFI_NETWORK.HOTSPOT);
check("…and hotspot_seen is set by the active row too", onHotspot.hotspotSeen === true);
check("an empty list says nothing rather than something", parseWifiList("", "phone-hotspot").hotspotSeen === false);

// --- 4. The dump: failures reported, secrets not -------------------------------------

console.log("\n4. the dump builder");

const FAKE_PSK = "hunter2-not-a-real-key";
const dump = buildWifiDump({
  at: Date.UTC(2026, 8, 19, 10, 48, 52),
  uptimeSeconds: 318,
  results: [
    {
      command: "/usr/bin/nmcli -f ALL connection show phone-hotspot",
      exitCode: 0,
      // ⚠️ The fixture CARRIES a secret. A redaction test whose input has nothing to
      // redact passes with the redactor deleted, which is the assertion-that-cannot-fail
      // this repo has been bitten by before.
      stdout: `802-11-wireless-security.psk:                 ${FAKE_PSK}\n802-11-wireless.ssid:                    phone-hotspot`,
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
check("a non-secret value on the same block survives", dump.includes("phone-hotspot"));
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

const commands = readOnlyCommands("wlan0", ["Wi-Fi connection 2", "home-wifi"]);
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
// ⚠️ A profile is addressed by NAME. NetworkManager 1.52.1's nmc_find_connection() matches
// uuid/id/path/filename and has no SSID arm, so `connection show phone-hotspot` can only
// answer "unknown connection" — this Pi's profile is called "Wi-Fi connection 2".
check(
  "per-profile detail is asked for by PROFILE NAME",
  flat.some(line => line.includes("connection show Wi-Fi connection 2"))
);
check("…and never by SSID", !flat.some(line => line.includes("connection show phone-hotspot")));
check(
  "a Pi with no saved wifi profiles still produces the rest of the dump",
  readOnlyCommands("wlan0", []).length === commands.length - 2
);

console.log("\n5b. resolving the profile names");

// Captured shape of `nmcli -t -f NAME,TYPE connection show` on this Pi.
const PROFILE_LISTING = [
  "home-wifi:802-11-wireless",
  "lo:loopback",
  "airbnb-chimp:802-11-wireless",
  "Wi-Fi connection 2:802-11-wireless",
].join("\n");
check("only the wifi profiles are picked out", parseWifiProfileNames(PROFILE_LISTING).length === 3);
check(
  "…including the hotspot's oddly-named one",
  parseWifiProfileNames(PROFILE_LISTING).includes("Wi-Fi connection 2")
);
check("…and loopback is not one of them", !parseWifiProfileNames(PROFILE_LISTING).includes("lo"));
check(
  "a profile name containing a colon survives",
  parseWifiProfileNames("pub\\:wifi:802-11-wireless")[0] === "pub:wifi"
);
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

// --- 5c. runCommand never throws, and never swallows -------------------------------

console.log("\n5c. the command rail itself");

// Real children. /bin/echo and /bin/sh exist on macOS and on the Pi, so this runs
// everywhere the suite does — and the point is precisely that the rail is not simulated.
const ok = await runCommand("/bin/echo", ["hello"], 5_000);
check("a successful command reports exit 0 and its output", ok.exitCode === 0 && ok.stdout.trim() === "hello");
check("…and a non-negative elapsed time", Number.isFinite(ok.elapsedMs) && ok.elapsedMs >= 0);

const failed = await runCommand("/bin/sh", ["-c", "echo oops >&2; exit 3"], 5_000);
check("a non-zero exit comes back as a NUMBER, not a throw", failed.exitCode === 3);
// ⚠️ Never swallow errors: the stderr is what a reader of the dump needs.
check("…with its stderr intact", failed.stderr.includes("oops"));

// ENOENT: execFile's `code` is a STRING here, so there is no numeric exit status to
// report. It must still resolve, and it must still say something.
const missing = await runCommand("/usr/bin/definitely-not-a-real-binary-xyz", [], 5_000);
check("a missing binary resolves rather than throwing", missing.exitCode === null);
check("…and says why, rather than coming back blank", missing.stderr.trim() !== "");

const slow = await runCommand("/bin/sh", ["-c", "sleep 5"], 300);
check("a timeout resolves and is flagged", slow.timedOut === true);
check("…and is not mistaken for a truncation", slow.truncated === false);

// --- 6. The signals, resolved through the registry rather than spelled ----------------

console.log("\n6. bounds, resolved the way the dashboard resolves them");

// ⚠️ No `wifi_signal_pct`: see src/can/registry.ts. A percent key has no honest value
// while disconnected, so it would drag this group's /status liveness through the fault.
//
// ⚠️ THE RAIL IS `fallbackBoundsFor`, NOT `boundsFor`. boundsFor() consults the generated
// per-key table FIRST, so once a key has an entry there the group argument is inert —
// `boundsFor("wifi_link_state", "", "diag")` still answers [0, 3]. What the `wifi` group
// actually buys is that these keys reach NO fallback rule, which is what makes
// generate-signal-bounds.ts refuse an undeclared one. Resolved from the registry entry so
// a group move turns this red rather than only turning the generator red.
const WIFI_KEYS: [key: string, topCode: number][] = [
  ["wifi_link_state", 3],
  ["wifi_network", 2],
  ["wifi_hotspot_seen", 1],
];
for (const [key, topCode] of WIFI_KEYS) {
  const signal = SIGNALS.find(entry => entry.key === key);
  check(`${key} is registered`, signal !== undefined);
  if (signal === undefined) {
    continue;
  }
  check(`…in a group of its own, not a BOOLEAN_GROUP`, signal.group === "wifi");
  check(`…and polled`, signal.source === "poll");
  check(
    `…whose group reaches no fallback rule, so the generator must refuse it undeclared`,
    fallbackBoundsFor(signal.key, signal.unit, signal.group) === null
  );
  // The consequence: the whole range each code can take is plausible. `wifi_link_state`
  // reaching 3 is an ordinary connected bike; under `diag`'s [0, 1] gate with its bounds
  // dropped, the dashboard would draw it as a dead sensor.
  check(`…and ${key} = ${topCode} is plausible`, isPlausible(signal.key, topCode, signal.unit, signal.group));
}

check(
  "no percent signal joined the group, which would read dark through the fault",
  SIGNALS.every(entry => entry.group !== "wifi" || entry.unit === "")
);
// Every wifi signal is written on EVERY successful poll, so the group is either fully
// live or genuinely unknown — never permanently part-dark on a healthy bike.
check(
  "no wifi signal is onDemand, so none of them can be silent by design",
  SIGNALS.filter(entry => entry.group === "wifi").every(entry => entry.onDemand === undefined)
);

// --- 7. The poll interval is a contract with /status, not a preference ----------------

console.log("\n7. the poll interval against FRESH_MS");

// ⚠️ Read OFF src/http/status.ts rather than compared to a second literal 10_000. The
// previous shape of this idea in check-hold-gestures.ts was green for every value of
// either number until it was made to read the real one.
check(`the wifi poll (${WIFI_POLL_MS} ms) is faster than FRESH_MS (${FRESH_MS} ms)`, WIFI_POLL_MS < FRESH_MS);
// ⚠️ THE SECOND HALF, and the one that was missing. Two nmcli calls run per cycle, so a
// cycle can last 2 × the per-call ceiling; if that exceeds the interval the re-entrancy
// guard skips a tick, and two skipped ticks compound into a hole past FRESH_MS. At the
// 5 s ceiling this file shipped with, the worst gap was 16 s against a 10 s window.
check(
  `a timing-out cycle (2 × ${WIFI_POLL_TIMEOUT_MS} ms) still cannot skip a tick`,
  2 * WIFI_POLL_TIMEOUT_MS < WIFI_POLL_MS
);
// And a margin over the HEALTHY cycle, which is what the contract is really about. A
// cycle that times out is allowed to read dark: then we genuinely cannot say.
check("…with a second of margin over the healthy cycle", FRESH_MS - WIFI_POLL_MS >= 1000);

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

// ⚠️ The DIRECTION is the whole of the prune, and a mutation that deleted the newest
// survived until this existed. Named oldest-first so the expectation is readable.
const dumps = ["2026-09-17T08-00-00-000Z.txt", "2026-09-18T08-00-00-000Z.txt", "2026-09-19T08-00-00-000Z.txt"];
check("with room to spare, nothing is removed", dumpsToRemove(dumps, 5).length === 0);
check("over the cap, the OLDEST goes", dumpsToRemove(dumps, 2).length === 1 && dumpsToRemove(dumps, 2)[0] === dumps[0]);
check("…and the newest is never chosen", !dumpsToRemove(dumps, 1).includes(dumps[2]));
check("…in order, oldest first", dumpsToRemove(dumps, 1).join(",") === `${dumps[0]},${dumps[1]}`);
check("files that are not dumps are left alone", dumpsToRemove([...dumps, "README"], 0).length === 3);

console.log("\n9. when a fault is worth a dump");

// ⚠️ Two minutes, so ordinary roaming cannot reach it: NetworkManager retried after
// twelve of thirteen failures on 2026-09-19, the quickest in 0.6 s.
check("a momentary drop takes no dump", !shouldDumpNow(30_000, null));
check("a drop just under the threshold takes no dump", !shouldDumpNow(WIFI_FAULT_DUMP_AFTER_MS - 1, null));
check("a sustained fault takes one", shouldDumpNow(WIFI_FAULT_DUMP_AFTER_MS, null));
check("…and not a second one straight after", !shouldDumpNow(10 * 60_000, 60_000));
check("…but does again once the gap has passed", shouldDumpNow(40 * 60_000, WIFI_DUMP_MIN_GAP_MS));
// ⚠️ Deliberately BELOW the longest ordinary retry seen (14 min 58 s on 2026-09-19), not
// above it: those long gaps are the same fault class and each is worth a dump. What the
// threshold has to clear is a roam, which is seconds.
check("the threshold sits below the longest ordinary retry gap", WIFI_FAULT_DUMP_AFTER_MS < 14 * 60_000);
check("…and well above any roam", WIFI_FAULT_DUMP_AFTER_MS > 30_000);

console.log("\n10. a failed read claims nothing");

// ⚠️ The rule the whole diagnosis turns on. `wifi_hotspot_seen = 0` means "the hotspot is
// not in range"; a failed nmcli means "we cannot say", and those are opposite claims.
const goodRead = { activeSsid: null, signalPercent: null, hotspotSeen: true, network: WIFI_NETWORK.NONE };
check("a good read records all three", signalsToRecord(WIFI_LINK_STATE.DISCONNECTED, goodRead).length === 3);
check(
  "a failed LIST read records neither hotspot_seen nor network",
  signalsToRecord(WIFI_LINK_STATE.DISCONNECTED, null).every(([key]) => key === "wifi_link_state")
);
check(
  "…and specifically never writes a 0 for hotspot_seen",
  !signalsToRecord(WIFI_LINK_STATE.DISCONNECTED, null).some(([key]) => key === "wifi_hotspot_seen")
);
check(
  "a failed DEVICE read records no link state",
  !signalsToRecord(null, goodRead).some(([key]) => key === "wifi_link_state")
);
check("both reads failing records nothing at all", signalsToRecord(null, null).length === 0);
check(
  "every key it emits is one the registry declares",
  signalsToRecord(WIFI_LINK_STATE.CONNECTED, goodRead).every(([key]) =>
    SIGNALS.some(entry => entry.key === key && entry.group === "wifi")
  )
);

console.log("\n11. no real network identifier reaches this repo");

// ⚠️ A real BSSID geolocates a building through wifi-positioning databases, which makes it
// the same thing docs/route-map.md forbids as a coordinate, in a form that does not look
// like one. Locally-administered addresses (bit 1 of the first octet set — second nibble
// 2, 6, A or E) are reserved for exactly this and can never collide with a real AP.
const fixtureBssids = [...WIFI_LIST_SHAPE.matchAll(/([0-9A-F]{2})(?:\\?:[0-9A-F]{2}){5}/g)].map(match => match[0]);
check("the fixture actually contains BSSIDs to check", fixtureBssids.length >= 2);
check(
  "every BSSID in the fixtures is locally administered, so none is a real access point",
  fixtureBssids.every(bssid => "26AE".includes(bssid[1].toUpperCase()))
);

console.log("\n11b. an unset WIFI_HOTSPOT_SSID fails loudly, not silently");

// ⚠️ The code carries no default SSID — a public repo is no place for somebody's network
// name — so "not configured" is a state that reaches a running Pi, and it must not look
// like "the hotspot is not in range".
check(
  "with no SSID configured, the sentence says so rather than inventing a hotspot",
  describeState(WIFI_LINK_STATE.DISCONNECTED, null, false).includes("WIFI_HOTSPOT_SSID") &&
    !describeState(WIFI_LINK_STATE.DISCONNECTED, null, false).includes("hotspot not in range")
);
check(
  "…and a connected bike still reads as connected",
  describeState(WIFI_LINK_STATE.CONNECTED, null, false).includes("connected")
);
check(
  "…while a configured one keeps the sentence that matters",
  describeState(WIFI_LINK_STATE.DISCONNECTED, goodRead, true) === "NOT connected, and the hotspot IS in range"
);

console.log("\n11c. the journal sentence never reports our own failure as the bike's");

// ⚠️ A failed nmcli is not a state of the radio. An earlier version said "radio
// unavailable" whenever the LIST call failed on a perfectly connected bike.
check("a failed device read says so", describeState(null, null).includes("cannot say"));
check(
  "connected with no list still says connected",
  describeState(WIFI_LINK_STATE.CONNECTED, null).includes("connected") &&
    !describeState(WIFI_LINK_STATE.CONNECTED, null).includes("unavailable")
);
check(
  "disconnected with no list does not claim the hotspot is absent",
  !describeState(WIFI_LINK_STATE.DISCONNECTED, null).includes("hotspot not in range")
);
check(
  "the sentence worth having",
  describeState(WIFI_LINK_STATE.DISCONNECTED, goodRead) === "NOT connected, and the hotspot IS in range"
);

console.log("\n12. the dump survives a key-off cut");

// ⚠️ The reason this file is under the checkout and not in /tmp is that the bike cuts
// 12 V at key-off. A plain writeFile leaves up to 30 s of ext4 delalloc in which i_size
// says the bytes are there and the blocks read NUL (docs/power-cuts.md) — so the one
// failure this location was chosen to survive would be the one its write path does not.
// Driven through writeDumpText, the real call site, for the reason
// check-power-cut-durability.ts §4 gives: calling the helper directly would only assert
// that the helper calls itself.
const durabilityDir = await mkdtemp(join(tmpdir(), "wifi-diag-check-"));
const beforeWrite = durabilityCounters();
const writtenPath = await writeDumpText(durabilityDir, Date.UTC(2026, 8, 19, 10, 48, 52), "a dump");
const afterWrite = durabilityCounters();
check("the dump is written", writtenPath !== null);
check("…through the durable path, flushing the file", afterWrite.flushes - beforeWrite.flushes === 1);
check("…and the directory that now holds it", afterWrite.directorySyncs - beforeWrite.directorySyncs === 1);
check("…and it reads back", writtenPath !== null && (await readFile(writtenPath, "utf8")) === "a dump");

// replaceFileDurably renames from `<name>.txt.tmp`, which does not end in `.txt` — so
// without the orphan arm a cut between write and rename leaves a file the prune can
// never reap, for the life of the card.
check("a `.txt.tmp` orphan is reaped", dumpsToRemove(["a.txt", "b.txt.tmp"], 20).includes("b.txt.tmp"));
check("…even when nothing else is over the cap", dumpsToRemove(["b.txt.tmp"], 20).length === 1);
check("…and a real dump under the cap still is not", !dumpsToRemove(["a.txt", "b.txt.tmp"], 20).includes("a.txt"));
await rm(durabilityDir, { recursive: true, force: true });

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
