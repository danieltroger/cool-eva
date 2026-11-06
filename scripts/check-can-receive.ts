import assert from "node:assert/strict";
import type { CanMessage, RawChannel } from "socketcan";
import { STREAM_IDS } from "../src/can/decode.ts";
import { ELOCK_RESP_ID, readKeysPairedOnce } from "../src/can/elock.ts";
import { GPS_CAN_ID } from "../src/can/gps.ts";
import { CAN_RX_FILTERS, receiveCanFrame, type ReceiveContext } from "../src/can/receive.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, latestValue } from "../src/can/signals.ts";
import { configureGpsClock } from "../src/gps/clock.ts";
import { syntheticGpsFrames } from "./simulator-fixture.ts";

export async function checkCanReceive(): Promise<void> {
  defineSignals(SIGNALS);
  assert.deepEqual(
    CAN_RX_FILTERS,
    [...STREAM_IDS.map(id => ({ id, mask: 0x7ff })), { id: 0x7e0, mask: 0x7f0 }, { id: ELOCK_RESP_ID, mask: 0x7ff }],
    "The live filters retain the broadcast, OBD and ELOCK entries in order"
  );
  const calls: string[] = [];
  let consumer: "read" | "write" | null = "read";
  const message: CanMessage = {
    id: 0x7e8,
    data: Buffer.from([3, 0x41, 0x0d, 42, 0, 0, 0, 0]),
    ts_sec: 1_800_000_000,
    ts_usec: 123_456,
  };
  const context: ReceiveContext = {
    noteTraffic: () => calls.push("traffic"),
    readRunner: {
      handleCanFrame: (id, data, arrival) => {
        calls.push("read");
        assert.equal(id, message.id);
        assert.equal(data, message.data);
        assert.deepEqual(
          arrival,
          { seconds: message.ts_sec, microseconds: message.ts_usec },
          "The read runner receives the kernel arrival timestamp"
        );
        return consumer === "read";
      },
    },
    writeRunner: {
      handleCanFrame: (id, data) => {
        calls.push("write");
        assert.equal(id, message.id);
        assert.equal(data, message.data);
        return consumer === "write";
      },
    },
    obdResponse: (id, data) => {
      calls.push("obd");
      assert.equal(id, message.id);
      assert.equal(data, message.data);
    },
  };
  receiveCanFrame(message, context);
  assert.deepEqual(calls.splice(0), ["traffic", "read"], "A read consumes before the write and OBD handlers");
  consumer = "write";
  receiveCanFrame(message, context);
  assert.deepEqual(calls.splice(0), ["traffic", "read", "write"], "A write consumes before the OBD handler");
  consumer = null;
  receiveCanFrame(message, context);
  assert.deepEqual(calls.splice(0), ["traffic", "read", "write", "obd"], "Unconsumed OBD reaches its live handler");

  await checkElock(context);
  assert.deepEqual(calls.splice(0), ["traffic"], "ELOCK is traffic but never OBD");
  receiveCanFrame({ id: GPS_CAN_ID, data: Buffer.from([0x19, 0xff, 44, 0, 0, 0, 0, 0]) }, context);
  assert.equal(latestValue("dtc_list_count"), 1, "0x410 reaches the hub diagnostic mirror");
  receiveCanFrame({ id: GPS_CAN_ID, data: Buffer.from([3, 0xff, 0, 0, 0, 0, 0, 0]) }, context);
  assert.equal(latestValue("dash_speed_kmh"), 0, "0x410 still reaches broadcast decoding after the hub mirror");
  assert.deepEqual(calls.splice(0), ["traffic", "traffic"]);
  receiveCanFrame({ id: 0x104, data: Buffer.alloc(7) }, context);
  receiveCanFrame({ id: 0x7ff, data: Buffer.alloc(8) }, context);
  assert.deepEqual(calls, [], "Only full recognised frames count as motorcycle traffic");

  await checkGpsClock(context);
  console.log("✓ live CAN RX: runner priority, OBD fallback, ELOCK, hub/decode fan-out, GPS clock spy and filters");
}

async function checkElock(context: ReceiveContext): Promise<void> {
  const channel: RawChannel = {
    send: message => {
      assert.equal(message.id, 0x791);
      assert.deepEqual([...message.data], [2, 0x21, 0x99, 0, 0, 0, 0, 0]);
      receiveCanFrame({ id: ELOCK_RESP_ID, data: Buffer.from([3, 0x61, 0x99, 2, 0, 0, 0, 0]) }, context);
      return 16;
    },
    addListener: unexpectedSocketCall,
    start: unexpectedSocketCall,
    stop: unexpectedSocketCall,
    setRxFilters: unexpectedSocketCall,
    disableLoopback: unexpectedSocketCall,
  };
  await readKeysPairedOnce(channel);
  assert.equal(latestValue("keys_paired"), 2, "ELOCK reply reaches the pending startup read");
}

async function checkGpsClock(context: ReceiveContext): Promise<void> {
  let elapsedSeconds = 0;
  const commands: { command: string; arguments: string[] }[] = [];
  configureGpsClock({
    now: () => elapsedSeconds * 1_000,
    wallTimeSeconds: () => Date.UTC(2026, 0, 1) / 1_000 + elapsedSeconds,
    userId: () => 0,
    run: async (command, arguments_) => {
      commands.push({ command, arguments: arguments_ });
    },
  });
  try {
    for (; elapsedSeconds < 5; elapsedSeconds += 1) {
      for (const data of syntheticGpsFrames(elapsedSeconds)) {
        receiveCanFrame({ id: GPS_CAN_ID, data: Buffer.from(data) }, context);
      }
    }
    await Promise.resolve();
    assert.equal(latestValue("gps_epoch_s"), Date.UTC(2030, 0, 1, 12, 0, 4) / 1_000);
    assert.deepEqual(
      commands,
      [{ command: "date", arguments: ["-u", "-s", `@${Date.UTC(2030, 0, 1, 12, 0, 4) / 1_000}`] }],
      "GPS UTC reaches the live clock command spy"
    );
  } finally {
    configureGpsClock({ externalClock: true });
  }
}

function unexpectedSocketCall(): never {
  throw new Error("The RX fixture must never start or configure a real socket");
}

await checkCanReceive();
