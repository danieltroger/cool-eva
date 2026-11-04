import assert from "assert/strict";
import { createServer } from "http";
import { once } from "events";
import { join } from "path";
import { handleNetworksEndpoint } from "../src/http/networks.ts";
import { freshSettings } from "../src/settings/schema.ts";
import { openNetworkLedger } from "../src/wifi/network-ledger.ts";
import { WifiNetworks } from "../src/wifi/networks.ts";
import type { NetworkView } from "../src/wifi/network-types.ts";
import { settingsFixture, closeSettingsFixture } from "./settings-check-fixtures.ts";
import { FakeNetworkManager } from "./fake-network-manager.ts";

await checkNetworkHttp();

async function checkNetworkHttp(): Promise<void> {
  const fixture = await settingsFixture();
  await fixture.store.initialise(freshSettings(fixture.paths));
  const current = fixture.store.read();
  assert.equal(current.kind, "ready");
  if (current.kind !== "ready") {
    throw new Error("Fixture not ready");
  }
  const ledger = await openNetworkLedger(
    join(fixture.paths.privateDirectory, "network-trials.json"),
    String(current.raw.instanceId),
    fixture.lock
  );
  const backend = new FakeNetworkManager();
  const controller = new WifiNetworks({
    ledger,
    backend,
    settings: fixture.store,
    generation: "synthetic-generation",
    motionBlockers: () => [],
    bluetoothReady: () => true,
    hotspotChanged: () => {},
    autoTick: false,
  });
  await controller.start();
  const server = createServer(
    (req, res) =>
      void handleNetworksEndpoint(req, res, new URL(req.url!, "http://localhost").pathname, { controller, fault: "" })
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/settings/networks`;
  try {
    for (const route of ["save", "trial", "keep", "previous", "cancel", "scan", "maintenance"]) {
      assert.equal((await fetch(`${base}/${route}`)).status, 405);
      const refusal = await fetch(`${base}/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"password":"synthetic-private-input"}',
      });
      assert.equal(refusal.status, 403);
      assert.equal(((await refusal.json()) as { csrfRefusal: boolean }).csrfRefusal, true);
    }
    const view = (await (await fetch(base)).json()) as NetworkView;
    const identity = {
      instanceId: view.instanceId,
      generation: view.generation,
      revision: view.revision,
      settingsRevision: view.settingsRevision,
    };
    const headers = { "X-Cool-Eva": "settings", "Content-Type": "application/json", "X-Cool-Eva-Tunnel": "1" };
    assert.equal(
      (
        await fetch(base + "/scan", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...identity, generation: "stale" }),
        })
      ).status,
      409
    );
    const secret = "synthetic-private-input";
    const response = await fetch(base + "/save", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...identity,
        draft: {
          ssid: "Synthetic Wi-Fi",
          purpose: "home",
          replacedUuid: null,
          passwordMode: "change",
          password: secret,
          hidden: true,
          accessPointChange: true,
          bluetoothTested: true,
        },
      }),
    });
    assert.equal(response.status, 200);
    const saved = await response.text();
    assert.ok(!saved.includes(secret));
    assert.match(saved, /Saved. Ready to try/);
    assert.equal(
      backend.events.some(event => event.startsWith("activate:")),
      false
    );
    const invalid = await fetch(base + "/save", { method: "POST", headers, body: `{"password":"${secret}` });
    assert.equal(invalid.status, 409);
    assert.ok(!(await invalid.text()).includes(secret));
    const large = await fetch(base + "/save", { method: "POST", headers, body: " ".repeat(17 * 1024) });
    assert.equal(large.status, 409);
    const read = (await (await fetch(base, { headers: { "X-Cool-Eva-Tunnel": "1" } })).json()) as NetworkView;
    assert.equal(read.viaBluetooth, true);
    assert.equal(read.canKeep, false);
    console.log(
      "Wi-Fi HTTP: all 7 mutations require CSRF, stale generation/JSON/body limits and secret redaction pass."
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    await controller.close();
    await closeSettingsFixture(fixture);
  }
}
