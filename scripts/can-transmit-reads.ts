import assert from "node:assert/strict";
import { handleResponse, initObd, pollPidNow, startObdPoller } from "../src/can/obd.ts";
import { handleTroubleCodeFrame, requestTroubleCodeList, troubleCodeTransferInFlight } from "../src/can/obd-dtc.ts";
import { handleElockResponse, readKeysPairedOnce } from "../src/can/elock.ts";
import { defineSignals, latestValue, type SignalDef } from "../src/can/signals.ts";
import { monotonicNow, since } from "../src/monotonic.ts";
import { delay, scriptedChannel, waitUntil } from "./can-transmit-fixtures.ts";

export async function checkPollTransmits(messages: string[]): Promise<void> {
  const attemptedAt: number[] = [];
  const fixture = scriptedChannel(() => {
    attemptedAt.push(monotonicNow());
    return -1;
  });
  const logStart = messages.length;
  initObd(fixture.channel);
  const stop = startObdPoller(80);
  try {
    await waitUntil(() => fixture.attempted.length >= 3, "three paced failed poll rounds");
  } finally {
    stop();
  }
  assert(
    fixture.attempted.every(frame => frame.data[1] === 1 && frame.data[2] === 0x0d),
    "Failed TX must skip the rest of each OBD round"
  );
  assert(
    attemptedAt[1] - attemptedAt[0] >= 60 && attemptedAt[2] - attemptedAt[1] >= 60,
    "Failed rounds must keep their timer pacing"
  );
  assert.equal(
    messages.slice(logStart).filter(message => message.startsWith("obd:")).length,
    1,
    "Recurring OBD failures must be rate limited"
  );
  const stoppedAtCount = fixture.attempted.length;
  await delay(100);
  assert.equal(fixture.attempted.length, stoppedAtCount, "Stopping must leave no next poll");
  for (const failure of [-1, new Error("Synthetic socket error")]) {
    assert.equal(await pollPidNow(scriptedChannel(() => failure).channel, 0x0d), null);
  }
  const healthy = scriptedChannel(
    () => 16,
    () => queueMicrotask(() => handleResponse(0x7e8, Buffer.from([3, 0x41, 0x0d, 42, 0, 0, 0, 0])))
  );
  const reply = await pollPidNow(healthy.channel, 0x0d);
  assert.equal(reply?.[0].value, 42, "A failed PID must release its pending slot for a later answer");
  await checkPollProcessingErrors(messages);
}

async function checkPollProcessingErrors(messages: string[]): Promise<void> {
  const speedSignal: SignalDef = { key: "speed_kmh", unit: "km/h", group: "obd", source: "poll" };
  let processingFailures = 0;
  defineSignals([
    {
      ...speedSignal,
      get deadband(): number {
        processingFailures += 1;
        throw new Error("Synthetic signal processing error");
      },
    },
  ]);
  const healthy = scriptedChannel(
    () => 16,
    () => queueMicrotask(() => handleResponse(0x7e8, Buffer.from([3, 0x41, 0x0d, 42, 0, 0, 0, 0])))
  );
  initObd(healthy.channel);
  const logStart = messages.length;
  const stop = startObdPoller(20);
  try {
    await waitUntil(() => processingFailures >= 2, "repeated signal processing failures after successful sends");
  } finally {
    stop();
    defineSignals([speedSignal]);
  }
  const failures = messages.slice(logStart).filter(message => message.includes("Synthetic signal processing error"));
  assert.equal(
    failures.length,
    processingFailures,
    "Non-transmit poll errors must not be suppressed by the transmit limiter"
  );
  assert(
    failures.every(message => message.startsWith("obd: poll error")),
    "Non-transmit poll errors must keep the poll-error label"
  );
  assert.equal(
    healthy.accepted.length,
    processingFailures,
    "The processing failures happen after accepted transmissions"
  );
  await delay(30);
}

