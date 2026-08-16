import { readFile } from "fs/promises";
import {
  buildRequestFrame,
  decodeParameterReply,
  identifierForIndex,
  interpretRecord,
  isSessionOpened,
  parseResponseFrame,
  toHex,
  type VcuRequest,
} from "../src/vcu/param-codec.ts";
import {
  PARAMETER_TABLE,
  ambiguousParameterNames,
  parameterAtIndex,
  parametersNamed,
  recordLengthFor,
} from "../src/vcu/param-table.ts";
import { diffSnapshots, toParameterRow, type VcuParameterSnapshot } from "../src/vcu/snapshot.ts";
import { createVcuKwpClient, type VcuReadOutcome } from "../src/vcu/kwp-client.ts";
import { exportableRowCount, snapshotToBackupCsv } from "../src/vcu/backup-csv.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { tallyOf } from "../src/vcu/read-runner.ts";
import {
  evaluateServiceGate,
  serviceGateExcludedKeys,
  serviceGateSignalKeys,
  type ServiceGateReadings,
} from "../src/vcu/service-gate.ts";
import { decodeFrame } from "../src/can/decode.ts";
import { describeProbe, parseProbeRequest } from "../src/vcu/probe.ts";
import { canIdsFor, identifierFor } from "../src/vcu/param-codec.ts";
import type { VcuProbeOutcome } from "../src/vcu/kwp-client.ts";
import { simulateVcuMicros } from "./simulated-vcu-micro.ts";
import { CAPTURED_FRAMES, KNOWN_VARIANT_DIFFERENCES, LIVE_BANK1_READS, parseHexBytes } from "./captured-vcu-records.ts";

// Checks the VCU parameter codec, name table and snapshot diff on a laptop, with no
// bike — the same trick scripts/decode-dtc-response.ts plays for trouble codes, and
// for the same reason. There is no test framework in this repo and this is not the
// place to introduce one, so the pure modules are kept trivially callable and their
// fixtures kept real.
//
// Since 2026-08-16 `npm test` runs this, via scripts/run-checks.ts. It is still meant
// to be run directly as well — that is the only way to pass --dump.
//
//   node --experimental-strip-types scripts/check-vcu-params.ts
//   node --experimental-strip-types scripts/check-vcu-params.ts --dump obd-garage/kwp_scan_raw.txt
//
// The checked-in fixtures (scripts/captured-vcu-records.ts) are enough on their own.
// `--dump` additionally replays a full `kwp_scan.py` dump of the A9 if you have one
// — obd-garage/ is local-only and not in this repo, so it is optional by design, and
// it is where the strongest evidence for the whole mapping lives: 233 records against
// 233 table entries, every length predicted, every magic number in place.

const dumpPath = readDumpPath(process.argv.slice(2));
const failures: string[] = [];

// ── 1. The name table itself ────────────────────────────────────────────────
expect(PARAMETER_TABLE.length === 277, `table should hold 277 parameters, holds ${PARAMETER_TABLE.length}`);
const indices = PARAMETER_TABLE.map(parameter => parameter.index);
expect(
  new Set(indices).size === 277 && Math.min(...indices) === 1 && Math.max(...indices) === 277,
  "indices should be exactly 1…277 with no gaps or repeats"
);
const onA8 = PARAMETER_TABLE.filter(parameter => parameter.micro === "A8");
expect(onA8.length === 44, `44 parameters should live on the A8, found ${onA8.length}`);
expect(PARAMETER_TABLE.length - onA8.length === 233, "the remaining 233 should live on the A9");

// The correction this table exists to encode: DIAG_ADDRESSES.md §4 summarises the
// A8 as "223–256 and 266–277", but 274 and 276 are the CONTROL micro's half of a
// pair and answer on the A9. Routing off the range instead of the µC column would
// ask the wrong micro and get silence.
expect(parameterAtIndex(274)?.micro === "A9", "274 EEPROM_VERSION_uC should route to the A9, not the A8");
expect(parameterAtIndex(276)?.micro === "A9", "276 TABLE_TYPE_uC should route to the A9, not the A8");
expect(parameterAtIndex(275)?.micro === "A8", "275 EEPROM_VERSION_uS should route to the A8");
expect(parameterAtIndex(277)?.micro === "A8", "277 TABLE_TYPE_uS should route to the A8");

// Names are not unique, and a lookup that quietly picked one would answer a
// question it was never asked.
expect(
  ambiguousParameterNames().length === 4,
  `4 names should describe two indices each, found ${ambiguousParameterNames().length}`
);
expect(parametersNamed("VSM_DUMMY_WORD10").length === 2, "VSM_DUMMY_WORD10 should resolve to both of its indices");
expect(parametersNamed("max_dc_chg_current")[0]?.index === 258, "name lookup should be case-insensitive");
expect(parametersNamed("NO_SUCH_PARAMETER").length === 0, "an unknown name should resolve to nothing, not to a guess");

// ── 2. Requests, and the read-only guard ────────────────────────────────────
// Whole 8-byte frames, zero-padded, which is what actually goes on the wire.
expect(
  toHex(buildRequestFrame("A9", { kind: "read-parameter", bank: 1, index: 258 })) === "A9 03 22 11 02 00 00 00",
  "reading 258 on the A9 should be A9 03 22 11 02"
);
expect(
  toHex(buildRequestFrame("A8", { kind: "read-parameter", bank: 1, index: 231 })) === "A8 03 22 10 E7 00 00 00",
  "reading 231 on the A8 should be A8 03 22 10 E7"
);
expect(
  toHex(buildRequestFrame("A9", { kind: "start-session" })) === "A9 02 10 81 00 00 00 00",
  "the session request should be A9 02 10 81"
);
expect(
  toHex(buildRequestFrame("A9", { kind: "tester-present" })) === "A9 01 3E 00 00 00 00 00",
  "tester present should be A9 01 3E"
);
expect(identifierForIndex(6) === 0x1006 && identifierForIndex(260) === 0x1104, "CID should be 0x1000 | index");
expectThrows(() => identifierForIndex(0x1000), "an index outside bank 1 should be refused");

// The whole read-only argument in one assertion: there is no way to name a service
// this module will not send, and if the union is ever widened without a matching
// branch the encoder says so instead of emitting something.
expectThrows(
  () => buildRequestFrame("A9", { kind: "write-parameter", index: 258, value: 60 } as unknown as VcuRequest),
  "a request kind that is not a read must be refused, not encoded"
);

