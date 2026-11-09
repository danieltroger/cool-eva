import assert from "node:assert/strict";
import { createServiceClientFixture } from "./service-client-fixture.ts";
import { openService, serviceCatalogue } from "../public/lib/service-client.js";
import { parameterOutcome, selectServiceParameter } from "../public/lib/service-edits.js";
import { backupStatus, importServiceBackup } from "../public/lib/service-backup.js";
import { parameterReadFailureText } from "../public/lib/service-feedback.js";

const { fixture, close } = await createServiceClientFixture();
try {
  await openService(() => true);
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
console.log("✓ failed parameter reads and backup imports retain a short visible reason");
