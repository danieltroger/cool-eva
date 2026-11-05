import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  syncBikeClock,
  sendChargeCommand,
  sendChargeStopCommand,
  readServiceStamp,
  writeParameters,
  type RunningWriteSession,
} from "../src/vcu/write-session.ts";
import { performChargeSocLimit, performChargeSocLimitRead } from "../src/vcu/charge-soc-limit.ts";
import { recordArrival } from "../src/can/signals.ts";
import { monotonicNow } from "../src/monotonic.ts";
import { planWrite } from "../src/vcu/write-targets.ts";
import { checkTableType } from "../src/vcu/param-table.ts";
import type { TableTypeReport } from "../src/vcu/snapshot.ts";
import { addressedReply, scriptedChannel } from "./can-transmit-fixtures.ts";

export async function checkCommandTransmits(): Promise<void> {
  for (const failure of [-1, new Error("Synthetic socket error")]) {
    const clock = scriptedChannel(() => failure);
    assert.equal(syncBikeClock(clock.channel, new Date("2026-01-02T03:04:05Z")).status, "failed");
    assert.equal(clock.attempted.length, 1);
    const stop = scriptedChannel(() => failure);
    assert.equal((await sendChargeStopCommand(stop.channel)).status, "failed");
    assert.equal(stop.attempted.length, 1);
    for (const failOnAttempt of [1, 2]) {
      const current = scriptedChannel((_frame, attempt) => (attempt === failOnAttempt ? failure : 16));
      assert.equal((await sendChargeCommand(current.channel, "dc", 40, 75)).status, "failed");
      assert.equal(current.accepted.length, failOnAttempt - 1);
      assert.equal(current.attempted.length, failOnAttempt, "Charge-current commands must not retry a rejected frame");
    }
  }
  const healthy = scriptedChannel();
  assert.equal(syncBikeClock(healthy.channel, new Date("2026-01-02T03:04:05Z")).status, "sent");
  assert.equal((await sendChargeStopCommand(healthy.channel)).status, "sent");
  assert.equal((await sendChargeCommand(healthy.channel, "dc", 40, 75)).status, "sent");
  assert.equal(healthy.accepted.length, 4);
  await checkSocLimitTransmits();
}

async function checkSocLimitTransmits(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-transmit-"));
  try {
    for (const failure of [-1, new Error("Synthetic socket error")]) {
      for (const failOnAttempt of [1, 2, 3]) {
        recordArrival("charge_soc_limit_pct", 0, Date.now(), monotonicNow() - 60_000);
        let readCount = 0;
        const fixture = scriptedChannel(
          (_frame, attempt) => (attempt === failOnAttempt ? failure : 16),
          frame => {
            if ((frame.data[0] & 0x80) === 0) {
              readCount += 1;
              recordArrival(
                "charge_soc_limit_pct",
                readCount === 1 && failOnAttempt !== 1 ? 75 : 80,
                Date.now(),
                monotonicNow()
              );
            }
          }
        );
        const result = await performChargeSocLimit({ directory }, 80, fixture.channel);
        if (failOnAttempt === 2) {
          assert.equal(result.ok, false, "A rejected SOC write must not be reported as sent or written");
          assert.equal(fixture.attempted.length, 2, "A rejected SOC write must not start a read-back");
        } else {
          assert(result.ok);
          assert.equal(
            result.result.status,
            failOnAttempt === 3 ? "unverified" : "written",
            "Failed read-back cannot turn a sent write into verified success"
          );
        }
      }
      const rejected = scriptedChannel(() => failure);
      assert.equal((await performChargeSocLimitRead({ directory }, rejected.channel)).ok, false);
      assert.equal(rejected.attempted.length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function checkWriteSessionTransmits(): Promise<void> {
  for (const failure of [-1, new Error("Synthetic socket error")]) {
    for (const failOnAttempt of [1, 2]) {
      let session: RunningWriteSession | null = null;
      const fixture = scriptedChannel(
        (_frame, attempt) => (attempt === failOnAttempt ? failure : 16),
        () => {
          queueMicrotask(() => session?.handleFrame(0x7e0, addressedReply([0x50, 0x81])));
        }
      );
      const running = readServiceStamp(fixture.channel, Date.now());
      session = running.session;
      const result = await running.finished;
      assert.equal(result.ok, false);
      assert.equal(fixture.attempted.length, failOnAttempt, "A rejected session exchange must end the operation");
      session.abort("synthetic cleanup");
    }
  }
  await checkRejectedBatchWrite();
}

async function checkRejectedBatchWrite(): Promise<void> {
  const planned = planWrite("MAX_DC_CHG_CURRENT", 80, 75);
  assert(planned.ok);
  const tableType: TableTypeReport = {
    verdicts: [checkTableType(276, 16407)!, checkTableType(277, 16407)!],
    confirmed: true,
    tableType: 16407,
    split: false,
    unread: [],
    unusable: [],
    mismatched: false,
    lines: ["Synthetic confirmed table"],
  };
  let session: RunningWriteSession | null = null;
  const fixture = scriptedChannel(
    frame => (frame.data[2] === 0x2e ? -1 : 16),
    frame => {
      const service = frame.data[2];
      const payload =
        service === 0x10
          ? [0x50, 0x81]
          : service === 0x22
            ? [0x62, frame.data[3], frame.data[4], 75]
            : frame.data[3] === 1
              ? [0x67, 1, 0, 0, 0, 1]
              : [0x67, 2, 0x34];
      queueMicrotask(() => session?.handleFrame(0x7e0, addressedReply(payload)));
    }
  );
  const running = writeParameters(fixture.channel, [planned.plan, planned.plan], tableType);
  session = running.session;
  const result = await running.finished;
  assert.equal(result.status, "ran");
  assert.equal(result.results[0].status, "failed");
  assert(result.results[0].status === "failed" && result.results[0].stage === "write");
  assert(
    result.results[1].status === "failed" && result.results[1].reason.includes("not attempted"),
    "A failed batch write must stop the remaining writes"
  );
  assert.equal(fixture.attempted.filter(frame => frame.data[2] === 0x2e).length, 1);
  assert.equal(fixture.attempted.at(-1)?.data[2], 0x2e, "No read-back or new command may follow the rejected write");
  session.abort("synthetic cleanup");
}
