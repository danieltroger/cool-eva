import assert from "assert/strict";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { startNetworkSettings } from "../src/wifi/network-startup.ts";
import { openSettingsStore } from "../src/settings/store.ts";
import { freshSettings, degradedSettings } from "../src/settings/schema.ts";
import type { SettingsRuntime } from "../src/settings/startup.ts";
import { excludeNetworkCandidates } from "../src/wifi/operation.ts";
import { recoverWifi, realEffects } from "../src/wifi/recover.ts";
import { RECOVER_TRIGGER, REJOIN_OUTCOME } from "../src/wifi/ladder.ts";
import type { runCommand } from "../src/wifi/nmcli.ts";
import { settingsFixture, closeSettingsFixture } from "./settings-check-fixtures.ts";
import { FakeNetworkManager } from "./fake-network-manager.ts";

export async function checkNetworkRecovery(): Promise<void> {
  const fixture = await settingsFixture();
  const runtime: SettingsRuntime = {
    ...fixture,
    active: degradedSettings(fixture.paths),
    activeCodeId: null,
    dataWritable: true,
    fault: null,
    wifiDiagnosticDirectory: fixture.paths.wifiDiagnosticDirectory,
    readiness: { coolant: "Off", fan: "Off", recording: "Off", bluetooth: "Off", hub: "Off", can: "Off" },
  };
  try {
    await writeFile(fixture.paths.settingsFile, "{broken");
    runtime.store = await openSettingsStore(fixture.paths, fixture.lock, process.getgid!());
    assert.equal(runtime.store.read().kind, "degraded");
    const degraded = await startNetworkSettings(
      runtime,
      "synthetic-process",
      () => [],
      () => {}
    );
    assert.equal(degraded.controller, null);
    await assertRecoveryRuns();
    await fixture.store.initialise(freshSettings(fixture.paths));
    runtime.store = fixture.store;
    const path = join(fixture.paths.privateDirectory, "network-trials.json");
    await writeFile(path, "{broken");
    const ledgerFault = await startNetworkSettings(
      runtime,
      "synthetic-process",
      () => [],
      () => {}
    );
    assert.equal(ledgerFault.controller, null);
    await assertRecoveryRuns();
    await unlink(path);
    runtime.dataWritable = false;
    assert.equal(
      (
        await startNetworkSettings(
          runtime,
          "synthetic-process",
          () => [],
          () => {}
        )
      ).controller,
      null
    );
    await assertRecoveryRuns();
    runtime.dataWritable = true;
    const backend = new FakeNetworkManager();
    backend.list = async () => {
      throw new Error("Synthetic boot D-Bus failure");
    };
    const listed = await startNetworkSettings(
      runtime,
      "synthetic-process",
      () => [],
      () => {},
      () => backend
    );
    assert.ok(listed.controller);
    try {
      assert.equal(listed.controller.fault, "");
      await assertRecoveryRuns();
    } finally {
      await listed.controller.close();
    }
    console.log(
      "Wi-Fi startup faults: degraded settings, data/ledger faults and boot NM failure preserve watchdog/gesture recovery; same-name candidates never activate."
    );
  } finally {
    excludeNetworkCandidates([]);
    await closeSettingsFixture(fixture);
  }
}

async function assertRecoveryRuns(): Promise<void> {
  const excluded = "00000000-0000-4000-8000-000000000071";
  const orphan = "00000000-0000-4000-8000-000000000072";
  const netplanOrphan = "00000000-0000-4000-8000-000000000073";
  const confirmed = "00000000-0000-4000-8000-000000000074";
  excludeNetworkCandidates([excluded]);
  const names = new Map([
    [excluded, "Synthetic excluded profile"],
    [orphan, "cool-eva-synthetic-orphan"],
    [netplanOrphan, "netplan-cool-eva-synthetic-orphan"],
    [confirmed, "Synthetic confirmed profile"],
  ]);
  const activated: string[] = [];
  const command: typeof runCommand = async (file, parameters) => {
    let stdout = "";
    if (parameters.includes("UUID,TYPE")) {
      stdout = [...names.keys()].map(uuid => `${uuid}:802-11-wireless`).join("\n");
    } else if (parameters.includes("connection.id,connection.autoconnect,802-11-wireless.ssid")) {
      const uuid = parameters.at(-1)!;
      stdout = `${names.get(uuid)}\n${uuid === confirmed ? "yes" : "no"}\nSynthetic hotspot\n`;
    } else if (parameters.includes("up")) {
      activated.push(parameters.at(-1)!);
    } else {
      assert.ok(parameters.includes("list"), "only synthetic scan/list/activation commands are allowed");
      stdout = "no:Synthetic hotspot:80";
    }
    return { command: file, stdout, stderr: "", exitCode: 0, elapsedMs: 0, timedOut: false, truncated: false };
  };
  const context = { iface: "wlan0", hotspotSsid: "Synthetic hotspot", dumpDirectory: null };
  for (const trigger of [RECOVER_TRIGGER.WATCHDOG, RECOVER_TRIGGER.GESTURE]) {
    assert.equal(await recoverWifi(context, trigger, realEffects(context, command)), REJOIN_OUTCOME.REJOINED);
  }
  assert.deepEqual(activated, [confirmed, confirmed]);
}
