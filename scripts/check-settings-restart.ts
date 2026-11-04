import assert from "assert/strict";
import { setTimeout as delay } from "timers/promises";
import { freshSettings } from "../src/settings/schema.ts";
import { createSettingsRestart } from "../src/settings/restart.ts";
import { acquireBus, busHeldBy } from "../src/vcu/bus-lease.ts";
import { restartMotionBlockers, sampleServiceGate } from "../src/vcu/service-gate.ts";
import { handleCanRestartEndpoint } from "../src/http/can-restart.ts";
import { postRequest, recordingResponse } from "./recording-response.ts";
import { closeSettingsFixture, settingsFixture } from "./settings-check-fixtures.ts";

await checkReservation();
await checkExpiry();
await checkExpiredDelivery();
checkMotion();
console.log("settings restart checks passed");

async function checkReservation(): Promise<void> {
  const fixture = await settingsFixture();
  let scheduled = 0;
  const restart = createSettingsRestart({
    store: fixture.store,
    motionBlockers: () => [],
    schedule: async () => {
      scheduled += 1;
    },
    deliveryTimeoutMs: 30,
    stopTimeoutMs: 1_000,
  });
  try {
    const document = freshSettings(fixture.paths);
    document.values.discoverHubOnce = true;
    await fixture.store.initialise(document);
    assert.equal(await restart.reserve("old-process", 0), false);
    assert.equal(busHeldBy(), null);
    const alreadyReading = acquireBus("synthetic parameter read");
    assert.equal(alreadyReading.ok, true);
    await assert.rejects(restart.reserve(restart.generation, 0), /Busy/);
    if (alreadyReading.ok) {
      alreadyReading.lease.release();
    }
    await fixture.store.update(0, { radiatorFanEnabled: true });
    await assert.rejects(restart.reserve(restart.generation, 0), /Settings changed/);
    assert.equal(await restart.reserve(restart.generation, 1), true);
    assert.match(busHeldBy() ?? "", /Cool Eva restart/);
    for (const operation of ["synthetic manual write", "synthetic automatic current", "synthetic read"]) {
      assert.equal(acquireBus(operation).ok, false);
    }
    await assert.rejects(fixture.store.update(1, { coolantProbesEnabled: true }), /restart is reserved/);
    assert.equal(await fixture.store.learnHub("02:00:00:00:00:01"), false);
    const refusedCanRestart = recordingResponse();
    await handleCanRestartEndpoint(
      postRequest({ "x-cool-eva": "can-restart" }),
      refusedCanRestart.res,
      "synthetic0",
      async () => {
        throw new Error("must not restart a reserved CAN link");
      }
    );
    assert.equal(refusedCanRestart.statusCode, 409);
    let finishDelivery: () => void = () => {
      throw new Error("delivery was not started");
    };
    const delivery = restart.deliverAndSchedule(
      () =>
        new Promise<void>(resolve => {
          finishDelivery = resolve;
        })
    );
    assert.equal(scheduled, 0);
    assert.equal(await restart.reserve(restart.generation, 1), false);
    assert.equal(acquireBus("during BLE drain").ok, false);
    finishDelivery();
    await delivery;
    assert.equal(scheduled, 1);
    await restart.deliverAndSchedule(async () => {});
    assert.equal(scheduled, 1);
    restart.consume();
    assert.equal(restart.status().state, "stopping");
    assert.equal(acquireBus("during shutdown").ok, false);
  } finally {
    await restart.close();
    await closeSettingsFixture(fixture);
  }
  assert.equal(busHeldBy(), null);
  console.log(
    "  revision and shared bus are reserved across BLE delivery and shutdown; no duplicate scheduling or late hub/write slips through"
  );
}

