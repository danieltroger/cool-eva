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
import { tallyOf } from "../src/vcu/read-runner.ts";
import {
  evaluateServiceGate,
  serviceGateExcludedKeys,
  serviceGateSignalKeys,
  type ServiceGateReadings,
} from "../src/vcu/service-gate.ts";
import { decodeFrame } from "../src/can/decode.ts";
import { PROBE_TARGETS, describeProbe, parseProbeRequest } from "../src/vcu/probe.ts";
import { canIdsFor, identifierFor, kwpResponseCanIds } from "../src/vcu/param-codec.ts";
import type { VcuProbeOutcome } from "../src/vcu/kwp-client.ts";
import {
  buildWriteFrame,
  decodeParameterWriteReply,
  decodeRoutineReply,
  decodeSecurityAccessReply,
  routineIdFor,
  securityKeyForSeed,
} from "../src/vcu/write-codec.ts";
import { WRITE_TARGETS, planBitWrite, planWrite, writeTargetNames } from "../src/vcu/write-targets.ts";
import {
  SERVICE_STAMP_IDENTIFIERS,
  buildClearDtcsFrame,
  buildRtcSyncFrame,
  checkPiClock,
  decodeClearDtcsReply,
  decodeRtcSyncFrame,
  interpretServiceStamp,
  isClearDtcsReply,
} from "../src/vcu/service-actions.ts";
import { acquireBus, busHeldBy } from "../src/vcu/bus-lease.ts";
import { parseWriteRequest, utcMinute } from "../src/http/vcu-write.ts";
import { simulateVcuMicros } from "./simulated-vcu-micro.ts";
import {
  CAPTURED_FRAMES,
  CAPTURED_RTC_FRAMES,
  CAPTURED_SECURITY_PAIRS,
  KNOWN_VARIANT_DIFFERENCES,
  LIVE_BANK1_READS,
  parseHexBytes,
} from "./captured-vcu-records.ts";

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
// (0x102 b1 0x10 → 0x12).
const CHARGING_BODY_FRAME = "80 12 02 44 99 FF D8 FF";
// …and the same with 0x102 b2 bit0, the AC charging bit, also set.
const AC_CHARGING_BODY_FRAME = "80 12 03 44 99 FF D8 FF";
// 0x305 — the charger's own frame: mains 5.0 A, DC 20.0 A, DC 400.0 V. Its VALUES
// are never consulted; that it arrived at all is the evidence.
const CHARGER_FRAME = "00 32 00 C8 00 A0 0F 00";

const energizedNotCharging = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, CHARGING_BODY_FRAME],
    [0x104, PARKED_DRIVE_FRAME],
  ])
);
expect(!energizedNotCharging.safe, "an energized bike with nothing plugged in should still be refused");
expect(energizedNotCharging.chargingEvidence === null, "…and no charge evidence should be claimed");

const dcCharging = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, CHARGING_BODY_FRAME],
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