// ── 3. Framing, against frames quoted verbatim off the bus 2026-08-08 ───────
const sessionFrame = parseResponseFrame(parseHexBytes(CAPTURED_FRAMES.sessionOpened));
expect(
  sessionFrame.kind === "payload" && isSessionOpened(sessionFrame.payload),
  "F1 02 50 81 should parse as an opened session"
);

const bank2 = parseResponseFrame(parseHexBytes(CAPTURED_FRAMES.bank2SingleFrame));
expect(
  bank2.kind === "payload" && toHex(bank2.payload) === "62 20 01 01 23",
  "the single-frame reply should yield its 5 payload bytes"
);
if (bank2.kind === "payload") {
  const matched = decodeParameterReply(bank2.payload, 0x2001);
  expect(
    matched.kind === "record" && toHex(matched.record) === "01 23",
    "a reply whose echo matches should hand back the record"
  );
  // The failure that would otherwise be invisible: bytes that decode perfectly but
  // answer a different question.
  const crossed = decodeParameterReply(bank2.payload, 0x1102);
  expect(
    crossed.kind === "identifier-mismatch",
    "a reply echoing another identifier must NOT be filed under the one we asked for"
  );
}

const firstFrame = parseResponseFrame(parseHexBytes(CAPTURED_FRAMES.bank2FirstFrame));
expect(
  firstFrame.kind === "multi-frame" && firstFrame.totalLength === 7,
  "the A8's First Frame should be reported as multi-frame, not decoded from its fragment"
);

const refusal = parseResponseFrame(parseHexBytes(CAPTURED_FRAMES.bank0Refused));
expect(refusal.kind === "payload", "the refusal frame should still parse");
if (refusal.kind === "payload") {
  const decoded = decodeParameterReply(refusal.payload, 0x0001);
  expect(
    decoded.kind === "refused" && decoded.negativeResponseCode === 0x12,
    "bank 0 should decode as a refusal with NRC 0x12 subFunctionNotSupported, not as an empty value"
  );
}

// A request frame seen on the bus (loopback, or another tester) is addressed to a
// micro, not to us, and must never be mistaken for an answer.
expect(
  parseResponseFrame(parseHexBytes("A9 03 22 11 02")).kind === "ignored",
  "a frame addressed to a micro rather than the tester should be ignored"
);

// ── 4. The live 2026-08-08 reads, through the real decode path ─────────────
// The record bytes and values are quoted; the frame around them is RECONSTRUCTED
// here (the notes did not record it), which is why §3 above exists separately.
for (const read of LIVE_BANK1_READS) {
  const parameter = parameterAtIndex(read.index);
  if (!parameter) {
    failures.push(`index ${read.index} (${read.name}) is missing from the name table`);
    continue;
  }
  if (parameter.name !== read.name) {
    failures.push(`index ${read.index} is called ${parameter.name} in the table but ${read.name} in the capture`);
  }
  if (parameter.micro !== read.micro) {
    failures.push(`index ${read.index} routes to ${parameter.micro} but was read live from ${read.micro}`);
  }
  const record = parseHexBytes(read.rawHex);
  if (record.length !== recordLengthFor(parameter.type)) {
    failures.push(`${read.name}: ${record.length}-byte record against a ${parameter.type} in the table`);
  }
  const identifier = identifierForIndex(read.index);
  const payload = new Uint8Array([0x62, identifier >> 8, identifier & 0xff, ...record]);
  const reply = decodeParameterReply(payload, identifier);
  if (reply.kind !== "record") {
    failures.push(`${read.name}: reply decoded as ${reply.kind}`);
    continue;
  }
  const interpreted = interpretRecord(reply.record, parameter);
  if (interpreted.value !== read.value) {
    failures.push(`${read.name}: decoded ${interpreted.value}, the bike read ${read.value}`);
  }
}

// The values that differ from the variant file, which is the reason params.ecf's
// column may never be presented as this bike's.
for (const difference of KNOWN_VARIANT_DIFFERENCES) {
  const parameter = parameterAtIndex(difference.index);
  expect(
    parameter?.otherBikeValue === difference.otherBike,
    `${difference.name}: the table should carry the OTHER bike's ${difference.otherBike}`
  );
  expect(
    parameter?.otherBikeValue !== difference.thisBike,
    `${difference.name}: the table must not be carrying this bike's ${difference.thisBike}`
  );
}

// ── 5. Interpretation: signs, unknown identifiers, wrong widths ─────────────
const signedParameter = parameterAtIndex(73);
expect(signedParameter?.signed === true, "73 TH_LOW_B_L_TEMP should be a signed parameter");
expect(
  interpretRecord(parseHexBytes("FF E7"), signedParameter).value === -25,
  "a signed WORD should decode two's complement"
);
expect(interpretRecord(parseHexBytes("FF E7"), parameterAtIndex(31)).value === 65511, "an unsigned WORD should not");

// "Reading something not in the table should report the raw value, not fail."
const unknown = interpretRecord(parseHexBytes("12 34"), null);
expect(
  unknown.value === null && unknown.unsigned === 0x1234 && unknown.rawHex === "12 34",
  "an unknown identifier should give up its raw bytes and decline to type them"
);

// A width the table did not predict has never been seen in 233 records. If it ever
// is, the raw bytes survive and the typed value is withheld rather than invented.
const mismatched = interpretRecord(parseHexBytes("00 4B"), parameterAtIndex(258));
expect(
  mismatched.widthMismatch && mismatched.value === null && mismatched.rawHex === "00 4B",
  "a record whose width contradicts the table should keep its bytes and withhold the value"
);

// ── 6. The diff, which is how a reconfigured bike gets noticed ──────────────
const before = snapshotOf([reading(258, "4B"), reading(259, "00 E1"), silent(261)]);
const after = snapshotOf([reading(258, "3C"), reading(259, "00 E1"), reading(261, "69")]);
const changes = diffSnapshots(before, after);
expect(
  changes.filter(change => change.kind === "value-changed").length === 1,
  "exactly one value change should be reported"
);
expect(
  changes.some(change => change.kind === "value-changed" && change.index === 258 && change.to === "3C"),
  "the change on 258 should be named with its raw bytes"
);
expect(
  changes.some(change => change.kind === "status-changed" && change.index === 261),
  "a parameter that answered this time but not last time is a change in the READ, reported separately"
);
expect(diffSnapshots(before, before).length === 0, "a snapshot compared with itself should report nothing");

