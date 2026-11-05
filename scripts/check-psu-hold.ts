import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { acquireBus } from "../src/vcu/bus-lease.ts";
import { PSU_HOLD_MAX_MS, PSU_HOLD_INTERVAL_MS, PSU_TX_FAILURE_LIMIT } from "../src/psu/hold.ts";
import { psuFixture } from "./psu-hold-fixture.ts";

export async function checkPsuHold(): Promise<void> {
  assert.equal(PSU_HOLD_MAX_MS, 3_600_000);
  assert.equal(PSU_HOLD_INTERVAL_MS, 150);
  assert.equal(PSU_TX_FAILURE_LIMIT, 3);
  exactFrameAndCadence();
  expiryAndRenewal();
  negativeGates();
  stopCauses();
  productionClock();
  const entry = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert(entry.indexOf('name: "stop PSU hold"') < entry.indexOf('name: "stop the CAN channel"'));
  assert.match(entry, /name: "stop PSU hold", run: \(\) => psuHold\.close\(\)/);
  const socket = await readFile(new URL("../src/can/socket.ts", import.meta.url), "utf8");
  assert.match(socket, /createRawChannelWithOptions\(iface, \{ timestamps: true, non_block_send: true \}\)/);
  assert.match(socket, /createRawChannel\(iface, true\)/, "Existing command channel stays unchanged");
  console.log(
    "psu-hold: exact frame, cadence/no burst, 60 minute boundary, renewal, every stop, filters, gates, lease and production monotonic clock pass"
  );
}

function exactFrameAndCadence() {
  const fixture = psuFixture();
  try {
    assert.equal(fixture.hold.status().on, false);
    assert(fixture.act("start").ok);
    const channel = fixture.channels[0];
    assert.deepEqual(channel.filters, [{ id: 0x501, mask: 0x800007ff }]);
    assert.equal(channel.frames.length, 1);
    fixture.clock.advance(149);
    assert.equal(channel.frames.length, 1);
    fixture.clock.advance(1);
    assert.equal(channel.frames.length, 2);
    fixture.clock.advance(300);
    assert.equal(channel.frames.length, 4);
    fixture.clock.jump(2_000);
    assert.equal(channel.frames.length, 5, "A stall skips missed slots");
    fixture.clock.advance(149);
    assert.equal(channel.frames.length, 5);
    fixture.clock.advance(1);
    assert.equal(channel.frames.length, 6);
    // Fire the timer early, as sub-ms rounding can do on the actual Node timer.
    fixture.clock.current += 149;
    fixture.clock.fire();
    assert.equal(channel.frames.length, 6);
    fixture.clock.advance(1);
    assert.equal(channel.frames.length, 7);
    for (const frame of channel.frames) {
      assert.equal(frame.id, 0x500);
      assert.equal(frame.ext, false);
      assert.equal(frame.rtr, false);
      assert.equal(frame.data.length, 8);
      assert.deepEqual([...frame.data], [1, 0, 0, 0, 0, 0, 0, 0]);
    }
    const callback = fixture.clock.timers.find(timer => !timer.cancelled)?.callback;
    assert(callback);
    fixture.act("stop");
    callback();
    assert.equal(channel.frames.length, 7, "No new TX after stop, even from a stale timer");
    assert.equal(channel.stops, 1);
  } finally {
    fixture.hold.close();
  }
}

function expiryAndRenewal() {
  const fixture = psuFixture();
  try {
    fixture.act("start");
    fixture.clock.jump(3_599_999);
    assert(fixture.hold.status().on);
    assert.equal(fixture.hold.status().remainingMs, 1);
    const count = fixture.channels[0].frames.length;
    fixture.clock.advance(1);
    assert.equal(fixture.hold.status().on, false);
    assert.equal(fixture.hold.status().lastStopReason, "timeout");
    assert.equal(fixture.channels[0].frames.length, count);
    assert.equal(fixture.hold.status().remainingMs, 0);
    assert(!fixture.act("extend").ok);
    fixture.act("start");
    const revision = fixture.hold.status().revision;
    fixture.clock.jump(1_000);
    const before = fixture.hold.status().remainingMs;
    assert(!fixture.act("start").ok);
    assert.equal(fixture.hold.status().remainingMs, before, "Repeated On never renews");
    assert(fixture.hold.perform("extend", revision).ok);
    assert.equal(fixture.hold.status().remainingMs, 3_600_000);
    assert(!fixture.hold.perform("extend", revision).ok, "A replay cannot extend twice");
    fixture.clock.jump(3_600_001);
    assert.equal(fixture.hold.status().lastStopReason, "timeout");
  } finally {
    fixture.hold.close();
  }
  const fresh = psuFixture();
  try {
    assert.equal(fresh.hold.status().on, false);
    assert.equal(fresh.channels.length, 0);
  } finally {
    fresh.hold.close();
  }
}

