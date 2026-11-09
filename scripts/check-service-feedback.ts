import assert from "node:assert/strict";
import { createServiceClientFixture } from "./service-client-fixture.ts";
import { openService, serviceCatalogue } from "../public/lib/service-client.js";
import { parameterOutcome, selectServiceParameter } from "../public/lib/service-edits.js";
import { backupStatus, importServiceBackup } from "../public/lib/service-backup.js";
import { parameterReadFailureText, parameterWriteBlockText } from "../public/lib/service-feedback.js";

const { fixture, close } = await createServiceClientFixture();
try {
  await openService(() => true);
  assert.equal(parameterWriteBlockText(true, fixture.status), "");
  assert.equal(parameterWriteBlockText(false, null), "Bike unavailable");
  assert.equal(parameterWriteBlockText(false, { ...fixture.status, enabled: false }), "Writes disabled");
  assert.equal(
    parameterWriteBlockText(false, { ...fixture.status, gate: { ...fixture.status.gate, safe: false } }),
    "Park to confirm"
  );
  assert.equal(parameterWriteBlockText(false, { ...fixture.status, busHeldBy: "synthetic read" }), "Bike busy");
  for (const noReadWillHelp of [false, true]) {
    assert.equal(
      parameterWriteBlockText(false, {
        ...fixture.status,
        tableGate: { ...fixture.status.tableGate, writesAllowed: false, noReadWillHelp },
      }),
      noReadWillHelp ? "Table unsupported" : "Table unconfirmed"
    );
  }
  assert.equal(parameterWriteBlockText(false, fixture.status), "Write unavailable");
  const parameter = serviceCatalogue.rawVal?.parameters.find(parameter => parameter.writable);
  assert.ok(parameter);
  fixture.probeMode = "refused";
  await selectServiceParameter(parameter);
  assert.equal(parameterReadFailureText(parameterOutcome.rawVal), "Read failed: bike unavailable");
  const csv = `id_hex,name,value\n0x${parameter.index.toString(16)},${parameter.name},${parameter.minimum}\n`;
  await importServiceBackup(new File([csv], "synthetic.csv"));
  assert.equal(backupStatus.rawVal, "Import failed: bike unavailable");
} finally {
  await close();
}
console.log("✓ parameter reads, backup imports and blocked parameter confirmations retain short visible reasons");
