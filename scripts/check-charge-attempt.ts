import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RawChannel } from "socketcan";
import { record } from "../src/can/signals.ts";
import { createVcuWriteRunner } from "../src/vcu/write-runner.ts";
import { evaluateServiceGate } from "../src/vcu/service-gate.ts";
import { handleVcuWriteEndpoint, type VcuWriteResponse } from "../src/http/vcu-write.ts";

await checkChargeAttempt();

async function checkChargeAttempt() {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-charge-attempt-"));
  let channelAvailable = false;
  let attempts = 0;
  let sent = 0;
  let failOnAttempt = 2;
  let rejectWithReturn = false;
  let throwBeforeSend = false;
  const channel = {
    send() {
      attempts++;
      if (attempts === failOnAttempt) {
        if (rejectWithReturn) {
          return -1;
        }
        throw new Error("Synthetic charge-frame transmission failure");
      }
      sent++;
      return 16;
    },
  } as unknown as RawChannel;
  const runner = createVcuWriteRunner({
    enabled: true,
    busIsActive: true,
    directory,
    onChargeCurrentOutgoing: () => {
      if (throwBeforeSend) {
        throw new Error("Synthetic action exception");
      }
    },
    channel: () => (channelAvailable ? channel : null),
    gate: () => evaluateServiceGate({}),
    latestSweep: async () => null,
    holdPoller: async () => ({ release: () => {} }),
  });
  const server = createServer((request, response) => {
    void handleVcuWriteEndpoint(request, response, new URL(request.url ?? "/vcu-write", "http://127.0.0.1"), {
      runner,
    }).catch(error => {
      console.error("charge-attempt: HTTP fixture failed", error);
      response.writeHead(500);
      response.end("Fixture failed");
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const url = `http://127.0.0.1:${address.port}/vcu-write?list=0&action=charge-current&amps=40&confirm=charge-current-40`;
    const refused = await post(url);
    assert.equal(
      refused.chargeCurrentAttempt,
      "not-sent",
      "A pre-send gate refusal must report that nothing was sent."
    );
    assert.equal(refused.result, null);
    assert.equal(attempts, 0);
    channelAvailable = true;
    record("charge_manager_state", 35);
    record("fast_dc_limit_max_a", 75);
    const partial = await post(url);
    assert.equal(sent, 1, "The first frame really reached the stand-in channel.");
    assert.equal(attempts, 2);
    assert.equal(partial.result, null);
    assert.equal(partial.chargeCurrentAttempt, "unknown", "A second-frame failure must never be reported as not sent.");
    attempts = 0;
    sent = 0;
    failOnAttempt = 1;
    const firstFailure = await post(url);
    assert.equal(
      firstFailure.chargeCurrentAttempt,
      "unknown",
      "A failed sender stays conservative even without a completed frame."
    );
    assert.equal(sent, 0);
    rejectWithReturn = true;
    for (const rejectedAttempt of [1, 2]) {
      attempts = 0;
      sent = 0;
      failOnAttempt = rejectedAttempt;
      const rejected = await post(url);
      assert.equal(rejected.result, null);
      assert.equal(
        rejected.chargeCurrentAttempt,
        "unknown",
        "Native rejection keeps the existing conservative sender-failure result."
      );
      assert.equal(sent, rejectedAttempt - 1);
      assert.equal(attempts, rejectedAttempt, "A refused command frame must never be retried.");
    }
    rejectWithReturn = false;
    attempts = 0;
    throwBeforeSend = true;
    const actionFailure = await post(url);
    assert.equal(
      actionFailure.chargeCurrentAttempt,
      "unknown",
      "An action exception cannot become a definite pre-send refusal."
    );
    assert.equal(attempts, 0);
    throwBeforeSend = false;
    record("fast_dc_limit_max_a", 35);
    const rangeRefusal = await post(url);
    assert.equal(rangeRefusal.chargeCurrentAttempt, "not-sent");
    assert.equal(attempts, 0, "Range checks still happen before every frame.");
    const malformed = await post(url.replace("amps=40&", "amps=0&"));
    assert.equal(malformed.chargeCurrentAttempt, "not-sent");
    assert.equal(attempts, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
  console.log(
    "✓ Real charge-current HTTP: pre-send refusal sends zero frames; partial/failed sends remain uncertain; range/parse guards still send nothing"
  );
}

async function post(url: string): Promise<VcuWriteResponse> {
  const response = await fetch(url, { method: "POST", headers: { "X-Cool-Eva": "service-write" } });
  return (await response.json()) as VcuWriteResponse;
}
