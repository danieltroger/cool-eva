import { readFile } from "fs/promises";
import {
  CAN_BITRATE_HZ,
  CAN_RESTART_MS,
  canConfigureArgs,
  decideCanBringUp,
  parseCanLinkConfig,
} from "../src/can/link-config.ts";

// Covers the decision behind `bringUpCan()`: when can0 may be left alone, and when it must
// be bounced. The bounce kills every other socket on the bus — including the raw capture
// behind can-capture.service, which is why issue #160 was opened — so a skip that fires too
// eagerly leaves the bike misconfigured, and one that never fires leaves the hole open.
// Both directions are asserted here.
//
//     node --experimental-strip-types scripts/check-can-bringup.ts
//
// ⚠️ TWO KINDS OF FIXTURE, kept apart on purpose — the split this repo already draws
// between captured-freeze-frames.ts and freeze-frame-fixtures.ts.
//
// CAPTURED_PI_LINK is real `ip` output from the bike, and it is what proves the field names
// are right. Everything built by link() below is SYNTHETIC, written from the iproute2 output
// format, and covers the shapes the Pi did not produce — bus-off, listen-only, a malformed
// ctrlmode, an `ip` too old to render CAN details. Those prove the decision logic is
// self-consistent and prove nothing about the wire. docs/can-capture.md says which is which.

/**
 * ⚠️ CAPTURED, byte for byte — `ip -details -json link show can0` on the bike's Pi,
 * 2026-09-08 20:13 CEST, bus awake, ~4 min after a cold boot, on the pre-#171 code.
 * Issue #160's gather comment.
 *
 * This is the fixture that turns the design's two riskiest bets into evidence. The bus
 * reads **ERROR-WARNING** (one rx error) rather than ERROR-ACTIVE, so a skip conditioned on
 * ERROR-ACTIVE alone — which is what this change was originally specified as — would refuse
 * here and the whole feature would be a no-op that logs. And `ctrlmode` is absent while
 * `ctrlmode_supported` is present, which is exactly the shape link-config.ts has to read as
 * "no flags set", now confirmed on the hardware rather than argued from iproute2 source.
 */
const CAPTURED_PI_LINK = `[{"ifindex":2,"ifname":"can0","flags":["NOARP","UP","LOWER_UP","ECHO"],"mtu":16,"qdisc":"pfifo_fast","operstate":"UP","linkmode":"DEFAULT","group":"default","txqlen":10,"link_type":"can","promiscuity":0,"allmulti":0,"min_mtu":0,"max_mtu":0,"linkinfo":{"info_kind":"can","info_data":{"ctrlmode_supported":["LOOPBACK","LISTEN-ONLY","ONE-SHOT","CC-LEN8-DLC"],"state":"ERROR-WARNING","berr_counter":{"tx":0,"rx":1},"restart_ms":100,"bittiming":{"bitrate":500000,"sample_point":"0.875","tq":125,"prop_seg":6,"phase_seg1":7,"phase_seg2":2,"sjw":1,"brp":4},"bittiming_const":{"name":"usb_8dev","tseg1":{"min":1,"max":16},"tseg2":{"min":1,"max":8},"sjw":{"min":1,"max":4},"brp":{"min":1,"max":1024},"brp_inc":1},"clock":32000000}},"num_tx_queues":1,"num_rx_queues":1,"gso_max_size":65536,"gso_max_segs":65535,"tso_max_size":65536,"tso_max_segs":65535,"gro_max_size":65536,"gso_ipv4_max_size":65536,"gro_ipv4_max_size":65536,"parentbus":"usb","parentdev":"1-1:1.0"}]`;

/** A healthy, configured, ACTIVE CAN link — what a deploy finds, and what the change is for. */
const DEFAULT_INFO_DATA: Record<string, unknown> = {
  state: "ERROR-ACTIVE",
  restart_ms: CAN_RESTART_MS,
  bittiming: { bitrate: CAN_BITRATE_HZ, sample_point: "0.875" },
};

const DEFAULT_ENTRY: Record<string, unknown> = {
  ifindex: 3,
  ifname: "can0",
  flags: ["NOARP", "UP", "LOWER_UP", "ECHO"],
  mtu: 16,
  operstate: "UP",
  link_type: "can",
};

