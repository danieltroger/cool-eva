import assert from "node:assert/strict";
import { decodeFrame } from "../src/can/decode.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, onChange, recordArrival, snapshot, type LiveValue } from "../src/can/signals.ts";
import { DISPLAY_FRESHNESS } from "../public/lib/generated-bounds.js";
import { readingCanColour, readingIsStale, readingStatus, STALE_MS } from "../public/lib/reading-status.js";
import { apply, connection, peek, signalState } from "../public/lib/store.js";
import { cellSnapshot } from "../public/lib/cell-snapshot.js";
import * as colors from "../public/lib/colors.js";

const heldSignals = SIGNALS.filter(signal => signal.displayFreshness !== undefined);
assert.deepEqual(
  Object.entries(DISPLAY_FRESHNESS).sort(),
  heldSignals.map(signal => [signal.key, signal.displayFreshness]).sort()
);
assert.deepEqual(
  ["lmu-cells-1-to-3", "lmu-cells-4-to-8", "module-temperature"].map(
    freshness => heldSignals.filter(signal => signal.displayFreshness === freshness).length
  ),
  [33, 48, 31]
);
assert.equal(STALE_MS, 8000);
defineSignals(SIGNALS);
connection.val = "live";
const changedKeys: string[] = [];
const unsubscribe = onChange(changes => changedKeys.push(...Object.keys(changes)));
const initialTime = 1_000_000;
recordMultiplex(initialTime);
await Promise.resolve();
assert.equal(heldSignals.length, 112);
for (const signal of heldSignals) {
  assert.ok(snapshot()[signal.key], `The real decoder emits ${signal.key}.`);
}
apply({ type: "snapshot", ts: initialTime, signals: snapshot() });
assertHeldStatus("fresh");
changedKeys.length = 0;
recordMultiplex(initialTime + 5000);
await Promise.resolve();
assert.deepEqual(changedKeys, [], "Unchanged values and selector changes inside deadband produce no value patches.");
apply({ type: "snapshot", ts: initialTime + 5000, signals: snapshot() });
assert.equal(signalState("lmu1_cell4_mv").rawVal?.ts, initialTime + 5000);
assertHeldStatus("fresh");
unsubscribe();

// These literals are independent of the production budgets, so shortening/removing a hold fails.
for (const [key, budget] of [
  ["lmu1_cell1_mv", 15_000],
  ["lmu1_cell4_mv", 715_000],
  ["lmu1_pcb1_c", 1_570_000],
] as const) {
  for (const offset of [-1, 0, 1]) {
    const timestamp = initialTime + budget + offset;
    apply({
      type: "snapshot",
      ts: timestamp,
      signals: { [key]: reading(key, initialTime), lmu_cell_mux: reading("lmu_cell_mux", timestamp) },
    });
    for (const sampled of [false, true]) {
      assert.equal(readingStatus(key, sampled), offset > 0 ? "stale" : "fresh", `${key} at ${budget + offset} ms`);
    }
  }
  const expired = initialTime + budget + 1;
  const repeated = { [key]: reading(key, initialTime), lmu_cell_mux: reading("lmu_cell_mux", expired) };
  apply({ type: "snapshot", ts: expired, signals: repeated });
  assert.equal(readingStatus(key), "stale", "A heartbeat repeating reading.ts cannot renew a hold.");
  apply({ type: "snapshot", ts: expired + 5000, signals: { ...repeated, [key]: reading(key, expired) } });
  assert.equal(readingStatus(key), "fresh", "A real same-value arrival with newer reading.ts renews its hold.");
}

const ordinaryKeys = ["lmu_cell_mux", "lmu_comm_warnings", "lmu_temp_high_idx", "lmu_temp_low_idx", "lmu_future"];
for (const key of ordinaryKeys) {
  assert.equal(DISPLAY_FRESHNESS[key], undefined, `${key} must not inherit a name-based hold.`);
  signalState(key).val = reading(key, initialTime);
  for (const elapsed of [8000, 8001]) {
    const timestamp = initialTime + elapsed;
    apply({
      type: "patch",
      ts: timestamp,
      signals: key === "lmu_cell_mux" ? {} : { lmu_cell_mux: reading("lmu_cell_mux", timestamp) },
    });
    for (const sampled of [false, true]) {
      assert.equal(readingIsStale(key, sampled), elapsed > 8000, `${key} retains the ordinary eight-second rule.`);
    }
  }
}

// Other traffic and WebSocket heartbeats remain live while every 0x66x frame stops.
const allReadings = Object.fromEntries(heldSignals.map(signal => [signal.key, reading(signal.key, initialTime)]));
apply({
  type: "snapshot",
  ts: initialTime + 8000,
  signals: { ...allReadings, lmu_cell_mux: reading("lmu_cell_mux", initialTime) },
});
assertHeldStatus("fresh");
apply({
  type: "snapshot",
  ts: initialTime + 8001,
  signals: { ...allReadings, pack_v: { value: 330, unit: "V", group: "battery", ts: initialTime + 8001 } },
});
assertHeldStatus("stale");
assert.equal(readingStatus("pack_v"), "fresh");
apply({
  type: "patch",
  ts: initialTime + 9000,
  signals: { lmu_cell_mux: reading("lmu_cell_mux", initialTime + 9000) },
});
assertHeldStatus("fresh");
connection.val = "offline";
assertHeldStatus("stale");
connection.val = "live";
signalState("lmu_cell_mux").val = null;
assertHeldStatus("stale");