export async function checkDtcTransmits(messages: string[]): Promise<void> {
  const logStart = messages.length;
  for (const failure of [-1, new Error("Synthetic socket error")]) {
    const fixture = scriptedChannel(() => failure);
    const result = await requestTroubleCodeList(fixture.channel, 3);
    assert.equal(result.outcome, "not-sent");
    assert.equal(fixture.attempted.length, 1, "An initial rejection must not retry");
    assert(!troubleCodeTransferInFlight());
  }
  const requestTimes: number[] = [];
  let flowControls = 0;
  const recovering = scriptedChannel(
    frame => {
      if (frame.id !== 0x7df && ++flowControls === 1) {
        return -1;
      }
      return 16;
    },
    frame => {
      if (frame.id === 0x7df) {
        requestTimes.push(monotonicNow());
        queueMicrotask(() => handleTroubleCodeFrame(0x7e8, Buffer.from([0x10, 8, 0x43, 3, 1, 1, 1, 2])));
      } else {
        queueMicrotask(() => handleTroubleCodeFrame(0x7e8, Buffer.from([0x21, 1, 3, 0, 0, 0, 0, 0])));
      }
    }
  );
  const recovered = await requestTroubleCodeList(recovering.channel, 3);
  assert.equal(recovered.outcome, "answered", "Failed DTC flow control must retain the idempotent read retry");
  assert.equal(requestTimes.length, 2);
  assert(requestTimes[1] - requestTimes[0] >= 100, "DTC recovery must retain its 120 ms retry gap");
  assert.equal(flowControls, 2);
  assert(!troubleCodeTransferInFlight());

  let attempts = 0;
  const capped = scriptedChannel(
    frame => (frame.id === 0x7df ? 16 : -1),
    frame => {
      if (frame.id === 0x7df) {
        attempts += 1;
        queueMicrotask(() => handleTroubleCodeFrame(0x7e8, Buffer.from([0x10, 8, 0x43, 3, 1, 1, 1, 2])));
      }
    }
  );
  const startedAt = monotonicNow();
  const failed = await requestTroubleCodeList(capped.channel, 3);
  assert.equal(failed.outcome, "truncated");
  assert(failed.outcome === "truncated");
  assert.match(
    failed.reason,
    /returned -1/,
    "A flow-control failure must retain its cause rather than disappear into a timeout"
  );
  assert.equal(attempts, 5, "DTC flow-control failures must retain the four-retry cap");
  assert(since(startedAt) >= 400, "Capped retries must remain timer paced");
  assert(!troubleCodeTransferInFlight());
  assert.equal(
    handleTroubleCodeFrame(0x7e8, Buffer.from([0x21, 1, 3, 0, 0, 0, 0, 0])),
    false,
    "Late frames must not revive a failed read"
  );
  assert.equal(
    messages.slice(logStart).filter(message => message.startsWith("obd-dtc:")).length,
    1,
    "DTC transmit errors share a bounded logger"
  );
}

export async function checkElockTransmits(messages: string[]): Promise<void> {
  for (const failure of [-1, new Error("Synthetic socket error")]) {
    const fixture = scriptedChannel(() => failure);
    const logStart = messages.length;
    await readKeysPairedOnce(fixture.channel);
    assert.equal(fixture.accepted.length, 0);
    assert.equal(fixture.attempted.length, 2, "E-LOCK's existing one-time session fallback stays bounded");
    assert(
      messages.slice(logStart).some(message => message.startsWith("elock: send failed")),
      "E-LOCK must log rejection"
    );
  }
  const healthy = scriptedChannel(
    () => 16,
    () => queueMicrotask(() => handleElockResponse(Buffer.from([3, 0x61, 0x99, 2, 0, 0, 0, 0])))
  );
  await readKeysPairedOnce(healthy.channel);
  assert.equal(latestValue("keys_paired"), 2, "A failed E-LOCK request must leave no stale response slot");
  assert.equal(healthy.attempted.length, 1);
}
