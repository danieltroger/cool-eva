import { CHARGE_COMMAND_CAN_ID, CHARGE_REQUEST_CAN_ID } from "../src/can/charge-command.ts";
import { MAX_SOC_LIMIT_PCT, buildChargeSocLimitRead, buildChargeSocLimitWrite } from "../src/can/charge-soc-command.ts";
import { decodeChargeSocLimitFrame } from "../src/can/charge-soc-limit.ts";
import { decodeChargeSetpointFrame } from "../src/can/charge-setpoint.ts";
import { decodeFrame } from "../src/can/decode.ts";
import { parseWriteRequest } from "../src/http/vcu-write.ts";

// Holds the SOC charge-limit command and decoder against frames the BIKE put on the bus — the
// dash's own menu confirms out of the capture archive, and the live replies read on 2026-09-19.
//
//   node --experimental-strip-types scripts/check-charge-soc-limit.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments, touches no bike.
//
// ⚠️ §2 is the one that matters most and it is not obvious: the direction bit. Clear it on a write
// and nothing commits; SET it on a read and every read-back becomes a write of b2, which is 0 —
// silently removing the battery protection it was called to verify.
//
// Provenance for every fixture, and why the command is ONE frame rather than the pair the capture
// appears to show: docs/dash-command-0x2c-charge-limit.md.

const failures: string[] = [];

/** The dash's own menu confirms, byte for byte out of candump. `at` is the capture's local stamp. */
const CAPTURED_DASH_WRITES = [
  { at: "2026-08-02 21:02:15.795230", percent: 40, requestHex: "AC FF 28 00 00 00 00 00" },
  { at: "2026-09-19 16:56:23.061347", percent: 0, requestHex: "AC FF 00 00 00 00 00 00" },
  { at: "2026-09-19 16:56:31.189895", percent: 80, requestHex: "AC FF 50 00 00 00 00 00" },
];

/**
 * Every `0x121` reply this bike has been seen to give on this opcode: the three that followed the
 * dash's own menu confirms, and all SEVEN of 2026-09-19 off the Pi's capture — six answers to
 * bit-7-clear reads, plus the bike's own answer to our write. Ten in total, and the point of
 * listing every one is the zero tail: `00 00 00 00 00` in all ten is what the decoder's b3-b7
 * gate rests on, and §4 below asserts that of the fixture itself before using it as evidence.
 */
const CAPTURED_REPLIES = [
  { at: "2026-08-02 21:02:15.800319", percent: 40, hex: "2C FF 28 00 00 00 00 00" },
  { at: "2026-09-19 16:56:23.069038", percent: 0, hex: "2C FF 00 00 00 00 00 00" },
  { at: "2026-09-19 16:56:31.194391", percent: 80, hex: "2C FF 50 00 00 00 00 00" },
  { at: "2026-09-19 22:52:04.616607 read", percent: 80, hex: "2C FF 50 00 00 00 00 00" },
  { at: "2026-09-19 22:52:05.636818 read", percent: 80, hex: "2C FF 50 00 00 00 00 00" },
  { at: "2026-09-19 22:53:07.895079 read-before", percent: 80, hex: "2C FF 50 00 00 00 00 00" },
  { at: "2026-09-19 22:53:07.908354 the bike answering our write", percent: 90, hex: "2C FF 5A 00 00 00 00 00" },
  { at: "2026-09-19 22:53:07.944784 read-back", percent: 90, hex: "2C FF 5A 00 00 00 00 00" },
  { at: "2026-09-19 22:53:26.710840 read", percent: 90, hex: "2C FF 5A 00 00 00 00 00" },
  { at: "2026-09-19 22:53:27.735862 read", percent: 90, hex: "2C FF 5A 00 00 00 00 00" },
];

/**
 * Real 0x121 frames of OTHER opcodes, from the same archive: two DC current-limit commands, one
 * AC, and the stop. None of them is a charge limit and none may decode as one.
 */
const OTHER_OPCODE_FRAMES = [
  { what: "DC current limit 47 A", hex: "18 FF 2F 01 4B 00 00 00" },
  { what: "DC current limit 75 A", hex: "18 FF 4B 01 4B 00 00 00" },
  { what: "AC current limit 1 A", hex: "1A FF 01 01 0F 00 00 00" },
  { what: "charge stop", hex: "16 FF 01 00 00 00 00 00" },
];

// ── §1 the builder reproduces the bike's own request bytes ─────────────────

