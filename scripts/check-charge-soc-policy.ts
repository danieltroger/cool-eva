import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawChannel } from "socketcan";
import { decodeFrame } from "../src/can/decode.ts";
import { record } from "../src/can/signals.ts";
import { createVcuWriteRunner, type VcuWriteRunnerOptions } from "../src/vcu/write-runner.ts";
import { evaluateServiceGate, type ServiceGateReadings } from "../src/vcu/service-gate.ts";
import { acquireBus, busHeldBy } from "../src/vcu/bus-lease.ts";
import { handleVcuWriteEndpoint, type VcuWriteResponse } from "../src/http/vcu-write.ts";
import { handleMutationGuard } from "../src/http/mutation-guard.ts";

await checkSocPolicy();

async function checkSocPolicy() {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-soc-policy-"));
  let sent: number[] = [];
  let savedLimit = 0;
  const channel = {
    send(frame: { data: Buffer }) {
      sent.push(frame.data[0]);
      if (frame.data[0] === 0xac) {
        savedLimit = frame.data[2];
      }
      for (const decoded of decodeFrame(0x121, Buffer.from([0x2c, 0xff, savedLimit, 0, 0, 0, 0, 0]))) {
        record(decoded.key, decoded.value);
      }
      return 16;
    },
  } as unknown as RawChannel;
  let readings: ServiceGateReadings = {};
  const options: VcuWriteRunnerOptions = {
    enabled: true,
    busIsActive: true,
    directory,
    channel: () => channel,
    gate: () => evaluateServiceGate(readings),
    latestSweep: async () => null,
    holdPoller: async () => ({ release: () => {} }),
  };
  let runner = createVcuWriteRunner(options);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/vcu-write", "http://127.0.0.1");
    if (handleMutationGuard(request, response, url.pathname)) return;
    void handleVcuWriteEndpoint(request, response, url, { runner }).catch(error => {
      console.error("soc-policy: HTTP fixture failed", error);
      response.writeHead(500);
      response.end("Fixture failed");
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/vcu-write?list=0&`;
    for (const mode of ["drive", "moving"] as const) {
      readings = unsafeReadings(mode);
      const gate = evaluateServiceGate(readings);
      assert.equal(gate.safe, false, `${mode} fixture must actually be unsafe for other writes.`);
      if (mode === "drive") {
        assert.equal(readings.go?.value, 1);
        assert.equal(readings.energized?.value, 1);
      } else {
        assert.ok((readings.speed_can_kmh?.value ?? 0) > 1);
      }
      sent = [];
      const read = await post(base + "action=charge-soc-limit-read");
      assert.equal(read.status, 200, `${mode}: read is permitted.`);
      assert.equal(read.payload.result?.status, "read");
      assert.deepEqual(sent, [0x2c]);
      sent = [];
      const write = await post(base + "action=charge-soc-limit&pct=85&confirm=charge-soc-limit-85");
      assert.equal(write.status, 200, `${mode}: confirmed Set is permitted.`);
      assert.equal(write.payload.result?.status, "written");
      assert.deepEqual(sent, [0x2c, 0xac, 0x2c]);
      assert.equal(busHeldBy(), null, "The SOC operation releases its lease.");
      for (const request of [
        { kind: "parameter", name: "MAX_DC_CHG_CURRENT", value: 80, expectedCurrent: 75 },
        { kind: "reset-vcu" },
      ] as const) {
        sent = [];
        const answer = await runner.perform(request);
        assert.equal(answer.ok, false, `${mode}: ${request.kind} retains its bike-state gate.`);
        assert.deepEqual(sent, [], "The paired unsafe fixture must stop other writes before TX.");
      }
    }
    const validSet = base + "action=charge-soc-limit&pct=85&confirm=charge-soc-limit-85";
    const refusedHeaders: Record<string, string>[] = [
      { "Content-Type": "application/json" },
      { "X-Cool-Eva": "service-write" },
      { "Content-Type": "application/json", "X-Cool-Eva": "service-mode" },
    ];
    for (const headers of refusedHeaders) {
      sent = [];
      assert.equal((await fetch(validSet, { method: "POST", headers })).status, 403);
      assert.deepEqual(sent, [], "Both JSON and the service-write header remain required.");
    }
    for (const query of [
      "action=charge-soc-limit&pct=85",
      "action=charge-soc-limit&pct=85&confirm=charge-soc-limit-80",
      "action=charge-soc-limit&pct=101&confirm=charge-soc-limit-101",
      "action=charge-soc-limit&pct=0&confirm=charge-soc-limit-0",
    ]) {
      sent = [];
      assert.equal((await post(base + query)).status, 400);
      assert.deepEqual(sent, [], "Value-bound confirmation and range remain required.");
    }
    const lease = acquireBus("synthetic existing operation");
    assert(lease.ok);
    try {
      sent = [];
      assert.equal((await post(validSet)).status, 409);
      assert.deepEqual(sent, [], "SOC does not bypass the bus lease.");
    } finally {
      lease.lease.release();
    }
    for (const refusal of [{ enabled: false }, { busIsActive: false }, { channel: () => null }]) {
      runner.stop();
      runner = createVcuWriteRunner({ ...options, ...refusal });
      sent = [];
      assert.equal((await post(validSet)).status, 409);
      assert.deepEqual(sent, [], "Permission and active CAN gates remain required.");
    }
  } finally {
    runner.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
  console.log(
    "✓ SOC read/confirmed Set succeed in real unsafe drive/moving fixtures; parameter/reset, permission, JSON/header, lease, range and confirmation keep their gates"
  );
}

async function post(url: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cool-Eva": "service-write" },
  });
  return { status: response.status, payload: (await response.json()) as VcuWriteResponse };
}

function unsafeReadings(mode: "drive" | "moving"): ServiceGateReadings {
  const readings: ServiceGateReadings = {};
  const frames = [
    [0x102, mode === "drive" ? "000A004494FFD8FF" : "0002004494FFD8FF"],
    [0x104, mode === "moving" ? "75B102002205B242" : "A19A020000000000"],
  ] as const;
  for (const [id, hex] of frames) {
    for (const decoded of decodeFrame(id, Buffer.from(hex, "hex"))) {
      readings[decoded.key] = { value: decoded.value, ageMs: 0 };
    }
  }
  return readings;
}
