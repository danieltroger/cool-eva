import assert from "assert/strict";
import { TRIAL_MS } from "../src/wifi/networks.ts";
import { RESTORATION_MS } from "../src/wifi/network-reconciliation.ts";
import { acquireWifiOperation } from "../src/wifi/operation.ts";
import { registerNetworkPurposes } from "./configure-network-purposes.ts";
import { networkRecoveryIncomplete } from "../public/lib/network-recovery.js";
import {
  networkScenario as scenario,
  networkIdentity as identity,
  networkDraft as draft,
  HOME,
  HOTSPOT,
  PASSWORD,
  WIFI,
  BLE,
} from "./network-check-fixtures.ts";

export async function checkNetworkRegressions(): Promise<void> {
  for (const phase of ["trying", "waiting"] as const) {
    await scenario(`A fault before recovery leaves ${phase} classified incomplete`, async fixture => {
      await fixture.networks.save(identity(fixture.networks), draft(), true);
      if (phase === "waiting") {
        fixture.backend.accessPoints.set("Synthetic replacement", { password: PASSWORD, readyAt: 0 });
      }
      await fixture.networks.trial(identity(fixture.networks));
      await fixture.networks.tick();
      if (phase === "waiting") {
        await fixture.networks.tick();
      }
      assert.equal(fixture.networks.state().change!.phase, phase);
      assert.equal(networkRecoveryIncomplete(await fixture.networks.view(BLE)), false);
      fixture.journalCut = { phase: "restoring", after: false };
      await fixture.restart(false);
      const faulted = await fixture.networks.view(BLE);
      assert.equal(faulted.change!.phase, phase);
      assert.match(faulted.message, /Recovery incomplete.*next power-on is unconfirmed/);
      assert.equal(networkRecoveryIncomplete(faulted), true);
      await fixture.networks.previous(identity(fixture.networks));
      assert.equal(fixture.networks.state().change!.phase, "restored");
      assert.equal(fixture.networks.fault, "");
    });
  }
  await scenario("Installer repair registers the replacement hotspot identity without a trial", async fixture => {
    await fixture.networks.persist({ hotspotUuid: HOME.uuid });
    await fixture.settings.update(fixture.networks.settingsRevision()!, { phoneHotspotSsid: "Synthetic old name" });
    await registerNetworkPurposes(fixture.networks, { [HOME.uuid]: "home", [HOTSPOT.uuid]: "hotspot" });
    assert.equal(fixture.networks.state().hotspotUuid, HOTSPOT.uuid);
    assert.equal(fixture.hotspot, HOTSPOT.ssid);
    assert.ok(!fixture.backend.events.some(event => event.startsWith("activate:")));
    await fixture.restart();
    assert.equal(fixture.networks.state().hotspotUuid, HOTSPOT.uuid);
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    await assert.rejects(
      registerNetworkPurposes(fixture.networks, { [fixture.networks.state().change!.uuid]: "hotspot" }),
      /only confirmed/
    );
  });
  await scenario("Result readback finishes before another trial can begin", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    fixture.backend.accessPoints.delete(HOME.ssid);
    await fixture.networks.trial(identity(fixture.networks));
    fixture.backend.time += TRIAL_MS;
    await fixture.networks.tick();
    fixture.backend.current = { uuid: HOME.uuid, address: "192.0.2.20" };
    const active = fixture.backend.active;
    let finishRead: () => void = () => {};
    let readStarted: () => void = () => {};
    const entered = new Promise<void>(resolve => {
      readStarted = resolve;
    });
    const pending = new Promise<void>(resolve => {
      finishRead = resolve;
    });
    fixture.backend.active = async () => {
      fixture.backend.active = active;
      readStarted();
      await pending;
      return active();
    };
    const reading = fixture.networks.view(BLE);
    await entered;
    const checkpoints = fixture.backend.events.filter(event => event.startsWith("checkpoint:")).length;
    const retry = fixture.networks.trial(identity(fixture.networks));
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      assert.equal(fixture.networks.releaseWifi, null, "a queued trial cannot take the radio during readback");
      assert.equal(fixture.backend.events.filter(event => event.startsWith("checkpoint:")).length, checkpoints);
    } finally {
      finishRead();
    }
    await reading;
    await retry;
    assert.equal(fixture.networks.state().change!.phase, "trying");
    assert.notEqual(fixture.networks.deadline, null);
  });
  await scenario(
    "A failed boot listing leaves existing recovery available without a permanent fault",
    async fixture => {
      const list = fixture.backend.list;
      fixture.backend.list = async () => {
        throw new Error("Synthetic NM unavailable");
      };
      await fixture.restart(false);
      assert.equal(fixture.networks.fault, "");
      const release = acquireWifiOperation("recovery");
      assert.ok(release);
      release();
      fixture.backend.list = list;
    }
  );
  for (const action of ["previous", "maintenance"] as const) {
    await scenario(`Startup reconciliation fault still allows ${action}`, async fixture => {
      await fixture.networks.save(identity(fixture.networks), draft(), true);
      await fixture.networks.trial(identity(fixture.networks));
      await fixture.networks.tick();
      const rollback = fixture.backend.rollback;
      fixture.backend.rollback = async () => {
        throw new Error("Synthetic rollback failure");
      };
      await fixture.restart(false);
      assert.notEqual(fixture.networks.fault, "");
      const view = await fixture.networks.view(BLE);
      assert.equal(view.ok, true, "a fault still returns a readable recovery identity");
      assert.equal(networkRecoveryIncomplete(view), true);
      assert.match(view.message, /Recovery incomplete.*next power-on is unconfirmed/);
      assert.doesNotMatch(view.message, /may switch|will not run/);
      fixture.backend.rollback = rollback;
      await fixture.networks[action](identity(fixture.networks));
      assert.equal(fixture.networks.fault, "");
      assert.equal(fixture.backend.current?.uuid, HOME.uuid);
    });
  }
  await scenario(
    "Netplan Change refuses a plain-keyfile candidate and deletes its password; Add remains available",
    async fixture => {
      fixture.backend.profiles.get(HOME.uuid)!.backend = "netplan";
      fixture.backend.disk.get(HOME.uuid)!.backend = "netplan";
      const add = fixture.backend.add;
      fixture.backend.add = async (profile, password, hidden) =>
        add({ ...profile, backend: "keyfile" }, password, hidden);
      await assert.rejects(fixture.networks.save(identity(fixture.networks), draft(), true), /Use Add/);
      assert.deepEqual([...fixture.backend.profiles.keys()].length, 2);
      assert.equal(fixture.backend.passwords.size, 2);
      assert.equal(fixture.networks.state().change, null);
      assert.ok(!fixture.backend.events.some(event => event.startsWith("activate:")));
      await fixture.networks.save(identity(fixture.networks), { ...draft(), replacedUuid: null }, true);
      assert.equal(fixture.networks.state().change!.phase, "saved");
    }
  );
  await scenario("Use previous after a confirmation fault disables the already promoted candidate", async fixture => {
    await fixture.settings.update(fixture.networks.settingsRevision()!, { phoneHotspotSsid: HOTSPOT.ssid });
    await fixture.networks.persist({ purposes: { [HOTSPOT.uuid]: "hotspot" }, hotspotUuid: HOTSPOT.uuid });
    await fixture.networks.save(
      identity(fixture.networks),
      { ...draft(), purpose: "hotspot", replacedUuid: HOTSPOT.uuid },
      true
    );
    const uuid = fixture.networks.state().change!.uuid;
    fixture.backend.accessPoints.set("Synthetic replacement", { password: PASSWORD, readyAt: 0 });
    await fixture.networks.trial(identity(fixture.networks));
    await fixture.networks.tick();
    await fixture.networks.tick();
    const remove = fixture.backend.remove;
    fixture.backend.remove = async () => {
      throw new Error("Synthetic retirement failure");
    };
    await assert.rejects(fixture.networks.keep(identity(fixture.networks), WIFI));
    await fixture.restart(false);
    assert.notEqual(fixture.networks.fault, "");
    fixture.backend.remove = remove;
    await fixture.networks.previous(identity(fixture.networks));
    assert.equal(fixture.backend.disk.get(uuid)!.autoconnect, false);
    assert.equal(fixture.backend.disk.get(uuid)!.authRetries, 1);
    assert.equal(fixture.backend.current?.uuid, HOME.uuid);
    assert.equal(fixture.hotspot, HOTSPOT.ssid);
    assert.equal(fixture.networks.state().hotspotUuid, HOTSPOT.uuid);
  });
  for (const restored of [false, true]) {
    await scenario(
      `Terminal ${restored ? "restored" : "failed"} result bounds NM polling and can be dismissed`,
      async fixture => {
        await fixture.networks.save(identity(fixture.networks), draft(), true);
        const uuid = fixture.networks.state().change!.uuid;
        fixture.backend.accessPoints.delete(HOME.ssid);
        await fixture.networks.trial(identity(fixture.networks));
        await fixture.networks.tick();
        fixture.backend.time += TRIAL_MS;
        await fixture.networks.tick();
        assert.equal(fixture.networks.state().change!.phase, "failed");
        if (restored) {
          fixture.backend.current = { uuid: HOME.uuid, address: "192.0.2.20" };
          await fixture.networks.tick();
          assert.equal(fixture.networks.state().change!.phase, "restored");
        } else {
          fixture.backend.time += RESTORATION_MS;
        }
        fixture.backend.active = async () => {
          throw new Error("A terminal tick must not call NM");
        };
        fixture.backend.list = async () => {
          throw new Error("A terminal tick must not list NM profiles");
        };
        for (let tick = 0; tick < 30; tick++) {
          fixture.backend.time += 1_000;
          await fixture.networks.tick();
        }
        await fixture.networks.cancel(identity(fixture.networks));
        assert.equal(fixture.networks.state().change, null);
        assert.equal(fixture.backend.profiles.has(uuid), false);
        assert.equal(fixture.backend.passwords.has(uuid), false);
      }
    );
  }
  await scenario("A direct read can observe restoration after the background window is idle", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    fixture.backend.accessPoints.delete(HOME.ssid);
    await fixture.networks.trial(identity(fixture.networks));
    fixture.backend.time += TRIAL_MS;
    await fixture.networks.tick();
    fixture.backend.time += RESTORATION_MS;
    await fixture.networks.tick();
    fixture.backend.current = { uuid: HOME.uuid, address: "192.0.2.20" };
    const view = await fixture.networks.view(BLE);
    assert.equal(view.change!.phase, "restored");
    assert.equal(view.observingRestoration, false);
  });
  await scenario("Updater rollback reconciles the kept hotspot name without a new trial", async fixture => {
    await fixture.settings.update(fixture.networks.settingsRevision()!, { phoneHotspotSsid: HOTSPOT.ssid });
    await fixture.networks.persist({ purposes: { [HOTSPOT.uuid]: "hotspot" }, hotspotUuid: HOTSPOT.uuid });
    await fixture.networks.save(identity(fixture.networks), { ...draft(), purpose: "hotspot" }, true);
    fixture.backend.accessPoints.set("Synthetic replacement", { password: PASSWORD, readyAt: 0 });
    await fixture.networks.trial(identity(fixture.networks));
    await fixture.networks.tick();
    await fixture.networks.tick();
    await fixture.networks.keep(identity(fixture.networks), WIFI);
    await fixture.settings.update(fixture.networks.settingsRevision()!, { phoneHotspotSsid: "Synthetic old identity" });
    fixture.hotspot = "Synthetic old identity";
    const attempts = fixture.backend.authAttempts.length;
    await fixture.restart();
    assert.equal(fixture.hotspot, "Synthetic replacement");
    assert.equal(fixture.backend.authAttempts.length, attempts);
    const settings = fixture.settings.read();
    assert.equal(settings.kind === "ready" && settings.document.values.phoneHotspotSsid, "Synthetic replacement");
    await fixture.networks.save(identity(fixture.networks), { ...draft(), replacedUuid: null }, true);
    await fixture.settings.update(fixture.networks.settingsRevision()!, {
      phoneHotspotSsid: "Synthetic older snapshot",
    });
    fixture.hotspot = "Synthetic older snapshot";
    await fixture.restart();
    assert.equal(fixture.networks.state().change!.phase, "saved", "a later draft never becomes a trial at boot");
    assert.equal(fixture.hotspot, "Synthetic replacement", "kept hotspot identity survives later drafts and rollback");
  });
}
