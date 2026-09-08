// Whether `bringUpCan()` has to bounce the interface at all, decided from what `ip`
// already reports. Pure — text in, verdict out, no I/O and no clock (CLAUDE.md) — so the
// whole decision replays in scripts/check-can-bringup.ts against planted `ip` output.
//
// ⚠️ THE DOWN/UP EXISTS FOR A REASON; do not widen these conditions to skip more often.
// The kernel returns -EBUSY for bitrate, ctrlmode and restart-ms changes on a live device
// (drivers/net/can/dev/netlink.c), so taking the interface DOWN is the only way to set
// them. What makes skipping safe is not that the bounce is pointless in general — it is
// that when the link ALREADY matches what the bounce would set, running it changes
// nothing except killing every other socket on the bus. One of those sockets is the raw
// capture that every decode finding in docs/ rests on. See docs/can-capture.md.

/** The bitrate every bring-up configures. Shared with the `ip` argv so the two cannot drift. */
export const CAN_BITRATE_HZ = 500_000;

/**
 * Automatic bus-off recovery delay. Part of the configuration, so a link running with
 * `restart-ms 0` is NOT "already configured" — it would sit in BUS-OFF forever.
 */
export const CAN_RESTART_MS = 100;

/**
 * Controller states in which the link is RUNNING with the configuration we want, so a
 * bounce would change nothing about it.
 *
 * ⚠️ `ERROR-ACTIVE` is the HEALTHY state, not a fault: it means the controller is still
 * entitled to send active error frames. Excluding everything matching /ERROR-/ would
 * exclude the only state a working bus is ever in, and the skip would never fire.
 *
 * `ERROR-WARNING` (counters ≥ 96) and `ERROR-PASSIVE` (≥ 128) are bus CONDITIONS rather
 * than configuration — they decrement again on good traffic, and a down/up does not fix
 * what causes them (nothing on the bus is ACKing). A parked bike whose poller has been
 * transmitting into a sleeping bus may well sit in one, and that is the commonest deploy
 * there is, so bouncing there would kill the capture to achieve nothing.
 */
const RUNNING_DEVICE_STATES = new Set(["ERROR-ACTIVE", "ERROR-WARNING", "ERROR-PASSIVE"]);

/** The ctrlmode flag this adapter makes sticky, and the only one this decision reads. */
const LISTEN_ONLY = "LISTEN-ONLY";

export interface BringUpDecision {
  /** True only when every condition matched. Anything else takes the existing down/up. */
  skip: boolean;
  /** Always populated, on both branches — this is the sentence that reaches the journal. */
  reason: string;
  /**
   * The link could not be READ, as opposed to read and found wanting. Different sentence
   * and different log level: a mismatch is routine, an unreadable link is either a bug
   * here or an `ip` we do not understand, and it must be loud rather than quietly safe.
   */
  unreadable: boolean;
}

/** One CAN link as `ip -details -json link show` describes it, narrowed to what we decide on. */
export interface CanLinkConfig {
  up: boolean;
  /** IFF_UP without IFF_RUNNING — the driver has dropped carrier. Logged, never gating. */
  noCarrier: boolean;
  operstate: string;
  deviceState: string;
  /**
   * 0 when the link has never been configured: the kernel omits the whole bittiming
   * object until a bitrate is set (can_bittiming_fill_info), which is a fact about the
   * LINK, not about `ip`. Every cold boot looks like this, so it must read as an ordinary
   * mismatch and not as an unreadable link — that warning has to keep meaning something.
   */
  bitrateHz: number;
  restartMs: number;
  /** Empty is a real answer: iproute2 omits the key entirely when no flags are set. */
  ctrlmodes: string[];
  /** `IFLA_CAN_CTRLMODE_EXT`, absent on older kernels. Logged, never required. */
  ctrlmodeSupported: string[] | null;
}

export type CanLinkReading = { kind: "read"; link: CanLinkConfig } | { kind: "unreadable"; why: string };