// ── 7. The transport, against a simulated micro ─────────────────────────────
// Everything above is pure and could be checked by inspection. This section covers
// the parts that only exist in time — the session handshake, an idle session
// expiring silently, and telling silence apart from a refusal — because those are
// the parts a reader cannot verify by staring at them, and the parts that would
// otherwise be exercised for the first time in a garage.
await checkTransport();

// ── 8. The energica_tool.py backup CSV, against that tool's own bytes ──────
// The export format is another owner's, not ours, so the check is byte equality
// against output taken from their writer rather than against our idea of "CSV".
// GOLDEN_BACKUP_CSV below was produced on 2026-08-15 by executing
// energica_tool.py's `_params_save_backup` body under Python 3 with a
// `_param_cur` of exactly these ids — see the provenance note in
// src/vcu/backup-csv.ts. The `\r\n` after the LAST row is not a typo: Python's
// csv.writer terminates every row, so the file ends with a newline.
const GOLDEN_BACKUP_CSV =
  "id_hex,name,value\r\n" +
  "0x06,CHARGE_RESTART_HOLDOFF,20\r\n" +
  "0x07,INLET_LOCK_DEVICE,1\r\n" +
  "0x08,DC_DC_OVER_CURRENT,40000\r\n" +
  "0x0F,MODEL,358\r\n" +
  "0x30,TORQUE_LIMIT,2300\r\n" +
  "0xFF,SPEED_ODO_FINALGEAR,4140\r\n";

const backupSnapshot = snapshotOf([
  reading(6, "14"),
  reading(7, "01"),
  reading(8, "9C 40"),
  reading(15, "01 66"),
  reading(48, "08 FC"),
  reading(255, "10 2C"),
]);
expect(
  snapshotToBackupCsv(backupSnapshot) === GOLDEN_BACKUP_CSV,
  `the backup CSV should match energica_tool.py byte for byte, got ${JSON.stringify(snapshotToBackupCsv(backupSnapshot))}`
);
expect(exportableRowCount(backupSnapshot) === 6, "all six readable rows should be exportable");

// A signed parameter has to come out with its minus sign — that tool writes
// `str(int)` and its restore path reads `int(...)`, so `-350` round-trips and
// 65186 would silently become a different calibration.
expect(
  snapshotToBackupCsv(snapshotOf([reading(93, "FE A2")])) === "id_hex,name,value\r\n0x5D,PACK_LPA,-350\r\n",
  "a signed value should export as a negative decimal, not as its unsigned reading"
);

// The ten parameters at 256…277 are past the one-byte local id energica_tool.py
// reads with, so it can neither read nor write them — but they are this bike's
// real charging limits and they belong in this bike's backup. Three hex digits is
// what f"0x{pid:02X}" produces for them; that tool's restore skips ids its table
// does not know, so the extra rows are ignored rather than misread.
expect(
  snapshotToBackupCsv(snapshotOf([reading(258, "4B")])) === "id_hex,name,value\r\n0x102,MAX_DC_CHG_CURRENT,75\r\n",
  "index 258 should export as 0x102 with this bike's 75, not be dropped for being out of that tool's reach"
);

// Rows that are not a value must not become one. A parameter the bike never
// answered has no place in a file whose reader does int(row["value"]).
const withFailures = snapshotOf([reading(6, "14"), silent(7), reading(8, "9C 40")]);
expect(
  snapshotToBackupCsv(withFailures) ===
    "id_hex,name,value\r\n0x06,CHARGE_RESTART_HOLDOFF,20\r\n0x08,DC_DC_OVER_CURRENT,40000\r\n",
  "a parameter that did not answer should be absent from the export, not exported as a reason"
);
expect(exportableRowCount(withFailures) === 2, "only the two that answered should count towards the export");

// The whole point of keeping a zero-read run distinct: an export of it is empty,
// and the endpoint refuses rather than handing over a header-only file that would
// look like a bike with no parameters.
expect(exportableRowCount(snapshotOf([silent(6), silent(7)])) === 0, "a snapshot that read nothing exports nothing");

// A width the table contradicts keeps its raw bytes in the snapshot but has no
// honest typed value, so it cannot go in a column of typed values.
expect(
  exportableRowCount(snapshotOf([reading(258, "00 4B")])) === 0,
  "a record whose width contradicts the table should be withheld from the export, not guessed at"
);

// ── 9. The read-runner's tally, which is what makes a failure legible ───────
// Pure, so it is checked here rather than by starting a child process. The
// distinction that matters: "the A8 never woke up" must not read as "44
// parameters vanished", and the statuses must not collapse into one count.
const tally = tallyOf(
  snapshotOf([reading(6, "14"), reading(8, "9C 40"), silent(7), noSession(231), noSession(232)]).rows
);
expect(tally.total === 5 && tally.read === 2, "the tally should count 5 rows of which 2 read");
expect(
  tally.byStatus["no-session"] === 2 && tally.byStatus["no-response"] === 1,
  "silence and a micro that never opened a session must stay separate counts"
);
expect(
  tally.micros.length === 2 &&
    tally.micros[0].micro === "A8" &&
    tally.micros[0].read === 0 &&
    tally.micros[0].failed === 2 &&
    tally.micros[1].read === 2,
  "the per-micro split should say the A8 answered nothing while the A9 answered twice"
);
expect(tallyOf([]).read === 0 && tallyOf([]).micros.length === 0, "an empty sweep should tally to nothing, not throw");

// ── 10. The service-mode safety gate, against real captured frames ─────────
// The gate decides whether ~277 diagnostic requests may go on the bus of a bike
// that might be about to be ridden, so it is checked against BYTES rather than
// against invented numbers: the frames below are the ones src/can/decode.ts cites,
// and they are put through the real decoder on the way in. What that buys is the
// two claims worth making without the motorcycle — the gate can be opened at all,
// and it shuts on the one moving capture this project has.

// The parked bike, 2026-08-02. `0x102` is quoted verbatim in decode.ts's header;
// `0x104` is that day's odometer with the speed and rpm fields at the zero they
// held for the whole capture.
const PARKED_BODY_FRAME = "80 10 02 44 99 FF D8 FF";
const PARKED_DRIVE_FRAME = "8D 99 02 00 00 00 00 00";

// The garage lap the same afternoon: `5F 00 32 00` in b4-7 decodes to 9.5 km/h and
// 400 rpm, measured against OBD PID 0D (10) and PID 0C (411).
const ROLLING_DRIVE_FRAME = "8D 99 02 00 5F 00 32 00";

