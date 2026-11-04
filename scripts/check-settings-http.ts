import assert from "assert/strict";
import { createServer } from "http";
import { setTimeout as delay } from "timers/promises";
import { busHeldBy } from "../src/vcu/bus-lease.ts";
import { once } from "events";
import { generateKeyPair } from "crypto";
import { readFile } from "fs/promises";
import { promisify } from "util";
import { startSettings } from "../src/settings/startup.ts";
import { createSettingsRestart } from "../src/settings/restart.ts";
import { handleSettingsEndpoint } from "../src/http/settings.ts";
import type { SettingsReply, SettingsActionReply } from "../src/settings/view.ts";
import { closeSettingsFixture, settingsFixture } from "./settings-check-fixtures.ts";

const fixture = await settingsFixture();
const runtime = await startSettings({
  codeDirectory: fixture.directory,
  workingDirectory: fixture.directory,
  environment: {},
  paths: fixture.paths,
  lock: fixture.lock,
  isLegacyInstallation: async () => false,
});
let scheduled = 0;
let scans = 0;
let drains = 0;
let finishDrain: () => void = () => {
  throw new Error("Drain not started");
};
const drainDone = new Promise<void>(resolve => {
  finishDrain = resolve;
});
const restart = createSettingsRestart({
  store: runtime.store,
  motionBlockers: () => [],
  schedule: async () => {
    scheduled += 1;
  },
  stopTimeoutMs: 5_000,
});
const context = {
  runtime,
  restart,
  codeDirectory: fixture.directory,
  scanHubs: async () => {
    scans += 1;
    return [{ name: "Synthetic Energica", address: "02:00:00:00:00:01" }];
  },
  drainBluetooth: async () => {
    drains += 1;
    await drainDone;
  },
};
const server = createServer((req, res) => {
  void handleSettingsEndpoint(req, res, new URL(req.url!, "http://localhost").pathname, context);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const jsonHeaders = { "X-Cool-Eva": "settings", "Content-Type": "application/json" };
try {
  const first = await read();
  assert.equal(first.active.coolantProbesEnabled, false);
  assert.equal(first.source, "fresh");
  assert.equal(first.revision, 0);
  const rejectedHeaders: Record<string, string>[] = [
    {},
    { "Content-Type": "application/json" },
    { "X-Cool-Eva": "settings", "Content-Type": "text/plain" },
  ];
  for (const headers of rejectedHeaders) {
    const response = await fetch(base + "/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ revision: 0, changes: { radiatorFanEnabled: true } }),
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { csrfRefusal: boolean }).csrfRefusal, true);
    assert.equal((await read()).revision, 0);
  }
  assert.equal((await fetch(base + "/settings/hub-candidates")).status, 405);
  assert.equal(scans, 0);
  assert.equal((await send("/settings/hub-candidates", "POST", {})).status, 200);
  assert.equal(scans, 1);
  for (const changes of [
    { coolantProbesEnabled: "true" },
    { unknown: "synthetic" },
    { rideLogDirectory: "" },
    { rideLogDirectory: "/tmp/synthetic-new-recordings" },
    { rideLogDirectory: fixture.directory },
    { dashboardBluetoothSecret: "guessable" },
  ]) {
    assert.equal((await send("/settings", "PATCH", { revision: 0, changes })).status, 409);
  }
  const secret = "a1".repeat(32);
  const before = await readFile(fixture.paths.settingsFile);
  const malformed = await fetch(base + "/settings", {
    method: "PATCH",
    headers: jsonHeaders,
    body: `{"syntheticCredential":"${secret}", bad-json`,
  });
  assert.equal(malformed.status, 409);
  assert.equal((await malformed.text()).includes(secret), false);
  assert.deepEqual(await readFile(fixture.paths.settingsFile), before);
  const { publicKey, privateKey } = await promisify(generateKeyPair)("x25519");
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  assert.equal(
    (await send("/settings", "PATCH", { revision: 0, changes: { rideLogPublicKeyPem: privatePem } })).status,
    409
  );
  assert.deepEqual(await readFile(fixture.paths.settingsFile), before);
  const saved = await send("/settings", "PATCH", {
    revision: 0,
    changes: {
      rideLogPublicKeyPem: "\ufeff\nSynthetic header\n" + publicPem,
      dashboardBluetoothSecret: secret,
      coolantProbesEnabled: true,
    },
  });
  assert.equal(saved.status, 200);
  const result = (await saved.json()) as SettingsActionReply;
  assert.match(result.message, /Saved. Applies after restart/);
  const view = result.settings!;
  assert.equal(view.active.coolantProbesEnabled, false);
  assert.equal(view.saved.coolantProbesEnabled, true);
  assert.ok(view.pending.includes("coolantProbesEnabled"));
  assert.ok(view.saved.bluetoothCodeId);
  const stored = JSON.parse(await readFile(fixture.paths.settingsFile, "utf-8"));
  assert.equal(stored.values.rideLogPublicKeyPem, publicPem);
  const readback = JSON.stringify(await read());
  assert.equal(readback.includes(secret), false);
  assert.equal(readback.includes("BEGIN PUBLIC KEY"), false);
  assert.equal(readback.includes("PRIVATE KEY"), false);
  assert.equal((await send("/settings", "PATCH", { revision: 0, changes: { radiatorFanEnabled: true } })).status, 409);
  const tunnelHeaders = { ...jsonHeaders, "X-Cool-Eva-Tunnel": "1" };
  const refused = await fetch(base + "/settings/apply", {
    method: "POST",
    headers: tunnelHeaders,
    body: JSON.stringify({ expectedGeneration: restart.generation, revision: 1 }),
  });
  assert.equal(refused.status, 409);
  assert.equal(scheduled, 0);
  const oldProcess = await send("/settings/apply", "POST", { expectedGeneration: "earlier-process", revision: 0 });
  assert.equal(oldProcess.status, 200);
  assert.equal(scheduled, 0);
  assert.equal(
    (
      await fetch(base + "/settings/apply", {
        method: "POST",
        headers: tunnelHeaders,
        body: JSON.stringify({
          expectedGeneration: restart.generation,
          revision: 1,
          bluetoothCodeId: view.saved.bluetoothCodeId,
        }),
      })
    ).status,
    200
  );
  for (let attempt = 0; attempt < 30 && drains === 0; attempt += 1) {
    await delay(5);
  }
  assert.equal(drains, 1, "A BLE restart actually waits for its output drain.");
  assert.equal(scheduled, 0);
  assert.ok(busHeldBy());
  finishDrain();
  await delay(10);
  assert.equal(scheduled, 1);
  assert.equal((await send("/settings", "PATCH", { revision: 1, changes: { radiatorFanEnabled: true } })).status, 409);
  console.log(
    "  header/method/content-type guards, private-key rejection, canonical public-key save, redacted GET, stale revision, Bluetooth handover and process-generation idempotence"
  );
} finally {
  finishDrain();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await restart.close();
  await closeSettingsFixture(fixture);
}
console.log("settings HTTP checks passed");

function send(path: string, method: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(base + path, { method, headers: jsonHeaders, body: JSON.stringify(body) });
}
async function read(): Promise<SettingsReply> {
  return (await (await fetch(base + "/settings")).json()) as SettingsReply;
}