/**
 * The whole decision: parse `ip -details -json link show <iface>` and say whether the
 * down/up can be skipped. Never throws — malformed input is a verdict, not an exception,
 * because the caller's fallback is the same either way and the REASON is the useful part.
 *
 * ⚠️ Takes `active` — the SAME argument `bringUpCan()` was called with — rather than a
 * pre-computed expectation, so that `active` ↔ `listen-only` is negated in exactly one
 * place and that place is covered by scripts/check-can-bringup.ts. When the polarity
 * lived in the caller instead, inverting it passed every check in the repo while leaving
 * a script that documents itself as transmitting NOTHING running on a TX-enabled bus.
 */
export function decideCanBringUp(ipOutput: string, active: boolean): BringUpDecision {
  const reading = parseCanLinkConfig(ipOutput);
  if (reading.kind === "unreadable") {
    return { skip: false, reason: reading.why, unreadable: true };
  }
  const link = reading.link;
  const wantListenOnly = !active;
  const listenOnly = link.ctrlmodes.includes(LISTEN_ONLY);
  const mismatches: string[] = [];
  if (!link.up) {
    mismatches.push(`link is not UP (operstate ${link.operstate})`);
  }
  if (!RUNNING_DEVICE_STATES.has(link.deviceState)) {
    mismatches.push(`controller state is ${link.deviceState}`);
  }
  if (link.bitrateHz !== CAN_BITRATE_HZ) {
    mismatches.push(`bitrate is ${link.bitrateHz}, not ${CAN_BITRATE_HZ}`);
  }
  if (link.restartMs !== CAN_RESTART_MS) {
    mismatches.push(`restart-ms is ${link.restartMs}, not ${CAN_RESTART_MS}`);
  }
  // ⚠️ Both directions. Two callers ask for listen-only ON, and a bus left ACTIVE is not
  // an acceptable substitute for one they asked to be silent.
  if (listenOnly !== wantListenOnly) {
    mismatches.push(`listen-only is ${listenOnly ? "ON" : "OFF"}, wanted ${wantListenOnly ? "ON" : "OFF"}`);
  }
  if (mismatches.length > 0) {
    return { skip: false, reason: mismatches.join("; "), unreadable: false };
  }
  return { skip: true, reason: describe(link), unreadable: false };
}

/**
 * `ip -details -json link show <iface>` → the fields the decision needs.
 *
 * ⚠️ The guard chain below is what makes an ABSENT `ctrlmode` readable as "no ctrlmode
 * flags set". iproute2 prints that array only when at least one flag is set (its
 * print_ctrlmode() returns early on zero), so a healthy ACTIVE link carries no such key
 * at all — but so would output from an `ip` too old to render CAN details, and reading
 * THAT as "listen-only is off" on an adapter where the flag is sticky is how the bike
 * ends up silently unable to transmit. Requiring info_kind, state and restart_ms first is
 * the positive evidence that this `ip` renders the CAN block, and therefore that the missing
 * array means empty rather than unsupported. Deliberately NOT the bitrate: the kernel omits
 * that until one is set, so demanding it would classify every cold boot as unreadable.
 */
