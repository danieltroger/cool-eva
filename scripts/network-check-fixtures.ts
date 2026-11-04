import assert from "assert/strict";
import { join } from "path";
import { freshSettings } from "../src/settings/schema.ts";
import { WifiNetworks } from "../src/wifi/networks.ts";
import { openNetworkLedger } from "../src/wifi/network-ledger.ts";
import type {
  NetworkProfile,
  NetworkPhase,
  NetworkDraft,
  NetworkRequestIdentity,
  NetworkProof,
} from "../src/wifi/network-types.ts";
import { FakeNetworkManager } from "./fake-network-manager.ts";
import { settingsFixture, closeSettingsFixture } from "./settings-check-fixtures.ts";

export async function networkScenario(name: string, work: (fixture: NetworkFixture) => Promise<void>): Promise<void> {
  const base = await settingsFixture();
  const document = freshSettings(base.paths);
  await base.store.initialise(document);
  const settings = base.store.read();
  assert.equal(settings.kind, "ready");
  if (settings.kind !== "ready") {
    throw new Error("Fixture not ready");
  }
  const instanceId = String(settings.raw.instanceId);
  const path = join(base.paths.privateDirectory, "network-trials.json");
  const backend = new FakeNetworkManager();
  for (const profile of [HOME, HOTSPOT]) {
    await backend.add(profile, PASSWORD, false);
    backend.accessPoints.set(profile.ssid, { password: PASSWORD, readyAt: 0 });
  }
  backend.boot();
  const fixture: NetworkFixture = {
    storage: base,
    settings: base.store,
    path,
    backend,
    networks: null as unknown as WifiNetworks,
    moving: false,
    bluetoothReady: true,
    hotspot: HOTSPOT.ssid,
    journalCut: null,
    writerLag: 0,
    restart: async (boot = true) => {
      await fixture.networks?.close();
      if (boot) {
        backend.boot();
      }
      const diskLedger = await openNetworkLedger(path, instanceId, base.lock);
      const ledger = {
        read: diskLedger.read,
        write: async (value: ReturnType<typeof diskLedger.read>) => {
          if (fixture.writerLag && value.change?.phase === "trying" && value.change.checkpoint) {
            backend.time += fixture.writerLag;
            fixture.writerLag = 0;
          }
          const cut = fixture.journalCut;
          if (cut && cut.phase === value.change?.phase) {
            fixture.journalCut = null;
            if (cut.after) {
              await diskLedger.write(value);
            }
            throw new Error("Simulated journal cut");
          }
          await diskLedger.write(value);
        },
      };
      fixture.networks = new WifiNetworks({
        ledger,
        settings: base.store,
        backend,
        generation: "synthetic-process",
        now: () => backend.time,
        motionBlockers: () => (fixture.moving ? ["moving"] : []),
        bluetoothReady: () => fixture.bluetoothReady,
        hotspotChanged: ssid => {
          fixture.hotspot = ssid;
          backend.events.push("identity");
        },
        autoTick: false,
      });
      await fixture.networks.start();
    },
  };
  try {
    await fixture.restart();
    await work(fixture);
    console.log(`  PASS ${name}`);
  } finally {
    await fixture.networks.close();
    await closeSettingsFixture(base);
  }
}
export interface NetworkFixture {
  storage: Awaited<ReturnType<typeof settingsFixture>>;
  settings: Awaited<ReturnType<typeof settingsFixture>>["store"];
  path: string;
  backend: FakeNetworkManager;
  networks: WifiNetworks;
  moving: boolean;
  bluetoothReady: boolean;
  hotspot: string;
  journalCut: { phase: NetworkPhase; after: boolean } | null;
  writerLag: number;
  restart: (boot?: boolean) => Promise<void>;
}

export const PASSWORD = "synthetic-passphrase";
export const HOME: NetworkProfile = {
  uuid: "00000000-0000-4000-8000-000000000001",
  name: "Synthetic home",
  ssid: "Synthetic home",
  priority: 20,
  autoconnect: true,
  authRetries: 0,
  security: "wpa-psk",
  backend: "keyfile",
};
export const HOTSPOT: NetworkProfile = {
  ...HOME,
  uuid: "00000000-0000-4000-8000-000000000002",
  name: "Synthetic hotspot",
  ssid: "Synthetic hotspot",
  priority: 10,
};

export function networkIdentity(networks: WifiNetworks): NetworkRequestIdentity {
  const state = networks.state();
  return {
    instanceId: state.instanceId,
    generation: networks.generation,
    revision: state.revision,
    settingsRevision: networks.settingsRevision(),
  };
}
export function networkDraft(): NetworkDraft {
  return {
    ssid: "Synthetic replacement",
    purpose: "home",
    replacedUuid: HOME.uuid,
    passwordMode: "change",
    password: PASSWORD,
    hidden: false,
    accessPointChange: true,
    bluetoothTested: true,
  };
}
export const BLE: NetworkProof = { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1", tunnel: true };
export const WIFI: NetworkProof = { localAddress: "192.0.2.30", remoteAddress: "192.0.2.40", tunnel: false };
