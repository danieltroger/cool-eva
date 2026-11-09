import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { handleServiceCatalogue, serviceCatalogue, type ServiceCatalogue } from "../src/http/service-catalogue.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { cellVoltageKey } from "../src/can/decode-bms.ts";
import { snapshot } from "../src/can/signals.ts";
import { busHeldBy } from "../src/vcu/bus-lease.ts";
import { activeParameterTable, parameterTable, selectParameterTable } from "../src/vcu/param-table.ts";
import { planWrite, writeTargetNamed } from "../src/vcu/write-targets.ts";

async function checkServiceCatalogue() {
  const originalTable = activeParameterTable().tableType;
  const originalReadings = snapshot();
  const originalLease = busHeldBy();
  const server = createServer(handleServiceCatalogue);
  try {
    const catalogue = serviceCatalogue();
    assert.equal(catalogue.tableType, originalTable);
    assert.equal(catalogue.parameters.length, 277);
    assert.deepEqual(
      catalogue.signals,
      SIGNALS.map(({ key, group, unit }) => ({ key, group, unit }))
    );
    assert.ok(catalogue.signals.some(signal => signal.key === "pack_kw" && signal.unit === "kW"));
    assert.ok(catalogue.signals.some(signal => signal.key === cellVoltageKey(11, 1)));
    assert.deepEqual(snapshot(), originalReadings, "Browsing supplies no invented or sampled readings.");
    assert.equal(busHeldBy(), originalLease, "Browsing cannot acquire the bus.");
    for (const parameter of parameterTable()) {
      const row = catalogue.parameters.find(candidate => candidate.index === parameter.index);
      assert.ok(row);
      assert.equal(row.name, parameter.name);
      assert.equal(row.micro, parameter.micro);
      assert.equal(row.group, parameter.section ?? "Other parameters");
      assert.equal(row.stock, null, "Another bike's values are never stock defaults.");
      if (row.writable) {
        const target = writeTargetNamed(row.name);
        assert.ok(target?.control.kind === "number");
        assert.equal(row.minimum, target.control.min);
        assert.equal(row.maximum, target.control.max);
        assert.ok(planWrite(row.name, row.minimum, 0).ok);
        assert.ok(planWrite(row.name, row.maximum, 0).ok);
        assert.equal(planWrite(row.name, row.minimum - 1, 0).ok, false);
        assert.equal(planWrite(row.name, row.maximum + 1, 0).ok, false);
      }
    }
    const readOnly = catalogue.parameters.filter(parameter => !parameter.writable);
    assert.deepEqual(
      readOnly.map(parameter => parameter.index),
      [11, 12, 13, 14, 16, 22, 23, 24, 25]
    );
    assert.equal(catalogue.parameters.find(parameter => parameter.name === "MAX_DC_CHG_CURRENT")?.maximum, 80);
    const torque = catalogue.parameters.find(parameter => parameter.name === "TORQUE_LIMIT");
    assert.ok(torque);
    assert.equal(torque.unit, "Nm");
    assert.equal(torque.scale, 0.1);
    assert.equal(torque.maximum * torque.scale, 276);
    const power = catalogue.parameters.find(parameter => parameter.name === "MAP3_PWR");
    assert.ok(power);
    assert.equal(power.unit, "raw", "A sketch sample cannot establish an engineering unit.");
    assert.equal(power.scale, 1);
    const beam = catalogue.parameters.find(parameter => parameter.name === "BEAM_MAX_CURR_TH");
    assert.ok(beam);
    assert.equal(beam.unit, "mA");
    assert.equal(beam.scale, 1);
    assert.equal(catalogue.parameters.find(parameter => parameter.name === "MAX_DC_CHG_CURRENT")?.unit, "A");
    catalogue.signals[0].key = "mutated-copy";
    catalogue.parameters[0].name = "mutated-copy";
    assert.notEqual(serviceCatalogue().signals[0].key, "mutated-copy");
    assert.notEqual(serviceCatalogue().parameters[0].name, "mutated-copy");

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/service-catalogue`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(body));
    const payload = JSON.parse(body) as ServiceCatalogue;
    assert.equal(payload.parameters.length, 277);
    assert.equal(payload.signals.length, SIGNALS.length);
    const refused = await fetch(url, { method: "POST" });
    assert.equal(refused.status, 405);
    assert.equal(refused.headers.get("allow"), "GET");
    await refused.text();

    assert.ok(selectParameterTable(4102).ok);
    const changed = serviceCatalogue();
    assert.equal(changed.tableType, 4102);
    assert.notEqual(changed.parameters[0].name, "VSM_DUMMY_WORD1");
    assert.deepEqual(
      changed.parameters.map(parameter => parameter.name),
      parameterTable().map(parameter => parameter.name)
    );
    const changedResponse = (await (await fetch(url)).json()) as ServiceCatalogue;
    assert.equal(changedResponse.tableType, 4102, "GET follows a table selected while the page is open.");
    assert.equal(changedResponse.parameters[0].name, changed.parameters[0].name);
    assert.deepEqual(snapshot(), originalReadings);
    assert.equal(busHeldBy(), originalLease);
    console.log(
      "✓ complete Service parameter/signal catalogue before any readings; policy bounds, honest units/stock, duplicate identities, table changes and read-only HTTP"
    );
  } finally {
    selectParameterTable(originalTable);
    server.close();
    server.closeAllConnections();
  }
}

await checkServiceCatalogue();
