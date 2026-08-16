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
  toHex(buildRequestFrame("A9", { kind: "read-parameter", index: 258 })) === "A9 03 22 11 02 00 00 00",
  "reading 258 on the A9 should be A9 03 22 11 02"
);
expect(
  toHex(buildRequestFrame("A8", { kind: "read-parameter", index: 231 })) === "A8 03 22 10 E7 00 00 00",
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

// ── 8. Optional: the full stored A9 dump ───────────────────────────────────
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
console.log("✓ table, request encoding, framing, live 2026-08-08 reads, interpretation and diff all check out");

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
      address: 0xa9,
      // Real values off this bike, so a wrong route or a wrong width shows up as a
      // wrong number rather than as an arbitrary one.
      records: new Map([
        [258, parseHexBytes("4B")],
        [259, parseHexBytes("00 E1")],
      ]),
      silentIndices: [1],
      sessionIdleMs: 400,
    },
    { address: 0xa8, records: new Map([[231, parseHexBytes("01 90")]]) },
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

function snapshotOf(outcomes: VcuReadOutcome[]): VcuParameterSnapshot {
  return { readAt: 0, complete: true, micros: ["A9"], rows: outcomes.map(toParameterRow) };
}
