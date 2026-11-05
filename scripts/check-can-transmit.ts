import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMainCanChannel } from "../src/can/channel-factory.ts";
import { CanTransmitError, transmitCanFrame } from "../src/can/transmit.ts";
import { createTransmitFailureLogger } from "../src/can/transmit-log.ts";
import { captureCanErrors, scriptedChannel } from "./can-transmit-fixtures.ts";
import { checkPollTransmits, checkDtcTransmits, checkElockTransmits } from "./can-transmit-reads.ts";
import { checkCommandTransmits, checkWriteSessionTransmits } from "./can-transmit-writes.ts";
import { checkMultiFrameTransmits, checkKwpTransmits } from "./can-transmit-kwp.ts";

await checkCanTransmits();

async function checkCanTransmits(): Promise<void> {
  await checkFactory();
  checkBoundary();
  checkLogLimiter();
  const captured = captureCanErrors();
  try {
    await checkPollTransmits(captured.messages);
    await checkDtcTransmits(captured.messages);
    await checkElockTransmits(captured.messages);
    await checkCommandTransmits();
    await checkMultiFrameTransmits();
    await checkKwpTransmits();
    await checkWriteSessionTransmits();
    assert(
      captured.messages.some(message => message.includes("returned -1")),
      "Native rejection must be logged"
    );
    assert(
      captured.messages.some(message => message.includes("Synthetic socket error")),
      "Thrown errors must be logged"
    );
  } finally {
    captured.restore();
  }
  console.log(
    "✓ Main CAN factory, exact native return, bounded polls, DTC recovery, commands, partial transfers and session cleanup"
  );
}

async function checkFactory(): Promise<void> {
  const fixture = scriptedChannel();
  let calls = 0;
  const channel = createMainCanChannel(
    {
      createRawChannelWithOptions(iface, options) {
        calls += 1;
        assert.equal(iface, "synthetic-can");
        assert.deepEqual(options, { timestamps: true, non_block_send: true });
        return fixture.channel;
      },
    },
    "synthetic-can"
  );
  assert.equal(channel, fixture.channel);
  assert.equal(calls, 1);
  const source = await readFile(new URL("../src/can/socket.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /return createMainCanChannel\(canModule, iface\)/,
    "The main socket must use the checked factory seam"
  );
  assert(!source.includes("createRawChannel("), "The main socket must not restore the blocking default factory");
}

function checkBoundary(): void {
  const frame = { id: 0x123, data: Buffer.alloc(8) };
  const healthy = scriptedChannel();
  assert.equal(transmitCanFrame(healthy.channel, frame), 16, "The native CAN_MTU is 16, independently of payload size");
  for (const rejected of [-1, 0, 8, 15, 17, Number.NaN]) {
    const fixture = scriptedChannel(() => rejected);
    assert.throws(() => transmitCanFrame(fixture.channel, frame), CanTransmitError, `Return ${rejected} must fail`);
    assert.equal(fixture.accepted.length, 0);
  }
  const exception = new Error("Synthetic socket error");
  assert.throws(
    () => transmitCanFrame(scriptedChannel(() => exception).channel, frame),
    error => error === exception
  );
  assert.throws(() => transmitCanFrame(healthy.channel, { ...frame, data: Buffer.alloc(9) }), CanTransmitError);
  assert.equal(healthy.attempted.length, 1, "Oversized data must be refused before entering the native addon");
}

function checkLogLimiter(): void {
  const captured = captureCanErrors();
  let monotonicTime = 100;
  const logFailure = createTransmitFailureLogger("synthetic", () => monotonicTime);
  try {
    logFailure("send failed", "first");
    for (let attempt = 0; attempt < 20; attempt++) {
      monotonicTime += 1;
      logFailure("send failed", "suppressed");
    }
    assert.equal(captured.messages.length, 1, "Repeated failures must not flood the journal");
    monotonicTime = 5100;
    logFailure("send failed", "next window");
    assert.equal(captured.messages.length, 2);
    assert.match(captured.messages[1], /20 transmit failures suppressed/);
    assert.match(captured.messages[1], /next window/);
  } finally {
    captured.restore();
  }
}
