import assert from "assert/strict";
import { createServer } from "http";
import { once } from "events";
import { readFile } from "fs/promises";
import { handleSettingsEndpoint, type SettingsHttpContext } from "../src/http/settings.ts";
import { createSettingsRestart } from "../src/settings/restart.ts";
import type { SettingsRuntime } from "../src/settings/startup.ts";
import type { SettingsReply } from "../src/settings/view.ts";
import { networkScenario, HOTSPOT, BLE, type NetworkFixture } from "./network-check-fixtures.ts";

export async function checkNetworkHotspotOwnership(): Promise<void> {
  await networkScenario(
    "Owned hotspot names refuse owner PATCH; unowned edits survive restart and rollback still reconciles",
    async fixture => {
      const server = await settingsServer(fixture);
      try {
        assert.equal((await server.read()).hotspotNameOwnership, "manual");
        assert.equal((await server.save("Synthetic manual checks")).status, 200);
        await fixture.restart(false);
        assert.equal((await server.read()).saved.phoneHotspotSsid, "Synthetic manual checks");
        await fixture.networks.persist({ purposes: { [HOTSPOT.uuid]: "hotspot" } });
        await fixture.restart(false);
        assert.equal((await server.read()).hotspotNameOwnership, "network");
        const before = await readFile(fixture.storage.paths.settingsFile);
        const refused = await server.save("Synthetic owner edit");
        assert.equal(refused.status, 409);
        assert.match(await refused.text(), /Set by your saved Phone hotspot network/);
        assert.deepEqual(await readFile(fixture.storage.paths.settingsFile), before);
        await fixture.restart(false);
        assert.equal((await server.read()).saved.phoneHotspotSsid, HOTSPOT.ssid);
        await fixture.settings.update(fixture.networks.settingsRevision()!, { phoneHotspotSsid: "Synthetic rollback" });
        await fixture.restart(false);
        assert.equal((await server.read()).saved.phoneHotspotSsid, HOTSPOT.ssid);
        await fixture.backend.remove(HOTSPOT.uuid);
        await fixture.networks.view(BLE);
        assert.equal((await server.read()).hotspotNameOwnership, "manual");
        assert.equal((await server.save("Synthetic owner fallback")).status, 200);
        await fixture.restart(false);
        assert.equal((await server.read()).saved.phoneHotspotSsid, "Synthetic owner fallback");
      } finally {
        await server.close();
      }
    }
  );
  await networkScenario(
    "Unknown hotspot ownership refuses the field; settings GET adds no NM polling",
    async fixture => {
      let listings = 0;
      fixture.backend.list = async () => {
        listings += 1;
        throw new Error("Synthetic listing failure");
      };
      await fixture.restart(false);
      const server = await settingsServer(fixture);
      try {
        const before = listings;
        for (let read = 0; read < 4; read++) {
          assert.equal((await server.read()).hotspotNameOwnership, "unknown");
        }
        assert.equal(listings, before, "settings readback uses existing profile observations");
        const refused = await server.save("Synthetic unknown owner");
        assert.equal(refused.status, 409);
        assert.match(await refused.text(), /Read saved Wi-Fi networks/);
      } finally {
        await server.close();
      }
    }
  );
}

async function settingsServer(fixture: NetworkFixture) {
  const current = fixture.settings.read();
  assert.equal(current.kind, "ready");
  if (current.kind !== "ready") {
    throw new Error("Settings fixture is not ready");
  }
  const runtime: SettingsRuntime = {
    ...fixture.storage,
    active: structuredClone(current.document.values),
    activeCodeId: null,
    fault: null,
    dataWritable: true,
    wifiDiagnosticDirectory: fixture.storage.paths.wifiDiagnosticDirectory,
    readiness: { coolant: "Off", fan: "Off", recording: "Off", bluetooth: "Off", hub: "Off", can: "Off" },
  };
  const restart = createSettingsRestart({
    store: fixture.settings,
    motionBlockers: () => [],
    schedule: async () => {
      throw new Error("This check must never restart");
    },
  });
  const context: SettingsHttpContext = {
    runtime,
    restart,
    codeDirectory: fixture.storage.directory,
    scanHubs: async () => [],
    drainBluetooth: async () => {},
    hotspotNameOwnership: () => fixture.networks.hotspotNameOwnership(),
  };
  const server = createServer((request, response) => {
    void handleSettingsEndpoint(request, response, "/settings", context);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/settings`;
  return {
    read: async (): Promise<SettingsReply> => (await (await fetch(url)).json()) as SettingsReply,
    save: (name: string) =>
      fetch(url, {
        method: "PATCH",
        headers: { "X-Cool-Eva": "settings", "Content-Type": "application/json" },
        body: JSON.stringify({ revision: fixture.networks.settingsRevision(), changes: { phoneHotspotSsid: name } }),
      }),
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      await restart.close();
    },
  };
}