/** An administratively down interface, as `ip` renders one. */
const DOWN: Record<string, unknown> = { flags: ["NOARP", "ECHO"], operstate: "DOWN" };

/**
 * One `ip` body: the healthy shapes above, with the overrides spread over them.
 *
 * ⚠️ `undefined` REMOVES a key, because that is what JSON.stringify does with one — which is
 * how a fixture says "this iproute2 emitted no bittiming at all". `infoData: null` drops the
 * whole `info_data` object, i.e. an `ip` that does not render CAN details.
 *
 * ⚠️ `ctrlmode` is absent from the defaults on purpose. iproute2 prints that array only when
 * a flag is set, so a healthy ACTIVE link carries no such key — reproducing that absence is
 * the single most important thing these fixtures do.
 */
function link(
  infoData: Record<string, unknown> | null = {},
  entry: Record<string, unknown> = {},
  infoKind: string | undefined = "can"
): string {
  return JSON.stringify([
    {
      ...DEFAULT_ENTRY,
      ...entry,
      linkinfo: { info_kind: infoKind, info_data: infoData && { ...DEFAULT_INFO_DATA, ...infoData } },
    },
  ]);
}

const UP_ACTIVE = link();

interface Case {
  name: string;
  json: string;
  /** Exactly what `bringUpCan(iface, active)` was called with — not a derived expectation. */
  active: boolean;
  skip: boolean;
  /** Substring the reason must contain — so a verdict cannot be right for the wrong reason. */
  because: string;
  unreadable?: boolean;
}

