import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVcuWriteRunner, type VcuWriteStatus, type ServiceWriteResult } from "../src/vcu/write-runner.ts";
import { serviceCatalogue, type ServiceCatalogue } from "../src/http/service-catalogue.ts";
import type { VcuWriteResponse } from "../src/http/vcu-write.ts";
import type { VcuProbeResponse } from "../src/http/vcu-probe.ts";
import type { VcuReadResponse } from "../src/http/vcu-read.ts";
import { serviceParameterFixtures } from "./preview-service-parameters.ts";

export async function createServiceClientFixture() {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-service-client-"));
  const parameters = serviceParameterFixtures();
  assert.ok(parameters.params.state === "snapshot");
  const saved = parameters.params;
  const gate = { safe: true, blockers: [], checks: [], chargingEvidence: null };
  const runner = createVcuWriteRunner({
    channel: () => null,
    busIsActive: false,
    enabled: true,
    directory,
    gate: () => gate,
    latestSweep: async () => ({ snapshot: saved.snapshot, report: saved.tableType }),
    holdPoller: async () => null,
  });
  const status = await runner.status({ detailFor: null, includeList: false });
  status.clock = { trustworthy: true, iso: "2026-01-01T12:00:00.000Z", offsetFromGpsSeconds: 0 };
  const fixture: ServiceClientFixture = {
    catalogue: serviceCatalogue(),
    status,
    parameters,
    requests: [],
    postMode: "success",
    probeMode: "success",
    statusFailure: false,
    catalogueFailure: false,
    catalogueDelay: null,
    allowBatch: false,
    statusDelay: null,
    postDelay: null,
    probeDelay: null,
    clearVerdict: "erased",
    readEnabled: false,
    confirmedTableGate: status.tableGate,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => respondToService(fixture, String(input), options);
  return {
    fixture,
    async close() {
      globalThis.fetch = originalFetch;
      runner.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export interface ServiceClientFixture {
  catalogue: ServiceCatalogue;
  status: VcuWriteStatus;
  parameters: ReturnType<typeof serviceParameterFixtures>;
  requests: { url: URL; method: string; header: string | null }[];
  postMode: "success" | "refused" | "transport" | "mismatch" | "missing";
  probeMode: "success" | "wrong-identity" | "refused" | "fractional";
  statusFailure: boolean;
  catalogueFailure: boolean;
  catalogueDelay: Promise<void> | null;
  allowBatch: boolean;
  statusDelay: Promise<void> | null;
  postDelay: Promise<void> | null;
  probeDelay: Promise<void> | null;
  clearVerdict: "erased" | "unproven";
  readEnabled: boolean;
  confirmedTableGate: VcuWriteStatus["tableGate"];
}

async function respondToService(
  fixture: ServiceClientFixture,
  input: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = new URL(input, "http://fixture.invalid");
  const method = options.method ?? "GET";
  const header = new Headers(options.headers).get("x-cool-eva");
  fixture.requests.push({ url, method, header });
  if (url.pathname === "/service-catalogue") {
    const payload = structuredClone(fixture.catalogue);
    if (fixture.catalogueDelay) {
      await fixture.catalogueDelay;
    }
    return jsonReply(payload, fixture.catalogueFailure ? 503 : 200);
  }
  if (url.pathname === "/vcu-params") return jsonReply(fixture.parameters.params);
  if (url.pathname === "/vcu-read") {
    if (method === "POST") {
      assert.equal(header, "service-mode");
      fixture.status.tableGate = fixture.confirmedTableGate;
    }
    const body: VcuReadResponse = {
      enabled: fixture.readEnabled,
      gate: fixture.status.gate,
      run: { phase: "idle" },
      export: { rows: 277, readAt: Date.UTC(2026, 0, 1), complete: true },
      message: null,
    };
    return jsonReply(body);
  }
  if (url.pathname === "/vcu-probe") {
    assert.equal(method, "POST");
    assert.equal(header, "service-mode");
    const answer = fixture.parameters.probes[url.searchParams.get("index") ?? ""];
    assert.ok(answer);
    assert.equal(url.searchParams.get("target"), answer.target);
    assert.equal(url.searchParams.get("bank"), "1");
    if (fixture.probeDelay) {
      await fixture.probeDelay;
    }
    const body: VcuProbeResponse = {
      reading:
        fixture.probeMode === "refused"
          ? null
          : {
              ...answer,
              name: fixture.probeMode === "wrong-identity" ? "FOREIGN_PARAMETER" : answer.name,
              value: fixture.probeMode === "fractional" ? 1.5 : answer.value,
            },
      message: null,
      gate: fixture.status.gate,
      targets: fixture.parameters.targets,
    };
    return jsonReply(body, fixture.probeMode === "refused" ? 409 : 200);
  }
  assert.equal(url.pathname, "/vcu-write");
  if (method === "GET") {
    const body = JSON.stringify({
      status: structuredClone(fixture.status),
      result: null,
      message: null,
    } satisfies VcuWriteResponse);
    if (fixture.statusDelay) {
      await fixture.statusDelay;
    }
    return new Response(body, {
      status: fixture.statusFailure ? 503 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  assert.equal(method, "POST");
  assert.equal(header, "service-write");
  if (fixture.postDelay) {
    await fixture.postDelay;
  }
  if (fixture.postMode === "transport") {
    throw new Error("synthetic lost response");
  }
  if (fixture.postMode === "refused")
    return jsonReply(
      { status: fixture.status, result: null, message: "Synthetic refusal" } satisfies VcuWriteResponse,
      409
    );
  const action = url.searchParams.get("action");
  if (action === "parameters") {
    assert.ok(fixture.allowBatch, "Only the fixed lights action may use the existing multi-parameter endpoint.");
    const writes = url.searchParams.getAll("w").map(entry => {
      const [name, wanted, expected] = entry.split(":");
      const reading = Object.values(fixture.parameters.probes).find(reading => reading.name === name);
      assert.ok(reading);
      assert.equal(reading.value, Number(expected));
      reading.value = Number(wanted);
      return {
        name,
        status: "written",
        message: "Synthetic light readback",
        succeeded: true,
        onBike: fixture.postMode === "missing" ? null : { name, value: Number(wanted), rawHex: null },
      };
    });
    return jsonReply({
      status: fixture.status,
      result: { action: "parameter-write", status: "written", succeeded: true, message: "Synthetic lights", writes },
      message: null,
    } satisfies VcuWriteResponse);
  }
  if (action !== "parameter") {
    assert.ok(["sync-clock", "set-service-point", "clear-dtcs", "reset-vcu"].includes(action ?? ""));
    const result: ServiceWriteResult =
      action === "clear-dtcs"
        ? {
            action: "clear-dtcs",
            status: "cleared",
            succeeded: true,
            message: "Synthetic clear result",
            clear: {
              storedBefore: 2,
              storedAfter: 0,
              distSinceClearBeforeKm: 10,
              distSinceClearAfterKm: 0,
              listedAfter: 0,
              verdict: fixture.clearVerdict,
            },
          }
        : {
            action: action === "sync-clock" ? "rtc-sync" : action === "reset-vcu" ? "reset-vcu" : "set-service-point",
            status: action === "sync-clock" ? "sent" : action === "reset-vcu" ? "reset" : "started",
            succeeded: true,
            message: "Synthetic service result",
            stamp: action === "set-service-point" ? { before: null, after: fixture.parameters.stamp } : undefined,
          };
    return jsonReply({ status: fixture.status, result, message: null } satisfies VcuWriteResponse);
  }
  const name = url.searchParams.get("name");
  const parameter = fixture.catalogue.parameters.find(parameter => parameter.name === name);
  assert.ok(parameter?.writable);
  const reading = fixture.parameters.probes[String(parameter.index)];
  const value = Number(url.searchParams.get("value"));
  assert.equal(Number(url.searchParams.get("expected")), reading.value);
  assert.ok(Number.isSafeInteger(value) && value >= parameter.minimum && value <= parameter.maximum);
  const confirmed = fixture.postMode === "success";
  const actual = fixture.postMode === "mismatch" ? value + 1 : value;
  reading.value = actual;
  const result: ServiceWriteResult = {
    action: "parameter-write",
    status: confirmed || fixture.postMode === "missing" ? "written" : "read-back-mismatch",
    message: "Synthetic readback",
    succeeded: confirmed || fixture.postMode === "missing",
    onBike: fixture.postMode === "missing" ? null : { name: parameter.name, value: actual, rawHex: null },
  };
  return jsonReply({ status: fixture.status, result, message: null } satisfies VcuWriteResponse);
}

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