function negativeGates() {
  const fixture = psuFixture();
  try {
    fixture.state.permitted = false;
    assert(!fixture.act("start").ok);
    assert.equal(fixture.channels.length, 0, "No channel or TX without permission");
    fixture.state.permitted = true;
    fixture.state.unavailable = "CAN unavailable";
    assert(!fixture.act("start").ok);
    assert.equal(fixture.channels.length, 0);
    fixture.state.unavailable = null;
    const lease = acquireBus("a synthetic operation");
    assert(lease.ok);
    try {
      assert(!fixture.act("start").ok);
      assert.equal(fixture.channels.length, 0);
    } finally {
      lease.lease.release();
    }
    assert(!fixture.hold.perform("start", 99).ok);
    assert.equal(fixture.channels.length, 0);
    fixture.act("start");
    const channel = fixture.channels[0];
    const acquired = acquireBus("a synthetic leased sender");
    assert(acquired.ok);
    try {
      assert.equal(fixture.hold.status().on, false, "Lease acquisition stops before its caller can send");
      assert.equal(channel.stops, 1);
      assert.equal(fixture.hold.status().lastStopReason, "bus-lease");
      fixture.clock.jump(500);
      assert.equal(channel.frames.length, 1);
    } finally {
      acquired.lease.release();
    }
    assert.equal(fixture.hold.status().on, false);
  } finally {
    fixture.hold.close();
  }
  const filtered = psuFixture({ filterFails: true });
  try {
    assert(!filtered.act("start").ok);
    assert.equal(filtered.channels[0].frames.length, 0);
    assert.equal(filtered.channels[0].messageListeners.length, 0);
    assert.equal(filtered.channels[0].stoppedListeners.length, 0);
    assert.equal(filtered.channels[0].stops, 1, "Failed RX filter closes the unobserved channel");
    assert.equal(filtered.hold.status().lastStopReason, "setup-failed");
  } finally {
    filtered.hold.close();
  }
}

function stopCauses() {
  for (const cause of ["owner", "service-shutdown", "can-down", "bus-off", "tx-errors", "permission"] as const) {
    const fixture = psuFixture();
    try {
      fixture.act("start");
      const channel = fixture.channels[0];
      if (cause === "owner") {
        fixture.act("stop");
      }
      if (cause === "service-shutdown") {
        fixture.hold.close();
      }
      if (cause === "can-down") {
        channel.emitStopped();
      }
      if (cause === "bus-off") {
        channel.emitMessage({ id: 0x40, err: true, data: Buffer.alloc(8) });
      }
      if (cause === "tx-errors") {
        channel.results = [-1, new Error("Synthetic TX error"), 0];
        fixture.clock.advance(450);
      }
      if (cause === "permission") {
        fixture.state.permitted = false;
        fixture.clock.advance(150);
      }
      assert.equal(fixture.hold.status().on, false, cause);
      assert.equal(fixture.hold.status().lastStopReason, cause);
      const count = channel.frames.length;
      fixture.hold.stop(cause);
      fixture.clock.jump(10_000);
      assert.equal(channel.frames.length, count);
      if (cause !== "can-down") {
        assert.equal(channel.stops, 1);
      }
    } finally {
      fixture.hold.close();
    }
  }
  const fixture = psuFixture();
  try {
    fixture.act("start");
    const old = fixture.channels[0];
    old.results = [-1, -1, 16, 8, 8, 16];
    fixture.clock.advance(900);
    assert(fixture.hold.status().on, "Success resets the consecutive error streak");
    fixture.state.unavailable = "CAN down";
    fixture.clock.advance(150);
    assert.equal(fixture.hold.status().lastStopReason, "can-down");
    fixture.state.unavailable = null;
    fixture.act("start");
    old.emitStopped();
    old.emitMessage({ id: 0x40, err: true, data: Buffer.alloc(8) });
    assert(fixture.hold.status().on, "Old channel callbacks cannot stop a new run");
    fixture.state.permitted = false;
    assert(fixture.act("stop").ok, "Off remains available if permission falls away");
  } finally {
    fixture.hold.close();
  }
}

function productionClock() {
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  const realWall = Date.now;
  const fixture = psuFixture({ productionClock: true });
  let wall = 10_000_000;
  Object.defineProperty(performance, "now", { configurable: true, value: fixture.clock.now });
  Date.now = () => wall;
  try {
    assert(fixture.act("start").ok);
    fixture.clock.advance(150);
    assert.equal(fixture.channels[0].frames.length, 2);
    wall += 86_400_000;
    fixture.clock.advance(150);
    assert(fixture.hold.status().on, "Wall-clock jump cannot end the hold early");
    assert.equal(fixture.channels[0].frames.length, 3);
    wall -= 172_800_000;
    fixture.clock.advance(150);
    assert.equal(fixture.channels[0].frames.length, 4, "Wall-clock reversal cannot stall pacing");
    fixture.clock.jump(3_600_000);
    assert.equal(fixture.hold.status().lastStopReason, "timeout", "Default production clock controls the hard limit");
  } finally {
    fixture.hold.close();
    Date.now = realWall;
    if (descriptor) {
      Object.defineProperty(performance, "now", descriptor);
    } else {
      Reflect.deleteProperty(performance, "now");
    }
  }
}

await checkPsuHold();