// ⚠️ The regression guard that matters most here: `charging` (0x102 b2 bit0) is
// NOT the charging bit — rides.db 2026-08-16 has it equal to `high_beam` at 421 of
// 421 timestamps, set at 100-142 km/h, and clear through all 25 real charging
// sessions. If it were treated as charge evidence, switching on the high beam would
// excuse the drive being energized. It must carry no weight at all.
const highBeamOnly = evaluateServiceGate(
  gateReadingsFrom([
    [0x102, AC_CHARGING_BODY_FRAME],
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
    [0x102, CHARGING_BODY_FRAME],
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
      [0x102, CHARGING_BODY_FRAME],
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
  ...gateReadingsFrom([[0x102, CHARGING_BODY_FRAME]]),
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
    [0x102, CHARGING_BODY_FRAME],
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
    ...gateReadingsFrom([[0x102, CHARGING_BODY_FRAME]]),
    ...gateReadingsFrom([[0x104, ROLLING_DRIVE_FRAME, 30_000]]),
    ...gateReadingsFrom([[0x305, CHARGER_FRAME]]),
  }).safe,
  "a 30 s old 0x104 is excused while charging — even one that used to say 9.5 km/h"
);
expect(
  !evaluateServiceGate({
    ...gateReadingsFrom([[0x102, CHARGING_BODY_FRAME, 30_000]]),
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

expect(canIdsFor("A9").request === 0x7c0 && canIdsFor("A9").response === 0x7e0, "the VCU micros are 0x7C0/0x7E0");
expect(canIdsFor("A8").request === 0x7c0, "both VCU micros share one pair of ids — they differ by address byte");

// ⚠️ The probe may address the two VCU micros and NOTHING else. A third target, `A4`
// on 0x7C3/0x7E3, was added and removed on 2026-08-16: 0x7E3 is DashboardV2's request
// id, so that option could have questioned the dashboard while the page said "charge
// manager". Checked as a LIST rather than as "A4 is absent", so that adding any new
// target has to come past this line and whatever justifies it.
expect(
  PROBE_TARGETS.join(",") === "A9,A8",
  `a probe should reach exactly the two VCU micros, reaches ${PROBE_TARGETS}`
);
expect(
  kwpResponseCanIds().join(",") === "2016",
  `only 0x7E0 should be a KWP reply id — 0x7E3 in this list means the dashboard's request id is back, got ${kwpResponseCanIds()}`
);

// A probe request is a person typing into a box, so every field is validated and a
// bad one is a message rather than a throw out of an HTTP handler.
const goodProbe = parseProbeRequest({ target: "A9", bank: "1", index: "258" });
expect(goodProbe.ok && goodProbe.request.index === 258, "a plain decimal index should parse");
const hexProbe = parseProbeRequest({ target: "a8", bank: "2", index: "0x102" });
expect(
  hexProbe.ok && hexProbe.request.index === 258 && hexProbe.request.target === "A8" && hexProbe.request.bank === 2,
  "hex should parse and the target should be case-insensitive — both are how an address arrives from a manual"
);
for (const [raw, why] of [
  [{ target: "A7", bank: "1", index: "1" }, "a target that answers no read on any bank"],
  [{ target: "A4", bank: "1", index: "1" }, "the removed charge-manager target, whose id pair was the dashboard's"],
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
// Both readings, always — this is the case where picking one would be wrong.
const negative = describeProbe(probeOutcome("A9", 2, 1, "FE A2"));
expect(negative.unsigned === 65186 && negative.signed === -350, "a probe should report the bytes both ways");
const refused = describeProbe({
  target: "A8",
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
    target: "A8",
    bank: 1,
    index: 1,
    identifier: 0x1001,
    status: "no-session",
    reason: "A8 did not answer 10 81",
  }).note?.includes("nothing is at this address") === true,
  "silence at an address should read as “nothing there or asleep”, not as a refusal"
);

// ── 13. The write codec: security keys, frames and replies ─────────────────
// Everything in the write path is unexercised against the bike (2026-08-16), so the
// only claims worth anything are the ones that can be checked here. This is the one
// with genuine ground truth: four real A8 seed/key pairs captured off this bike's own
// bus on 2026-08-08 while Energica's software was connected (DIAG_ADDRESSES.md §9.3).
//
// Getting this wrong costs one of about three SecurityAccess attempts, and the
// lockout clears only on a VCU power cycle — so it is checked against every captured
// pair rather than one.
for (const [seedHex, keyHex] of CAPTURED_SECURITY_PAIRS) {
  const produced = securityKeyForSeed(Number.parseInt(seedHex, 16));
  expect(
    produced === Number.parseInt(keyHex, 16),
    `seed 0x${seedHex} should key as 0x${keyHex}, produced 0x${produced.toString(16).toUpperCase().padStart(8, "0")}`
  );
}
// The trap that would silently break all four: JavaScript's bitwise operators are
// signed, so a seed with bit 30 set makes `(seed & 0x55555555) << 1` negative and the
// addition becomes a subtraction. 0xEF2BA23F above already covers it; this states it.
expect(securityKeyForSeed(0x40000000) >= 0, "a seed with bit 30 set must not produce a negative key");
expect(securityKeyForSeed(0xffffffff) <= 0xffffffff, "the key stays inside 32 bits");
// §8's disambiguation case: seed 8 separates `(A|B) − offset` from `A | (B − offset)`.
expect(securityKeyForSeed(8) === 0xc1a0bac2, "seed 0x00000008 should key as 0xC1A0BAC2, i.e. the (A|B) parse");

expect(
  toHex(buildWriteFrame("A8", { kind: "security-seed" })) === "A8 02 27 01 00 00 00 00",
  "a seed request should be A8 02 27 01"
);
expect(
  toHex(buildWriteFrame("A8", { kind: "security-key", key: 0x1c5f69e2 })) === "A8 06 27 02 1C 5F 69 E2",
  "a key send should be A8 06 27 02 + the key big-endian"
);
// ⚠️ The routine is named, never numbered, and this is the assertion that says so.
// `31 FB` — one digit away, and the routine that WIPES BATTERY STATISTICS — has no
// name in the codec and so cannot be built at all.
expect(
  toHex(buildWriteFrame("A8", { kind: "start-routine", routine: "set-service-point" })) === "A8 02 31 FC 00 00 00 00",
  "Set Service Point should be A8 02 31 FC"
);
expect(routineIdFor("set-service-point") === 0xfc, "the only named routine is 0xFC");
expectThrows(
  () => buildWriteFrame("A8", { kind: "start-routine", routine: "reset-battery-statistics" } as never),
  "a routine the codec does not name must be refused, not encoded — 31 FB must stay unreachable"
);
expectThrows(
  () => buildWriteFrame("A8", { kind: "ecu-reset" } as never),
  "a request kind outside the write union must be refused, not encoded"
);

// The replies, including the two negative ones the factory capture actually recorded.
expect(
  decodeSecurityAccessReply(parseHexBytes("67 01 A5 7D 5F 18")).kind === "seed",
  "67 01 + four bytes should decode as a seed"
);
const seedReply = decodeSecurityAccessReply(parseHexBytes("67 01 A5 7D 5F 18"));
expect(seedReply.kind === "seed" && seedReply.seed === 0xa57d5f18, "the seed should be read big-endian");
const topBitSeed = decodeSecurityAccessReply(parseHexBytes("67 01 FF FF FF FF"));
expect(
  topBitSeed.kind === "seed" && topBitSeed.seed === 0xffffffff,
  "a seed with the top bit set must not read as negative"
);
expect(decodeSecurityAccessReply(parseHexBytes("67 02 34")).kind === "unlocked", "67 02 34 should decode as unlocked");
const badKey = decodeSecurityAccessReply(parseHexBytes("7F 27 35"));
expect(
  badKey.kind === "refused" && badKey.negativeResponseCode === 0x35,
  "7F 27 35 should decode as a refusal with invalidKey — the one that spends an attempt"
);
expect(
  decodeParameterWriteReply(parseHexBytes("6E 13 EE"), 0x13ee).kind === "accepted",
  "6E 13 EE should decode as an accepted write of 0x13EE"
);
// The failure that would otherwise be invisible: a well-formed acknowledgement of a
// DIFFERENT identifier. Filing it as success would mean reporting a write to a cell
// nobody asked about.
expect(
  decodeParameterWriteReply(parseHexBytes("6E 13 EF"), 0x13ee).kind === "identifier-mismatch",
  "an acknowledgement of another identifier must not read as success"
);
const staleUnlock = decodeParameterWriteReply(parseHexBytes("7F 2E 33"), 0x13ee);
expect(
  staleUnlock.kind === "refused" && staleUnlock.negativeResponseCode === 0x33,
  "7F 2E 33 should decode as securityAccessDenied — the stale-unlock case the capture recorded twice"
);
expect(
  decodeRoutineReply(parseHexBytes("71 FC"), "set-service-point").kind === "started",
  "71 FC should read as started"
);
expect(
  decodeRoutineReply(parseHexBytes("71 FB"), "set-service-point").kind === "routine-mismatch",
  "an echo of 0xFB must never read as the service point having run"
);
// ⚠️ `71 FC` is INFERRED, never logged. So an unexpected shape has to come back as
// "unknown" and not as failure OR success — the routine is irreversible.
expect(
  decodeRoutineReply(parseHexBytes("71"), "set-service-point").kind === "unrecognised",
  "a 71 with no routine echo means the outcome is unknown, not that it worked"
);

// ── 14. THE ALLOWLIST, and everything that may not get past it ─────────────
// The core of the write feature's safety, and the part that is fully testable with no
// bike at all — which is the reason it is shaped as a pure function in the first place.

expect(WRITE_TARGETS.length === 5, `the allowlist should hold 5 parameters, holds ${WRITE_TARGETS.length}`);
expect(
  writeTargetNames().join(",") === "MAX_DC_CHG_CURRENT,FCHG_CURRENT_GAIN,TORQUE_LIMIT,REGEN_TORQUE_LIMIT,VSM_CONFIG_1",
  `the allowlist should be exactly the five parameters asked for, is ${writeTargetNames().join(",")}`
);
// Every entry must agree with params.ecf about what it is. The allowlist carries both
// an index and a name so that a renumbered variant file is a startup error rather
// than a write to whatever now sits at 258.
for (const target of WRITE_TARGETS) {
  const parameter = parameterAtIndex(target.index);
  expect(
    parameter?.name.toUpperCase() === target.name.toUpperCase(),
    `the allowlist calls index ${target.index} ${target.name}, params.ecf calls it ${parameter?.name}`
  );
}

// ⚠️ THE REJECTION. Anything not on the list is refused in the PURE LAYER, with a
// reason, and never becomes a plan — so it can never become a frame. These are the
// neighbours that would hurt most: a cell limit, a throttle map, the current limit.
for (const name of [
  "CELL_OVERVOLTAGE",
  "THROTTLE_MAX_TH",
  "ACTIVE_CURRENT_LIMIT",
  "LIMP_MIN_CELL",
  "WATER_PUMP_MIN_CURR_TH",
  "SPEED_LIMIT",
  "MODEL",
  "NOT_A_PARAMETER_AT_ALL",
]) {
  const refused = planWrite(name, 1, 0);
  expect(!refused.ok, `${name} is not on the allowlist and must be refused`);
  expect(!refused.ok && refused.reason.includes(name), `${name}'s refusal should name what was asked for`);
  expect(
    !refused.ok && refused.reason.includes("MAX_DC_CHG_CURRENT"),
    `${name}'s refusal should list what IS writable, so nobody goes hunting for identifiers`
  );
}
// Case-insensitively, because a name arrives from a manual or a URL.
expect(planWrite("max_dc_chg_current", 80, 75).ok, "the allowlist should match names case-insensitively");

// The write the owner actually wants, end to end through the pure layer.
const dcPlan = planWrite("MAX_DC_CHG_CURRENT", 80, 75);
expect(dcPlan.ok && dcPlan.plan.identifier === 0x1102, "MAX_DC_CHG_CURRENT should address CID 0x1102");
expect(dcPlan.ok && dcPlan.plan.micro === "A9", "MAX_DC_CHG_CURRENT lives on the A9");
expect(dcPlan.ok && toHex(dcPlan.plan.record) === "50", "80 should encode as the single byte 0x50");
expect(
  dcPlan.ok &&
    toHex(buildWriteFrame("A9", { kind: "write-parameter", plan: dcPlan.plan })) === "A9 04 2E 11 02 50 00 00",
  `writing 80 should be A9 04 2E 11 02 50, got ${dcPlan.ok ? toHex(buildWriteFrame("A9", { kind: "write-parameter", plan: dcPlan.plan })) : "(no plan)"}`
);

// ⚠️ THE RANGES, enforced in the pure layer so they are testable without a bike.
// Each bound is policy, written down with its reasoning in write-targets.ts; what is
// checked here is that the policy is actually applied.
for (const [name, value, allowed] of [
  ["MAX_DC_CHG_CURRENT", 80, true], // the factory's own 80 A option
  ["MAX_DC_CHG_CURRENT", 75, true],
  ["MAX_DC_CHG_CURRENT", 0, true],
  ["MAX_DC_CHG_CURRENT", 81, false], // one past the highest value Energica ever shipped
  ["MAX_DC_CHG_CURRENT", 127, false], // the datatype's own ceiling is NOT the policy's
  ["MAX_DC_CHG_CURRENT", -1, false],
  ["FCHG_CURRENT_GAIN", 225, true],
  ["FCHG_CURRENT_GAIN", 255, true],
  ["FCHG_CURRENT_GAIN", 256, true],
  ["FCHG_CURRENT_GAIN", 513, false],
  ["TORQUE_LIMIT", 2300, true],
  ["TORQUE_LIMIT", 2760, true], // +20 %, the same step already taken on regen
  ["TORQUE_LIMIT", 2761, false],
  ["REGEN_TORQUE_LIMIT", 600, true],
  ["REGEN_TORQUE_LIMIT", 900, true],
  ["REGEN_TORQUE_LIMIT", 901, false],
] as [string, number, boolean][]) {
  // previousValue is deliberately something else, so a rejected value is rejected for
  // being out of range and not for being a no-op.
  const planned = planWrite(name, value, value === 0 ? 1 : 0);
  expect(planned.ok === allowed, `${name} = ${value} should be ${allowed ? "allowed" : "refused"}`);
  if (!allowed) {
    expect(!planned.ok && planned.reason.includes(String(value)), `${name} = ${value} should be refused by name`);
  }
}
// A fractional value is refused rather than rounded into a neighbouring one.
expect(!planWrite("MAX_DC_CHG_CURRENT", 79.5, 75).ok, "a fractional value must be refused, not rounded");
expect(!planWrite("MAX_DC_CHG_CURRENT", Number.NaN, 75).ok, "NaN must be refused");

// ⚠️ VSM_CONFIG_1 is a BIT TOGGLE and nothing else. There is no input to the pure
// layer that writes a whole word into it — which is the protection against a
// fat-fingered word reconfiguring the PSU type (0x0760) or Bluetooth (0x3000).
expect(!planWrite("VSM_CONFIG_1", 0x1117, 0x1113).ok, "VSM_CONFIG_1 must not be writable as a word");
expect(!planWrite("VSM_CONFIG_1", 4, 0x1113).ok, "…not even with the value Energica's own option data quotes");
expect(!planBitWrite("MAX_DC_CHG_CURRENT", "anything", true, 75).ok, "a value parameter has no bits to toggle");

// The toggle the owner wants: 0x1113 → 0x1117, one bit, nothing else.
const gripsOn = planBitWrite("VSM_CONFIG_1", "heated-handlebars", true, 0x1113);
expect(
  gripsOn.ok && gripsOn.plan.value === 0x1117,
  `enabling grips should make 0x1117, made ${gripsOn.ok ? gripsOn.plan.value.toString(16) : "nothing"}`
);
expect(gripsOn.ok && toHex(gripsOn.plan.record) === "11 17", "…encoded as the WORD 11 17");
const gripsOff = planBitWrite("VSM_CONFIG_1", "heated-handlebars", false, 0x1117);
expect(gripsOff.ok && gripsOff.plan.value === 0x1113, "turning it off again should give 0x1113 back");
// The load-bearing property: WHATEVER the current word is, only the one mask moves.
// This is what makes "a bit toggle cannot reconfigure the PSU type" a fact about the
// arithmetic rather than about the caller.
for (const currentWord of [0x0000, 0x1113, 0x1117, 0xffff, 0x0760, 0x3000, 0x8421]) {
  for (const on of [true, false]) {
    const planned = planBitWrite("VSM_CONFIG_1", "heated-handlebars", on, currentWord);
    expect(planned.ok, `a toggle against 0x${currentWord.toString(16)} should plan`);
    if (planned.ok) {
      const changed = (planned.plan.value ^ currentWord) >>> 0;
      expect(
        changed === 0 || changed === 0x0004,
        `toggling grips against 0x${currentWord.toString(16)} moved mask 0x${changed.toString(16)}`
      );
      expect(
        (planned.plan.value & 0x0760) >>> 0 === (currentWord & 0x0760) >>> 0,
        "the PSU-type field must never move"
      );
      expect(
        (planned.plan.value & 0x3000) >>> 0 === (currentWord & 0x3000) >>> 0,
        "the Bluetooth field must never move"
      );
    }
  }
}
expect(
  !planBitWrite("VSM_CONFIG_1", "fast-charge", true, 0x1113).ok,
  "only the bits the allowlist names may be toggled"
);
expect(
  !planBitWrite("VSM_CONFIG_1", "heated-handlebars", true, 0x10000).ok,
  "a current word outside 16 bits must be refused, not masked"
);
expect(!planBitWrite("VSM_CONFIG_1", "heated-handlebars", true, -1).ok, "a negative current word must be refused");

// Widths and signs come from params.ecf, and a value that does not fit is refused
// rather than truncated. A truncated write is the worst outcome available here: it
// would be accepted and leave a number nobody chose.
const torque = planWrite("TORQUE_LIMIT", 2300, 2000);
expect(torque.ok && toHex(torque.plan.record) === "08 FC", "a WORD should encode big-endian across two bytes");
expect(torque.ok && torque.plan.record.length === 2, "TORQUE_LIMIT is a WORD");
expect(dcPlan.ok && dcPlan.plan.record.length === 1, "MAX_DC_CHG_CURRENT is a BYTE");

// ⚠️ THE CODEC'S OWN GUARD. A plan forged by hand — deserialised from JSON, built by
// a future caller that skipped write-targets.ts — is refused at the last moment,
// before the bytes exist. This is what makes "the codec cannot write a
// non-allowlisted identifier" true of the CODEC and not only of today's callers.
expectThrows(
  () =>
    buildWriteFrame("A9", {
      kind: "write-parameter",
      plan: {
        name: "CELL_OVERVOLTAGE",
        index: 78,
        micro: "A9",
        identifier: 0x104e,
        record: Uint8Array.from([0x10, 0xcc]),
        value: 4300,
        previousValue: 4200,
        description: "forged",
      },
    }),
  "a hand-built plan for a parameter that is not on the allowlist must be refused by the codec"
);
expectThrows(
  () =>
    buildWriteFrame("A9", {
      kind: "write-parameter",
      // An allowlisted NAME with an out-of-range value and bytes to match. The name
      // check alone would pass this; re-deriving the plan is what catches it.
      plan: {
        name: "MAX_DC_CHG_CURRENT",
        index: 258,
        micro: "A9",
        identifier: 0x1102,
        record: Uint8Array.from([0x7f]),
        value: 127,
        previousValue: 75,
        description: "forged",
      },
    }),
  "a forged plan carrying an out-of-range value must be refused by the codec"
);
expectThrows(
  () =>
    buildWriteFrame("A9", {
      kind: "write-parameter",
      // An allowlisted name and an in-range value, with BYTES that say something
      // else. The bytes are what reach the bus, so the bytes are what is compared.
      plan: {
        name: "MAX_DC_CHG_CURRENT",
        index: 258,
        micro: "A9",
        identifier: 0x1102,
        record: Uint8Array.from([0x63]),
        value: 80,
        previousValue: 75,
        description: "forged",
      },
    }),
  "a forged plan whose bytes disagree with its value must be refused by the codec"
);

// ── 15. The clock: the bike's RTC frame, and whether the Pi may set it ─────
// ✅ The two frames below really went out, on 2026-08-16, from another owner's tool.
// They are the only end-to-end ground truth for the bit packing, so the builder is
// checked against them and the decoder is checked against the builder.
for (const [hex, iso] of CAPTURED_RTC_FRAMES) {
  const built = buildRtcSyncFrame(new Date(iso));
  expect(toHex(built) === hex, `${iso} should pack as ${hex}, packed as ${toHex(built)}`);
  const decoded = decodeRtcSyncFrame(parseHexBytes(hex));
  const when = new Date(iso);
  expect(
    decoded !== null &&
      decoded.hour === when.getUTCHours() &&
      decoded.minute === when.getUTCMinutes() &&
      decoded.second === when.getUTCSeconds() &&
      decoded.day === when.getUTCDate() &&
      decoded.month === when.getUTCMonth() + 1 &&
      decoded.year === when.getUTCFullYear() &&
      decoded.weekday === when.getUTCDay(),
    `${hex} should decode back to ${iso}`
  );
}
// Every field crosses a byte boundary except the year, so a round trip over a spread
// of instants is what proves the shifts rather than one lucky one.
for (const iso of [
  "2026-01-01T00:00:00Z",
  "2026-12-31T23:59:59Z",
  "2026-08-16T06:03:29Z",
  "2027-02-28T13:37:07Z",
  "2030-06-30T19:45:33Z",
]) {
  const when = new Date(iso);
  const decoded = decodeRtcSyncFrame(buildRtcSyncFrame(when));
  expect(
    decoded !== null &&
      decoded.hour === when.getUTCHours() &&
      decoded.minute === when.getUTCMinutes() &&
      decoded.second === when.getUTCSeconds() &&
      decoded.day === when.getUTCDate() &&
      decoded.month === when.getUTCMonth() + 1 &&
      decoded.weekday === when.getUTCDay() &&
      decoded.year === when.getUTCFullYear(),
    `${iso} should survive a pack/unpack round trip`
  );
}
// 0x120 carries other opcodes — the charge-current setpoint traffic uses 0x98, 0x9A,
// 0x96, 0xAC — so a frame on that id that is not ours must read as "not ours".
expect(
  decodeRtcSyncFrame(parseHexBytes("98 FF 4B 00 00 00 00 00")) === null,
  "a charge-setpoint frame is not a clock frame"
);

// ⚠️ The Pi's own clock. Fails closed: no satellite time is a refusal, because a Pi
// with no RTC and no fix is exactly the machine whose clock is wrong.
const goodClock = Date.UTC(2026, 7, 16, 12, 0, 0);
expect(
  checkPiClock({ systemEpochMs: goodClock, gpsEpochSeconds: goodClock / 1000, gpsAgeMs: 500 }).trustworthy,
  "a clock agreeing with a fresh GPS fix should be trusted"
);
expect(
  !checkPiClock({ systemEpochMs: goodClock, gpsEpochSeconds: null, gpsAgeMs: null }).trustworthy,
  "no satellite time at all must refuse — that is the state a Pi with no RTC boots into"
);
expect(
  !checkPiClock({ systemEpochMs: goodClock, gpsEpochSeconds: goodClock / 1000, gpsAgeMs: 600_000 }).trustworthy,
  "a ten-minute-old fix cannot vouch for the clock now"
);
expect(
  !checkPiClock({ systemEpochMs: goodClock, gpsEpochSeconds: goodClock / 1000 + 3600, gpsAgeMs: 500 }).trustworthy,
  "an hour away from satellite time must refuse — gps/clock.ts steps past 60 s, so it has not managed to"
);
// ⚠️ The one that is not hypothetical: a GPS date-decode bug stamped 49 772 rows of
// this bike's log as the year 2060.
const year2060 = Date.UTC(2060, 0, 1);
expect(
  !checkPiClock({ systemEpochMs: year2060, gpsEpochSeconds: year2060 / 1000, gpsAgeMs: 500 }).trustworthy,
  "a clock reading 2060 must refuse even when a fresh GPS reading agrees with it"
);
expect(
  !checkPiClock({ systemEpochMs: Date.UTC(2020, 0, 1), gpsEpochSeconds: Date.UTC(2020, 0, 1) / 1000, gpsAgeMs: 500 })
    .trustworthy,
  "a clock before this code was written must refuse — a Pi with no RTC boots to a filesystem timestamp"
);

// ── 16. The service stamp, mode 04, the bus lease and the request parser ───
// A8's last-service block, decoded the way EMsuite's own GetMotorbikeService() does.
// ⚠️ Untried on this bike: these four identifiers sit outside params.ecf's 1…277 and
// no sweep has ever reached them.
const stampNow = Date.UTC(2026, 7, 16, 12, 0, 0);
expect(SERVICE_STAMP_IDENTIFIERS.dateLow.identifier === 0x13e8, "the service date's low word is 0x13E8");
expect(SERVICE_STAMP_IDENTIFIERS.odometerHigh.identifier === 0x13eb, "the odometer's high word is 0x13EB");
// 2026-06-01T00:00:00Z is 833 587 200 s after 2000-01-01 = 0x31AF_8800.
const realStamp = interpretServiceStamp(
  { dateLow: 0x8800, dateHigh: 0x31af, odometerLow: 0xa410, odometerHigh: 0x0000 },
  stampNow
);
expect(
  realStamp.dateIso === "2026-06-01T00:00:00.000Z",
  `the stamp should decode to 2026-06-01, decoded ${realStamp.dateIso}`
);
expect(realStamp.odometer === 42000, `the odometer should be (high << 16) | low, got ${realStamp.odometer}`);
expect(realStamp.implausible === null, "a 2026 stamp on a 2026 clock is plausible");
// The readings that are NOT dates, said plainly instead of rendered as 2000-01-01.
expect(
  interpretServiceStamp({ dateLow: 0, dateHigh: 0, odometerLow: 0, odometerHigh: 0 }, stampNow).implausible !== null,
  "an all-zero stamp must be called out, not shown as New Year's Day 2000"
);
expect(
  interpretServiceStamp({ dateLow: 0xffff, dateHigh: 0xffff, odometerLow: 0, odometerHigh: 0 }, stampNow)
    .implausible !== null,
  "an erased EEPROM cell must be called out"
);
expect(
  interpretServiceStamp({ dateLow: 0x8800, dateHigh: 0x31af, odometerLow: 0, odometerHigh: 0 }, Date.UTC(2020, 0, 1))
    .implausible !== null,
  "a stamp in the future must be called out — either the bike's clock is wrong or ours is"
);
// The high word really is the high word. Swapping them would decode to a wrong date
// that still looks like a date, which is why it is checked rather than assumed.
expect(
  interpretServiceStamp({ dateLow: 0x31af, dateHigh: 0x8800, odometerLow: 0, odometerHigh: 0 }, stampNow)
    .dateSeconds !== realStamp.dateSeconds,
  "the two halves must not be interchangeable"
);

// Mode 04. Plain OBD framing, not the micros' extended addressing.
expect(toHex(buildClearDtcsFrame()) === "01 04 00 00 00 00 00 00", "mode 04 should be a one-byte payload, 01 04");
expect(decodeClearDtcsReply(parseHexBytes("01 44 00 00 00 00 00 00")).kind === "cleared", "01 44 means cleared");
const clearRefused = decodeClearDtcsReply(parseHexBytes("03 7F 04 22 00 00 00 00"));
expect(
  clearRefused.kind === "refused" && clearRefused.negativeResponseCode === 0x22,
  "7F 04 22 should decode as conditionsNotCorrect"
);
// ⚠️ The artefact this bus really produces: something answers `03 7F 00 33`, a
// refusal of a service 0x00 that does not exist and that we never sent. Reading it as
// our answer is what made the mode-03 transfer look impossible for a while.
expect(
  decodeClearDtcsReply(parseHexBytes("03 7F 00 33 00 00 00 00")).kind === "unrecognised",
  "a refusal naming a service we did not send must not be read as our answer"
);

// ⚠️ And the discriminator that decides whether a frame in the OBD range is ours AT
// ALL. The always-on poller is never paused by service mode, so it is sending
// mode-01 PIDs and sometimes a multi-frame mode-03 transfer while a Mode 04 reply is
// awaited. Consuming one of those would report "nothing confirmed" for an action that
// may already have erased the diagnostic memory, and would take the frame away from
// the poller — losing a whole transfer if it were a Consecutive Frame.
expect(isClearDtcsReply(parseHexBytes("01 44 00 00 00 00 00 00")), "a positive mode-04 reply is ours");
expect(isClearDtcsReply(parseHexBytes("03 7F 04 22 00 00 00 00")), "a refusal naming service 04 is ours");
for (const [hex, why] of [
  ["04 41 0D 00 00 00 00 00", "a mode-01 PID 0D reply — the poller's, at 2 Hz throughout our window"],
  ["03 41 0C 1A 2B 00 00 00", "a mode-01 rpm reply"],
  ["10 50 43 27 05 62 10 00", "the First Frame of a mode-03 transfer"],
  ["21 10 03 05 14 C1 11 C1", "a Consecutive Frame — taking this loses the whole transfer"],
  ["03 7F 00 33 00 00 00 00", "the spurious refusal of a service nobody sent"],
  ["03 7F 03 12 00 00 00 00", "a refusal of mode 03, which is the poller's request and not ours"],
  ["01 43 00 00 00 00 00 00", "a mode-03 positive reply"],
] as [string, string][]) {
  expect(!isClearDtcsReply(parseHexBytes(hex)), `${why} must NOT be consumed as our mode-04 answer`);
}

// The bus lease: one thing at a time, across files.
const firstLease = acquireBus("a parameter read");
expect(firstLease.ok, "the first caller should get the bus");
const blocked = acquireBus("a service write");
expect(!blocked.ok && blocked.heldBy === "a parameter read", "a second caller should be told who has it");
expect(busHeldBy() === "a parameter read", "busHeldBy should name the holder");
if (firstLease.ok) {
  firstLease.lease.release();
}
expect(busHeldBy() === null, "releasing should free it");
// A late release must not free somebody ELSE's lease — the bug that would let two
// callers both believe the bus was idle. Two leases with the SAME name, because that
// is the case a name comparison would get wrong.
const departingLease = acquireBus("a probe");
expect(!acquireBus("a probe").ok, "the bus is still held while the first probe has it");
if (departingLease.ok) {
  departingLease.lease.release();
  // Releasing twice is safe, and is what a `finally` on a retried path does.
  departingLease.lease.release();
}
const successorLease = acquireBus("a probe");
expect(successorLease.ok, "the bus should be free once its holder released");
if (successorLease.ok) {
  if (departingLease.ok) {
    // The departed lease releasing again must NOT take the new holder's away.
    departingLease.lease.release();
  }
  expect(busHeldBy() === "a probe", "a stale release must not free the current holder's lease");
  successorLease.lease.release();
}
expect(busHeldBy() === null, "the bus should be idle again at the end of the checks");

// The HTTP request parser. Every rejection is a person typing, so each is a reason.
const nowForParse = Date.UTC(2026, 7, 16, 14, 3, 30);
expect(utcMinute(nowForParse) === "2026-08-16T14:03Z", "the confirmation minute should be minute-resolution UTC");
for (const [query, why] of [
  ["action=parameter&name=MAX_DC_CHG_CURRENT&value=80", "a write with no expected= (the compare-and-swap needs one)"],
  ["action=parameter&value=80&expected=75", "a write with no name"],
  ["action=parameter&name=MAX_DC_CHG_CURRENT&value=eighty&expected=75", "a non-numeric value"],
  ["action=bit&name=VSM_CONFIG_1&bit=heated-handlebars&expected=4371", "a bit toggle with no on="],
  ["action=bit&name=VSM_CONFIG_1&bit=heated-handlebars&on=2&expected=4371", "on= that is not 0 or 1"],
  ["action=set-service-point", "the irreversible routine without confirm="],
  ["action=set-service-point&confirm=yes", "…or with the wrong confirmation"],
  ["action=clear-dtcs", "clearing DTCs without confirm="],
  ["action=sync-clock", "a clock sync with no confirmed minute"],
  ["action=sync-clock&confirm=2026-08-16T13:59Z", "a clock sync confirming a minute that has passed"],
  ["action=ecu-reset", "an action that does not exist"],
  ["", "no action at all"],
] as [string, string][]) {
  const parsed = parseWriteRequest(new URLSearchParams(query), nowForParse);
  expect(!parsed.ok, `${why} should be refused`);
  expect(!parsed.ok && parsed.reason.length > 0, `${why} should say why`);
}
expect(
  parseWriteRequest(new URLSearchParams("action=parameter&name=MAX_DC_CHG_CURRENT&value=80&expected=75"), nowForParse)
    .ok,
  "a complete parameter write should parse"
);
expect(
  parseWriteRequest(new URLSearchParams("action=sync-clock&confirm=2026-08-16T14:03Z"), nowForParse).ok,
  "a clock sync confirming the current minute should parse"
);
expect(
  parseWriteRequest(new URLSearchParams("action=set-service-point&confirm=set-service-point"), nowForParse).ok,
  "the routine with its confirmation should parse"
);

// ⚠️ Hex values, and the sign in particular. `-0x50` used to parse as **+80**: the
// `-` was stripped, handed to parseInt (which honours it), and then re-applied as a
// multiplier — applying it twice. A negative that every allowlist entry would have
// refused with a reason became a positive, in-range value headed for a calibration
// EEPROM. Caught in review on PR #60, never shipped.
for (const [raw, expectedValue] of [
  ["80", 80],
  ["0x50", 80],
  ["0X50", 80],
  ["-0x50", -80],
  ["-80", -80],
] as [string, number][]) {
  const parsed = parseWriteRequest(
    new URLSearchParams(`action=parameter&name=MAX_DC_CHG_CURRENT&value=${raw}&expected=75`),
    nowForParse
  );
  expect(
    parsed.ok && parsed.request.kind === "parameter" && parsed.request.value === expectedValue,
    `value=${raw} should parse as ${expectedValue}, parsed as ${parsed.ok && parsed.request.kind === "parameter" ? parsed.request.value : "a refusal"}`
  );
}
// …and a negative that does get through the parser is refused by the allowlist, which
// is the second of the two locks doing its job.
expect(!planWrite("MAX_DC_CHG_CURRENT", -80, 75).ok, "a negative charge current must be refused by the range check");

// ── 17. Optional: the full stored A9 dump ──────────────────────────────────
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
  "✓ table, request encoding, framing, live 2026-08-08 reads, interpretation, diff, the energica_tool.py backup CSV, " +
    "the read tally, the service-mode safety gate, the identifier probe, the write codec against four captured " +
    "seed/key pairs, the write allowlist and its ranges, the RTC frame against two frames that really went out, " +
    "the service stamp, mode 04, the bus lease and the write request parser all check out"
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
function probeOutcome(target: "A9" | "A8", bank: number, index: number, rawHex: string): VcuProbeOutcome {
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
