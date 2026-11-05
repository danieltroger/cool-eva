import assert from "node:assert/strict";
import { startMultiFrameTransfer } from "../src/vcu/multiframe-transfer.ts";
import { createVcuKwpClient } from "../src/vcu/kwp-client.ts";
import { encodeMultiFrameRequestPayload } from "../src/vcu/multiframe-codec.ts";
import { simulateVcuMicros } from "./simulated-vcu-micro.ts";
import { delay, scriptedChannel } from "./can-transmit-fixtures.ts";

export async function checkMultiFrameTransmits(): Promise<void> {
  for (const failure of [-1, new Error("Synthetic socket error")]) {
    for (const failOnAttempt of [1, 2, 3]) {
      let attempts = 0;
      let accepted = 0;
      const transfer = startMultiFrameTransfer({
        target: "A8",
        requestPayload: encodeMultiFrameRequestPayload({ kind: "request-upload-freeze-frame-log" }),
        send() {
          attempts += 1;
          if (attempts === failOnAttempt) {
            if (failure instanceof Error) {
              throw failure;
            }
            return failure;
          }
          accepted += 1;
          return 16;
        },
        maxPayloadBytes: 256,
        firstReplyTimeoutMs: 50,
        transferTimeoutMs: 50,
        requestFlowControlTimeoutMs: 50,
      });
      if (failOnAttempt > 1) {
        transfer.handleFrame(Buffer.from([0xf1, 0x30, 0, 0, 0, 0, 0, 0]));
      }
      const outcome = await transfer.finished;
      assert.equal(
        outcome.kind,
        failOnAttempt === 1 ? "not-sent" : "abandoned",
        "A rejected consecutive frame must abandon the partial transfer"
      );
      assert.equal(accepted, failOnAttempt - 1);
      assert.equal(
        transfer.handleFrame(Buffer.from([0xf1, 3, 0x75, 0x12, 0xe9, 0, 0, 0])),
        false,
        "A late positive reply must not report a partial request as success"
      );
      await delay(60);
      assert.equal(attempts, failOnAttempt, "Failure must clear consecutive-frame pacing and timeout fallback");
    }
  }
  let attempts = 0;
  const transfer = startMultiFrameTransfer({
    target: "A8",
    requestPayload: encodeMultiFrameRequestPayload({ kind: "list-stored-dtcs" }),
    send: () => (++attempts === 1 ? 16 : -1),
    maxPayloadBytes: 256,
    firstReplyTimeoutMs: 50,
    transferTimeoutMs: 50,
    requestFlowControlTimeoutMs: 50,
  });
  transfer.handleFrame(Buffer.from([0xf1, 0x10, 8, 0x58, 1, 0, 1, 2]));
  assert.equal((await transfer.finished).kind, "abandoned", "Failed KWP reply flow control must abandon the exchange");
  assert.equal(transfer.handleFrame(Buffer.from([0xf1, 0x20, 3, 4, 5, 0, 0, 0])), false);
}

export async function checkKwpTransmits(): Promise<void> {
  for (const failure of [-1, new Error("Synthetic socket error")]) {
    const initial = scriptedChannel(() => failure);
    const refused = createVcuKwpClient(initial.channel, { paceMs: 0, responseTimeoutMs: 30 });
    try {
      assert.equal(await refused.openSession("A8"), false);
      assert.equal(initial.attempted.length, 1);
    } finally {
      refused.stop();
    }
  }

  const bus = simulateVcuMicros([
    { target: "A9", records: new Map([[258, Uint8Array.of(75)]]) },
    { target: "A8", records: new Map(), upload: { grantBody: Uint8Array.of(0x12, 0xe9), blocks: [] } },
  ]);
  const healthySend = bus.channel.send;
  let rejectRead = true;
  let rejectConsecutive = true;
  let reads = 0;
  let consecutiveAttempts = 0;
  bus.channel.send = frame => {
    if (frame.data[0] === 0xa9 && frame.data[2] === 0x22) {
      reads += 1;
      if (rejectRead) {
        return -1;
      }
    }
    if (frame.data[0] === 0xa8 && frame.data[1] >> 4 === 2) {
      consecutiveAttempts += 1;
      if (rejectConsecutive) {
        return -1;
      }
    }
    return healthySend(frame);
  };
  const client = createVcuKwpClient(bus.channel, { paceMs: 0, responseTimeoutMs: 80 });
  bus.channel.addListener("onMessage", frame => client.handleFrame(frame.id, frame.data));
  try {
    assert.equal((await client.readParameter("A9", 258)).status, "not-sent");
    assert.equal(reads, 1, "A KWP send rejection must be terminal, without a session reopen retry");
    rejectRead = false;
    assert.equal(
      (await client.readParameter("A9", 258)).status,
      "read",
      "A failed KWP read must release the pending slot"
    );
    const partial = await client.multiFrameRead("A8", { kind: "request-upload-freeze-frame-log" });
    assert.equal(partial.status, "abandoned");
    assert.equal(consecutiveAttempts, 1, "A failed consecutive frame must not be retried or followed by another");
    rejectConsecutive = false;
    assert.equal(await client.ping("A8"), true, "A partial transfer must release the client for cleanup");
  } finally {
    client.stop();
  }
}
