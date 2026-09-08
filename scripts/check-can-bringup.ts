import {
  CAN_BITRATE_HZ,
  CAN_RESTART_MS,
  canConfigureArgs,
  decideCanBringUp,
  parseCanLinkConfig,
  type WantedCanLink,
} from "../src/can/link-config.ts";

// Covers the decision behind `bringUpCan()`: when can0 may be left alone, and when it
// must be bounced. The bounce kills every other socket on the bus — including the raw
// capture behind can-capture.service, which is why issue #160 was opened — so a skip that
// fires too eagerly leaves the bike misconfigured, and one that never fires leaves the
// hole open. Both directions are asserted here.
//
//     node --experimental-strip-types scripts/check-can-bringup.ts
//
// ⚠️ THE FIXTURES ARE SYNTHETIC. Every `ip -details -json link show can0` body below was
// written by hand from the iproute2 output format, NOT captured from the Pi — the bike
// was powered down when this was written. So this proves the decision logic is
// self-consistent; it does NOT prove the field names match what this Pi's `ip` emits.
// Only the first deploy's journal line can do that. When real output arrives, replace
// UP_ACTIVE with it verbatim and this check becomes evidence rather than reasoning.
// docs/can-capture.md records which is which.

const WANT_ACTIVE: WantedCanLink = { bitrateHz: CAN_BITRATE_HZ, restartMs: CAN_RESTART_MS, listenOnly: false };
const WANT_LISTEN_ONLY: WantedCanLink = { bitrateHz: CAN_BITRATE_HZ, restartMs: CAN_RESTART_MS, listenOnly: true };

/**
 * One `ip` body. `ctrlmode` is OMITTED rather than empty when no flags are set — that is
 * what iproute2 really does, and reproducing it is the point of these fixtures rather
 * than an accident of how they were written.
 */
function linkJson(overrides: {
  flags?: string[];
  operstate?: string;
  state?: string;
  bitrate?: number | null;
  bitrateFlat?: number;
  restartMs?: number | null;
  ctrlmode?: string[];
  ctrlmodeSupported?: string[];
  infoKind?: string;
  omitInfoData?: boolean;
}): string {
  const infoData: Record<string, unknown> = {};
  if (overrides.state !== undefined) {
    infoData.state = overrides.state;
  }
  if (overrides.ctrlmode) {
    infoData.ctrlmode = overrides.ctrlmode;
  }
  if (overrides.ctrlmodeSupported) {
    infoData.ctrlmode_supported = overrides.ctrlmodeSupported;
  }
  if (overrides.restartMs !== null) {
    infoData.restart_ms = overrides.restartMs ?? CAN_RESTART_MS;
  }
  if (overrides.bitrateFlat !== undefined) {
    infoData.bittiming_bitrate = overrides.bitrateFlat;
  } else if (overrides.bitrate !== null) {
    infoData.bittiming = { bitrate: overrides.bitrate ?? CAN_BITRATE_HZ, sample_point: "0.875" };
  }
  const linkinfo: Record<string, unknown> = { info_kind: overrides.infoKind ?? "can" };
  if (!overrides.omitInfoData) {
    linkinfo.info_data = infoData;
  }
  return JSON.stringify([
    {
      ifindex: 3,
      ifname: "can0",
      flags: overrides.flags ?? ["NOARP", "UP", "LOWER_UP", "ECHO"],
      mtu: 16,
      operstate: overrides.operstate ?? "UP",
      link_type: "can",
      linkinfo,
    },
  ]);
}

/** A healthy, ACTIVE bus: the state a deploy finds, and the one the whole change exists for. */
const UP_ACTIVE = linkJson({ state: "ERROR-ACTIVE" });

interface Case {
  name: string;
  json: string;
  wanted: WantedCanLink;
  skip: boolean;
  /** Substring the reason must contain — so a verdict cannot be right for the wrong reason. */
  because: string;
  unreadable?: boolean;
}