// A surviving carrier does not hide a missing slow frame beyond that class's bound.
apply({
  type: "snapshot",
  ts: initialTime + 715_001,
  signals: { ...allReadings, lmu_cell_mux: reading("lmu_cell_mux", initialTime + 715_001) },
});
assert.equal(readingStatus("lmu1_cell4_mv"), "stale");
assert.equal(readingStatus("lmu1_pcb1_c"), "fresh");

const colourTime = 4_000_000;
apply({
  type: "snapshot",
  ts: colourTime,
  signals: {
    lmu_cell_mux: reading("lmu_cell_mux", colourTime),
    lmu1_cell4_mv: { ...reading("lmu1_cell4_mv", colourTime - 8001), value: 3000 },
    lmu1_pcb1_c: { ...reading("lmu1_pcb1_c", colourTime - 8001), value: 60 },
    cell_min_mv: { value: 3280, unit: "mV", group: "cells", ts: colourTime },
    cell_max_mv: { value: 3320, unit: "mV", group: "cells", ts: colourTime },
    cell_spread_mv: { value: 40, unit: "mV", group: "cells", ts: colourTime },
    cell_lowest_v_idx: { value: 7, unit: "", group: "cells", ts: colourTime },
    cell_highest_v_idx: { value: 19, unit: "", group: "cells", ts: colourTime },
  },
});
for (const key of ["lmu1_cell4_mv", "lmu1_pcb1_c"]) {
  for (const sampled of [false, true]) {
    assert.equal(readingStatus(key, sampled), "fresh", "Old held readings stay visible.");
    assert.equal(readingCanColour(key, sampled), false, "Old held readings must not carry current colour.");
  }
}
const pack = cellSnapshot(peek, key => readingStatus(key, true));
assert.deepEqual([pack.low, pack.high, pack.spread, pack.weakest, pack.strongest], [3280, 3320, 40, 7, 19]);
assert.equal(pack.cells.find(cell => cell.key === "lmu1_cell4_mv")?.value, 3000);
assert.equal(pack.displayLow, 3000, "Held extrema may fit bar geometry but cannot become pack summaries.");
for (const age of [8000, 8001]) {
  apply({
    type: "patch",
    ts: colourTime,
    signals: { lmu1_cell4_mv: { ...reading("lmu1_cell4_mv", colourTime - age), value: 3405 } },
  });
  assert.equal(readingCanColour("lmu1_cell4_mv", true), age <= 8000);
}
assert.equal(colors.spread(Math.max(0, 3320 - 3405)), colors.GOOD, "Above the current BMS maximum means no gap.");
apply({ type: "patch", ts: colourTime + 8001, signals: { lmu_cell_mux: reading("lmu_cell_mux", colourTime + 8001) } });
assert.equal(cellSnapshot(peek, key => readingStatus(key, true)).high, null, "No held-cell fallback for stale 0x203.");
signalState("lmu1_cell4_mv").val = null;
assert.equal(readingStatus("lmu1_cell4_mv"), "missing");
apply({
  type: "patch",
  ts: colourTime + 8002,
  signals: { lmu1_cell4_mv: { value: 65535, unit: "mV", group: "cells", ts: colourTime + 8002 } },
});
assert.equal(readingStatus("lmu1_cell4_mv"), "fault", "Holding cannot bypass physical bounds.");
console.log(
  "✓ 112 registry classes, decoded heartbeat arrivals, bounded holds, live carrier/recovery, 0x203 summaries and current-only colours"
);

function reading(key: string, timestamp: number): LiveValue {
  const definition = SIGNALS.find(signal => signal.key === key);
  return {
    value: definition?.unit === "°C" ? 30 : key === "lmu_cell_mux" ? 1 : 3300,
    unit: definition?.unit ?? "",
    group: definition?.group ?? "misc",
    ts: timestamp,
  };
}

function assertHeldStatus(expected: "fresh" | "stale") {
  for (const signal of heldSignals) {
    for (const sampled of [false, true]) {
      assert.equal(readingStatus(signal.key, sampled), expected, `${signal.key} (sampled=${sampled})`);
    }
  }
}

function recordMultiplex(timestamp: number) {
  for (let moduleNumber = 1; moduleNumber <= 11; moduleNumber++) {
    for (const frameId of [0x662, 0x663, 0x664]) {
      const payload = Buffer.from([moduleNumber, 0x0c, 0xe4, 0x0c, 0xe4, 0x0c, 0xe4, 0]);
      if (frameId === 0x664) {
        payload.set([30, 31, 32], 5);
      }
      for (const decoded of decodeFrame(frameId, payload)) {
        recordArrival(decoded.key, decoded.value, timestamp, timestamp);
      }
    }
  }
}
