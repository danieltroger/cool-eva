import assert from "assert/strict";
import { readFile, stat, writeFile } from "fs/promises";
import { CHECKPOINT_SECONDS, TRIAL_MS, RECOVERY_BUSY } from "../src/wifi/networks.ts";
import { acquireWifiOperation, networkCandidateExcluded } from "../src/wifi/operation.ts";
import {
  networkScenario as scenario,
  HOME,
  HOTSPOT,
  PASSWORD,
  networkIdentity as identity,
  networkDraft as draft,
  BLE,
  WIFI,
} from "./network-check-fixtures.ts";
import { installNetworkSecretSpies } from "./network-secret-spies.ts";
import { checkNetworkRegressions } from "./network-regressions.ts";
import { checkNetworkRecovery } from "./network-recovery-check.ts";

async function checkNetworks(): Promise<void> {
  assert.ok(CHECKPOINT_SECONDS * 1000 > TRIAL_MS, "checkpoint outlives the owner's trial");
  await scenario("Save and plain start cannot activate; failed trial survives two boots", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    const uuid = fixture.networks.state().change!.uuid;
    assert.equal(fixture.backend.profiles.get(uuid)?.autoconnect, false);
    assert.equal(fixture.backend.profiles.get(uuid)?.authRetries, 1);
    assert.ok(networkCandidateExcluded(uuid));
    await fixture.restart();
    assert.equal(fixture.backend.current?.uuid, HOME.uuid);
    assert.equal(fixture.backend.events.filter(event => event === `activate:${uuid}`).length, 0);
    await fixture.networks.trial(identity(fixture.networks));
    await fixture.networks.tick();
    fixture.backend.time += 1_000;
    await fixture.backend.active();
    assert.equal(
      fixture.backend.authAttempts.filter(candidate => candidate === uuid).length,
      1,
      "bounded NM auth budget"
    );
    fixture.backend.time += TRIAL_MS;
    await fixture.networks.tick();
    assert.equal(fixture.networks.state().change!.phase, "restored");
    fixture.backend.accessPoints.set("Synthetic replacement", { password: PASSWORD, readyAt: 0 });
    fixture.backend.disk.get(uuid)!.priority = 999;
    await fixture.restart();
    await fixture.restart();
    assert.equal(
      fixture.backend.current?.uuid,
      HOME.uuid,
      "NM boot selection must exclude the failed candidate even at higher priority"
    );
  });
  await scenario("Save first, AP changes late, retries and direct Wi-Fi confirmation", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    const uuid = fixture.networks.state().change!.uuid;
    const revision = fixture.networks.state().revision;
    await fixture.networks.trial(identity(fixture.networks));
    assert.equal(
      fixture.networks.state().change!.checkpoint?.startsWith("/org/freedesktop/NetworkManager/Checkpoint/"),
      true
    );
    assert.equal(fixture.networks.state().revision, revision);
    await fixture.networks.tick();
    fixture.backend.time += 21_000;
    fixture.backend.accessPoints.set("Synthetic replacement", { password: PASSWORD, readyAt: fixture.backend.time });
    await fixture.networks.tick();
    await fixture.networks.tick();
    assert.equal(fixture.networks.state().change!.phase, "waiting");
    assert.equal(fixture.networks.state().change!.attempts, 2, "AP changes are not single-shot");
    assert.ok(fixture.backend.profiles.has(HOME.uuid), "old profile stays until Keep");
    assert.equal(fixture.backend.profiles.get(uuid)?.autoconnect, false);
    await assert.rejects(fixture.networks.keep(identity(fixture.networks), BLE), /new Wi-Fi/);
    await assert.rejects(
      fixture.networks.keep(identity(fixture.networks), { ...WIFI, remoteAddress: "127.0.0.1" }),
      /new Wi-Fi/
    );
    await assert.rejects(
      fixture.networks.keep(identity(fixture.networks), { ...WIFI, localAddress: "192.0.2.99" }),
      /new Wi-Fi/
    );
    await fixture.networks.keep(identity(fixture.networks), WIFI);
    assert.equal(fixture.networks.state().change!.phase, "kept");
    assert.equal(fixture.backend.profiles.get(uuid)?.priority, HOME.priority);
    assert.equal(fixture.backend.profiles.get(uuid)?.authRetries, 0);
    assert.equal(fixture.backend.profiles.get(uuid)?.autoconnect, true);
    assert.ok(fixture.backend.events.indexOf("destroy") < fixture.backend.events.indexOf("policy"));
    assert.ok(fixture.backend.events.indexOf("policy") < fixture.backend.events.indexOf(`remove:${HOME.uuid}`));
    assert.ok(fixture.backend.profiles.has(HOTSPOT.uuid), "unrelated profile preserved");
    assert.equal((await stat(fixture.path)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(fixture.path, "utf8")).includes(PASSWORD));
  });
  await scenario("Phone first reaches Save over BLE; retained password stays server-side", async fixture => {
    fixture.backend.accessPoints.delete(HOME.ssid);
    fixture.backend.current = null;
    fixture.backend.accessPoints.set("Synthetic replacement", { password: PASSWORD, readyAt: 0 });
    const submission = { ...draft(), passwordMode: "keep" as const, password: "" };
    await assert.rejects(fixture.networks.save(identity(fixture.networks), submission, false), /Bluetooth/);
    fixture.bluetoothReady = false;
    await assert.rejects(fixture.networks.save(identity(fixture.networks), submission, true), /Bluetooth/);
    fixture.bluetoothReady = true;
    await fixture.networks.save(identity(fixture.networks), submission, true);
    await fixture.networks.trial(identity(fixture.networks));
    await fixture.networks.tick();
    await fixture.networks.tick();
    assert.equal(fixture.networks.state().change!.phase, "waiting");
    const view = await fixture.networks.view(BLE);
    assert.equal(view.canKeep, false);
    assert.ok(!JSON.stringify(view).includes(PASSWORD));
    await fixture.networks.previous(identity(fixture.networks));
    assert.equal(fixture.networks.state().change!.phase, "failed");
    assert.match(fixture.networks.state().change!.message, /still saved.*could not reconnect/);
  });
  await scenario("Motion is checked before every retry, and Try again needs no new password", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    const uuid = fixture.networks.state().change!.uuid;
    await fixture.networks.trial(identity(fixture.networks));
    await fixture.networks.tick();
    fixture.moving = true;
    fixture.backend.time += 21_000;
    await assert.rejects(fixture.networks.tick(), /parked/);
    assert.equal(fixture.backend.events.filter(event => event === `activate:${uuid}`).length, 1);
    fixture.moving = false;
    fixture.backend.accessPoints.set("Synthetic replacement", { password: PASSWORD, readyAt: 0 });
    await fixture.networks.trial(identity(fixture.networks));
    await fixture.networks.tick();
    await fixture.networks.tick();
    assert.equal(fixture.networks.state().change!.uuid, uuid, "armed Try again keeps the stored candidate");
    assert.equal(fixture.networks.state().change!.phase, "waiting");
  });
  await scenario("Recovery mid-step refuses admission, and settings/restart cannot overlap trial", async fixture => {
    const release = acquireWifiOperation("recovery")!;
    assert.ok(release);
    await assert.rejects(
      fixture.networks.save(identity(fixture.networks), draft(), true),
      error => error instanceof Error && error.message === RECOVERY_BUSY
    );
    release();
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    fixture.moving = true;
    await assert.rejects(fixture.networks.trial(identity(fixture.networks)), /parked/);
    fixture.moving = false;
    await fixture.networks.trial(identity(fixture.networks));
    await assert.rejects(fixture.settings.reserve(fixture.networks.settingsRevision()), /A Wi-Fi trial is running/);
    await assert.rejects(
      fixture.settings.update(fixture.networks.settingsRevision()!, { coolantProbesEnabled: true }),
      /reserved/
    );
    assert.equal(acquireWifiOperation("recovery"), null);
  });
  await scenario("Owned checkpoint survives a process restart; no fresh trial is authorised", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    await fixture.networks.trial(identity(fixture.networks));
    await fixture.networks.tick();
    const uuid = fixture.networks.state().change!.uuid;
    await fixture.restart(false);
    assert.ok(fixture.backend.events.includes("rollback"));
    assert.equal(fixture.backend.events.filter(event => event === `activate:${uuid}`).length, 1);
    assert.equal(fixture.backend.checkpointsByPath.size, 0);
  });
  for (const cut of ["destroy", "policy", "remove"]) {
    await scenario(`Confirmation resumes after a power cut at ${cut}`, async fixture => {
      await fixture.networks.save(
        identity(fixture.networks),
        { ...draft(), replacedUuid: HOTSPOT.uuid, purpose: "hotspot" },
        true
      );
      fixture.backend.accessPoints.set("Synthetic replacement", { password: PASSWORD, readyAt: 0 });
      await fixture.networks.trial(identity(fixture.networks));
      await fixture.networks.tick();
      await fixture.networks.tick();
      fixture.backend.failAt = cut;
      await assert.rejects(fixture.networks.keep(identity(fixture.networks), WIFI), /power cut/);
      await fixture.settings.update(fixture.networks.settingsRevision()!, {
        phoneHotspotSsid: "Synthetic rolled-back name",
      });
      fixture.hotspot = "Synthetic rolled-back name";
      await fixture.restart(false);
      assert.equal(fixture.networks.state().change!.phase, "kept");
      assert.match(fixture.networks.state().change!.message, /Wi-Fi may switch at power-on/);
      assert.equal(fixture.hotspot, "Synthetic replacement");
      const removal = fixture.backend.events.indexOf(`remove:${HOTSPOT.uuid}`);
      assert.ok(
        fixture.backend.events.indexOf("identity") < removal,
        "hotspot-check identity changes before retirement"
      );
    });
  }
  await scenario("Lost keyfile is visible; boot never reconstructs or activates it", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    const uuid = fixture.networks.state().change!.uuid;
    fixture.backend.disk.delete(uuid);
    await fixture.restart();
    assert.equal(fixture.backend.profiles.has(uuid), false);
    assert.equal(fixture.networks.state().change!.phase, "failed");
    assert.match(fixture.networks.state().change!.message, /could not be restored/);
    const view = await fixture.networks.view(BLE);
    assert.equal(view.change!.phase, "failed");
    assert.match(view.change!.message, /could not be restored/, "readback must not hide the missing candidate");
    await assert.rejects(fixture.networks.trial(identity(fixture.networks)));
    assert.equal(fixture.backend.events.filter(event => event === `activate:${uuid}`).length, 0);
  });
  await scenario("Add priority follows its purpose and Cancel preserves unrelated settings", async fixture => {
    const ledger = fixture.networks.state();
    await fixture.networks.persist({ purposes: { ...ledger.purposes, [HOME.uuid]: "home" } });
    await fixture.networks.save(identity(fixture.networks), { ...draft(), replacedUuid: null }, true);
    assert.equal(fixture.networks.state().change!.priority, HOME.priority);
    const stale = identity(fixture.networks);
    await fixture.networks.cancel(stale);
    assert.equal(fixture.networks.state().change, null);
    await assert.rejects(fixture.networks.trial(stale), /stale/);
    const current = fixture.settings.read();
    assert.equal(current.kind, "ready");
    if (current.kind === "ready") {
      assert.equal(current.document.values.coolantProbesEnabled, false);
    }
    const fallback = fixture.backend.current;
    assert.equal(fallback?.uuid, HOME.uuid);
  });
  await scenario("NM independently rolls back an abandoned checkpoint", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    await fixture.networks.trial(identity(fixture.networks));
    await fixture.networks.tick();
    await fixture.networks.close();
    fixture.backend.time += 181_000;
    await fixture.backend.active();
    assert.ok(fixture.backend.events.includes("checkpoint-timeout"));
    assert.equal(fixture.backend.current?.uuid, HOME.uuid);
    await fixture.restart(false);
    assert.equal(fixture.networks.state().change!.phase, "restored");
  });
  await scenario("Lost persistent write refuses Save without activating an orphan", async fixture => {
    fixture.backend.loseWrite = true;
    await assert.rejects(fixture.networks.save(identity(fixture.networks), draft(), true));
    assert.equal(fixture.networks.state().change, null);
    assert.deepEqual([...fixture.backend.profiles.keys()], [HOME.uuid, HOTSPOT.uuid]);
    assert.equal(fixture.backend.passwords.size, 2, "failed Save removes the new password from NM");
    fixture.backend.boot();
    assert.equal(fixture.backend.current?.uuid, HOME.uuid);
  });
  await scenario("Own-hotspot change, and route-C maintenance never arms a trial", async fixture => {
    fixture.backend.current = { uuid: HOTSPOT.uuid, address: "192.0.2.20" };
    await fixture.networks.save(
      identity(fixture.networks),
      { ...draft(), purpose: "hotspot", replacedUuid: HOTSPOT.uuid },
      true
    );
    await fixture.networks.maintenance(identity(fixture.networks));
    assert.equal(fixture.networks.state().change!.phase, "saved");
    fixture.backend.accessPoints.delete(HOTSPOT.ssid);
    fixture.backend.accessPoints.set("Synthetic replacement", {
      password: PASSWORD,
      readyAt: fixture.backend.time + 21_000,
    });
    await fixture.networks.trial(identity(fixture.networks));
    await fixture.networks.tick();
    fixture.backend.time += 21_000;
    await fixture.networks.tick();
    await fixture.networks.tick();
    assert.equal(fixture.networks.state().change!.phase, "waiting");
    await fixture.networks.maintenance(identity(fixture.networks));
    assert.equal(fixture.networks.state().change!.phase, "failed");
    const attempts = fixture.backend.events.filter(event => event.startsWith("activate:")).length;
    await fixture.restart();
    assert.equal(fixture.backend.events.filter(event => event.startsWith("activate:")).length, attempts);
  });
  for (const phase of ["promoting", "identity", "retiring", "kept"] as const) {
    for (const after of [false, true]) {
      await scenario(`Journal cut ${after ? "after" : "before"} ${phase}`, async fixture => {
        await fixture.networks.save(identity(fixture.networks), draft(), true);
        fixture.backend.accessPoints.set("Synthetic replacement", { password: PASSWORD, readyAt: 0 });
        await fixture.networks.trial(identity(fixture.networks));
        await fixture.networks.tick();
        await fixture.networks.tick();
        fixture.journalCut = { phase, after };
        await assert.rejects(fixture.networks.keep(identity(fixture.networks), WIFI), /journal cut/);
        await fixture.restart(false);
        assert.equal(fixture.networks.state().change!.phase, "kept");
        if (!(phase === "kept" && after)) {
          assert.match(fixture.networks.state().change!.message, /Wi-Fi may switch at power-on/);
        }
      });
    }
  }
  await scenario("Slow checkpoint journal cannot extend the trial", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    fixture.writerLag = 61_000;
    await fixture.networks.trial(identity(fixture.networks));
    assert.equal((await fixture.networks.view(BLE)).remainingMs, 59_000);
  });
  await scenario("A retry cannot activate after its write crosses the deadline", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    const uuid = fixture.networks.state().change!.uuid;
    await fixture.networks.trial(identity(fixture.networks));
    fixture.writerLag = TRIAL_MS + 1;
    await fixture.networks.tick();
    assert.equal(fixture.backend.events.filter(event => event === `activate:${uuid}`).length, 0);
    assert.equal(fixture.networks.state().change!.phase, "restored");
  });
  await scenario("NM chooses priority then most recent use at a tie", async fixture => {
    fixture.backend.profiles.get(HOTSPOT.uuid)!.priority = HOME.priority;
    fixture.backend.disk.get(HOTSPOT.uuid)!.priority = HOME.priority;
    fixture.backend.time = 1_000;
    await fixture.backend.activate(HOTSPOT.uuid);
    fixture.backend.boot();
    assert.equal(fixture.backend.current?.uuid, HOTSPOT.uuid);
    fixture.backend.disk.get(HOME.uuid)!.priority += 1;
    fixture.backend.boot();
    assert.equal(fixture.backend.current?.uuid, HOME.uuid);
  });
  await scenario("A newer or corrupt trial ledger is preserved", async fixture => {
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    const original = await readFile(fixture.path, "utf8");
    const future = JSON.stringify({ ...JSON.parse(original), version: 2 });
    await writeFile(fixture.path, future);
    await assert.rejects(fixture.restart(), /needs repair/);
    assert.equal(await readFile(fixture.path, "utf8"), future);
    await writeFile(fixture.path, "{broken");
    await assert.rejects(fixture.restart(), /needs repair/);
    assert.equal(await readFile(fixture.path, "utf8"), "{broken");
  });
  await scenario("Discover-once hub learning stays runtime state during a network trial", async fixture => {
    await fixture.settings.update(fixture.networks.settingsRevision()!, { discoverHubOnce: true, hubAddress: null });
    await fixture.networks.save(identity(fixture.networks), draft(), true);
    await fixture.networks.trial(identity(fixture.networks));
    const revision = fixture.networks.settingsRevision();
    assert.equal(await fixture.settings.learnHub("02:00:00:00:00:08"), true);
    assert.equal(fixture.networks.settingsRevision(), revision);
    const stored = fixture.settings.read();
    assert.equal(stored.kind, "ready");
    if (stored.kind === "ready") {
      assert.equal(stored.document.learned.hubAddress, "02:00:00:00:00:08");
    }
  });
  await checkNetworkRegressions();
  await checkNetworkRecovery();
  console.log(
    "Wi-Fi network settings: 38 scenarios and 4 startup/recovery fault cases passed (no radio/device operations)."
  );
}

installNetworkSecretSpies([PASSWORD]);
await checkNetworks();