const CASES: Case[] = [
  { name: "up, ACTIVE, wanted ACTIVE", json: UP_ACTIVE, wanted: WANT_ACTIVE, skip: true, because: "ERROR-ACTIVE" },
  // ⚠️ The asymmetry, both ways. Two scripts ask for listen-only ON, and a bus left
  // ACTIVE is not an acceptable substitute for one asked to stay silent.
  {
    name: "up, ACTIVE, wanted listen-only",
    json: UP_ACTIVE,
    wanted: WANT_LISTEN_ONLY,
    skip: false,
    because: "listen-only is OFF, wanted ON",
  },
  {
    name: "up, LISTEN-ONLY set, wanted ACTIVE",
    json: linkJson({ state: "ERROR-ACTIVE", ctrlmode: ["LISTEN-ONLY"] }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "listen-only is ON, wanted OFF",
  },
  {
    name: "up, LISTEN-ONLY set, wanted listen-only",
    json: linkJson({ state: "ERROR-ACTIVE", ctrlmode: ["LISTEN-ONLY"] }),
    wanted: WANT_LISTEN_ONLY,
    skip: true,
    because: "LISTEN-ONLY",
  },
  // The two states a parked bike can reach when its poller transmits into a bus nothing
  // is ACKing. Both are running-with-our-configuration, so both skip: refusing here would
  // exclude the commonest deploy there is. docs/can-capture.md §"Which states skip".
  {
    name: "ERROR-WARNING skips",
    json: linkJson({ state: "ERROR-WARNING" }),
    wanted: WANT_ACTIVE,
    skip: true,
    because: "ERROR-WARNING",
  },
  {
    name: "ERROR-PASSIVE skips",
    json: linkJson({ state: "ERROR-PASSIVE" }),
    wanted: WANT_ACTIVE,
    skip: true,
    because: "ERROR-PASSIVE",
  },
  {
    name: "BUS-OFF bounces",
    json: linkJson({ state: "BUS-OFF" }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "controller state is BUS-OFF",
  },
  {
    name: "STOPPED bounces",
    json: linkJson({ state: "STOPPED", flags: ["NOARP", "ECHO"], operstate: "DOWN" }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "link is not UP",
  },
  {
    name: "SLEEPING bounces",
    json: linkJson({ state: "SLEEPING" }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "controller state is SLEEPING",
  },
  {
    name: "wrong bitrate bounces",
    json: linkJson({ state: "ERROR-ACTIVE", bitrate: 250_000 }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "bitrate is 250000",
  },
  // restart-ms 0 means no automatic bus-off recovery: configured, but not the way we
  // configure it, so it is not "already there".
  {
    name: "restart-ms 0 bounces",
    json: linkJson({ state: "ERROR-ACTIVE", restartMs: 0 }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "restart-ms is 0",
  },
  // A fixed-bitrate driver publishes bittiming_bitrate and no bittiming object at all.
  // Without this branch the feature would be silently inert on such an adapter.
  {
    name: "flat bittiming_bitrate is accepted",
    json: linkJson({ state: "ERROR-ACTIVE", bitrate: null, bitrateFlat: CAN_BITRATE_HZ }),
    wanted: WANT_ACTIVE,
    skip: true,
    because: "ERROR-ACTIVE",
  },
  // ⚠️ THE ONE THAT MATTERS MOST. An `ip` that renders no CAN details also renders no
  // ctrlmode array — and reading that absence as "listen-only is off", on an adapter
  // where the flag is sticky, is how the bike ends up silently unable to transmit.
  {
    name: "missing info_data is unreadable, not healthy",
    json: linkJson({ omitInfoData: true }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "info_data",
    unreadable: true,
  },
  {
    name: "missing state is unreadable",
    json: linkJson({ bitrate: CAN_BITRATE_HZ }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "info_data.state",
    unreadable: true,
  },
  {
    name: "no bitrate anywhere is unreadable, and names both keys",
    json: linkJson({ state: "ERROR-ACTIVE", bitrate: null }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "bittiming_bitrate",
    unreadable: true,
  },
  {
    name: "missing restart_ms is unreadable",
    json: linkJson({ state: "ERROR-ACTIVE", restartMs: null }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: "restart_ms",
    unreadable: true,
  },
  {
    name: "a non-CAN device is unreadable",
    json: linkJson({ state: "ERROR-ACTIVE", infoKind: "vcan" }),
    wanted: WANT_ACTIVE,
    skip: false,
    because: 'not "can"',
    unreadable: true,
  },
  {
    name: "empty output is unreadable",
    json: "",
    wanted: WANT_ACTIVE,
    skip: false,
    because: "did not return JSON",
    unreadable: true,
  },
  {
    name: "the text (non-JSON) form is unreadable",
    json: "3: can0: <NOARP,UP,LOWER_UP,ECHO> mtu 16 qdisc pfifo_fast state UP mode DEFAULT",
    wanted: WANT_ACTIVE,
    skip: false,
    because: "did not return JSON",
    unreadable: true,
  },
  {
    name: "an empty array is unreadable",
    json: "[]",
    wanted: WANT_ACTIVE,
    skip: false,
    because: "no interface object",
    unreadable: true,
  },
];

const failures: string[] = [];

for (const testCase of CASES) {
  const decision = decideCanBringUp(testCase.json, testCase.wanted);
  if (decision.skip !== testCase.skip) {
    failures.push(`${testCase.name}: expected skip=${testCase.skip}, got ${decision.skip} (${decision.reason})`);
  }
  if (!decision.reason.includes(testCase.because)) {
    failures.push(
      `${testCase.name}: reason should mention ${JSON.stringify(testCase.because)}, got "${decision.reason}"`
    );
  }
  if (decision.reason.trim().length === 0) {
    failures.push(`${testCase.name}: empty reason — a silent verdict is unreviewable in a journal`);
  }
  if (decision.unreadable !== Boolean(testCase.unreadable)) {
    failures.push(`${testCase.name}: expected unreadable=${Boolean(testCase.unreadable)}, got ${decision.unreadable}`);
  }
}

// ⚠️ An unreadable link must NEVER skip. Everything else here is a judgement about how
// eager to be; this one is the difference between failing safe and failing silent.
for (const testCase of CASES.filter(entry => entry.unreadable)) {
  if (decideCanBringUp(testCase.json, WANT_LISTEN_ONLY).skip) {
    failures.push(`${testCase.name}: skipped despite being unreadable, under the listen-only want too`);
  }
}

// The `ip` argv and the skip's expectations must come from the same constants. Two
// spellings of 500000 drift in the dangerous direction: a skip that fires on a bus
// configured differently from what we would have set.
const activeArgs = canConfigureArgs("can0", true);
const listenArgs = canConfigureArgs("can0", false);
if (!activeArgs.includes(String(CAN_BITRATE_HZ)) || !activeArgs.includes(String(CAN_RESTART_MS))) {
  failures.push(`the configure argv does not carry the shared constants: ${activeArgs.join(" ")}`);
}
if (
  activeArgs.join(" ") !==
  `link set can0 type can bitrate ${CAN_BITRATE_HZ} restart-ms ${CAN_RESTART_MS} listen-only off`
) {
  failures.push(`unexpected configure argv: ${activeArgs.join(" ")}`);
}
if (listenArgs.at(-1) !== "on") {
  failures.push(`listen-only was not requested for a passive bring-up: ${listenArgs.join(" ")}`);
}
// argv, not a shell string: an interface name is never re-parsed by a shell.
for (const argument of [...activeArgs, ...listenArgs]) {
  if (/[;&|$`<>]/.test(argument)) {
    failures.push(`configure argv element looks shell-ish: ${JSON.stringify(argument)}`);
  }
}

// The parser is exported and used directly here as well, so a future caller that wants
// the fields rather than the verdict is covered by the same fixtures.
const healthy = parseCanLinkConfig(UP_ACTIVE);
if (healthy.kind !== "read") {
  failures.push(`the healthy fixture did not parse: ${healthy.kind === "unreadable" ? healthy.why : ""}`);
} else if (healthy.link.ctrlmodes.length !== 0 || !healthy.link.up || healthy.link.bitrateHz !== CAN_BITRATE_HZ) {
  failures.push(`the healthy fixture parsed wrongly: ${JSON.stringify(healthy.link)}`);
}
// ctrlmode_supported is opportunistic: present on newer kernels, and never required.
const withSupported = parseCanLinkConfig(
  linkJson({ state: "ERROR-ACTIVE", ctrlmodeSupported: ["LOOPBACK", "LISTEN-ONLY"] })
);
if (withSupported.kind === "read" && withSupported.link.ctrlmodeSupported?.includes("LISTEN-ONLY") !== true) {
  failures.push("ctrlmode_supported was not read when present");
}
if (
  !decideCanBringUp(
    linkJson({ state: "ERROR-ACTIVE", ctrlmodeSupported: ["LISTEN-ONLY"] }),
    WANT_ACTIVE
  ).reason.includes("ctrlmode_supported")
) {
  failures.push(
    "ctrlmode_supported was not logged in the skip reason, so the journal cannot corroborate the ctrlmode reading"
  );
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(`\n✓ ${CASES.length} bring-up decisions, the shared 500000/100 constants and the argv shape`);