// Constructed rather than captured — no capture of these states exists, which is
// exactly why they are labelled as such. Each sets one more bit of b1 on top of the
// parked 0x10 key_on, so each isolates ONE rule's blocking path. The two weakest
// signals in the gate (`go_request`, whose manufacturer name is "Engine Switch",
// and `go`, which that table does not list at all) and the earliest-moving one
// (`throttle_on`) each get their own case, because those are the three most worth
// knowing are wired to something.
const ENERGIZED_BODY_FRAME = "80 1A 02 44 99 FF D8 FF"; // + 0x02 energized, 0x08 go
const GO_REQUEST_BODY_FRAME = "80 14 02 44 99 FF D8 FF"; // + 0x04 go_request alone
const THROTTLE_BODY_FRAME = "80 90 02 44 99 FF D8 FF"; // + 0x80 throttle_on alone
// b2 gains 0x80 `moving` while 0x104 still says zero: the bike's own opinion
// contradicting the wheel. Either alone must be enough to refuse.
const MOVING_BODY_FRAME = "80 10 82 44 99 FF D8 FF";

const parkedReadings = gateReadingsFrom([
  [0x102, PARKED_BODY_FRAME],
  [0x104, PARKED_DRIVE_FRAME],
]);
const parked = evaluateServiceGate(parkedReadings);
expect(parked.safe, `a parked bike should pass the gate, blocked by: ${parked.blockers.join(" · ")}`);
expect(
  parked.checks.every(check => check.state === "ok" || check.key === "speed_kmh"),
  "every gated signal should read ok on the parked capture"
);

// The single most important assertion in this file: the frames really do decode to
// the states the gate is asserting, so a passing gate is a fact about the bike and
// not about the fixture agreeing with itself.
expect(
  parkedReadings["speed_can_kmh"]?.value === 0 &&
    parkedReadings["motor_rpm_can"]?.value === 0 &&
    parkedReadings["energized"]?.value === 0 &&
    parkedReadings["go"]?.value === 0 &&
    parkedReadings["moving"]?.value === 0,
  "the parked capture should decode to zero speed, zero rpm and a drive that is down"
);

const rolling = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, PARKED_BODY_FRAME],
    [0x104, ROLLING_DRIVE_FRAME],
  ])
);
expect(!rolling.safe, "9.5 km/h should not pass the gate");
expect(
  rolling.blockers.some(blocker => blocker.includes("road speed is zero")) &&
    rolling.blockers.some(blocker => blocker.includes("the motor is not turning")),
  `speed and rpm should each be named as blockers, got: ${rolling.blockers.join(" · ")}`
);
// A bike being pushed shows speed without the body frame changing, which is why the
// gate does not rest on the 0x102 state bits alone.
expect(
  !rolling.blockers.some(blocker => blocker.includes("energized")),
  "a rolling bike with the drive down should be blocked on motion, not misreported as energized"
);

const energized = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, ENERGIZED_BODY_FRAME],
    [0x104, PARKED_DRIVE_FRAME],
  ])
);
expect(!energized.safe, "a stationary bike with the drive up should not pass the gate");
expect(
  energized.blockers.length === 2 &&
    energized.blockers.some(blocker => blocker.includes("not energized")) &&
    energized.blockers.some(blocker => blocker.includes("not in drive")),
  `energized and go should both block, got: ${energized.blockers.join(" · ")}`
);

// One bit at a time, so each rule is shown to be wired to the bit it names rather
// than riding along with a neighbour that happened to be set in the same fixture.
for (const [frame, requirement, label] of [
  [GO_REQUEST_BODY_FRAME, "nobody is asking for drive", "go_request"],
  [THROTTLE_BODY_FRAME, "the throttle is closed", "throttle_on"],
  [MOVING_BODY_FRAME, "the bike is not moving", "moving"],
] as const) {
  const verdict = evaluateServiceGate(
    gateReadingsFrom([
      [0x102, frame],
      [0x104, PARKED_DRIVE_FRAME],
    ])
  );
  expect(!verdict.safe, `${label} set should close the gate on its own`);
  expect(
    verdict.blockers.length === 1 && verdict.blockers[0].includes(requirement),
    `${label} should be the only blocker, got: ${verdict.blockers.join(" · ")}`
  );
}

// Fail closed, three ways. Each of these looks like a safe bike to anything that
// reads the VALUE without asking how old it is or whether it exists.
const nothing = evaluateServiceGate({});
expect(!nothing.safe, "a gate with no readings at all must refuse");
// Asserted by NAME rather than by count: a count would still pass if some other
// rule quietly became the excused one.
expect(
  nothing.checks
    .filter(check => check.key !== "speed_kmh")
    .every(check =>
      nothing.blockers.some(blocker => blocker.includes(check.key) || blocker.includes(check.requirement))
    ),
  `every required signal should be named when nothing has arrived, got: ${nothing.blockers.join(" · ")}`
);
expect(
  !nothing.blockers.some(blocker => blocker.includes("speed_kmh")),
  "the OBD corroborator must not block by being absent"
);
const stale = evaluateServiceGate(
  gateReadingsFrom(
    [
      [0x102, PARKED_BODY_FRAME],
      [0x104, PARKED_DRIVE_FRAME],
    ],
    30_000
  )
);
expect(!stale.safe, "readings 30 s old must not pass, however parked they say the bike is");
expect(
  stale.blockers.every(blocker => blocker.includes("too old to go on")),
  `a stale gate should say so rather than reporting the values, got: ${stale.blockers.join(" · ")}`
);
expect(
  !evaluateServiceGate({ ...parkedReadings, speed_can_kmh: { value: 0, ageMs: null } }).safe,
  "a value with no age is not a reading and must not pass"
);

