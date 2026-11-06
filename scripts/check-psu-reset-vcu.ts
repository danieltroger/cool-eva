import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordArrival } from "../src/can/signals.ts";
import { monotonicNow } from "../src/monotonic.ts";
import { PSU_HOLD_MAX_MS } from "../src/psu/hold.ts";
import { acquireBus, busBlocksPsuHold, busHeldBy } from "../src/vcu/bus-lease.ts";
import { createVcuReadRunner } from "../src/vcu/read-runner.ts";
import type { ServiceWriteRequest } from "../src/vcu/write-runner.ts";
import { scriptedChannel, waitUntil } from "./can-transmit-fixtures.ts";
import { psuFixture } from "./psu-hold-fixture.ts";
import { parkSyntheticBike, resetWriteFixture } from "./psu-reset-vcu-fixture.ts";

export async function checkPsuResetVcu(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-psu-reset-"));
  try {
    await survivesReset(directory);
    await stopsForOtherWrites(directory);
    await stopsForSweep(directory);
    await stopDuringReset(directory, "owner");
    await stopDuringReset(directory, "timeout");
    laterLeaseIsolation();
    assert.equal(busHeldBy(), null);
    assert.equal(busBlocksPsuHold(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log(
    "PSU reset: held reset exchanges retain exact repeat frames and deadline; parameter/sweep/charge leases stop, later holders isolate, Start/Extend refuse, Off/timeout still stop"
  );
}

await checkPsuResetVcu();

async function survivesReset(directory: string): Promise<void> {
  const fixture = psuFixture();
  const micro = resetWriteFixture(directory, fixture.hold);
  assert(fixture.act("start").ok);
  const revision = fixture.hold.status().revision;
  const remaining = fixture.hold.status().remainingMs;
  const reset = micro.runner.perform({ kind: "reset-vcu" });
  try {
    for (const [target, service, operand] of [
      [0xa9, 0x10, 0x81],
      [0xa8, 0x10, 0x81],
      [0xa9, 0x11, 0x02],
      [0xa8, 0x11, 0x02],
    ]) {
      // The fake micro withholds this reply until the during-lease assertions finish.
      const request = await micro.nextRequest(reset);
      assert.equal(request.id, 0x7c0);
      assert.deepEqual([...request.data], [target, 2, service, operand, 0, 0, 0, 0]);
      assert.equal(busHeldBy(), "a service write", "Reset must still own the lease");
      assert.equal(busBlocksPsuHold(), false);
      assert(fixture.hold.status().on, "Reset acquisition must preserve the existing hold");
      const channel = fixture.channels[0];
      const count = channel.frames.length;
      fixture.clock.advance(300);
      assert.equal(busHeldBy(), "a service write", "No reply was released while advancing two PSU slots");
      assert.equal(channel.frames.length, count + 2, "Two PSU repeats must occur DURING the held exchange");
      assert.equal(channel.stops, 0);
      assert(!fixture.act("extend").ok, "Even an opted-in lease refuses Extend");
      const unstarted = psuFixture();
      try {
        const refused = unstarted.act("start");
        assert.equal(refused.statusCode, 409, "An opted-in reset still refuses a new Start");
        assert.match(refused.message, /Busy: a service write/);
        assert.equal(unstarted.channels.length, 0);
      } finally {
        unstarted.hold.close();
      }
      assert.equal(acquireBus("a competing operation").ok, false, "Reset retains exclusive diagnostic ownership");
      assert.equal(busBlocksPsuHold(), false, "A refused acquisition cannot alter the holder's exception");
      assert.equal(micro.runner.handleCanFrame(0x500, channel.frames.at(-1)!.data), false);
      assert(micro.reply([service + 0x40, operand]), "Only the addressed diagnostic reply completes the exchange");
    }
    const result = await reset;
    assert(result.ok && result.result.succeeded);
    assert.equal(micro.bus.accepted.length, 4);
    assert.deepEqual(micro.holdAtSend, [true, true, true, true]);
    assert.equal(busHeldBy(), null);
    assert.equal(fixture.hold.status().revision, revision);
    assert.equal(fixture.hold.status().remainingMs, remaining - 1200, "Reset never renews the deadline");
    assert.equal(fixture.channels.length, 1, "Reset never reopens or shares the PSU transport");
    for (const frame of fixture.channels[0].frames) {
      assert.equal(frame.id, 0x500);
      assert.equal(frame.ext, false);
      assert.equal(frame.rtr, false);
      assert.deepEqual([...frame.data], [1, 0, 0, 0, 0, 0, 0, 0]);
    }
    const next = acquireBus("a later parameter read");
    assert(next.ok);
    try {
      assert.equal(fixture.hold.status().on, false, "The later default lease must not inherit reset's exception");
      assert.equal(fixture.hold.status().lastStopReason, "bus-lease");
    } finally {
      next.lease.release();
    }
  } finally {
    micro.runner.stop();
    await reset;
    fixture.hold.close();
  }
}

async function stopsForOtherWrites(directory: string): Promise<void> {
  const requests: ServiceWriteRequest[] = [
    { kind: "parameter", name: "MAX_DC_CHG_CURRENT", value: 70, expectedCurrent: 75 },
    { kind: "charge-current", amps: 32, origin: "manual" },
  ];
  for (const request of requests) {
    const fixture = psuFixture();
    const micro = resetWriteFixture(directory, fixture.hold);
    if (request.kind === "charge-current") {
      recordArrival("charge_manager_state", 0x23, Date.UTC(2026, 0, 2), monotonicNow());
      recordArrival("fast_dc_limit_max_a", 75, Date.UTC(2026, 0, 2), monotonicNow());
    }
    assert(fixture.act("start").ok);
    const operation = micro.runner.perform(request);
    try {
      await micro.nextRequest(operation);
      assert.equal(busHeldBy(), "a service write");
      assert.equal(micro.holdAtSend[0], false, `${request.kind} stops the PSU BEFORE its first frame`);
      assert.equal(fixture.hold.status().lastStopReason, "bus-lease");
      fixture.clock.advance(450);
      assert.equal(fixture.channels[0].frames.length, 1, "No PSU repeat after the operation acquired the bus");
      micro.runner.stop();
      await operation;
      assert.equal(busHeldBy(), null);
      fixture.clock.advance(450);
      assert.equal(fixture.hold.status().on, false, "Releasing a lease never restarts the hold");
      assert.equal(fixture.channels[0].frames.length, 1);
    } finally {
      micro.runner.stop();
      await operation;
      fixture.hold.close();
    }
  }
}

async function stopsForSweep(directory: string): Promise<void> {
  parkSyntheticBike();
  const fixture = psuFixture();
  const holdAtSend: boolean[] = [];
  const bus = scriptedChannel(
    () => 16,
    () => holdAtSend.push(fixture.hold.status().on)
  );
  const runner = createVcuReadRunner({ channel: () => bus.channel, busIsActive: true, directory });
  assert(fixture.act("start").ok);
  try {
    assert(runner.start().started, "Exercise a real admitted sweep, not a refused gate");
    assert.equal(busHeldBy(), "a parameter read");
    assert.equal(fixture.hold.status().on, false);
    await waitUntil(() => bus.accepted.length > 0, "sweep's first synthetic transmission");
    assert.equal(holdAtSend[0], false, "Sweep stops the PSU before its first frame");
    assert.equal(fixture.hold.status().lastStopReason, "bus-lease");
    fixture.clock.advance(450);
    assert.equal(fixture.channels[0].frames.length, 1);
  } finally {
    await runner.stop();
    await waitUntil(() => busHeldBy() === null, "sweep lease release");
    fixture.clock.advance(450);
    assert.equal(fixture.hold.status().on, false);
    assert.equal(fixture.channels[0].frames.length, 1);
    fixture.hold.close();
  }
}

async function stopDuringReset(directory: string, cause: "owner" | "timeout"): Promise<void> {
  const fixture = psuFixture();
  const micro = resetWriteFixture(directory, fixture.hold);
  assert(fixture.act("start").ok);
  const reset = micro.runner.perform({ kind: "reset-vcu" });
  try {
    await micro.nextRequest(reset);
    assert.equal(busHeldBy(), "a service write");
    assert(fixture.hold.status().on);
    const count = fixture.channels[0].frames.length;
    if (cause === "owner") {
      assert(fixture.hold.perform("stop", -1).ok);
    } else {
      fixture.clock.jump(PSU_HOLD_MAX_MS);
    }
    assert.equal(fixture.hold.status().on, false);
    assert.equal(fixture.hold.status().lastStopReason, cause);
    assert.equal(fixture.channels[0].frames.length, count);
    assert.equal(fixture.channels[0].stops, 1);
  } finally {
    micro.runner.stop();
    await reset;
    fixture.hold.close();
  }
}

function laterLeaseIsolation(): void {
  const allowed = acquireBus("a synthetic reset", { allowPsuHold: true });
  assert(allowed.ok);
  assert.equal(busBlocksPsuHold(), false);
  allowed.lease.release();
  for (const name of ["a parameter write", "a parameter read", "a charge command", "a CAN link restart"]) {
    const next = acquireBus(name);
    assert(next.ok);
    try {
      allowed.lease.release();
      assert.equal(busHeldBy(), name, "A late release must not clear a later holder");
      assert.equal(busBlocksPsuHold(), true, "Default acquisitions never inherit an earlier exception");
      assert.equal(acquireBus("a refused synthetic reset", { allowPsuHold: true }).ok, false);
      assert.equal(busBlocksPsuHold(), true, "A refused opted-in acquisition cannot weaken the current lease");
    } finally {
      next.lease.release();
    }
  }
}