async function checkExpiry(): Promise<void> {
  for (const mode of [
    "unused",
    "lost-reply",
    "failed-reply",
    "scheduler-hangs",
    "scheduler-fails",
    "no-sigterm",
  ] as const) {
    const fixture = await settingsFixture();
    let scheduled = 0;
    const restart = createSettingsRestart({
      store: fixture.store,
      motionBlockers: () => [],
      deliveryTimeoutMs: 15,
      scheduleTimeoutMs: 15,
      stopTimeoutMs: 80,
      schedule: async () => {
        scheduled += 1;
        if (mode === "scheduler-hangs") {
          await new Promise<void>(() => {});
        }
        if (mode === "scheduler-fails") {
          throw new Error("synthetic systemd refusal");
        }
      },
    });
    try {
      await fixture.store.initialise(freshSettings(fixture.paths));
      assert.equal(await restart.reserve(restart.generation, 0), true);
      if (mode !== "unused") {
        await restart.deliverAndSchedule(async () => {
          if (mode === "lost-reply") {
            await new Promise<void>(() => {});
          }
          if (mode === "failed-reply") {
            throw new Error("synthetic connection lost");
          }
        });
        assert.equal(scheduled, 1);
      }
      await delay(100);
      assert.equal(restart.status().state, "failed");
      assert.match(restart.status().message, /Restart/);
      assert.equal(busHeldBy(), null);
      await fixture.store.update(0, { radiatorFanEnabled: true });
    } finally {
      await restart.close();
      await closeSettingsFixture(fixture);
    }
  }
  const fixture = await settingsFixture();
  const restart = createSettingsRestart({
    store: fixture.store,
    motionBlockers: () => ["road speed is zero"],
    schedule: async () => {
      throw new Error("must not schedule");
    },
  });
  try {
    await fixture.store.initialise(freshSettings(fixture.paths));
    await assert.rejects(restart.reserve(restart.generation, 0), /parked/);
    assert.equal(busHeldBy(), null);
  } finally {
    await restart.close();
    await closeSettingsFixture(fixture);
  }
  console.log(
    "  unused reservation, lost reply, failed scheduling and absent SIGTERM all release boundedly with a visible failure; failed delivery still schedules once"
  );
}

function checkMotion(): void {
  const unknown = () => sampleServiceGate(() => ({ value: null, ageMs: null }));
  assert.deepEqual(restartMotionBlockers(unknown()), []);
  for (const key of ["speed_can_kmh", "motor_rpm_can", "moving", "go", "go_request", "throttle_on"]) {
    const readings = unknown();
    readings[key] = { value: 1, ageMs: 0 };
    assert.ok(restartMotionBlockers(readings).length > 0, key);
    readings[key] = { value: 1, ageMs: 60_000 };
    assert.deepEqual(restartMotionBlockers(readings), []);
    readings[key] = { value: 0, ageMs: 0 };
    assert.deepEqual(restartMotionBlockers(readings), []);
  }
  const charging = unknown();
  charging.energized = { value: 1, ageMs: 0 };
  assert.deepEqual(restartMotionBlockers(charging), []);
  console.log(
    "  motion uses the existing rule table; fresh drive evidence blocks, missing/stale evidence and stationary charging permit a restart"
  );
}

async function checkExpiredDelivery(): Promise<void> {
  const fixture = await settingsFixture();
  let scheduled = 0;
  const restart = createSettingsRestart({
    store: fixture.store,
    motionBlockers: () => [],
    stopTimeoutMs: 120,
    deliveryTimeoutMs: 1_000,
    schedule: async () => {
      scheduled += 1;
    },
  });
  try {
    await fixture.store.initialise(freshSettings(fixture.paths));
    await restart.reserve(restart.generation, 0);
    let finishOld: () => void = () => {
      throw new Error("Old delivery not started");
    };
    const old = restart.deliverAndSchedule(
      () =>
        new Promise<void>(resolve => {
          finishOld = resolve;
        })
    );
    await delay(160);
    assert.equal(restart.status().state, "failed");
    assert.equal(await restart.reserve(restart.generation, 0), true);
    finishOld();
    await old;
    assert.equal(scheduled, 0, "An expired delivery cannot schedule against a later bus reservation.");
    await restart.deliverAndSchedule(() => {
      throw new Error("Synthetic synchronous delivery failure");
    });
    assert.equal(scheduled, 1, "A synchronous reply failure still schedules the restart.");
  } finally {
    await restart.close();
    await closeSettingsFixture(fixture);
  }
  console.log("  an expired BLE delivery cannot consume a later lease; a synchronous delivery failure still restarts");
}