// The OBD corroborator: never blocks by being absent (that is a fact about our
// poller), always blocks by disagreeing (that is two paths contradicting).
expect(
  evaluateServiceGate({ ...parkedReadings, speed_kmh: { value: null, ageMs: null } }).safe,
  "a missing OBD speed should not block — its absence is about our polling, not the bike"
);
const contradiction = evaluateServiceGate({ ...parkedReadings, speed_kmh: { value: 12, ageMs: 400 } });
expect(!contradiction.safe, "OBD saying 12 km/h while CAN says 0 is a contradiction, not a pass");
expect(
  evaluateServiceGate({ ...parkedReadings, speed_kmh: { value: 0, ageMs: 400 } }).safe,
  "an OBD speed that agrees should leave the gate open"
);
// The case that matters most, and the one this file used to miss: `missing` only
// ever describes the window before the poller's FIRST reply. After that the only
// way the corroborator can report "our own poller has gone quiet" is `stale` — and
// a running sweep is the likeliest cause of it, since it competes for the same bus.
// A gate that blocked on this would have aborted the sweep that caused it.
const staleCorroborator = evaluateServiceGate({ ...parkedReadings, speed_kmh: { value: 0, ageMs: 30_000 } });
expect(staleCorroborator.safe, `a stale OBD speed must not block, got: ${staleCorroborator.blockers.join(" · ")}`);
expect(
  staleCorroborator.checks.find(check => check.key === "speed_kmh")?.state === "stale",
  "…and it should still be REPORTED as stale, so the page can show it"
);
expect(
  evaluateServiceGate({ ...parkedReadings, speed_kmh: { value: 12, ageMs: 30_000 } }).safe,
  "a stale OBD speed is excused whatever it says — a 30 s old 12 km/h is not a claim about now"
);
// A required signal, by contrast, is never excused for being stale.
expect(
  !evaluateServiceGate({ ...parkedReadings, speed_can_kmh: { value: 0, ageMs: 30_000 } }).safe,
  "a stale REQUIRED signal must still block — only the corroborator is excused"
);

// ── Stationary AND CHARGING must be allowed in ────────────────────────────
// The state the whole feature is for: you cannot test a DC charge-current limit on
// a bike that is not plugged in. `energized` is 1 throughout a charge, so it is the
// one check a charge session excuses — and nothing else is.

// b1 gains 0x02 energized on top of the parked 0x10 key_on, which is exactly the
// transition CAN_MAP.md records at the start of the 2026-08-04 DC session
// (0x102 b1 0x10 → 0x12). b2 = 0x02 is the low beam lamp, i.e. what any bike with its
// ignition on looks like.
//
// ⚠️ These two were called CHARGING_BODY_FRAME and AC_CHARGING_BODY_FRAME until
// 2026-08-16. Neither frame ever said "charging": the bit that made the second one
// look like an AC charge is 0x102 b2 bit0, which is the HIGH BEAM. The old names were
// the .xdbc's decoder error restated as a fixture, and they made the guard below read
// as though it were about a charger when it is about a headlight.
const KEY_ON_ENERGIZED_BODY_FRAME = "80 12 02 44 99 FF D8 FF";
// …and the same with 0x102 b2 bit0 set as well — the high beam switched on.
const HIGH_BEAM_ON_BODY_FRAME = "80 12 03 44 99 FF D8 FF";
// 0x305 — the charger's own frame: mains 5.0 A, DC 20.0 A, DC 400.0 V. Its VALUES
// are never consulted; that it arrived at all is the evidence.
const CHARGER_FRAME = "00 32 00 C8 00 A0 0F 00";

const energizedNotCharging = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, KEY_ON_ENERGIZED_BODY_FRAME],
    [0x104, PARKED_DRIVE_FRAME],
  ])
);
expect(!energizedNotCharging.safe, "an energized bike with nothing plugged in should still be refused");
expect(energizedNotCharging.chargingEvidence === null, "…and no charge evidence should be claimed");

const dcCharging = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, KEY_ON_ENERGIZED_BODY_FRAME],
    [0x104, PARKED_DRIVE_FRAME],
    [0x305, CHARGER_FRAME],
  ])
);
expect(
  dcCharging.safe,
  `a stationary charging bike must be allowed in, blocked by: ${dcCharging.blockers.join(" · ")}`
);
expect(dcCharging.chargingEvidence !== null, "…and the verdict should name what says it is charging");
expect(
  dcCharging.checks.find(check => check.key === "energized")?.state === "excused-by-charging",
  "…with energized reported as excused rather than silently ok, so the page can say why"
);

// ⚠️ The regression guard that matters most here: 0x102 b2 bit0 is NOT a charging bit.
// It is the high beam, and since 2026-08-16 it is decoded under that name
// (`high_beam_lamp`) — rides.db has it equal to `high_beam` at 421 of 421 timestamps,
// set at 100-142 km/h and clear through all 25 real charging sessions, and a per-frame
// pass over all 1 103 000 frames of 0x102 in the capture corpus found zero
// disagreements. If it were treated as charge evidence, switching on the high beam
// would excuse the drive being energized. It must carry no weight at all — which is
// why this asserts on the FRAME rather than on a key name, so it still holds however
// the signal is called next.
const highBeamOnly = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, HIGH_BEAM_ON_BODY_FRAME],
    [0x104, PARKED_DRIVE_FRAME],
  ])
);
expect(!highBeamOnly.safe, "0x102 b2 bit0 is the high beam and must not excuse anything");
expect(highBeamOnly.chargingEvidence === null, "…and must not be claimed as charge evidence");

// ⚠️ The trap this must not fall into: `liveState` keeps `dc_v` for ever, so an
// unplugged bike still reports 400 V from whenever it last charged. Only the AGE
// separates "plugged in" from "was plugged in, once".
const staleCharger = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, KEY_ON_ENERGIZED_BODY_FRAME],
    [0x104, PARKED_DRIVE_FRAME],
    [0x305, CHARGER_FRAME, 30_000],
  ])
);
expect(!staleCharger.safe, "a charger frame 30 s old is not a bike that is plugged in");
expect(staleCharger.chargingEvidence === null, "…and must not be claimed as evidence");

// The excuse is narrow: it covers `energized` and nothing else. A charging bike that
// somehow reports motion, or drive, is still refused.
for (const [label, frames] of [
  [
    "motion",
    [
      [0x102, KEY_ON_ENERGIZED_BODY_FRAME],
      [0x104, ROLLING_DRIVE_FRAME],
      [0x305, CHARGER_FRAME],
    ],
  ],
  [
    "drive",
    [
      [0x102, "80 1A 02 44 99 FF D8 FF"],
      [0x104, PARKED_DRIVE_FRAME],
      [0x305, CHARGER_FRAME],
    ],
  ],
] as [string, [number, string, number?][]][]) {
  const verdict = evaluateServiceGate(gateReadingsFrom(frames));
  expect(!verdict.safe, `a charging bike showing ${label} must still be refused`);
  expect(
    verdict.chargingEvidence !== null && !verdict.blockers.some(blocker => blocker.includes("not energized")),
    `…and the refusal should be about the ${label}, not about energized, got: ${verdict.blockers.join(" · ")}`
  );
}