const CASES: Case[] = [
  // The real bike, both polarities. Not a variant of the synthetic cases below — this is
  // the only entry here whose bytes came off the Pi.
  {
    name: "the captured Pi link skips when ACTIVE is wanted",
    json: CAPTURED_PI_LINK,
    active: true,
    skip: true,
    because: "state=ERROR-WARNING",
  },
  {
    name: "the captured Pi link bounces when listen-only is wanted",
    json: CAPTURED_PI_LINK,
    active: false,
    skip: false,
    because: "listen-only is OFF, wanted ON",
  },
  { name: "up, ACTIVE, wanted ACTIVE", json: UP_ACTIVE, active: true, skip: true, because: "ERROR-ACTIVE" },
  // ⚠️ The asymmetry, both ways. Two scripts ask for listen-only ON, and a bus left ACTIVE is
  // not an acceptable substitute for one asked to stay silent.
  {
    name: "up, ACTIVE, wanted listen-only",
    json: UP_ACTIVE,
    active: false,
    skip: false,
    because: "listen-only is OFF, wanted ON",
  },
  {
    name: "up, LISTEN-ONLY set, wanted ACTIVE",
    json: link({ ctrlmode: ["LISTEN-ONLY"] }),
    active: true,
    skip: false,
    because: "listen-only is ON, wanted OFF",
  },
  {
    name: "up, LISTEN-ONLY set, wanted listen-only",
    json: link({ ctrlmode: ["LISTEN-ONLY"] }),
    active: false,
    skip: true,
    because: "LISTEN-ONLY",
  },
  // The two states a parked bike can reach when its poller transmits into a bus nothing is
  // ACKing. Both are running-with-our-configuration, so both skip: refusing here would
  // exclude the commonest deploy there is. docs/can-capture.md §"Which states skip".
  {
    name: "ERROR-WARNING skips",
    json: link({ state: "ERROR-WARNING" }),
    active: true,
    skip: true,
    because: "ERROR-WARNING",
  },
  {
    name: "ERROR-PASSIVE skips",
    json: link({ state: "ERROR-PASSIVE" }),
    active: true,
    skip: true,
    because: "ERROR-PASSIVE",
  },
  {
    name: "BUS-OFF bounces",
    json: link({ state: "BUS-OFF" }),
    active: true,
    skip: false,
    because: "controller state is BUS-OFF",
  },
  {
    name: "an admin-down link bounces",
    json: link({ state: "STOPPED" }, DOWN),
    active: true,
    skip: false,
    because: "link is not UP",
  },
  // Admin-UP but STOPPED: isolates the controller-state check, which the case above cannot,
  // because there the link is also down and either condition alone would catch it.
  {
    name: "STOPPED bounces even when the link is admin-UP",
    json: link({ state: "STOPPED" }),
    active: true,
    skip: false,
    because: "controller state is STOPPED",
  },
  {
    name: "SLEEPING bounces",
    json: link({ state: "SLEEPING" }),
    active: true,
    skip: false,
    because: "controller state is SLEEPING",
  },
  {
    name: "wrong bitrate bounces",
    json: link({ bittiming: { bitrate: 250_000 } }),
    active: true,
    skip: false,
    because: "bitrate is 250000",
  },
  // restart-ms 0 means no automatic bus-off recovery: configured, but not the way we
  // configure it, so it is not "already there".
  {
    name: "restart-ms 0 bounces",
    json: link({ restart_ms: 0 }),
    active: true,
    skip: false,
    because: "restart-ms is 0",
  },
  // A fixed-bitrate driver publishes bittiming_bitrate and no bittiming object at all.
  // Without this branch the feature would be silently inert on such an adapter.
  {
    name: "flat bittiming_bitrate is accepted",
    json: link({ bittiming: undefined, bittiming_bitrate: CAN_BITRATE_HZ }),
    active: true,
    skip: true,
    because: "ERROR-ACTIVE",
  },
  // ⚠️ THE SHAPE THE SERVICE MEETS MOST OFTEN. The Pi loses power with the bike, so every
  // start is a cold boot, and the kernel omits bittiming entirely until a bitrate is set
  // (can_bittiming_fill_info). That is a fact about the LINK — an ordinary mismatch — and
  // must NOT be classified unreadable, or the one warning reserved for "an `ip` we do not
  // understand" fires on every power-up wearing the words the first deploy watches for.
  {
    name: "a never-configured can0 is a routine mismatch, not unreadable",
    json: link({ state: "STOPPED", restart_ms: 0, bittiming: undefined }, DOWN),
    active: true,
    skip: false,
    because: "bitrate is 0, not 500000",
    unreadable: false,
  },
  // ⚠️ THE ONE THAT MATTERS MOST. An `ip` that renders no CAN details also renders no
  // ctrlmode array — and reading that absence as "listen-only is off", on an adapter where
  // the flag is sticky, is how the bike ends up silently unable to transmit.
  {
    name: "missing info_data is unreadable, not healthy",
    json: link(null),
    active: true,
    skip: false,
    because: "info_data",
    unreadable: true,
  },
  {
    name: "missing state is unreadable",
    json: link({ state: undefined }),
    active: true,
    skip: false,
    because: "info_data.state",
    unreadable: true,
  },
  {
    name: "missing restart_ms is unreadable",
    json: link({ restart_ms: undefined }),
    active: true,
    skip: false,
    because: "restart_ms",
    unreadable: true,
  },
  {
    name: "a non-CAN device is unreadable",
    json: link({}, {}, "vcan"),
    active: true,
    skip: false,
    because: 'not "can"',
    unreadable: true,
  },
  // Every other guard here treats an unexpected shape as unreadable; ctrlmode is the one
  // place where a MISSING key is read as a positive fact, so a key that is present and
  // malformed must not quietly take the same path.
  {
    name: "a malformed ctrlmode is unreadable, not empty",
    json: link({ ctrlmode: [5] }),
    active: true,
    skip: false,
    because: "not an array of strings",
    unreadable: true,
  },
  {
    name: "empty output is unreadable",
    json: "",
    active: true,
    skip: false,
    because: "did not return JSON",
    unreadable: true,
  },
  {
    name: "the text (non-JSON) form is unreadable",
    json: "3: can0: <NOARP,UP,LOWER_UP,ECHO> mtu 16 qdisc pfifo_fast state UP mode DEFAULT",
    active: true,
    skip: false,
    because: "did not return JSON",
    unreadable: true,
  },
  {
    name: "an empty array is unreadable",
    json: "[]",
    active: true,
    skip: false,
    because: "no interface object",
    unreadable: true,
  },
];

const failures: string[] = [];

