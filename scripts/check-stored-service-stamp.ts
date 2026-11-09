import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVcuWriteRunner } from "../src/vcu/write-runner.ts";
import { storedServiceStamp } from "../src/vcu/stored-service-stamp.ts";
import type { AuditRecord } from "../src/vcu/write-audit.ts";

const directory = await mkdtemp(join(tmpdir(), "cool-eva-stored-stamp-"));
const dateIso = "2025-05-12T00:00:00.000Z";
const reading: AuditRecord = {
  at: Date.UTC(2026, 10, 8),
  clockTrustworthy: true,
  action: "read-service-stamp",
  status: "read",
  before: dateIso,
  note: "read cleanly",
};
const records: AuditRecord[] = [
  reading,
  ...Array.from(
    { length: 20 },
    (_, index): AuditRecord => ({ at: index, clockTrustworthy: false, action: "parameter-write", status: "refused" })
  ),
  { ...reading, at: 1, status: "failed", before: null, note: "No reply" },
];
let channelReads = 0;
const runner = createVcuWriteRunner({
  channel: () => {
    channelReads++;
    return null;
  },
  busIsActive: false,
  enabled: true,
  directory,
  gate: () => ({ safe: false, blockers: ["Not parked"], checks: [], chargingEvidence: null }),
  latestSweep: async () => null,
  holdPoller: async () => null,
});
try {
  await writeFile(
    join(directory, "service-writes.jsonl"),
    records.map(record => JSON.stringify(record)).join("\n") + "\n"
  );
  const status = await runner.status({ detailFor: null, includeList: false });
  assert.equal(
    status.lastServiceStamp?.dateIso,
    dateIso,
    "A stored reading older than the excerpt survives a newer failed read and a clock step."
  );
  assert.equal(status.recent.length, 12);
  assert.equal(
    status.recent.some(record => record.status === "read"),
    false
  );
  assert.equal(channelReads, 0, "Stored status never opens the bike connection.");
  assert.equal(storedServiceStamp([], Date.now()), null);
  assert.ok(
    storedServiceStamp([{ ...reading, before: "2000-01-01T00:00:00.000Z", note: "reads zero" }], Date.now())
      ?.implausible
  );
  assert.ok(storedServiceStamp([{ ...reading, before: "not a date" }], Date.now())?.implausible);
  assert.equal(
    storedServiceStamp(
      [{ ...reading, action: "set-service-point", status: "started", after: null }, reading],
      Date.now()
    )?.confirmed,
    false,
    "An unconfirmed overwrite cannot revive the old date."
  );
} finally {
  runner.stop();
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "✓ stored service dates survive excerpt limits and failed reads; invalid and unconfirmed dates stay honest, without bus traffic"
);