// ⚠️ A charging bike STOPS BROADCASTING 0x104 — rides.db has not one live
// `speed_can_kmh` sample inside any of the 25 charging sessions. So while a charger
// is attached those two signals may be absent, and the 0x102 bits are what still
// prove the bike is awake and still.
const chargingNo104 = evaluateServiceGate({
  ...gateReadingsFrom([[0x102, KEY_ON_ENERGIZED_BODY_FRAME]]),
  ...gateReadingsFrom([[0x305, CHARGER_FRAME]]),
});
expect(
  chargingNo104.safe,
  `a charging bike that has stopped sending 0x104 should still be allowed in, blocked by: ${chargingNo104.blockers.join(" · ")}`
);
expect(
  chargingNo104.checks.find(check => check.key === "speed_can_kmh")?.state === "excused-by-charging",
  "…with the missing speed reported as excused rather than silently ok"
);

// …but only while charging. The same absence with nothing plugged in must refuse —
// this is the trap the data documents, where forward-filling the last value hands
// you 47 km/h for a bike that has been parked for seven hours.
expect(
  !evaluateServiceGate(gateReadingsFrom([[0x102, PARKED_BODY_FRAME]])).safe,
  "a bike with no 0x104 and no charger must refuse — absence is not zero"
);

// …and the excuse is for ABSENCE only. A fresh 0x104 that says the wheel is turning
// blocks whether or not something is plugged in.
const chargingButRolling = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, KEY_ON_ENERGIZED_BODY_FRAME],
    [0x104, ROLLING_DRIVE_FRAME],
    [0x305, CHARGER_FRAME],
  ])
);
expect(!chargingButRolling.safe, "a fresh speed reading still blocks while charging");
expect(
  chargingButRolling.blockers.some(blocker => blocker.includes("road speed is zero")),
  `…naming the speed, got: ${chargingButRolling.blockers.join(" · ")}`
);

// A stale 0x104 while charging is excused; a stale 0x102 is not, because 0x102 is
// what proves the bike is awake at all.
expect(
  evaluateServiceGate({
    ...gateReadingsFrom([[0x102, KEY_ON_ENERGIZED_BODY_FRAME]]),
    ...gateReadingsFrom([[0x104, ROLLING_DRIVE_FRAME, 30_000]]),
    ...gateReadingsFrom([[0x305, CHARGER_FRAME]]),
  }).safe,
  "a 30 s old 0x104 is excused while charging — even one that used to say 9.5 km/h"
);
expect(
  !evaluateServiceGate({
    ...gateReadingsFrom([[0x102, KEY_ON_ENERGIZED_BODY_FRAME, 30_000]]),
    ...gateReadingsFrom([[0x305, CHARGER_FRAME]]),
  }).safe,
  "a stale 0x102 must still block — it is the proof the bike is awake and not moving"
);

// The signals deliberately left out must stay out. Every one of them reads
// "parked-looking" on some capture where the bike is not, or has never been seen in
// the state the gate would need — the reasoning is in service-gate.ts and this is
// what stops it being quietly undone.
expect(
  serviceGateExcludedKeys().every(key => !serviceGateSignalKeys().includes(key)),
  `a signal excluded from the gate has been wired back into it: ${serviceGateExcludedKeys()
    .filter(key => serviceGateSignalKeys().includes(key))
    .join(", ")}`
);

// …and every one of them must still be a signal that EXISTS. Raised in review of the
// 2026-08-16 beam rename, which is exactly the case it guards: the check above only
// asks "is this name absent from RULES", and a name nothing produces is trivially
// absent from everything. So `"charging"` would have sat in that list for ever after
// the signal it names stopped being decoded, still passing, while the reasoning
// attached to it quietly stopped applying to anything — a list of names with no
// spelling check is a comment wearing a check's clothes.
const registeredKeys = new Set(SIGNALS.map(signal => signal.key));
const unknownExclusions = serviceGateExcludedKeys().filter(key => !registeredKeys.has(key));
expect(
  unknownExclusions.length === 0,
  `the gate excludes signals that no longer exist, so their reasoning guards nothing: ${unknownExclusions.join(", ")}`
);

// ── 11. Probing one identifier: banks, targets and what a reply means ──────
// The replacement for the deleted script's `--index N`, and it reaches further:
// any bank on any of three ECUs. Both halves are pure, so both are checked here.

// The identifier really is (bank << 12) | index, and both halves are range-checked
// rather than truncated into a different, valid-looking read.
expect(identifierFor(1, 6) === 0x1006, "bank 1 index 6 should be 0x1006");
expect(identifierFor(2, 5) === 0x2005, "bank 2 index 5 should be 0x2005 — live data, not calibration");
expect(identifierFor(0, 0) === 0x0000 && identifierFor(15, 4095) === 0xffff, "the whole 16-bit space is reachable");
expectThrows(() => identifierFor(16, 0), "a bank past 15 should be refused, not wrapped");
expectThrows(() => identifierFor(1, 0x1000), "an index past 4095 should be refused, not truncated into the bank");

// The charge manager is a different pair of CAN ids, and that is the entire reason
// it has never answered: every sweep this project ran went out on 0x7C0.
expect(canIdsFor("A9").request === 0x7c0 && canIdsFor("A9").response === 0x7e0, "the VCU micros are 0x7C0/0x7E0");
expect(canIdsFor("A8").request === 0x7c0, "both VCU micros share one pair of ids — they differ by address byte");
expect(canIdsFor("A4").request === 0x7c3 && canIdsFor("A4").response === 0x7e3, "the charge manager is 0x7C3/0x7E3");

// …and the frame addressed to it carries 0xA4, with the bank in the identifier.
expect(
  toHex(buildRequestFrame("A4", { kind: "read-parameter", bank: 2, index: 5 })) === "A4 03 22 20 05 00 00 00",
  `a bank-2 read on the charge manager should be A4 03 22 20 05, got ${toHex(buildRequestFrame("A4", { kind: "read-parameter", bank: 2, index: 5 }))}`
);

// A probe request is a person typing into a box, so every field is validated and a
// bad one is a message rather than a throw out of an HTTP handler.
const goodProbe = parseProbeRequest({ target: "A9", bank: "1", index: "258" });
expect(goodProbe.ok && goodProbe.request.index === 258, "a plain decimal index should parse");
const hexProbe = parseProbeRequest({ target: "a4", bank: "2", index: "0x102" });
expect(
  hexProbe.ok && hexProbe.request.index === 258 && hexProbe.request.target === "A4" && hexProbe.request.bank === 2,
  "hex should parse and the target should be case-insensitive — both are how an address arrives from a manual"
);
for (const [raw, why] of [
  [{ target: "A7", bank: "1", index: "1" }, "a target that answers no read on any bank"],
  [{ target: null, bank: "1", index: "1" }, "no target at all"],
  [{ target: "A9", bank: "16", index: "1" }, "a bank past 15"],
  [{ target: "A9", bank: "1", index: "4096" }, "an index past 4095"],
  [{ target: "A9", bank: "1", index: "" }, "an empty index"],
  [{ target: "A9", bank: "1", index: "1.5" }, "a fractional index"],
  [{ target: "A9", bank: "-1", index: "1" }, "a negative bank"],
] as [{ target: string | null; bank: string | null; index: string | null }, string][]) {
  const parsed = parseProbeRequest(raw);
  expect(!parsed.ok, `${why} should be refused with a reason`);
  expect(!parsed.ok && parsed.reason.length > 0, `${why} should say why`);
}