for (const captured of CAPTURED_DASH_WRITES) {
  const frames = buildChargeSocLimitWrite(captured.percent);
  const built = hexOf(frames[0].data);
  if (built !== captured.requestHex) {
    failures.push(
      `§1 ${captured.at}: built "${built}" for ${captured.percent} %, bus carried "${captured.requestHex}"`
    );
  }
  if (frames[0].id !== CHARGE_REQUEST_CAN_ID) {
    failures.push(`§1 ${captured.at}: built on 0x${frames[0].id.toString(16)}, not the 0x120 request id`);
  }
}
// The value actually written on 2026-09-19, which no capture holds because the Pi does not hear
// its own frames — it is here from the journal of the write that produced the 90 read back below.
if (hexOf(buildChargeSocLimitWrite(90)[0].data) !== "AC FF 5A 00 00 00 00 00") {
  failures.push(`§1 the 90 % write is not "AC FF 5A …" — it is "${hexOf(buildChargeSocLimitWrite(90)[0].data)}"`);
}

// ── §2 the direction bit, both ways, and the one-frame shape ───────────────

const writeFrames = buildChargeSocLimitWrite(90);
const readFrames = buildChargeSocLimitRead();
if ((writeFrames[0].data[0] & 0x80) === 0) {
  failures.push("§2 the WRITE has bit 7 clear — that is a read, and nothing would commit");
}
if ((readFrames[0].data[0] & 0x80) !== 0) {
  failures.push("§2 the READ has bit 7 SET — every read-back would write b2 = 0, removing the limit");
}
if (readFrames[0].data[2] !== 0) {
  failures.push(
    `§2 the READ carries b2 = ${readFrames[0].data[2]}; it must be 0 so a stray write bit cannot set a limit`
  );
}
// ⚠️ The H1 regression guard. Sending the 0x121 half as well spoofs the VCU's own answer to the
// dash — the mechanism behind "the display moved and the setpoint did not". One frame, on 0x120.
for (const [label, frames] of [
  ["write", writeFrames],
  ["read", readFrames],
] as const) {
  if (frames.length !== 1) {
    failures.push(`§2 the ${label} builds ${frames.length} frames; this command is ONE frame on 0x120`);
  }
  if (frames.some(frame => frame.id === CHARGE_COMMAND_CAN_ID)) {
    failures.push(`§2 the ${label} puts a frame on 0x121 — that id is the BIKE's to send, never ours`);
  }
}

// ── §3 the builder refuses what is not a percentage ────────────────────────

