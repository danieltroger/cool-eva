import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  changeServiceAction,
  actionOutcome,
  serviceActionAvailable,
  SERVICE_ACTIONS,
} from "../public/lib/service-actions.js";
import { changeServiceLights, lightsOff, lightsOutcome, refreshLightsState } from "../public/lib/service-lights.js";
import { createServiceClientFixture, type ServiceClientFixture } from "./service-client-fixture.ts";
import { arm, armed } from "../public/lib/arming.js";
import {
  currentParameterReading,
  openService,
  refreshServiceStatus,
  serviceBusy,
  serviceCatalogue,
  serviceCanWrite,
  serviceChanges,
  serviceStatus,
} from "../public/lib/service-client.js";
import {
  changeNewParameterValue,
  confirmParameterChange,
  resetServiceEditor,
  selectedParameter,
  selectServiceParameter,
  serviceEditor,
} from "../public/lib/service-edits.js";
import {
  applyBackupDifference,
  backupDifferences,
  backupStatus,
  importServiceBackup,
  resetServiceBackup,
} from "../public/lib/service-backup.js";
import {
  parameterBackupCsv,
  parameterInput,
  parameterValue,
  parseParameterBackup,
} from "../public/lib/parameter-backup.js";

async function checkServiceParameters() {
  const { fixture, close } = await createServiceClientFixture();
  let visible = true;
  try {
    await openService(() => visible);
    await delay(0);
    const catalogue = serviceCatalogue.rawVal;
    assert.ok(catalogue);
    const power = catalogue.parameters.find(parameter => parameter.name === "MAP3_PWR");
    const torque = catalogue.parameters.find(parameter => parameter.name === "TORQUE_LIMIT");
    assert.ok(power && torque);
    assert.equal(
      fixture.requests.filter(request => request.url.pathname === "/vcu-read" && request.method === "POST").length,
      0
    );
    assert.ok(
      fixture.requests
        .filter(request => request.url.pathname === "/vcu-write")
        .every(request => request.url.searchParams.get("list") === "0")
    );
    assert.equal(parameterInput(power, ""), null);
    assert.equal(parameterInput(power, "0.5"), null);
    assert.equal(parameterInput(power, "70000"), null);
    assert.equal(parameterInput(torque, "230.1"), 2301);
    assert.equal(parameterInput(torque, "230.11"), null);
    assert.equal(parameterValue(torque, 2301), "230.1 Nm");
    assert.equal(parameterValue(power, 480), "480 raw");
    const csv = `id_hex,name,value\r\n0x39,MAP3_PWR,500\r\n0x30,TORQUE_LIMIT,2400\r\n0x102,MAX_DC_CHG_CURRENT,75\r\n`;
    assert.equal(parseParameterBackup(csv, catalogue.parameters).length, 3);
    assert.throws(() => parseParameterBackup(csv + "0x39,MAP3_PWR,1\r\n", catalogue.parameters), /Cannot match/);
    assert.throws(
      () => parseParameterBackup("id_hex,name,value\n0x39,OTHER,500", catalogue.parameters),
      /Cannot match/
    );
    assert.throws(
      () => parseParameterBackup("id_hex,name,value\n0x102,MAX_DC_CHG_CURRENT,81", catalogue.parameters),
      /allowed range/
    );
    assert.throws(
      () => parseParameterBackup("id_hex,name,value\n0x39,MAP3_PWR,1.5", catalogue.parameters),
      /invalid row/
    );
    assert.equal(
      parameterBackupCsv([power, torque], parameter => (parameter === power ? 480 : null)),
      "id_hex,name,value\r\n0x39,MAP3_PWR,480\r\n"
    );

    await selectServiceParameter(power);
    assert.equal(currentParameterReading(power, true)?.value, 480);
    changeNewParameterValue("500");
    const stillSelected = () => selectedParameter.rawVal === power;
    const first = confirmParameterChange(power, 500, "parameter:57", stillSelected);
    assert.equal(serviceBusy.rawVal, true, "The lock is taken before the first await.");
    assert.equal(await confirmParameterChange(power, 500, "parameter:57", stillSelected), null);
    assert.equal((await first)?.kind, "armed");
    assert.equal(
      await confirmParameterChange(power, 500, "parameter:57", stillSelected),
      null,
      "A second tap inside the dwell is ignored."
    );
    assert.equal(writes(fixture.requests).length, 0);
    arm("parameter:57", performance.now() - 500);
    assert.equal((await confirmParameterChange(power, 500, "parameter:57", stillSelected))?.kind, "confirmed");
    assert.equal(writes(fixture.requests).length, 1);
    assert.equal(currentParameterReading(power, true)?.value, 500);
    assert.equal(serviceChanges.rawVal[0].value, 500);
    assert.equal((await confirmParameterChange(power, 500, "parameter:57", stillSelected))?.kind, "unchanged");
    assert.equal(writes(fixture.requests).length, 1, "An equal live value never produces a write.");

    for (const mode of ["refused", "transport", "mismatch", "missing"] as const) {
      fixture.postMode = mode;
      await selectServiceParameter(power);
      const wanted: number = (currentParameterReading(power, true)?.value ?? 0) + 10;
      assert.equal((await confirmParameterChange(power, wanted, "parameter:57", stillSelected))?.kind, "armed");
      arm("parameter:57", performance.now() - 500);
      assert.equal((await confirmParameterChange(power, wanted, "parameter:57", stillSelected))?.kind, "unconfirmed");
      assert.equal(
        currentParameterReading(power, true)?.value,
        mode === "mismatch" ? wanted + 1 : undefined,
        "A lost/unverified response cannot fall back to an older snapshot."
      );
    }
    fixture.postMode = "success";
    fixture.probeMode = "wrong-identity";
    await selectServiceParameter(torque);
    assert.equal(currentParameterReading(torque, true), null, "A foreign parameter's value cannot label this row.");
    fixture.probeMode = "fractional";
    await selectServiceParameter(torque);
    assert.equal(currentParameterReading(torque, true), null, "A fractional protocol count is rejected.");
    fixture.probeMode = "success";
    await selectServiceParameter(power);
    const before = writes(fixture.requests).length;
    resetServiceBackup();
    await importServiceBackup(new File([csv], "synthetic.csv"));
    assert.equal(backupDifferences.rawVal.length, 2);
    assert.deepEqual(
      backupDifferences.rawVal.map(row => row.parameter.name),
      ["MAP3_PWR", "TORQUE_LIMIT"]
    );
    assert.equal(writes(fixture.requests).length, before, "Import only reads and compares.");
    for (const difference of backupDifferences.rawVal) {
      await applyBackupDifference(difference);
      assert.equal(writes(fixture.requests).length, before + backupDifferences.rawVal.indexOf(difference));
      arm(`backup:${difference.version}:${difference.parameter.index}`, performance.now() - 500);
      await applyBackupDifference(difference);
      assert.equal(difference.outcome.rawVal?.kind, "confirmed");
    }
    assert.equal(writes(fixture.requests).length, before + 2);
    assert.ok(writes(fixture.requests).every(request => request.url.searchParams.get("action") === "parameter"));
    assert.equal(backupStatus.rawVal, "Differences applied. Restart bike to apply.");
    await importServiceBackup(new File([csv], "synthetic.csv"));
    assert.equal(backupDifferences.rawVal.length, 0);
    assert.equal(backupStatus.rawVal, "Backup matches. Nothing to apply.");

    arm("some-control");
    const pending = refreshServiceStatus();
    await pending;
    assert.equal(armed.rawVal, "");
    fixture.statusFailure = true;
    assert.equal(await refreshServiceStatus(), false);
    assert.equal(serviceStatus.rawVal, null, "A failed current status fails closed.");
    assert.equal(armed.rawVal, "");
    fixture.statusFailure = false;
    await refreshServiceStatus();

    const oldStatus = fixture.status;
    const held = Promise.withResolvers<void>();
    fixture.statusDelay = held.promise;
    const staleStatus = refreshServiceStatus();
    await delay(0);
    fixture.statusDelay = null;
    fixture.status = { ...oldStatus, enabled: false };
    assert.equal(await refreshServiceStatus(), true);
    held.resolve();
    assert.equal(await staleStatus, false);
    assert.equal(serviceCanWrite(true), false, "A delayed status cannot replace a newer answer.");
    fixture.status = oldStatus;
    await refreshServiceStatus();

    const paused = Promise.withResolvers<void>();
    fixture.probeDelay = paused.promise;
    const selecting = selectServiceParameter(power);
    await delay(0);
    resetServiceEditor();
    paused.resolve();
    await selecting;
    fixture.probeDelay = null;
    assert.equal(selectedParameter.rawVal, null);
    assert.equal(serviceEditor.rawVal, "");

    await checkActions(fixture);

    fixture.catalogue = { ...fixture.catalogue, tableType: 4102 };
    fixture.status.tableGate = { ...fixture.status.tableGate, tableType: 4102 };
    await refreshServiceStatus();
    await delay(0);
    assert.equal(serviceCatalogue.rawVal?.tableType, 4102);
    assert.equal(selectedParameter.rawVal, null, "A table change invalidates an edit and its confirmation.");
    assert.equal(armed.rawVal, "");
    assert.equal(serviceCanWrite(true), true);
    const metadataHeld = Promise.withResolvers<void>();
    fixture.catalogue = { ...fixture.catalogue, tableType: 4202 };
    fixture.status.tableGate = { ...fixture.status.tableGate, tableType: 4201 };
    fixture.catalogueDelay = metadataHeld.promise;
    const olderAlignment = refreshServiceStatus();
    await delay(0);
    fixture.catalogueDelay = null;
    fixture.status.tableGate = { ...fixture.status.tableGate, tableType: 4202 };
    const newerAlignment = refreshServiceStatus();
    await delay(0);
    metadataHeld.resolve();
    await Promise.all([olderAlignment, newerAlignment]);
    assert.equal(
      serviceCatalogue.rawVal?.tableType,
      4202,
      "A superseded metadata retry cannot erase the newer active catalogue."
    );
    assert.equal(serviceCanWrite(true), true);

    fixture.status.tableGate = { ...fixture.status.tableGate, tableType: 9999 };
    const catalogueRequests = fixture.requests.filter(request => request.url.pathname === "/service-catalogue").length;
    await refreshServiceStatus();
    assert.equal(
      fixture.requests.filter(request => request.url.pathname === "/service-catalogue").length - catalogueRequests,
      2,
      "Metadata realignment is bounded, even if the server keeps returning another table."
    );
    assert.equal(serviceCatalogue.rawVal, null);
    assert.equal(serviceCanWrite(true), false);
    fixture.readEnabled = true;
    assert.ok(fixture.confirmedTableGate.tableType !== null);
    fixture.catalogue = { ...fixture.catalogue, tableType: fixture.confirmedTableGate.tableType };
    fixture.status.tableGate = {
      ...fixture.confirmedTableGate,
      writesAllowed: false,
      noReadWillHelp: false,
      reason: "Read the active table",
    };
    await openService(() => visible);
    assert.equal(
      fixture.requests.filter(request => request.url.pathname === "/vcu-read" && request.method === "POST").length,
      1,
      "An unknown table starts the existing safe read on opening."
    );
    assert.equal(serviceCanWrite(true), true, "An immediately finished initial read still refreshes table permission.");
    resetServiceEditor();
    assert.equal(serviceEditor.rawVal, "");
    console.log(
      "✓ Service editor/CSV protocol: exact identities, raw/engineering values, lock and dwell, CAS/readback, unknown delivery, no stale fallback, only differing backup rows and one confirmed write each"
    );
  } finally {
    visible = false;
    await close();
  }
}

