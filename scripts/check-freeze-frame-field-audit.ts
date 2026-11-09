import assert from "node:assert/strict";
import { INFOKEY_TABLE, lookupInfokey, scaleInfokeyValue } from "../src/diagnostics/infokey-table.ts";
import { decodeFreezeFrameResponse, type FreezeFrame, type FreezeFrameValue } from "../src/diagnostics/freeze-frame.ts";
import { recordedFieldDisplay } from "../public/lib/fault-records.js";
import { infokeyFault } from "../public/lib/infokey-bounds.js";
import { MANUFACTURER_INFOKEY_AUDIT } from "./manufacturer-infokey-audit.ts";
import {
  CAPTURED_FREEZE_FRAMES,
  capturedFreezeFramePayload,
  componentSixtyTwoWithSentinel,
} from "./captured-freeze-frames.ts";
import {
  CAPTURED_EXCHANGE_53,
  CAPTURED_EXCHANGE_54,
  CAPTURED_EXCHANGE_60,
  LIFETIME_READ_PAYLOADS,
  capturedExchangePayload,
} from "./captured-lifetime-reads.ts";
import { parseHexFrame } from "./captured-dtc-transfer.ts";

function checkFreezeFrameFieldAudit(): void {
  assert.equal(MANUFACTURER_INFOKEY_AUDIT.length, 120);
  assert.deepEqual(
    MANUFACTURER_INFOKEY_AUDIT.map(row => row[0]),
    Array.from({ length: 120 }, (_, index) => index + 1)
  );
  assert.deepEqual(
    INFOKEY_TABLE.map(field => [field.id, field.name, field.datatype, field.unit, field.equation]),
    MANUFACTURER_INFOKEY_AUDIT,
    "Every field must match the independently opened manufacturer dictionary."
  );

  const replies = recordedReplies();
  const seenInfokeys = new Set<number>();
  let frameCount = 0;
  let fieldSlotCount = 0;
  for (const reply of replies) {
    const decoded = decodeFreezeFrameResponse(reply.payload, reply.component);
    if (decoded.kind !== "frame") {
      assert.equal(reply.component, 54);
      assert.equal(decoded.rawHex, "57 00");
      continue;
    }
    frameCount += 1;
    assert.equal(decoded.frame.truncated, false);
    assert.notEqual(decoded.frame.cyclesSinceStored, null);
    for (const field of decoded.frame.values) {
      const source = MANUFACTURER_INFOKEY_AUDIT.find(row => row[0] === field.infokey);
      assert(source, `Unknown recorded field ${field.infokey}`);
      assert.deepEqual([field.name, field.datatype, field.unit, field.equation], source.slice(1));
      seenInfokeys.add(field.infokey);
      fieldSlotCount += 1;
    }
  }
  assert.equal(replies.length, 34);
  assert.equal(frameCount, 33);
  assert.equal(fieldSlotCount, 211);
  assert.equal(seenInfokeys.size, 65, "The captures cover 65 fields; the other 55 have metadata verification only.");

  checkRecordedValues(replies);
  checkUncapturedEquations();
  checkCorruptionAndRefusals(replies);
  console.log(
    "✓ Freeze-frame audit: all 120 definitions; 34 recorded replies, 211 slots/65 fields; low rails preserved, sentinels rejected"
  );
}

interface RecordedReply {
  date: string;
  component: number;
  payload: Uint8Array;
}

function recordedReplies(): RecordedReply[] {
  return [
    ...CAPTURED_FREEZE_FRAMES.map(entry => ({
      date: "2026-08-08",
      component: entry.component,
      payload: capturedFreezeFramePayload(entry),
    })),
    ...LIFETIME_READ_PAYLOADS.map(entry => ({
      date: "2026-09-08",
      component: entry.component,
      payload: parseHexFrame(entry.payloadHex),
    })),
    ...[CAPTURED_EXCHANGE_53, CAPTURED_EXCHANGE_54, CAPTURED_EXCHANGE_60].map(entry => ({
      date: "2026-09-08",
      component: entry.component,
      payload: capturedExchangePayload(entry),
    })),
  ];
}