export function parseCanLinkConfig(ipOutput: string): CanLinkReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ipOutput);
  } catch (error) {
    const head = ipOutput.trim().slice(0, 80);
    return unreadable(`\`ip\` did not return JSON (${(error as Error).message}); output began ${JSON.stringify(head)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return unreadable("`ip` returned no interface object — does the interface exist?");
  }
  const entry = asRecord(parsed[0]);
  if (!entry) {
    return unreadable("the first element of `ip`'s array is not an object");
  }
  const linkInfo = asRecord(entry.linkinfo);
  if (!linkInfo) {
    return unreadable("no `linkinfo` in the output — was `ip` run without -details?");
  }
  const kind = asString(linkInfo.info_kind);
  if (kind !== "can") {
    return unreadable(`linkinfo.info_kind is ${JSON.stringify(kind)}, not "can" — this is not a CAN device`);
  }
  const info = asRecord(linkInfo.info_data);
  if (!info) {
    return unreadable(
      "no `linkinfo.info_data` — this iproute2 does not render CAN details, so ctrlmode cannot be trusted"
    );
  }
  const deviceState = asString(info.state);
  if (deviceState === null) {
    return unreadable("no `info_data.state` — cannot tell a running controller from a stopped one");
  }
  const restartMs = asNumber(info.restart_ms);
  if (restartMs === null) {
    return unreadable("no `info_data.restart_ms` — cannot tell whether bus-off recovery is configured");
  }
  const ctrlmodes = readCtrlmodes(info.ctrlmode);
  if (ctrlmodes === null) {
    return unreadable("`info_data.ctrlmode` is present but is not an array of strings");
  }
  const flags = asStringArray(entry.flags) ?? [];
  return {
    kind: "read",
    link: {
      up: flags.includes("UP"),
      noCarrier: flags.includes("NO-CARRIER"),
      operstate: asString(entry.operstate) ?? "UNKNOWN",
      deviceState,
      bitrateHz: bitrateOf(info),
      restartMs,
      ctrlmodes,
      ctrlmodeSupported: asStringArray(info.ctrlmode_supported),
    },
  };
}

/**
 * The `ip link set` arguments that configure the interface, as an argv array.
 *
 * ⚠️ INVARIANT: one skip condition per argument this function sets. Sharing the two
 * constants with the comparison keeps their VALUES from drifting, but the property SET is
 * what actually bites — add `one-shot` or a pinned sample-point here without adding a
 * condition to decideCanBringUp() and the skip starts firing on a bus configured differently
 * from the one this would have produced. That direction is both dangerous and silent.
 */
export function canConfigureArgs(iface: string, active: boolean): string[] {
  return [
    "link",
    "set",
    iface,
    "type",
    "can",
    "bitrate",
    String(CAN_BITRATE_HZ),
    "restart-ms",
    String(CAN_RESTART_MS),
    "listen-only",
    active ? "off" : "on",
  ];
}

/**
 * What was found, field by field, so one journal line explains the whole verdict.
 *
 * ⚠️ This line is the only instrument the change is verified by on a real bike, so every
 * field it can carry, it carries — `ctrlmode_supported` because it is positive proof this
 * `ip` renders ctrlmode arrays at all (which is what makes an ABSENT `ctrlmode` readable
 * as "no flags"), and NO-CARRIER because a bus-off-cycling adapter reads ERROR-ACTIVE on
 * most samples while carrying it, and the first deploy is the cheapest chance to see that.
 */
function describe(link: CanLinkConfig): string {
  const supported = link.ctrlmodeSupported ? ` ctrlmode_supported=[${link.ctrlmodeSupported.join(",")}]` : "";
  return (
    `state=${link.deviceState} operstate=${link.operstate}${link.noCarrier ? " NO-CARRIER" : ""} ` +
    `bitrate=${link.bitrateHz} restart_ms=${link.restartMs} ctrlmode=[${link.ctrlmodes.join(",")}]${supported}`
  );
}

/**
 * The bitrate, from either place iproute2 puts it, or 0 when it says nothing: `bittiming`
 * is suppressed for drivers advertising a fixed bitrate list, which publish
 * `bittiming_bitrate` instead, and BOTH are absent on a link that has never been
 * configured. The Korlan's `usb_8dev` uses bittiming_const, so it takes the first branch.
 */
function bitrateOf(info: Record<string, unknown>): number {
  const bittiming = asRecord(info.bittiming);
  return (bittiming ? asNumber(bittiming.bitrate) : null) ?? asNumber(info.bittiming_bitrate) ?? 0;
}

/**
 * `[]` for an absent key — the guard chain above is what makes that readable as "no flags
 * set" rather than "this `ip` does not render them" — but `null` for a key that is present
 * and the wrong shape. Absence is evidence here; a malformed array is not, and every other
 * guard in this file treats an unexpected shape as unreadable.
 */
function readCtrlmodes(value: unknown): string[] | null {
  return value === undefined ? [] : asStringArray(value);
}

function unreadable(why: string): CanLinkReading {
  return { kind: "unreadable", why };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Strict, like every other guard here: one non-string entry makes the whole array unreadable. */
function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === "string")) {
    return null;
  }
  return value;
}