async function checkActions(fixture: ServiceClientFixture) {
  for (const entry of SERVICE_ACTIONS) {
    const before = writes(fixture.requests).length;
    await changeServiceAction(entry.action);
    assert.equal(writes(fixture.requests).length, before);
    assert.equal(armed.rawVal, `service:${entry.action}`);
    await changeServiceAction(entry.action);
    assert.equal(writes(fixture.requests).length, before);
    arm(`service:${entry.action}`, performance.now() - 500);
    await changeServiceAction(entry.action);
    assert.equal(writes(fixture.requests).length, before + 1);
    assert.equal(actionOutcome(entry.action).rawVal?.completed, true);
    const query = writes(fixture.requests).at(-1)?.url.searchParams;
    assert.equal(query?.get("confirm"), entry.action === "sync-clock" ? "2026-01-01T12:00Z" : entry.action);
  }
  fixture.clearVerdict = "unproven";
  await changeServiceAction("clear-dtcs");
  arm("service:clear-dtcs", performance.now() - 500);
  await changeServiceAction("clear-dtcs");
  assert.equal(
    actionOutcome("clear-dtcs").rawVal?.completed,
    false,
    "An accepted clear with no erasure evidence cannot claim faults cleared."
  );
  fixture.clearVerdict = "erased";
  const originalClock = fixture.status.clock;
  fixture.status.clock = { trustworthy: false, iso: originalClock.iso, reasons: ["Synthetic GPS unavailable"] };
  await refreshServiceStatus();
  assert.equal(serviceActionAvailable("sync-clock", true), false);
  await changeServiceAction("sync-clock");
  assert.equal(armed.rawVal, "");
  fixture.status.clock = originalClock;
  await refreshServiceStatus();

  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return stored.size;
    },
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => {
      stored.set(key, value);
    },
    removeItem: key => {
      stored.delete(key);
    },
    clear: () => stored.clear(),
    key: index => [...stored.keys()][index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  fixture.allowBatch = true;
  try {
    refreshLightsState();
    assert.equal(lightsOff.rawVal, false);
    await changeServiceLights();
    assert.equal(armed.rawVal, "service:lights-off");
    const before = writes(fixture.requests).length;
    await changeServiceLights();
    assert.equal(writes(fixture.requests).length, before);
    arm("service:lights-off", performance.now() - 500);
    await changeServiceLights();
    assert.equal(lightsOff.rawVal, true);
    assert.equal(lightsOutcome.rawVal?.confirmed, true);
    assert.equal(writes(fixture.requests).at(-1)?.url.searchParams.getAll("w").length, 5);
    assert.equal(stored.size, 1, "Healthy own-bike light values are retained for restore.");
    await changeServiceLights();
    arm("service:lights-restore", performance.now() - 500);
    await changeServiceLights();
    assert.equal(lightsOff.rawVal, false);
    fixture.postMode = "missing";
    await changeServiceLights();
    arm("service:lights-off", performance.now() - 500);
    await changeServiceLights();
    assert.equal(lightsOutcome.rawVal?.confirmed, false, "Missing individual readbacks cannot confirm all lights.");
    assert.equal(lightsOff.rawVal, false);
    fixture.postMode = "success";
  } finally {
    fixture.allowBatch = false;
    if (previousStorage) {
      Object.defineProperty(globalThis, "localStorage", previousStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
}

function writes(requests: { method: string; url: URL }[]) {
  return requests.filter(request => request.method === "POST" && request.url.pathname === "/vcu-write");
}

await checkServiceParameters();