for (const testCase of CASES) {
  const decision = decideCanBringUp(testCase.json, testCase.active);
  if (decision.skip !== testCase.skip) {
    failures.push(`${testCase.name}: expected skip=${testCase.skip}, got ${decision.skip} (${decision.reason})`);
  }
  if (!decision.reason.includes(testCase.because)) {
    failures.push(
      `${testCase.name}: reason should mention ${JSON.stringify(testCase.because)}, got "${decision.reason}"`
    );
  }
  if (decision.unreadable !== Boolean(testCase.unreadable)) {
    failures.push(`${testCase.name}: expected unreadable=${Boolean(testCase.unreadable)}, got ${decision.unreadable}`);
  }
}

// ⚠️ The skip reason IS the E2E instrument: docs/can-capture.md quotes it, and the first
// deploy is read against it. Losing a field would be completely silent, so every one the
// operator is told to look for is asserted rather than only the state name.
const skipReason = decideCanBringUp(UP_ACTIVE, true).reason;
for (const field of [
  "state=ERROR-ACTIVE",
  "operstate=UP",
  `bitrate=${CAN_BITRATE_HZ}`,
  `restart_ms=${CAN_RESTART_MS}`,
  "ctrlmode=[]",
]) {
  if (!skipReason.includes(field)) {
    failures.push(`the skip journal line has lost ${field} — it reads "${skipReason}"`);
  }
}
// ctrlmode_supported is what turns "the array is absent" from an inference into evidence, so
// the journal has to carry it when the kernel offers it.
if (
  !decideCanBringUp(link({ ctrlmode_supported: ["LOOPBACK", "LISTEN-ONLY"] }), true).reason.includes(
    "ctrlmode_supported"
  )
) {
  failures.push(
    "ctrlmode_supported was not logged in the skip reason, so the journal cannot corroborate the ctrlmode reading"
  );
}
// NO-CARRIER is never gated on (it is driver-dependent) but must be VISIBLE when set: on a
// bus-off-cycling adapter the controller state reads ERROR-ACTIVE on most samples anyway.
const carrierless = decideCanBringUp(link({}, { flags: ["NOARP", "NO-CARRIER", "UP"] }), true);
if (!carrierless.skip || !carrierless.reason.includes("NO-CARRIER")) {
  failures.push(`NO-CARRIER should be logged and not gated on: skip=${carrierless.skip}, "${carrierless.reason}"`);
}

// ⚠️ An unreadable link must NEVER skip. Everything else here is a judgement about how eager
// to be; this one is the difference between failing safe and failing silent.
for (const testCase of CASES.filter(entry => entry.unreadable)) {
  if (decideCanBringUp(testCase.json, false).skip) {
    failures.push(`${testCase.name}: skipped despite being unreadable, under the listen-only want too`);
  }
}

// `ip link show can0` names one interface, so an array of two is contrived — but reading the
// wrong end of it is a one-character mistake and every other fixture here has one element.
const twoInterfaces = `[${UP_ACTIVE.slice(1, -1)},${link({ state: "BUS-OFF" }).slice(1, -1)}]`;
if (!decideCanBringUp(twoInterfaces, true).skip) {
  failures.push("the decision did not read the FIRST interface object in `ip`'s array");
}

// The `ip` argv and the skip's expectations must come from the same constants: two spellings
// of 500000 drift in the dangerous direction, a skip firing on a bus configured differently
// from what we would have set.
const activeArgs = canConfigureArgs("can0", true);
const listenArgs = canConfigureArgs("can0", false);
const expectedArgs = `link set can0 type can bitrate ${CAN_BITRATE_HZ} restart-ms ${CAN_RESTART_MS} listen-only off`;
if (activeArgs.join(" ") !== expectedArgs) {
  failures.push(`unexpected configure argv: ${activeArgs.join(" ")}`);
}
// Not redundant with the exact match above: an argv collapsed into ONE space-joined string
// still joins to the same text, and that is precisely the shell-string regression to catch.
if (!activeArgs.includes(String(CAN_BITRATE_HZ)) || !activeArgs.includes(String(CAN_RESTART_MS))) {
  failures.push(
    `the configure argv is not element-wise — it looks like a single shell string: ${JSON.stringify(activeArgs)}`
  );
}
if (listenArgs.at(-1) !== "on") {
  failures.push(`listen-only was not requested for a passive bring-up: ${listenArgs.join(" ")}`);
}
// argv, not a shell string: a hostile interface name stays ONE element and is never re-parsed.
const hostile = canConfigureArgs("can0; rm -rf /", true);
if (!hostile.includes("can0; rm -rf /")) {
  failures.push(`an interface name with shell metacharacters was split or mangled: ${JSON.stringify(hostile)}`);
}

