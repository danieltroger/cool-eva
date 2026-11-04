import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { handleBundleStop } from "../src/http/bundle-stop.ts";
import { handleBundleUpdate } from "../src/http/bundle-update.ts";
import { settingsReply, type SettingsHttpContext } from "../src/http/settings.ts";
import { readUpdateStatus } from "../src/release/update-status.ts";
import { createSettingsRestart } from "../src/settings/restart.ts";
import { startSettings } from "../src/settings/startup.ts";
import { acquireBus, busHeldBy } from "../src/vcu/bus-lease.ts";
import { recordingResponse } from "./recording-response.ts";
import { closeSettingsFixture, settingsFixture } from "./settings-check-fixtures.ts";
import {
  createUpdateFixture,
  invokeUpdater,
  publishFixtureRelease,
  readState,
  REPOSITORY,
} from "./update-check/fixture.ts";

export async function checkBundleStop(): Promise<void> {
  const parent = join(REPOSITORY, ".preview-shots");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "bundle-stop-"));
  const fixture = await createUpdateFixture(directory);
  const storage = await settingsFixture(directory);
  const runtime = await startSettings({
    codeDirectory: storage.directory,
    workingDirectory: storage.directory,
    environment: {},
    paths: storage.paths,
    lock: storage.lock,
    isLegacyInstallation: async () => false,
  });
  let moving = false;
  const restart = createSettingsRestart({
    store: runtime.store,
    motionBlockers: () => (moving ? ["synthetic movement"] : []),
    schedule: async () => {
      throw new Error("The shell owns the stop; do not schedule another restart");
    },
  });
  let context: SettingsHttpContext = {
    runtime,
    restart,
    codeDirectory: storage.directory,
    scanHubs: async () => [],
    drainBluetooth: async () => {},
  };
  const server = createServer(async (request, response) => {
    if (request.url === "/update/reserve-stop") {
      await handleBundleStop(request, response, context);
    } else if (request.url === "/settings") {
      response.end(JSON.stringify(settingsReply(context)));
    } else {
      const metadata = JSON.parse(await readFile(join(fixture.code, "current/release.json"), "utf8"));
      response.end(JSON.stringify({ ok: true, release: metadata.release }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const configuration = JSON.parse(await readFile(fixture.configuration, "utf8"));
  configuration.healthUrl = `${base}/release-health`;
  await writeFile(fixture.configuration, JSON.stringify(configuration));
  const savedHealth = process.env.UPDATE_FIXTURE_REAL_HEALTH;
  process.env.UPDATE_FIXTURE_REAL_HEALTH = "1";
  const privateDirectory = join(fixture.data, "updater");
  const cache = join(privateDirectory, "cached-bundle.tar.zst");
  const trace = join(fixture.root, "commands.txt");
  try {
    await publishFixtureRelease(fixture, "candidate", "b".repeat(40));
    await queueIntent(context, privateDirectory);
    moving = true;
    await invokeUpdater(fixture, "update");
    assert.equal((await readState(fixture)).current, "old");
    assert.equal((await readState(fixture)).pending, null);
    assert.equal((await readUpdateStatus(privateDirectory)).ok, false);
    assert.match((await readUpdateStatus(privateDirectory)).message, /Park and try again/);
    assert(!/systemctl stop/.test(await readFile(trace, "utf8")), "a moving bike must not be stopped after download");
    assert.equal((await fetch(`${base}/release-health`)).status, 200, "the app must still serve HTTP");
    assert((await stat(cache)).size > 0);
    assert.equal((await stat(cache)).mode & 0o777, 0o600);
    assert.equal(busHeldBy(), null);
    moving = false;

    const held = acquireBus("synthetic service write during download");
    assert(held.ok);
    try {
      await writeFile(trace, "");
      assert.match(await invokeUpdater(fixture, "update"), /Reusing the verified/);
      assert(!/systemctl stop/.test(await readFile(trace, "utf8")), "a busy bus must not be stopped");
      assert(
        !/curl .*bundle\.tar\.zst/.test(await readFile(trace, "utf8")),
        "a refused update must reuse its download"
      );
      assert.equal(busHeldBy(), "synthetic service write during download");
    } finally {
      held.lease.release();
    }
    await runtime.store.update(0, { coolantProbesEnabled: true });
    const failedQueue = recordingResponse();
    await handleBundleUpdate(failedQueue.res, privateDirectory, {
      reservation: {
        request: stopRequest(),
        settings: context,
        body: { expectedGeneration: restart.generation, revision: 1 },
      },
      queue: async () => {
        throw new Error("synthetic failed queue after a newer confirmation");
      },
    });
    assert.equal(failedQueue.statusCode, 500);
    await writeFile(trace, "");
    await invokeUpdater(fixture, "update");
    assert(!/systemctl stop/.test(await readFile(trace, "utf8")), "the originally confirmed revision must still match");
    assert.match((await readUpdateStatus(privateDirectory)).message, /Park and try again/);

    const runningState = JSON.parse(await readFile(fixture.state, "utf8"));
    runningState.status.running = true;
    await writeFile(fixture.state, JSON.stringify(runningState));
    await queueIntent(context, privateDirectory);
    await writeFile(trace, "");
    await invokeUpdater(fixture, "update");
    assert(
      !/systemctl stop/.test(await readFile(trace, "utf8")),
      "an admission during download must not replace its original revision"
    );

    await checkStopGuards(context);
    // Losing the app's in-memory confirmation during download is a refusal, never fresh consent.
    const replacement = { ...context };
    const missingIntent = recordingResponse();
    await handleBundleStop(stopRequest(), missingIntent.res, replacement);
    assert.equal(missingIntent.statusCode, 409);
    const oldGeneration = recordingResponse();
    await handleBundleStop(stopRequest({ expectedGeneration: "old-process", revision: 1 }), oldGeneration.res, context);
    assert.equal(oldGeneration.statusCode, 409);
    assert.equal(busHeldBy(), null);

    // A Bluetooth-key change during download still requires acknowledgement on that phone.
    await queueIntent(context, privateDirectory, true);
    await runtime.store.update(1, { dashboardBluetoothSecret: "ab".repeat(32) });
    const bluetooth = recordingResponse();
    await handleBundleStop(stopRequest({}, "::ffff:127.0.0.1"), bluetooth.res, context);
    assert.equal(bluetooth.statusCode, 409);
    assert.match(bluetooth.body, /Bluetooth key/);
    assert.equal(busHeldBy(), null);

    await queueIntent(context, privateDirectory);
    // A corrupt cache is not trusted, even if its byte count still matches.
    const corrupted = await readFile(cache);
    corrupted[0] ^= 1;
    await writeFile(cache, corrupted);
    await writeFile(trace, "");
    assert.match(await invokeUpdater(fixture, "update"), /Update installed/);
    const calls = await readFile(trace, "utf8");
    assert.match(calls, /curl .*bundle\.tar\.zst/);
    assert.match(calls, /curl .*update\/reserve-stop[\s\S]*systemctl stop/);
    assert.notEqual((await readState(fixture)).current, "old");
    assert.equal(restart.status().state, "reserved", "the successful stop reservation must survive the HTTP reply");
    assert.match(busHeldBy() ?? "", /Cool Eva restart/);
    await assert.rejects(runtime.store.update(2, { radiatorFanEnabled: true }), /restart is reserved/);
    const duplicate = recordingResponse();
    await handleBundleStop(stopRequest(), duplicate.res, context);
    assert.equal(duplicate.statusCode, 409);
    assert.match(busHeldBy() ?? "", /Cool Eva restart/, "a duplicate must not release the first lease");
    restart.consume();
    assert.match(busHeldBy() ?? "", /Cool Eva restart/, "SIGTERM holds the lease through shutdown");
    await restart.close();
    assert.equal(busHeldBy(), null);
    const operatorRestart = createSettingsRestart({ store: runtime.store, motionBlockers: () => [] });
    context = { ...context, restart: operatorRestart };
    const branchTag = await publishFixtureRelease(fixture, "operator-candidate", "c".repeat(40));
    assert.match(await invokeUpdater(fixture, "install-tag", branchTag), /Update installed/);
    assert.equal(
      operatorRestart.status().state,
      "reserved",
      "the SSH path must reserve the revision read before download"
    );
    assert.match(busHeldBy() ?? "", /Cool Eva restart/);
    operatorRestart.consume();
    await operatorRestart.close();
    console.log(
      "bundle stop: real localhost motion/busy/stale refusal, no stop, cached retry, cache checksum, Bluetooth handover and held-until-SIGTERM reservation passed"
    );
  } finally {
    if (savedHealth === undefined) {
      delete process.env.UPDATE_FIXTURE_REAL_HEALTH;
    } else {
      process.env.UPDATE_FIXTURE_REAL_HEALTH = savedHealth;
    }
    await restart.close();
    await context.restart.close();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    await closeSettingsFixture(storage);
    await rm(directory, { recursive: true, force: true });
  }
}

async function queueIntent(context: SettingsHttpContext, directory: string, bluetooth = false): Promise<void> {
  const reply = recordingResponse();
  const body = { expectedGeneration: context.restart.generation, revision: settingsReply(context).revision };
  const request = stopRequest();
  if (bluetooth) {
    request.headers["x-cool-eva-tunnel"] = "1";
  }
  await handleBundleUpdate(reply.res, directory, {
    reservation: { request, body, settings: context },
    queue: async () => {},
  });
  assert.equal(reply.statusCode, 202);
  assert.equal(busHeldBy(), null);
}

async function checkStopGuards(context: SettingsHttpContext): Promise<void> {
  for (const request of [
    stopRequest({}, "192.0.2.10"),
    stopRequest({}, "::ffff:192.0.2.10"),
    Object.assign(stopRequest(), { method: "GET" }),
    Object.assign(stopRequest(), { headers: { "content-type": "application/json" } }),
    Object.assign(stopRequest(), { headers: { "x-cool-eva": "settings", "content-type": "application/json" } }),
    Object.assign(stopRequest(), { headers: { "x-cool-eva": "update" } }),
    Object.assign(stopRequest(), { headers: { "x-cool-eva": "update", "content-type": "text/plain" } }),
  ]) {
    const response = recordingResponse();
    await handleBundleStop(request, response.res, context);
    assert.equal(response.statusCode, 403);
    assert.equal(busHeldBy(), null);
  }
  const invalid = recordingResponse();
  await handleBundleStop(stopRequest({ url: "https://example.invalid" }), invalid.res, context);
  assert.equal(invalid.statusCode, 409);
  assert.equal(busHeldBy(), null);
  assert.match(
    await readFile(join(REPOSITORY, "src/index.ts"), "utf8"),
    /url\.pathname === "\/update\/reserve-stop"[\s\S]*handleBundleStop\(req, res, settingsHttp\)/
  );
}

function stopRequest(body: Record<string, unknown> = {}, remoteAddress = "127.0.0.1"): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    headers: { "x-cool-eva": "update", "content-type": "application/json" },
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;
}

await checkBundleStop();