for (const bad of [MAX_SOC_LIMIT_PCT + 1, -1, 5.5, Number.NaN, 255]) {
  let threw = false;
  try {
    buildChargeSocLimitWrite(bad);
  } catch {
    threw = true;
  }
  if (!threw) {
    failures.push(`§3 the builder accepted ${bad} as a percentage`);
  }
}
// …and accepts both ends of the range it does carry, 0 included: "no limit" is a value the dash
// itself writes, and a builder that refused it could not express the bike's own state.
for (const good of [0, 1, 50, MAX_SOC_LIMIT_PCT]) {
  try {
    buildChargeSocLimitWrite(good);
  } catch (error) {
    failures.push(`§3 the builder refused ${good} %: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── §4 the decoder reads the bike's replies back ───────────────────────────

for (const reply of CAPTURED_REPLIES) {
  // The fixture's OWN tail, asserted before it is used as evidence for the gate that reads it: a
  // fixture edited to carry a non-zero b3 would otherwise quietly weaken §5's whole argument.
  if (!reply.hex.endsWith("00 00 00 00 00")) {
    failures.push(`§4 ${reply.at}: the fixture's own b3-b7 tail is not zero ("${reply.hex}")`);
  }
  const decoded = decodeChargeSocLimitFrame(bytesOf(reply.hex));
  const value = decoded.find(entry => entry.key === "charge_soc_limit_pct")?.value;
  if (value !== reply.percent) {
    failures.push(`§4 ${reply.at}: "${reply.hex}" decoded to ${value ?? "nothing"}, expected ${reply.percent}`);
  }
}

// ── §5 the decoder's gates, one broken byte at a time ──────────────────────

const GOOD = "2C FF 5A 00 00 00 00 00";
const REJECTED: { what: string; hex: string }[] = [
  { what: "a short frame", hex: "2C FF 5A 00 00 00 00" },
  { what: "a different opcode", hex: "1D FF 5A 00 00 00 00 00" },
  { what: "no 0xFF separator", hex: "2C 01 5A 00 00 00 00 00" },
  { what: "101 %", hex: "2C FF 65 00 00 00 00 00" },
  { what: "b3 in use", hex: "2C FF 5A 01 00 00 00 00" },
  { what: "b4 in use", hex: "2C FF 5A 00 4B 00 00 00" },
  { what: "a tail in use", hex: "2C FF 5A 00 00 00 00 01" },
];
if (decodeChargeSocLimitFrame(bytesOf(GOOD)).length !== 1) {
  failures.push(`§5 the control frame "${GOOD}" does not decode — every rejection below proves nothing`);
}
for (const rejected of REJECTED) {
  if (decodeChargeSocLimitFrame(bytesOf(rejected.hex)).length !== 0) {
    failures.push(`§5 ${rejected.what} ("${rejected.hex}") decoded as a charge limit`);
  }
}

// ── §6 no cross-talk, in BOTH directions, on the shared id ─────────────────

for (const other of OTHER_OPCODE_FRAMES) {
  if (decodeChargeSocLimitFrame(bytesOf(other.hex)).length !== 0) {
    failures.push(`§6 ${other.what} ("${other.hex}") decoded as a charge limit`);
  }
}
for (const reply of CAPTURED_REPLIES) {
  const keys = decodeChargeSetpointFrame(bytesOf(reply.hex)).map(entry => entry.key);
  if (keys.length !== 0) {
    failures.push(`§6 ${reply.at}: the charge-current decoder read ${keys.join(", ")} out of a charge-limit frame`);
  }
}

// ── §7 through the real dispatch, not the decoder in isolation ─────────────

const dispatched = decodeFrame(CHARGE_COMMAND_CAN_ID, bytesOf("2C FF 5A 00 00 00 00 00"));
if (dispatched.find(entry => entry.key === "charge_soc_limit_pct")?.value !== 90) {
  failures.push("§7 decodeFrame does not route 0x121 to the charge-limit decoder — the signal never reaches the log");
}
// The setpoint decoder must still be reached for its own opcodes; a concat that dropped it would
// pass every section above.
const stillDecoded = decodeFrame(CHARGE_COMMAND_CAN_ID, bytesOf("18 FF 2F 01 4B 00 00 00"));
if (stillDecoded.find(entry => entry.key === "dc_charge_limit_selected_a")?.value !== 0x2f) {
  failures.push("§7 decodeFrame stopped decoding the charge-current setpoint when the limit decoder was added");
}

// ── §8 the endpoint's confirmations ───────────────────────────────────────
//
// check-irreversible-actions.ts asserts this action is confirm-gated at all. What it cannot see is
// whether the token carries the VALUE — so a page showing one percentage could POST another — and
// that 0 ("no limit") is not one keystroke away on the numeric path.

const CONFIRMATIONS: { what: string; query: string; accepted: boolean }[] = [
  {
    what: "90 % with its own token",
    query: "action=charge-soc-limit&pct=90&confirm=charge-soc-limit-90",
    accepted: true,
  },
  {
    what: "90 % carrying 80's token",
    query: "action=charge-soc-limit&pct=90&confirm=charge-soc-limit-80",
    accepted: false,
  },
  { what: "90 % with no token", query: "action=charge-soc-limit&pct=90", accepted: false },
  {
    what: "0 % with the numeric token",
    query: "action=charge-soc-limit&pct=0&confirm=charge-soc-limit-0",
    accepted: false,
  },
  {
    what: "0 % with the off token",
    query: "action=charge-soc-limit&pct=0&confirm=charge-soc-limit-off",
    accepted: true,
  },
  {
    what: "90 % with the off token",
    query: "action=charge-soc-limit&pct=90&confirm=charge-soc-limit-off",
    accepted: false,
  },
  { what: "a read, unconfirmed", query: "action=charge-soc-limit-read", accepted: true },
];
for (const candidate of CONFIRMATIONS) {
  const parsed = parseWriteRequest(new URLSearchParams(candidate.query), Date.now());
  if (parsed.ok !== candidate.accepted) {
    failures.push(
      `§8 ${candidate.what} was ${parsed.ok ? "ACCEPTED" : "refused"} and should have been ` +
        `${candidate.accepted ? "accepted" : "REFUSED"}${parsed.ok ? "" : ` — ${parsed.reason}`}`
    );
  }
}
const ninety = parseWriteRequest(new URLSearchParams(CONFIRMATIONS[0].query), Date.now());
if (ninety.ok && (ninety.request.kind !== "charge-soc-limit" || ninety.request.percent !== 90)) {
  failures.push(`§8 the accepted 90 % request parsed to ${JSON.stringify(ninety.request)}`);
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-soc-limit failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ buildChargeSocLimitWrite reproduces all ${CAPTURED_DASH_WRITES.length} of the dash's own menu confirms byte ` +
    `for byte and the 90 % written on 2026-09-19, both builders emit ONE frame on 0x120 and never touch 0x121, ` +
    `the write carries bit 7 SET and the read bit 7 CLEAR with b2 = 0, the decoder reads all ` +
    `${CAPTURED_REPLIES.length} captured and live replies back, rejects ${REJECTED.length} broken frames, and ` +
    `neither decoder reads the other's ${OTHER_OPCODE_FRAMES.length} opcodes on the shared id, and the ` +
    `endpoint accepts ${CONFIRMATIONS.filter(entry => entry.accepted).length} of ${CONFIRMATIONS.length} ` +
    `confirmations — the token has to carry the value, and 0 % needs its own word`
);

function bytesOf(hex: string): Buffer {
  return Buffer.from(hex.split(" ").map(byte => Number.parseInt(byte, 16)));
}

function hexOf(data: Uint8Array): string {
  return Array.from(data, byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
