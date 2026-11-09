import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFreezeFramesEndpoint, type FreezeFramesResponse } from "../src/http/freeze-frames.ts";
import { writeFreezeFrameRead, type StoredFreezeFrameReading } from "../src/vcu/freeze-frame-store.ts";
import { CAPTURED_FREEZE_FRAMES, capturedFreezeFramePayload } from "./captured-freeze-frames.ts";
import { toHex } from "../src/diagnostics/freeze-frame.ts";
import { buildPayload } from "../src/http/fault-infokeys.ts";
import {
  resolveFaultRecord,
  recordedFields,
  recordedFieldDisplay,
  recordedFieldLabel,
  recordedCycleAge,
} from "../public/lib/fault-records.js";
import { activeFaultRows, storedFaultRows } from "../public/lib/fault-rows.js";
import type { FreezeFrameValue } from "../src/diagnostics/freeze-frame.ts";
import { lookupByComponentSymptom } from "../src/diagnostics/dtc-table.ts";
import type { TroubleCodeSnapshot } from "../src/http/stored-dtcs.ts";

async function checkFaultRecords() {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-fault-records-"));
  const server = createServer((_request, response) => {
    void handleFreezeFramesEndpoint(response, directory);
  });
  try {
    const stored = await writeFreezeFrameRead(directory, {
      readAt: Date.UTC(2026, 0, 1),
      source: "service",
      completion: "complete",
      components: CAPTURED_FREEZE_FRAMES.map(capture => capture.component),
      replies: CAPTURED_FREEZE_FRAMES.map(capture => ({
        component: capture.component,
        payloadHex: toHex(capturedFreezeFramePayload(capture)),
        failure: null,
      })),
      list: {
        declaredCount: 29,
        parsed: 29,
        padding: 0,
        outOfRange: 0,
        duplicate: 0,
        truncated: false,
        trailingHex: "",
      },
    });
    assert.equal(stored.stored, true);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/freeze-frames`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = (await response.json()) as FreezeFramesResponse;
    assert.equal(payload.reading?.records.length, 29);
    const pump = resolveFaultRecord("44/0", payload);
    assert.equal(pump.kind, "recorded");
    assert.ok(pump.frame);
    assert.deepEqual(
      pump.frame.values.map(value => [value.name, value.value, value.unit]),
      [
        ["VEHICLE_SUBSTATE", 22, ""],
        ["ai_WaterPumpCurrent_In", 0, "mA"],
        ["WaterPump_ModuleSts", -4, ""],
        ["D_IGBTA_T", 34.9, "°C"],
        ["D_IGBTB_T", 34.9, "°C"],
        ["D_IGBTC_T", 34.9, "°C"],
        ["V_AIR_TEMP", 28.5, "°C"],
      ]
    );
    assert.equal(recordedCycleAge(pump.frame.cyclesSinceStored), "Stored 255 cycles ago");
    const dictionary = buildPayload();
    const fields = recordedFields(pump.frame, dictionary, "44/0");
    assert.equal(fields.length, 7);
    assert.deepEqual(
      fields.map(field => recordedFieldLabel(field.name)),
      ["Vehicle state", "Pump current", "Pump status", "IGBT A", "IGBT B", "IGBT C", "Outside air"]
    );
    assert.deepEqual(
      fields.map(field => recordedFieldDisplay(field.value).text),
      ["22", "0 mA", "−4", "34.9 °C", "34.9 °C", "34.9 °C", "28.5 °C"]
    );
    assert.equal(resolveFaultRecord("44/1", payload).kind, "different-symptom");
    assert.equal(
      resolveFaultRecord("44/0", payload, true).kind,
      "unavailable",
      "A failed fetch cannot show an earlier cached reading."
    );
    assert.equal(resolveFaultRecord("44/0", { reading: null, howToRead: "" }).kind, "not-read");
    assert.equal(resolveFaultRecord("44/0", null).kind, "not-read");
    const empty: FreezeFramesResponse & { reading: StoredFreezeFrameReading } = {
      ...payload,
      reading: { ...payload.reading!, records: [], components: [] },
    };
    assert.equal(resolveFaultRecord("44/0", empty).kind, "not-listed");
    empty.reading.components = [44];
    assert.equal(resolveFaultRecord("44/0", empty).kind, "unavailable");
    empty.reading.records = [
      { component: 44, failure: null, response: { kind: "unrecognised", reason: "short", rawHex: "57 00" } },
    ];
    assert.equal(resolveFaultRecord("44/0", empty).kind, "no-record");
    empty.reading.records[0].response = { kind: "unrecognised", reason: "garbled", rawHex: "57 01" };
    assert.equal(
      resolveFaultRecord("44/0", empty).kind,
      "unavailable",
      "Garbled bytes cannot claim the bike returned no record."
    );
    empty.reading.records[0].response = { kind: "frame", frame: pump.frame };
    empty.reading.records[0].failure = "timed out";
    assert.equal(resolveFaultRecord("44/0", empty).kind, "unavailable");
    const partial = recordedFields(
      { ...pump.frame, values: pump.frame.values.slice(0, 2), truncated: true },
      dictionary,
      "44/0"
    );
    assert.equal(partial.length, 7, "Missing fields retain all seven named slots.");
    assert.deepEqual(
      partial.slice(2).map(field => recordedFieldDisplay(field.value).kind),
      Array(5).fill("missing")
    );
    assert.equal(recordedFieldDisplay({ ...pump.frame.values[1], value: 65535, raw: 65535 }).kind, "fault");
    assert.equal(recordedFieldDisplay({ ...pump.frame.values[1], value: 65535, raw: 65535 }).text, "fault mA");
    const raw: FreezeFrameValue = {
      ...pump.frame.values[1],
      value: null,
      raw: 123456,
      scalingNote: "refused",
      scalingRefusal: "malformed-equation",
    };
    const display = recordedFieldDisplay(raw);
    assert.equal(display.kind, "raw");
    assert.ok(display.text.endsWith(" raw") && !display.text.includes("mA"));
    assert.equal(recordedFieldLabel("UnlistedSignal"), "UnlistedSignal");
    assert.deepEqual([null, 0, 1, 12].map(recordedCycleAge), [
      "Cycle age unavailable",
      "Stored this cycle",
      "Stored 1 cycle ago",
      "Stored 12 cycles ago",
    ]);
    const active = activeFaultRows([
      { key: "dtc_0044_0", codeKey: "44/0", active: true, lastSeenMs: 0, firings: 1, row: null },
      { key: "dtc_0034_0", codeKey: "34/0", active: false, lastSeenMs: 100, firings: 1, row: null },
    ]);
    assert.equal(active.length, 1);
    assert.equal(active[0].key, "44/0");
    const pumpCode = lookupByComponentSymptom(44, 0);
    const lightingCode = lookupByComponentSymptom(34, 0);
    assert.ok(pumpCode && lightingCode);
    const snapshot: TroubleCodeSnapshot = {
      stored: {
        state: "codes",
        codes: [
          { raw: 0x2c00, ...pumpCode },
          { raw: 0x2200, ...lightingCode },
        ],
        declaredCount: 2,
        truncated: false,
      },
      pending: { state: "not-read" },
      permanent: { state: "not-read" },
      freezeFrame: null,
      readAt: null,
      ageMs: null,
    };
    assert.deepEqual(
      storedFaultRows(snapshot, active).map(row => row.code),
      ["B1000"],
      "An active/stored code has one home."
    );
    assert.deepEqual(storedFaultRows(null, active), []);
    const left = lookupByComponentSymptom(39, 3);
    const right = lookupByComponentSymptom(40, 3);
    assert.ok(left && right);
    snapshot.stored = {
      state: "codes",
      declaredCount: 2,
      truncated: false,
      codes: [
        { raw: 0x2703, ...left },
        { raw: 0x2803, ...right },
      ],
    };
    assert.equal(
      storedFaultRows(snapshot, active).length,
      2,
      "Equal OBD strings under different components remain separate codes."
    );
    empty.reading.records[0] = {
      component: 44,
      failure: null,
      response: { kind: "frame", frame: { ...pump.frame, shortlistKnown: false } },
    };
    assert.equal(resolveFaultRecord("44/0", empty).kind, "unavailable");
    console.log(
      "✓ captured bytes → durable store → real HTTP endpoint → seven pump values/units/cycle age; exact identity, all fields, quality states and one home"
    );
  } finally {
    server.close();
    server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  }
}

await checkFaultRecords();