function checkRecordedValues(replies: RecordedReply[]): void {
  const cases: readonly [number, number, number, number, string][] = [
    [40, 3, 1296, 1296, "mV"],
    [34, 3, 1296, 1296, "mV"],
    [35, 3, 1296, 1296, "mV"],
    [39, 3, 1296, 1296, "mV"],
    [36, 3, 12720, 12720, "mV"],
    [37, 3, 12720, 12720, "mV"],
    [48, 3, 12736, 12736, "mV"],
    [48, 29, 9028, 9028, "mV"],
    [62, 3, 1732, 1732, "mV"],
    [7, 7, -883, -88.3, "A"],
    [4, 6, 2959, 295.9, "V"],
    [4, 8, 35, 35, "°C"],
    [4, 9, 27, 27, "°C"],
    [44, 61, 349, 34.9, "°C"],
    [44, 11, 137, 28.5, "°C"],
    [51, 36, 174729, 17472.9, "km"],
    [3, 6, 0, 0, "V"],
    [44, 58, -4, -4, ""],
    [53, 87, 65535, 65535, ""],
    [53, 88, 65535, 65535, ""],
  ];
  for (const [component, infokey, raw, expected, unit] of cases) {
    const field = fieldFrom(recordedFrame(replies, component), infokey);
    assert.equal(field.raw, raw);
    assert.equal(field.unit, unit);
    assert(
      field.value !== null && Math.abs(field.value - expected) < 1e-8,
      `${component}/${infokey} must preserve ${expected} ${unit}, got ${field.value}`
    );
    assert.equal(
      infokeyFault(field),
      null,
      `${component}/${infokey} is unusual or ordinary data, not a sensor sentinel.`
    );
    assert.equal(recordedFieldDisplay(field).kind, "value");
  }
  const lighting = recordedFrame(replies, 40);
  assert.equal(lighting.obdCode, "B1012");
  assert.equal(lighting.cyclesSinceStored, 23);
  assert.equal(recordedFieldDisplay(fieldFrom(lighting, 3)).text.replace(/\s/g, ""), "1296mV");
  const later = recordedFrame(replies, 51, "2026-09-08");
  assert.equal(fieldFrom(later, 36).raw, 184405);
  assert.equal(fieldFrom(later, 36).value, 18440.5);
}

function checkUncapturedEquations(): void {
  // These two wheel-speed fields have no captured values; these are source-equation examples.
  for (const [infokey, raw, expected] of [
    [107, 1280, 72],
    [109, 256, 14.4],
  ] as const) {
    const field = lookupInfokey(infokey);
    assert(field);
    const scaled = scaleInfokeyValue(field, raw);
    assert(scaled.applied && Math.abs(scaled.value - expected) < 1e-8);
  }
  const speed = lookupInfokey(106);
  assert(speed);
  assert.equal(speed.equation, "", "A name ending x10 does not establish a different manufacturer equation.");
}

function checkCorruptionAndRefusals(replies: RecordedReply[]): void {
  const sentinel = decodeFreezeFrameResponse(componentSixtyTwoWithSentinel(), 62);
  assert(sentinel.kind === "frame");
  const load = fieldFrom(sentinel.frame, 4);
  assert.equal(load.raw, 65535);
  assert.equal(recordedFieldDisplay(load).kind, "fault", "The constructed current sentinel must remain a fault.");

  // Constructed corruptions of real replies; the committed capture bytes are never edited.
  const temperature = payloadFrom(replies, 44).slice();
  new DataView(temperature.buffer, temperature.byteOffset, temperature.byteLength).setInt16(10, -2420, false);
  const decoded = decodeFreezeFrameResponse(temperature, 44);
  assert(decoded.kind === "frame");
  const field = fieldFrom(decoded.frame, 61);
  assert.equal(field.value, -242);
  assert.equal(recordedFieldDisplay(field).kind, "fault", "A dead temperature must not be clamped into range.");

  const rail = payloadFrom(replies, 48).slice();
  new DataView(rail.buffer, rail.byteOffset, rail.byteLength).setUint16(6, 65535, false);
  const railDecoded = decodeFreezeFrameResponse(rail, 48);
  assert(railDecoded.kind === "frame");
  assert.equal(recordedFieldDisplay(fieldFrom(railDecoded.frame, 3)).kind, "fault");

  for (const date of ["2026-08-08", "2026-09-08"]) {
    const counters = recordedFrame(replies, 52, date);
    assert.equal(fieldFrom(counters, 80).scalingRefusal, "impossible-result");
    assert.equal(fieldFrom(counters, 86).scalingRefusal, "malformed-equation");
    for (const infokey of [80, 86]) {
      const value = fieldFrom(counters, infokey);
      assert.equal(value.value, null);
      assert.equal(recordedFieldDisplay(value).kind, "raw");
    }
  }
}

function recordedFrame(replies: RecordedReply[], component: number, date = "2026-08-08"): FreezeFrame {
  const decoded = decodeFreezeFrameResponse(payloadFrom(replies, component, date), component);
  assert(decoded.kind === "frame");
  return decoded.frame;
}

function payloadFrom(replies: RecordedReply[], component: number, date = "2026-08-08"): Uint8Array {
  const reply = replies.find(candidate => candidate.component === component && candidate.date === date);
  assert(reply, `Missing ${date} recorded reply for ${component}`);
  return reply.payload;
}

function fieldFrom(frame: FreezeFrame, infokey: number): FreezeFrameValue {
  const field = frame.values.find(candidate => candidate.infokey === infokey);
  assert(field, `Missing field ${infokey} in ${frame.component}/${frame.symptom}`);
  return field;
}

checkFreezeFrameFieldAudit();