// The parser is exported and driven directly too, so a future caller wanting the fields
// rather than the verdict is covered by the same fixtures.
const healthy = parseCanLinkConfig(UP_ACTIVE);
if (healthy.kind !== "read") {
  failures.push(`the healthy fixture did not parse: ${healthy.why}`);
} else if (healthy.link.ctrlmodes.length !== 0 || !healthy.link.up || healthy.link.bitrateHz !== CAN_BITRATE_HZ) {
  failures.push(`the healthy fixture parsed wrongly: ${JSON.stringify(healthy.link)}`);
}

// Every field the decision reads, checked against the real body rather than the verdict —
// this is what says the JSON key names in link-config.ts match what this Pi's `ip` emits.
const captured = parseCanLinkConfig(CAPTURED_PI_LINK);
if (captured.kind !== "read") {
  failures.push(`the CAPTURED Pi output no longer parses: ${captured.why}`);
} else {
  const link = captured.link;
  if (!link.up || link.operstate !== "UP" || link.bitrateHz !== CAN_BITRATE_HZ || link.restartMs !== CAN_RESTART_MS) {
    failures.push(`the captured Pi body parsed wrongly: ${JSON.stringify(link)}`);
  }
  if (link.deviceState !== "ERROR-WARNING") {
    failures.push(`the captured Pi body should read ERROR-WARNING, got ${link.deviceState}`);
  }
  // The absence that the whole design rests on, and the key that corroborates it.
  if (link.ctrlmodes.length !== 0) {
    failures.push(`the captured Pi body should carry NO ctrlmode flags, got [${link.ctrlmodes.join(",")}]`);
  }
  if (!link.ctrlmodeSupported?.includes("LISTEN-ONLY")) {
    failures.push("the captured Pi body should advertise LISTEN-ONLY in ctrlmode_supported");
  }
}

// ⚠️ Read src/can/socket.ts as TEXT, because no check can import it: it pulls in `socketcan`,
// a Linux-only optionalDependency, so a check that loaded it would not run on a laptop or in
// CI at all. That leaves the wiring from `bringUpCan(iface, active)` to the decision as the
// one part of this feature nothing can execute — and inverting it there used to be a green
// build AND a script whose own header says it transmits NOTHING running on a TX-enabled bus.
// So assert what can be asserted: `active` reaches both functions unmodified, and is never
// negated in that file. Precedent: check-irreversible-actions.ts reads src/http/vcu-write.ts
// the same way. Whitespace is collapsed first so a Prettier rewrap cannot turn this red.
const socketSource = await readFile(new URL("../src/can/socket.ts", import.meta.url), "utf8");
const collapsed = socketSource.replace(/\s+/g, " ");
const WIRING: { needle: string; why: string }[] = [
  {
    needle: "decideCanBringUp(stdout, active)",
    why: "the polarity belongs in link-config.ts, which this check can drive",
  },
  { needle: "canConfigureArgs(iface, active)", why: "the argv would stop matching the conditions the skip checks" },
  { needle: "if (decision.skip) {", why: "without it the skip never fires and the whole feature is a no-op that logs" },
  {
    needle: "if (decision.unreadable) { console.warn(",
    why: "an unreadable link must stay LOUD — demoted to console.log it reads as routine",
  },
];
for (const { needle, why } of WIRING) {
  if (!collapsed.includes(needle)) {
    failures.push(`src/can/socket.ts no longer contains \`${needle}\` — ${why}`);
  }
}
const negations = socketSource
  .split("\n")
  .filter((line: string) => !line.trim().startsWith("//") && line.includes("!active"));
if (negations.length > 0) {
  failures.push(
    `src/can/socket.ts negates \`active\` (${negations.map((line: string) => line.trim()).join(" / ")}) — that polarity is untestable there`
  );
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(`\n✓ ${CASES.length} bring-up decisions, the skip journal line, and the argv shape`);