// What a reply MEANS. The name table describes bank 1 on the VCU micros and nothing
// else, so it is consulted only there — attaching a calibration parameter's name and
// sign to a live-data reading would be a wrong answer that looks informative.
const bank1Probe = describeProbe(probeOutcome("A9", 1, 258, "4B"));
expect(
  bank1Probe.name === "MAX_DC_CHG_CURRENT" && bank1Probe.value === 75 && bank1Probe.unsigned === 75,
  "a bank-1 index the table describes should come back named and typed"
);
const bank2Probe = describeProbe(probeOutcome("A9", 2, 258, "4B"));
expect(
  bank2Probe.name === null && bank2Probe.value === null,
  "the same index in bank 2 is live data and must NOT borrow the calibration parameter's name"
);
expect(
  bank2Probe.unsigned === 75 && bank2Probe.signed === 75 && bank2Probe.rawHex === "4B",
  "…but the bytes and both readings of them are still returned"
);
expect(bank2Probe.note !== null, "…with a note saying the width and sign are not known");
expect(
  describeProbe(probeOutcome("A4", 1, 258, "4B")).name === null,
  "the charge manager is not in the VCU's name table, whatever the bank"
);
// Both readings, always — this is the case where picking one would be wrong.
const negative = describeProbe(probeOutcome("A9", 2, 1, "FE A2"));
expect(negative.unsigned === 65186 && negative.signed === -350, "a probe should report the bytes both ways");
const refused = describeProbe({
  target: "A4",
  bank: 2,
  index: 5,
  identifier: 0x2005,
  status: "refused",
  negativeResponseCode: 0x31,
  description: "requestOutOfRange",
});
expect(refused.status === "refused" && refused.rawHex === null, "a refusal carries no bytes");
expect(
  refused.note?.includes("will not serve") === true,
  `a refusal should say the ECU is there and declining, got: ${refused.note}`
);
expect(
  describeProbe({
    target: "A4",
    bank: 1,
    index: 1,
    identifier: 0x1001,
    status: "no-session",
    reason: "A4 did not answer 10 81",
  }).note?.includes("nothing is at this address") === true,
  "silence at an address should read as “nothing there or asleep”, not as a refusal"
);

// ── 12. Optional: the full stored A9 dump ──────────────────────────────────
if (dumpPath) {
  await replayStoredDump(dumpPath);
} else {
  console.log("no --dump given: skipping the 233-record A9 replay (obd-garage/ is local-only and not in this repo)\n");
}

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "✓ table, request encoding, framing, live 2026-08-08 reads, interpretation, diff, the energica_tool.py backup CSV, the read tally, the service-mode safety gate and the identifier probe all check out"
);

/**
 * Drives the real client against a simulated A9 and A8.
 *
 * The session window is set SHORTER than the client's own idle limit on purpose, so
 * the session expires while the client still believes it is open. That is the
 * failure the real bus produces when a sweep pauses — a read that simply vanishes —
 * and the retry that recovers it is the one piece of logic here with no other way
 * to be checked short of riding to the garage.
 */
async function checkTransport(): Promise<void> {
  const bus = simulateVcuMicros([
    {
      target: "A9",
      // Real values off this bike, so a wrong route or a wrong width shows up as a
      // wrong number rather than as an arbitrary one.
      records: new Map([
        [258, parseHexBytes("4B")],
        [259, parseHexBytes("00 E1")],
      ]),
      silentIndices: [1],
      sessionIdleMs: 400,
    },
    { target: "A8", records: new Map([[231, parseHexBytes("01 90")]]) },
  ]);
  const client = createVcuKwpClient(bus.channel, { paceMs: 1, responseTimeoutMs: 60 });
  bus.channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));

  expect(await client.ping("A9"), "the A9 should answer a session plus tester present");
  const first = await client.readParameter("A9", 258);
  expect(first.status === "read" && toHex(first.record) === "4B", "258 should read 4B off the simulated A9");

  // The A8 holds its own session; reading it must not disturb the A9's.
  const onA8 = await client.readParameter("A8", 231);
  expect(onA8.status === "read" && toHex(onA8.record) === "01 90", "231 should read off the simulated A8");

  // Silence is not a refusal and must not be reported as one.
  expect(
    (await client.readParameter("A9", 1)).status === "no-response",
    "a silent index should come back as no-response"
  );
  // …and a refusal is not silence.
  expect(
    (await client.readParameter("A9", 2)).status === "refused",
    "an index the micro refuses should come back as refused"
  );

  // Two reads at once cannot both be answered — one reply id, no request tag — so
  // the second must come back as "we never asked" rather than take the first one's
  // frame. It prints a warning, which is the intended noise.
  const [firstOfTwo, secondOfTwo] = await Promise.all([
    client.readParameter("A9", 258),
    client.readParameter("A9", 259),
  ]);
  expect(
    [firstOfTwo.status, secondOfTwo.status].includes("not-sent"),
    "interleaved reads: one must be reported as not-sent, not given the other's reply"
  );

  // Long enough for the 400 ms session to lapse while the client's 1500 ms idle
  // limit still thinks it is open, so recovery has to come from the retry.
  await new Promise(resolve => setTimeout(resolve, 700));
  const sentBefore = bus.sentRequests.length;
  const recovered = await client.readParameter("A9", 259);
  expect(recovered.status === "read", `a silently-expired session should be recovered, got ${recovered.status}`);
  expect(
    bus.sentRequests.length - sentBefore === 3,
    "recovery should cost exactly the lost read, a 10 81, and the retry"
  );

  client.stop();

  // And the standing guarantee, checked against every byte that reached the bus.
  const services = new Set(bus.sentRequests.map(request => request.split(" ")[1]));
  expect(
    [...services].every(service => ["10", "3E", "22"].includes(service)),
    `only 10/3E/22 may ever be transmitted, saw ${[...services].join(", ")}`
  );
}

/**
 * Replays a full `kwp_scan.py` dump — `<µC> B<bank> <id> <len> <hexvalue>` — through
 * the real decoder and checks it against the name table.
 *
 * This is the evidence for `CID = 0x1000 | index` at full strength: the file assigns
 * 233 indices to the A9 and the dump holds 233 bank-1 records, the two SETS are
 * identical, and the TYPE column predicts every record length. An off-by-one index
 * would break all three at once.
 */
async function replayStoredDump(path: string): Promise<void> {
  const text = await readFile(path, "utf-8");
  const records = new Map<number, Uint8Array>();
  for (const [lineNumber, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    const columns = line.trim().split(/\s+/);
    if (columns.length !== 5) {
      failures.push(`${path}:${lineNumber + 1}: ${columns.length} columns, expected 5`);
      continue;
    }
    const [micro, bank, identifier, length, value] = columns;
    if (bank !== "B1") {
      continue;
    }
    if (micro !== "A9") {
      // kwp_scan_raw.txt is A9-only; anything else means a newer dump and the A8
      // assertions below would need rethinking rather than silently skipping.
      failures.push(`${path}:${lineNumber + 1}: bank-1 record from ${micro}, which this replay does not model`);
      continue;
    }
    const bytes = parseHexBytes(value);
    if (bytes.length !== Number(length)) {
      failures.push(`${path}:${lineNumber + 1}: declares ${length} bytes, carries ${bytes.length}`);
    }
    records.set(Number.parseInt(identifier, 16), bytes);
  }

  const expected = PARAMETER_TABLE.filter(parameter => parameter.micro === "A9");
  const missing = expected.filter(parameter => !records.has(parameter.index));
  const extra = [...records.keys()].filter(index => parameterAtIndex(index)?.micro !== "A9");
  expect(missing.length === 0, `every A9 parameter should be in the dump; ${missing.length} were not`);
  expect(
    extra.length === 0,
    `every bank-1 record should be an A9 parameter; ${extra.length} were not (${extra.join(", ")})`
  );

  let sameAsVariantFile = 0;
  const different: string[] = [];
  for (const parameter of expected) {
    const record = records.get(parameter.index);
    if (!record) {
      continue;
    }
    if (record.length !== recordLengthFor(parameter.type)) {
      failures.push(`${parameter.name}: dump record is ${record.length} bytes, the table says ${parameter.type}`);
      continue;
    }
    const interpreted = interpretRecord(record, parameter);
    if (interpreted.value === parameter.otherBikeValue) {
      sameAsVariantFile += 1;
    } else {
      different.push(
        `${parameter.index} ${parameter.name}: this bike ${interpreted.value}, the file ${parameter.otherBikeValue}`
      );
    }
  }
  console.log(`replayed ${records.size} bank-1 records from ${path}`);
  console.log(`  ${sameAsVariantFile} match the variant file, ${different.length} differ:`);
  for (const line of different) {
    console.log(`    ${line}`);
  }
  // Magic numbers are the load-bearing part of the cross-check: an off-by-one index
  // would move them off their names, and nothing else here would necessarily notice.
  for (const [index, magic] of [
    [8, 40000],
    [18, 3600],
    [31, 3300],
  ] as const) {
    const record = records.get(index);
    expect(
      record !== undefined && interpretRecord(record, parameterAtIndex(index)).value === magic,
      `index ${index} should still read ${magic} — the mapping rests on these`
    );
  }
  console.log("");
}

function readDumpPath(argv: string[]): string | null {
  const flag = argv.indexOf("--dump");
  if (flag === -1) {
    return null;
  }
  const path = argv[flag + 1];
  if (!path) {
    console.error("--dump needs a path");
    process.exit(1);
  }
  return path;
}

function expect(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

function expectThrows(action: () => unknown, message: string): void {
  try {
    action();
  } catch {
    // Throwing IS the pass here. Nothing is swallowed: the failure path below is
    // what records the case where it did not throw.
    return;
  }
  failures.push(message);
}

/** A probe outcome that answered, for the pure describeProbe() checks. */
function probeOutcome(target: "A9" | "A8" | "A4", bank: number, index: number, rawHex: string): VcuProbeOutcome {
  return {
    target,
    bank,
    index,
    identifier: identifierFor(bank, index),
    status: "read",
    record: parseHexBytes(rawHex),
  };
}

/** A read outcome for a parameter that answered, as toParameterRow() would see it. */
function reading(index: number, rawHex: string): VcuReadOutcome {
  const parameter = parameterAtIndex(index);
  return {
    micro: parameter?.micro ?? "A9",
    index,
    identifier: identifierForIndex(index),
    status: "read",
    record: parseHexBytes(rawHex),
  };
}

function silent(index: number): VcuReadOutcome {
  const parameter = parameterAtIndex(index);
  return { micro: parameter?.micro ?? "A9", index, identifier: identifierForIndex(index), status: "no-response" };
}

/** A parameter on a micro that never opened a session — the shape "the bike was asleep" takes. */
function noSession(index: number): VcuReadOutcome {
  const parameter = parameterAtIndex(index);
  const micro = parameter?.micro ?? "A9";
  return {
    micro,
    index,
    identifier: identifierForIndex(index),
    status: "no-session",
    reason: `${micro} did not answer 10 81`,
  };
}

/**
 * Real CAN frames → what the gate would see, all at the same age.
 *
 * Deliberately routed through the actual `decodeFrame`, not through hand-written
 * values: that is what makes a passing gate evidence about the capture rather than
 * about this file. `ageMs` is supplied because a gate reading is a value AND its
 * age, and neither is a reading on its own.
 */
function gateReadingsFrom(frames: [number, string, number?][], ageMs = 50): ServiceGateReadings {
  const readings: ServiceGateReadings = {};
  for (const [id, hex, frameAgeMs] of frames) {
    for (const { key, value } of decodeFrame(id, Buffer.from(parseHexBytes(hex)))) {
      // Per-frame age, because "the charger frames stopped arriving" is a different
      // situation from "the bike stopped broadcasting", and the charging excuse turns
      // on exactly that difference.
      readings[key] = { value, ageMs: frameAgeMs ?? ageMs };
    }
  }
  return readings;
}

function snapshotOf(outcomes: VcuReadOutcome[]): VcuParameterSnapshot {
  return { readAt: 0, complete: true, micros: ["A9"], rows: outcomes.map(toParameterRow) };
}
